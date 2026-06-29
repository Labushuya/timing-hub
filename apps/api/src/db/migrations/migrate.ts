/**
 * migrate.ts — node-pg-migrate runner
 *
 * Usage:
 *   npx tsx src/db/migrations/migrate.ts          (runs pending UP migrations)
 *   npx tsx src/db/migrations/migrate.ts down 1   (rolls back 1 migration)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { default: run } = require('node-pg-migrate');

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var is required');
  process.exit(1);
}

const direction = (process.argv[2] ?? 'up') as 'up' | 'down';
const count = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

try {
  await run({
    databaseUrl: DATABASE_URL,
    migrationsTable: 'pgmigrations',
    dir: join(__dirname),
    direction,
    count,
    // Only pick up plain .sql files — not this .ts file
    ignorePattern: '.*\\.ts$',
    log: (msg: string) => console.log('[migrate]', msg),
    verbose: true,
  });
  console.log('[migrate] Done.');
  process.exit(0);
} catch (err) {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
}
