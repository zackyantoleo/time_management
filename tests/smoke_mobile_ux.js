// Synthetic fixtures only. All non-local requests are intercepted; no live account data.
// NODE_PATH=<installed Playwright node_modules> node tests/smoke_mobile_ux.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.MOBILE_UX_OUTPUT || path.join(root, 'tests/screenshots/mobile-ux');
const baseline = process.argv.includes('--baseline');
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const server = spawn('python3', ['-m', 'http.server', '18876', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  let browser;
  const results = [];
  try {
    for (let i = 0; ; i++) {
      try { assert((await fetch('http://127.0.0.1:18876/')).ok); break; }
      catch (e) { if (i > 50) throw e; await wait(100); }
    }
    browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', timezoneId: 'Asia/Jakarta', hasTouch: true, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript(() => {
        if (sessionStorage.getItem('mobile-seeded')) return;
        const now = new Date().toISOString();
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: [], bau: { items: [], alias: {} } }));
        localStorage.setItem('catet.tasks.v1', JSON.stringify([
          { id: 'focus', text: 'QA-101 — Uji alur checkout dan validasi promo', status: 'fokus', priority: 'tinggi', createdAt: now, focusedAt: now },
          { id: 'task', text: 'QA-102 — Verifikasi perubahan API dengan judul panjang agar tetap terbaca di layar kecil', status: 'aktif', priority: 'urgent', createdAt: now },
          { id: 'task2', text: 'Siapkan hasil pengujian untuk daily standup', status: 'aktif', priority: 'tinggi', createdAt: now }
        ]));
        localStorage.setItem('catet.worklog.v1', '[]');
        localStorage.setItem('catet.routines.v1', '[]');
        sessionStorage.setItem('mobile-seeded', '1');
      });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:18876') return route.continue();
        if (u.hostname !== 'synthetic.invalid') return route.abort();
        await route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic' }
          : u.pathname === '/state' ? { stores: null, updatedAt: null, ok: true }
          : u.pathname === '/worklog-report' ? { days: {}, summaries: {} } : { items: [], events: [] } });
      });
      await page.goto(mode === 'http' ? 'http://127.0.0.1:18876/' : pathToFileURL(path.join(root, 'index.html')).href);
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
      if (!baseline) assert.notEqual(await page.evaluate(() => document.activeElement.id), 'cap-text', 'initial mobile load does not autofocus');
      // Keep both optional header signals visible to exercise the worst-case header width.
      await page.evaluate(() => {
        document.querySelector('#wrapped-week-chip').hidden = false;
        document.querySelector('#wrapped-week-chip-label').textContent = 'W41';
        document.querySelector('#ready-alert-btn').hidden = false;
      });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `${baseline ? 'before' : 'after'}-${mode}-${theme}.png`), fullPage: true });
      }
      for (const width of [320, 360, 375, 390, 430, 760, 844, 1280]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
        await page.evaluate(() => setView('papan'));
        const metrics = await page.evaluate(() => {
          const rect = s => { const e = document.querySelector(s), r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }; };
          return { width: innerWidth, fits: document.documentElement.scrollWidth <= innerWidth,
            nav: rect('.tabs'), navPosition: getComputedStyle(document.querySelector('.tabs')).position,
            font: parseFloat(getComputedStyle(document.querySelector('#cap-text')).fontSize),
            focus: rect('#focus-card'), run: rect('#cap-run'), save: rect('#cap-save'),
            focusButtons: [...document.querySelectorAll('.focus-actions button')].map(e => ({ y: e.getBoundingClientRect().y, h: e.getBoundingClientRect().height })) };
        });
        results.push({ mode, ...metrics });
        if (baseline) continue;
        assert(metrics.fits, `${mode} Board overflow at ${width}`);
        if (width <= 760) {
          assert.equal(metrics.navPosition, 'fixed', 'mobile tabs stay reachable at bottom');
          assert(metrics.nav.bottom <= 844 && metrics.nav.bottom >= 830);
          assert(metrics.font >= 16, 'mobile inputs must not trigger iOS auto zoom');
          assert(metrics.run.h >= 44 && metrics.save.h >= 44, 'Run and Save remain available on mobile');
          assert.equal(metrics.focusButtons[0].y, metrics.focusButtons[1].y, 'Done and Pause share a row');
        } else assert.notEqual(metrics.navPosition, 'fixed', 'desktop retains its top tabs');
        for (const tab of ['jira', 'kalender', 'log']) {
          await page.locator('#tab-' + tab).click();
          const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(e => ({ tag: e.tagName, cls: e.className, text: e.textContent.slice(0, 70), right: e.getBoundingClientRect().right })));
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} overflow at ${width}: ${JSON.stringify(overflow)}`);
        }
        await page.locator('#tab-kalender').click();
        await page.waitForSelector('.kal-cell');
        await page.locator('.kal-cell.ini').click();
        assert.equal(await page.locator('.kal-cell.ini').getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Enter');
        assert(await page.locator('.kal-cell.ini').evaluate(e => e === document.activeElement));
        if (width <= 760) {
          const height = await page.locator('.kal-cell').first().evaluate(e => e.getBoundingClientRect().height);
          assert(height <= 64 && height >= 44, 'mobile month must be compact, with readable day details below');
        }
        await page.locator('#settings-btn').click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Settings overflow at ${width}`);
        if (width <= 760) {
          // Explicit populated states; API fixtures intentionally return an empty account.
          await page.evaluate(() => {
            jira.items = [{ id: 'fixture-ticket', key: 'QA-987', summary: 'Synthetic long ticket title for mobile overflow verification', addedAt: new Date().toISOString(), status: 'In Progress' }];
            setView('jira');
          });
          assert(await page.locator('.jira-row').count());
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'populated Jira fits');
          await page.evaluate(() => {
            const n = new Date();
            worklog = [{ id: 'fixture-log', text: 'QA-987 — Synthetic long worklog title for mobile verification', priority: 'tinggi', mins: 30, ts: n.toISOString(), date: localDateStr(n) }];
            setView('log');
          });
          assert(await page.locator('.log-entry').count());
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'populated worklog fits');
          await page.evaluate(() => {
            document.querySelector('#wrapped-week-chip').hidden = false;
            document.querySelector('#wrapped-week-chip-label').textContent = 'W41';
            document.querySelector('#ready-alert-btn').hidden = false;
          });
          assert(await page.evaluate(() => [...document.querySelectorAll('.top-actions > button, .week-chip')].every(e => e.getBoundingClientRect().right <= innerWidth)), 'all optional header actions fit');
        }
      }
      if (!baseline) {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.locator('#tab-papan').click();
        assert.notEqual(await page.evaluate(() => document.activeElement.id), 'cap-text', 'no automatic phone keyboard');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        assert(await page.locator('footer.foot').evaluate(e => e.getBoundingClientRect().bottom <= document.querySelector('.tabs').getBoundingClientRect().top), 'last content clears bottom navigation');
        await page.locator('#capture-more').click();
        assert.equal(await page.locator('#capture-more').getAttribute('aria-expanded'), 'true');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert(await page.locator('.task-action-label').evaluateAll(labels => labels.every(label => label.closest('button').getAttribute('aria-label').includes(label.textContent))), 'visible labels are included in accessible names');
        await page.locator('.task-actions button').filter({ has: page.locator('.task-action-label', { hasText: 'Edit' }) }).first().click();
        const smallInputs = await page.locator('input, textarea, select').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && parseFloat(getComputedStyle(n).fontSize) < 16).map(n => n.id || n.className || n.type));
        assert.deepEqual(smallInputs, [], 'mobile capture and task editor inputs are at least 16px');
        await page.locator('#cap-text').fill('Synthetic mobile capture');
        await page.locator('#cap-run').click();
        await page.waitForFunction(() => tasks.some(t => t.text === 'Synthetic mobile capture' && t.status === 'fokus'));
        assert(await page.evaluate(() => JSON.parse(localStorage.getItem('catet.tasks.v1')).some(t => t.text === 'Synthetic mobile capture' && t.status === 'fokus')));
        await page.locator('#tab-jira').click();
        await page.locator('#tab-jira').focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => view), 'kalender');
        await page.reload(); await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
        assert.equal(await page.evaluate(() => view), 'kalender');
        await page.locator('#tab-papan').click();
        assert(await page.locator('#focus-card').textContent().then(s => s.includes('Synthetic mobile capture')));
        await page.locator('#tab-kalender').click();
        await page.evaluate(() => {
          const day = localDateStr(new Date());
          gridEvents = [{ id: 'synthetic-event', summary: 'Synthetic daily meeting with a long title', allDay: true, date: day }];
          calSel = day; render();
        });
        assert.equal(await page.locator('.kal-cell.ini .kal-mobile-count').textContent(), '1');
        assert((await page.locator('.kal-detail').textContent()).includes('Synthetic daily meeting'));
        await page.addStyleTag({ content: 'body { zoom: 1.25; }' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'calendar supports enlarged content');
        await page.addStyleTag({ content: 'body { zoom: 1; }' });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
          await page.screenshot({ path: path.join(out, `calendar-${mode}-${theme}.png`), fullPage: true });
        }
        assert.deepEqual(errors, []);
      }
      await context.close();
    }
    fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : 'verified.json'), JSON.stringify(results, null, 2));
    console.log(`${baseline ? 'BASELINE' : 'PASS'} mobile UX: ${results.length} viewport/transport cases; screenshots: ${out}`);
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
