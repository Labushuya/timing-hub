/**
 * tests/integration/times-batch-sync.test.ts
 *
 * Integration tests for:
 *   POST  /api/v1/times              — single time entry
 *   POST  /api/v1/times/batch       — batch ingest
 *   PATCH /api/v1/times/:id/confirm — confirm entry + scoring enqueue
 *
 * Authentication notes:
 *   POST /times and POST /times/batch use "dual auth":
 *     - X-Posten-Session header → posten_sessions table lookup
 *     - X-Bridge-Token header   → bridge_tokens table lookup
 *   These tests create posten sessions directly in the DB.
 *
 *   PATCH /times/:id/confirm supports both posten sessions and JWT roles
 *   (organizer, admin, timekeeper). Tests use JWT auth for confirm.
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
// Test fixtures
// ---------------------------------------------------------------------------

interface TestFixture {
  organizer:    RegisteredUser;
  eventId:      string;
  eventSlug:    string;
  postenId:     string;
  sessionToken: string;
  participantId: string;
}

const DEFAULT_EVENT_BODY = {
  name:      'Test Race 2026',
  format:    'glp' as const,
  starts_at: new Date('2026-07-01T10:00:00Z').getTime(),
  timezone:  'Europe/Berlin',
  config:    { target_time_ms: 120_000 },
};

/**
 * Full fixture setup:
 * 1. Register organizer
 * 2. Create event (auto-creates posten)
 * 3. Activate event (needs participant first)
 * 4. Create posten session directly in DB
 * 5. Create a participant
 */
