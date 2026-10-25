// @ts-check
import { test, expect } from '@playwright/test';

test('searches Google for Playwright', async ({ page }) => {
  await page.goto('https://www.google.com/');

  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.fill('Playwright browser automation');
  await searchBox.press('Enter');

  await expect(page).toHaveURL(/google\.com\/search\?/);
  await expect(page.locator('#search')).toContainText(/Playwright/i);
});
