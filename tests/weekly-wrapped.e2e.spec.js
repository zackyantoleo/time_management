const { test, expect } = require('playwright/test');

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
});

test('slideshow starts first and opens the report', async ({ page }) => {
  await page.goto('http://127.0.0.1:8790/weekly-wrapped.html');
  await expect(page.locator('#wrapped-story')).toBeVisible();
  await expect(page.locator('#wrapped-report')).toBeHidden();
  await expect(page.locator('#story-title')).toHaveText('Minggu ini, tanpa noise.');
  await expect(page.locator('#story-index')).toHaveText('01 / 06');

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#story-index')).toHaveText('02 / 06');
  await expect(page.locator('#story-title')).toContainText('Fullstack Auto');

  for (let index = 0; index < 4; index += 1) await page.locator('#story-next').click();
  await expect(page.locator('#view-report')).toBeVisible();
  await page.locator('#view-report').click();
  await expect(page.locator('#wrapped-story')).toBeHidden();
  await expect(page.locator('#wrapped-report')).toBeVisible();
  await expect(page.locator('#scorecard-list .score-row')).toHaveCount(6);
  await expect(page.locator('#evidence-list .evidence-item')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('mobile story fits without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:8790/weekly-wrapped.html');
  await expect(page.locator('#story-next')).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(fits).toBe(true);
  expect(errors).toEqual([]);
});
