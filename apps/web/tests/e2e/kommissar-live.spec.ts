import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, createTestEvent } from './helpers/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getZeitnehmerHref(page: Page, eventSlug: string): Promise<string> {
  await page.goto(`/events/${eventSlug}/posten`);

  const addBtn = page.locator('[data-testid="add-posten-btn"], button:has-text("Posten")');
  if (await addBtn.count()) {
    await addBtn.click();
    await page.fill('[name="code"]', 'F1');
    await page.fill('[name="name"]', 'Ziel');
    await page.selectOption('[name="role"]', 'finish');
    await page.click('[data-testid="posten-submit"], [type="submit"]');
  }

  const tokenLink = page.locator('a[href*="/p/"]').first();
  await tokenLink.waitFor({ timeout: 5_000 });
  return (await tokenLink.getAttribute('href')) ?? '';
}

// ---------------------------------------------------------------------------
test.describe('Kommissar Live Feed', () => {
  test(
    'Zeitnehmer stamp appears in Kommissar feed within 1000 ms',
    async ({ browser }) => {
      // Two isolated browser contexts simulate two separate users
      const ctxA: BrowserContext = await browser.newContext();
      const ctxB: BrowserContext = await browser.newContext();

      const pageA: Page = await ctxA.newPage(); // Zeitnehmer
      const pageB: Page = await ctxB.newPage(); // Kommissar

      try {
        // --- Setup: create event as veranstalter (context A) ---
        await loginAs(pageA, 'veranstalter');
        const eventSlug = await createTestEvent(pageA, 'glp');
        const zeitnehmerHref = await getZeitnehmerHref(pageA, eventSlug);

        // --- Context B: log in as Kommissar, open live feed ---
        await loginAs(pageB, 'kommissar');
        await pageB.goto(`/events/${eventSlug}/live`);
        await pageB.locator('[data-testid="live-feed"], main').waitFor({ timeout: 8_000 });

        // Count existing entries
        const feedSelector = '[data-testid="live-entry"], [data-testid="time-entry"]';
        const initialCount = await pageB.locator(feedSelector).count();

        // --- Context A: navigate to Zeitnehmer screen and stamp ---
        await pageA.goto(zeitnehmerHref);
        const stampBtn = pageA.locator('[data-testid="stamp-btn"]');
        await stampBtn.waitFor({ timeout: 8_000 });
        const stampTime = Date.now();
        await stampBtn.click();

        // --- Context B: new entry must appear within 1000 ms ---
        await expect(pageB.locator(feedSelector)).toHaveCount(initialCount + 1, {
          timeout: 1_000,
        });
        const elapsed = Date.now() - stampTime;
        console.log(`Live latency: ${elapsed} ms`);
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );

  // -------------------------------------------------------------------------
  test(
    'Kommissar voids entry — entry shows voided in Zeitnehmer queue',
    async ({ browser }) => {
      const ctxA: BrowserContext = await browser.newContext(); // Zeitnehmer
      const ctxB: BrowserContext = await browser.newContext(); // Kommissar

      const pageA: Page = await ctxA.newPage();
      const pageB: Page = await ctxB.newPage();

      try {
        // Setup
        await loginAs(pageA, 'veranstalter');
        const eventSlug = await createTestEvent(pageA, 'glp');
        const zeitnehmerHref = await getZeitnehmerHref(pageA, eventSlug);

        await loginAs(pageB, 'kommissar');
        await pageB.goto(`/events/${eventSlug}/live`);
        await pageB.locator('[data-testid="live-feed"], main').waitFor({ timeout: 8_000 });

        // Zeitnehmer: stamp once
        await pageA.goto(zeitnehmerHref);
        const stampBtn = pageA.locator('[data-testid="stamp-btn"]');
        await stampBtn.waitFor({ timeout: 8_000 });
        await stampBtn.click();

        // Kommissar: wait for entry, then void it
        const feedEntry = pageB.locator('[data-testid="live-entry"], [data-testid="time-entry"]').first();
        await feedEntry.waitFor({ timeout: 5_000 });
        await feedEntry.locator('[data-testid="void-btn"], button:has-text("Void"), button:has-text("Annullieren")').click();

        // Confirm void dialog if present
        const confirmBtn = pageB.locator('[data-testid="confirm-void"], button:has-text("Bestätigen")');
        if (await confirmBtn.isVisible({ timeout: 1_000 })) {
          await confirmBtn.click();
        }

        // Zeitnehmer: the queue item should show a voided indicator
        const voidedItem = pageA.locator(
          '[data-testid="queue-item"][data-voided="true"], [data-testid="voided-entry"], .voided',
        );
        await expect(voidedItem.first()).toBeVisible({ timeout: 5_000 });
      } finally {
        await ctxA.close();
        await ctxB.close();
      }
    },
  );
});
