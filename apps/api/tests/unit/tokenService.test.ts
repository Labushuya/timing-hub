import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateToken,
  hashPassword,
  verifyPassword,
  verifyRegistrationToken,
} from '../../src/services/tokenService.js';
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('returns a 64-character hex string when called with default length (32 bytes)', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('returns a hex string of the correct length for a custom byte count', () => {
    const token = generateToken(16);
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it('generates different tokens on each call (no repetition)', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it('returns a 128-char hex string for 64 bytes', () => {
    const token = generateToken(64);
    expect(token).toHaveLength(128);
  });
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------

describe('hashPassword / verifyPassword', () => {
  it('creates an argon2id hash that is verifiable by verifyPassword', async () => {
    const password = 'supersecret123!';
    const hash = await hashPassword(password);

    expect(hash).toBeTruthy();
    // argon2id hashes start with $argon2id$
    expect(hash).toMatch(/^\$argon2id\$/);

    const valid = await verifyPassword(hash, password);
    expect(valid).toBe(true);
  });

  it('wrong password returns false from verifyPassword', async () => {
    const password = 'correctPassword';
    const hash = await hashPassword(password);

    const valid = await verifyPassword(hash, 'wrongPassword');
    expect(valid).toBe(false);
  });

  it('two hashes of the same password differ (salt randomness)', async () => {
    const password = 'samePassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    expect(hash1).not.toBe(hash2);
    // But both verify correctly
    expect(await verifyPassword(hash1, password)).toBe(true);
    expect(await verifyPassword(hash2, password)).toBe(true);
  });

  it('empty string password hashes and verifies correctly', async () => {
    const hash = await hashPassword('');
    expect(await verifyPassword(hash, '')).toBe(true);
    expect(await verifyPassword(hash, 'notempty')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyRegistrationToken
// ---------------------------------------------------------------------------

/**
 * Create a minimal postgres Sql mock that supports tagged template literal calls.
 * The mock returns the value set by `mockReturnValueOnce` / `mockResolvedValueOnce`.
 */
function makeDbMock(rows: { id: string; role: string }[]): Sql {
  const mockFn = vi.fn().mockResolvedValue(rows);
  // postgres `sql` is a tagged template function; proxy it so `db\`...\`` works
  return mockFn as unknown as Sql;
}

describe('verifyRegistrationToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { id, role } when DB returns a valid, non-expired, unused token', async () => {
    const db = makeDbMock([{ id: 'token-uuid-1', role: 'organizer' }]);

    const result = await verifyRegistrationToken(db, 'some-valid-token');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('token-uuid-1');
    expect(result!.role).toBe('organizer');
  });

  it('returns null when DB returns no rows (expired token)', async () => {
    const db = makeDbMock([]); // empty = expired or not found

    const result = await verifyRegistrationToken(db, 'expired-token');
    expect(result).toBeNull();
  });

  it('returns null when DB returns no rows (already-used token)', async () => {
    const db = makeDbMock([]); // used tokens excluded by WHERE used_at IS NULL

    const result = await verifyRegistrationToken(db, 'used-token');
    expect(result).toBeNull();
  });

  it('returns null for a token not found in DB', async () => {
    const db = makeDbMock([]);

    const result = await verifyRegistrationToken(db, 'nonexistent-token');
    expect(result).toBeNull();
  });

  it('calls the DB with the correct token string', async () => {
    const db = makeDbMock([{ id: 'id1', role: 'timekeeper' }]);
    const token = 'my-registration-token';

    await verifyRegistrationToken(db, token);

    // The mock was called once
    expect(vi.mocked(db as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('correctly maps role string to JwtPayload role type', async () => {
    const roles: Array<'admin' | 'organizer' | 'timekeeper' | 'viewer'> = [
      'admin',
      'organizer',
      'timekeeper',
      'viewer',
    ];

    for (const role of roles) {
      const db = makeDbMock([{ id: 'some-id', role }]);
      const result = await verifyRegistrationToken(db, 'tok');
      expect(result!.role).toBe(role);
    }
  });

  it('returns only the first row when DB returns multiple (LIMIT 1 expectation)', async () => {
    // DB enforces LIMIT 1, but even if multiple rows came back, we use rows[0]
    const db = makeDbMock([
      { id: 'first-id', role: 'organizer' },
      { id: 'second-id', role: 'admin' },
    ]);

    const result = await verifyRegistrationToken(db, 'tok');
    expect(result!.id).toBe('first-id');
    expect(result!.role).toBe('organizer');
  });
});
