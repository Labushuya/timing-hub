/**
 * services/tokenService.ts — JWT + refresh token lifecycle
 *
 * Responsibilities:
 *   - Sign short-lived access JWTs (15 min)
 *   - Generate, hash, store, and rotate refresh tokens (30 days)
 *   - Detect token reuse attacks (refresh token family invalidation)
 *   - Revoke tokens on logout
 *
 * Refresh token rotation strategy:
 *   Each refresh token belongs to a "family" (UUID).
 *   Using an already-used token invalidates the entire family
 *   (prevents replay attacks even if the token was stolen).
 *
 * Schema notes:
 *   refresh_tokens: id (jti), user_id, token_hash, family, revoked_at, expires_at
 *   registration_tokens: id, token, role, used_at, expires_at
 */
import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { JwtPayload } from '../plugins/auth.js';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random hex string.
 * Default length = 32 bytes → 64 hex chars.
 */
export function generateToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/** Hash a plaintext password using argon2id (recommended preset). */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Verify a plaintext password against an argon2 hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/**
 * Sign a short-lived (15 min) access JWT.
 */
export function generateAccessToken(app: FastifyInstance, payload: JwtPayload): string {
  return app.jwt.sign(payload, { expiresIn: '15m' });
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export interface RefreshTokenResult {
  /** Raw JWT that is sent to the client. */
  token: string;
  /** Argon2id hash stored in DB (token_hash column). */
  hash: string;
  /** UUID that serves as the JWT ID (jti) and DB primary key. */
  jti: string;
}

/**
 * Generate a 30-day refresh token, store its hash in refresh_tokens,
 * and return the raw token + hash + jti.
 *
 * The raw token is a signed JWT whose payload carries:
 *   sub   — userId
 *   jti   — UUID primary key of the refresh_tokens row
 *   type  — 'refresh'
 */
export async function generateRefreshToken(
  app: FastifyInstance,
  userId: string,
  options?: { userAgent?: string; ipAddress?: string; family?: string },
): Promise<RefreshTokenResult> {
  const jti = crypto.randomUUID();

  // Sign as JWT so the client can carry userId + jti together
  const token = app.jwt.sign(
    { sub: userId, jti, type: 'refresh' } as unknown as Parameters<typeof app.jwt.sign>[0],
    { expiresIn: '30d' },
  );

  const hash = await argon2.hash(token, { type: argon2.argon2id });

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await app.db`
    INSERT INTO refresh_tokens (id, user_id, token_hash, family, expires_at, user_agent, ip_address)
    VALUES (
      ${jti},
      ${userId},
      ${hash},
      ${options?.family ?? crypto.randomUUID()},
      ${expiresAt},
      ${options?.userAgent ?? null},
      ${options?.ipAddress ?? null}
    )
  `;

  return { token, hash, jti };
}

// ---------------------------------------------------------------------------
// Registration tokens
// ---------------------------------------------------------------------------

export interface RegistrationTokenRow {
  id: string;
  role: JwtPayload['role'];
}

/**
 * Look up a registration token, verify it is valid (not expired, not used).
 * Returns { id, role } or null.
 */
export async function verifyRegistrationToken(
  db: Sql,
  token: string,
): Promise<RegistrationTokenRow | null> {
  const rows = await db<{ id: string; role: string }[]>`
    SELECT id, role
    FROM registration_tokens
    WHERE token     = ${token}
      AND used_at   IS NULL
      AND expires_at > now()
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    id: row.id,
    role: row.role as JwtPayload['role'],
  };
}

/**
 * Mark a registration token as used by the given userId.
 */
export async function markTokenUsed(db: Sql, tokenId: string, userId: string): Promise<void> {
  await db`
    UPDATE registration_tokens
    SET used_at = now(),
        created_by = ${userId}
    WHERE id = ${tokenId}
  `;
}

// ---------------------------------------------------------------------------
// Token service object (backward-compat / convenience API)
// ---------------------------------------------------------------------------

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export const tokenService = {
  /**
   * Create a new access + refresh token pair for a user.
   * Stores the hashed refresh token in the DB.
   */
  async createTokenPair(
    app: FastifyInstance,
    userId: string,
    payload: Omit<JwtPayload, 'iat' | 'exp'>,
    options?: { userAgent?: string; ipAddress?: string },
  ): Promise<TokenPair> {
    const accessToken = generateAccessToken(app, payload);
    const { token: refreshToken } = await generateRefreshToken(app, userId, options);

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  },

  /**
   * Rotate a refresh token.
   * Validates token, checks revocation, rotates family, returns new pair.
   * If the token has already been used (reuse attack), revokes the entire family.
   */
  async rotateRefreshToken(
    app: FastifyInstance,
    rawRefreshToken: string,
    payload: Omit<JwtPayload, 'iat' | 'exp'>,
    options?: { userAgent?: string; ipAddress?: string },
  ): Promise<TokenPair> {
    // Decode without verifying first to extract jti
    let decoded: { sub: string; jti: string; type: string };
    try {
      decoded = app.jwt.decode<{ sub: string; jti: string; type: string }>(rawRefreshToken)!;
    } catch {
      throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 });
    }

    if (!decoded?.jti) {
      throw Object.assign(new Error('Invalid refresh token structure'), { statusCode: 401 });
    }

    // Verify signature
    try {
      app.jwt.verify<{ sub: string; jti: string; type: string }>(rawRefreshToken);
    } catch {
      throw Object.assign(new Error('Refresh token expired or invalid'), { statusCode: 401 });
    }

    // Look up the token in DB
    const rows = await app.db<{
      id: string;
      user_id: string;
      token_hash: string;
      family: string;
      revoked_at: Date | null;
      expires_at: Date;
    }[]>`
      SELECT id, user_id, token_hash, family, revoked_at, expires_at
      FROM refresh_tokens
      WHERE id = ${decoded.jti}
      LIMIT 1
    `;

    if (rows.length === 0) {
      throw Object.assign(new Error('Refresh token not found'), { statusCode: 401 });
    }

    const row = rows[0]!;

    // Token already revoked — reuse attack: revoke entire family
    if (row.revoked_at !== null) {
      await app.db`
        UPDATE refresh_tokens
        SET revoked_at = now()
        WHERE family = ${row.family}
          AND revoked_at IS NULL
      `;
      throw Object.assign(new Error('Refresh token reuse detected — all sessions revoked'), { statusCode: 401 });
    }

    // Token expired in DB
    if (row.expires_at < new Date()) {
      throw Object.assign(new Error('Refresh token expired'), { statusCode: 401 });
    }

    // Verify hash matches (belt-and-suspenders)
    const hashValid = await argon2.verify(row.token_hash, rawRefreshToken);
    if (!hashValid) {
      throw Object.assign(new Error('Refresh token hash mismatch'), { statusCode: 401 });
    }

    // Revoke the current token
    await app.db`
      UPDATE refresh_tokens
      SET revoked_at = now()
      WHERE id = ${decoded.jti}
    `;

    // Issue new pair in same family
    const accessToken = generateAccessToken(app, payload);
    const { token: refreshToken } = await generateRefreshToken(app, row.user_id, {
      ...options,
      family: row.family,
    });

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  },

  /**
   * Revoke a specific refresh token (logout from one device).
   */
  async revokeRefreshToken(
    app: FastifyInstance,
    rawRefreshToken: string,
  ): Promise<void> {
    let decoded: { jti?: string } | null = null;
    try {
      decoded = app.jwt.decode<{ jti?: string }>(rawRefreshToken);
    } catch {
      // silently ignore invalid tokens on logout
      return;
    }

    if (!decoded?.jti) return;

    await app.db`
      UPDATE refresh_tokens
      SET revoked_at = now()
      WHERE id = ${decoded.jti}
        AND revoked_at IS NULL
    `;
  },

  /**
   * Revoke all refresh tokens for a user (logout from all devices).
   */
  async revokeAllUserTokens(
    app: FastifyInstance,
    userId: string,
  ): Promise<void> {
    await app.db`
      UPDATE refresh_tokens
      SET revoked_at = now()
      WHERE user_id   = ${userId}
        AND revoked_at IS NULL
    `;
  },
};