async function buildFixture(): Promise<TestFixture> {
  const db = getDb();
  const app = getApp();

  // 1. Register organizer
  const organizer = await registerUser({ role: 'organizer' });

  // 2. Create event
  const createRes = await app.inject({
    method:  'POST',
    url:     '/api/v1/events',
    headers: { authorization: `Bearer ${organizer.access_token}` },
    payload: DEFAULT_EVENT_BODY,
  });
  const event = createRes.json<{ id: string; slug: string; posten: { id: string }[] }>();
  const postenId = event.posten[0]!.id;

  // 3. Create participant (needed to activate event)
  const now = Date.now();
  await db`
    INSERT INTO participants (event_id, startnummer, driver_name, created_at, updated_at)
    VALUES (${event.id}, '42', 'Max Mustermann', ${now}, ${now})
  `;
  const participantRows = await db<{ id: string }[]>`
    SELECT id FROM participants WHERE event_id = ${event.id} LIMIT 1
  `;
  const participantId = participantRows[0]!.id;

  // 4. Activate event (status → active, required for posten session auth)
  await app.inject({
    method:  'POST',
    url:     `/api/v1/events/${event.slug}/activate`,
    headers: { authorization: `Bearer ${organizer.access_token}` },
  });

  // 5. Create a posten session directly in the DB
  //    Note: posten_sessions v2 schema has:
  //      id, posten_id, session_token, device_hint, created_at, expires_at, last_seen_at
  //    The times.ts auth query additionally filters on revoked_at IS NULL which is
  //    not in the v2 schema — this is a known mismatch. The session insert omits that column.
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // +24h
  const sessionTokenRows = await db<{ session_token: string }[]>`
    INSERT INTO posten_sessions (posten_id, expires_at)
    VALUES (${postenId}, ${expiresAt})
    RETURNING session_token
  `;
  const sessionToken = sessionTokenRows[0]!.session_token;

  return {
    organizer,
    eventId:       event.id,
    eventSlug:     event.slug,
    postenId,
    sessionToken,
    participantId,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/times — single time entry
// ---------------------------------------------------------------------------

describe('POST /times', () => {
  it('valid entry → 201, source=manual, entry in DB', async () => {
    const { postenId, sessionToken } = await buildFixture();

    const rawTs = Date.now() - 5000;
    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      headers: { 'x-posten-session': sessionToken },
      payload: {
        posten_id:        postenId,
        raw_timestamp_ms: rawTs,
        source:           'manual',
        // client_seq is stored as BIGINT in DB — use a numeric string
        client_seq:       '1001',
      },
    });

    const body = res.json<{
      status:   string;
      entry_id: string;
      entry:    { source: string; raw_timestamp_ms: number };
    }>();

    expect(res.statusCode).toBe(201);
    expect(body.status).toBe('accepted');
    expect(body.entry_id).toBeTruthy();
    expect(body.entry.source).toBe('manual');
    expect(body.entry.raw_timestamp_ms).toBe(rawTs);
  });

  it('duplicate client_seq → 200, status=duplicate, same entry_id returned', async () => {
    const { postenId, sessionToken } = await buildFixture();

    const rawTs = Date.now() - 5000;
    const payload = {
      posten_id:        postenId,
      raw_timestamp_ms: rawTs,
      source:           'manual',
      // Numeric string — stored as BIGINT in DB
      client_seq:       '2001',
    };

    // First insert
    const first = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      headers: { 'x-posten-session': sessionToken },
      payload,
    });
    const firstBody = first.json<{ entry_id: string }>();
    expect(first.statusCode).toBe(201);

    // Duplicate — same client_seq
    const second = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      headers: { 'x-posten-session': sessionToken },
      payload,
    });
    const secondBody = second.json<{ status: string; entry_id: string }>();

    expect(second.statusCode).toBe(200);
    expect(secondBody.status).toBe('duplicate');
    expect(secondBody.entry_id).toBe(firstBody.entry_id);
  });

  it('mismatched posten_id in body → 403', async () => {
    const { sessionToken } = await buildFixture();

    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      headers: { 'x-posten-session': sessionToken },
      payload: {
        posten_id:        '00000000-0000-0000-0000-000000000000',
        raw_timestamp_ms: Date.now(),
        source:           'manual',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('missing X-Posten-Session → 401', async () => {
    const { postenId } = await buildFixture();

    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      payload: {
        posten_id:        postenId,
        raw_timestamp_ms: Date.now(),
        source:           'manual',
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/times/batch — batch ingest
// ---------------------------------------------------------------------------

describe('POST /times/batch', () => {
  it('3 entries, 1 duplicate → acks: 2 accepted + 1 duplicate', async () => {
    const { postenId, sessionToken } = await buildFixture();

    const baseTs = Date.now() - 10_000;

    // Pre-insert one entry so we have a known client_seq to duplicate
    const pre = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times',
      headers: { 'x-posten-session': sessionToken },
      payload: {
        posten_id:        postenId,
        raw_timestamp_ms: baseTs,
        source:           'manual',
        // Numeric-only — stored as BIGINT in DB
        client_seq:       '3001',
      },
    });
    expect(pre.statusCode).toBe(201);

    // Batch: 2 new + 1 duplicate of the pre-inserted seq
    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times/batch',
      headers: { 'x-posten-session': sessionToken },
      payload: {
        entries: [
          {
            posten_id:        postenId,
            raw_timestamp_ms: baseTs + 1000,
            source:           'manual',
            client_seq:       '3002',
          },
          {
            posten_id:        postenId,
            raw_timestamp_ms: baseTs + 2000,
            source:           'manual',
            client_seq:       '3003',
          },
          {
            // Duplicate of the pre-inserted entry
            posten_id:        postenId,
            raw_timestamp_ms: baseTs,
            source:           'manual',
            client_seq:       '3001',
          },
        ],
      },
    });

    const body = res.json<{
      acks:       { client_seq: string; entry_id: string; status: string }[];
      accepted:   number;
      duplicates: number;
    }>();

    expect(res.statusCode).toBe(200);
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(1);
    expect(body.acks).toHaveLength(3);

    const dupAck = body.acks.find((a) => a.client_seq === '3001');
    expect(dupAck?.status).toBe('duplicate');

    const newAcks = body.acks.filter((a) => a.status === 'accepted');
    expect(newAcks).toHaveLength(2);
  });

  it('empty entries array → 400', async () => {
    const { sessionToken } = await buildFixture();

    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times/batch',
      headers: { 'x-posten-session': sessionToken },
      payload: { entries: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('entries referencing different posten → 403', async () => {
    const { postenId, sessionToken } = await buildFixture();

    const res = await getApp().inject({
      method:  'POST',
      url:     '/api/v1/times/batch',
      headers: { 'x-posten-session': sessionToken },
      payload: {
        entries: [
          {
            posten_id:        postenId,
            raw_timestamp_ms: Date.now(),
            source:           'manual',
            client_seq:       '4001',
          },
          {
            posten_id:        '00000000-0000-0000-0000-000000000000',
            raw_timestamp_ms: Date.now(),
            source:           'manual',
            client_seq:       '4002',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/times/:id/confirm — confirm entry + scoring enqueue
// ---------------------------------------------------------------------------

describe('PATCH /times/:id/confirm', () => {
  async function insertRawEntry(opts: {
    postenId: string;
    eventId:  string;
    startnummer?: string;
  }): Promise<string> {
    const db  = getDb();
    const now = Date.now();
    const rows = await db<{ id: string }[]>`
      INSERT INTO time_entries
        (posten_id, event_id, source, raw_timestamp_ms, server_recv_ms,
         is_confirmed, is_void, created_at, updated_at)
      VALUES (
        ${opts.postenId},
        ${opts.eventId},
        'manual',
        ${now - 5000},
        ${now},
        false,
        false,
        ${now},
        ${now}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  it('organizer confirms entry → assigns participant + 200', async () => {
    const fixture = await buildFixture();
    const { organizer, eventId, postenId, participantId } = fixture;

    // Insert unconfirmed entry
    const entryId = await insertRawEntry({ postenId, eventId });

    const res = await getApp().inject({
      method:  'PATCH',
      url:     `/api/v1/times/${entryId}/confirm`,
      headers: { authorization: `Bearer ${organizer.access_token}` },
      payload: { startnummer: '42' },
    });

    const body = res.json<{
      id:            string;
      is_confirmed:  boolean;
      participant_id: string;
      startnummer:   string;
    }>();

    expect(res.statusCode).toBe(200);
    expect(body.is_confirmed).toBe(true);
    expect(body.startnummer).toBe('42');
    expect(body.participant_id).toBe(participantId);
  });

  it('confirm with unknown startnummer → 404', async () => {
    const { organizer, eventId, postenId } = await buildFixture();

    const entryId = await insertRawEntry({ postenId, eventId });

    const res = await getApp().inject({
      method:  'PATCH',
      url:     `/api/v1/times/${entryId}/confirm`,
      headers: { authorization: `Bearer ${organizer.access_token}` },
      payload: { startnummer: '999' }, // does not exist
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/999/);
  });

  it('confirm non-existent entry → 404', async () => {
    const { organizer } = await buildFixture();

    const res = await getApp().inject({
      method:  'PATCH',
      url:     '/api/v1/times/00000000-0000-0000-0000-000000000000/confirm',
      headers: { authorization: `Bearer ${organizer.access_token}` },
      payload: { startnummer: '42' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('viewer role cannot confirm → 403', async () => {
    const fixture = await buildFixture();
    const { eventId, postenId } = fixture;
    const viewer  = await registerUser({ role: 'viewer', email: 'viewer@example.com' });

    const entryId = await insertRawEntry({ postenId, eventId });

    const res = await getApp().inject({
      method:  'PATCH',
      url:     `/api/v1/times/${entryId}/confirm`,
      headers: { authorization: `Bearer ${viewer.access_token}` },
      payload: { startnummer: '42' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unauthenticated confirm → 401', async () => {
    const { eventId, postenId } = await buildFixture();
    const entryId = await insertRawEntry({ postenId, eventId });

    const res = await getApp().inject({
      method:  'PATCH',
      url:     `/api/v1/times/${entryId}/confirm`,
      payload: { startnummer: '42' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('confirm triggers scoring recompute enqueue (no error thrown)', async () => {
    // This test verifies enqueueCompute is called without throwing.
    // In CI the BullMQ job will be accepted but not processed (no worker polling in tests).
    const fixture = await buildFixture();
    const { organizer, eventId, postenId } = fixture;
    const entryId = await insertRawEntry({ postenId, eventId });

    const res = await getApp().inject({
      method:  'PATCH',
      url:     `/api/v1/times/${entryId}/confirm`,
      headers: { authorization: `Bearer ${organizer.access_token}` },
      payload: { startnummer: '42' },
    });

    // If enqueueCompute threw synchronously the route would 500; 200 means it succeeded
    expect(res.statusCode).toBe(200);
  });
});
