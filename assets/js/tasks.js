// tasks.js — state & operasi tugas (papan) + log kerja (append-only).
// Kunci localStorage: catet.tasks.v1, catet.worklog.v1.
"use strict";

const STORE_KEY = "catet.tasks.v1";
const PRIORITIES = [
  { id: "urgent", label: "Urgent — kerjakan sekarang" },
  { id: "tinggi", label: "Tinggi" },
  { id: "sedang", label: "Sedang" },
  { id: "rendah", label: "Rendah — kalau sempat" },
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
}
function loadWorklog() {
  try { return JSON.parse(localStorage.getItem(WORKLOG_KEY)) || []; }
  catch { return []; }
}
function saveWorklog() {
  localStorage.setItem(WORKLOG_KEY, JSON.stringify(worklog));
}

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
function skorTugas(t) {
  const base = t.dampak ? t.dampak * 2 : (SKOR_BASE_PRIORITAS[t.priority] || 3);
  const uPts = t.usaha === "L" ? 2 : t.usaha === "M" ? 1 : 0;
  const raw = base + duePtsTugas(t) + uPts; // maks 6 + 4 + 2 = 12
  return Math.min(10, Math.round((raw / 12) * 10));
}
// Masuk daftar "Kerjakan hari ini"? Ya bila: skornya tinggi, tenggatnya hari
// ini/terlambat, prioritas urgent, atau ada yang terblokir (dampak 3).
function masukHariIni(t) {
  return t.priority === "urgent" || t.dampak === 3 ||
    duePtsTugas(t) >= 3 || skorTugas(t) >= SKOR_AMBANG_HARI_INI;
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
function completeTask(t) {
  stopFocus(t);
  t.status = "selesai";
  t.doneAt = new Date().toISOString();
  const when = new Date(t.doneAt);
  worklog.push({
    id: uid(), taskId: t.id, date: localDateStr(when), ts: t.doneAt,
    text: t.text, priority: t.priority, mins: Math.round(t.focusMins || 0),
  });
  t.focusMins = 0;
  save(); saveWorklog();
}
function uncompleteTask(t) {
  t.status = "aktif"; t.doneAt = null;
  for (let i = worklog.length - 1; i >= 0; i--) {
    if (worklog[i].taskId === t.id) { worklog.splice(i, 1); break; }
  }
  save(); saveWorklog();
}

// Tugas yang sudah berstatus selesai sebelum fitur log ada ikut dicatat sekali.
function backfillWorklog() {
  let changed = false;
  for (const t of tasks) {
    if (t.status === "selesai" && t.doneAt && !worklog.some((e) => e.taskId === t.id)) {
      const when = new Date(t.doneAt);
      worklog.push({
        id: uid(), taskId: t.id, date: localDateStr(when), ts: t.doneAt,
        text: t.text, priority: t.priority, mins: Math.round(t.focusMins || 0),
      });
      changed = true;
    }
  }
  if (changed) saveWorklog();
}
