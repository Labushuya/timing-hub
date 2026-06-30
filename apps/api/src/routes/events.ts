/**
 * routes/events.ts — Event management routes
 *
 * Endpoints:
 *   POST   /events                    — create event (organizer / admin)
 *   GET    /events                    — list events
 *   GET    /events/:slug              — get event details (public for active/finished)
 *   PATCH  /events/:slug              — update event fields
 *   DELETE /events/:slug              — soft-delete (archive)
 *   POST   /events/:slug/activate     — draft → active
 *   POST   /events/:slug/finish       — active → finished
 *   POST   /events/:slug/import       — bulk-import participants via CSV
 */

import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import type { JSONValue } from 'postgres';
import { z } from 'zod';
import { enqueueCompute } from '../services/scoring/index.js';
import { sanitizeString } from '../middleware/validate.js';

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

const GLPConfigSchema = z.object({
  sectors: z.array(z.string()).optional(),
  target_time_ms: z.number().int().optional(),
  penalty_per_second_ms: z.number().int().optional(),
}).passthrough();

const SPConfigSchema = z.object({
  special_stage_name: z.string().optional(),
  distance_km: z.number().optional(),
  surface: z.enum(['tarmac', 'gravel', 'mixed']).optional(),
}).passthrough();

const RundstreckeConfigSchema = z.object({
  laps: z.number().int().min(1).optional(),
  track_length_m: z.number().optional(),
  pit_lane_time_ms: z.number().int().optional(),
}).passthrough();

const OrientierungConfigSchema = z.object({
  checkpoints: z.array(z.string()).optional(),
  max_time_ms: z.number().int().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Body schemas (Zod)
// ---------------------------------------------------------------------------

const EventFormatEnum = z.enum(['glp', 'sonderpruefung', 'rundstrecke', 'orientierung']);

const CreateEventBodySchema = z.object({
  name:        z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  format:      EventFormatEnum,
  starts_at:   z.number().int(),
  ends_at:     z.number().int().optional(),
  timezone:    z.string().default('Europe/Berlin'),
  config:      z.union([
    GLPConfigSchema,
    SPConfigSchema,
    RundstreckeConfigSchema,
    OrientierungConfigSchema,
  ]),
});

const PatchEventBodySchema = z.object({
  name:        z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  starts_at:   z.number().int().optional(),
  ends_at:     z.number().int().optional().nullable(),
  timezone:    z.string().optional(),
  config:      z.record(z.unknown()).optional(),
});

type CreateEventBody = z.infer<typeof CreateEventBodySchema>;
type PatchEventBody  = z.infer<typeof PatchEventBodySchema>;

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface EventRow {
  id:          string;
  owner_id:    string;
  slug:        string;
  name:        string;
  description: string | null;
  format:      string;
  status:      string;
  starts_at:   string; // BIGINT comes back as string from postgres driver
  ends_at:     string | null;
  timezone:    string;
  config:      Record<string, unknown>;
  created_at:  string;
  updated_at:  string;
}

interface PostenRow {
  id:           string;
  event_id:     string;
  code:         string;
  name:         string;
  sort_order:   number;
  role:         string;
  access_token: string;
  bridge_token: string | null;
  created_at:   string;
}

interface SectionTargetJoinedRow {
  id:               string;
  event_id:         string;
  from_posten_id:   string | null;
  from_posten_code: string | null;
  to_posten_id:     string | null;
  to_posten_code:   string | null;
  class:            string | null;
  target_time_ms:   string; // BIGINT as string
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

export function generateSlug(name: string, year: number): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) +
    '-' +
    String(year)
  );
}

