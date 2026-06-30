import type { Page } from '@playwright/test';
import type { EventFormat } from '@timing-hub/shared-types';

// ---------------------------------------------------------------------------
// Test credentials — must exist in the test database seed
// ---------------------------------------------------------------------------
const TEST_CREDENTIALS: Record<string, { email: string; password: string }> = {
  admin: { email: 'admin@test.local', password: 'test-admin-pw' },
  veranstalter: { email: 'veranstalter@test.local', password: 'test-veranstalter-pw' },
  kommissar: { email: 'kommissar@test.local', password: 'test-kommissar-pw' },
};

// ---------------------------------------------------------------------------
// loginAs — fills and submits the login form, then waits for /dashboard
// ---------------------------------------------------------------------------
export async function loginAs(
  page: Page,
  role: 'admin' | 'veranstalter' | 'kommissar',
): Promise<void> {
  const creds = TEST_CREDENTIALS[role];
  if (!creds) throw new Error(`No test credentials for role: ${role}`);
  await page.goto('/login');
  await page.fill('[name="email"]', creds.email);
  await page.fill('[name="password"]', creds.password);
  await page.click('[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// createTestEvent — navigates through the 3-step wizard and creates an event
// ---------------------------------------------------------------------------
export async function createTestEvent(
  page: Page,
  format: EventFormat,
): Promise<string> {
  await page.goto('/events/new');

  // Step 1 — Basic info
  await page.fill('[name="name"]', `Test Event ${Date.now()}`);
  await page.fill('[name="description"]', 'Automated test event');
  await page.selectOption('[name="format"]', format);
  await page.fill('[name="starts_at"]', '2099-12-31T10:00');
  await page.click('[data-testid="wizard-next"]');

  // Step 2 — Format config (accept defaults)
  await page.click('[data-testid="wizard-next"]');

  // Step 3 — Review + submit
  await page.click('[data-testid="wizard-submit"]');

  // Wait for redirect to the event page and capture the slug
  await page.waitForURL('**/events/**', { timeout: 10_000 });
  const url = page.url();
  const slug = url.split('/events/')[1]?.split('/')[0] ?? '';
  return slug;
}

// ---------------------------------------------------------------------------
// getApiClient — returns a thin typed fetch wrapper for direct API calls
// ---------------------------------------------------------------------------
export function getApiClient(baseURL = 'http://localhost:5173') {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  return {
    get: <T>(path: string, headers?: Record<string, string>) =>
      request<T>('GET', path, undefined, headers),
    post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('POST', path, body, headers),
    patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('PATCH', path, body, headers),
    delete: <T>(path: string, headers?: Record<string, string>) =>
      request<T>('DELETE', path, undefined, headers),
  };
}
