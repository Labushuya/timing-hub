/**
 * routes/auth.ts — Authentication routes
 *
 *   POST /api/v1/auth/register      — register with invite token
 *   POST /api/v1/auth/login         — email + password → access + refresh tokens
 *   POST /api/v1/auth/refresh       — rotate refresh token
 *   POST /api/v1/auth/logout        — revoke refresh token
 *   GET  /api/v1/auth/me            — current user info (requires Bearer token)
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  verifyRegistrationToken,
  markTokenUsed,
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  tokenService,
} from '../services/tokenService.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
  authRateLimitConfig,
  registerRateLimitConfig,
} from '../plugins/security.js';

// ---------------------------------------------------------------------------
// JSON Schemas (inline — no zod-to-json-schema dep needed)
// ---------------------------------------------------------------------------

const registerBodySchema = {
  type: 'object',
  required: ['token', 'email', 'password', 'display_name'],
  additionalProperties: false,
  properties: {
    token:        { type: 'string', minLength: 1 },
    email:        { type: 'string', format: 'email', maxLength: 254 },
    password:     { type: 'string', minLength: 8, maxLength: 128 },
    display_name: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email:    { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

const refreshBodySchema = {
  type: 'object',
  required: ['refresh_token'],
  additionalProperties: false,
  properties: {
    refresh_token: { type: 'string', minLength: 1 },
  },
} as const;

const logoutBodySchema = {
  type: 'object',
  required: ['refresh_token'],
  additionalProperties: false,
  properties: {
    refresh_token: { type: 'string', minLength: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const userResponse = {
  type: 'object',
  properties: {
    id:           { type: 'string' },
    email:        { type: 'string' },
    role:         { type: 'string' },
    display_name: { type: 'string' },
    locale:       { type: ['string', 'null'] },
    created_at:   { type: 'string' },
  },
} as const;

const tokenPairResponse = {
  type: 'object',
  properties: {
    access_token:  { type: 'string' },
    refresh_token: { type: 'string' },
    user:          userResponse,
  },
} as const;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function authRoutesFn(app: FastifyInstance): Promise<void> {

  // -------------------------------------------------------------------------
  // POST /auth/register
  // -------------------------------------------------------------------------
  app.post(
    '/register',
    {
      config: { rateLimit: registerRateLimitConfig },
      schema: {
        body: registerBodySchema,
        response: { 200: tokenPairResponse },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { token: string; email: string; password: string; display_name: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { token, email, password, display_name } = request.body;

      // 1. Validate registration token
      const regToken = await verifyRegistrationToken(app.db, token);
      if (!regToken) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid or expired registration token',
        });
      }

      // 2. Check email uniqueness
      const existing = await app.db<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${email.toLowerCase()} LIMIT 1
      `;
      if (existing.length > 0) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Email address is already registered',
        });
      }

      // 3. Hash password
      const passwordHash = await hashPassword(password);

      // 4. Insert user
      const insertedRows = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        created_at: Date;
      }[]>`
        INSERT INTO users (email, password_hash, display_name, role)
        VALUES (${email.toLowerCase()}, ${passwordHash}, ${display_name}, ${regToken.role})
        RETURNING id, email, role, display_name, created_at
      `;

      const user = insertedRows[0]!;

      // 5. Mark registration token as used
      await markTokenUsed(app.db, regToken.id, user.id);

      // 6. Issue tokens
      const jwtPayload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role as JwtPayload['role'],
      };

      const accessToken = generateAccessToken(app, jwtPayload);
      const userAgent = request.headers['user-agent'];
      const { token: refreshToken } = await generateRefreshToken(app, user.id, {
        ...(userAgent !== undefined ? { userAgent } : {}),
        ipAddress: request.ip,
      });

      return reply.send({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id:           user.id,
          email:        user.email,
          role:         user.role,
          display_name: user.display_name,
          locale:       null,
          created_at:   user.created_at.toISOString(),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------
  app.post(
    '/login',
    {
      config: { rateLimit: authRateLimitConfig },
      schema: {
        body: loginBodySchema,
        response: { 200: tokenPairResponse },
      },
    },
    async (
      request: FastifyRequest<{ Body: { email: string; password: string } }>,
      reply: FastifyReply,
    ) => {
      const { email, password } = request.body;

      // Look up user — use a constant-time response to prevent user enumeration
      const rows = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        password_hash: string;
        is_active: boolean;
        created_at: Date;
      }[]>`
        SELECT id, email, role, display_name, password_hash, is_active, created_at
        FROM users
        WHERE email = ${email.toLowerCase()}
        LIMIT 1
      `;

      const INVALID_MSG = 'Invalid credentials';

      if (rows.length === 0) {
        // Run a dummy verify to maintain constant timing
        await verifyPassword('$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password).catch(() => {});
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: INVALID_MSG });
      }

      const user = rows[0]!;

      const valid = await verifyPassword(user.password_hash, password);
      if (!valid || !user.is_active) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: INVALID_MSG });
      }

      const jwtPayload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role as JwtPayload['role'],
      };

      const accessToken = generateAccessToken(app, jwtPayload);
      const userAgent = request.headers['user-agent'];
      const { token: refreshToken } = await generateRefreshToken(app, user.id, {
        ...(userAgent !== undefined ? { userAgent } : {}),
        ipAddress: request.ip,
      });

      return reply.send({
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          id:           user.id,
          email:        user.email,
          role:         user.role,
          display_name: user.display_name,
          locale:       null,
          created_at:   user.created_at.toISOString(),
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/refresh
  // -------------------------------------------------------------------------
  app.post(
    '/refresh',
    {
      schema: {
        body: refreshBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              access_token:  { type: 'string' },
              refresh_token: { type: 'string' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { refresh_token: string } }>,
      reply: FastifyReply,
    ) => {
      const { refresh_token } = request.body;

      // Decode to get userId for DB fetch
      let decoded: { sub?: string; jti?: string; type?: string } | null = null;
      try {
        decoded = app.jwt.decode<{ sub?: string; jti?: string; type?: string }>(refresh_token);
      } catch {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid refresh token' });
      }

      if (!decoded?.sub || !decoded?.jti) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid refresh token' });
      }

      // Verify JWT signature & expiry
      try {
        app.jwt.verify<{ sub: string; jti: string }>(refresh_token);
      } catch {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Refresh token expired or invalid' });
      }

      // Look up token in DB
      const tokenRows = await app.db<{
        id: string;
        user_id: string;
        token_hash: string;
        family: string;
        revoked_at: Date | null;
        expires_at: Date;
      }[]>`
        SELECT id, user_id, token_hash, family, revoked_at, expires_at
        FROM refresh_tokens
        WHERE id = ${decoded.jti}
        LIMIT 1
      `;

      if (tokenRows.length === 0) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Refresh token not found' });
      }

      const rt = tokenRows[0]!;

      // Reuse detection — revoke entire family if already revoked
      if (rt.revoked_at !== null) {
        await app.db`
          UPDATE refresh_tokens
          SET revoked_at = now()
          WHERE family    = ${rt.family}
            AND revoked_at IS NULL
        `;
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Refresh token reuse detected — all sessions revoked',
        });
      }

      if (rt.expires_at < new Date()) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Refresh token expired' });
      }

      // Fetch current user to get fresh role
      const userRows = await app.db<{
        id: string;
        email: string;
        role: string;
        is_active: boolean;
      }[]>`
        SELECT id, email, role, is_active
        FROM users
        WHERE id = ${rt.user_id}
        LIMIT 1
      `;

      if (userRows.length === 0 || !userRows[0]!.is_active) {
        return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'User not found or deactivated' });
      }

      const user = userRows[0]!;

      // Revoke old token and issue new pair (rotation)
      await app.db`
        UPDATE refresh_tokens
        SET revoked_at = now()
        WHERE id = ${decoded.jti}
      `;

      const jwtPayload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role as JwtPayload['role'],
      };

      const accessToken = generateAccessToken(app, jwtPayload);
      const userAgent = request.headers['user-agent'];
      const { token: newRefreshToken } = await generateRefreshToken(app, user.id, {
        ...(userAgent !== undefined ? { userAgent } : {}),
        ipAddress: request.ip,
        family: rt.family,
      });

      return reply.send({
        access_token:  accessToken,
        refresh_token: newRefreshToken,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  app.post(
    '/logout',
    {
      schema: { body: logoutBodySchema },
    },
    async (
      request: FastifyRequest<{ Body: { refresh_token: string } }>,
      reply: FastifyReply,
    ) => {
      const { refresh_token } = request.body;

      let jti: string | undefined;
      try {
        const decoded = app.jwt.decode<{ jti?: string }>(refresh_token);
        jti = decoded?.jti;
      } catch {
        // Ignore decode errors on logout — always return 204
      }

      if (jti) {
        await app.db`
          UPDATE refresh_tokens
          SET revoked_at = now()
          WHERE id         = ${jti}
            AND revoked_at IS NULL
        `.catch((err) => {
          app.log.warn({ err }, 'logout: failed to revoke refresh token');
        });
      }

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /auth/me
  // -------------------------------------------------------------------------
  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              id:           { type: 'string' },
              email:        { type: 'string' },
              role:         { type: 'string' },
              display_name: { type: 'string' },
              locale:       { type: ['string', 'null'] },
              created_at:   { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.sub;

      const rows = await app.db<{
        id: string;
        email: string;
        role: string;
        display_name: string;
        created_at: Date;
      }[]>`
        SELECT id, email, role, display_name, created_at
        FROM users
        WHERE id = ${userId}
          AND is_active = true
        LIMIT 1
      `;

      if (rows.length === 0) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'User not found or deactivated',
        });
      }

      const user = rows[0]!;

      return reply.send({
        id:           user.id,
        email:        user.email,
        role:         user.role,
        display_name: user.display_name,
        locale:       null,
        created_at:   user.created_at.toISOString(),
      });
    },
  );
}

export const authRoutes = fp(authRoutesFn, {
  name: 'auth-routes',
  fastify: '5.x',
  dependencies: ['auth', 'postgres'],
});
