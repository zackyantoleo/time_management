// Synthetic fixtures; Worker di-mock dan semua request lain diblokir. Fase 1:
// panel Test cases hanya parse + pratinjau — tidak boleh ada request ke
// /testcases, /me/qality, Jira, atau QAlity.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.TESTCASE_SMOKE_OUTPUT || path.join(process.env.TMPDIR || root, 'catet-testcase-screens');
const PORT = 18884;
const wait = ms => new Promise(r => setTimeout(r, ms));
const MARKER = 'SYNTH-DRAFT-MARKER';
const SAMPLE = `Here are the test cases:

**Title:** Verify Get Customer Profile Successfully

**Precondition:**
- Customer has a valid access token (${MARKER}).

**Test Step(s):**
1. Send a GET request to \`/customers/v2/profile\` using a valid access token.

**Expected Result:**
1. API returns HTTP status code \`200 OK\`.
2. Response contains the correct customer profile data according to the database.

---

**Title:** Check profile <img src=x onerror="window.__xss=1">

**Test Step(s):**
1. Send a GET request and verify the response body.

**Expected Result:**
1. API returns HTTP status code \`200 OK\`.

---

**Title:** verify get customer profile   successfully

**Precondition:**
- Customer has a valid access token.

**Test Step(s):**
1. Send a GET request to \`/customers/v2/profile\`.
`;
const json21 = JSON.stringify({ format: 'catet.testcases.v1', cases: Array.from({ length: 21 }, (_, i) => ({
  title: 'Verify Synthetic Case ' + (i + 1), preconditions: ['Synthetic precondition.'], steps: ['Open synthetic page ' + (i + 1) + '.'], expected: ['Page opens.'],
})) }, null, 2);

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; ; i++) { try { assert((await fetch('http://127.0.0.1:' + PORT)).ok); break; } catch { assert(i < 50); await wait(100); } }
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [], consoleErrors = [], workerCalls = [], blocked = [], stateBodies = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      await page.addInitScript(() => {
        if (sessionStorage.getItem('tc-seed')) return;
        const now = new Date().toISOString();
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: [] }));
        localStorage.setItem('catet.tasks.v1', JSON.stringify([
          { id: 'tc1', text: 'QA-123 — Synthetic ticket', status: 'aktif', priority: 'urgent', createdAt: now },
          { id: 'tc2', text: 'Plain synthetic note', status: 'aktif', priority: 'urgent', createdAt: now },
          { id: 'tc3', text: 'QA-200 — Focused synthetic ticket', status: 'fokus', priority: 'tinggi', focusedAt: now, createdAt: now },
        ]));
        localStorage.setItem('catet.worklog.v1', '[]');
        sessionStorage.setItem('tc-seed', '1');
      });
      await page.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:' + PORT) return route.continue();
        if (u.hostname !== 'synthetic.invalid') { blocked.push(u.hostname); return route.abort(); }
        workerCalls.push(req.method() + ' ' + u.pathname);
        if (u.pathname === '/state' && req.method() !== 'GET') stateBodies.push(req.postData() || '');
        return route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic', jira_site: 'https://jira.invalid', jira_tersimpan: true }
          : u.pathname === '/state' ? { stores: null, updatedAt: null } : { items: [], events: [], days: {}, summaries: {} } });
      });
      await page.goto(mode === 'http' ? 'http://127.0.0.1:' + PORT : pathToFileURL(path.join(root, 'index.html')).href);
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);

      const row = page.locator('li.task[data-task-id="tc1"]');
      const toggle = row.getByRole('button', { name: 'Test cases', exact: true });
      assert.equal(await toggle.count(), 1, 'task bertiket Jira punya tombol Test cases');
      assert.equal(await page.locator('li.task[data-task-id="tc2"]').getByRole('button', { name: 'Test cases' }).count(), 0, 'task tanpa key Jira tidak');
      assert.equal(await page.locator('#focus-card').getByRole('button', { name: 'Test cases' }).count(), 1, 'kartu fokus bertiket juga punya tombol');
      assert.equal(await page.locator('.testcase-panel').count(), 0, 'panel tertutup secara default');

      await toggle.click();
      const panel = page.locator('#tc-panel-tc1');
      await panel.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-btn-tc1', 'fokus tetap di tombol pembuka');
      assert.match(await panel.locator('.jira-key').textContent(), /^QA-123$/);

      // Parse → pratinjau dengan error + warning; teks pengguna tidak dirender sebagai HTML.
      await panel.locator('textarea').fill(SAMPLE);
      await panel.getByRole('button', { name: 'Parse', exact: true }).click();
      const cards = panel.locator('.testcase-card');
      assert.equal(await cards.count(), 3);
      assert.deepEqual(await cards.evaluateAll(n => n.map(c => c.className)), ['testcase-card has-error', 'testcase-card has-warning', 'testcase-card has-error']);
      assert.deepEqual(await panel.locator('.testcase-chip').allTextContents(), ['3 cases', '3 selected', '2 errors', '1 warning']);
      assert.match(await cards.nth(0).locator('.testcase-issues.err').textContent(), /duplikat/);
      assert.match(await cards.nth(2).locator('.testcase-issues.err').textContent(), /Tidak ada Expected Result/);
      const warn2 = await cards.nth(1).locator('.testcase-issues.warn').textContent();
      for (const re of [/Verify\/Validate/, /Precondition kosong/, /Step 1.*verify/]) assert.match(warn2, re);
      assert.equal(await cards.nth(1).locator('.testcase-issues.err').count(), 0, 'warning tidak jadi error');
      assert.equal(await panel.locator('img').count(), 0, 'judul berisi tag HTML tetap teks');
      assert.match(await cards.nth(1).locator('.testcase-title').textContent(), /<img src=x/);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.deepEqual(await cards.nth(0).locator('.testcase-field ol').nth(1).locator('li').allTextContents(),
        ['API returns HTTP status code `200 OK`.', 'Response contains the correct customer profile data according to the database.']);
      assert.equal(await panel.locator('.testcase-status.ok').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-parse-tc1', 'fokus kembali ke Parse setelah render');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `testcase-${mode}-desktop-${theme}.png`), fullPage: true });
      }

      // Hapus centang case kembar → duplikat hilang, batch siap; fokus tetap di checkbox.
      await cards.nth(2).getByRole('checkbox').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-pick-tc1-2');
      assert.deepEqual(await cards.evaluateAll(n => n.map(c => c.className)), ['testcase-card', 'testcase-card has-warning', 'testcase-card excluded']);
      assert.match(await cards.nth(2).textContent(), /Excluded/);
      assert.deepEqual(await panel.locator('.testcase-chip').allTextContents(), ['3 cases', '2 selected', '0 errors', '1 warning']);
      assert.match(await panel.locator('.testcase-status.ok').textContent(), /2 case siap/);

      // Draft per task: tersimpan lokal, ditandai basi saat diedit, bertahan saat panel ditutup & reload.
      const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem('catet.testcaseDrafts.v1') || '{}'));
      assert.equal((await draft()).tc1.text, SAMPLE.replace(/\r/g, ''));
      assert.equal(await panel.locator('.testcase-stale').isVisible(), false);
      await panel.locator('textarea').press('End');
      await panel.locator('textarea').pressSequentially(' extra');
      assert.equal(await panel.locator('.testcase-stale').isVisible(), true, 'pratinjau basi ditandai');
      assert.match((await draft()).tc1.text, / extra$/);
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      assert.equal(await page.locator('.testcase-panel').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-btn-tc1', 'Close mengembalikan fokus ke tombol');
      await page.reload();
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
      await page.locator('li.task[data-task-id="tc1"]').getByRole('button', { name: 'Test cases', exact: true }).click();
      assert.match(await page.locator('#tc-panel-tc1 textarea').inputValue(), / extra$/, 'draft bertahan setelah reload');
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-card').count(), 0, 'pratinjau tidak dipersist; Parse ulang');

      // JSON 21 case → ditolak di level batch; hapus satu centang → siap.
      await page.locator('#tc-panel-tc1 textarea').fill(json21);
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-card').count(), 21);
      assert.match(await page.locator('#tc-panel-tc1 .testcase-preview > .testcase-issues.err').textContent(), /21 case; maksimal 20/);
      await page.locator('#tc-panel-tc1 .testcase-card').nth(20).getByRole('checkbox').click();
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-preview > .testcase-issues.err').count(), 0);
      assert.match(await page.locator('#tc-panel-tc1 .testcase-status.ok').textContent(), /20 case siap/);

      // Input rusak → pesan jelas, tanpa kartu.
      await page.locator('#tc-panel-tc1 textarea').fill('Tolong buatkan test case untuk tiket ini ya.');
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-card').count(), 0);
      assert.match(await page.locator('#tc-panel-tc1 .testcase-issues.err').textContent(), /Tidak ada test case/);
      await page.locator('#tc-panel-tc1 textarea').fill('{"format": "catet.testcases.v1", "cases": [');
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Parse', exact: true }).click();
      assert.match(await page.locator('#tc-panel-tc1 .testcase-issues.err').textContent(), /JSON tidak valid/);

      // Kartu fokus: panel terbuka di dalam kartu (satu panel sekaligus); HP 360/390 px muat.
      await page.locator('#focus-card').getByRole('button', { name: 'Test cases' }).click();
      assert.equal(await page.locator('.testcase-panel').count(), 1);
      const focusPanel = page.locator('#focus-card #tc-panel-tc3');
      await focusPanel.locator('textarea').fill(SAMPLE);
      await focusPanel.getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await focusPanel.locator('.testcase-card').count(), 3);
      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fits ${width}px`);
      }
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `testcase-${mode}-mobile-${theme}.png`), fullPage: true });
      }
      await page.locator('#focus-card').getByRole('button', { name: 'Test cases' }).click(); // tutup
      await page.locator('li.task[data-task-id="tc1"]').getByRole('button', { name: 'Test cases', exact: true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'task row + panel fit on phone');

      // Clear (dengan konfirmasi) menghapus draft task itu saja.
      page.once('dialog', d => d.accept());
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Clear', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 textarea').inputValue(), '');
      const left = await draft();
      assert.equal(left.tc1, undefined);
      assert.match(left.tc3.text, /Verify Get Customer Profile/);

      // Tidak ada write ke luar; draft tidak ikut state yang disinkronkan.
      assert(!workerCalls.some(c => /\/(testcases|me\/qality)/.test(c)), 'Fase 1 tidak memanggil endpoint test case: ' + workerCalls.join(', '));
      assert.deepEqual(blocked, [], 'tidak ada request ke host lain (Jira/QAlity)');
      assert(!stateBodies.some(b => b.includes(MARKER)), 'draft tidak ikut /state');
      assert(await page.evaluate(m => ['catet.tasks.v1', 'catet.jira.v1'].every(k => !(localStorage.getItem(k) || '').includes(m)), MARKER));
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      console.log(`PASS ${mode}: toggle/parse/preview/error+warning/XSS-safe/uncheck/draft/reload/batch 21/rusak/focus card/mobile/clear, no writes, no console errors`);
      await context.close();
    }
    console.log('Screenshots: ' + out);
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
