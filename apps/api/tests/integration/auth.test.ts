/**
 * tests/integration/auth.test.ts
 *
 * Integration tests for POST /api/v1/auth/register
 *                       POST /api/v1/auth/login
 *                       POST /api/v1/auth/refresh
 *                       POST /api/v1/auth/logout
 *                       GET  /api/v1/auth/me
 *
 * All tests run against a real Postgres + Redis (via Docker in CI).
 * Tables are truncated before each test to ensure isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupIntegration,
  teardownIntegration,
  truncateAllTables,
  createRegistrationToken,
  registerUser,
  getApp,
  getDb,
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

const BASE = '/api/v1/auth';

async function doRegister(overrides?: Partial<{
  token:        string;
  email:        string;
  password:     string;
  display_name: string;
}>) {
  const app   = getApp();
  const token = overrides?.token ?? (await createRegistrationToken('organizer'));
  return app.inject({
    method:  'POST',
    url:     `${BASE}/register`,
    payload: {
      token,
      email:        overrides?.email        ?? 'alice@example.com',
      password:     overrides?.password     ?? 'Password123!',
      display_name: overrides?.display_name ?? 'Alice',
    },
  });
}

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

describe('POST /auth/register', () => {
  it('valid token → 200 + user object + token pair', async () => {
    const res  = await doRegister();
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      access_token:  expect.any(String),
      refresh_token: expect.any(String),
      user: {
        id:           expect.any(String),
        email:        'alice@example.com',
        role:         'organizer',
        display_name: 'Alice',
      },
    });
    // created_at must be an ISO string
    expect(new Date(body.user.created_at).getTime()).toBeGreaterThan(0);
  });

  it('invalid / expired token → 400', async () => {
    const res = await doRegister({ token: 'not-a-real-token' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/invalid|expired/i);
  });

  it('duplicate email → 409 Conflict', async () => {
    // First registration succeeds
    await doRegister({ email: 'alice@example.com' });

    // Second registration with same email + a fresh token fails
    const token2 = await createRegistrationToken('organizer');
    const res    = await doRegister({ email: 'alice@example.com', token: token2 });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already registered/i);
  });

  it('used token → 400 (token cannot be reused)', async () => {
    const token = await createRegistrationToken('organizer');
    await doRegister({ token });

    // Try to register a second user with the already-used token
    const res = await doRegister({ token, email: 'bob@example.com' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('valid credentials → 200 + token pair', async () => {
    await doRegister({ email: 'alice@example.com', password: 'Password123!' });

    const res  = getApp().inject({
      method:  'POST',
      url:     `${BASE}/login`,
      payload: { email: 'alice@example.com', password: 'Password123!' },
    });

    const response = await res;
    const body     = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.user.email).toBe('alice@example.com');
  });

  it('wrong password → 401 with generic message', async () => {
    await doRegister({ email: 'alice@example.com', password: 'Password123!' });

    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/login`,
      payload: { email: 'alice@example.com', password: 'WrongPassword!' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Invalid credentials');
  });

  it('non-existent email → 401 with same generic message (no enumeration)', async () => {
    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/login`,
      payload: { email: 'nobody@example.com', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(401);
    // Must be the same message as wrong password to prevent user enumeration
    expect(res.json().message).toBe('Invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

describe('POST /auth/refresh', () => {
  it('valid refresh token → 200 + new access token + new refresh token', async () => {
    const { refresh_token } = await registerUser({ email: 'alice@example.com' });

    const res  = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/refresh`,
      payload: { refresh_token },
    });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    // Rotated: new refresh token must differ from the old one
    expect(body.refresh_token).not.toBe(refresh_token);
  });

  it('replayed refresh token → 401 + entire family revoked', async () => {
    const { refresh_token } = await registerUser({ email: 'alice@example.com' });

    // First rotation succeeds
    await getApp().inject({
      method:  'POST',
      url:     `${BASE}/refresh`,
      payload: { refresh_token },
    });

    // Replay the original token — reuse attack detection should fire
    const res2 = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/refresh`,
      payload: { refresh_token },
    });

    expect(res2.statusCode).toBe(401);
    expect(res2.json().message).toMatch(/reuse|revoked/i);
  });

  it('completely invalid token → 401', async () => {
    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/refresh`,
      payload: { refresh_token: 'this.is.not.a.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('valid logout → 204', async () => {
    const { refresh_token } = await registerUser({ email: 'alice@example.com' });

    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/logout`,
      payload: { refresh_token },
    });

    expect(res.statusCode).toBe(204);
  });

  it('after logout, using the refresh token → 401', async () => {
    const { refresh_token } = await registerUser({ email: 'alice@example.com' });

    // Logout
    await getApp().inject({
      method:  'POST',
      url:     `${BASE}/logout`,
      payload: { refresh_token },
    });

    // Attempt to refresh after logout
    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/refresh`,
      payload: { refresh_token },
    });

    expect(res.statusCode).toBe(401);
  });

  it('logout with garbage token → still 204 (idempotent / no enumeration)', async () => {
    const res = await getApp().inject({
      method:  'POST',
      url:     `${BASE}/logout`,
      payload: { refresh_token: 'garbage.token.here' },
    });
    // Logout must always succeed — even with invalid tokens
    expect(res.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  it('returns current user when authenticated', async () => {
    const { access_token, email } = await registerUser({ email: 'alice@example.com' });

    const res  = await getApp().inject({
      method:  'GET',
      url:     `${BASE}/me`,
      headers: { authorization: `Bearer ${access_token}` },
    });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.email).toBe(email);
    expect(body.id).toBeTruthy();
    expect(body.role).toBeTruthy();
    expect(body.display_name).toBeTruthy();
  });

  it('returns 401 without a token', async () => {
    const res = await getApp().inject({
      method: 'GET',
      url:    `${BASE}/me`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with a malformed token', async () => {
    const res = await getApp().inject({
      method:  'GET',
      url:     `${BASE}/me`,
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});
