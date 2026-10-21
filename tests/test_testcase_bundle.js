// Synthetic fixtures only. Tempelan test case banyak tiket (JSON dari AI):
// parse per tiket, validasi per tiket + batas tempelan, pemilihan kelompok untuk
// panel per task, rencana Push all, dan pembanding judul Jira (tanpa DOM/jaringan).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/testcases.js'), 'utf8');

function load(store = new Map()) {
  const context = vm.createContext({
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    tasks: [],
  });
  vm.runInContext(source, context); // tidak boleh menyentuh DOM saat dimuat
  return { run: code => vm.runInContext(code, context), context, store };
}
const { run } = load();
const plain = x => JSON.parse(JSON.stringify(x));
const bundle = text => plain(run('parseTestCaseBundle')(text));
const parse = text => plain(run('parseTestCases')(text));
const forTicket = (text, key) => plain(run('parseTestCasesUntukTiket')(text, key));
const cek = (parsed, pilihTiket, pilih) => plain(run('cekBundleTestCase')(parsed, pilihTiket, pilih));
const all = parsed => [parsed.groups.map(() => true), parsed.groups.map(g => g.cases.map(() => true))];

const kasus = (n, extra = {}) => ({
  id: 'TC-' + String(n).padStart(3, '0'), scenario_type: n % 2 ? 'positive' : 'negative',
  title: 'Verify Example Case ' + n, precondition: 'Example precondition ' + n + '.',
  test_steps: ['Send an example request ' + n + '.'], expected_result: ['Example response ' + n + ' is returned.'], ...extra,
});
const tiket = (key, n, extra = {}) => ({ task_id: key, task_name: 'Example Ticket ' + key, endpoint: 'GET /example/' + key.toLowerCase(),
  test_cases: Array.from({ length: n }, (_, i) => kasus(i + 1)), ...extra });
const sample = [tiket('ABC-101', 3), tiket('ABC-102', 5)];

// Daftar tiket → satu kelompok per tiket; field AI dipetakan ke bentuk internal;
// id & scenario_type diabaikan tanpa warning (K3).
{
  const r = bundle(JSON.stringify(sample, null, 2));
  assert.equal(r.bundle, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.groups.map(g => [g.key, g.taskName, g.endpoint, g.cases.length, g.errors.length]),
    [['ABC-101', 'Example Ticket ABC-101', 'GET /example/abc-101', 3, 0], ['ABC-102', 'Example Ticket ABC-102', 'GET /example/abc-102', 5, 0]]);
  assert.deepEqual(r.groups[0].cases[0], {
    title: 'Verify Example Case 1', preconditions: ['Example precondition 1.'],
    steps: ['Send an example request 1.'], expected: ['Example response 1 is returned.'], ignored: [],
  });
  const v = cek(r, ...all(r));
  assert.equal(v.ok, true);
  assert.deepEqual(v.groups.map(g => [g.siap, g.errors.length, g.dipilih.length]), [[true, 0, 3], [true, 0, 5]]);
  assert(v.groups.every(g => g.v.cases.every(c => !c.warnings.some(w => /id|scenario_type/.test(w)))), 'id/scenario_type tanpa warning');
}

// Satu objek tiket (bukan daftar), dibungkus ```json; CRLF.
{
  const r = bundle(('```json\n' + JSON.stringify(tiket('ABC-103', 1)) + '\n```').replace(/\n/g, '\r\n'));
  assert.equal(r.bundle, true);
  assert.deepEqual(r.groups.map(g => [g.key, g.cases.length]), [['ABC-103', 1]]);
}

