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
