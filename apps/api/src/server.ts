import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
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

// CORS origin validation — required in production
const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN;
if (NODE_ENV === 'production' && !CORS_ORIGIN_RAW) {
  throw new Error('CORS_ORIGIN env var is required in production');
}
const CORS_ORIGINS = CORS_ORIGIN_RAW?.split(',') ?? ['http://localhost:3000'];

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
// Sentry — initialise before any route/plugin registration
// ---------------------------------------------------------------------------
const SENTRY_DSN = process.env.SENTRY_DSN;

// Non-actionable HTTP status codes — do not alert on these
const SENTRY_IGNORED_STATUS_CODES = new Set([401, 404, 429]);

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    release: pkgVersion,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event, hint) {
      // Filter out non-actionable HTTP errors (404, 401, 429)
      const err = hint?.originalException;
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode !== undefined && SENTRY_IGNORED_STATUS_CODES.has(statusCode)) {
          return null;
        }
      }
      return event;
    },
  });
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
    origin: CORS_ORIGINS,
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'https:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginEmbedderPolicy: false, // needed for some browsers
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
  // Request ID plugin
  // -------------------------------------------------------------------------
  const { requestIdPlugin } = await import('./plugins/requestId.js');
  await app.register(requestIdPlugin);

  // -------------------------------------------------------------------------
  // Request logging plugin
  // -------------------------------------------------------------------------
  const { requestLoggingPlugin } = await import('./plugins/requestLogging.js');
  await app.register(requestLoggingPlugin);

  // -------------------------------------------------------------------------
  // Metrics plugin
  // -------------------------------------------------------------------------
  const { metricsPlugin } = await import('./plugins/metrics.js');
  await app.register(metricsPlugin);

  app.log.info({ origins: CORS_ORIGINS }, 'CORS allowed origins');

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
    // Wire Sentry's Fastify error handler for automatic transaction + error capture
    Sentry.setupFastifyErrorHandler(app);

    // Override the default error handler to:
    //  - skip non-actionable errors (already filtered via beforeSend, but avoid noise)
    //  - attach user context from JWT when available
    //  - return a clean JSON error body
    app.setErrorHandler((error: FastifyError, request, reply) => {
      const statusCode = error.statusCode ?? 500;

      // Attach user context if JWT payload is available
      try {
        const jwtPayload = request.user as { sub?: string; email?: string } | undefined;
        if (jwtPayload?.sub) {
          Sentry.setUser({ id: jwtPayload.sub, ...(jwtPayload.email !== undefined ? { email: jwtPayload.email } : {}) });
        }
      } catch {
        // JWT not decoded — ignore
      }

      if (!SENTRY_IGNORED_STATUS_CODES.has(statusCode)) {
        Sentry.captureException(error);
      }

      app.log.error(error);
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
