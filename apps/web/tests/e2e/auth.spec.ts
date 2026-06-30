import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth';

test.describe('Auth — Login', () => {
  test('successful login redirects to /dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'veranstalter@test.local');
    await page.fill('[name="password"]', 'test-veranstalter-pw');
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('wrong password shows error and does not redirect', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'veranstalter@test.local');
    await page.fill('[name="password"]', 'wrong-password');
    await page.click('[type="submit"]');
    // Should stay on login
    await expect(page).toHaveURL(/\/login/);
    // Error message must be visible
    const errorEl = page.locator('[data-testid="login-error"], .error, [role="alert"]');
    await expect(errorEl.first()).toBeVisible();
  });

  test('empty fields trigger HTML5 validation', async ({ page }) => {
    await page.goto('/login');
    // Click submit without filling in anything
    await page.click('[type="submit"]');
    // Page should not navigate away
    await expect(page).toHaveURL(/\/login/);
    // Email field should be invalid (HTML5 constraint)
    const emailInput = page.locator('[name="email"]');
    await expect(emailInput).toHaveAttribute('required', '');
  });
});

test.describe('Auth — Logout', () => {
  test('clicking Abmelden redirects to /login and blocks /dashboard', async ({ page }) => {
    await loginAs(page, 'veranstalter');
    await expect(page).toHaveURL(/\/dashboard/);

    // Find and click the logout button
    const logoutBtn = page.locator('[data-testid="logout-btn"], button:has-text("Abmelden")');
    await logoutBtn.first().click();
    await expect(page).toHaveURL(/\/login/);

    // Directly visiting /dashboard must redirect back to /login
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