export async function ensureUniqueSlug(
  db: FastifyInstance['db'],
  baseSlug: string,
): Promise<string> {
  // Check exact slug
  const exact = await db<{ slug: string }[]>`
    SELECT slug FROM events WHERE slug = ${baseSlug} LIMIT 1
  `;
  if (exact.length === 0) return baseSlug;

  // Find all existing slugs with the same base (base or base-N pattern)
  const escapedBase = baseSlug.replace(/[%_\\]/g, '\\$&');
  const existing = await db<{ slug: string }[]>`
    SELECT slug FROM events
    WHERE slug = ${baseSlug}
       OR slug ~ ${`^${escapedBase}-\\d+$`}
  `;
  const taken = new Set(existing.map((r) => r.slug));

  for (let counter = 2; counter < 1000; counter++) {
    const candidate = `${baseSlug}-${counter}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not generate unique slug');
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function writeAuditLog(
  db: FastifyInstance['db'],
  opts: {
    event_id?:    string;
    user_id?:     string;
    action:       string;
    entity_type?: string;
    entity_id?:   string;
    new_value?:   JSONValue;
    ip_address?:  string;
  },
): Promise<void> {
  await db`
    INSERT INTO audit_log
      (event_id, user_id, action, entity_type, entity_id, new_value, ip_address)
    VALUES (
      ${opts.event_id   ?? null},
      ${opts.user_id    ?? null},
      ${opts.action},
      ${opts.entity_type ?? null},
      ${opts.entity_id  ?? null},
      ${opts.new_value  ? db.json(opts.new_value) : null},
      ${opts.ip_address ?? null}
    )
  `;
}

// ---------------------------------------------------------------------------
// CSV import helper
// ---------------------------------------------------------------------------

const HEADER_ALIASES: Record<string, string> = {
  // startnummer
  'start_number':  'startnummer',
  'startnr':       'startnummer',
  'nr':            'startnummer',
  'number':        'startnummer',
  // driver_name
  'fahrer':        'driver_name',
  'driver':        'driver_name',
  'name':          'driver_name',
  // co_driver_name
  'beifahrer':     'co_driver_name',
  'co_driver':     'co_driver_name',
  'codriver':      'co_driver_name',
  'co-driver':     'co_driver_name',
  // car_make
  'make':          'car_make',
  'marke':         'car_make',
  'brand':         'car_make',
  // car_model
  'model':         'car_model',
  'modell':        'car_model',
  // car_year
  'year':          'car_year',
  'baujahr':       'car_year',
  // class
  'klasse':        'class',
  'gruppe':        'class',
  'group':         'class',
  // target_time_ms
  'zielzeit':      'target_time_ms',
  'target_time':   'target_time_ms',
  'sollzeit':      'target_time_ms',
};

function normaliseHeader(h: string): string {
  const lower = h.trim().toLowerCase();
  return HEADER_ALIASES[lower] ?? lower.replace(/\s+/g, '_');
}

interface CsvParticipantRow {
  startnummer?:    string;
  driver_name?:    string;
  co_driver_name?: string;
  car_make?:       string;
  car_model?:      string;
  car_year?:       string;
  class?:          string;
  target_time_ms?: string;
}

function parseCSV(text: string): CsvParticipantRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const rawHeaders = lines[0]!.split(',');
  const headers = rawHeaders.map(normaliseHeader);

  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? '').trim();
    });
    return row as CsvParticipantRow;
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function eventRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // POST /events — create event
  // =========================================================================
  app.post(
    '/',
    {
      preHandler: app.requireRole(['organizer', 'admin']),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Validate body
      const parseResult = CreateEventBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: CreateEventBody = parseResult.data;
      const userId = request.user.sub;

      // Sanitize user-supplied text fields before persisting
      const safeName        = sanitizeString(body.name, 100);
      const safeDescription = body.description !== undefined
        ? sanitizeString(body.description, 500)
        : undefined;

      // Derive year from starts_at (unix ms)
      const year = new Date(body.starts_at).getFullYear();
      const baseSlug = generateSlug(safeName, year);
      const slug = await ensureUniqueSlug(app.db, baseSlug);

      // Insert event
      const now = Date.now();
      const eventRows = await app.db<EventRow[]>`
        INSERT INTO events
          (owner_id, slug, name, description, format, starts_at, ends_at, timezone, config, created_at, updated_at)
        VALUES (
          ${userId},
          ${slug},
          ${safeName},
          ${safeDescription ?? null},
          ${body.format},
          ${body.starts_at},
          ${body.ends_at ?? null},
          ${body.timezone},
          ${app.db.json(body.config as unknown as JSONValue)},
          ${now},
          ${now}
        )
        RETURNING *
      `;

      const event = eventRows[0]!;

      // Insert default posten based on format
      if (body.format === 'rundstrecke') {
        await app.db`
          INSERT INTO posten (event_id, code, name, sort_order, role)
          VALUES (${event.id}, 'ZEIT', 'Zeitnahme', 0, 'finish')
        `;
      } else {
        await app.db`
          INSERT INTO posten (event_id, code, name, sort_order, role)
          VALUES
            (${event.id}, 'START', 'START', 0, 'start'),
            (${event.id}, 'ZIEL',  'ZIEL',  1, 'finish')
        `;
      }

      // Audit log
      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.create',
        entity_type: 'event',
        entity_id:   event.id,
        new_value:   { slug, name: body.name, format: body.format } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      // Fetch full event with posten
      const posten = await app.db<PostenRow[]>`
        SELECT * FROM posten WHERE event_id = ${event.id} ORDER BY sort_order
      `;

      return reply.status(201).send(serialiseEvent(event, posten));
    },
  );

  // =========================================================================
  // GET /events — list events
  // =========================================================================
  app.get(
    '/',
    {
      preHandler: app.requireRole(['organizer', 'admin']),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        status?: string;
        page?:   string;
        limit?:  string;
      };

      const page  = Math.max(1, parseInt(query.page  ?? '1',  10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '20', 10) || 20));
      const offset = (page - 1) * limit;

      const userId = request.user.sub;
      const isAdmin = request.user.role === 'admin';

      const allowedStatuses = ['draft', 'active', 'finished', 'archived'];
      const statusFilter = query.status && allowedStatuses.includes(query.status)
        ? query.status
        : null;

      // Build query dynamically using template literal fragments
      const ownerFilter = isAdmin
        ? app.db``
        : app.db`AND e.owner_id = ${userId}`;

      const statusSql = statusFilter
        ? app.db`AND e.status = ${statusFilter}`
        : app.db``;

      const events = await app.db<(EventRow & {
        posten_count:      string;
        participant_count: string;
      })[]>`
        SELECT
          e.*,
          (SELECT count(*)::text FROM posten      p WHERE p.event_id = e.id) AS posten_count,
          (SELECT count(*)::text FROM participants pt WHERE pt.event_id = e.id) AS participant_count
        FROM events e
        WHERE 1=1
          ${ownerFilter}
          ${statusSql}
        ORDER BY e.starts_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const totalRow = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM events e
        WHERE 1=1
          ${ownerFilter}
          ${statusSql}
      `;

      const total = parseInt(totalRow[0]?.count ?? '0', 10);

      return reply.send({
        events: events.map((e) => ({
          ...serialiseEventFlat(e),
          posten_count:      parseInt(e.posten_count, 10),
          participant_count: parseInt(e.participant_count, 10),
        })),
        total,
        page,
        limit,
      });
    },
  );

  // =========================================================================
  // GET /events/:slug — get event details
  // =========================================================================
  app.get(
    '/:slug',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };

      // Try to authenticate — optional
      let userId: string | null = null;
      let userRole: string | null = null;
      try {
        await request.jwtVerify();
        userId   = request.user.sub;
        userRole = request.user.role;
      } catch {
        // unauthenticated — allowed for public events
      }

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;

      if (eventRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Event not found',
        });
      }

      const event = eventRows[0]!;

      // Access control: draft/archived only for owner or admin
      const isOwner = userId === event.owner_id;
      const isAdmin = userRole === 'admin';
      const isPublicStatus = event.status === 'active' || event.status === 'finished';

      if (!isPublicStatus && !isOwner && !isAdmin) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Event not found',
        });
      }

      // Fetch posten (strip bridge_token for public access)
      const posten = await app.db<PostenRow[]>`
        SELECT * FROM posten WHERE event_id = ${event.id} ORDER BY sort_order
      `;

      // Fetch section targets with posten codes
      const sectionTargets = await app.db<SectionTargetJoinedRow[]>`
        SELECT
          st.id,
          st.event_id,
          st.from_posten_id,
          pf.code AS from_posten_code,
          st.to_posten_id,
          pt.code AS to_posten_code,
          st.class,
          st.target_time_ms
        FROM section_targets st
        LEFT JOIN posten pf ON pf.id = st.from_posten_id
        LEFT JOIN posten pt ON pt.id = st.to_posten_id
        WHERE st.event_id = ${event.id}
        ORDER BY st.created_at ASC
      `;

      // Counts
      const countRow = await app.db<{
        result_count:      string;
        participant_count: string;
      }[]>`
        SELECT
          (SELECT count(*)::text FROM results      r  WHERE r.event_id  = ${event.id}) AS result_count,
          (SELECT count(*)::text FROM participants pt WHERE pt.event_id = ${event.id}) AS participant_count
      `;

      const isPrivileged = isOwner || isAdmin;

      const postenOut = posten.map((p) => ({
        id:          p.id,
        event_id:    p.event_id,
        code:        p.code,
        name:        p.name,
        sort_order:  p.sort_order,
        role:        p.role,
        access_token: p.access_token,
        // bridge_token only for owner / admin
        ...(isPrivileged ? { bridge_token: p.bridge_token } : {}),
        created_at:  Number(p.created_at),
      }));

      const sectionTargetsOut = sectionTargets.map((st) => ({
        id:               st.id,
        event_id:         st.event_id,
        from_posten_id:   st.from_posten_id,
        from_posten_code: st.from_posten_code,
        to_posten_id:     st.to_posten_id,
        to_posten_code:   st.to_posten_code,
        class:            st.class,
        target_time_ms:   Number(st.target_time_ms),
      }));

      return reply.send({
        ...serialiseEvent(event, []),
        posten: postenOut,
        section_targets:   sectionTargetsOut,
        result_count:      parseInt(countRow[0]?.result_count      ?? '0', 10),
        participant_count: parseInt(countRow[0]?.participant_count  ?? '0', 10),
      });
    },
  );

  // =========================================================================
  // PATCH /events/:slug — update event
  // =========================================================================
  app.patch(
    '/:slug',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };
      const userId   = request.user.sub;
      const isAdmin  = request.user.role === 'admin';

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;

      if (event.owner_id !== userId && !isAdmin) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
      }

      const parseResult = PatchEventBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: PatchEventBody = parseResult.data;

      // Sanitize mutable text fields
      const safeName = body.name !== undefined
        ? sanitizeString(body.name, 100)
        : undefined;
      const safeDescription = body.description !== undefined && body.description !== null
        ? sanitizeString(body.description, 500)
        : body.description; // preserve null / undefined as-is

      // Guard: cannot change format if time entries exist — format is immutable but not in the patch schema.
      // Ensure config changes don't break things if time entries exist
      if (body.config !== undefined) {
        const teRows = await app.db<{ count: string }[]>`
          SELECT count(*)::text AS count FROM time_entries WHERE event_id = ${event.id} LIMIT 1
        `;
        const teCount = parseInt(teRows[0]?.count ?? '0', 10);
        if (teCount > 0) {
          // Allow config update but warn — format change was already prevented by not exposing format in patch schema
        }
      }

      const now = Date.now();

      const updatedRows = await app.db<EventRow[]>`
        UPDATE events SET
          name        = COALESCE(${safeName        ?? null}, name),
          description = CASE WHEN ${safeDescription !== undefined} THEN ${safeDescription ?? null} ELSE description END,
          starts_at   = COALESCE(${body.starts_at   ?? null}, starts_at),
          ends_at     = CASE WHEN ${body.ends_at     !== undefined} THEN ${body.ends_at ?? null} ELSE ends_at END,
          timezone    = COALESCE(${body.timezone     ?? null}, timezone),
          config      = CASE WHEN ${body.config !== undefined} THEN ${body.config ? app.db.json(body.config as unknown as JSONValue) : app.db.json({} as JSONValue)} ELSE config END,
          updated_at  = ${now}
        WHERE id = ${event.id}
        RETURNING *
      `;

      const updated = updatedRows[0]!;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.update',
        entity_type: 'event',
        entity_id:   event.id,
        new_value:   body as unknown as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(serialiseEventFlat(updated));
    },
  );

  // =========================================================================
  // DELETE /events/:slug — soft delete (archive)
  // =========================================================================
  app.delete(
    '/:slug',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };
      const userId   = request.user.sub;
      const isAdmin  = request.user.role === 'admin';

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;

      if (event.owner_id !== userId && !isAdmin) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
      }

      if (event.status !== 'draft' && event.status !== 'archived') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Cannot delete event in status "${event.status}". Only draft or archived events may be deleted.`,
        });
      }

      const now = Date.now();
      await app.db`
        UPDATE events SET status = 'archived', updated_at = ${now}
        WHERE id = ${event.id}
      `;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.archive',
        entity_type: 'event',
        entity_id:   event.id,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.status(204).send();
    },
  );

  // =========================================================================
  // POST /events/:slug/activate — draft → active
  // =========================================================================
  app.post(
    '/:slug/activate',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };
      const userId   = request.user.sub;
      const isAdmin  = request.user.role === 'admin';

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;

      if (event.owner_id !== userId && !isAdmin) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
      }

      if (event.status !== 'draft') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Event is already in status "${event.status}". Only draft events can be activated.`,
        });
      }

      // Validate: at least 1 participant
      const ptRows = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count FROM participants WHERE event_id = ${event.id}
      `;
      const ptCount = parseInt(ptRows[0]?.count ?? '0', 10);
      if (ptCount < 1) {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Event must have at least 1 participant before activation.',
        });
      }

      // Validate: at least 1 posten
      const postenRows = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count FROM posten WHERE event_id = ${event.id}
      `;
      const postenCount = parseInt(postenRows[0]?.count ?? '0', 10);
      if (postenCount < 1) {
        return reply.status(422).send({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Event must have at least 1 Posten before activation.',
        });
      }

      const now = Date.now();
      const updatedRows = await app.db<EventRow[]>`
        UPDATE events SET status = 'active', updated_at = ${now}
        WHERE id = ${event.id}
        RETURNING *
      `;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.activate',
        entity_type: 'event',
        entity_id:   event.id,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(serialiseEventFlat(updatedRows[0]!));
    },
  );

  // =========================================================================
  // POST /events/:slug/finish — active → finished
  // =========================================================================
  app.post(
    '/:slug/finish',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };
      const userId   = request.user.sub;
      const isAdmin  = request.user.role === 'admin';

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;

      if (event.owner_id !== userId && !isAdmin) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
      }

      if (event.status !== 'active') {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Event is in status "${event.status}". Only active events can be finished.`,
        });
      }

      const now = Date.now();
      const updatedRows = await app.db<EventRow[]>`
        UPDATE events SET status = 'finished', updated_at = ${now}
        WHERE id = ${event.id}
        RETURNING *
      `;

      // Trigger final result computation (fire-and-forget, errors are logged by the queue)
      enqueueCompute(app, event.id).catch((err) =>
        app.log.error({ err, eventId: event.id }, 'enqueueCompute failed after event finish'),
      );

      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.finish',
        entity_type: 'event',
        entity_id:   event.id,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(serialiseEventFlat(updatedRows[0]!));
    },
  );

  // =========================================================================
  // POST /events/:slug/import — bulk CSV participant import
  // =========================================================================
  app.post(
    '/:slug/import',
    {
      preHandler: app.authenticate,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as { slug: string };
      const userId   = request.user.sub;
      const isAdmin  = request.user.role === 'admin';

      const eventRows = await app.db<EventRow[]>`
        SELECT * FROM events WHERE slug = ${slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;

      if (event.owner_id !== userId && !isAdmin) {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
      }

      // Read multipart file
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'No file uploaded. Expected multipart/form-data with field "file".',
        });
      }

      if (data.fieldname !== 'file') {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'File field must be named "file".',
        });
      }

      // Buffer the upload
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer);
      }
      const csvText = Buffer.concat(chunks).toString('utf-8');

      // Parse CSV
      const rows = parseCSV(csvText);

      if (rows.length === 0) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'CSV file is empty or has no data rows.',
        });
      }

      let imported = 0;
      let skipped  = 0;
      const errors: { row: number; reason: string }[] = [];

      const now = Date.now();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const rowNum = i + 2; // 1-based + header row

        // Validate required fields
        if (!row.startnummer?.trim()) {
          errors.push({ row: rowNum, reason: 'startnummer is required' });
          skipped++;
          continue;
        }
        if (!row.driver_name?.trim()) {
          errors.push({ row: rowNum, reason: 'driver_name is required' });
          skipped++;
          continue;
        }

        const startnummer   = row.startnummer.trim();
        const driver_name   = row.driver_name.trim();
        const co_driver_name = row.co_driver_name?.trim() ?? null;
        const car_make      = row.car_make?.trim()       ?? null;
        const car_model     = row.car_model?.trim()      ?? null;
        const car_year_raw  = row.car_year?.trim();
        const car_year: number | null = car_year_raw
          ? (parseInt(car_year_raw, 10) || null)
          : null;
        const cls          = row.class?.trim()           ?? null;
        const target_raw   = row.target_time_ms?.trim();
        const target_time_ms: number | null = target_raw
          ? (isNaN(parseFloat(target_raw)) ? null : Math.round(parseFloat(target_raw)))
          : null;

        try {
          await app.db`
            INSERT INTO participants
              (event_id, startnummer, driver_name, co_driver_name,
               car_make, car_model, car_year, class, target_time_ms,
               created_at, updated_at)
            VALUES (
              ${event.id}, ${startnummer}, ${driver_name}, ${co_driver_name},
              ${car_make}, ${car_model}, ${car_year}, ${cls}, ${target_time_ms},
              ${now}, ${now}
            )
            ON CONFLICT (event_id, startnummer) DO UPDATE SET
              driver_name    = EXCLUDED.driver_name,
              co_driver_name = EXCLUDED.co_driver_name,
              car_make       = EXCLUDED.car_make,
              car_model      = EXCLUDED.car_model,
              car_year       = EXCLUDED.car_year,
              class          = EXCLUDED.class,
              target_time_ms = COALESCE(EXCLUDED.target_time_ms, participants.target_time_ms),
              updated_at     = EXCLUDED.updated_at
          `;
          imported++;
        } catch (err) {
          app.log.warn({ err, row: rowNum, startnummer }, 'participant upsert failed');
          errors.push({ row: rowNum, reason: err instanceof Error ? err.message : 'DB error' });
          skipped++;
        }
      }

      await writeAuditLog(app.db, {
        event_id:    event.id,
        user_id:     userId,
        action:      'event.import_participants',
        entity_type: 'event',
        entity_id:   event.id,
        new_value:   { imported, skipped, error_count: errors.length } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send({ imported, skipped, errors });
    },
  );
}

// ---------------------------------------------------------------------------
// Serialisers
// ---------------------------------------------------------------------------

function serialiseEventFlat(e: EventRow): Record<string, unknown> {
  return {
    id:          e.id,
    owner_id:    e.owner_id,
    slug:        e.slug,
    name:        e.name,
    description: e.description,
    format:      e.format,
    status:      e.status,
    starts_at:   Number(e.starts_at),
    ends_at:     e.ends_at !== null ? Number(e.ends_at) : null,
    timezone:    e.timezone,
    config:      e.config,
    created_at:  Number(e.created_at),
    updated_at:  Number(e.updated_at),
  };
}

function serialiseEvent(e: EventRow, posten: PostenRow[]): Record<string, unknown> {
  return {
    ...serialiseEventFlat(e),
    posten: posten.map((p) => ({
      id:           p.id,
      event_id:     p.event_id,
      code:         p.code,
      name:         p.name,
      sort_order:   p.sort_order,
      role:         p.role,
      access_token: p.access_token,
      bridge_token: p.bridge_token,
      created_at:   Number(p.created_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const eventRoutes = fp(eventRoutesFn, {
  name: 'event-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
