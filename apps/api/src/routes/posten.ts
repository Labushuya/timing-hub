/**
 * routes/posten.ts — Posten (timing station) management routes
 *
 * Event-scoped (auth: owner or admin):
 *   POST   /events/:slug/posten                       — create posten
 *   GET    /events/:slug/posten                       — list posten
 *   GET    /events/:slug/posten/:code                 — get single posten
 *   PATCH  /events/:slug/posten/:code                 — update posten
 *   DELETE /events/:slug/posten/:code                 — delete posten
 *   POST   /events/:slug/posten/:code/regenerate-tokens — rotate access_token + bridge_token
 *
 * Public:
 *   POST   /posten/:accessToken/session               — device login (creates posten_session)
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { JSONValue } from 'postgres';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSTEN_ROLE_VALUES = ['start', 'finish', 'intermediate', 'sector_split'] as const;
type PostenRole = typeof POSTEN_ROLE_VALUES[number];

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 h in milliseconds

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PostenRoleEnum = z.enum(POSTEN_ROLE_VALUES);

const CreatePostenBodySchema = z.object({
  code:       z.string().min(1).max(20).regex(/^[A-Z0-9_-]+$/, 'code must be uppercase alphanumeric'),
  name:       z.string().min(1).max(100),
  sort_order: z.number().int().min(0).optional().default(0),
  role:       PostenRoleEnum,
});

const PatchPostenBodySchema = z.object({
  name:       z.string().min(1).max(100).optional(),
  sort_order: z.number().int().min(0).optional(),
  role:       PostenRoleEnum.optional(),
});

const CreateSessionBodySchema = z.object({
  device_hint: z.string().max(200).optional(),
});

type CreatePostenBody = z.infer<typeof CreatePostenBodySchema>;
type PatchPostenBody  = z.infer<typeof PatchPostenBodySchema>;

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface EventRow {
  id:       string;
  owner_id: string;
  slug:     string;
  name:     string;
  format:   string;
  status:   string;
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

// ---------------------------------------------------------------------------
// Serialiser helpers
// ---------------------------------------------------------------------------

function serialisePosten(p: PostenRow, includePrivate: boolean): Record<string, unknown> {
  return {
    id:           p.id,
    event_id:     p.event_id,
    code:         p.code,
    name:         p.name,
    sort_order:   p.sort_order,
    role:         p.role,
    access_token: p.access_token,
    ...(includePrivate ? { bridge_token: p.bridge_token } : {}),
    created_at:   Number(p.created_at),
  };
}

// ---------------------------------------------------------------------------
// Audit helper (mirrors events.ts)
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
// Shared guard: resolve event + check owner/admin
// ---------------------------------------------------------------------------

async function resolveEventAndCheckAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string,
): Promise<EventRow | null> {
  // Require authentication
  try {
    await request.jwtVerify();
  } catch {
    reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
    return null;
  }

  const rows = await app.db<EventRow[]>`
    SELECT id, owner_id, slug, name, format, status
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
// Plugin
// ---------------------------------------------------------------------------

async function postenRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // POST /events/:slug/posten — create posten
  // =========================================================================
  app.post<{ Params: { slug: string } }>(
    '/events/:slug/posten',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const parseResult = CreatePostenBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: CreatePostenBody = parseResult.data;

      // Check code uniqueness within event
      const existing = await app.db<{ id: string }[]>`
        SELECT id FROM posten
        WHERE event_id = ${event.id} AND code = ${body.code}
        LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Posten with code "${body.code}" already exists in this event`,
        });
      }

      // INSERT — access_token and bridge_token are DB DEFAULT (gen_random_bytes(32)::hex)
      const rows = await app.db<PostenRow[]>`
        INSERT INTO posten (event_id, code, name, sort_order, role)
        VALUES (${event.id}, ${body.code}, ${body.name}, ${body.sort_order}, ${body.role})
        RETURNING *
      `;

      const posten = rows[0]!;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'posten.create',
        entity_type: 'posten',
        entity_id:   posten.id,
        after_state: { code: posten.code, name: posten.name, role: posten.role } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.status(201).send(serialisePosten(posten, true));
    },
  );

  // =========================================================================
  // GET /events/:slug/posten — list all posten
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/posten',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<PostenRow[]>`
        SELECT * FROM posten
        WHERE event_id = ${event.id}
        ORDER BY sort_order ASC, code ASC
      `;

      return reply.send(rows.map((p) => serialisePosten(p, true)));
    },
  );

  // =========================================================================
  // GET /events/:slug/posten/:code — get single posten
  // =========================================================================
  app.get<{ Params: { slug: string; code: string } }>(
    '/events/:slug/posten/:code',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; code: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<PostenRow[]>`
        SELECT * FROM posten
        WHERE event_id = ${event.id} AND code = ${request.params.code}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Posten "${request.params.code}" not found`,
        });
      }

      return reply.send(serialisePosten(rows[0]!, true));
    },
  );

  // =========================================================================
  // PATCH /events/:slug/posten/:code — update posten
  // =========================================================================
  app.patch<{ Params: { slug: string; code: string } }>(
    '/events/:slug/posten/:code',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; code: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const parseResult = PatchPostenBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: PatchPostenBody = parseResult.data;

      if (!body.name && body.sort_order === undefined && !body.role) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'At least one field (name, sort_order, role) must be provided',
        });
      }

      const existing = await app.db<PostenRow[]>`
        SELECT * FROM posten
        WHERE event_id = ${event.id} AND code = ${request.params.code}
        LIMIT 1
      `;

      if (existing.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Posten "${request.params.code}" not found`,
        });
      }

      const updated = await app.db<PostenRow[]>`
        UPDATE posten SET
          name       = COALESCE(${body.name       ?? null}, name),
          sort_order = COALESCE(${body.sort_order ?? null}, sort_order),
          role       = COALESCE(${body.role       ?? null}, role)
        WHERE id = ${existing[0]!.id}
        RETURNING *
      `;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'posten.update',
        entity_type: 'posten',
        entity_id:   existing[0]!.id,
        after_state: body as unknown as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(serialisePosten(updated[0]!, true));
    },
  );

  // =========================================================================
  // DELETE /events/:slug/posten/:code — delete posten
  // =========================================================================
  app.delete<{ Params: { slug: string; code: string } }>(
    '/events/:slug/posten/:code',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; code: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<PostenRow[]>`
        SELECT * FROM posten
        WHERE event_id = ${event.id} AND code = ${request.params.code}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Posten "${request.params.code}" not found`,
        });
      }

      const posten = rows[0]!;

      // Guard: no time_entries referencing this posten
      const teRows = await app.db<{ count: string }[]>`
        SELECT count(*)::text AS count FROM time_entries
        WHERE posten_id = ${posten.id}
        LIMIT 1
      `;
      const teCount = parseInt(teRows[0]?.count ?? '0', 10);
      if (teCount > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Cannot delete posten "${posten.code}": ${teCount} time entr${teCount === 1 ? 'y' : 'ies'} reference it`,
        });
      }

      await app.db`DELETE FROM posten WHERE id = ${posten.id}`;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'posten.delete',
        entity_type: 'posten',
        entity_id:   posten.id,
        after_state: { code: posten.code } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.status(204).send();
    },
  );

  // =========================================================================
  // POST /events/:slug/posten/:code/regenerate-tokens
  // =========================================================================
  app.post<{ Params: { slug: string; code: string } }>(
    '/events/:slug/posten/:code/regenerate-tokens',
    {},
    async (
      request: FastifyRequest<{ Params: { slug: string; code: string } }>,
      reply: FastifyReply,
    ) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<PostenRow[]>`
        SELECT * FROM posten
        WHERE event_id = ${event.id} AND code = ${request.params.code}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Posten "${request.params.code}" not found`,
        });
      }

      const posten = rows[0]!;

      // Regenerate both tokens via DB function to guarantee uniqueness
      const updated = await app.db<{ access_token: string; bridge_token: string | null }[]>`
        UPDATE posten SET
          access_token = encode(gen_random_bytes(32), 'hex'),
          bridge_token = encode(gen_random_bytes(32), 'hex')
        WHERE id = ${posten.id}
        RETURNING access_token, bridge_token
      `;

      const newTokens = updated[0]!;

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'posten.regenerate_tokens',
        entity_type: 'posten',
        entity_id:   posten.id,
        after_state: { code: posten.code } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send({
        access_token: newTokens.access_token,
        bridge_token: newTokens.bridge_token,
      });
    },
  );

  // =========================================================================
  // POST /posten/:accessToken/session — PUBLIC device login
  // =========================================================================
  app.post<{ Params: { accessToken: string } }>(
    '/posten/:accessToken/session',
    {},
    async (
      request: FastifyRequest<{ Params: { accessToken: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = CreateSessionBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const body = parseResult.data;

      // Look up posten by access_token; join to event to check status
      const rows = await app.db<
        (PostenRow & {
          event_id:     string;
          event_slug:   string;
          event_name:   string;
          event_format: string;
          event_status: string;
        })[]
      >`
        SELECT
          p.id,
          p.event_id,
          p.code,
          p.name,
          p.sort_order,
          p.role,
          p.access_token,
          p.bridge_token,
          p.created_at,
          e.slug   AS event_slug,
          e.name   AS event_name,
          e.format AS event_format,
          e.status AS event_status
        FROM posten p
        JOIN events e ON e.id = p.event_id
        WHERE p.access_token = ${request.params.accessToken}
          AND e.status = 'active'
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid access token or event is not active',
        });
      }

      const row = rows[0]!;

      const now       = Date.now();
      const expiresAt = now + SESSION_TTL_MS;

      // Create posten_session — session_token is DB DEFAULT
      const sessionRows = await app.db<{ id: string; session_token: string; expires_at: string }[]>`
        INSERT INTO posten_sessions
          (posten_id, device_hint, created_at, expires_at)
        VALUES (
          ${row.id},
          ${body.device_hint ?? null},
          ${now},
          ${expiresAt}
        )
        RETURNING id, session_token, expires_at
      `;

      const session = sessionRows[0]!;

      return reply.status(201).send({
        session_token: session.session_token,
        expires_at:    Number(session.expires_at),
        posten: {
          id:   row.id,
          code: row.code,
          name: row.name,
          role: row.role,
        },
        event: {
          id:     row.event_id,
          slug:   row.event_slug,
          name:   row.event_name,
          format: row.event_format,
          status: row.event_status,
        },
        bridge_connected: false,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const postenRoutes = fp(postenRoutesFn, {
  name: 'posten-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
