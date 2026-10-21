'use strict';
// Read private artifacts locally; print aggregate checks only. Never screenshot private data.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let stage = 'init';
(async () => {
  assert(process.argv.length > 2, 'provide local replay directories');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/home/zackVPS/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--allow-file-access-from-files'] });
  const results = [];
  const workerSource = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8').replace('../assets/js/work-pattern-report-contract.js', pathToFileURL(path.join(root, 'assets/js/work-pattern-report-contract.js')).href);
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
  try {
    for (const dir of process.argv.slice(2).map(p => path.resolve(p))) {
      const htmlPath = path.join(dir, 'review-local.html'), jsonPath = path.join(dir, 'work-pattern-report.json');
      for (const file of [htmlPath, jsonPath]) { const s = fs.lstatSync(file); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); }
      const report = JSON.parse(fs.readFileSync(jsonPath)), html = fs.readFileSync(htmlPath, 'utf8');
      require('../assets/js/work-pattern-report-contract').validateWorkPatternReport(report);
      let row;
      const accessKey = 'synthetic-access';
      const accessHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessKey))).toString('hex');
      const env = { WEEKLY_WRAPPED_SERVICE_TOKEN: 'synthetic-service', CATET_DB: {
        prepare(sql) { return { bind(...args) { return {
          async first() {
            if (sql.includes('FROM users WHERE token_hash')) return args[0] === accessHash ? { id: 'synthetic-user' } : null;
            if (sql.includes('FROM weekly_wrapped_reports')) return row || null;
            throw new Error('unexpected local SQL read');
          },
          async run() {
            assert(sql.includes('INSERT INTO weekly_wrapped_reports'));
            row = { report_id: args[1], blob: args[2], updated_at: args[3] }; return { success: true, meta: { changes: 1 } };
          }, async all() { return { results: [] }; },
        }; } }; }, async exec() {}, async batch() { return []; },
      } };
      const headers = { Origin: 'https://zackyantoleo.github.io', 'X-Catet-Key': accessKey, Authorization: 'Bearer synthetic-service', 'Content-Type': 'application/json' };
      const put = body => worker.fetch(new Request('https://worker.test/weekly-wrapped', { method: 'PUT', headers, body: JSON.stringify(body) }), env);
      stage = 'worker-put'; assert.equal((await put(report)).status, 200);
      const read = await worker.fetch(new Request('https://worker.test/weekly-wrapped', { headers }), env);
      assert.equal(read.status, 200); const stored = await read.json(); delete stored.updated_at; assert.deepEqual(stored, report);
      const bad = structuredClone(report); bad.report.insights[0].interpretation = 'Jadwal membuktikan hadir dan produktif.';
      assert.equal((await put(bad)).status, 400); assert.deepEqual(JSON.parse(row.blob), report);
      const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}/local-review.html`;
      try {
        for (const mode of ['file', 'http', 'sandbox']) {
          stage = mode; const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
          const errors = [], extra = []; const page = await context.newPage();
          page.on('pageerror', e => errors.push(e.message));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          await context.route('**/*', route => {
            if (route.request().isNavigationRequest()) return route.continue();
            extra.push(route.request().url()); return route.abort();
          });
          if (mode === 'sandbox') {
            await page.setContent('<!doctype html><html><body></body></html>');
            await page.evaluate(body => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.style.width = '300px'; f.style.height = '740px'; f.srcdoc = body; document.body.append(f); }, html);
          } else await page.goto(mode === 'file' ? pathToFileURL(htmlPath).href : url);
          const view = mode === 'sandbox' ? page.frameLocator('iframe') : page;
          await view.locator('#work-pattern-report').waitFor({ state: 'visible' });
          assert.equal(await view.locator('#wrapped-source-status').getAttribute('data-source'), 'local');
          assert.equal(await view.locator('#work-pattern-highlights .claim-card').count(), report.report.insights.filter(i => i.dimension !== 'activity').length);
          assert.equal(await view.locator('#work-pattern-items .claim-card').count(), report.report.insights.filter(i => i.dimension === 'activity').length);
          assert.equal(await view.locator('#work-pattern-evidence .pattern-ref').count(), report.report.evidence.length);
          assert.equal(await view.locator('#wrapped-report').isVisible(), false);
          await view.locator('#work-pattern-highlights details summary').first().press('Enter');
          assert.equal(await view.locator('#work-pattern-highlights details[open]').count(), 1);
          const frame = mode === 'sandbox' ? page.frames().find(f => f !== page.mainFrame()) : page.mainFrame();
          assert(await frame.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
          assert.deepEqual(await frame.evaluate(() => JSON.parse(document.querySelector('#wrapped-local-report').textContent)), report);
          if (mode !== 'sandbox') assert(!(await frame.evaluate(() => JSON.stringify(localStorage))).includes('event:'));
          stage = mode + '-requests'; assert.equal(extra.length, 0);
          stage = mode + '-errors'; assert.equal(errors.length, 0);
          await context.close();
        }
      } finally { await new Promise(resolve => server.close(resolve)); }
      results.push({ week: report.report_id, original_as_of: report.generated_at, facts: report.report.insights.length, records: report.report.evidence.length,
        worker_memory_put_get: 'exact; invalid cannot overwrite', browser_modes: ['file', 'http', 'sandbox'], remote_requests: 0, page_errors: 0, width: 320 });
    }
    console.log(JSON.stringify({ status: 'PASS', cycles: results }));
  } finally { await browser.close(); }
})().catch(e => { console.error('LOCAL_REPLAY_SMOKE_FAILED stage=' + stage + ' type=' + e.constructor.name + (e.code ? ' code=' + e.code : '') + (e.stack?.match(/smoke_work_pattern_replay.js:\d+/)?.[0] || '')); process.exitCode = 1; });
