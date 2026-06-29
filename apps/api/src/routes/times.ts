/**
 * routes/times.ts — Time entry routes (core timing functionality)
 *
 * Registered on the /api/v1 scope without an extra prefix (like postenRoutes).
 * All paths are declared explicitly relative to that scope.
 *
 * Endpoints:
 *   POST   /api/v1/times                      — record single time entry
 *   POST   /api/v1/times/batch                — batch ingest (offline sync)
 *   GET    /api/v1/events/:slug/times         — list entries for an event
 *   PATCH  /api/v1/times/:id/confirm          — confirm entry startnummer
 *   PATCH  /api/v1/times/:id/void             — void an entry with reason
 *   PATCH  /api/v1/times/:id/assign           — re-assign to different participant
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { JSONValue, TransactionSql } from 'postgres';
import { z } from 'zod';
import { enqueueCompute } from '../services/scoring/index.js';
import { broadcast } from '../ws/hub.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const TimeEntryBodySchema = z.object({
  posten_id:         z.string().uuid(),
  startnummer:       z.string().min(1).max(20).optional(),
  raw_timestamp_ms:  z.number().int().positive(),
  source:            z.enum(['manual', 'timy_bridge']),
  lap_number:        z.number().int().min(0).optional(),
  sector_number:     z.number().int().min(0).optional(),
  channel:           z.number().int().min(0).optional(),
  client_seq:        z.string().max(64).optional(),
});

const BatchEntrySchema = TimeEntryBodySchema.extend({
  client_seq: z.string().max(64), // required in batch
});

const BatchBodySchema = z.object({
  entries: z.array(BatchEntrySchema).min(1).max(500),
});

const ConfirmBodySchema = z.object({
  startnummer: z.string().min(1).max(20),
});

const VoidBodySchema = z.object({
  reason: z.string().min(3).max(500),
});

const AssignBodySchema = z.object({
  startnummer: z.string().min(1).max(20),
});

// Query schema for GET /events/:slug/times
const ListTimesQuerySchema = z.object({
  posten_id:  z.string().uuid().optional(),
  confirmed:  z.enum(['true', 'false']).optional(),
  void:       z.enum(['true', 'false']).optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(500).default(100),
  sort:       z.enum(['timestamp', 'created_at']).default('timestamp'),
});

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface TimeEntryRow {
  id:               string;
  event_id:         string;
  posten_id:        string;
  participant_id:   string | null;
  startnummer:      string | null;
  source:           string;
  raw_timestamp_ms: string;
  server_recv_ms:   string;
  lap_number:       number | null;
  sector_number:    number | null;
  channel:          string | null;
  client_seq:       string | null;
  is_confirmed:     boolean;
  is_void:          boolean;
  void_reason:      string | null;
  voided_by:        string | null;
  voided_at:        string | null;
  confirmed_by:     string | null;
  confirmed_at:     string | null;
  created_at:       string;
  updated_at:       string;
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
// Auth helpers: dual-auth (posten session OR bridge_token header)
// ---------------------------------------------------------------------------

interface PostenContext {
  posten_id: string;
  event_id:  string;
  event_slug: string;
  actor_id?: string; // set for JWT-authenticated requests
}

/**
 * Authenticate via X-Posten-Session header OR bridge_token header.
 * On success returns the resolved posten context.
 * On failure sends the appropriate error and returns null.
 */
