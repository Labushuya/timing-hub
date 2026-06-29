import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// JWT payload shape
// ---------------------------------------------------------------------------
export interface JwtPayload {
  sub: string;       // user id (uuid)
  email: string;
  role: 'admin' | 'organizer' | 'timekeeper' | 'viewer';
  iat?: number;
  exp?: number;
}

export type UserRole = JwtPayload['role'];

// ---------------------------------------------------------------------------
// Module augmentation
// ---------------------------------------------------------------------------
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: UserRole | UserRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticatePosten: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');

async function authPluginFn(app: FastifyInstance): Promise<void> {
  // @fastify/jwt is already registered by server.ts; here we only add decorators.
  // If running standalone (e.g. tests), register jwt ourselves:
  if (!app.hasDecorator('jwt')) {
    await app.register(fjwt, {
      secret: JWT_SECRET!,
      sign: { expiresIn: '15m' },
    });
  }

  // ------------------------------------------------------------------
  // fastify.authenticate — verify Bearer JWT, populate request.user
  // ------------------------------------------------------------------
  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await request.jwtVerify<JwtPayload>();
      } catch (err) {
        reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
      }
    },
  );

  // ------------------------------------------------------------------
  // fastify.requireRole — authenticate AND check role
  // ------------------------------------------------------------------
  app.decorate(
    'requireRole',
    (role: UserRole | UserRole[]) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        try {
          await request.jwtVerify<JwtPayload>();
        } catch {
          return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
        }

        const allowed = Array.isArray(role) ? role : [role];
        if (!allowed.includes(request.user.role)) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: `Required role: ${allowed.join(' or ')}`,
          });
        }
      },
  );

  // ------------------------------------------------------------------
  // fastify.authenticatePosten — validate X-Posten-Session header vs DB
  // ------------------------------------------------------------------
  app.decorate(
    'authenticatePosten',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const sessionToken = request.headers['x-posten-session'];
      if (!sessionToken || typeof sessionToken !== 'string') {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'X-Posten-Session header is required',
        });
      }

      try {
        const rows = await app.db<
          { posten_id: string; event_id: string; expires_at: Date }[]
        >`
          SELECT ps.posten_id, ps.event_id, ps.expires_at
          FROM posten_sessions ps
          WHERE ps.token = ${sessionToken}
            AND ps.revoked_at IS NULL
            AND ps.expires_at > now()
          LIMIT 1
        `;

        if (rows.length === 0) {
          return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Invalid or expired Posten session',
          });
        }

        // Attach session info to request for downstream handlers
        (request as FastifyRequest & { postenSession: NonNullable<typeof rows[0]> }).postenSession = rows[0]!
      } catch (err) {
        app.log.error(err, 'authenticatePosten DB error');
        return reply.status(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'Session validation failed' });
      }
    },
  );
}

export const authPlugin = fp(authPluginFn, {
  name: 'auth',
  fastify: '5.x',
  dependencies: ['postgres'],
});
