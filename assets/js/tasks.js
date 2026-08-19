// tasks.js — state & operasi tugas (papan) + log kerja (append-only).
// Kunci localStorage: catet.tasks.v1, catet.worklog.v1.
"use strict";

const STORE_KEY = "catet.tasks.v1";
const PRIORITIES = [
  { id: "urgent", label: "Urgent — do it now" },
  { id: "tinggi", label: "High" },
  { id: "sedang", label: "Medium" },
  { id: "rendah", label: "Low — when free" },
];
const PR_ORDER = { urgent: 0, tinggi: 1, sedang: 2, rendah: 3 };

const WORKLOG_KEY = "catet.worklog.v1";

let tasks = load();
let worklog = loadWorklog();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
// segera=true → push sinkron tanpa debounce (fokus/pause/selesai), supaya
// perangkat lain cepat melihat status "In progress".
function save(segera) {
  localStorage.setItem(STORE_KEY, JSON.stringify(tasks));
  if (typeof syncDirty === "function") syncDirty(!!segera);
}
function loadWorklog() {
  try { return JSON.parse(localStorage.getItem(WORKLOG_KEY)) || []; }
  catch { return []; }
}
function saveWorklog(segera) {
  localStorage.setItem(WORKLOG_KEY, JSON.stringify(worklog));
  if (typeof syncDirty === "function") syncDirty(!!segera);
}
// Simpan TANPA menandai dirty — khusus perubahan yang dibuat mesin (arsip
// otomatis, backfill, penanda notifikasi), bukan tangan pengguna. Kalau
// perubahan mesin ikut mengklaim dirty, tab lama di latar bisa mendorong
// state basi dan menimpa fokus/selesai dari perangkat lain. Perubahan mesin
// bersifat deterministik: tiap perangkat menghitungnya sendiri.
function saveTanpaSinkron() { localStorage.setItem(STORE_KEY, JSON.stringify(tasks)); }
function saveWorklogTanpaSinkron() { localStorage.setItem(WORKLOG_KEY, JSON.stringify(worklog)); }

/* ---------- skor dinamis: menentukan urutan & apa yang tampil hari ini ----
   Berbeda dari skor saat pencatatan (snapshot), skor ini dihitung ulang setiap
   render — tenggat yang makin dekat otomatis menaikkan skor tanpa disentuh.
   Bahan: dampak (dari panel "Bantu nilai", fallback ke prioritas), kedekatan
   tenggat, dan perkiraan usaha (tugas lama dapat poin lebih supaya dicicil
   lebih awal). Skala 0–10. */
function priorityEvaluator(now) {
  return CatetPriorityEngine.createEvaluator({ tasks, sprints, jira, now: now || new Date() });
}
function skorTugas(t) {
  return priorityEvaluator().score(t);
}
// Rincian komponen skor — untuk tooltip badge, biar angkanya tidak misterius.
function rincianSkor(t) {
  return priorityEvaluator().explain(t);
}
// Masuk daftar "Kerjakan hari ini"?
// - urgent / memblokir orang (dampak 3) / tenggat hari ini atau lewat → selalu.
// - anggota sprint → lewat JATAH HARIAN sprint (sprintKuotaHariIni): burn-down
//   otomatis, bukan membanjiri daftar dengan semua anggota di hari-hari akhir.
// - selain itu → skor tinggi.
// kuotaSet opsional (di-precompute board.js sekali per render).
function masukHariIni(t, kuotaSet) {
  return priorityEvaluator().isToday(t, kuotaSet || sprintKuotaHariIni());
}
// Urutan pengerjaan: skor tertinggi dulu, lalu tenggat terdekat, lalu yang
// lebih dulu dicatat.
function bandingkanTugas(a, b) {
  return priorityEvaluator().compare(a, b);
}

/* ---------- work log (append-only, terpisah dari daftar tugas) ---------- */
// Akumulasi menit fokus berhenti di sini; dipanggil setiap tugas keluar dari
// slot fokus (ditunda, diganti, atau selesai).
function stopFocus(t) {
  if (t.focusedAt) {
    t.focusMins = (t.focusMins || 0) + Math.max(0, (Date.now() - new Date(t.focusedAt)) / 60000);
    t.focusedAt = null;
  }
}

/* ---------- tumpukan interupsi ----------
   Memfokuskan tugas lain saat sudah ada yang difokuskan = interupsi: tugas
   lama TIDAK kembali ke daftar, melainkan masuk tumpukan (field ditumpuk =
   stempel waktu, ikut tersinkron lewat store tasks). Begitu tugas fokus
   selesai, tumpukan teratas otomatis kembali difokuskan — persis alur
   "diinterupsi, kerjakan, lalu balik ke kerjaan semula". Menit fokus
   masing-masing tetap akurat karena stopFocus dipanggil di tiap perpindahan. */
