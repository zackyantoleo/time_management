'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sample = fs.readFileSync(path.join(root, 'assets/data/work-patterns.sample.json'), 'utf8');
(async () => {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.json') ? 'application/json' : 'text/html');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/zackVPS/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--allow-file-access-from-files'] });
  const results = [];
  try {
    for (const protocol of ['file', 'http']) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 360, height: 740 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await context.route('https://**/*', route => { external.push(route.request().url()); route.abort(); });
      const url = protocol === 'file' ? 'file://' + path.join(root, 'weekly-wrapped.html') : base + '/weekly-wrapped.html';
      await page.goto(url);
      await page.waitForSelector('#work-pattern-report', { state: 'visible' });
      assert.equal(await page.locator('#wrapped-source-status').getAttribute('data-source'), 'demo');
      assert.equal(await page.locator('#wrapped-story').isVisible(), false);
      assert.equal(await page.locator('#wrapped-report').isVisible(), false, 'legacy plans/scores must be hidden');
      assert.equal(await page.locator('#work-pattern-items').getAttribute('open'), null);
      assert.equal(await page.locator('#work-pattern-summary').textContent(), JSON.parse(sample).report.summary);
      await page.locator('#work-pattern-highlights details summary').first().press('Enter');
      assert(await page.locator('#work-pattern-highlights details[open]').count());
      assert(await page.locator('#work-pattern-highlights').textContent().then(t => /Konteks tandingan|counter-context/.test(t)));
      assert(await page.locator('#work-pattern-highlights').textContent().then(t => /3180|180/.test(t)));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      assert(await page.locator('#wrapped-period').isVisible());
      const separated = await page.evaluate(() => Math.max(document.querySelector('.wrapped-top').getBoundingClientRect().bottom, document.querySelector('#wrapped-period').getBoundingClientRect().bottom, document.querySelector('#theme-toggle').getBoundingClientRect().bottom) <= document.querySelector('.wrapped-local-tools').getBoundingClientRect().top);
      assert(separated, 'period/header must not overlap local controls');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        if (process.env.WRAPPED_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.WRAPPED_SCREENSHOT_DIR, `${protocol}-${theme}.png`), fullPage: true });
      }
      const before = await page.evaluate(() => JSON.stringify(localStorage));
      await page.locator('#wrapped-local-input').setInputFiles({ name: 'local-draft.json', mimeType: 'application/json', buffer: Buffer.from(sample) });
      await page.waitForFunction(() => document.querySelector('#wrapped-source-status').dataset.source === 'local');
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before, 'opening local report must not persist private data');
      const hostile = JSON.parse(sample);
      hostile.report.coverage.catet.reason = '<img src=x onerror=alert(1)>';
      await page.locator('#wrapped-local-input').setInputFiles({ name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) });
      await page.waitForFunction(() => document.querySelector('#work-pattern-report').textContent.includes('<img src=x'));
      assert.equal(await page.locator('#work-pattern-report img').count(), 0);
      const bad = JSON.parse(sample); bad.report.insights[0].evidence_refs = ['missing'];
      await page.locator('#wrapped-local-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
      await page.waitForSelector('#wrapped-error', { state: 'visible' });
      assert.equal(await page.locator('#work-pattern-report').isVisible(), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      results.push(`${protocol}: demo/local/citations/no-storage/XSS/invalid/mobile/light-dark PASS`);
      await context.close();
    }
    {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const requests = [], embeddedErrors = [];
      page.on('pageerror', e => embeddedErrors.push(e.message));
      await context.route('**/*', route => {
        if (route.request().isNavigationRequest()) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        requests.push(route.request().url()); return route.abort();
      });
      let html = fs.readFileSync(path.join(root, 'weekly-wrapped.html'), 'utf8');
      html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => `<script>${fs.readFileSync(path.join(root, f), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`)
        .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>${fs.readFileSync(path.join(root, f), 'utf8')}</style>`)
        .replace(/<link rel="(?:manifest|icon|apple-touch-icon)"[^>]+>/g, '')
        .replace('</head>', '<script id="wrapped-local-report" type="application/json">' + sample.replace(/</g, '\\u003c') + '</script></head>');
      await page.goto(base + '/local-review.html');
      try { await page.waitForSelector('#work-pattern-report', { state: 'visible', timeout: 5000 }); }
      catch (e) { console.log({ embeddedErrors, requests, embedded: await page.locator('#wrapped-local-report').count(), source: await page.locator('#wrapped-source-status').textContent() }); throw e; }
      assert.equal(await page.locator('#wrapped-source-status').getAttribute('data-source'), 'local');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      assert.deepEqual(requests, [], 'self-contained local artifact must not fetch');
      results.push('embedded local artifact: no requests, 320px PASS');
      await context.close();
    }
    for (const status of [401, 403, 500, 'invalid', 'missing', 'live']) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(() => localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-key', proxy: 'https://worker.invalid' })));
      const page = await context.newPage();
      await context.route('https://**/*', route => route.fulfill({ status: typeof status === 'number' ? status : 200, contentType: 'application/json',
        body: status === 'live' ? JSON.stringify({ ...JSON.parse(sample), updated_at: '2026-10-14T03:00:00.000Z' }) : status === 'missing' ? JSON.stringify({ report: null, updatedAt: null }) : '{}' }));
      await page.goto(base + '/weekly-wrapped.html');
      if (status === 'live' || status === 'missing') {
        await page.waitForSelector('#work-pattern-report', { state: 'visible' });
        assert.equal(await page.locator('#wrapped-source-status').getAttribute('data-source'), status === 'live' ? 'live' : 'demo');
        results.push(`${status}: correct source state PASS`);
      } else {
        await page.waitForSelector('#wrapped-error', { state: 'visible' });
        assert.equal(await page.locator('#wrapped-source-status').getAttribute('data-source'), 'error');
        assert.equal(await page.locator('#work-pattern-report').isVisible(), false);
        assert(await page.locator('#wrapped-retry').isVisible());
        results.push(`HTTP ${status}: honest error, no demo fallback PASS`);
      }
      await context.close();
    }
    {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(() => localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-key', proxy: 'https://worker.invalid' })));
      let release, completed;
      const done = new Promise(resolve => { completed = resolve; });
      await context.route('https://**/*', async route => {
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 200, contentType: 'application/json', body: sample }); completed();
      });
      const page = await context.newPage();
      await page.goto(base + '/weekly-wrapped.html');
      await page.locator('#wrapped-local-input').setInputFiles({ name: 'local.json', mimeType: 'application/json', buffer: Buffer.from(sample) });
      await page.waitForFunction(() => document.querySelector('#wrapped-source-status').dataset.source === 'local');
      release(); await done;
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#wrapped-source-status').getAttribute('data-source'), 'local', 'late live response must not overwrite explicit local review');
      results.push('late live response: local selection preserved PASS');
      await context.close();
    }
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(base + '/weekly-wrapped.html?demo=legacy');
    await page.waitForSelector('#wrapped-report', { state: 'visible' });
    assert.equal(await page.locator('#wrapped-story').isVisible(), false);
    await page.locator('#replay-story').click();
    await page.waitForSelector('#wrapped-story', { state: 'visible' });
    assert.equal(await page.locator('#story-index').textContent(), '01 / 06');
    await page.keyboard.press('Escape');
    await page.locator('#correction-looks-right').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('catet.weekly.corrections.demo.v1') || '{}').verdict === 'looks_right');
    results.push('legacy: report-first/optional-story/correction PASS');
    await context.close();
    console.log(JSON.stringify({ status: 'PASS', checks: results }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
