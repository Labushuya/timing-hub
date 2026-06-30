import { test, expect } from '@playwright/test';
import { loginAs, createTestEvent } from './helpers/auth';

// Expected column headers per EventFormat
const FORMAT_HEADERS: Record<string, string[]> = {
  glp: ['Startnummer', 'Fahrer', 'Soll-Zeit', 'Ist-Zeit', 'Abweichung', 'Punkte'],
  sonderpruefung: ['Startnummer', 'Fahrer', 'Sektor', 'Zeit', 'Platz'],
  rundstrecke: ['Startnummer', 'Fahrer', 'Runden', 'Beste Runde', 'Gesamtzeit', 'Platz'],
};

// ---------------------------------------------------------------------------
test.describe('Results Export', () => {
  test('Results page loads and table is shown', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${eventSlug}/results`);

    await expect(
      page.locator('table, [data-testid="results-table"]').first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  // -------------------------------------------------------------------------
  test('CSV export — clicking export button triggers file download', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${eventSlug}/results`);

    // Wait for results table to be present
    await page.locator('table, [data-testid="results-table"]').first().waitFor({ timeout: 8_000 });

    // Listen for download event
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await page.click('[data-testid="export-csv-btn"], button:has-text("CSV"), a:has-text("CSV")');
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });

  // -------------------------------------------------------------------------
  test('GLP results table has correct column headers', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${eventSlug}/results`);

    const table = page.locator('table, [data-testid="results-table"]').first();
    await table.waitFor({ timeout: 8_000 });

    for (const header of (FORMAT_HEADERS['glp'] ?? [])) {
      await expect(table).toContainText(header, { timeout: 5_000 });
    }
  });

  // -------------------------------------------------------------------------
  test('Sonderpruefung results table has correct column headers', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'sonderpruefung');
    await page.goto(`/events/${eventSlug}/results`);

    const table = page.locator('table, [data-testid="results-table"]').first();
    await table.waitFor({ timeout: 8_000 });

    for (const header of (FORMAT_HEADERS['sonderpruefung'] ?? [])) {
      await expect(table).toContainText(header, { timeout: 5_000 });
    }
  });

  // -------------------------------------------------------------------------
  test('Rundstrecke results table has correct column headers', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    const eventSlug = await createTestEvent(page, 'rundstrecke');
    await page.goto(`/events/${eventSlug}/results`);

    const table = page.locator('table, [data-testid="results-table"]').first();
    await table.waitFor({ timeout: 8_000 });

    for (const header of (FORMAT_HEADERS['rundstrecke'] ?? [])) {
      await expect(table).toContainText(header, { timeout: 5_000 });
    }
  });
});
