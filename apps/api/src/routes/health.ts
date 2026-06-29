import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pkgVersion = 'unknown';
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version?: string };
  pkgVersion = pkg.version ?? 'unknown';
} catch {
  // non-fatal
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status:    { type: 'string' },
              db:        { type: 'string' },
              redis:     { type: 'string' },
              version:   { type: 'string' },
              uptime_ms: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const startMs = Date.now();

      // --- DB probe ---
      let dbStatus = 'ok';
      try {
        await app.db`SELECT 1`;
      } catch {
        dbStatus = 'error';
      }

      // --- Redis probe ---
      let redisStatus = 'ok';
      try {
        const pong = await app.redis.ping();
        if (pong !== 'PONG') redisStatus = 'error';
      } catch {
        redisStatus = 'error';
      }

      const status = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';
      const httpStatus = status === 'ok' ? 200 : 503;

      return reply.status(httpStatus).send({
        status,
        db:        dbStatus,
        redis:     redisStatus,
        version:   pkgVersion,
        uptime_ms: Math.round(process.uptime() * 1000),
      });
    },
  );
}
