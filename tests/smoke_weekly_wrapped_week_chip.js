const { chromium } = require('playwright');
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || '/home/zackVPS/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PORT = '8768';
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(url, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => fetch(url).then(() => resolve()).catch((error) => {
      if (Date.now() - started >= timeoutMs) reject(error);
      else setTimeout(attempt, 100);
    });
    attempt();
  });
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1'], {
    cwd: path.resolve(__dirname, '..'), stdio: 'ignore',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  const errors = [];
  try {
    await waitForServer(BASE + '/');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

    await page.goto(BASE + '/index.html');
    await page.waitForFunction(() => typeof refreshWrappedWeekChip === 'function');
    assert.strictEqual(await page.locator('#tab-wrapped').count(), 0, 'Wrapped tab must be gone');
    assert.strictEqual(await page.locator('#wrapped-week-chip').getAttribute('hidden'), '',
      'chip stays hidden without a live report');
    await page.click('#settings-btn');
    assert.strictEqual(await page.locator('a[href="weekly-wrapped.html"]').filter({ hasText: 'Open Wrapped' }).count(), 1,
      'Settings remains the durable fallback');

    await page.route('**/weekly-wrapped', async (route) => {
      const url = route.request().url();
      if (url.includes('/corrections')) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schema_version: 1,
          report_id: '2026-W37',
          generated_at: '2026-09-14T01:15:00.000Z',
          report: { scorecard: [] },
        }),
      });
    });
    await page.route('**/weekly-wrapped/corrections**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ correction: null }),
      });
    });
    await page.evaluate(() => {
      jira.key = 'smoke-key';
      jira.proxy = 'https://catet-jira-proxy.zackyanto-leo.workers.dev';
    });
    await page.evaluate(() => refreshWrappedWeekChip());
    await page.waitForFunction(() => {
      const chip = document.querySelector('#wrapped-week-chip');
      return chip && !chip.hidden && chip.textContent.includes('W37');
    });

    await page.unroute('**/weekly-wrapped/corrections**');
    await page.route('**/weekly-wrapped/corrections**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ correction: { verdict: 'looks_right' } }),
      });
    });
    await page.evaluate(() => refreshWrappedWeekChip());
    await page.waitForFunction(() => document.querySelector('#wrapped-week-chip')?.hidden === true);

    assert.strictEqual(errors.length, 0, 'no page errors: ' + errors.join(' | '));
    console.log('weekly wrapped week-chip smoke: OK');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
