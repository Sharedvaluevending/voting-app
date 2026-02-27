// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Public pages', () => {
  test('themes page loads', async ({ page }) => {
    await page.goto('/themes');
    await expect(page.locator('h2')).toContainText(/Market Themes|Themes/i);
    await page.waitForLoadState('networkidle');
  });

  test('market-pulse page loads', async ({ page }) => {
    await page.goto('/market-pulse');
    await expect(page.locator('h2')).toContainText(/Market Pulse|Pulse/i);
    await page.waitForLoadState('networkidle');
  });

  test('backtest page loads', async ({ page }) => {
    await page.goto('/backtest');
    await expect(page.locator('h2')).toContainText(/Backtest|Historical/i);
    await expect(page.locator('#backtest-form')).toBeVisible();
  });
});
