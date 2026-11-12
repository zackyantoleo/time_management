// Riwayat sprint di tab Jira: entri < 2 bulan tampil (dengan detail isi
// sprint), entri > 2 bulan dipangkas saat start-up. Synthetic fixtures only;
// all external requests are blocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.SHOT_DIR || process.env.TMPDIR || '/tmp';
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const iso = (d) => d.toISOString();
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fixtures = {
  'catet.sprints.v1': {aktif: 'live', list: [
    {id: 'live', nama: 'Sprint 15', selesai: ymd(new Date(Date.now() + 6 * 86400000))},
    {id: 'jira:14', jiraId: 14, auto: true, nama: 'Sprint 14', selesai: ymd(daysAgo(3)), status: 'selesai', selesaiPada: iso(daysAgo(2)),
      prdLinks: [{id: 'p1', title: 'PRD Checkout v2', url: 'https://example.com/prd/checkout'}],
      hasil: {total: 3, beres: 2, items: [
        {text: 'TEST-101 — Validasi voucher di checkout', done: true, priority: 'tinggi'},
        {text: 'TEST-102 — Regression payment gateway', done: false, priority: 'sedang'},
        {text: 'TEST-103 — Smoke test release', done: true, priority: 'sedang'},
      ]}},
    {id: 'm13', nama: 'Sprint 13', selesai: ymd(daysAgo(17)), status: 'selesai', selesaiPada: iso(daysAgo(16)),
      hasil: {total: 1, beres: 1, items: [{text: 'TEST-90 — Automation login', done: true, priority: 'sedang'}]}},
    // ~70 hari: sudah lewat 2 bulan (tapi belum 3) → harus dipangkas.
    {id: 'old', nama: 'Sprint 7', selesai: ymd(daysAgo(72)), status: 'selesai', selesaiPada: iso(daysAgo(70)),
      hasil: {total: 0, beres: 0, items: []}},
  ]},
  'catet.tasks.v1': [{id: 't-old', text: 'TEST-50 — Masih di papan', priority: 'sedang', status: 'aktif', sprintId: 'old',
    createdAt: iso(daysAgo(140)), doneAt: null, focusedAt: null, notified: false}],
  'catet.view.v1': 'jira',
  'catet.jira.v1': {key: 'synthetic-code', proxy: 'https://synthetic.invalid', site: 'https://jira.invalid', items: [], dismissed: []},
};

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '18882', '--bind', '127.0.0.1'], {cwd: root, stdio: 'ignore'});
  let browser;
  try {
    for (let i = 0; ; i++) { try { assert((await fetch('http://127.0.0.1:18882')).ok); break; } catch { assert(i < 50); await new Promise((r) => setTimeout(r, 100)); } }
    browser = await chromium.launch({headless: true, args: ['--allow-file-access-from-files']});
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 820, height: 1000}, deviceScaleFactor: 2});
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.route('**/*', (r) => {
        const u = new URL(r.request().url());
        if (u.protocol === 'file:' || u.origin === 'http://127.0.0.1:18882') return r.continue();
        if (u.hostname !== 'synthetic.invalid') return r.abort();
        return r.fulfill({json: u.pathname === '/me' ? {name: 'Synthetic', jira_site: 'https://jira.invalid', jira_tersimpan: true}
          : u.pathname === '/state' ? {stores: null, updatedAt: null} : {items: [], events: [], days: {}, summaries: {}}});
      });
      await page.addInitScript((data) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }, fixtures);
      await page.goto(mode === 'http' ? 'http://127.0.0.1:18882' : pathToFileURL(path.join(root, 'index.html')).href);
      await page.waitForFunction(() => typeof syncReady !== 'undefined' && syncReady);
      await page.waitForSelector('#jiraview .sprint-history');

      const stored = await page.evaluate(() => ({
        ids: JSON.parse(localStorage.getItem('catet.sprints.v1')).list.map((s) => s.id),
        task: JSON.parse(localStorage.getItem('catet.tasks.v1')).find((t) => t.id === 't-old').sprintId,
      }));
      assert.deepEqual(stored.ids, ['live', 'jira:14', 'm13'], 'Riwayat > 2 bulan dipangkas saat start-up');
      assert.equal(stored.task, null, 'Tugas di sprint yang dipangkas dilepas, bukan dihapus');

      const summary = page.locator('#jiraview details.sprint-history > summary');
      assert.match(await summary.innerText(), /Completed sprints\s*2/);
      await summary.click();
      const rows = page.locator('#jiraview details.sprint-history .jira-row');
      assert.equal(await rows.count(), 2);
      assert.match(await rows.nth(0).innerText(), /Sprint 14[\s\S]*2\/3 done[\s\S]*closed 2 d ago/);
      await rows.nth(0).getByRole('button', {name: /Lihat isi sprint/}).click();
      const detail = page.locator('#jiraview .sprint-history-detail');
      await detail.waitFor();
      const text = await detail.innerText();
      const hapus = new Date(daysAgo(2)); const tgl = hapus.getDate(); hapus.setDate(1); hapus.setMonth(hapus.getMonth() + 2);
      hapus.setDate(Math.min(tgl, new Date(hapus.getFullYear(), hapus.getMonth() + 1, 0).getDate()));
      const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      assert(text.includes('terhapus otomatis') && text.includes(hapus.getDate() + ' ' + BLN[hapus.getMonth()] + ' ' + hapus.getFullYear()),
        'Tanggal hapus otomatis = 2 bulan setelah ditutup');
      assert.match(await page.locator('#jiraview .sprint-history-note').innerText(), /2 bulan/);
      assert.match(text, /PRD Checkout v2/);
      assert.match(text, /Sprint items \(3\)/i);
      assert.match(text, /TEST-102[\s\S]*not done/, 'Item belum beres tampil lebih dulu dengan label');
      // Detail & lipatan tetap terbuka setelah render ulang.
      await page.evaluate(() => render());
      assert.equal(await page.locator('#jiraview .sprint-history-detail').count(), 1);

      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.locator('#jiraview section.s-jira').first().screenshot({path: path.join(out, `catet-sprint-history-${mode}-${theme}.png`)});
      }

      // Lebar HP: tanpa scroll horizontal, info retensi tetap terlihat.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await page.setViewportSize({width: 390, height: 900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Tidak boleh ada scroll horizontal di HP');
      assert(await page.locator('#jiraview .sprint-history-detail .sprint-history-meta').first().isVisible());
      await page.locator('#jiraview section.s-jira').first().screenshot({path: path.join(out, `catet-sprint-history-${mode}-phone.png`)});
      await page.setViewportSize({width: 820, height: 1000});

      // Pencarian tab Jira menyaring riwayat lewat isi tiket.
      await page.fill('#search', 'TEST-90');
      assert.equal(await page.locator('#jiraview details.sprint-history .jira-row').count(), 1);
      assert.match(await page.locator('#jiraview details.sprint-history > summary').innerText(), /1\/2/);
      await page.fill('#search', '');

      // Hapus manual dari riwayat (dengan konfirmasi).
      page.once('dialog', (d) => d.accept());
      await page.locator('#jiraview details.sprint-history .jira-row').nth(1).getByRole('button', {name: /Hapus dari riwayat/}).click();
      assert.equal(await page.locator('#jiraview details.sprint-history .jira-row').count(), 1);

      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: expired history pruned, 2 entries shown, detail + PRD + search + delete, no console errors`);
      await context.close();
    }
  } finally { if (browser) await browser.close(); server.kill(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
