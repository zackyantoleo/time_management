// Synthetic fixtures; intercept every non-local request. No production writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.MISSING_WORKLOG_OUTPUT || path.join(process.env.TMPDIR || root, 'catet-missing-worklog-screens');
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const server = spawn('python3', ['-m', 'http.server', '18879', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; ; i++) { try { assert((await fetch('http://127.0.0.1:18879')).ok); break; } catch { assert(i < 50); await wait(100); } }
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage(), errors = [], methods = [];
      let requests = 0, fail = false, hold = false, release, credentialUpdates = 0, currentSite = 'https://jira.invalid';
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        if (sessionStorage.getItem('missing-seed')) return;
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: ['QA-2'] }));
        localStorage.setItem('catet.tasks.v1', JSON.stringify([{ id: 'existing', text: 'QA-1 existing on board', status: 'aktif', priority: 'rendah', createdAt: new Date().toISOString() }]));
        localStorage.setItem('catet.worklog.v1', '[]'); sessionStorage.setItem('missing-seed', '1');
      });
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:18879') return route.continue();
        if (u.hostname !== 'synthetic.invalid') return route.abort();
        methods.push(route.request().method() + ' ' + u.pathname);
        if (u.pathname === '/missing-worklog') {
          const responseSite = currentSite;
          requests++; if (hold) await new Promise(r => release = r);
          return route.fulfill({ status: fail ? 502 : 200, json: fail ? { error: 'Synthetic Jira error' } : {
            site: responseSite, complete: true, total: 2, excludedQality: 7, checkedAt: new Date().toISOString(), items: [
              { key: 'QA-1', summary: '<img src=x onerror=alert(1)> Done ticket', status: 'Done', issueType: 'Task' },
              { key: 'QA-2', summary: 'Other author only', status: 'In Progress', issueType: 'Bug' },
            ] } });
        }
        if (u.pathname === '/me/jira') { credentialUpdates++; currentSite = JSON.parse(route.request().postData()).site; return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic', jira_site: currentSite, jira_tersimpan: true } : u.pathname === '/state' ? { stores: null, updatedAt: null } : { items: [], events: [], days: {}, summaries: {} } });
      });
      await page.goto(mode === 'http' ? 'http://127.0.0.1:18879' : pathToFileURL(path.join(root, 'index.html')).href);
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
      await page.locator('#tab-jira').click();
      const chip = page.getByRole('button', { name: 'Missing worklog', exact: true });
      assert.equal(await chip.count(), 1, 'compact filter exists');
      assert.equal(requests, 0, 'lazy endpoint; no expensive fetch on startup');
      const tasksBefore = await page.evaluate(() => JSON.stringify(tasks));
      await chip.click(); await page.waitForSelector('#jira-worklog-list .jira-row');
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 2, 'Done/board/dismissed tickets still appear');
      assert.equal(await page.locator('#jira-worklog-list img').count(), 0, 'user titles are text, not HTML');
      assert.equal(await page.locator('#jira-worklog-list .jira-row button').count(), 0, 'read-only list has no take/delete/transition actions');
      assert.equal(await page.evaluate(() => JSON.stringify(tasks)), tasksBefore);
      await page.locator('#search').fill('Other author');
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 1);
      await page.locator('#search').fill('');
      await page.locator('#jira-worklog-refresh').focus(); await page.evaluate(() => render());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'jira-worklog-refresh', 'periodic render preserves keyboard focus');
      await page.locator('#jira-worklog-list .jira-key').first().focus();
      await page.evaluate(() => render());
      assert.equal(await page.locator('#jira-worklog-list .jira-key').first().evaluate(e => e === document.activeElement), true, 'result link focus survives render');
      await page.locator('#jira-worklog-refresh').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#jira-worklog-list .jira-row');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'jira-worklog-refresh', 'keyboard Refresh keeps focus during and after loading');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `missing-${mode}-${theme}.png`), fullPage: true });
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile fits');
      await page.evaluate(() => { jira.site = 'https://unrelated.invalid'; render(); });
      assert.equal(await page.locator('#jira-worklog-list .jira-key').first().getAttribute('href'), 'https://jira.invalid/browse/QA-1', 'links use result connection, not mutable global Jira site');
      const updateCredentials = async site => {
        await page.locator('#settings-btn').click();
        await page.locator('#settings-access details').first().evaluate(e => e.open = true);
        const form = page.locator('.routine-form').filter({ has: page.locator('input[placeholder="Email Atlassian"]') });
        await form.locator('input[type="url"]').fill(site);
        await form.locator('input[type="email"]').fill('synthetic@example.invalid');
        await form.locator('input[type="password"]').fill('synthetic-test-token');
        const dialog = page.waitForEvent('dialog').then(d => d.dismiss());
        await form.getByRole('button', { name: 'Update', exact: true }).click(); await dialog;
        await page.locator('#tab-jira').click();
      };
      await updateCredentials('https://other-jira.invalid');
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 0, 'Jira credential update clears cached account results');
      hold = true; release = null;
      await page.getByRole('button', { name: 'Missing worklog', exact: true }).click();
      for (let i = 0; !release; i++) { assert(i < 100); await wait(10); }
      await updateCredentials('https://third-jira.invalid');
      release(); hold = false; await wait(100);
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 0, 'Jira credential update invalidates pending old-account response');
      assert.equal(credentialUpdates, 2);
      await page.evaluate(() => pakaiKode('another-code'));
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 0, 'direct account switch clears prior results');
      await page.getByRole('button', { name: 'Missing worklog', exact: true }).click();
      await page.waitForSelector('#jira-worklog-list .jira-row');
      fail = true; await page.locator('#jira-worklog-refresh').click();
      await page.waitForFunction(() => document.querySelector('#jira-worklog-feedback')?.textContent.includes('Synthetic Jira error'));
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 0, 'failed fetch not presented as fresh');
      fail = false; hold = true; await page.locator('#jira-worklog-refresh').click();
      for (let i = 0; !release; i++) { assert(i < 100); await wait(10); }
      const count = requests; await page.evaluate(() => refreshMissingWorklog()); assert.equal(requests, count, 'concurrent refresh is locked');
      await page.evaluate(() => { kosongkanDataLokalTanpaAkses(); render(); });
      release(); await wait(100);
      await page.evaluate(() => { jira.key = 'other-code'; render(); });
      assert.equal(await page.locator('#jira-worklog-list .jira-row').count(), 0, 'in-flight response cannot cross sign-out/account switch');
      assert(!methods.some(m => m.startsWith('POST ') && m !== 'POST /me/jira'), 'filter does not write Jira');
      assert.deepEqual(errors, []);
      console.log(mode + ': missing worklog UI/search/read-only/error/focus/account isolation: PASS');
      await context.close();
    }
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
