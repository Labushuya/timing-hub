/**
 * tests/integration/setup.ts
 *
 * Shared test harness for integration tests.
 *
 * Responsibilities:
 *  - Build the Fastify app (buildServer) against TEST_DATABASE_URL
 *  - Run all SQL migrations against the test DB
 *  - Export: app (FastifyInstance), db (postgres Sql instance)
 *  - Provide truncateAllTables() for per-suite cleanup
 *  - Teardown: close app + DB connection
 *
 * Usage in test suites:
 *   import { app, db, truncateAllTables } from './setup.js';
 *   beforeAll(() => setupIntegration());   // optional — import-side-effect
 *   afterAll(() => teardownIntegration());
 *   beforeEach(() => truncateAllTables());
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/timing_hub_test';

const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ??
  process.env.REDIS_URL ??
  'redis://localhost:6379';

const TEST_JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-for-integration-tests-min-32-chars!!';

// Set env vars before importing the server module
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL     = TEST_REDIS_URL;
process.env.JWT_SECRET    = TEST_JWT_SECRET;
process.env.NODE_ENV      = 'test';

// ---------------------------------------------------------------------------
// Singletons — set once per process
// ---------------------------------------------------------------------------

let _app: FastifyInstance | null  = null;
let _db:  Sql | null              = null;

export function getApp(): FastifyInstance {
  if (!_app) throw new Error('Integration test setup not complete — call setupIntegration() first');
  return _app;
}

export function getDb(): Sql {
  if (!_db) throw new Error('Integration test setup not complete — call setupIntegration() first');
  return _db;
}

// Convenience re-exports that match the documented API
export let app: FastifyInstance;
export let db: Sql;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, '../../src/db/migrations');

const MIGRATION_FILES = [
  '001_initial.sql',
  '002_events.sql',
  '003_posten.sql',
  '004_participants.sql',
  '005_time_entries.sql',
];

async function runMigrations(sql: Sql): Promise<void> {
  for (const file of MIGRATION_FILES) {
    const migrationSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.unsafe(migrationSql);
  }
}

// ---------------------------------------------------------------------------
// Table list (order matters: children before parents for truncate)
// ---------------------------------------------------------------------------

const TRUNCATE_ORDER = [
  'audit_log',
  'results',
  'time_entries',
  'posten_sessions',
  'participants',
  'posten',
  'events',
  'refresh_tokens',
  'registration_tokens',
  'users',
];

export async function truncateAllTables(): Promise<void> {
  const sql = getDb();
  // RESTART IDENTITY cascades sequences; CASCADE handles FK ordering
  await sql.unsafe(
    `TRUNCATE TABLE ${TRUNCATE_ORDER.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function setupIntegration(): Promise<void> {
  // 1. Standalone DB connection for migration + truncation
  _db = postgres(TEST_DATABASE_URL, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    transform: { undefined: null },
  });
  db = _db;

  // 2. Run migrations
  await runMigrations(_db);

  // 3. Build Fastify app (imports server.ts, which will read DATABASE_URL from env)
  const { buildServer } = await import('../../src/server.js');
  _app = await buildServer();
  app = _app;

  // Ensure Fastify is ready to handle injected requests
  await _app.ready();
}

export async function teardownIntegration(): Promise<void> {
  if (_app) {
    await _app.close();
    _app = null;
  }
  if (_db) {
    await _db.end({ timeout: 5 });
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Helper: create a valid registration token in the DB
// ---------------------------------------------------------------------------

export async function createRegistrationToken(
  role: 'admin' | 'organizer' | 'timekeeper' | 'viewer' = 'organizer',
): Promise<string> {
  const sql = getDb();
  const rows = await sql<{ token: string }[]>`
    INSERT INTO registration_tokens (role, expires_at)
    VALUES (${role}, now() + INTERVAL '1 hour')
    RETURNING token
  `;
  return rows[0]!.token;
}

// ---------------------------------------------------------------------------
// Helper: register a user and return tokens
// ---------------------------------------------------------------------------

export interface RegisteredUser {
  id:            string;
  email:         string;
  display_name:  string;
  role:          string;
  access_token:  string;
  refresh_token: string;
}

export async function registerUser(opts: {
  email?:        string;
  password?:     string;
  display_name?: string;
  role?:         'admin' | 'organizer' | 'timekeeper' | 'viewer';
}): Promise<RegisteredUser> {
  const fastify = getApp();
  const token = await createRegistrationToken(opts.role ?? 'organizer');

  const email       = opts.email        ?? `user_${Date.now()}@example.com`;
  const password    = opts.password     ?? 'TestPassword123!';
  const displayName = opts.display_name ?? 'Test User';

  const response = await fastify.inject({
    method: 'POST',
    url:    '/api/v1/auth/register',
    payload: { token, email, password, display_name: displayName },
  });

  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(
      `registerUser failed: ${response.statusCode} ${response.body}`,
    );
  }

  const body = response.json<{
    access_token:  string;
    refresh_token: string;
    user: { id: string; email: string; display_name: string; role: string };
  }>();

  return {
    id:            body.user.id,
    email:         body.user.email,
    display_name:  body.user.display_name,
    role:          body.user.role,
    access_token:  body.access_token,
    refresh_token: body.refresh_token,
  };
}
