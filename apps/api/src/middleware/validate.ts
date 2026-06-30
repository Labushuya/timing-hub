/**
 * middleware/validate.ts — Input sanitization and validation helpers
 *
 * Pure functions — no Fastify dependency, fully unit-testable.
 */

// ---------------------------------------------------------------------------
// String sanitization
// ---------------------------------------------------------------------------

/**
 * Trim, strip null bytes, and limit to maxLen characters.
 */
export function sanitizeString(s: string, maxLen: number): string {
  return s
    .trim()
    .replace(/\0/g, '') // remove null bytes
    .slice(0, maxLen);
}

/**
 * Convert to a URL-safe slug:
 *   - lowercase
 *   - spaces → hyphens
 *   - strip non-alphanumeric except hyphens
 *   - collapse multiple hyphens
 *   - limit to 80 characters
 */
export function sanitizeSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') // strip leading/trailing hyphens
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

/**
 * Basic email format check (RFC 5321 practical limits).
 * Returns true if the address looks valid.
 */
export function validateEmail(email: string): boolean {
  if (email.length > 254) return false;
  // local@domain — local part up to 64 chars, domain required
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ---------------------------------------------------------------------------
// Password validation
// ---------------------------------------------------------------------------

export interface PasswordValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a password against the application policy:
 *   - minimum 8 characters
 *   - maximum 128 characters
 *   - must contain at least one letter
 *   - must contain at least one digit
 */
export function validatePassword(password: string): PasswordValidationResult {
  if (password.length < 8) {
    return { valid: false, reason: 'Password must be at least 8 characters.' };
  }
  if (password.length > 128) {
    return { valid: false, reason: 'Password must not exceed 128 characters.' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one digit.' };
  }
  return { valid: true };
}