function fokuskan(t) {
  const cur = tasks.find((x) => x.status === "fokus");
  if (cur && cur !== t) {
    stopFocus(cur);
    cur.status = "aktif";
    cur.ditumpuk = new Date().toISOString();
  }
  t.status = "fokus"; t.focusedAt = new Date().toISOString(); t.ditumpuk = null;
  save(true); // segera: perangkat lain harus lihat fokus tanpa tunggu debounce
  // Tiket Jira yang difokuskan → geser ke In Progress di Jira (best-effort).
  if (typeof transisiJiraInProgress === "function") transisiJiraInProgress(t);
}
// Tugas di tumpukan, yang terakhir ditunda paling atas (LIFO).
function daftarTumpukan() {
  return tasks.filter((t) => t.status === "aktif" && t.ditumpuk)
    .sort((a, b) => (a.ditumpuk < b.ditumpuk ? 1 : -1));
}
function lanjutkanTumpukan() {
  const top = daftarTumpukan()[0];
  if (top) { top.ditumpuk = null; top.status = "fokus"; top.focusedAt = new Date().toISOString(); }
  return top || null;
}

// mesin=true saat penutupan dilakukan otomatis (tiket sudah Done di Jira):
// simpan tanpa klaim dirty — tiap perangkat mendeteksinya sendiri dari feed.
// kapanIso: tanggal Done sebenarnya (resolutiondate Jira) — log jatuh di hari
// itu, bukan di hari sinkronnya.
function completeTask(t, mesin, kapanIso) {
  const tadinyaFokus = t.status === "fokus";
  stopFocus(t);
  t.status = "selesai";
  t.doneAt = kapanIso || new Date().toISOString();
  delete t.logDihapus; // penyelesaian baru = entri log baru yang sah lagi
  if (tadinyaFokus) lanjutkanTumpukan(); // interupsi beres → balik ke semula
  const when = new Date(t.doneAt);
  worklog.push({
    id: uid(), taskId: t.id, date: localDateStr(when), ts: t.doneAt,
    text: t.text, priority: t.priority, mins: Math.round(t.focusMins || 0),
  });
  t.focusMins = 0;
  if (mesin) { saveTanpaSinkron(); saveWorklogTanpaSinkron(); }
  else {
    save(true); saveWorklog(true); // segera: fokus/selesai ikut sinkron
    // Diselesaikan sendiri → tiket Jira jadi Done (mesin=true dilewati: itu
    // penutupan otomatis KARENA tiketnya sudah Done, tak perlu transisi lagi).
    if (typeof transisiJira === "function") transisiJira(t, "done");
  }
}
function uncompleteTask(t) {
  t.status = "aktif"; t.doneAt = null;
  for (let i = worklog.length - 1; i >= 0; i--) {
    if (worklog[i].taskId === t.id) { worklog.splice(i, 1); break; }
  }
  save(true); saveWorklog(true);
}

// Arsipkan tugas selesai yang sudah lama: buang dari papan supaya state
// sinkron tidak membengkak tanpa batas (blob KV di Worker dibatasi 512 KB —
// kalau penuh, sinkronisasi mati). Riwayatnya tidak hilang: setiap tugas
// selesai sudah tercatat di Log kerja (backfillWorklog menjamin itu untuk
// data lama, jadi panggil ini SETELAH backfill). Yang dibuang hanya baris
// di lipatan "Selesai" yang sudah sebulan tak tersentuh.
const ARSIP_SETELAH_HARI = 30;
function arsipkanTugasSelesai() {
  const batas = Date.now() - ARSIP_SETELAH_HARI * 86400000;
  const sisa = tasks.filter((t) =>
    !(t.status === "selesai" && t.doneAt && new Date(t.doneAt) < batas));
  if (sisa.length !== tasks.length) { tasks = sisa; saveTanpaSinkron(); }
}

// Tugas yang sudah berstatus selesai sebelum fitur log ada ikut dicatat sekali.
// t.logDihapus = pengguna sengaja menghapus entri lognya — hormati, jangan
// dihidupkan lagi di sini (dulu: hapus entri → refresh → entri muncul lagi).
function backfillWorklog() {
  let changed = false;
  for (const t of tasks) {
    if (t.status === "selesai" && t.doneAt && !t.logDihapus && !worklog.some((e) => e.taskId === t.id)) {
      const when = new Date(t.doneAt);
      worklog.push({
        id: uid(), taskId: t.id, date: localDateStr(when), ts: t.doneAt,
        text: t.text, priority: t.priority, mins: Math.round(t.focusMins || 0),
      });
      changed = true;
    }
  }
  if (changed) saveWorklogTanpaSinkron();
}
