const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || '/home/zackVPS/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const fileUrl = 'file://' + path.resolve(__dirname, '..', 'weekly-wrapped.html');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--allow-file-access-from-files'],
  });
  const errors = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const posts = [];
    page.on('request', (request) => {
      if (request.url().includes('/weekly-wrapped/corrections') && request.method() === 'POST') posts.push(request.url());
    });

    await page.goto(fileUrl);
    await page.waitForFunction(() => document.querySelector('#story-title')?.textContent === 'Minggu ini, tanpa noise.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#wrapped-correction', { state: 'visible' });
    const advancedOpen = await page.locator('#wrapped-advanced').getAttribute('open');
    assert.strictEqual(advancedOpen, null, 'long form must stay collapsed');
    assert.strictEqual(await page.locator('#weekly-start-form').isVisible(), false, 'start form is not a prerequisite');

    await page.click('#correction-looks-right');
    await page.waitForFunction(() => /Looks right/.test(document.querySelector('#correction-status')?.textContent || ''));
    const ack = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.weekly.corrections.demo.v1')));
    assert.strictEqual(ack.verdict, 'looks_right');
    assert.strictEqual(ack.source, 'demo');
    assert.strictEqual(ack.report_id, '2026-W35');
    assert.strictEqual(posts.length, 0, 'demo must not POST to production Worker');
    assert.deepStrictEqual(errors, []);
    console.log(JSON.stringify({ ok: true, protocol: 'file', verdict: ack.verdict, source: ack.source }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
