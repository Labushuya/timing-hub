import { test, expect } from '@playwright/test';
import { loginAs, createTestEvent, getApiClient } from './helpers/auth';

// ---------------------------------------------------------------------------
// Helpers to create seed data via the API before each test
// ---------------------------------------------------------------------------
async function seedZeitnehmerContext(page: typeof test.prototype): Promise<{
  eventSlug: string;
  postenToken: string;
}> {
  // Login, create event and a single posten, return routing info
  await loginAs(page as unknown as Parameters<typeof loginAs>[0], 'veranstalter');
  const eventSlug = await createTestEvent(
    page as unknown as Parameters<typeof createTestEvent>[0],
    'glp',
  );
  // Navigate to posten creation
  const p = page as unknown as import('@playwright/test').Page;
  await p.goto(`/events/${eventSlug}/posten`);
  await p.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
  await p.fill('[name="code"]', 'F1');
  await p.fill('[name="name"]', 'Ziel');
  await p.selectOption('[name="role"]', 'finish');
  await p.click('[data-testid="posten-submit"], [type="submit"]');

  // Grab the access token from the QR link or a data attribute
  const tokenEl = p.locator('[data-testid="posten-token"], a[href*="/p/"]').first();
  await tokenEl.waitFor({ timeout: 5_000 });
  const href = (await tokenEl.getAttribute('href')) ?? (await tokenEl.textContent()) ?? '';
  const postenToken = href.split('/').pop() ?? '';
  return { eventSlug, postenToken };
}

// ---------------------------------------------------------------------------

test.describe('Zeitnehmer Timing', () => {
  test('Open Posten URL loads Zeitnehmer screen', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');

    await page.goto(`/events/${eventSlug}/posten`);
    await page.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
    await page.fill('[name="code"]', 'S1');
    await page.fill('[name="name"]', 'Start');
    await page.selectOption('[name="role"]', 'start');
    await page.click('[data-testid="posten-submit"], [type="submit"]');

    const tokenLink = page.locator('a[href*="/p/"]').first();
    await tokenLink.waitFor({ timeout: 5_000 });
    const href = await tokenLink.getAttribute('href');
    expect(href).toMatch(/\/p\//);

    await page.goto(href!);
    // Zeitnehmer heading or stamp button must be present
    await expect(
      page.locator('[data-testid="zeitnehmer-screen"], [data-testid="stamp-btn"], h1').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  // -------------------------------------------------------------------------
  test('Stamp time — tap StampButton adds entry to queue', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');

    await page.goto(`/events/${eventSlug}/posten`);
    await page.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
    await page.fill('[name="code"]', 'F1');
    await page.fill('[name="name"]', 'Ziel');
    await page.selectOption('[name="role"]', 'finish');
    await page.click('[data-testid="posten-submit"], [type="submit"]');

    const tokenLink = page.locator('a[href*="/p/"]').first();
    await tokenLink.waitFor({ timeout: 5_000 });
    const href = await tokenLink.getAttribute('href');
    await page.goto(href!);

    const stampBtn = page.locator('[data-testid="stamp-btn"]');
    await stampBtn.waitFor({ timeout: 8_000 });
    await stampBtn.click();

    // At least one entry appears in the queue list
    const queueItem = page.locator('[data-testid="queue-item"], [data-testid="stamp-queue"] li');
    await expect(queueItem.first()).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  test('Confirm entry — enter Startnummer and confirm', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');

    await page.goto(`/events/${eventSlug}/posten`);
    await page.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
    await page.fill('[name="code"]', 'F1');
    await page.fill('[name="name"]', 'Ziel');
    await page.selectOption('[name="role"]', 'finish');
    await page.click('[data-testid="posten-submit"], [type="submit"]');

    const tokenLink = page.locator('a[href*="/p/"]').first();
    await tokenLink.waitFor({ timeout: 5_000 });
    const href = await tokenLink.getAttribute('href');
    await page.goto(href!);

    // Stamp
    const stampBtn = page.locator('[data-testid="stamp-btn"]');
    await stampBtn.waitFor({ timeout: 8_000 });
    await stampBtn.click();

    // Enter startnummer on the pending queue item
    const startnummerInput = page.locator('[data-testid="startnummer-input"]').first();
    await startnummerInput.waitFor({ timeout: 5_000 });
    await startnummerInput.fill('7');
    await page.click('[data-testid="confirm-entry-btn"], button:has-text("Bestätigen")');

    // Entry is confirmed — status indicator or class changes
    const confirmedEntry = page.locator(
      '[data-testid="queue-item"][data-confirmed="true"], [data-testid="confirmed-entry"]',
    );
    await expect(confirmedEntry.first()).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  test('Multiple stamps — 3 stamps produce 3 queue entries', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');

    await page.goto(`/events/${eventSlug}/posten`);
    await page.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
    await page.fill('[name="code"]', 'F1');
    await page.fill('[name="name"]', 'Ziel');
    await page.selectOption('[name="role"]', 'finish');
    await page.click('[data-testid="posten-submit"], [type="submit"]');

    const tokenLink = page.locator('a[href*="/p/"]').first();
    await tokenLink.waitFor({ timeout: 5_000 });
    const href = await tokenLink.getAttribute('href');
    await page.goto(href!);

    const stampBtn = page.locator('[data-testid="stamp-btn"]');
    await stampBtn.waitFor({ timeout: 8_000 });

    for (let i = 0; i < 3; i++) {
      await stampBtn.click();
      await page.waitForTimeout(150); // short pause between stamps
    }

    const queueItems = page.locator('[data-testid="queue-item"], [data-testid="stamp-queue"] li');
    await expect(queueItems).toHaveCount(3, { timeout: 5_000 });
  });
});
