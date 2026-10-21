// Synthetic fixtures; Worker di-mock dan semua request lain diblokir (tidak ada
// request ke Jira/QAlity). Tab Jira → Test cases: tempel JSON banyak tiket →
// Parse per tiket → Dry run all (berurutan, satu tiket 400, satu judul beda) →
// Push all (satu konfirmasi, previewHash per tiket, berhenti setelah failed,
// sisanya Not tried) → Retry link → putaran kedua sukses membersihkan draft.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.TESTCASE_BULK_SMOKE_OUTPUT || path.join(process.env.TMPDIR || root, 'catet-testcase-bulk-screens');
const PORT = 18886;
const wait = ms => new Promise(r => setTimeout(r, ms));
const MARKER = 'SYNTH-BULK-MARKER';
const XSS = 'Verify <img src=x onerror="window.__xss=1"> example title';
const kasus = (n, title, extra = {}) => ({ id: 'TC-00' + n, scenario_type: 'positive', title,
  precondition: 'Example precondition ' + n + '.', test_steps: ['Send an example request ' + n + '.'], expected_result: ['Example response ' + n + '.'], ...extra });
const ROUND1 = [
  { task_id: 'ABC-201', task_name: 'Example Profile Endpoint', endpoint: 'GET /example/profile', test_cases: [
    kasus(1, 'Verify Example Profile Success', { precondition: 'Example user exists (' + MARKER + ').' }), kasus(2, XSS), kasus(3, 'Verify Example Profile Third')] },
  { task_id: 'xyz-202', task_name: 'Example Inactive Project', test_cases: [kasus(4, 'Verify Example Inactive')] },
  { task_id: 'ABC-203', task_name: 'Example Order Endpoint', test_cases: [kasus(5, 'Verify Example Order')] },
  { task_id: 'ABC-204', task_name: 'Example Invoice Endpoint', test_cases: [kasus(6, 'Verify Example Invoice A'), kasus(7, 'Verify Example Invoice B')] },
];
const SAMPLE = '```json\n' + JSON.stringify(ROUND1, null, 2) + '\n```';
const ROUND2 = JSON.stringify([ROUND1[2], ROUND1[3]], null, 2);
const ELEVEN = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ task_id: 'ABC-' + (301 + i), test_cases: [kasus(1, 'Verify Example ' + i)] })));
const SUMMARY = { 'ABC-201': '[BE] Example profile endpoint', 'ABC-203': 'Completely different synthetic title', 'ABC-204': 'Example Invoice Endpoint' };

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
      const errors = [], consoleErrors = [], workerCalls = [], blocked = [], stateBodies = [], previewBodies = [], pushBodies = [], relinkBodies = [];
      let hold = null, release = null, round = 1;
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      await page.addInitScript(() => {
        if (sessionStorage.getItem('tcb-seed')) return;
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: [] }));
        localStorage.setItem('catet.tasks.v1', '[]');
        localStorage.setItem('catet.worklog.v1', '[]');
        sessionStorage.setItem('tcb-seed', '1');
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
          if (hold && body.issueKey === hold) await new Promise(r => { release = r; });
          if (body.issueKey === 'XYZ-202') return route.fulfill({ status: 400, json: { error: 'Project XYZ belum aktif di QAlity untuk akunmu, jadi belum didukung. Project aktif: ABC.' } });
          return route.fulfill({ json: {
            issueKey: body.issueKey, issueSummary: SUMMARY[body.issueKey], project: { key: 'ABC', id: '10999' }, linkType: 'QAlity Test', existing: [],
            counts: { create: body.cases.length, skip: 0 }, previewHash: body.issueKey.slice(-1).repeat(64),
            plan: body.cases.map((c, i) => ({ index: i, title: c.title, action: 'create', duplicateOf: null, reason: null,
              testCase: { name: c.title, properties: {}, testSteps: [{ step: c.steps[0], data: '', result: '1. ' + c.expected[0], position: 1 }] } })),
          } });
        }
        if (u.pathname === '/testcases/push') {
          const body = JSON.parse(req.postData() || '{}');
          pushBodies.push(body);
          const st = (i) => round === 2 ? 'created_linked' : body.issueKey === 'ABC-203' ? 'failed' : i === 1 ? 'created_unlinked' : 'created_linked';
          const results = body.cases.map((c, i) => ({ index: i, title: c.title, caseHash: 'h' + i, status: st(i),
            testKey: st(i) === 'failed' ? null : body.issueKey.replace(/\d+$/, n => String(Number(n) + 700 + i)),
            error: st(i) === 'failed' ? 'QAlity menolak (HTTP 400).' : st(i) === 'created_unlinked' ? 'Jira menolak link (HTTP 403). Klik Retry link.' : null }));
          const counts = {};
          for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
          return route.fulfill({ json: { issueKey: body.issueKey, project: { key: 'ABC', id: '10999' }, linkType: 'QAlity Test', results, counts, unmappedKeys: [], history: [] } });
        }
        if (u.pathname === '/testcases/relink') {
          relinkBodies.push(JSON.parse(req.postData() || '{}'));
          return route.fulfill({ json: { issueKey: 'ABC-201', testKey: 'ABC-902', status: 'created_linked', error: null, history: [] } });
        }
        return route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic', jira_site: 'https://jira.invalid', jira_tersimpan: true, qality_tersimpan: true }
          : u.pathname === '/state' ? { stores: null, updatedAt: null } : { items: [], events: [], days: {}, summaries: {} } });
      });
      const open = async () => {
        await page.goto(mode === 'http' ? 'http://127.0.0.1:' + PORT : pathToFileURL(path.join(root, 'index.html')).href);
        await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
        await page.locator('#tab-jira').click();
        const chip = page.getByRole('button', { name: 'Test cases', exact: true });
        assert.equal(await chip.getAttribute('id'), 'jira-filter-testcases');
        await chip.click();
        await page.locator('#tcb').waitFor();
        assert.equal(await chip.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#jira-filter-inbox').getAttribute('aria-pressed'), 'false');
      };
      const sec = page.locator('#tcb');
      const groups = sec.locator('.testcase-group');
      const group = key => groups.filter({ has: page.locator('.testcase-group-head .jira-key', { hasText: new RegExp('^' + key + '$') }) });
      const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem('catet.testcaseBulkDraft.v1') || 'null'));

      await open();
      assert.equal(await page.locator('#jira-filter-missing-worklog').count(), 1, 'chip lama tetap ada');
      // Parse: kelompok per tiket, key di-uppercase, teks pengguna tetap teks.
      await sec.locator('#tcb-input').fill(SAMPLE);
      assert.equal((await draft()).text, SAMPLE, 'draft disimpan saat mengetik');
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();
      assert.equal(await groups.count(), 4);
      assert.deepEqual(await sec.locator('.testcase-group-head .jira-key').allTextContents(), ['ABC-201', 'XYZ-202', 'ABC-203', 'ABC-204']);
      assert.deepEqual(await sec.locator('.testcase-preview > .testcase-summary .testcase-chip').allTextContents(), ['4 tickets', '4 selected', '0 blocked']);
      assert.equal(await group('ABC-201').locator('.testcase-card').count(), 3);
      assert.match(await group('ABC-201').textContent(), /GET \/example\/profile/);
      assert.equal(await sec.locator('img').count(), 0, 'judul berisi tag HTML tetap teks');
      assert.match(await group('ABC-201').locator('.testcase-card .testcase-title').nth(1).textContent(), /<img src=x/);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await sec.locator('.testcase-issues.warn', { hasText: /scenario_type|“id”/ }).count(), 0, 'K3: id/scenario_type tanpa warning');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tcb-parse');

      // Draft bertahan setelah reload; pratinjau tidak dipersist.
      await page.reload();
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
      await page.locator('#tab-jira').click();
      await page.locator('#jira-filter-testcases').click();
      assert.equal(await sec.locator('#tcb-input').inputValue(), SAMPLE, 'draft bertahan setelah reload');
      assert.equal(await groups.count(), 0);
      // Render berkala (mis. sinkron Jira) tidak membuang fokus/kursor textarea.
      await page.evaluate(() => { const t = document.getElementById('tcb-input'); t.focus(); t.setSelectionRange(5, 9); render(); });
      assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['tcb-input', 5, 9]);
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();

      // Lepas satu case: hanya tiket itu yang berubah.
      await group('ABC-201').locator('.testcase-card').nth(2).getByRole('checkbox').click();
      assert.deepEqual(await group('ABC-201').locator('.testcase-summary .testcase-chip').allTextContents(), ['3 cases', '2 selected', '0 errors', '0 warnings']);
      assert.match(await sec.locator('.testcase-preview > .testcase-status').textContent(), /4 tiket siap \(6 case\)/);
      assert.deepEqual(workerCalls.filter(c => /\/testcases/.test(c)), [], 'Parse/pratinjau tidak memanggil Worker');

      // Dry run all: berurutan, progres terlihat, fokus tetap di tombol.
      hold = 'XYZ-202';
      await sec.locator('#tcb-dry').click();
      for (let i = 0; !release; i++) { assert(i < 200); await wait(10); }
      assert.match(await sec.locator('.testcase-progress').textContent(), /^Checking 2\/4 — XYZ-202…$/);
      assert.equal(await sec.locator('#tcb-dry').textContent(), 'Checking…');
      assert.equal(await sec.locator('#tcb-dry').getAttribute('aria-disabled'), 'true');
      assert.equal(await sec.locator('#tcb-parse').isDisabled(), true, 'Parse terkunci selama berjalan');
      assert.equal(previewBodies.length, 2, 'tiket berikutnya menunggu tiket sebelumnya');
      hold = null; release();
      await sec.locator('.testcase-progress').waitFor({ state: 'detached' });
      assert.deepEqual(previewBodies.map(b => [b.issueKey, b.cases.length]), [['ABC-201', 2], ['XYZ-202', 1], ['ABC-203', 1], ['ABC-204', 2]]);
      assert.deepEqual(previewBodies[0].cases.map(c => Object.keys(c).sort()), [['expected', 'preconditions', 'steps', 'title'], ['expected', 'preconditions', 'steps', 'title']], 'id/scenario_type tidak dikirim');
      assert.deepEqual(previewBodies[0].cases.map(c => c.title), ['Verify Example Profile Success', XSS]);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tcb-dry', 'fokus tetap di Dry run all');
      // Hasil per tiket: OK + judul Jira (prefiks [BE] tetap dianggap sama); 400 hanya menahan tiket itu; judul beda → warning.
      assert.match(await group('ABC-201').locator('.testcase-plan .testcase-status.ok').textContent(), /2 test case akan dibuat di project ABC/);
      assert.match(await group('ABC-201').locator('.testcase-jira-title').textContent(), /Judul Jira: \[BE\] Example profile endpoint/);
      assert.equal(await group('ABC-201').locator('.testcase-jira-title .testcase-issues.warn').count(), 0);
      assert.match(await group('XYZ-202').locator('.testcase-issues.err').textContent(), /Dry run gagal: Project XYZ belum aktif/);
      assert.equal(await group('XYZ-202').locator('.testcase-plan').count(), 0);
      assert.match(await group('ABC-203').locator('.testcase-jira-title .testcase-issues.warn').textContent(), /beda dengan task_name dari AI \(“Example Order Endpoint”\)/);
      assert.equal(await group('ABC-203').locator('.testcase-plan').count(), 1, 'warning judul tidak memblokir');
      assert.equal(await sec.locator('.testcase-group .testcase-plan button').count(), 0, 'rencana per tiket tanpa tombol Push sendiri');
      assert.equal(await sec.locator('img').count(), 0);
      assert.match(await sec.textContent(), /Siap push: ABC-201 \(2 case\), ABC-203 \(1 case\), ABC-204 \(2 case\)\./);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `bulk-${mode}-dryrun-${theme}.png`), fullPage: true });
      }

      // Centang berubah → Dry run tiket itu basi (tiket lain tetap); kembali → berlaku lagi.
      await group('ABC-201').locator('.testcase-card').nth(1).getByRole('checkbox').click();
      assert.equal(await group('ABC-201').locator('.testcase-plan').count(), 0, 'hasil basi disembunyikan');
      assert.match(await sec.textContent(), /Siap push: ABC-203 \(1 case\), ABC-204 \(2 case\)\./);
      await group('ABC-201').locator('.testcase-card').nth(1).getByRole('checkbox').click();
      assert.equal(await group('ABC-201').locator('.testcase-plan').count(), 1);

      // Push all: satu konfirmasi berisi daftar + yang tidak ikut; batal = tanpa request.
      let message = '';
      page.once('dialog', d => { message = d.message(); d.dismiss(); });
      await sec.locator('#tcb-push').click();
      assert.match(message, /^Buat 5 test case di QAlity/);
      assert.match(message, /ABC-201: 2 case \(project ABC\)\nABC-203: 1 case \(project ABC\)\nABC-204: 2 case \(project ABC\)/);
      assert.match(message, /Tidak ikut:\nXYZ-202: Dry run gagal/);
      assert.equal(pushBodies.length, 0, 'batal konfirmasi = tidak ada push');
      page.once('dialog', d => d.accept());
      await sec.locator('#tcb-push').click();
      await sec.locator('#tcb-pushres .testcase-status').waitFor();
      // Urutan + previewHash per tiket; ABC-203 failed → ABC-204 tidak dikirim.
      assert.deepEqual(pushBodies.map(b => [b.issueKey, b.previewHash]), [['ABC-201', '1'.repeat(64)], ['ABC-203', '3'.repeat(64)]]);
      assert.deepEqual(pushBodies[0].cases, previewBodies[0].cases, 'push mengirim isi persis dry run tiket itu');
      assert.deepEqual(pushBodies[1].cases, previewBodies[2].cases);
      const res = sec.locator('#tcb-pushres');
      assert.match(await res.locator('.testcase-status').first().textContent(), /Push selesai — 0 tiket beres, 2 bermasalah, 1 tidak dicoba\. Draft disimpan/);
      assert.deepEqual(await res.locator('.testcase-push-ticket > .testcase-plan-head .testcase-badge').allTextContents(), ['Check', 'Failed', 'Not tried']);
      assert.deepEqual(await res.locator('.testcase-push-ticket > .testcase-plan-head .jira-key').allTextContents(), ['ABC-201', 'ABC-203', 'ABC-204']);
      assert.deepEqual(await res.locator('.testcase-push-ticket').nth(0).locator('.testcase-row .testcase-badge').allTextContents(), ['Linked', 'Unlinked']);
      assert.match(await res.locator('.testcase-push-ticket').nth(1).textContent(), /QAlity menolak \(HTTP 400\)/);
      assert.match(await res.locator('.testcase-push-ticket').nth(2).textContent(), /Tidak dicoba — Push all berhenti setelah ABC-203/);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tcb-pushres', 'fokus ke hasil push');
      assert.equal((await draft()).text, SAMPLE, 'push sebagian: draft tetap');
      assert.equal(await group('ABC-201').locator('.testcase-plan').count(), 0, 'rencana yang sudah dipush dibuang');
      assert.equal(await group('ABC-204').locator('.testcase-plan').count(), 1, 'Dry run tiket Not tried tetap berlaku');
      assert.equal(await sec.locator('img').count(), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await res.screenshot({ path: path.join(out, `bulk-${mode}-push-${theme}.png`) });
      }

      // Retry link di baris Unlinked (tiket belum tentu ada sebagai task CATET).
      await res.getByRole('button', { name: 'Retry link', exact: true }).click();
      await res.locator('.testcase-push-ticket').nth(0).locator('.testcase-plan-head .testcase-badge', { hasText: /^Done$/ }).waitFor();
      assert.deepEqual(relinkBodies, [{ issueKey: 'ABC-201', testKey: 'ABC-902' }]);
      assert.equal(await res.getByRole('button', { name: 'Retry link' }).count(), 0);

      // Lebih dari 10 tiket → error tempelan, tanpa Dry run all.
      await sec.locator('#tcb-input').fill(ELEVEN);
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();
      assert.match(await sec.locator('.testcase-preview > .testcase-issues.err').textContent(), /11 tiket dicentang; maksimal 10/);
      assert.equal(await sec.locator('#tcb-dry').count(), 0);
      assert.equal(await sec.locator('#tcb-pushres').count(), 0, 'tempelan baru → hasil push lama tidak ditampilkan');
      await sec.locator('#tcb-tiket-10').click();
      assert.equal(await sec.locator('#tcb-dry').count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tcb-tiket-10');

      // Putaran kedua: semua tiket di tempelan beres → draft dibersihkan.
      round = 2;
      await sec.locator('#tcb-input').fill(ROUND2);
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();
      await sec.locator('#tcb-dry').click();
      await group('ABC-204').locator('.testcase-plan').waitFor();
      await sec.locator('.testcase-progress').waitFor({ state: 'detached' });
      page.once('dialog', d => d.accept());
      await sec.locator('#tcb-push').click();
      await sec.locator('#tcb-pushres .testcase-status.ok').waitFor();
      assert.match(await sec.locator('#tcb-pushres .testcase-status').textContent(), /2 tiket beres\. Semua tiket beres — draft dibersihkan/);
      assert.equal(await sec.locator('#tcb-input').inputValue(), '');
      assert.equal(await draft(), null);
      assert.equal(await groups.count(), 0);
      assert.deepEqual(pushBodies.slice(2).map(b => b.issueKey), ['ABC-203', 'ABC-204']);
      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `fits ${width}px`);
      }
      await sec.locator('#tcb-input').fill(SAMPLE);
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'groups fit on phone');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await page.screenshot({ path: path.join(out, `bulk-${mode}-mobile-${theme}.png`), fullPage: true });
      }

      // Ganti akun → state banyak tiket direset; sign out → draft dihapus.
      await page.evaluate(() => pakaiKode('another-code'));
      assert.equal(await page.locator('#jira-filter-inbox').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => testcaseBulk), null);
      await page.evaluate(() => { kosongkanDataLokalTanpaAkses(); });
      assert.equal(await draft(), null, 'draft banyak tiket dihapus saat data akun dikosongkan');

      const n = re => workerCalls.filter(c => re.test(c)).length;
      assert.equal(n(/^POST \/testcases\/preview$/), 6);
      assert.equal(n(/^POST \/testcases\/push$/), 4);
      assert.equal(n(/^POST \/testcases\/relink$/), 1);
      assert.equal(n(/^GET \/testcases$/), 0, 'mode banyak tiket tidak memuat History per tiket');
      assert.deepEqual(blocked, [], 'tidak ada request ke host lain (Jira/QAlity)');
      assert(!stateBodies.some(b => b.includes(MARKER)), 'draft tidak ikut /state');
      assert.deepEqual(errors, []);
      // Console error yang diizinkan: 400 dry run XYZ-202 (disengaja).
      const expected = /Failed to load resource: the server responded with a status of 400/;
      assert.equal(consoleErrors.filter(m => expected.test(m)).length, 1);
      assert.deepEqual(consoleErrors.filter(m => !expected.test(m)), []);
      console.log(`PASS ${mode}: chip/parse/K3/XSS-safe/draft reload/uncheck/dry run all sequential+progress+400+title mismatch/stale sig/push all confirm+order+hash+stop rule+Not tried/retry link/11 tickets/round 2 clears draft/mobile/account reset, no console errors`);
      await context.close();
    }
    console.log('Screenshots: ' + out);
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
