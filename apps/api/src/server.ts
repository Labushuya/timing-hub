import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import * as Sentry from '@sentry/node';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const isDev = NODE_ENV === 'development';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL env var is required');

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const SENTRY_DSN = process.env.SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN, environment: NODE_ENV });
}

// ---------------------------------------------------------------------------
// Package version (optional — may not exist in all envs)
// ---------------------------------------------------------------------------
let pkgVersion = 'unknown';
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version?: string };
  pkgVersion = pkg.version ?? 'unknown';
} catch {
  // non-fatal
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
          },
        }
      : true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: 'array',
        useDefaults: true,
      },
    },
    trustProxy: true,
  });

  // -------------------------------------------------------------------------
  // Global plugins
  // -------------------------------------------------------------------------
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}.`,
    }),
  });

  await app.register(jwt, {
    secret: JWT_SECRET as string,
    sign: { expiresIn: '15m' },
  });

  await app.register(websocket);

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
      files: 5,
    },
  });

  // -------------------------------------------------------------------------
  // Internal plugins (db, redis, auth decorators)
  // -------------------------------------------------------------------------
  const { postgresPlugin } = await import('./plugins/postgres.js');
  await app.register(postgresPlugin);

  const { redisPlugin } = await import('./plugins/redis.js');
  await app.register(redisPlugin);

  const { authPlugin } = await import('./plugins/auth.js');
  await app.register(authPlugin);

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  const { registerRoutes } = await import('./routes/index.js');
  await registerRoutes(app);

  // -------------------------------------------------------------------------
  // WebSocket hub
  // -------------------------------------------------------------------------
  const { registerWsHub } = await import('./ws/hub.js');
  await registerWsHub(app);

  // -------------------------------------------------------------------------
  // Scoring worker (background, non-blocking)
  // -------------------------------------------------------------------------
  const { startScoringWorker } = await import('./services/scoring/index.js');
  const scoringWorker = startScoringWorker(app);
  app.addHook('onClose', async () => {
    app.log.info('Closing scoring worker');
    await scoringWorker.close();
  });

  // -------------------------------------------------------------------------
  // Sentry error handler (must be last)
  // -------------------------------------------------------------------------
  if (SENTRY_DSN) {
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      Sentry.captureException(error);
      app.log.error(error);
      const statusCode = error.statusCode ?? 500;
      reply.status(statusCode).send({
        statusCode,
        error: error.name,
        message: isDev ? error.message : 'Internal Server Error',
      });
    });
  }

  return app;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helper
// ---------------------------------------------------------------------------
async function gracefulShutdown(app: FastifyInstance, signal: string): Promise<void> {
  app.log.info({ signal }, 'Received shutdown signal — closing server');
  try {
    await app.close();
    app.log.info('Server closed cleanly');
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const app = await buildServer();

  process.on('SIGTERM', () => void gracefulShutdown(app, 'SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown(app, 'SIGINT'));

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Exports for type inference by @timing-hub/web or testing
// ---------------------------------------------------------------------------
export type { AppType } from './routes/index.js';

void main();
