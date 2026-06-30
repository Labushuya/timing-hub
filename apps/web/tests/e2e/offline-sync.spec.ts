import { test, expect } from '@playwright/test';
import { loginAs, createTestEvent } from './helpers/auth';

// ---------------------------------------------------------------------------
// Shared setup — log in, create event, add posten, navigate to Zeitnehmer URL
// ---------------------------------------------------------------------------
async function setupZeitnehmerPage(page: import('@playwright/test').Page): Promise<void> {
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
  await page.locator('[data-testid="stamp-btn"]').waitFor({ timeout: 8_000 });
}

// ---------------------------------------------------------------------------

test.describe('Offline / Online Sync', () => {
  test('Stamp while offline shows banner with pending count; going online syncs and hides banner', async ({
    page,
    context,
  }) => {
    await setupZeitnehmerPage(page);

    // --- Go offline ---
    await context.setOffline(true);

    const stampBtn = page.locator('[data-testid="stamp-btn"]');
    await stampBtn.click();
    await page.waitForTimeout(200);
    await stampBtn.click();

    // Offline banner must be visible and show count >= 2
    const offlineBanner = page.locator(
      '[data-testid="offline-banner"], [data-testid="sync-pending"]',
    );
    await expect(offlineBanner.first()).toBeVisible({ timeout: 5_000 });

    const countEl = page.locator('[data-testid="pending-count"]');
    if (await countEl.count()) {
      const countText = await countEl.textContent();
      expect(Number(countText)).toBeGreaterThanOrEqual(2);
    }

    // --- Go online ---
    await context.setOffline(false);

    // Banner should disappear once sync is complete
    await expect(offlineBanner.first()).not.toBeVisible({ timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  test('Synced offline entries appear in Kommissar dashboard', async ({ page, context }) => {
    await setupZeitnehmerPage(page);

    // Grab the current event slug from the URL for use later
    const zeitnehmerUrl = page.url();
    const eventSlug = zeitnehmerUrl.match(/\/p\/([^/]+)\//)?.[1] ?? '';

    // Stamp while offline
    await context.setOffline(true);
    const stampBtn = page.locator('[data-testid="stamp-btn"]');
    await stampBtn.click();
    await context.setOffline(false);

    // Wait for sync
    const offlineBanner = page.locator(
      '[data-testid="offline-banner"], [data-testid="sync-pending"]',
    );
    await expect(offlineBanner.first()).not.toBeVisible({ timeout: 15_000 });

    // Open a new page as Kommissar and check the live feed
    const kommissarPage = await context.newPage();
    await loginAs(kommissarPage, 'kommissar');
    await kommissarPage.goto(`/events/${eventSlug}/live`);

    // At least one time entry must be visible in the feed
    const feedItem = kommissarPage.locator(
      '[data-testid="live-entry"], [data-testid="time-entry"]',
    );
    await expect(feedItem.first()).toBeVisible({ timeout: 10_000 });
    await kommissarPage.close();
  });
});
