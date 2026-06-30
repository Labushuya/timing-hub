/**
 * plugins/security.ts — Per-route rate limit preHandlers
 *
 * Exports helper preHandler factories for specific rate limits:
 *   authRateLimit     — 5/min per IP (login)
 *   registerRateLimit — 10/hour per IP (register)
 *   timesRateLimit    — 120/min per session token (POST /times)
 *   batchRateLimit    — 10/min per session token (POST /times/batch)
 *   generalRateLimit  — 200/min per IP (global fallback, mirrors server default)
 *
 * Key strategy:
 *   - Zeitnehmer routes: X-Posten-Session header value
 *   - User routes: JWT sub claim (user ID)
 *   - Fallback: IP address
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Extract session token key for Zeitnehmer routes. Falls back to IP. */
function postenSessionKey(request: FastifyRequest): string {
  const token = request.headers['x-posten-session'];
  if (token && typeof token === 'string') return `posten:${token}`;
  return `ip:${request.ip}`;
}

/** Extract JWT sub (user ID) for authenticated user routes. Falls back to IP. */
function jwtUserKey(request: FastifyRequest): string {
  try {
    const decoded = request.server.jwt.decode<{ sub?: string }>(
      (request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
    );
    if (decoded?.sub) return `user:${decoded.sub}`;
  } catch {
    // fall through
  }
  return `ip:${request.ip}`;
}

/** IP-only key for unauthenticated routes (login, register). */
function ipKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

// ---------------------------------------------------------------------------
// Rate limit config factories
//
// @fastify/rate-limit supports per-route config via route options:
//   { config: { rateLimit: { max, timeWindow, keyGenerator } } }
//
// These helpers return the config object to spread into route options.
// ---------------------------------------------------------------------------

export const authRateLimitConfig = {
  max: 5,
  timeWindow: '1 minute',
  keyGenerator: ipKey,
} as const;

export const registerRateLimitConfig = {
  max: 10,
  timeWindow: '1 hour',
  keyGenerator: ipKey,
} as const;

export const timesRateLimitConfig = {
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: postenSessionKey,
} as const;

export const batchRateLimitConfig = {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: postenSessionKey,
} as const;

export const generalRateLimitConfig = {
  max: 200,
  timeWindow: '1 minute',
  keyGenerator: ipKey,
} as const;

// ---------------------------------------------------------------------------
// preHandler factories (for routes that prefer preHandler over config)
// ---------------------------------------------------------------------------

type RateLimitPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/**
 * Build a manual rate limit preHandler using the app's rate-limit store.
 * Falls back to the global rate-limit plugin behaviour when the route uses
 * config-level rate limits (preferred approach).
 *
 * This is a thin wrapper that validates the batch payload max entry count.
 */
export function batchSizeGuard(maxEntries: number): RateLimitPreHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as { entries?: unknown[] } | undefined;
    if (Array.isArray(body?.entries) && body.entries.length > maxEntries) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Batch exceeds maximum of ${maxEntries} entries.`,
      });
    }
  };
}
