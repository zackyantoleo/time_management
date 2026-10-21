// Synthetic fixtures; Worker di-mock dan semua request lain diblokir. Parse +
// pratinjau lokal tanpa request; membuka panel memuat History (GET /testcases);
// Dry run = POST /testcases/preview; Push/Retry link = POST /testcases/push|relink
// ke Worker mock; token QAlity lewat /me/qality. Tidak ada request ke Jira/QAlity.
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
      const errors = [], consoleErrors = [], workerCalls = [], blocked = [], stateBodies = [], previewBodies = [], qalityBodies = [], pushBodies = [];
      let previewMode = 'ok', pushMode = 'ok', history = [];
      const XSS = 'Check profile <img src=x onerror="window.__xss=1">';
      // Token kedaluwarsa 10 hari lagi → Settings menampilkan peringatan.
      const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
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
        if (u.pathname === '/testcases/preview') {
          const body = JSON.parse(req.postData() || '{}');
          previewBodies.push(body);
          if (previewMode === 'error') return route.fulfill({ status: 400, json: { error: 'Project QA belum aktif di QAlity untuk akunmu, jadi belum didukung. Project aktif: CD.' } });
          return route.fulfill({ json: {
            issueKey: body.issueKey, project: { key: 'QA', id: '10999' }, linkType: 'QAlity Test',
            existing: [{ key: 'QA-900', summary: 'Check profile <img src=x onerror="window.__xss=1">', status: 'To Do', linkType: 'QAlity Test' }],
            counts: { create: 1, skip: 1 }, previewHash: 'f'.repeat(64),
            plan: [
              { index: 0, title: body.cases[0].title, action: 'create', duplicateOf: null, reason: null, testCase: { name: body.cases[0].title, properties: {}, testSteps: [
                { step: body.cases[0].steps[0], data: 'Precondition:\n- ' + body.cases[0].preconditions[0], result: '1. A\n2. B', position: 1 }] } },
              { index: 1, title: body.cases[1].title, action: 'skip_duplicate', duplicateOf: 'QA-900', reason: 'Judul sama dengan test case yang sudah ter-link: QA-900.', testCase: { name: body.cases[1].title, properties: {}, testSteps: [] } },
            ] } });
        }
        if (u.pathname === '/testcases' && req.method() === 'GET') {
          const issueKey = u.searchParams.get('issue');
          return route.fulfill({ json: { issueKey, projectKey: 'QA', history: issueKey === 'QA-123' ? history : [],
            existing: issueKey === 'QA-123' ? [{ key: 'QA-900', summary: XSS, status: 'To Do', linkType: 'QAlity Test' }] : [] } });
        }
        if (u.pathname === '/testcases/push') {
          const body = JSON.parse(req.postData() || '{}');
          pushBodies.push(body);
          if (pushMode === 'off') return route.fulfill({ status: 404, json: { error: 'Rute test case tidak dikenal.' } });
          const st0 = pushMode === 'partial' ? 'created_unlinked' : 'created_linked';
          const err0 = st0 === 'created_linked' ? null : 'Jira menolak link (HTTP 403). Klik Retry link.';
          const now = new Date().toISOString();
          history = [{ case_hash: 'h0', title: body.cases[0].title, test_key: 'QA-901', status: st0, error: err0, created_at: now, updated_at: now }];
          return route.fulfill({ json: { issueKey: body.issueKey, project: { key: 'QA', id: '10999' }, linkType: 'QAlity Test', unmappedKeys: [], history,
            counts: { [st0]: 1, skipped_duplicate: 1 },
            results: [{ index: 0, title: body.cases[0].title, caseHash: 'h0', status: st0, testKey: 'QA-901', error: err0 },
              { index: 1, title: body.cases[1].title, caseHash: 'h1', status: 'skipped_duplicate', testKey: 'QA-900', error: null }] } });
        }
        if (u.pathname === '/testcases/relink') {
          const body = JSON.parse(req.postData() || '{}');
          assert.deepEqual(body, { issueKey: 'QA-123', testKey: 'QA-901' });
          history = history.map(h => ({ ...h, status: 'created_linked', error: null }));
          return route.fulfill({ json: { issueKey: 'QA-123', testKey: 'QA-901', status: 'created_linked', error: null, history } });
        }
        if (u.pathname === '/me/qality') { qalityBodies.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ json: { ok: true, qality_tersimpan: true, qality_expires_at: exp } }); }
        return route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic', jira_site: 'https://jira.invalid', jira_tersimpan: true, qality_tersimpan: true, qality_expires_at: exp }
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
      assert.match(await panel.locator('.testcase-head .jira-key').textContent(), /^QA-123$/);
      // History dimuat saat panel dibuka: test case ter-link + belum ada push.
      const hist = panel.locator('.testcase-history');
      await hist.locator('a.jira-key', { hasText: 'QA-900' }).waitFor();
      assert.match(await hist.textContent(), /Belum ada push dari CATET untuk QA-123/);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-btn-tc1', 'History dimuat tanpa memindah fokus');

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
      assert.deepEqual(workerCalls.filter(c => /\/testcases/.test(c)), ['GET /testcases'], 'Parse/pratinjau tidak memanggil Worker; hanya History saat panel dibuka');

      // Dry run → rencana dari Worker: Create + Skip, baris QAlity persis, teks tetap teks.
      await panel.getByRole('button', { name: 'Dry run', exact: true }).click();
      await panel.locator('.testcase-plan').waitFor();
      assert.equal(previewBodies.length, 1);
      assert.equal(previewBodies[0].issueKey, 'QA-123');
      assert.deepEqual(previewBodies[0].cases.map(c => Object.keys(c).sort()), [['expected', 'preconditions', 'steps', 'title'], ['expected', 'preconditions', 'steps', 'title']], 'hanya 4 field yang dikirim');
      assert.deepEqual(previewBodies[0].cases.map(c => c.title), ['Verify Get Customer Profile Successfully', 'Check profile <img src=x onerror="window.__xss=1">']);
      const plan = panel.locator('.testcase-plan');
      assert.match(await plan.locator('.testcase-status.ok').textContent(), /1 test case akan dibuat di project QA dan di-link “QAlity Test” ke QA-123; 1 dilewati/);
      assert.deepEqual(await plan.locator('.testcase-badge').allTextContents(), ['Create', 'Skip']);
      assert.equal(await plan.locator('.testcase-step').count(), 1);
      assert.deepEqual(await plan.locator('.testcase-step .testcase-pre').allTextContents(),
        ['Send a GET request to `/customers/v2/profile` using a valid access token.', 'Precondition:\n- Customer has a valid access token (' + MARKER + ').', '1. A\n2. B']);
      assert.match(await plan.textContent(), /sudah ter-link: QA-900/);
      assert.match(await plan.textContent(), /Dry run tidak membuat apa pun/);
      assert.equal(await panel.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-dry-tc1', 'fokus kembali ke Dry run');
      assert.equal(await panel.getByRole('button', { name: 'Push 1 to QAlity', exact: true }).count(), 1, 'Push hanya muncul setelah dry run');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `testcase-${mode}-dryrun-${theme}.png`), fullPage: true });
      }
      // Pilihan berubah → hasil lama hilang; error Worker tampil sebagai Error.
      await cards.nth(1).getByRole('checkbox').click();
      assert.equal(await panel.locator('.testcase-plan').count(), 0, 'hasil dry run basi disembunyikan');
      previewMode = 'error';
      await panel.getByRole('button', { name: 'Dry run', exact: true }).click();
      await panel.locator('.testcase-dryrun .testcase-issues.err').waitFor();
      assert.match(await panel.locator('.testcase-dryrun .testcase-issues.err').textContent(), /Dry run gagal: Project QA belum aktif/);
      previewMode = 'ok';
      await cards.nth(1).getByRole('checkbox').click(); // kembali ke 2 case seperti sebelumnya

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

      // Tempelan banyak tiket di panel per task: hanya kelompok tiket task ini; tiket lain → info / error.
      const bundleCase = (n) => ({ id: 'TC-' + n, scenario_type: 'positive', title: 'Verify Bundle Case ' + n, precondition: 'Bundle precondition.', test_steps: ['Open bundle page ' + n + '.'], expected_result: ['Bundle page opens.'] });
      await page.locator('#tc-panel-tc1 textarea').fill(JSON.stringify([
        { task_id: 'qa-123', task_name: 'Synthetic ticket', test_cases: [bundleCase(1), bundleCase(2)] },
        { task_id: 'QA-555', task_name: 'Other synthetic ticket', test_cases: [bundleCase(3)] }]));
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-bundle-info').textContent(),
        'Tempelan berisi 2 tiket; panel ini memakai QA-123 (2 case). Tiket lain: QA-555 — pakai Jira → Test cases.');
      assert.deepEqual(await page.locator('#tc-panel-tc1 .testcase-card .testcase-title').allTextContents(), ['Verify Bundle Case 1', 'Verify Bundle Case 2']);
      assert.match(await page.locator('#tc-panel-tc1 .testcase-status.ok').textContent(), /2 case siap/);
      await page.locator('#tc-panel-tc1 textarea').fill(JSON.stringify([{ task_id: 'QA-555', test_cases: [bundleCase(3)] }]));
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-card').count(), 0);
      assert.equal(await page.locator('#tc-panel-tc1 .testcase-issues.err').textContent(), 'ErrorTempelan tidak berisi QA-123. Tiket di tempelan: QA-555.');

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
      // Di HP baris tugas jadi grid 2 kolom; panel harus selebar baris, bukan kolom ikon 44 px.
      assert(await page.evaluate(() => { const p = document.getElementById('tc-panel-tc1'); return p.getBoundingClientRect().width > 0.9 * p.parentElement.getBoundingClientRect().width; }),
        'panel Test cases selebar baris tugas di HP');

      // Clear (dengan konfirmasi) menghapus draft task itu saja.
      page.once('dialog', d => d.accept());
      await page.locator('#tc-panel-tc1').getByRole('button', { name: 'Clear', exact: true }).click();
      assert.equal(await page.locator('#tc-panel-tc1 textarea').inputValue(), '');
      const left = await draft();
      assert.equal(left.tc1, undefined);
      assert.match(left.tc3.text, /Verify Get Customer Profile/);

      // Push: konfirmasi wajib; flag mati → 404 jelas; push sebagian → Retry link
      // di History; push sukses → draft dibersihkan. Teks tetap teks.
      const tc1 = page.locator('#tc-panel-tc1');
      const siapPush = async () => {
        await tc1.locator('textarea').fill(SAMPLE);
        await tc1.getByRole('button', { name: 'Parse', exact: true }).click();
        await tc1.locator('.testcase-card').nth(2).getByRole('checkbox').click();
        await tc1.getByRole('button', { name: 'Dry run', exact: true }).click();
        await tc1.locator('.testcase-plan').waitFor();
      };
      await siapPush();
      const pushBtn = tc1.getByRole('button', { name: 'Push 1 to QAlity', exact: true });
      page.once('dialog', d => { assert.match(d.message(), /Buat 1 test case di QAlity \(project QA\) lalu link “QAlity Test” ke QA-123/); d.dismiss(); });
      await pushBtn.click();
      assert.equal(pushBodies.length, 0, 'batal konfirmasi = tidak ada push');
      pushMode = 'off';
      page.once('dialog', d => d.accept());
      await pushBtn.click();
      await tc1.locator('.testcase-pushres .testcase-issues.err').waitFor();
      assert.match(await tc1.locator('.testcase-pushres').textContent(), /Push belum diaktifkan di Worker/);
      assert.deepEqual(pushBodies[0], { issueKey: 'QA-123', previewHash: 'f'.repeat(64), cases: previewBodies.at(-1).cases }, 'push mengirim isi + hash dry run');
      pushMode = 'partial';
      page.once('dialog', d => d.accept());
      await pushBtn.click();
      await tc1.locator('.testcase-pushres .testcase-rows').waitFor();
      const res = tc1.locator('.testcase-pushres');
      assert.match(await res.locator('.testcase-status').textContent(), /Push selesai — 1 unlinked, 1 skipped\. Draft disimpan/);
      assert.deepEqual(await res.locator('.testcase-badge').allTextContents(), ['Unlinked', 'Skipped']);
      assert.deepEqual(await res.locator('a.jira-key').allTextContents(), ['QA-901', 'QA-900']);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tc-pushres-tc1', 'fokus ke hasil push');
      assert.match((await draft()).tc1.text, /Verify Get Customer Profile/, 'push sebagian: draft tetap');
      assert.equal(await tc1.locator('.testcase-plan').count(), 0, 'rencana lama dibuang setelah push');
      const retry = tc1.locator('.testcase-history').getByRole('button', { name: 'Retry link', exact: true });
      await retry.waitFor();
      assert.equal(await tc1.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await tc1.screenshot({ path: path.join(out, `testcase-${mode}-push-${theme}.png`) });
      }
      await retry.click();
      await tc1.locator('.testcase-history .testcase-badge', { hasText: /^Linked$/ }).waitFor();
      assert.equal(await tc1.locator('.testcase-history').getByRole('button', { name: 'Retry link' }).count(), 0);
      pushMode = 'ok';
      await tc1.getByRole('button', { name: 'Dry run', exact: true }).click();
      await tc1.locator('.testcase-plan').waitFor();
      page.once('dialog', d => d.accept());
      await tc1.getByRole('button', { name: 'Push 1 to QAlity', exact: true }).click();
      await tc1.locator('.testcase-pushres .testcase-status.ok').waitFor();
      assert.match(await tc1.locator('.testcase-pushres .testcase-status').textContent(), /1 linked, 1 skipped\. Draft dibersihkan/);
      assert.equal(await tc1.locator('textarea').inputValue(), '', 'push sukses membersihkan draft');
      assert.equal((await draft()).tc1, undefined);
      assert.equal(await tc1.locator('.testcase-card').count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'hasil push + History muat di HP');

      // Settings → Account: status token + peringatan 14 hari; Save mengirim token + tanggal.
      await page.locator('#settings-btn').click();
      await page.locator('summary', { hasText: 'account settings' }).click();
      const qs = page.locator('.qality-settings');
      await qs.waitFor();
      assert.match(await qs.locator('.qality-warn').textContent(), /kedaluwarsa dalam 10 hari/);
      await qs.getByLabel('QAlity API token').fill('synthetic-qality-token-0123456789');
      page.once('dialog', d => d.accept());
      await qs.getByRole('button', { name: 'Update', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.qality-settings button[disabled]'));
      assert.deepEqual(qalityBodies, [{ token: 'synthetic-qality-token-0123456789', expiresAt: exp }]);
      assert(!(await page.content()).includes('synthetic-qality-token-0123456789'), 'token tidak tertinggal di DOM');

      // Write hanya lewat Worker mock dan hanya setelah konfirmasi; draft tidak ikut state.
      const n = (re) => workerCalls.filter(c => re.test(c)).length;
      assert.equal(n(/^POST \/testcases\/push$/), 3, 'tiga push dikonfirmasi (off, partial, ok)');
      assert.equal(n(/^POST \/testcases\/relink$/), 1);
      assert.equal(n(/^POST \/testcases\/preview$/), 4);
      assert.deepEqual(blocked, [], 'tidak ada request ke host lain (Jira/QAlity)');
      assert(!stateBodies.some(b => b.includes(MARKER)), 'draft tidak ikut /state');
      assert(await page.evaluate(m => ['catet.tasks.v1', 'catet.jira.v1'].every(k => !(localStorage.getItem(k) || '').includes(m)), MARKER));
      assert.deepEqual(errors, []);
      // Console error yang diizinkan: 400 dry run error + 404 push flag mati (disengaja).
      const expected = /Failed to load resource: the server responded with a status of (400|404)/;
      assert.equal(consoleErrors.filter(m => expected.test(m)).length, 2);
      assert.deepEqual(consoleErrors.filter(m => !expected.test(m)), []);
      console.log(`PASS ${mode}: toggle/history/parse/preview/error+warning/XSS-safe/uncheck/dry run plan+error/draft/reload/batch 21/rusak/focus card/mobile/clear/push cancel+off+partial+retry link+ok/QAlity token settings, no console errors`);
      await context.close();
    }
    console.log('Screenshots: ' + out);
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
