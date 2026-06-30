import { test, expect } from '@playwright/test';
import path from 'path';
import { loginAs, createTestEvent } from './helpers/auth';

test.describe('Organizer Onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'veranstalter');
  });

  // -------------------------------------------------------------------------
  test('Create event — 3-step wizard creates event and redirects to event page', async ({
    page,
  }) => {
    await page.goto('/events/new');

    // Step 1 — Basic info
    await page.fill('[name="name"]', 'GLP Schwarzwald 2099');
    await page.fill('[name="description"]', 'E2E Testevent');
    await page.selectOption('[name="format"]', 'glp');
    await page.fill('[name="starts_at"]', '2099-12-31T10:00');
    const nextBtn = page.locator('[data-testid="wizard-next"]');
    await nextBtn.click();

    // Step 2 — GLP config (accept defaults)
    await nextBtn.click();

    // Step 3 — Review + submit
    await page.click('[data-testid="wizard-submit"]');

    // Redirected to event detail page
    await expect(page).toHaveURL(/\/events\/[^/]+/);
    await expect(page.locator('h1, [data-testid="event-name"]')).toContainText('GLP Schwarzwald 2099');
  });

  // -------------------------------------------------------------------------
  test('Add participant — form submission shows participant in table', async ({ page }) => {
    const slug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${slug}/participants`);

    await page.click('[data-testid="add-participant-btn"], button:has-text("Teilnehmer")');

    await page.fill('[name="startnummer"]', '42');
    await page.fill('[name="name"]', 'Max Mustermann');
    await page.fill('[name="fahrzeug"]', 'Ford Fiesta');

    await page.click('[data-testid="participant-submit"], [type="submit"]');

    // Participant must appear in the table
    await expect(page.locator('table, [data-testid="participants-table"]')).toContainText('42');
    await expect(page.locator('table, [data-testid="participants-table"]')).toContainText(
      'Max Mustermann',
    );
  });

  // -------------------------------------------------------------------------
  test('CSV import — drop file shows preview, submit imports participants', async ({ page }) => {
    const slug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${slug}/participants`);

    // Navigate to CSV import section
    await page.click('[data-testid="csv-import-btn"], button:has-text("CSV")');

    // Build a minimal CSV buffer and simulate a file drop / file input
    const csvContent = `startnummer,name,fahrzeug\n1,Alice Test,Polo\n2,Bob Test,Golf\n`;
    const csvPath = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'participants.csv');

    // Use setInputFiles if there is a file input; fall back to drag-drop
    const fileInput = page.locator('input[type="file"]');
    if (await fileInput.count()) {
      await fileInput.setInputFiles({
        name: 'participants.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvContent),
      });
    } else {
      // Drag-and-drop onto the dropzone
      const dropzone = page.locator('[data-testid="csv-dropzone"]');
      await dropzone.dispatchEvent('drop', {
        dataTransfer: {
          files: [
            {
              name: 'participants.csv',
              type: 'text/csv',
              content: csvContent,
            },
          ],
        },
      });
    }

    // Preview must be shown
    await expect(
      page.locator('[data-testid="csv-preview"], table').first(),
    ).toBeVisible({ timeout: 5_000 });

    // Confirm import
    await page.click('[data-testid="csv-confirm"], button:has-text("Importieren")');

    // Rows should appear in participants list
    await expect(page.locator('table, [data-testid="participants-table"]')).toContainText('Alice Test');
    await expect(page.locator('table, [data-testid="participants-table"]')).toContainText('Bob Test');
  });

  // -------------------------------------------------------------------------
  test('Create Posten — form creates posten and QR code is visible', async ({ page }) => {
    const slug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${slug}/posten`);

    await page.click('[data-testid="add-posten-btn"], button:has-text("Posten")');
    await page.fill('[name="code"]', 'P1');
    await page.fill('[name="name"]', 'Startposten');
    await page.selectOption('[name="role"]', 'start');
    await page.click('[data-testid="posten-submit"], [type="submit"]');

    // Posten row appears
    await expect(page.locator('table, [data-testid="posten-list"]')).toContainText('Startposten');

    // QR code is visible within the row
    const qrCode = page.locator('[data-testid="qr-code"], svg, img[alt*="QR"]').first();
    await expect(qrCode).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  test('Activate event — clicking Aktivieren changes status to Aktiv', async ({ page }) => {
    const slug = await createTestEvent(page, 'glp');
    await page.goto(`/events/${slug}`);

    // Add at least one posten first (required for activation in most flows)
    await page.goto(`/events/${slug}/posten`);
    const addBtn = page.locator('[data-testid="add-posten-btn"], button:has-text("Posten")');
    if (await addBtn.count()) {
      await addBtn.click();
      await page.fill('[name="code"]', 'P1');
      await page.fill('[name="name"]', 'Finish');
      await page.selectOption('[name="role"]', 'finish');
      await page.click('[data-testid="posten-submit"], [type="submit"]');
    }

    await page.goto(`/events/${slug}`);
    await page.click('[data-testid="activate-btn"], button:has-text("Aktivieren")');

    // Confirmation dialog if any
    const confirmBtn = page.locator('[data-testid="confirm-activate"], button:has-text("Bestätigen")');
    if (await confirmBtn.isVisible({ timeout: 1_000 })) {
      await confirmBtn.click();
    }

    // Status badge should now read "Aktiv"
    await expect(
      page.locator('[data-testid="event-status"], .status-badge, [class*="status"]').first(),
    ).toContainText('Aktiv', { timeout: 5_000 });
  });
});
