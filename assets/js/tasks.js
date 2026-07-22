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
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(tasks));
  if (typeof syncDirty === "function") syncDirty();
}
function loadWorklog() {
  try { return JSON.parse(localStorage.getItem(WORKLOG_KEY)) || []; }
  catch { return []; }
}
function saveWorklog() {
  localStorage.setItem(WORKLOG_KEY, JSON.stringify(worklog));
  if (typeof syncDirty === "function") syncDirty();
}
// Simpan TANPA menandai dirty — khusus perubahan yang dibuat mesin (arsip
// otomatis, backfill, penanda notifikasi), bukan tangan pengguna. Perangkat
// ber-flag dirty MENDORONG seluruh state-nya alih-alih menarik; kalau
// perubahan mesin ikut mengklaim itu, tab lama yang berjalan di latar akan
// terus menimpa server dengan state basi — tugas yang sudah diselesaikan di
// perangkat lain "hidup lagi". Perubahan mesin bersifat deterministik: tiap
// perangkat menghitungnya sendiri, tak perlu didorong.
function saveTanpaSinkron() { localStorage.setItem(STORE_KEY, JSON.stringify(tasks)); }
function saveWorklogTanpaSinkron() { localStorage.setItem(WORKLOG_KEY, JSON.stringify(worklog)); }

/* ---------- skor dinamis: menentukan urutan & apa yang tampil hari ini ----
   Berbeda dari skor saat pencatatan (snapshot), skor ini dihitung ulang setiap
   render — tenggat yang makin dekat otomatis menaikkan skor tanpa disentuh.
   Bahan: dampak (dari panel "Bantu nilai", fallback ke prioritas), kedekatan
   tenggat, dan perkiraan usaha (tugas lama dapat poin lebih supaya dicicil
   lebih awal). Skala 0–10. */
const SKOR_BASE_PRIORITAS = { urgent: 6, tinggi: 4, sedang: 3, rendah: 1 };
const SKOR_AMBANG_HARI_INI = 6;

function duePtsTugas(t) {
  if (!t.due) return 0;
  const h = (new Date(t.due) - Date.now()) / 3600000;
  if (h < 0) return 4;   // terlambat
  if (h <= 24) return 3; // hari ini
  if (h <= 48) return 2; // besok
  return 1;
}
// Tekanan waktu efektif = yang paling mendesak antara tenggat per-tugas dan
// akhir sprint yang memuat tugas ini (sprintPts dari sprints.js).
function tekananWaktu(t) {
  return Math.max(duePtsTugas(t), sprintPts(t));
}
// Bonus otomatis — tanpa input pengguna: kerjaan yang sudah dicicil naik
// (selesaikan dulu yang setengah jadi), dan tugas yang mengendap ≥3 hari
// naik pelan supaya tidak membusuk di daftar.
function bonusOtomatis(t) {
  const wip = (t.focusMins || 0) > 0 || t.ditumpuk ? 1 : 0;
  const umur = Date.now() - new Date(t.createdAt) >= 3 * 86400000 ? 1 : 0;
  return wip + umur;
}
function skorTugas(t) {
  const base = t.dampak ? t.dampak * 2 : (SKOR_BASE_PRIORITAS[t.priority] || 3);
  const uPts = t.usaha === "L" ? 2 : t.usaha === "M" ? 1 : 0;
  // bonus menambah di atas formula lama, dicap 12 — skor tak pernah turun
  const raw = Math.min(12, base + tekananWaktu(t) + uPts + bonusOtomatis(t));
  return Math.min(10, Math.round((raw / 12) * 10));
}
// Rincian komponen skor — untuk tooltip badge, biar angkanya tidak misterius.
function rincianSkor(t) {
  const parts = [(t.dampak ? "impact " : "priority ") +
    (t.dampak ? t.dampak * 2 : (SKOR_BASE_PRIORITAS[t.priority] || 3))];
  const w = tekananWaktu(t);
  if (w) parts.push((sprintPts(t) > duePtsTugas(t) ? "sprint" : "due") + " +" + w);
  const uPts = t.usaha === "L" ? 2 : t.usaha === "M" ? 1 : 0;
  if (uPts) parts.push("effort +" + uPts);
  if ((t.focusMins || 0) > 0 || t.ditumpuk) parts.push("in progress +1");
  if (Date.now() - new Date(t.createdAt) >= 3 * 86400000) parts.push("aging +1");
  return parts.join(" · ");
}
// Masuk daftar "Kerjakan hari ini"?
// - urgent / memblokir orang (dampak 3) / tenggat hari ini atau lewat → selalu.
// - anggota sprint → lewat JATAH HARIAN sprint (sprintKuotaHariIni): burn-down
//   otomatis, bukan membanjiri daftar dengan semua anggota di hari-hari akhir.
// - selain itu → skor tinggi.
// kuotaSet opsional (di-precompute board.js sekali per render).
function masukHariIni(t, kuotaSet) {
  if (t.priority === "urgent" || t.dampak === 3) return true;
  if (duePtsTugas(t) >= 3) return true; // tenggat eksplisit menang atas kuota
  // Tiket QA yang tiket dev-nya baru saja Done → siap dites, kerjakan hari ini.
  const dep = typeof depsTugas === "function" ? depsTugas(t) : null;
  if (dep && dep.ready) return true;
  const s = t.sprintId && typeof sprintById === "function" ? sprintById(t.sprintId) : null;
  if (s && !sprintSelesai(s)) {
    return (kuotaSet || sprintKuotaHariIni()).has(t.id);
  }
  return skorTugas(t) >= SKOR_AMBANG_HARI_INI;
}
// Urutan pengerjaan: skor tertinggi dulu, lalu tenggat terdekat, lalu yang
// lebih dulu dicatat.
function bandingkanTugas(a, b) {
  const sa = skorTugas(a), sb = skorTugas(b);
  if (sa !== sb) return sb - sa;
  if (a.due && b.due) return new Date(a.due) - new Date(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return new Date(a.createdAt) - new Date(b.createdAt);
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
  save();
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
  else { save(); saveWorklog(); }
}
function uncompleteTask(t) {
  t.status = "aktif"; t.doneAt = null;
  for (let i = worklog.length - 1; i >= 0; i--) {
    if (worklog[i].taskId === t.id) { worklog.splice(i, 1); break; }
  }
  save(); saveWorklog();
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
