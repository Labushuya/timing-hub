/**
 * routes/participants.ts — Participant management routes
 *
 *   POST   /events/:slug/participants                       — register single participant
 *   GET    /events/:slug/participants                       — list participants for an event
 *   GET    /events/:slug/participants/:startnummer          — get participant details + time_entries count
 *   PATCH  /events/:slug/participants/:startnummer          — update participant
 *   DELETE /events/:slug/participants/:startnummer          — remove participant (no confirmed time_entries)
 *   POST   /events/:slug/participants/:startnummer/dns      — mark as Did Not Start
 *   POST   /events/:slug/participants/:startnummer/dnf      — mark as Did Not Finish
 *   POST   /events/:slug/participants/:startnummer/dsq      — disqualify
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { JSONValue } from 'postgres';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateParticipantBodySchema = z.object({
  startnummer:    z.string().min(1).max(20),
  driver_name:    z.string().min(1).max(150),
  co_driver_name: z.string().max(150).optional().nullable(),
  car_make:       z.string().max(80).optional().nullable(),
  car_model:      z.string().max(80).optional().nullable(),
  car_year:       z.number().int().min(1900).max(2100).optional().nullable(),
  class:          z.string().max(50).optional().nullable(),
  target_time_ms: z.number().int().min(0).optional().nullable(),
  seed_time_ms:   z.number().int().min(0).optional().nullable(),
  notes:          z.string().max(500).optional().nullable(),
});

const PatchParticipantBodySchema = z.object({
  driver_name:    z.string().min(1).max(150).optional(),
  co_driver_name: z.string().max(150).optional().nullable(),
  car_make:       z.string().max(80).optional().nullable(),
  car_model:      z.string().max(80).optional().nullable(),
  car_year:       z.number().int().min(1900).max(2100).optional().nullable(),
  class:          z.string().max(50).optional().nullable(),
  target_time_ms: z.number().int().min(0).optional().nullable(),
  seed_time_ms:   z.number().int().min(0).optional().nullable(),
  notes:          z.string().max(500).optional().nullable(),
});

type CreateParticipantBody = z.infer<typeof CreateParticipantBodySchema>;
type PatchParticipantBody  = z.infer<typeof PatchParticipantBodySchema>;

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface EventRow {
  id:       string;
  owner_id: string;
  slug:     string;
  status:   string;
}

interface ParticipantRow {
  id:             string;
  event_id:       string;
  startnummer:    string;
  driver_name:    string;
  co_driver_name: string | null;
  car_make:       string | null;
  car_model:      string | null;
  car_year:       number | null;
  class:          string | null;
  target_time_ms: string | null; // BIGINT comes back as string from postgres driver
  seed_time_ms:   string | null;
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
}

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

function serialiseParticipant(p: ParticipantRow, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id:             p.id,
    event_id:       p.event_id,
    startnummer:    p.startnummer,
    driver_name:    p.driver_name,
    co_driver_name: p.co_driver_name,
    car_make:       p.car_make,
    car_model:      p.car_model,
    car_year:       p.car_year,
    class:          p.class,
    target_time_ms: p.target_time_ms !== null ? Number(p.target_time_ms) : null,
    seed_time_ms:   p.seed_time_ms   !== null ? Number(p.seed_time_ms)   : null,
    notes:          p.notes,
    created_at:     Number(p.created_at),
    updated_at:     Number(p.updated_at),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

async function writeAuditLog(
  db: FastifyInstance['db'],
  opts: {
    event_id?:    string;
    actor_id?:    string;
    action:       string;
    entity_type:  string;
    entity_id?:   string;
    after_state?: JSONValue;
    ip_address?:  string;
  },
): Promise<void> {
  await db`
    INSERT INTO audit_log
      (event_id, actor_id, action, entity_type, entity_id, after_state, ip_address)
    VALUES (
      ${opts.event_id   ?? null},
      ${opts.actor_id   ?? null},
      ${opts.action},
      ${opts.entity_type},
      ${opts.entity_id  ?? null},
      ${opts.after_state ? db.json(opts.after_state) : null},
      ${opts.ip_address ?? null}
    )
  `;
}

// ---------------------------------------------------------------------------
// Shared guard: resolve event + authenticate owner/admin
// ---------------------------------------------------------------------------

async function resolveEventAndCheckAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
): Promise<EventRow | null> {
  try {
    await request.jwtVerify();
  } catch {
    reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
    return null;
  }

  const rows = await app.db<EventRow[]>`
    SELECT id, owner_id, slug, status
    FROM events
    WHERE slug = ${slug}
    LIMIT 1
  `;

  if (rows.length === 0) {
    reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
    return null;
  }

  const event = rows[0]!;
  const isOwner = request.user.sub === event.owner_id;
  const isAdmin = request.user.role === 'admin';

  if (!isOwner && !isAdmin) {
    reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Not the event owner' });
    return null;
  }

  return event;
}

// ---------------------------------------------------------------------------
// Shared DNS / DNF / DSQ handler
// ---------------------------------------------------------------------------

async function setStatusFlag(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
  startnummer: string,
  flag: 'dns' | 'dnf' | 'dsq',
): Promise<void> {
  const event = await resolveEventAndCheckAccess(app, request, reply, slug);
  if (!event) return;

  const rows = await app.db<ParticipantRow[]>`
    SELECT * FROM participants
    WHERE event_id = ${event.id} AND startnummer = ${startnummer}
    LIMIT 1
  `;

  if (rows.length === 0) {
    reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: `Participant "${startnummer}" not found`,
    });
    return;
  }

  const participant = rows[0]!;
  const now = Date.now();
  const flagColumn = `is_${flag}` as 'is_dns' | 'is_dnf' | 'is_dsq';

  const updated = await app.db<ParticipantRow[]>`
    UPDATE participants
    SET ${app.db(flagColumn)} = true, updated_at = ${now}
    WHERE id = ${participant.id}
    RETURNING *
  `;

  await writeAuditLog(app.db, {
    event_id:    event.id,
    actor_id:    request.user.sub,
    action:      `participant.${flag}`,
    entity_type: 'participant',
    entity_id:   participant.id,
    after_state: { startnummer, [flagColumn]: true } as JSONValue,
    ip_address:  request.ip,
  }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

  reply.send(serialiseParticipant(updated[0]!));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function participantRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // POST /events/:slug/participants — register single participant
  // =========================================================================
  app.post<{ Params: { slug: string } }>(
    '/events/:slug/participants',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const parseResult = CreateParticipantBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: CreateParticipantBody = parseResult.data;

      // Startnummer uniqueness within event
      const existing = await app.db<{ id: string }[]>`
        SELECT id FROM participants
        WHERE event_id = ${event.id} AND startnummer = ${body.startnummer}
        LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Participant with Startnummer "${body.startnummer}" already exists in this event`,
        });
      }

      const now = Date.now();

      const rows = await app.db<ParticipantRow[]>`
        INSERT INTO participants
          (event_id, startnummer, driver_name, co_driver_name,
           car_make, car_model, car_year, class,
           target_time_ms, seed_time_ms, notes,
           created_at, updated_at)
        VALUES (
          ${event.id},
          ${body.startnummer},
          ${body.driver_name},
          ${body.co_driver_name ?? null},
          ${body.car_make       ?? null},
          ${body.car_model      ?? null},
          ${body.car_year       ?? null},
          ${body.class          ?? null},
          ${body.target_time_ms ?? null},
          ${body.seed_time_ms   ?? null},
          ${body.notes          ?? null},
          ${now},
          ${now}
        )
        RETURNING *
      `;

      const participant = rows[0]!;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'participant.create',
        entity_type: 'participant',
        entity_id:   participant.id,
        after_state: { startnummer: participant.startnummer, driver_name: participant.driver_name } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.status(201).send(serialiseParticipant(participant));
    },
  );

  // =========================================================================
  // GET /events/:slug/participants — list participants
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/participants',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const query = request.query as {
        page?:   string;
        limit?:  string;
        search?: string;
        class?:  string;
        sort?:   string;
      };

      const page   = Math.max(1, parseInt(query.page  ?? '1',  10) || 1);
      const limit  = Math.min(500, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
      const offset = (page - 1) * limit;

      const searchFilter = query.search?.trim();
      const classFilter  = query.class?.trim();

      // Only allow safe sort columns
      const allowedSorts: Record<string, string> = {
        startnummer:  'p.startnummer ASC',
        driver_name:  'p.driver_name ASC',
      };
      const sortKey = query.sort?.trim() ?? 'startnummer';
      const orderBy = allowedSorts[sortKey] ?? allowedSorts['startnummer']!;

      // Use trigram similarity search when ?search= is provided (requires pg_trgm + gin_trgm_ops index)
      // falls back gracefully to ILIKE if extension absent
      const searchSql = searchFilter
        ? app.db`AND (p.driver_name % ${searchFilter} OR p.driver_name ILIKE ${'%' + searchFilter + '%'} OR p.co_driver_name ILIKE ${'%' + searchFilter + '%'} OR p.startnummer ILIKE ${'%' + searchFilter + '%'})`
        : app.db``;

      const classSql = classFilter
        ? app.db`AND p.class = ${classFilter}`
        : app.db``;

      // Fetch participants, total count, and distinct classes in parallel
      const [participantRows, totalRow, classRows] = await Promise.all([
        app.db<ParticipantRow[]>`
          SELECT p.*
          FROM participants p
          WHERE p.event_id = ${event.id}
            ${searchSql}
            ${classSql}
          ORDER BY ${app.db.unsafe(orderBy)}
          LIMIT ${limit} OFFSET ${offset}
        `,
        app.db<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM participants p
          WHERE p.event_id = ${event.id}
            ${searchSql}
            ${classSql}
        `,
        app.db<{ class: string | null }[]>`
          SELECT DISTINCT p.class
          FROM participants p
          WHERE p.event_id = ${event.id}
            AND p.class IS NOT NULL
          ORDER BY p.class ASC
        `,
      ]);

      const total   = parseInt(totalRow[0]?.count ?? '0', 10);
      const classes = classRows.map((r) => r.class as string);

      return reply.send({
        participants: participantRows.map((p) => serialiseParticipant(p)),
        total,
        classes,
        page,
        limit,
      });
    },
  );

  // =========================================================================
  // GET /events/:slug/participants/:startnummer — get single participant
  // =========================================================================
  app.get<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const [rows, teRows] = await Promise.all([
        app.db<ParticipantRow[]>`
          SELECT * FROM participants
          WHERE event_id = ${event.id} AND startnummer = ${request.params.startnummer}
          LIMIT 1
        `,
        app.db<{ count: string }[]>`
          SELECT count(*)::text AS count
          FROM time_entries te
          JOIN participants p ON p.id = te.participant_id
          WHERE p.event_id = ${event.id}
            AND p.startnummer = ${request.params.startnummer}
        `,
      ]);

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Participant "${request.params.startnummer}" not found`,
        });
      }

      const time_entries_count = parseInt(teRows[0]?.count ?? '0', 10);

      return reply.send(serialiseParticipant(rows[0]!, { time_entries_count }));
    },
  );

  // =========================================================================
  // PATCH /events/:slug/participants/:startnummer — update participant
  // =========================================================================
  app.patch<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const parseResult = PatchParticipantBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: PatchParticipantBody = parseResult.data;

      const existing = await app.db<ParticipantRow[]>`
        SELECT * FROM participants
        WHERE event_id = ${event.id} AND startnummer = ${request.params.startnummer}
        LIMIT 1
      `;

      if (existing.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Participant "${request.params.startnummer}" not found`,
        });
      }

      const now = Date.now();
      const p   = existing[0]!;

      const updated = await app.db<ParticipantRow[]>`
        UPDATE participants SET
          driver_name    = COALESCE(${body.driver_name    ?? null}, driver_name),
          co_driver_name = CASE WHEN ${body.co_driver_name !== undefined} THEN ${body.co_driver_name ?? null} ELSE co_driver_name END,
          car_make       = CASE WHEN ${body.car_make       !== undefined} THEN ${body.car_make       ?? null} ELSE car_make END,
          car_model      = CASE WHEN ${body.car_model      !== undefined} THEN ${body.car_model      ?? null} ELSE car_model END,
          car_year       = CASE WHEN ${body.car_year       !== undefined} THEN ${body.car_year       ?? null} ELSE car_year END,
          class          = CASE WHEN ${body.class          !== undefined} THEN ${body.class          ?? null} ELSE class END,
          target_time_ms = CASE WHEN ${body.target_time_ms !== undefined} THEN ${body.target_time_ms ?? null} ELSE target_time_ms END,
          seed_time_ms   = CASE WHEN ${body.seed_time_ms   !== undefined} THEN ${body.seed_time_ms   ?? null} ELSE seed_time_ms END,
          notes          = CASE WHEN ${body.notes          !== undefined} THEN ${body.notes          ?? null} ELSE notes END,
          updated_at     = ${now}
        WHERE id = ${p.id}
        RETURNING *
      `;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'participant.update',
        entity_type: 'participant',
        entity_id:   p.id,
        after_state: body as unknown as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(serialiseParticipant(updated[0]!));
    },
  );

  // =========================================================================
  // DELETE /events/:slug/participants/:startnummer — remove participant
  // =========================================================================
  app.delete<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<ParticipantRow[]>`
        SELECT * FROM participants
        WHERE event_id = ${event.id} AND startnummer = ${request.params.startnummer}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Participant "${request.params.startnummer}" not found`,
        });
      }

      const participant = rows[0]!;

      // Guard: no *confirmed* time_entries referencing this participant
      const teRows = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count FROM time_entries
        WHERE participant_id = ${participant.id}
          AND status = 'confirmed'
      `;
      const teCount = parseInt(teRows[0]?.count ?? '0', 10);
      if (teCount > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Cannot delete participant "${participant.startnummer}": ${teCount} confirmed time entr${teCount === 1 ? 'y' : 'ies'} reference them`,
        });
      }

      await app.db`DELETE FROM participants WHERE id = ${participant.id}`;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'participant.delete',
        entity_type: 'participant',
        entity_id:   participant.id,
        after_state: { startnummer: participant.startnummer } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.status(204).send();
    },
  );

  // =========================================================================
  // POST /events/:slug/participants/:startnummer/dns
  // =========================================================================
  app.post<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer/dns',
    {},
    async (request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>, reply: FastifyReply) => {
      return setStatusFlag(app, request, reply, request.params.slug, request.params.startnummer, 'dns');
    },
  );

  // =========================================================================
  // POST /events/:slug/participants/:startnummer/dnf
  // =========================================================================
  app.post<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer/dnf',
    {},
    async (request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>, reply: FastifyReply) => {
      return setStatusFlag(app, request, reply, request.params.slug, request.params.startnummer, 'dnf');
    },
  );

  // =========================================================================
  // POST /events/:slug/participants/:startnummer/dsq
  // =========================================================================
  app.post<{ Params: { slug: string; startnummer: string } }>(
    '/events/:slug/participants/:startnummer/dsq',
    {},
    async (request: FastifyRequest<{ Params: { slug: string; startnummer: string } }>, reply: FastifyReply) => {
      return setStatusFlag(app, request, reply, request.params.slug, request.params.startnummer, 'dsq');
    },
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const participantRoutes = fp(participantRoutesFn, {
  name: 'participant-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
