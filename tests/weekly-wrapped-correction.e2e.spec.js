const { test, expect } = require('playwright/test');

const BASE_URL = process.env.WEEKLY_WRAPPED_BASE_URL || 'http://127.0.0.1:8787';
let errors;
const correctionPosts = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  correctionPosts.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/weekly-wrapped/corrections') && request.method() === 'POST') {
      correctionPosts.push(request.url());
    }
  });
});

test('sample report can be corrected without the long form', async ({ page }) => {
  await page.goto(`${BASE_URL}/weekly-wrapped.html`);
  await expect(page.locator('#wrapped-source-status')).toHaveAttribute('data-source', 'demo');
  await expect(page.locator('#story-title')).toHaveText('Minggu ini, tanpa noise.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#wrapped-report')).toBeVisible();
  await expect(page.locator('#wrapped-correction')).toBeVisible();
  await expect(page.locator('#correction-looks-right')).toBeVisible();
  await expect(page.locator('#correction-wrong')).toBeVisible();
  await expect(page.locator('#correction-note')).toBeVisible();
  await expect(page.locator('#wrapped-advanced')).not.toHaveAttribute('open', /.*/);
  await expect(page.locator('#weekly-start-form')).toBeHidden();

  await page.locator('#correction-looks-right').click();
  await expect(page.locator('#correction-status')).toContainText(/Looks right|tersimpan|saved/i);
  const ack = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.weekly.corrections.demo.v1')));
  expect(ack.verdict).toBe('looks_right');
  expect(ack.source).toBe('demo');
  expect(ack.report_id).toBe('2026-W35');
  expect(correctionPosts).toEqual([]);

  await page.locator('#correction-wrong').click();
  await expect(page.locator('#correction-status')).toContainText(/salah|wrong|tersimpan|saved/i);
  const wrong = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.weekly.corrections.demo.v1')));
  expect(wrong.verdict).toBe('wrong');
  expect(wrong.correction_id).toBe(ack.correction_id);

  await page.locator('#correction-note').fill('Hidden pairing review');
  await page.locator('#correction-save-missed').click();
  await expect(page.locator('#correction-status')).toContainText(/terlewat|missed|tersimpan|saved/i);
  const missed = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.weekly.corrections.demo.v1')));
  expect(missed.verdict).toBe('missed');
  expect(missed.note).toBe('Hidden pairing review');
  expect(missed.source).toBe('demo');
  expect(correctionPosts).toEqual([]);

  await page.locator('#wrapped-advanced summary').click();
  await expect(page.locator('#wrapped-advanced')).toHaveAttribute('open', '');
  await expect(page.locator('#weekly-start-form')).toBeVisible();
  await expect(page.locator('#weekly-end-form')).toBeVisible();
  expect(errors).toEqual([]);
});
