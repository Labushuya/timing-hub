/**
 * tests/integration/events.test.ts
 *
 * Integration tests for:
 *   POST   /api/v1/events            — create event
 *   GET    /api/v1/events/:slug      — get event details
 *   POST   /api/v1/events/:slug/activate — draft → active
 *   POST   /api/v1/events/:slug/import  — CSV participant import
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupIntegration,
  teardownIntegration,
  truncateAllTables,
  registerUser,
  getApp,
  getDb,
  type RegisteredUser,
} from './setup.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupIntegration();
}, 60_000);

afterAll(async () => {
  await teardownIntegration();
});

beforeEach(async () => {
  await truncateAllTables();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = '/api/v1/events';

interface EventBody {
  name:      string;
  format:    'glp' | 'sonderpruefung' | 'rundstrecke' | 'orientierung';
  starts_at: number;
  timezone?: string;
  config:    Record<string, unknown>;
}

const DEFAULT_EVENT: EventBody = {
  name:      'Test Rallye 2026',
  format:    'glp',
  starts_at: new Date('2026-07-01T10:00:00Z').getTime(),
  timezone:  'Europe/Berlin',
  config:    { target_time_ms: 120_000 },
};

async function createEvent(
  user: RegisteredUser,
  body: Partial<EventBody> = {},
) {
  return getApp().inject({
    method:  'POST',
    url:     BASE,
    headers: { authorization: `Bearer ${user.access_token}` },
    payload: { ...DEFAULT_EVENT, ...body },
  });
}

async function getEvent(slug: string, accessToken?: string) {
  return getApp().inject({
    method:  'GET',
    url:     `${BASE}/${slug}`,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

// Build a minimal valid CSV string
function buildCsv(rows: { startnummer: string; driver_name: string }[]): string {
  const header = 'startnummer,driver_name,co_driver_name,car_make,car_model';
  const dataRows = rows.map(
    (r) => `${r.startnummer},${r.driver_name},,,`,
  );
  return [header, ...dataRows].join('\n');
}

// ---------------------------------------------------------------------------
// POST /events — create event
// ---------------------------------------------------------------------------

describe('POST /events', () => {
  it('valid body → 201 + slug generated + default posten created', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const res       = await createEvent(organizer);
    const body      = res.json();

    expect(res.statusCode).toBe(201);
    expect(body.slug).toBeTruthy();
    // Slug must be derived from name
    expect(body.slug).toContain('test-rallye');
    expect(body.format).toBe('glp');
    expect(body.status).toBe('draft');

    // Default posten should be present
    expect(Array.isArray(body.posten)).toBe(true);
    expect(body.posten.length).toBeGreaterThanOrEqual(1);

    // For glp format: expect START + ZIEL
    const codes = (body.posten as { code: string }[]).map((p) => p.code);
    expect(codes).toContain('START');
    expect(codes).toContain('ZIEL');
  });

  it('rundstrecke format creates single ZEIT posten', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const res  = await createEvent(organizer, { format: 'rundstrecke', name: 'Circuit Race 2026' });
    const body = res.json();

    expect(res.statusCode).toBe(201);
    const codes = (body.posten as { code: string }[]).map((p) => p.code);
    expect(codes).toContain('ZEIT');
    expect(codes).not.toContain('START');
  });

  it('unauthenticated → 401', async () => {
    const res = await getApp().inject({
      method:  'POST',
      url:     BASE,
      payload: DEFAULT_EVENT,
    });
    expect(res.statusCode).toBe(401);
  });

  it('viewer role → 403 (insufficient role)', async () => {
    const viewer = await registerUser({ role: 'viewer' });
    const res    = await createEvent(viewer);
    expect(res.statusCode).toBe(403);
  });

  it('missing required field → 400', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const { name: _n, ...withoutName } = DEFAULT_EVENT;
    const res = await getApp().inject({
      method:  'POST',
      url:     BASE,
      headers: { authorization: `Bearer ${organizer.access_token}` },
      payload: withoutName,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /events/:slug — get event details
// ---------------------------------------------------------------------------

describe('GET /events/:slug', () => {
  it('owner can see their own draft event', async () => {
    const organizer  = await registerUser({ role: 'organizer' });
    const createRes  = await createEvent(organizer);
    const { slug }   = createRes.json<{ slug: string }>();

    const res  = await getEvent(slug, organizer.access_token);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.slug).toBe(slug);
    expect(body.status).toBe('draft');
  });

  it('unauthenticated public request → 404 for draft event', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    // No auth header — public visitor
    const res = await getEvent(slug);
    expect(res.statusCode).toBe(404);
  });

  it('non-owner authenticated user → 404 for draft event', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const other     = await registerUser({ role: 'organizer', email: 'other@example.com' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    const res = await getEvent(slug, other.access_token);
    expect(res.statusCode).toBe(404);
  });

  it('unknown slug → 404', async () => {
    const res = await getEvent('this-slug-does-not-exist-2026');
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /events/:slug/activate — draft → active
// ---------------------------------------------------------------------------

describe('POST /events/:slug/activate', () => {
  async function activateEvent(slug: string, accessToken: string) {
    return getApp().inject({
      method:  'POST',
      url:     `${BASE}/${slug}/activate`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async function insertParticipant(eventId: string) {
    const db  = getDb();
    const now = Date.now();
    await db`
      INSERT INTO participants (event_id, startnummer, driver_name, created_at, updated_at)
      VALUES (${eventId}, '1', 'Test Driver', ${now}, ${now})
    `;
  }

  it('activate with ≥1 participant + ≥1 posten → 200 status=active', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const event     = createRes.json<{ id: string; slug: string }>();

    await insertParticipant(event.id);

    const res  = await activateEvent(event.slug, organizer.access_token);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
  });

  it('activate with no participants → 422 with error message', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    // No participants inserted — default posten exist (created on event creation)
    const res = await activateEvent(slug, organizer.access_token);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/participant/i);
  });

  it('non-owner cannot activate → 403', async () => {
    const organizer  = await registerUser({ role: 'organizer' });
    const other      = await registerUser({ role: 'organizer', email: 'other@example.com' });
    const createRes  = await createEvent(organizer);
    const event      = createRes.json<{ id: string; slug: string }>();

    await insertParticipant(event.id);

    const res = await activateEvent(event.slug, other.access_token);
    expect(res.statusCode).toBe(403);
  });

  it('activating an already-active event → 409', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const event     = createRes.json<{ id: string; slug: string }>();

    await insertParticipant(event.id);

    // First activation succeeds
    await activateEvent(event.slug, organizer.access_token);

    // Second activation should fail
    const res = await activateEvent(event.slug, organizer.access_token);
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /events/:slug/import — CSV participant import
// ---------------------------------------------------------------------------

describe('POST /events/:slug/import', () => {
  async function importCsv(
    slug:        string,
    accessToken: string,
    csvContent:  string,
  ) {
    // Use multipart/form-data via inject
    // Fastify inject supports multipart via Readable streams or Buffer
    const boundary = '----TestBoundary123';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="participants.csv"',
      'Content-Type: text/csv',
      '',
      csvContent,
      `--${boundary}--`,
    ].join('\r\n');

    return getApp().inject({
      method:  'POST',
      url:     `${BASE}/${slug}/import`,
      headers: {
        authorization:  `Bearer ${accessToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  }

  it('valid CSV → correct participant count in response', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    const csv = buildCsv([
      { startnummer: '1', driver_name: 'Alice Müller' },
      { startnummer: '2', driver_name: 'Bob Schmidt' },
      { startnummer: '3', driver_name: 'Carol Weber' },
    ]);

    const res  = await importCsv(slug, organizer.access_token, csv);
    const body = res.json<{ imported: number; skipped: number; errors: unknown[] }>();

    expect(res.statusCode).toBe(200);
    expect(body.imported).toBe(3);
    expect(body.skipped).toBe(0);
    expect(body.errors).toHaveLength(0);

    // Verify DB count
    const db  = getDb();
    const rows = await db<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM participants pt
      JOIN events e ON e.id = pt.event_id
      WHERE e.slug = ${slug}
    `;
    expect(parseInt(rows[0]!.count, 10)).toBe(3);
  });

  it('duplicate startnummer → upsert (no error, updated record)', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    const csv1 = buildCsv([{ startnummer: '1', driver_name: 'Alice Müller' }]);
    await importCsv(slug, organizer.access_token, csv1);

    // Import same startnummer with updated name
    const csv2 = buildCsv([{ startnummer: '1', driver_name: 'Alice Müller-Updated' }]);
    const res   = await importCsv(slug, organizer.access_token, csv2);
    const body  = res.json<{ imported: number; skipped: number }>();

    expect(res.statusCode).toBe(200);
    // Upsert counts as imported
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(0);

    // Still only 1 participant in DB
    const db  = getDb();
    const rows = await db<{ count: string; driver_name: string }[]>`
      SELECT count(*)::text AS count, min(driver_name) AS driver_name
      FROM participants pt
      JOIN events e ON e.id = pt.event_id
      WHERE e.slug = ${slug}
    `;
    expect(parseInt(rows[0]!.count, 10)).toBe(1);
    expect(rows[0]!.driver_name).toBe('Alice Müller-Updated');
  });

  it('CSV with duplicate startnummern within the same import → last write wins', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    // Two rows with the same startnummer in a single CSV
    const csv = buildCsv([
      { startnummer: '5', driver_name: 'First' },
      { startnummer: '5', driver_name: 'Second' },
    ]);

    const res  = await importCsv(slug, organizer.access_token, csv);
    const body = res.json<{ imported: number }>();

    expect(res.statusCode).toBe(200);
    // Both rows process without error (ON CONFLICT DO UPDATE)
    expect(body.imported).toBe(2);
  });

  it('non-owner → 403', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const other     = await registerUser({ role: 'organizer', email: 'other@example.com' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    const csv = buildCsv([{ startnummer: '1', driver_name: 'Alice' }]);
    const res = await importCsv(slug, other.access_token, csv);
    expect(res.statusCode).toBe(403);
  });

  it('empty CSV → 400', async () => {
    const organizer = await registerUser({ role: 'organizer' });
    const createRes = await createEvent(organizer);
    const { slug }  = createRes.json<{ slug: string }>();

    const res = await importCsv(slug, organizer.access_token, 'startnummer,driver_name\n');
    expect(res.statusCode).toBe(400);
  });
});