// Alias field + teks tunggal vs daftar; field lain → warning "tidak dikenal";
// alias dan nama utama sekaligus → error (tidak ada data yang dibuang diam-diam).
{
  const r = bundle(JSON.stringify([{ task_id: 'ABC-104', test_cases: [
    { title: '  Verify   Alias  Fields ', preconditions: ['Pre A.', '  ', 'Pre B.'], steps: 'Open the example page.', expected: 'Page opens.' },
    { title: 'Verify Extra Field', test_steps: ['Do it.'], expected_result: ['Done.'], priority: 'High', id: 7, scenario_type: 'edge' },
    { title: 'Verify Both Names', precondition: 'A.', preconditions: ['B.'], test_steps: ['Do.'], expected_result: ['Ok.'] },
    { title: 42, test_steps: [1], expected_result: ['Ok.'] },
    'not-a-case',
  ] }]));
  const g = r.groups[0];
  assert.deepEqual(g.cases[0], { title: 'Verify Alias Fields', preconditions: ['Pre A.', 'Pre B.'], steps: ['Open the example page.'], expected: ['Page opens.'], ignored: [] });
  assert.deepEqual(g.cases[1].ignored, ['priority']);
  assert.equal(g.cases.length, 5, 'nomor case sejajar dengan input');
  assert(g.errors.some(e => /Case #3/.test(e) && /precondition” dan “preconditions/.test(e)));
  assert(g.errors.some(e => /Case #4/.test(e) && /title/.test(e)));
  assert(g.errors.some(e => /Case #4/.test(e) && /test_steps/.test(e)));
  assert(g.errors.some(e => /Case #5 bukan objek/.test(e)));
  const v = cek(r, [true], [[true, true, false, false, false]]);
  assert.equal(v.groups[0].siap, false, 'error parse memblokir tiket walau case-nya tidak dicentang');
  const w = v.groups[0].v.cases[1].warnings.join('\n');
  assert.match(w, /“priority” tidak dikenal/);
  assert.doesNotMatch(w, /“id”|“scenario_type”/);
}

// task_id: hilang, kosong, bukan teks, format salah, huruf kecil (di-uppercase),
// ganda (semua kemunculan error, tidak digabung). test_cases kosong/bukan daftar.
{
  const r = bundle(JSON.stringify([
    { task_name: 'No id', test_cases: [kasus(1)] },
    { task_id: '  ', test_cases: [kasus(1)] },
    { task_id: 101, test_cases: [kasus(1)] },
    { task_id: 'ABC 101', test_cases: [kasus(1)] },
    { task_id: ' abc-105 ', test_cases: [kasus(1)] },
    tiket('ABC-106', 1), tiket('abc-106', 2),
    { task_id: 'ABC-107', test_cases: [] },
    { task_id: 'ABC-108', test_cases: 'none' },
    { task_id: 'ABC-109' },
    ['nested'],
  ]));
  assert.equal(r.bundle, true);
  const e = i => r.groups[i].errors.join(' | ');
  assert.match(e(0), /task_id kosong/);
  assert.match(e(1), /task_id kosong/);
  assert.match(e(2), /task_id harus berupa teks/);
  assert.match(e(3), /“ABC 101” bukan key tiket Jira/);
  assert.equal(r.groups[4].key, 'ABC-105');
  assert.deepEqual(r.groups[4].errors, []);
  assert.match(e(5), /ABC-106 muncul 2 kali/);
  assert.match(e(6), /ABC-106 muncul 2 kali/);
  assert.equal(r.groups[5].cases.length + r.groups[6].cases.length, 3, 'tiket ganda tidak digabung');
  assert.match(e(7), /test_cases kosong/);
  assert.match(e(8), /test_cases harus berupa daftar/);
  assert.match(e(9), /test_cases harus berupa daftar/);
  assert.match(e(10), /Item #11 bukan objek tiket/);
  // Error satu tiket hanya memblokir tiket itu.
  const v = cek(r, ...all(r));
  assert.deepEqual(v.groups.map(g => g.siap), [false, false, false, false, true, false, false, false, false, false, false]);
  assert.equal(v.ok, false, '11 tiket dicentang → error tempelan');
  const pilihTiket = r.groups.map((_, i) => i !== 10);
  const v10 = cek(r, pilihTiket, all(r)[1]);
  assert.equal(v10.ok, true, '10 tiket dicentang → boleh');
  assert.deepEqual(v10.groups.filter(g => g.siap).length, 1);
  assert.equal(v10.groups[7].errors.filter(x => /Belum ada case/.test(x)).length, 0, 'test_cases kosong tidak dobel pesan');
}

// Batas tempelan: 11 tiket dicentang → semua tertahan; 21 case dalam satu tiket
// → hanya tiket itu tertahan; hapus satu centang → siap.
{
  const r = bundle(JSON.stringify([tiket('ABC-110', 21), ...Array.from({ length: 10 }, (_, i) => tiket('ABC-' + (111 + i), 1))]));
  const [pt, pc] = all(r);
  const v = cek(r, pt, pc);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /11 tiket dicentang; maksimal 10/);
  pt[5] = false;
  const v2 = cek(r, pt, pc);
  assert.equal(v2.ok, true);
  assert.equal(v2.groups[0].siap, false);
  assert.match(v2.groups[0].errors.join(' '), /21 case; maksimal 20/);
  assert.equal(v2.groups[1].siap, true, 'tiket lain tetap siap');
  pc[0][20] = false;
  assert.equal(cek(r, pt, pc).groups[0].siap, true);
  assert.equal(cek(r, pt, pc).groups[5].siap, false, 'tiket tidak dicentang tidak siap');
}

// Bukan format banyak tiket: markdown, catet.testcases.v1, JSON rusak, kosong.
{
  const md = '**Title:** Verify Example\n**Test Step(s):**\n1. Open.\n**Expected Result:**\n1. Opens.';
  const v1 = JSON.stringify({ format: 'catet.testcases.v1', cases: [{ title: 'Verify Example', steps: ['Open.'], expected: ['Opens.'] }] });
  for (const text of [md, v1, '[{"title": "Verify X"}]', '[]', '[Positive] Verify login']) {
    const r = bundle(text);
    assert.equal(r.bundle, false, text);
    assert.match(r.errors[0], /tidak berisi task_id/);
  }
  assert.match(bundle('[{"task_id": "ABC-101", "test_cases": [').errors[0], /JSON tidak valid/);
  assert.match(bundle('  ').errors[0], /Belum ada teks/);
  // Panel per task: format lama persis seperti parseTestCases.
  for (const text of [md, v1, '[{"title": "Verify X"}]', '{"format": "catet.testcases.v1", "cases": [', '']) {
    assert.deepEqual(forTicket(text, 'ABC-101'), parse(text), 'format lama tidak berubah: ' + text.slice(0, 30));
  }
}

// Panel 🧪 per task: hanya kelompok tiket task itu; info tiket lain; tidak cocok → error.
{
  const text = JSON.stringify([tiket('ABC-101', 3), tiket('ABC-102', 5), tiket('ABC-103', 1)]);
  const r = forTicket(text, 'ABC-102');
  assert.equal(r.source, 'bundle');
  assert.deepEqual(r.errors, []);
  assert.equal(r.cases.length, 5);
  assert.deepEqual(r.cases.map(c => c.title), bundle(text).groups[1].cases.map(c => c.title));
  assert.equal(r.info, 'Tempelan berisi 3 tiket; panel ini memakai ABC-102 (5 case). Tiket lain: ABC-101, ABC-103 — pakai Jira → Test cases.');
  const one = forTicket(JSON.stringify(tiket('ABC-101', 2)), 'ABC-101');
  assert.equal(one.info, 'Tempelan berisi 1 tiket; panel ini memakai ABC-101 (2 case).');
  const miss = forTicket(text, 'ABC-999');
  assert.deepEqual(miss.cases, []);
  assert.deepEqual(miss.errors, ['Tempelan tidak berisi ABC-999. Tiket di tempelan: ABC-101, ABC-102, ABC-103.']);
  const dup = forTicket(JSON.stringify([tiket('ABC-101', 1), tiket('ABC-101', 2)]), 'ABC-101');
  assert.match(dup.errors.join(' '), /ABC-101 muncul 2 kali/, 'tiket ganda tetap diblokir di panel per task');
  const bad = forTicket(JSON.stringify([{ task_id: 'ABC-101', test_cases: [] }]), 'ABC-101');
  assert.match(bad.errors.join(' '), /test_cases kosong/);
}

// Rencana Push all: hanya tiket dengan Dry run yang masih berlaku (sig = key +
// isi case dicentang sekarang), sukses, dan ada case baru; previewHash milik
// tiket itu sendiri; sisanya dikecualikan beserta alasannya.
{
  const r = run(`parseTestCaseBundle(${JSON.stringify(JSON.stringify([tiket('ABC-101', 2), tiket('ABC-102', 2), tiket('ABC-103', 1), tiket('ABC-104', 1), tiket('ABC-105', 1)]))})`);
  const pt = r.groups.map(() => true), pc = r.groups.map(g => g.cases.map(() => true));
  const sig = (i) => run('sigTestCase')(r.groups[i].key, r.groups[i].cases.filter((_, j) => pc[i][j]));
  const ok = (key, create, hash) => ({ issueKey: key, project: { key: 'ABC' }, counts: { create, skip: 0 }, plan: [], previewHash: hash });
  const dry = {
    'ABC-101': { sig: sig(0), loading: false, error: '', rinci: [], data: ok('ABC-101', 2, 'a'.repeat(64)) },
    'ABC-102': { sig: sig(1), loading: false, error: 'Dry run gagal: Project ABC belum aktif', rinci: [], data: null },
    'ABC-103': { sig: sig(2), loading: false, error: '', rinci: [], data: ok('ABC-103', 0, 'c'.repeat(64)) },
    'ABC-104': { sig: sig(3), loading: false, error: '', rinci: [], data: ok('ABC-104', 1, 'd'.repeat(64)) },
  };
  const plan = () => plain(run('rencanaPushBundle')(r, pt, pc, dry));
  let p = plan();
  assert.deepEqual(p.siap.map(x => [x.key, x.n, x.d.previewHash, x.cases.length]), [['ABC-101', 2, 'a'.repeat(64), 2], ['ABC-104', 1, 'd'.repeat(64), 1]]);
  assert.deepEqual(p.kecuali, [
    { key: 'ABC-102', alasan: 'Dry run gagal' },
    { key: 'ABC-103', alasan: 'tidak ada case baru (semua Skip)' },
    { key: 'ABC-105', alasan: 'belum Dry run, atau isinya berubah sejak Dry run' },
  ]);
  // Centang case ABC-101 berubah → Dry run-nya tidak berlaku lagi; tiket lain tidak terpengaruh.
  pc[0][1] = false;
  p = plan();
  assert.deepEqual(p.siap.map(x => x.key), ['ABC-104']);
  assert.deepEqual(p.kecuali[0], { key: 'ABC-101', alasan: 'belum Dry run, atau isinya berubah sejak Dry run' });
  pc[0][1] = true;
  pt[3] = false;
  p = plan();
  assert.deepEqual(p.siap.map(x => x.key), ['ABC-101']);
  assert(p.kecuali.some(x => x.key === 'ABC-104' && x.alasan === 'tidak dicentang'));
  dry['ABC-101'].loading = true;
  assert.deepEqual(plan().siap, [], 'Dry run yang masih berjalan tidak bisa dipush');
}

// K2: task_name dari AI vs judul Jira — longgar terhadap huruf besar/tanda baca/prefiks.
{
  const mirip = (a, b) => run('judulMiripTestCase')(a, b);
  assert.equal(mirip('Get Example Profile', '[BE] Get example profile'), true);
  assert.equal(mirip('Example: Create Order!', 'example create order'), true);
  assert.equal(mirip('Get Example Profile', 'Delete Example Invoice'), false);
  assert.equal(mirip('Get Example Profile', ''), false);
}

// Draft banyak tiket: { text, updatedAt } di catet.testcaseBulkDraft.v1, terpisah dari draft per task.
{
  const store = new Map();
  const d = load(store);
  d.run('simpanDraftBulkTestCase')('[{"task_id": "ABC-101"}]');
  const raw = JSON.parse(store.get('catet.testcaseBulkDraft.v1'));
  assert.equal(raw.text, '[{"task_id": "ABC-101"}]');
  assert.ok(Number.isFinite(Date.parse(raw.updatedAt)));
  assert.equal(store.has('catet.testcaseDrafts.v1'), false);
  assert.equal(d.run('bacaDraftBulkTestCase')(), '[{"task_id": "ABC-101"}]');
  d.run('simpanDraftBulkTestCase')('  ');
  assert.equal(store.has('catet.testcaseBulkDraft.v1'), false, 'draft kosong dihapus');
  store.set('catet.testcaseBulkDraft.v1', '{rusak');
  assert.equal(d.run('bacaDraftBulkTestCase')(), '', 'storage rusak tidak melempar');
}

// Chip "Test cases" di tab Jira, mode tunggal pengganti boolean, reset saat ganti akun;
// draft banyak tiket ikut dihapus saat sign out; SW v81.
{
  const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
  assert.match(jira, /\["testcases", "Test cases", "jira-filter-testcases"\]/);
  assert.match(jira, /"jira-filter-inbox"/);
  assert.match(jira, /"jira-filter-missing-worklog"/);
  assert.doesNotMatch(jira, /jiraWorklogFilter/);
  assert.equal((jira.match(/jiraFilterMode = "inbox";\n  if \(typeof resetTestCaseBulk === "function"\) resetTestCaseBulk\(\);/g) || []).length, 2);
  assert.match(jira, /"catet\.testcaseBulkDraft\.v1",\n  \]\) localStorage\.removeItem/);
  assert.match(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), /const CACHE = "catet-v81";/);
}

console.log('PASS testcase bundle: daftar/objek, alias, K3, task_id, ganda, batas 10 tiket/20 case, format lama, panel per task, rencana Push all, judul Jira, draft, chip');
