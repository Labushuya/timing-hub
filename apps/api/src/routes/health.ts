/**
 * routes/health.ts — Comprehensive health check endpoint
 *
 * GET /health
 *
 * Returns:
 *   {
 *     status:    'ok' | 'degraded' | 'error',
 *     version:   string,
 *     uptime_ms: number,
 *     checks: {
 *       database:       { status: 'ok'|'error', latency_ms: number },
 *       redis:          { status: 'ok'|'error', latency_ms: number },
 *       scoring_worker: { status: 'ok'|'idle'|'error', queue_depth: number }
 *     },
 *     ws: {
 *       connected_clients: number,
 *       active_rooms:      number
 *     }
 *   }
 *
 * HTTP status:
 *   200  — ok or degraded  (Railway / load-balancer keeps the instance alive)
 *   503  — error           (hard failure, restart the instance)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { getScoringQueue } from '../services/scoring/index.js';
import { metrics } from '../plugins/metrics.js';

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

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

async function checkDatabase(app: FastifyInstance): Promise<{ status: 'ok' | 'error'; latency_ms: number }> {
  const start = Date.now();
  try {
    await app.db`SELECT 1`;
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch {
    return { status: 'error', latency_ms: Date.now() - start };
  }
}

async function checkRedis(app: FastifyInstance): Promise<{ status: 'ok' | 'error'; latency_ms: number }> {
  const start = Date.now();
  try {
    const pong = await app.redis.ping();
    const status = pong === 'PONG' ? 'ok' : 'error';
    return { status, latency_ms: Date.now() - start };
  } catch {
    return { status: 'error', latency_ms: Date.now() - start };
  }
}

async function checkScoringWorker(
  app: FastifyInstance,
): Promise<{ status: 'ok' | 'idle' | 'error'; queue_depth: number }> {
  try {
    const queue = getScoringQueue(app);
    const [waiting, active] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
    ]);
    const depth = waiting + active;
    return {
      status: depth > 0 ? 'ok' : 'idle',
      queue_depth: depth,
    };
  } catch {
    return { status: 'error', queue_depth: 0 };
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

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
              version:   { type: 'string' },
              uptime_ms: { type: 'number' },
              checks: {
                type: 'object',
                properties: {
                  database: {
                    type: 'object',
                    properties: {
                      status:     { type: 'string' },
                      latency_ms: { type: 'number' },
                    },
                  },
                  redis: {
                    type: 'object',
                    properties: {
                      status:     { type: 'string' },
                      latency_ms: { type: 'number' },
                    },
                  },
                  scoring_worker: {
                    type: 'object',
                    properties: {
                      status:      { type: 'string' },
                      queue_depth: { type: 'number' },
                    },
                  },
                },
              },
              ws: {
                type: 'object',
                properties: {
                  connected_clients: { type: 'number' },
                  active_rooms:      { type: 'number' },
                },
              },
            },
          },
          503: {
            type: 'object',
            properties: {
              status:  { type: 'string' },
              version: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Run DB and Redis checks in parallel; scoring check is fast (Redis queue)
      const [dbCheck, redisCheck, scoringCheck] = await Promise.all([
        checkDatabase(app),
        checkRedis(app),
        checkScoringWorker(app),
      ]);

      const allChecksOk =
        dbCheck.status === 'ok' &&
        redisCheck.status === 'ok' &&
        scoringCheck.status !== 'error';

      // 'error' only if ALL critical checks fail (DB + Redis down simultaneously)
      const criticalFailure = dbCheck.status === 'error' && redisCheck.status === 'error';

      const overallStatus = criticalFailure
        ? 'error'
        : allChecksOk
          ? 'ok'
          : 'degraded';

      const httpStatus = overallStatus === 'error' ? 503 : 200;

      return reply.status(httpStatus).send({
        status: overallStatus,
        version: pkgVersion,
        uptime_ms: Math.round(process.uptime() * 1000),
        checks: {
          database: dbCheck,
          redis: redisCheck,
          scoring_worker: scoringCheck,
        },
        ws: {
          connected_clients: metrics.getGauge('ws.connected_clients'),
          active_rooms: metrics.getGauge('ws.active_rooms'),
        },
      });
    },
  );
}
