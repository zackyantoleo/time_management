// Riwayat sprint: sprint yang ditutup (manual / hilang dari Jira) tidak
// langsung dibuang — disimpan 2 bulan sejak ditutup, lalu dipangkas.
// Synthetic fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/sprints.js'), 'utf8');

function makeContext({tasks = [], list = [], aktif = null} = {}) {
  let sequence = 0;
  const saved = {sprints: 0, tasks: 0, worklog: 0, dirty: 0};
  const context = vm.createContext({
    localStorage: {getItem: () => JSON.stringify({list, aktif}), setItem() {}},
    tasks, worklog: [], jira: {dismissed: [], items: []},
    JIRA_RE: /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g,
    uid: () => `new-${++sequence}`,
    localDateStr: (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
    saveTanpaSinkron() { saved.tasks++; }, save() { saved.tasks++; saved.dirty++; },
    saveWorklog() { saved.worklog++; }, syncDirty() { saved.dirty++; },
    saved,
  });
  vm.runInContext(source, context);
  return context;
}
const run = (context, code) => vm.runInContext(code, context);
const feedWith = (jiraId, keys) => keys.map((key) => ({key, summary: 'Synthetic ' + key,
  sprint: {jiraId, name: 'Sprint ' + jiraId, endDate: '2026-11-20'}}));
const task = (id, key, status, sprintId, extra = {}) => ({id, text: key + ' — Synthetic ' + key, priority: 'sedang',
  status, sprintId, createdAt: '2026-11-01T00:00:00Z', doneAt: status === 'selesai' ? '2026-11-10T00:00:00Z' : null, ...extra});

// 1. Sprint otomatis yang hilang dari Jira masuk riwayat (bukan dihapus),
//    snapshot diambil SEBELUM tugas yang belum beres dilepas.
{
  const c = makeContext({
    tasks: [task('a', 'TEST-1', 'selesai', 'jira:7'), task('b', 'TEST-2', 'aktif', 'jira:7')],
    list: [{id: 'jira:7', jiraId: 7, nama: 'Sprint 7', selesai: '2026-11-10', auto: true}],
  });
  // Feed berikutnya: TEST-2 sudah di sprint 8 (carry over), sprint 7 tak ada lagi.
  run(c, `rekonsiliasiSprintJira(${JSON.stringify(feedWith(8, ['TEST-2']))})`);
  const s7 = run(c, 'sprintById("jira:7")');
  assert(s7, 'Sprint otomatis yang ditutup harus tetap ada di riwayat');
  assert.equal(s7.status, 'selesai');
  assert(Number.isFinite(Date.parse(s7.selesaiPada)));
  assert.equal(s7.hasil.total, 2, 'Snapshot harus memuat tugas yang belum beres juga');
  assert.equal(s7.hasil.beres, 1);
  assert.deepEqual(Array.from(s7.hasil.items, (x) => x.done).sort(), [false, true]);
  assert.equal(c.tasks.find((t) => t.id === 'b').sprintId, 'jira:8', 'Tugas carry-over pindah ke sprint baru');
  assert.equal(c.tasks.find((t) => t.id === 'a').sprintId, 'jira:7', 'Tugas selesai tetap tertaut ke sprint riwayat');
  assert.deepEqual(Array.from(run(c, 'sprintAktifList()'), (s) => s.id), ['jira:8']);
  assert.deepEqual(Array.from(run(c, 'riwayatSprintList()'), (s) => s.id), ['jira:7']);
  // Idempoten: sinkron berikutnya tidak menimpa stempel/snapshot.
  const before = JSON.stringify(s7);
  run(c, `rekonsiliasiSprintJira(${JSON.stringify(feedWith(8, ['TEST-2']))})`);
  assert.equal(JSON.stringify(run(c, 'sprintById("jira:7")')), before);
  // Muncul lagi di sprint aktif Jira → hidup lagi, snapshot dibuang.
  run(c, `rekonsiliasiSprintJira(${JSON.stringify(feedWith(7, ['TEST-3']))})`);
  const reopened = run(c, 'sprintById("jira:7")');
  assert.equal(reopened.status, undefined);
  assert.equal(reopened.hasil, undefined);
  assert.equal(reopened.selesaiPada, undefined);
  assert.equal(c.saved.dirty, 0, 'Rekonsiliasi tidak boleh mengklaim dirty');
}

// 2. Sprint otomatis yang masih berisi tugas aktif (penetapan manual) tetap aktif.
{
  const c = makeContext({
    tasks: [task('m', 'TEST-9', 'aktif', 'jira:5', {sprintManual: true})],
    list: [{id: 'jira:5', jiraId: 5, nama: 'Sprint 5', selesai: '2026-11-10', auto: true}],
  });
  run(c, `rekonsiliasiSprintJira(${JSON.stringify(feedWith(6, ['TEST-1']))})`);
  assert.equal(run(c, 'sprintById("jira:5")').status, undefined);
}

// 3. sprintId menggantung (sprint-nya sudah dipangkas) ditaut ulang ke sprint Jira.
{
  const c = makeContext({tasks: [task('d', 'TEST-4', 'aktif', 'jira:1')]});
  run(c, `rekonsiliasiSprintJira(${JSON.stringify(feedWith(9, ['TEST-4']))})`);
  assert.equal(c.tasks[0].sprintId, 'jira:9');
}

// 4. Retensi 2 bulan kalender (dijepit ke akhir bulan) + pemangkasan.
{
  const c = makeContext({
    tasks: [task('x', 'TEST-5', 'aktif', 'old'), task('y', 'TEST-6', 'selesai', 'recent')],
    list: [
      {id: 'old', nama: 'Old', selesai: '2026-08-01', status: 'selesai', selesaiPada: '2026-08-11T03:00:00.000Z'},
      {id: 'recent', nama: 'Recent', selesai: '2026-10-01', status: 'selesai', selesaiPada: '2026-10-02T03:00:00.000Z'},
      {id: 'legacy-old', nama: 'Legacy old', selesai: '2026-07-01', status: 'selesai'},
      {id: 'legacy-new', nama: 'Legacy new', selesai: '2026-09-30', status: 'selesai'},
      {id: 'live', nama: 'Live', selesai: '2026-11-30'},
    ],
    aktif: 'old',
  });
  assert.equal(run(c, 'localDateStr(tambahBulan(new Date(2026, 10, 30, 12), 3))'), '2027-02-28');
  assert.equal(run(c, 'localDateStr(tambahBulan(new Date(2027, 10, 30, 12), 3))'), '2028-02-29');
  assert.equal(run(c, 'localDateStr(tambahBulan(new Date(2026, 11, 31, 12), 2))'), '2027-02-28');
  assert.equal(run(c, 'RIWAYAT_SPRINT_BULAN'), 2);
  const now = 'new Date("2026-11-12T05:00:00Z")';
  assert.deepEqual(Array.from(run(c, `riwayatSprintList(${now})`), (s) => s.id), ['recent', 'legacy-new'],
    'Riwayat kedaluwarsa disembunyikan walau belum dipangkas; urut terbaru dulu');
  assert.equal(run(c, 'hapusRiwayatPada(sprintById("live"))'), null, 'Sprint aktif tidak pernah kedaluwarsa');
  assert.equal(run(c, `pangkasRiwayatSprint(${now})`), true);
  assert.deepEqual(Array.from(run(c, 'sprints.list'), (s) => s.id), ['recent', 'legacy-new', 'live']);
  assert.equal(run(c, 'sprints.aktif'), null);
  assert.equal(c.tasks.find((t) => t.id === 'x').sprintId, null, 'Tautan ke sprint yang dipangkas dilepas');
  assert.equal(c.tasks.find((t) => t.id === 'y').sprintId, 'recent');
  assert.equal(c.saved.dirty, 0, 'Pemangkasan deterministik — tanpa klaim dirty');
  assert.equal(run(c, `pangkasRiwayatSprint(${now})`), false, 'Idempoten');
  // Legacy tanpa selesaiPada: dihitung dari akhir sprint (30 Sep 23.59 → 30 Nov).
  assert.equal(run(c, 'pangkasRiwayatSprint(new Date("2026-12-01T12:00:00.000Z"))'), true);
  assert.deepEqual(Array.from(run(c, 'sprints.list'), (s) => s.id), ['recent', 'live']);
  // Sedetik sebelum tepat 2 bulan → masih ada; tepat 2 bulan → terhapus.
  const batas = run(c, 'hapusRiwayatPada(sprintById("recent")).getTime()');
  assert.equal(run(c, 'localDateStr(hapusRiwayatPada(sprintById("recent")))').slice(0, 7), '2026-12');
  assert.equal(run(c, `pangkasRiwayatSprint(new Date(${batas - 1000}))`), false);
  assert.equal(run(c, `pangkasRiwayatSprint(new Date(${batas}))`), true);
  assert.deepEqual(Array.from(run(c, 'sprints.list'), (s) => s.id), ['live']);
}

// 5. Complete sprint (manual) menyimpan snapshot; duplikat tiket digabung.
{
  const c = makeContext({
    tasks: [task('p', 'TEST-7', 'selesai', 'm1'), task('q', 'TEST-7', 'aktif', 'm1'), task('r', 'TEST-8', 'selesai', 'm1'),
      {id: 'n', text: 'Catatan tanpa tiket', priority: 'rendah', status: 'aktif', sprintId: 'm1'}],
    list: [{id: 'm1', nama: 'Manual', selesai: '2026-11-11'}], aktif: 'm1',
  });
  run(c, 'completeSprint(sprintById("m1"))');
  const s = run(c, 'sprintById("m1")');
  assert.equal(s.status, 'selesai');
  assert.equal(s.hasil.total, 3);
  assert.equal(s.hasil.beres, 1);
  assert.equal(s.hasil.items.find((x) => x.text.startsWith('TEST-7')).done, false, 'Salinan aktif menang');
  assert.match(c.worklog[0].text, /1\/3 tasks done/);
  // Snapshot tetap dipakai walau tugasnya kemudian diarsipkan.
  run(c, 'tasks.length = 0');
  assert.equal(run(c, 'hasilSprint(sprintById("m1")).total'), 3);
  // Hapus manual dari riwayat ikut sinkron.
  const dirty = c.saved.dirty;
  run(c, 'hapusRiwayatSprint(sprintById("m1"))');
  assert.equal(run(c, 'sprintById("m1")'), null);
  assert(c.saved.dirty > dirty);
}

console.log('PASS sprint history: Jira close → history w/ snapshot, reopen, 2-month retention prune, manual complete snapshot');