async function authenticateDual(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<PostenContext | null> {
  // Try X-Posten-Session first
  const sessionToken = request.headers['x-posten-session'];
  if (sessionToken && typeof sessionToken === 'string') {
    const rows = await app.db<
      { posten_id: string; event_id: string; event_slug: string }[]
    >`
      SELECT ps.posten_id, p.event_id, e.slug AS event_slug
      FROM   posten_sessions ps
      JOIN   posten  p ON p.id = ps.posten_id
      JOIN   events  e ON e.id = p.event_id
      WHERE  ps.session_token = ${sessionToken}
        AND  ps.revoked_at   IS NULL
        AND  ps.expires_at   > now()
        AND  e.status        = 'active'
      LIMIT  1
    `;

    if (rows.length === 0) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or expired Posten session',
      });
      return null;
    }

    return rows[0]!;
  }

  // Try bridge_token header
  const bridgeToken = request.headers['bridge_token'] ?? request.headers['x-bridge-token'];
  if (bridgeToken && typeof bridgeToken === 'string') {
    const rows = await app.db<
      { posten_id: string; event_id: string; event_slug: string }[]
    >`
      SELECT bt.posten_id, p.event_id, e.slug AS event_slug
      FROM   bridge_tokens bt
      JOIN   posten  p ON p.id = bt.posten_id
      JOIN   events  e ON e.id = p.event_id
      WHERE  bt.token      = ${bridgeToken}
        AND  bt.revoked_at IS NULL
        AND  bt.expires_at > now()
        AND  e.status      = 'active'
      LIMIT  1
    `;

    if (rows.length === 0) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or expired bridge token',
      });
      return null;
    }

    return rows[0]!;
  }

  reply.status(401).send({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'X-Posten-Session or bridge_token header is required',
  });
  return null;
}

/**
 * Authenticate via X-Posten-Session header only (zeitnehmer).
 * Returns { posten_id, event_id, event_slug }.
 */
async function authenticatePostenSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<PostenContext | null> {
  const sessionToken = request.headers['x-posten-session'];
  if (!sessionToken || typeof sessionToken !== 'string') {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'X-Posten-Session header is required',
    });
    return null;
  }

  const rows = await app.db<
    { posten_id: string; event_id: string; event_slug: string }[]
  >`
    SELECT ps.posten_id, p.event_id, e.slug AS event_slug
    FROM   posten_sessions ps
    JOIN   posten  p ON p.id = ps.posten_id
    JOIN   events  e ON e.id = p.event_id
    WHERE  ps.session_token = ${sessionToken}
      AND  ps.revoked_at   IS NULL
      AND  ps.expires_at   > now()
      AND  e.status        = 'active'
    LIMIT  1
  `;

  if (rows.length === 0) {
    reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired Posten session',
    });
    return null;
  }

  return rows[0]!;
}

/**
 * Serialize a time entry row for API output.
 */
function serialiseEntry(row: TimeEntryRow & { posten_name?: string; participant?: unknown }): Record<string, unknown> {
  return {
    id:               row.id,
    event_id:         row.event_id,
    posten_id:        row.posten_id,
    ...(row.posten_name !== undefined ? { posten_name: row.posten_name } : {}),
    participant_id:   row.participant_id ?? null,
    startnummer:      row.startnummer ?? null,
    source:           row.source,
    raw_timestamp_ms: Number(row.raw_timestamp_ms),
    server_recv_ms:   Number(row.server_recv_ms),
    lap_number:       row.lap_number ?? null,
    sector_number:    row.sector_number ?? null,
    channel:          row.channel ?? null,
    client_seq:       row.client_seq ?? null,
    is_confirmed:     row.is_confirmed,
    is_void:          row.is_void,
    void_reason:      row.void_reason ?? null,
    voided_by:        row.voided_by ?? null,
    voided_at:        row.voided_at ? Number(row.voided_at) : null,
    confirmed_by:     row.confirmed_by ?? null,
    confirmed_at:     row.confirmed_at ? Number(row.confirmed_at) : null,
    created_at:       Number(row.created_at),
    updated_at:       Number(row.updated_at),
    ...(row.participant !== undefined ? { participant: row.participant } : {}),
  };
}

// ---------------------------------------------------------------------------
// Core insert logic (shared between single and batch)
// ---------------------------------------------------------------------------

interface InsertResult {
  entry_id: string;
  status: 'accepted' | 'duplicate';
  entry: TimeEntryRow;
}

