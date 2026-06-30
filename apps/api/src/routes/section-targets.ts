/**
 * routes/section-targets.ts — Section target (Sollzeit) management routes
 *
 * Event-scoped (auth: owner or admin):
 *   GET  /events/:slug/section-targets  — list all section targets with posten codes
 *   PUT  /events/:slug/section-targets  — replace all section targets (transactional)
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { JSONValue } from 'postgres';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SectionTargetItemSchema = z.object({
  from_posten_id: z.string().uuid().nullable(),
  to_posten_id:   z.string().uuid().nullable(),
  class:          z.string().max(50).nullable(),
  target_time_ms: z.number().int().min(0),
});

const PutSectionTargetsBodySchema = z.array(SectionTargetItemSchema).max(500);

type SectionTargetItem = z.infer<typeof SectionTargetItemSchema>;

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

interface SectionTargetRow {
  id:             string;
  event_id:       string;
  from_posten_id: string | null;
  to_posten_id:   string | null;
  class:          string | null;
  target_time_ms: string; // BIGINT comes back as string from postgres driver
  created_at:     string;
}

interface SectionTargetJoinedRow extends SectionTargetRow {
  from_posten_code: string | null;
  to_posten_code:   string | null;
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
// Shared guard: resolve event + check owner/admin
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
// Serialiser
// ---------------------------------------------------------------------------

function serialiseSectionTarget(row: SectionTargetJoinedRow): Record<string, unknown> {
  return {
    id:               row.id,
    event_id:         row.event_id,
    from_posten_id:   row.from_posten_id,
    from_posten_code: row.from_posten_code,
    to_posten_id:     row.to_posten_id,
    to_posten_code:   row.to_posten_code,
    class:            row.class,
    target_time_ms:   Number(row.target_time_ms),
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function sectionTargetRoutesFn(app: FastifyInstance): Promise<void> {

  // =========================================================================
  // GET /events/:slug/section-targets — list section targets with posten codes
  // =========================================================================
  app.get<{ Params: { slug: string } }>(
    '/events/:slug/section-targets',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const rows = await app.db<SectionTargetJoinedRow[]>`
        SELECT
          st.id,
          st.event_id,
          st.from_posten_id,
          pf.code AS from_posten_code,
          st.to_posten_id,
          pt.code AS to_posten_code,
          st.class,
          st.target_time_ms,
          st.created_at
        FROM section_targets st
        LEFT JOIN posten pf ON pf.id = st.from_posten_id
        LEFT JOIN posten pt ON pt.id = st.to_posten_id
        WHERE st.event_id = ${event.id}
        ORDER BY st.created_at ASC
      `;

      return reply.send(rows.map(serialiseSectionTarget));
    },
  );

  // =========================================================================
  // PUT /events/:slug/section-targets — replace all section targets
  // =========================================================================
  app.put<{ Params: { slug: string } }>(
    '/events/:slug/section-targets',
    {},
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const event = await resolveEventAndCheckAccess(app, request, reply, request.params.slug);
      if (!event) return;

      const parseResult = PutSectionTargetsBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Validation error',
          issues: parseResult.error.flatten().fieldErrors,
        });
      }

      const items: SectionTargetItem[] = parseResult.data;

      // Validate: all non-null posten_ids must belong to this event
      const allPostedIds = [
        ...items.map((i) => i.from_posten_id).filter((id): id is string => id !== null),
        ...items.map((i) => i.to_posten_id).filter((id): id is string => id !== null),
      ];

      if (allPostedIds.length > 0) {
        const uniqueIds = [...new Set(allPostedIds)];

        const validPosten = await app.db<{ id: string }[]>`
          SELECT id FROM posten
          WHERE event_id = ${event.id}
            AND id = ANY(${uniqueIds}::uuid[])
        `;

        const validSet = new Set(validPosten.map((p) => p.id));
        const invalidIds = uniqueIds.filter((id) => !validSet.has(id));

        if (invalidIds.length > 0) {
          return reply.status(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: `Posten IDs do not belong to this event: ${invalidIds.join(', ')}`,
          });
        }
      }

      // Transactional: delete + re-insert
      const newRows = await app.db.begin(async (sql) => {
        // Delete all existing section_targets for this event
        await sql`
          DELETE FROM section_targets WHERE event_id = ${event.id}
        `;

        if (items.length === 0) {
          return [] as SectionTargetJoinedRow[];
        }

        // Bulk insert
        const inserted = await sql<SectionTargetRow[]>`
          INSERT INTO section_targets
            (event_id, from_posten_id, to_posten_id, class, target_time_ms)
          SELECT
            ${event.id}::uuid,
            x.from_posten_id::uuid,
            x.to_posten_id::uuid,
            x.class,
            x.target_time_ms::bigint
          FROM json_to_recordset(${sql.json(
            items.map((i) => ({
              from_posten_id: i.from_posten_id,
              to_posten_id:   i.to_posten_id,
              class:          i.class,
              target_time_ms: i.target_time_ms,
            })),
          )}) AS x(
            from_posten_id text,
            to_posten_id   text,
            class          text,
            target_time_ms bigint
          )
          RETURNING *
        `;

        // Fetch with posten codes
        const ids = inserted.map((r) => r.id);
        const joined = await sql<SectionTargetJoinedRow[]>`
          SELECT
            st.id,
            st.event_id,
            st.from_posten_id,
            pf.code AS from_posten_code,
            st.to_posten_id,
            pt.code AS to_posten_code,
            st.class,
            st.target_time_ms,
            st.created_at
          FROM section_targets st
          LEFT JOIN posten pf ON pf.id = st.from_posten_id
          LEFT JOIN posten pt ON pt.id = st.to_posten_id
          WHERE st.id = ANY(${ids}::uuid[])
          ORDER BY st.created_at ASC
        `;

        return joined;
      });

      await writeAuditLog(app.db, {
        event_id:    event.id,
        actor_id:    request.user.sub,
        action:      'section_targets.replace',
        entity_type: 'section_targets',
        entity_id:   event.id,
        after_state: { count: items.length } as JSONValue,
        ip_address:  request.ip,
      }).catch((err) => app.log.warn({ err }, 'audit log write failed'));

      return reply.send(newRows.map(serialiseSectionTarget));
    },
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const sectionTargetRoutes = fp(sectionTargetRoutesFn, {
  name: 'section-target-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
