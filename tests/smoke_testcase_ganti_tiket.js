// Synthetic fixtures; Worker di-mock dan semua request lain diblokir (tidak ada
// request ke Jira/QAlity). Ganti tiket tujuan test case: AI memberi key tiket dev
// → Change ticket di mode banyak tiket (validasi, ganda, Escape, Enter, datalist
// task) → task_id di teks + draft ikut diganti, centang tetap, Dry run memakai
// tiket baru, Actual result GAP ikut pindah; panel 🧪 → "Use … for …".
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.TESTCASE_TICKET_SMOKE_OUTPUT || path.join(process.env.TMPDIR || root, 'catet-testcase-ticket-screens');
const PORT = 18888;
const wait = ms => new Promise(r => setTimeout(r, ms));
const kasus = (n, title) => ({ id: 'TC-0' + n, scenario_type: 'positive', title, precondition: ['Example precondition ' + n + '.'],
  test_steps: ['Send an example request ' + n + '.'], expected_result: ['Example response ' + n + '.'] });
const SAMPLE = '```json\n' + JSON.stringify([
  { task_id: 'ABC-301', task_name: 'Example Profile', endpoint: 'GET /example/profile',
    test_cases: [kasus(1, 'Verify Example Profile'), kasus(2, 'Verify Example Profile Empty'), kasus(3, 'GAP: Example email is not masked')] },
  { task_id: 'ABC-303', task_name: 'Example Order', test_cases: [kasus(4, 'Verify Example Order')] },
], null, 2) + '\n```';
const SUMMARY = { 'ABC-301': 'Example Profile', 'ABC-302': 'Testing Example Profile', 'ABC-303': 'Example Order', 'ABC-304': 'Testing Example Order' };
const gapKey = (key, title) => key + '|' + title.replace(/\s+/g, ' ').trim().toLowerCase();
const GAP = 'GAP: Example email is not masked';

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; ; i++) { try { assert((await fetch('http://127.0.0.1:' + PORT)).ok); break; } catch { assert(i < 50); await wait(100); } }
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    for (const mode of ['http', 'file']) {
      for (const scheme of ['light', 'dark']) {
        if (mode === 'file' && scheme === 'dark') continue;
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', colorScheme: scheme });
        const page = await context.newPage();
        const errors = [], consoleErrors = [], blocked = [], previewBodies = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        await page.addInitScript(() => {
          if (sessionStorage.getItem('ticket-seed')) return;
          const now = new Date().toISOString();
          localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: [] }));
          localStorage.setItem('catet.tasks.v1', JSON.stringify([
            { id: 'q1', text: 'ABC-302 — Testing Example Profile', status: 'aktif', priority: 'urgent', createdAt: now },
            { id: 'q2', text: 'ABC-304 — Testing Example Order', status: 'aktif', priority: 'urgent', createdAt: now },
            { id: 'q3', text: 'ABC-399 — Old finished ticket', status: 'selesai', priority: 'rendah', createdAt: now, doneAt: now },
          ]));
          localStorage.setItem('catet.worklog.v1', '[]');
          sessionStorage.setItem('ticket-seed', '1');
        });
        await page.route('**/*', async route => {
          const req = route.request(), u = new URL(req.url());
          if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:' + PORT) return route.continue();
          if (u.hostname !== 'synthetic.invalid') { blocked.push(u.hostname); return route.abort(); }
          if (u.pathname === '/testcases/preview') {
            const body = JSON.parse(req.postData() || '{}');
            previewBodies.push(body);
            return route.fulfill({ json: {
              issueKey: body.issueKey, issueSummary: SUMMARY[body.issueKey], project: { key: 'ABC', id: '10999' }, linkType: 'QAlity Test',
              existing: [], counts: { create: body.cases.length, skip: 0 }, previewHash: body.issueKey.slice(-1).repeat(64),
              plan: body.cases.map((c, i) => ({ index: i, title: c.title, action: 'create', duplicateOf: null, reason: null,
                testCase: { name: c.title, properties: {}, testSteps: [{ step: c.steps[0], data: '', result: '1. ' + c.expected[0], position: 1 }] } })),
            } });
          }
          if (u.pathname === '/testcases' && req.method() === 'GET') {
            const issueKey = u.searchParams.get('issue');
            return route.fulfill({ json: { issueKey, issueSummary: SUMMARY[issueKey], projectKey: 'ABC', existing: [], history: [] } });
          }
          return route.fulfill({ json: u.pathname === '/me' ? { name: 'Synthetic', jira_site: 'https://jira.invalid', jira_tersimpan: true, qality_tersimpan: true }
            : u.pathname === '/state' ? { stores: null, updatedAt: null } : { items: [], events: [], days: {}, summaries: {} } });
        });
        await page.goto(mode === 'http' ? 'http://127.0.0.1:' + PORT : pathToFileURL(path.join(root, 'index.html')).href);
        await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
        await page.locator('#tab-jira').click();
        await page.getByRole('button', { name: 'Test cases', exact: true }).click();
        const sec = page.locator('#tcb');
        await sec.waitFor();
        const keys = () => sec.locator('.testcase-group-head .jira-key').allTextContents();

        await sec.locator('#tcb-input').fill(SAMPLE);
        await sec.getByRole('button', { name: 'Parse', exact: true }).click();
        assert.deepEqual(await keys(), ['ABC-301', 'ABC-303']);
        // Hapus centang case #2 tiket pertama — harus tetap setelah ganti tiket.
        await sec.locator('#tcb-group-0 .testcase-card-head input').nth(1).uncheck();
        await sec.locator('#tcb-group-0 textarea.gap-actual').fill('Email is returned in plain text.');

        // Klik tombol di dalam <label> tidak ikut mencentang/menghapus centang tiket.
        await sec.locator('#tcb-ubah-0').click();
        assert.equal(await sec.locator('#tcb-tiket-0').isChecked(), true, 'checkbox tiket tidak berubah');
        const inp = sec.locator('#tcb-key-0');
        assert.equal(await inp.evaluate(n => n === document.activeElement), true, 'fokus ke isian tiket');
        assert.equal(await inp.inputValue(), 'ABC-301');
        assert.deepEqual(await sec.locator('#tcb-keys-0 option').evaluateAll(o => o.map(x => x.value)), ['ABC-302', 'ABC-304'], 'datalist = task aktif bertiket');

        // Validasi: bukan key, key ganda, Escape membatalkan.
        await inp.fill('profile');
        await sec.locator('#tcb-key-ok-0').click();
        assert.match(await sec.locator('#tcb-group-0 .testcase-ticket-edit .testcase-issues').innerText(), /bukan key tiket Jira/);
        assert.equal(await sec.locator('#tcb-key-0').inputValue(), 'profile', 'isian tidak hilang setelah error');
        await sec.locator('#tcb-key-0').fill('abc-303');
        await sec.locator('#tcb-key-0').press('Enter');
        assert.match(await sec.locator('#tcb-group-0 .testcase-ticket-edit .testcase-issues').innerText(), /ABC-303 sudah ada di tempelan/);
        await sec.locator('#tcb-key-0').press('Escape');
        assert.equal(await sec.locator('#tcb-key-0').count(), 0);
        assert.equal(await sec.locator('#tcb-ubah-0').evaluate(n => n === document.activeElement), true, 'fokus kembali ke tombol');
        assert.deepEqual(await keys(), ['ABC-301', 'ABC-303']);

        // Teks diedit tanpa Parse → tidak ditimpa.
        await sec.locator('#tcb-input').fill(SAMPLE + '\n');
        await sec.locator('#tcb-ubah-0').click();
        await sec.locator('#tcb-key-0').fill('ABC-302');
        await sec.locator('#tcb-key-ok-0').click();
        assert.match(await sec.locator('#tcb-group-0 .testcase-ticket-edit .testcase-issues').innerText(), /klik Parse dulu/);
        await sec.locator('#tcb-key-0').press('Escape');
        await sec.locator('#tcb-input').fill(SAMPLE);

        // Berhasil: task_id + draft diganti, centang tetap, Actual result GAP ikut pindah.
        await sec.locator('#tcb-ubah-0').click();
        await sec.locator('#tcb-key-0').fill('abc-302');
        if (scheme === 'light' && mode === 'http') await sec.locator('#tcb-group-0').screenshot({ path: path.join(out, 'ticket-edit-' + scheme + '.png') });
        await sec.locator('#tcb-key-0').press('Enter');
        assert.deepEqual(await keys(), ['ABC-302', 'ABC-303']);
        assert.equal(await sec.locator('#tcb-ubah-0').evaluate(n => n === document.activeElement), true);
        const teks = await sec.locator('#tcb-input').inputValue();
        assert.doesNotMatch(teks, /```/);
        assert.deepEqual(JSON.parse(teks).map(x => x.task_id), ['ABC-302', 'ABC-303']);
        const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.testcaseBulkDraft.v1')).text);
        assert.equal(draft, teks, 'draft = teks baru');
        assert.equal(await sec.locator('#tcb-input + .testcase-stale').isHidden(), true, 'tidak dianggap basi');
        assert.deepEqual(await sec.locator('#tcb-group-0 .testcase-card-head input').evaluateAll(n => n.map(x => x.checked)), [true, false], 'centang case tetap');
        assert.equal(await sec.locator('#tcb-group-0 textarea.gap-actual').inputValue(), 'Email is returned in plain text.', 'Actual result ikut pindah');
        const bugDrafts = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.bugDrafts.v1')));
        assert.deepEqual(Object.keys(bugDrafts), [gapKey('ABC-302', GAP)]);

        // Dry run all memakai tiket baru; prefix = judul tiket baru.
        await sec.locator('#tcb-dry').click();
        await sec.locator('#tcb-push').waitFor();
        assert.deepEqual(previewBodies.map(b => [b.issueKey, b.cases.length]), [['ABC-302', 1], ['ABC-303', 1]]);
        assert.equal(previewBodies[0].cases[0].title, 'Testing Example Profile - Verify Example Profile');
        assert.match(await sec.locator('#tcb-group-0 .testcase-jira-title').innerText(), /Testing Example Profile/);
        assert.equal(await sec.locator('#tcb-group-0 .testcase-jira-title .testcase-issues').count(), 0, 'judul "Testing …" masih mirip task_name');
        await sec.screenshot({ path: path.join(out, 'ticket-bulk-' + mode + '-' + scheme + '.png') });
        for (const width of [375, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await sec.locator('#tcb-ubah-1').click();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `isian tiket muat ${width}px`);
          if (width === 375 && mode === 'http') await sec.locator('#tcb-group-1').screenshot({ path: path.join(out, 'ticket-edit-mobile-' + scheme + '.png') });
          await sec.locator('#tcb-key-1').press('Escape');
        }
        await page.setViewportSize({ width: 1280, height: 900 });

        // Panel 🧪 task ABC-304: tempelan hanya berisi ABC-303 → "Use ABC-303 for ABC-304".
        if (scheme === 'light') {
          await page.locator('#tab-papan').click();
          await page.locator('#tc-btn-q2').click();
          const panel = page.locator('#tc-panel-q2');
          await panel.locator('#tc-input-q2').fill(JSON.stringify([JSON.parse(teks)[1]]));
          await panel.getByRole('button', { name: 'Parse', exact: true }).click();
          assert.match(await panel.locator('.testcase-issues.err').innerText(), /tidak berisi ABC-304/);
          assert.equal(await panel.locator('#tc-dry-q2').count(), 0);
          await panel.getByRole('button', { name: 'Use ABC-303 for ABC-304', exact: true }).click();
          assert.equal(await panel.locator('.testcase-issues.err').count(), 0);
          assert.equal(await panel.locator('#tc-dry-q2').count(), 1, 'Dry run muncul setelah pindah');
          assert.equal(JSON.parse(await panel.locator('#tc-input-q2').inputValue())[0].task_id, 'ABC-304');
          assert.match(await panel.locator('.testcase-bundle-info').textContent(), /memakai ABC-304 \(1 case\)/);
        }

        assert.deepEqual(errors, []);
        assert.deepEqual(consoleErrors.filter(m => !/Failed to load resource/.test(m)), []);
        assert.deepEqual(blocked.filter(h => h !== 'fonts.googleapis.com' && h !== 'fonts.gstatic.com'), []);
        await context.close();
      }
    }
    console.log('PASS smoke testcase ganti tiket (http + file, terang + gelap): Change ticket, validasi, ganda, basi, Escape/Enter, datalist, draft, centang, Actual GAP pindah, Dry run tiket baru, HP, panel 🧪 — screenshots ' + out);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
