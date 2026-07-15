// sprints.js — kelompok sprint untuk tiket Jira: nama + tanggal selesai.
// Sprint jadi sumber tekanan waktu ketiga bagi skor dinamis (tasks.js):
// makin dekat akhir sprint, makin tinggi poin semua tugas anggotanya.
// Kunci localStorage: catet.sprints.v1.
"use strict";

const SPRINT_KEY = "catet.sprints.v1";
let sprints = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(SPRINT_KEY));
    if (s && typeof s === "object" && Array.isArray(s.list)) return s;
  } catch {}
  return { list: [], aktif: null };
})();
function saveSprints() { localStorage.setItem(SPRINT_KEY, JSON.stringify(sprints)); if (typeof syncDirty === "function") syncDirty(); }

function sprintById(id) { return sprints.list.find((s) => s.id === id) || null; }
// Sprint aktif = target tombol "＋ Sprint" di tab Jira.
function sprintAktif() {
  return sprintById(sprints.aktif) || sprints.list[0] || null;
}
// Akhir sprint dihitung sampai habisnya hari itu (23.59), bukan tengah malam.
function akhirSprint(s) {
  const [y, m, d] = s.selesai.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59);
}
// Poin tekanan sprint, skala sama dengan poin tenggat di tasks.js (0–4).
// Sengaja mulai menekan lebih awal daripada tenggat per-tugas, karena satu
// sprint berisi banyak tiket yang harus dicicil.
function sprintPts(t) {
  if (!t.sprintId) return 0;
  const s = sprintById(t.sprintId);
  if (!s) return 0; // sprint sudah dihapus — abaikan
  const h = (akhirSprint(s) - Date.now()) / 3600000;
  if (h < 0) return 4;    // sprint lewat
  if (h <= 24) return 4;  // hari terakhir
  if (h <= 72) return 3;  // ≤3 hari lagi
  if (h <= 168) return 2; // ≤1 minggu
  return 1;
}
function fmtSisaSprint(s) {
  const hari = Math.ceil((akhirSprint(s) - Date.now()) / 86400000);
  if (hari < 0) return "lewat " + Math.abs(hari) + " hari";
  if (hari === 0) return "berakhir hari ini";
  return "sisa " + hari + " hari";
}
function jumlahTugasSprint(id) {
  return tasks.filter((t) => t.status !== "selesai" && t.sprintId === id).length;
}
