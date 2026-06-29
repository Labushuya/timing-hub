import fp from 'fastify-plugin';
import postgres, { type Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: Sql;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL env var is required');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

async function connectWithRetry(log: FastifyInstance['log']): Promise<Sql> {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      const sql = postgres(DATABASE_URL!, {
        max: 20,
        idle_timeout: 30,
        connect_timeout: 10,
        transform: { undefined: null },
        onnotice: (notice) => log.debug({ notice }, 'Postgres notice'),
      });
      // Probe the connection
      await sql`SELECT 1`;
      log.info({ attempt }, 'Postgres connected');
      return sql;
    } catch (err) {
      log.warn({ err, attempt, maxRetries: MAX_RETRIES }, 'Postgres connection failed, retrying');
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('Unreachable');
}

async function postgresPluginFn(app: FastifyInstance): Promise<void> {
  const sql = await connectWithRetry(app.log);

  app.decorate('db', sql);

  app.addHook('onClose', async () => {
    app.log.info('Closing Postgres connection');
    await sql.end({ timeout: 5 });
  });
}

export const postgresPlugin = fp(postgresPluginFn, {
  name: 'postgres',
  fastify: '5.x',
});
