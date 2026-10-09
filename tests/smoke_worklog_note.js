const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = spawn('python3', ['-m', 'http.server', '8873', '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; ; i++) {
      try { await fetch('http://127.0.0.1:8873/'); break; }
      catch (e) { if (i === 50) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [], sent = [];
      let rejectPush = true;
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('dialog', d => d.dismiss());
      await page.addInitScript(() => {
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-test', proxy: 'https://catet-test.invalid', items: [], deps: {}, bau: { items: [], alias: {} } }));
      });
      // Synthetic boundary only: no real Jira request or credentials.
      await page.route('https://catet-test.invalid/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/worklog') {
          sent.push(route.request().postDataJSON());
          await route.fulfill({ status: 200, json: rejectPush ? { error: 'test rejection' } : { ok: true } });
        } else await route.fulfill({ json: pathname === '/worklog-report' ? { days: {}, summaries: {} } : { items: [], events: [], stores: null } });
      });
      await page.goto(mode === 'http' ? 'http://127.0.0.1:8873/' : 'file://' + path.join(root, 'index.html'));
      await page.evaluate(() => {
        const now = new Date();
        tasks = [{ id: 'note-task', text: 'QA-999 — Original task', status: 'selesai', doneAt: now.toISOString(), priority: 'tinggi' }];
        worklog = [{ id: 'note-log', taskId: 'note-task', text: tasks[0].text, priority: 'tinggi', mins: 30, ts: now.toISOString(), date: localDateStr(now) }];
        save(); saveWorklog(); setView('log');
      });
      const note = page.getByRole('textbox', { name: 'Worklog note' });
      await page.getByText('Note', { exact: true }).click({ timeout: 1500 });
      assert.equal(await note.inputValue(), 'QA-999 — Original task');
      const custom = 'Testing API selesai. Referensi QA-123.\n<img src=x onerror=alert(1)>';
      await note.fill(custom);
      await page.getByRole('button', { name: '→ Jira', exact: true }).click();
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('#worklog button')].find(b => b.textContent === '→ Jira');
        return button && !button.disabled && !document.querySelector('.log-note-input').disabled;
      });
      assert.equal(sent[0].comment, custom);
      assert.equal(sent[0].key, 'QA-999');
      assert.equal(sent[0].timeSpentSeconds, 1800);
      // A failed application response must retain the draft and allow retry.
      assert.equal(await page.evaluate(() => worklog[0].jiraLogged || false), false);
      assert.equal(await note.isEnabled(), true);
      await page.reload();
      await page.evaluate(() => setView('log'));
      await page.getByText('Note', { exact: true }).click();
      assert.equal(await note.inputValue(), custom);
      assert.equal(await page.evaluate(() => tasks[0].text), 'QA-999 — Original task');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#worklog img').length), 0);
      fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(__dirname, 'screenshots', `worklog-note-${mode}-${theme}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      rejectPush = false;
      await note.fill('');
      await page.getByRole('button', { name: '→ Jira', exact: true }).click();
      await page.waitForFunction(() => worklog[0].jiraLogged === true);
      assert.equal(sent.at(-1).comment, '');
      assert.equal(await note.count(), 0);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('catet.worklog.v1'))[0].jiraNote), '');
      await page.evaluate(() => {
        jira.bau = { items: [{ key: 'TDBU-999', summary: 'Test meeting' }], alias: {} };
        worklog = [{ ...worklog[0], id: 'bau-log', text: 'Daily meeting', priority: 'rutin', bauKey: 'TDBU-999', jiraLogged: false }];
        delete worklog[0].jiraNote;
        saveWorklog(); render();
      });
      await page.getByText('Note', { exact: true }).click();
      assert.equal(await note.inputValue(), 'Daily meeting');
      await note.fill('Review QA-123');
      await page.getByRole('button', { name: '→ TDBU-999', exact: true }).click();
      await page.waitForFunction(() => worklog[0].jiraLogged === true);
      assert.equal(sent.at(-1).key, 'TDBU-999');
      assert.equal(sent.at(-1).comment, 'Review QA-123');
      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: default, custom payload, persistence, unchanged title, failure/retry, empty note, safe rendering, themes, mobile`);
      await context.close();
    }
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
