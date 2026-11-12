// Synthetic fixtures; Worker di-mock dan semua request lain diblokir (tidak ada
// request ke Jira). GAP findings → tiket Bug: Parse memisah case GAP dari test
// case (tiket tidak tertahan) → Actual result wajib → Dry run bug (isi persis
// yang dikirim) → Actual diedit = rencana disembunyikan → Create bug (konfirmasi,
// previewHash) → draft dibersihkan; Unlinked → Retry link; flag mati; panel 🧪.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.TESTCASE_GAP_SMOKE_OUTPUT || path.join(process.env.TMPDIR || root, 'catet-testcase-gap-screens');
const PORT = 18887;
const wait = ms => new Promise(r => setTimeout(r, ms));
const XSS = 'GAP: <img src=x onerror="window.__xss=1"> domain lock is not enforced';
const kasus = (n, title) => ({ id: 'TC-0' + n, scenario_type: 'negative', title, precondition: ['Example precondition ' + n + '.'],
  test_steps: ['Send an example request ' + n + '.'], expected_result: ['Example response ' + n + '.', 'Example body ' + n + '.'] });
const SAMPLE = JSON.stringify([
  { task_id: 'ABC-201', task_name: 'Example Sales Map', endpoint: 'POST /example/salesmap',
    test_cases: [kasus(1, 'Verify Example Create'), kasus(2, XSS), kasus(3, 'Verify Example Duplicate')] },
  { task_id: 'ABC-202', task_name: 'Example List', endpoint: 'GET /example/salesmap', test_cases: [kasus(4, 'GAP: Date range filter is ignored')] },
], null, 2);
const ACTUAL = 'API returns 201 Created.\nThe record is stored with a foreign domain.';
const SUMMARY = { 'ABC-201': 'Example Sales Map', 'ABC-202': 'Example List' };
const gapKey = (key, title) => key + '|' + title.replace(/\s+/g, ' ').trim().toLowerCase();

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
      const errors = [], consoleErrors = [], blocked = [], previewBodies = [], pushBodies = [];
      let pushMode = 'ok';
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      await page.addInitScript(() => {
        if (sessionStorage.getItem('gap-seed')) return;
        const now = new Date().toISOString();
        localStorage.setItem('catet.jira.v1', JSON.stringify({ key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: [] }));
        localStorage.setItem('catet.tasks.v1', JSON.stringify([{ id: 'g1', text: 'ABC-201 — Synthetic sales map', status: 'aktif', priority: 'urgent', createdAt: now }]));
        localStorage.setItem('catet.worklog.v1', '[]');
        sessionStorage.setItem('gap-seed', '1');
      });
      await page.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:' + PORT) return route.continue();
        if (u.hostname !== 'synthetic.invalid') { blocked.push(u.hostname); return route.abort(); }
        if (u.pathname === '/bugs/preview') {
          const body = JSON.parse(req.postData() || '{}');
          previewBodies.push(body);
          const relink = pushBodies.some(p => p.issueKey === body.issueKey && p.gap.title === body.gap.title && p.unlinked);
          return route.fulfill({ json: {
            issueKey: body.issueKey, issueSummary: SUMMARY[body.issueKey], project: { key: 'ABC', id: '10999' }, issueType: 'Bug', linkType: 'Relates',
            action: relink ? 'relink' : 'create', bugKey: relink ? 'ABC-902' : null, reason: relink ? 'ABC-902 sudah dibuat tapi link ke ' + body.issueKey + ' belum terverifikasi.' : null,
            bug: { summary: '[Feedback] ' + body.gap.title.replace(/^gap\s*:\s*/i, ''), parent: { key: 'ABC-100', summary: 'Synthetic epic' },
              assignee: body.issueKey === 'ABC-201' ? { accountId: 'acc-1', displayName: 'Synthetic Dev' } : null, endpoint: body.gap.endpoint,
              preconditions: body.gap.preconditions, steps: body.gap.steps, expected: body.gap.expected, actual: body.gap.actual },
            previewHash: (body.issueKey.slice(-1) + body.gap.actual.length).padEnd(64, '0'),
          } });
        }
        if (u.pathname === '/bugs/push') {
          const body = JSON.parse(req.postData() || '{}');
          pushBodies.push(body);
          if (pushMode === 'off') return route.fulfill({ status: 404, json: { error: 'Rute bug tidak dikenal.' } });
          const summary = '[Feedback] ' + body.gap.title.replace(/^gap\s*:\s*/i, '');
          if (pushMode === 'unlinked') {
            body.unlinked = true;
            return route.fulfill({ json: { issueKey: body.issueKey, summary, status: 'created_unlinked', bugKey: 'ABC-902', error: 'Jira menolak link (HTTP 403). Klik Retry link.' } });
          }
          return route.fulfill({ json: { issueKey: body.issueKey, summary, status: 'created_linked', bugKey: body.issueKey === 'ABC-201' ? 'ABC-901' : 'ABC-902', error: null } });
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
      const group = key => sec.locator('.testcase-group').filter({ has: page.locator('.testcase-group-head .jira-key', { hasText: new RegExp('^' + key + '$') }) });

      // Parse: GAP keluar dari daftar test case → tiket tidak tertahan.
      await sec.locator('#tcb-input').fill(SAMPLE);
      await sec.getByRole('button', { name: 'Parse', exact: true }).click();
      assert.deepEqual(await sec.locator('.testcase-preview > .testcase-summary .testcase-chip').allTextContents(), ['2 tickets', '1 selected', '0 blocked']);
      const g1 = group('ABC-201');
      assert.equal(await g1.locator('.testcase-list').first().locator('> .testcase-card').count(), 2, 'GAP tidak ada di daftar test case');
      assert.deepEqual(await g1.locator('> .testcase-summary .testcase-chip').allTextContents(), ['2 cases', '2 selected', '0 errors', '0 warnings']);
      assert.equal(await sec.locator('#tcb-dry').count(), 1, 'Dry run all muncul walau ada GAP');
      assert.equal(await group('ABC-202').evaluate(n => n.classList.contains('has-error')), false, 'tiket hanya-GAP tidak tertahan');
      const gaps = g1.locator('.testcase-gaps');
      assert.equal(await gaps.locator('.gap-card').count(), 1);
      assert.equal(await gaps.locator('.gap-card .testcase-title').textContent(), XSS, 'judul GAP tetap teks');
      assert.equal(await page.evaluate(() => window.__xss), undefined);

      // Actual result wajib sebelum Dry run bug; draft lokal per GAP.
      const card = gaps.locator('.gap-card').first();
      const dry = card.getByRole('button', { name: 'Dry run bug', exact: true });
      assert.equal(await dry.isDisabled(), true, 'Actual kosong → Dry run bug mati');
      assert.equal(await card.locator('.testcase-hint', { hasText: 'Isi Actual result dulu' }).isVisible(), true);
      await card.locator('textarea.gap-actual').fill(ACTUAL);
      assert.equal(await dry.isDisabled(), false);
      const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem('catet.bugDrafts.v1')));
      assert.equal(drafts[gapKey('ABC-201', XSS)].text, ACTUAL);
      await dry.click();
      await card.getByRole('button', { name: 'Create bug', exact: true }).waitFor();
      assert.deepEqual(previewBodies.at(-1), { issueKey: 'ABC-201', gap: { title: XSS, preconditions: ['Example precondition 2.'],
        steps: ['Send an example request 2.'], expected: ['Example response 2.', 'Example body 2.'], actual: ACTUAL, endpoint: 'POST /example/salesmap' } });
      const plan = card.locator('.testcase-plan');
      const fieldText = await plan.locator('.testcase-field').allInnerTexts();
      for (const re of [/^Summary\s+\[Feedback\] <img/i, /^Parent\s+ABC-100 Synthetic epic/i, /^Assignee\s+Synthetic Dev/i, /^Link\s+Relates → ABC-201/i, /^Endpoint\s+POST \/example\/salesmap/i]) {
        assert(fieldText.some(t => re.test(t)), 'rencana memuat ' + re);
      }
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
        await card.screenshot({ path: path.join(out, `gap-${mode}-plan-${theme}.png`) });
      }
      // Actual diedit → rencana disembunyikan sampai Dry run lagi (tanpa render ulang).
      await card.locator('textarea.gap-actual').fill(ACTUAL + ' Edited.');
      assert.equal(await plan.isVisible(), false);
      assert.equal(await card.locator('.testcase-stale').isVisible(), true);
      await card.locator('textarea.gap-actual').fill(ACTUAL);
      assert.equal(await plan.isVisible(), true, 'teks kembali sama → rencana tampil lagi');

      // Create bug: konfirmasi menyebut summary/parent/assignee/link; previewHash ikut.
      let pesan = '';
      page.once('dialog', d => { pesan = d.message(); d.accept(); });
      await card.getByRole('button', { name: 'Create bug', exact: true }).click();
      await card.locator('.testcase-pushres').waitFor();
      assert.match(pesan, /Buat Bug di Jira project ABC\?/);
      assert.match(pesan, /Parent: ABC-100 Synthetic epic\nAssignee: Synthetic Dev \(akan menerima notifikasi Jira\)\nLink: Relates ke ABC-201/);
      assert.deepEqual([pushBodies.at(-1).issueKey, pushBodies.at(-1).previewHash, pushBodies.at(-1).gap.actual], ['ABC-201', ('1' + ACTUAL.length).padEnd(64, '0'), ACTUAL]);
      assert.match(await card.locator('.testcase-pushres').innerText(), /Bug dibuat dan ter-link ke ABC-201\.[\s\S]*Linked[\s\S]*ABC-901/);
      assert.equal(await page.evaluate(() => localStorage.getItem('catet.bugDrafts.v1')), null, 'draft Actual dibersihkan setelah beres');
      assert.equal(await card.locator('textarea.gap-actual').inputValue(), ACTUAL, 'teks tetap tampil');

      // Unlinked → Retry link (tanpa konfirmasi, previewHash sama, action relink).
      const c2 = group('ABC-202').locator('.gap-card').first();
      await c2.locator('textarea.gap-actual').fill('Filter is ignored; all rows returned.');
      await c2.getByRole('button', { name: 'Dry run bug', exact: true }).click();
      await c2.getByRole('button', { name: 'Create bug', exact: true }).waitFor();
      assert.match(await c2.locator('.testcase-plan').innerText(), /Assignee\s+— \(tiket belum di-assign\)/i);
      pushMode = 'unlinked';
      page.once('dialog', d => { assert.doesNotMatch(d.message(), /notifikasi/); d.accept(); });
      await c2.getByRole('button', { name: 'Create bug', exact: true }).click();
      await c2.getByRole('button', { name: 'Retry link', exact: true }).waitFor();
      assert.match(await c2.locator('.testcase-pushres').innerText(), /belum terverifikasi[\s\S]*Unlinked/);
      pushMode = 'ok';
      const n = pushBodies.length;
      await c2.getByRole('button', { name: 'Retry link', exact: true }).click();
      await c2.locator('.testcase-pushres', { hasText: 'Bug dibuat dan ter-link' }).waitFor();
      assert.equal(pushBodies.length, n + 1);
      assert.equal(pushBodies.at(-1).previewHash, pushBodies.at(-2).previewHash);

      // Flag BUG_PUSH_ENABLED mati → pesan jelas, tidak ada yang dianggap terbuat.
      await page.evaluate(() => { bugGap.clear(); render(); });
      const c3 = group('ABC-201').locator('.gap-card').first();
      await c3.locator('textarea.gap-actual').fill('Still ignored.');
      await c3.getByRole('button', { name: 'Dry run bug', exact: true }).click();
      await c3.getByRole('button', { name: 'Create bug', exact: true }).waitFor();
      pushMode = 'off';
      page.once('dialog', d => d.accept());
      await c3.getByRole('button', { name: 'Create bug', exact: true }).click();
      await c3.locator('.testcase-pushres').waitFor();
      assert.match(await c3.locator('.testcase-pushres').innerText(), /flag BUG_PUSH_ENABLED mati/);

      // Muat di HP.
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `GAP findings muat ${width}px`);
      }
      await group('ABC-201').locator('.testcase-gaps').screenshot({ path: path.join(out, `gap-${mode}-mobile.png`) });
      await page.setViewportSize({ width: 1280, height: 900 });

      // Panel 🧪 per task: GAP tiket task itu ikut tampil di bawah pratinjau.
      if (mode === 'http') {
        await page.locator('#tab-papan').click();
        await page.locator('#tc-btn-g1').click();
        const panel = page.locator('#tc-panel-g1');
        await panel.locator('#tc-input-g1').fill(SAMPLE);
        await panel.getByRole('button', { name: 'Parse', exact: true }).click();
        assert.match(await panel.locator('.testcase-bundle-info').textContent(), /2 case \+ 1 GAP/);
        assert.equal(await panel.locator('#tc-dry-g1').count(), 1, 'Dry run test case tidak tertahan GAP');
        assert.equal(await panel.locator('.testcase-gaps .gap-card').count(), 1);
        assert.match(await panel.locator('.testcase-gaps .testcase-pushres').innerText(), /BUG_PUSH_ENABLED mati/, 'state GAP sama dengan mode banyak tiket');
      }

      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors.filter(m => !/Failed to load resource/.test(m)), []);
      assert.deepEqual(blocked.filter(h => h !== 'fonts.googleapis.com' && h !== 'fonts.gstatic.com'), []);
      await context.close();
    }
    console.log('PASS smoke testcase GAP → Bug (http + file): parse terpisah, Actual wajib, Dry run bug, edit = basi, Create bug, Retry link, flag mati, HP, panel 🧪 — screenshots ' + out);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
