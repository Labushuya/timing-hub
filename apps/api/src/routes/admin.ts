/**
 * routes/admin.ts — Admin routes (role: admin)
 *
 * All endpoints require Bearer JWT with role=admin.
 *
 *   POST   /admin/tokens            — issue a registration token
 *   GET    /admin/tokens            — list registration tokens (paginated)
 *   DELETE /admin/tokens/:id        — soft-delete (immediate invalidation)
 *   GET    /admin/users             — list users (paginated, filterable)
 *   PATCH  /admin/users/:id         — update user role / deactivation
 */
import fp from 'fastify-plugin';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '../plugins/auth.js';
import { generateToken } from '../services/tokenService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expiresAtFromDuration(duration: '7d' | '30d' | '90d'): Date {
  const days = duration === '7d' ? 7 : duration === '30d' ? 30 : 90;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const createTokenBodySchema = {
  type: 'object',
  required: ['role', 'expires_in'],
  additionalProperties: false,
  properties: {
    role:       { type: 'string', enum: ['veranstalter', 'kommissar'] },
    email:      { type: 'string', format: 'email', maxLength: 254 },
    expires_in: { type: 'string', enum: ['7d', '30d', '90d'] },
  },
} as const;

const listTokensQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page:   { type: 'integer', minimum: 1, default: 1 },
    limit:  { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    status: { type: 'string', enum: ['active', 'used', 'expired', 'all'], default: 'all' },
  },
} as const;

const listUsersQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page:                { type: 'integer', minimum: 1, default: 1 },
    limit:               { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    role:                { type: 'string', enum: ['all', 'admin', 'organizer', 'timekeeper', 'viewer', 'veranstalter', 'kommissar'], default: 'all' },
    search:              { type: 'string', maxLength: 200 },
    include_deactivated: { type: 'boolean', default: false },
  },
} as const;

const patchUserBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    role:        { type: 'string', enum: ['admin', 'organizer', 'timekeeper', 'viewer'] },
    deactivated: { type: 'boolean' },
  },
} as const;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function adminRoutesFn(app: FastifyInstance): Promise<void> {
  const adminGuard = [app.authenticate, app.requireRole('admin')];

  // -------------------------------------------------------------------------
  // POST /admin/tokens — issue a registration token
  // -------------------------------------------------------------------------
  app.post<{ Body: { role: string; email?: string; expires_in: '7d' | '30d' | '90d' } }>(
    '/tokens',
    {
      preHandler: adminGuard,
      schema: {
        body: createTokenBodySchema,
        response: {
          201: {
            type: 'object',
            properties: {
              id:              { type: 'string' },
              token:           { type: 'string' },
              role:            { type: 'string' },
              expires_at:      { type: 'string' },
              issued_to_email: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { role, email, expires_in } = request.body;
      const issuedBy = request.user.sub;

      const id = crypto.randomUUID();
      const token = generateToken(32); // 64-char hex
      const expiresAt = expiresAtFromDuration(expires_in);

      await app.db`
        INSERT INTO registration_tokens (id, token, issued_by, issued_to_email, role, expires_at, created_at)
        VALUES (
          ${id},
          ${token},
          ${issuedBy},
          ${email ?? null},
          ${role},
          ${expiresAt},
          now()
        )
      `;

      return reply.status(201).send({
        id,
        token,
        role,
        expires_at:      expiresAt.toISOString(),
        issued_to_email: email ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/tokens — list registration tokens (paginated)
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { page?: number; limit?: number; status?: string } }>(
    '/tokens',
    {
      preHandler: adminGuard,
      schema: {
        querystring: listTokensQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              tokens: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id:              { type: 'string' },
                    token:           { type: 'string' },
                    role:            { type: 'string' },
                    status:          { type: 'string' },
                    expires_at:      { type: 'string' },
                    issued_to_email: { type: ['string', 'null'] },
                    issued_by:       { type: 'string' },
                    used_at:         { type: ['string', 'null'] },
                    created_at:      { type: 'string' },
                  },
                },
              },
              total: { type: 'integer' },
              page:  { type: 'integer' },
              limit: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const page  = request.query.page  ?? 1;
      const limit = request.query.limit ?? 20;
      const status = request.query.status ?? 'all';
      const offset = (page - 1) * limit;

      // Build status filter clause
      let whereClause: string;
      if (status === 'used') {
        whereClause = 'WHERE used_at IS NOT NULL';
      } else if (status === 'expired') {
        whereClause = 'WHERE used_at IS NULL AND expires_at < now()';
      } else if (status === 'active') {
        whereClause = 'WHERE used_at IS NULL AND expires_at >= now()';
      } else {
        whereClause = '';
      }

      // Count query
      const countRows = await app.db<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM registration_tokens
        ${app.db.unsafe(whereClause)}
      `;
      const total = parseInt(countRows[0]?.count ?? '0', 10);

      // Data query
      const rows = await app.db<{
        id: string;
        token: string;
        role: string;
        expires_at: Date;
        issued_to_email: string | null;
        issued_by: string;
        used_at: Date | null;
        created_at: Date;
      }[]>`
        SELECT id, token, role, expires_at, issued_to_email, issued_by, used_at, created_at
        FROM registration_tokens
        ${app.db.unsafe(whereClause)}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const now = new Date();
      const tokens = rows.map((row) => ({
        id:              row.id,
        token:           row.token,
        role:            row.role,
        status:          row.used_at
          ? 'used'
          : row.expires_at < now
            ? 'expired'
            : 'active',
        expires_at:      row.expires_at.toISOString(),
        issued_to_email: row.issued_to_email,
        issued_by:       row.issued_by,
        used_at:         row.used_at?.toISOString() ?? null,
        created_at:      row.created_at.toISOString(),
      }));

      return reply.send({ tokens, total, page, limit });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/tokens/:id — soft-delete (set expires_at = now)
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/tokens/:id',
    {
      preHandler: adminGuard,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      // Check token exists (no tenant scoping needed — single-tenant admin)
      const rows = await app.db<{ id: string }[]>`
        SELECT id FROM registration_tokens
        WHERE id = ${id}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Registration token not found',
        });
      }

      // Soft-delete: set expires_at = now() to immediately invalidate
      await app.db`
        UPDATE registration_tokens
        SET expires_at = now()
        WHERE id = ${id}
      `;

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/users — list users (paginated, filterable)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      page?: number;
      limit?: number;
      role?: string;
      search?: string;
      include_deactivated?: boolean;
    };
  }>(
    '/users',
    {
      preHandler: adminGuard,
      schema: {
        querystring: listUsersQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id:           { type: 'string' },
                    email:        { type: 'string' },
                    role:         { type: 'string' },
                    display_name: { type: 'string' },
                    is_active:    { type: 'boolean' },
                    created_at:   { type: 'string' },
                  },
                },
              },
              total: { type: 'integer' },
              page:  { type: 'integer' },
              limit: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const page               = request.query.page  ?? 1;
      const limit              = request.query.limit ?? 20;
      const role               = request.query.role  ?? 'all';
      const search             = request.query.search?.trim();
      const includeDeactivated = request.query.include_deactivated ?? false;
      const offset             = (page - 1) * limit;

      // Build conditions
      const conditions: string[] = [];
      if (!includeDeactivated) {
        conditions.push('is_active = true');
      }
      if (role !== 'all') {
        conditions.push(`role = '${role.replace(/'/g, "''")}'`);
      }
      if (search) {
        const escaped = search.replace(/'/g, "''");
        conditions.push(
          `(display_name ILIKE '%${escaped}%' OR email ILIKE '%${escaped}%')`,
        );
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      const countRows = await app.db<{ count: string }[]>`
        SELECT COUNT(*) AS count
        FROM users
        ${app.db.unsafe(whereClause)}
      `;
      const total = parseInt(countRows[0]?.count ?? '0', 10);

      const rows = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        is_active: boolean;
        created_at: Date;
      }[]>`
        SELECT id, email, role, display_name, is_active, created_at
        FROM users
        ${app.db.unsafe(whereClause)}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const users = rows.map((u) => ({
        id:           u.id,
        email:        u.email,
        role:         u.role,
        display_name: u.display_name,
        is_active:    u.is_active,
        created_at:   u.created_at.toISOString(),
      }));

      return reply.send({ users, total, page, limit });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/users/:id — update role or deactivation status
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { role?: UserRole; deactivated?: boolean } }>(
    '/users/:id',
    {
      preHandler: adminGuard,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: patchUserBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              id:           { type: 'string' },
              email:        { type: 'string' },
              role:         { type: 'string' },
              display_name: { type: 'string' },
              is_active:    { type: 'boolean' },
              created_at:   { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { role, deactivated } = request.body;
      const callerId = request.user.sub;

      // Guard: cannot modify own account
      if (id === callerId) {
        if (deactivated !== undefined) {
          return reply.status(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: 'You cannot deactivate your own account',
          });
        }
        if (role !== undefined) {
          return reply.status(422).send({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: 'You cannot change your own role',
          });
        }
      }

      // Fetch existing user
      const existing = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        is_active: boolean;
        created_at: Date;
      }[]>`
        SELECT id, email, role, display_name, is_active, created_at
        FROM users
        WHERE id = ${id}
        LIMIT 1
      `;

      if (existing.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'User not found',
        });
      }

      const current = existing[0]!;
      const newRole     = role        ?? current.role;
      const newIsActive = deactivated !== undefined ? !deactivated : current.is_active;

      const updated = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        is_active: boolean;
        created_at: Date;
      }[]>`
        UPDATE users
        SET role      = ${newRole},
            is_active = ${newIsActive}
        WHERE id = ${id}
        RETURNING id, email, role, display_name, is_active, created_at
      `;

      const u = updated[0]!;
      return reply.send({
        id:           u.id,
        email:        u.email,
        role:         u.role,
        display_name: u.display_name,
        is_active:    u.is_active,
        created_at:   u.created_at.toISOString(),
      });
    },
  );
}

export const adminRoutes = fp(adminRoutesFn, {
  name: 'admin-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
