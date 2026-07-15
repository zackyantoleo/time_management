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
function sprintSelesai(s) { return !!(s && s.status === "selesai"); }
function sprintAktifList() { return sprints.list.filter((s) => !sprintSelesai(s)); }
// Sprint aktif = target tombol "＋ Sprint"; hanya dari sprint yang belum ditutup.
function sprintAktif() {
  const dipilih = sprintById(sprints.aktif);
  if (dipilih && !sprintSelesai(dipilih)) return dipilih;
  return sprintAktifList()[0] || null;
}
// Tutup sprint: catat ke log kerja, lepas tekanan waktunya, simpan riwayat.
function completeSprint(s) {
  const anggota = tasks.filter((t) => t.sprintId === s.id);
  const beres = anggota.filter((t) => t.status === "selesai").length;
  s.status = "selesai";
  s.selesaiPada = new Date().toISOString();
  const now = new Date();
  worklog.push({
    id: uid(), taskId: "sprint:" + s.id, date: localDateStr(now), ts: now.toISOString(),
    text: "🏁 Sprint “" + s.nama + "” ditutup — " + beres + "/" + anggota.length + " tugas selesai",
    priority: "sprint", mins: 0,
  });
  if (sprints.aktif === s.id) sprints.aktif = (sprintAktifList()[0] || {}).id || null;
  saveSprints(); saveWorklog();
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
  if (!s || sprintSelesai(s)) return 0; // sprint dihapus/ditutup — tak menekan lagi
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