async function insertTimeEntry(
  app: FastifyInstance,
  opts: {
    posten_id:        string;
    event_id:         string;
    raw_timestamp_ms: number;
    source:           'manual' | 'timy_bridge';
    startnummer?:     string;
    lap_number?:      number;
    sector_number?:   number;
    channel?:         number;
    client_seq?:      string;
    db?: FastifyInstance['db'] | TransactionSql; // allows passing a transaction sql
  },
): Promise<InsertResult> {
  const db = opts.db ?? app.db;
  const serverRecvMs = Date.now();

  // Dedup: if client_seq provided, check for existing entry
  if (opts.client_seq) {
    const existing = await db<TimeEntryRow[]>`
      SELECT * FROM time_entries
      WHERE posten_id  = ${opts.posten_id}
        AND client_seq = ${opts.client_seq}
      LIMIT 1
    `;
    if (existing.length > 0) {
      return { entry_id: existing[0]!.id, status: 'duplicate', entry: existing[0]! };
    }
  }

  // Resolve participant_id if startnummer is given
  let participantId: string | null = null;
  let isConfirmed = false;

  if (opts.startnummer) {
    const partRows = await db<{ id: string }[]>`
      SELECT id FROM participants
      WHERE  event_id    = ${opts.event_id}
        AND  startnummer = ${opts.startnummer}
      LIMIT  1
    `;
    if (partRows.length > 0) {
      participantId = partRows[0]!.id;
      isConfirmed = true;
    }
  }

  const inserted = await db<TimeEntryRow[]>`
    INSERT INTO time_entries
      (posten_id, participant_id, startnummer, source,
       raw_timestamp_ms, server_recv_ms,
       lap_number, sector_number, channel, client_seq,
       is_confirmed, is_void)
    VALUES (
      ${opts.posten_id},
      ${participantId},
      ${opts.startnummer ?? null},
      ${opts.source},
      ${opts.raw_timestamp_ms},
      ${serverRecvMs},
      ${opts.lap_number ?? null},
      ${opts.sector_number ?? null},
      ${opts.channel != null ? String(opts.channel) : null},
      ${opts.client_seq ?? null},
      ${isConfirmed},
      false
    )
    RETURNING *
  `;

  return { entry_id: inserted[0]!.id, status: 'accepted', entry: inserted[0]! };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function timesRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // POST /times — record a single time entry
  // =========================================================================
  app.post(
    '/times',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticateDual(app, request, reply);
      if (!ctx) return;

      const parseResult = TimeEntryBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body = parseResult.data;

      // Verify that the posten_id in the body belongs to the authenticated posten
      if (body.posten_id !== ctx.posten_id) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'posten_id does not match authenticated session',
        });
      }

      let result: InsertResult;
      try {
        result = await insertTimeEntry(app, {
          posten_id:        body.posten_id,
          event_id:         ctx.event_id,
          raw_timestamp_ms: body.raw_timestamp_ms,
          source:           body.source,
          ...(body.startnummer   !== undefined ? { startnummer:   body.startnummer }   : {}),
          ...(body.lap_number    !== undefined ? { lap_number:    body.lap_number }    : {}),
          ...(body.sector_number !== undefined ? { sector_number: body.sector_number } : {}),
          ...(body.channel       !== undefined ? { channel:       body.channel }       : {}),
          ...(body.client_seq    !== undefined ? { client_seq:    body.client_seq }    : {}),
        });
      } catch (err) {
        app.log.error({ err }, 'POST /times insert error');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Failed to insert time entry' });
      }

      if (result.status === 'accepted') {
        // Enqueue scoring recompute (fire and forget — errors are logged by the queue)
        enqueueCompute(app, ctx.event_id).catch((err: unknown) =>
          app.log.warn({ err }, 'enqueueCompute failed'),
        );

        // Broadcast new entry to all WS subscribers of this event
        broadcast(app, ctx.event_slug, {
          type:       'time_entry',
          event_slug: ctx.event_slug,
          entry:      serialiseEntry(result.entry),
        }).catch((err: unknown) =>
          app.log.warn({ err }, 'WS broadcast failed'),
        );
      }

      return reply.status(result.status === 'accepted' ? 201 : 200).send({
        entry_id: result.entry_id,
        status:   result.status,
        entry:    serialiseEntry(result.entry),
      });
    },
  );

  // =========================================================================
  // POST /times/batch — batch ingest (offline sync)
  // =========================================================================
  app.post(
    '/times/batch',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticatePostenSession(app, request, reply);
      if (!ctx) return;

      const parseResult = BatchBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const { entries } = parseResult.data;

      // Verify all entries reference the authenticated posten
      const forbidden = entries.find((e) => e.posten_id !== ctx.posten_id);
      if (forbidden) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'All entries must reference the authenticated posten',
        });
      }

      type AckItem = { client_seq: string; entry_id: string; status: 'accepted' | 'duplicate' };
      const acks: AckItem[] = [];
      let accepted = 0;
      let duplicates = 0;

      try {
        await app.db.begin(async (tx) => {
          for (const entry of entries) {
            const result = await insertTimeEntry(app, {
              posten_id:        entry.posten_id,
              event_id:         ctx.event_id,
              raw_timestamp_ms: entry.raw_timestamp_ms,
              source:           entry.source,
              client_seq:       entry.client_seq,
              db:               tx,
              ...(entry.startnummer   !== undefined ? { startnummer:   entry.startnummer }   : {}),
              ...(entry.lap_number    !== undefined ? { lap_number:    entry.lap_number }    : {}),
              ...(entry.sector_number !== undefined ? { sector_number: entry.sector_number } : {}),
              ...(entry.channel       !== undefined ? { channel:       entry.channel }       : {}),
            });

            acks.push({
              client_seq: entry.client_seq,
              entry_id:   result.entry_id,
              status:     result.status,
            });

            if (result.status === 'accepted') {
              accepted++;
            } else {
              duplicates++;
            }
          }
        });
      } catch (err) {
        app.log.error({ err }, 'POST /times/batch transaction error');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Batch insert failed' });
      }

      // Trigger scoring and broadcast once for the whole batch
      if (accepted > 0) {
        enqueueCompute(app, ctx.event_id).catch((err: unknown) =>
          app.log.warn({ err }, 'enqueueCompute failed'),
        );

        broadcast(app, ctx.event_slug, {
          type:       'batch_ingested',
          event_slug: ctx.event_slug,
          accepted,
          duplicates,
        }).catch((err: unknown) =>
          app.log.warn({ err }, 'WS broadcast failed'),
        );
      }

      return reply.status(200).send({ acks, accepted, duplicates });
    },
  );

  // =========================================================================
  // GET /events/:slug/times — list time entries for an event
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/times',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string } }>,
      reply: FastifyReply,
    ) => {
      // Auth: veranstalter/kommissar/admin (JWT roles: organizer, admin, timekeeper also has read)
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
      }

      const allowedRoles = ['admin', 'organizer', 'timekeeper'];
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Required role: organizer, timekeeper, or admin',
        });
      }

      // Parse query
      const queryParse = ListTimesQuerySchema.safeParse(request.query);
      if (!queryParse.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid query parameters',
          issues: queryParse.error.flatten().fieldErrors,
        });
      }

      const q = queryParse.data;

      // Resolve event
      const eventRows = await app.db<{ id: string; slug: string }[]>`
        SELECT id, slug FROM events WHERE slug = ${request.params.slug} LIMIT 1
      `;
      if (eventRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Event not found' });
      }

      const event = eventRows[0]!;
      const offset = (q.page - 1) * q.limit;

      // Build dynamic WHERE conditions
      // We use conditional fragments with postgres tagged templates
      type FullEntryRow = TimeEntryRow & { posten_name: string };

      const rows = await app.db<FullEntryRow[]>`
        SELECT
          te.*,
          p.name AS posten_name
        FROM time_entries te
        JOIN posten p ON p.id = te.posten_id
        WHERE te.event_id = ${event.id}
          ${q.posten_id  !== undefined ? app.db`AND te.posten_id = ${q.posten_id}` : app.db``}
          ${q.confirmed  !== undefined ? app.db`AND te.is_confirmed = ${q.confirmed === 'true'}` : app.db``}
          ${q.void       !== undefined ? app.db`AND te.is_void      = ${q.void === 'true'}`      : app.db``}
        ORDER BY ${q.sort === 'timestamp' ? app.db`te.raw_timestamp_ms ASC` : app.db`te.created_at ASC`}
        LIMIT  ${q.limit}
        OFFSET ${offset}
      `;

      // Count for pagination
      const countRows = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM time_entries te
        WHERE te.event_id = ${event.id}
          ${q.posten_id  !== undefined ? app.db`AND te.posten_id = ${q.posten_id}` : app.db``}
          ${q.confirmed  !== undefined ? app.db`AND te.is_confirmed = ${q.confirmed === 'true'}` : app.db``}
          ${q.void       !== undefined ? app.db`AND te.is_void      = ${q.void === 'true'}`      : app.db``}
      `;

      const total = parseInt(countRows[0]?.count ?? '0', 10);

      return reply.send({
        data:  rows.map((r) => serialiseEntry(r)),
        meta: {
          page:        q.page,
          limit:       q.limit,
          total,
          total_pages: Math.ceil(total / q.limit),
        },
      });
    },
  );

  // =========================================================================
  // PATCH /times/:id/confirm — attach startnummer to an unconfirmed entry
  // =========================================================================
  app.patch<{ Params: { id: string } }>(
    '/times/:id/confirm',
    {},
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      // Auth: zeitnehmer (own posten) OR veranstalter/kommissar
      let actorId: string | undefined;
      let postenCtx: PostenContext | null = null;

      const sessionToken = request.headers['x-posten-session'];
      if (sessionToken && typeof sessionToken === 'string') {
        postenCtx = await authenticatePostenSession(app, request, reply);
        if (!postenCtx) return;
      } else {
        try {
          await request.jwtVerify();
        } catch {
          return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
        }
        const allowedRoles = ['admin', 'organizer', 'timekeeper'];
        if (!allowedRoles.includes(request.user.role)) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Required role: organizer, timekeeper, or admin',
          });
        }
        actorId = request.user.sub;
      }

      const parseResult = ConfirmBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const { startnummer } = parseResult.data;

      // Fetch entry
      const entryRows = await app.db<TimeEntryRow[]>`
        SELECT te.*, e.slug AS event_slug_col
        FROM   time_entries te
        JOIN   events e ON e.id = te.event_id
        WHERE  te.id = ${request.params.id}
        LIMIT  1
      `;

      if (entryRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Time entry not found' });
      }

      const entry = entryRows[0]!;

      // If zeitnehmer, verify they own this posten
      if (postenCtx && entry.posten_id !== postenCtx.posten_id) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Entry belongs to a different posten',
        });
      }

      // Lookup participant by startnummer in same event
      const partRows = await app.db<{ id: string }[]>`
        SELECT id FROM participants
        WHERE  event_id    = ${entry.event_id}
          AND  startnummer = ${startnummer}
        LIMIT  1
      `;

      if (partRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Participant with startnummer "${startnummer}" not found in this event`,
        });
      }

      const participantId = partRows[0]!.id;
      const confirmedBy = postenCtx ? postenCtx.posten_id : actorId!;

      const updated = await app.db<TimeEntryRow[]>`
        UPDATE time_entries SET
          participant_id = ${participantId},
          startnummer    = ${startnummer},
          is_confirmed   = true,
          confirmed_by   = ${confirmedBy},
          confirmed_at   = ${Date.now()}
        WHERE id = ${entry.id}
        RETURNING *
      `;

      const updatedEntry = updated[0]!;

      // Resolve event slug for broadcast
      const slugRows = await app.db<{ slug: string }[]>`
        SELECT slug FROM events WHERE id = ${entry.event_id} LIMIT 1
      `;
      const eventSlug = slugRows[0]?.slug ?? '';

      // Fetch participant for broadcast
      const participantFull = await app.db<Record<string, unknown>[]>`
        SELECT id, event_id, startnummer, first_name, last_name, team, category,
               bib_color, created_at, updated_at
        FROM   participants
        WHERE  id = ${participantId}
        LIMIT  1
      `;

      if (eventSlug && participantFull.length > 0) {
        broadcast(app, eventSlug, {
          type:        'participant_confirmed',
          event_slug:  eventSlug,
          entry_id:    entry.id,
          participant: participantFull[0],
        }).catch((err: unknown) => app.log.warn({ err }, 'WS broadcast failed'));
      }

      enqueueCompute(app, entry.event_id).catch((err: unknown) =>
        app.log.warn({ err }, 'enqueueCompute failed'),
      );

      return reply.send(serialiseEntry(updatedEntry));
    },
  );

  // =========================================================================
  // PATCH /times/:id/void — void an entry (veranstalter/kommissar/admin only)
  // =========================================================================
  app.patch<{ Params: { id: string } }>(
    '/times/:id/void',
    {},
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
      }

      const allowedRoles = ['admin', 'organizer'];
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Required role: organizer or admin',
        });
      }

      const parseResult = VoidBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const { reason } = parseResult.data;

      const entryRows = await app.db<TimeEntryRow[]>`
        SELECT * FROM time_entries WHERE id = ${request.params.id} LIMIT 1
      `;

      if (entryRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Time entry not found' });
      }

      const entry = entryRows[0]!;

      if (entry.is_void) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Entry is already voided',
        });
      }

      const updated = await app.db<TimeEntryRow[]>`
        UPDATE time_entries SET
          is_void     = true,
          void_reason = ${reason},
          voided_by   = ${request.user.sub},
          voided_at   = ${Date.now()}
        WHERE id = ${entry.id}
        RETURNING *
      `;

      const updatedEntry = updated[0]!;

      await writeAuditLog(app.db, {
        event_id:    entry.event_id,
        actor_id:    request.user.sub,
        action:      'time_entry.void',
        entity_type: 'time_entry',
        entity_id:   entry.id,
        after_state: { is_void: true, void_reason: reason } as JSONValue,
        ip_address:  request.ip,
      }).catch((err: unknown) => app.log.warn({ err }, 'audit log write failed'));

      enqueueCompute(app, entry.event_id).catch((err: unknown) =>
        app.log.warn({ err }, 'enqueueCompute failed'),
      );

      return reply.send(serialiseEntry(updatedEntry));
    },
  );

  // =========================================================================
  // PATCH /times/:id/assign — re-assign entry to a different participant
  // =========================================================================
  app.patch<{ Params: { id: string } }>(
    '/times/:id/assign',
    {},
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
      }

      const allowedRoles = ['admin', 'organizer'];
      if (!allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Required role: organizer or admin',
        });
      }

      const parseResult = AssignBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const { startnummer } = parseResult.data;

      const entryRows = await app.db<TimeEntryRow[]>`
        SELECT * FROM time_entries WHERE id = ${request.params.id} LIMIT 1
      `;

      if (entryRows.length === 0) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Time entry not found' });
      }

      const entry = entryRows[0]!;

      const partRows = await app.db<{ id: string }[]>`
        SELECT id FROM participants
        WHERE  event_id    = ${entry.event_id}
          AND  startnummer = ${startnummer}
        LIMIT  1
      `;

      if (partRows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Participant with startnummer "${startnummer}" not found in this event`,
        });
      }

      const participantId = partRows[0]!.id;

      const updated = await app.db<TimeEntryRow[]>`
        UPDATE time_entries SET
          participant_id = ${participantId},
          startnummer    = ${startnummer},
          is_confirmed   = true,
          confirmed_by   = ${request.user.sub},
          confirmed_at   = ${Date.now()}
        WHERE id = ${entry.id}
        RETURNING *
      `;

      const updatedEntry = updated[0]!;

      await writeAuditLog(app.db, {
        event_id:    entry.event_id,
        actor_id:    request.user.sub,
        action:      'time_entry.assign',
        entity_type: 'time_entry',
        entity_id:   entry.id,
        after_state: {
          participant_id: participantId,
          startnummer,
        } as JSONValue,
        ip_address:  request.ip,
      }).catch((err: unknown) => app.log.warn({ err }, 'audit log write failed'));

      enqueueCompute(app, entry.event_id).catch((err: unknown) =>
        app.log.warn({ err }, 'enqueueCompute failed'),
      );

      return reply.send(serialiseEntry(updatedEntry));
    },
  );
}

// ---------------------------------------------------------------------------
// Export — use fastify-plugin so the decorator (app.db, etc.) is visible
// across all routes registered in this plugin.
// ---------------------------------------------------------------------------

export const timesRoutes = fp(timesRoutesFn, {
  name: 'times-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
