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

// Ubah keanggotaan sprint sebuah tugas. id berisi → pindah/masuk sprint.
// id null → keluarkan (lihat keluarkanDariSprint).
function setTaskSprint(t, id) {
  if (id) { t.sprintId = id; save(); return; }
  keluarkanDariSprint(t);
}

// Keluarkan tugas dari sprint. Kalau asalnya tiket Jira, kembalikan ke inbox
// "belum diambil" dan cabut dari daftar dismissed — jadi tidak lagi dianggap
// sudah diambil untuk dikerjakan. Tugas biasa (non-Jira) tetap di papan
// (turun ke "Nanti"; bagian itu dibuka biar terlihat tidak hilang).
function keluarkanDariSprint(t) {
  const key = (t.text.match(JIRA_RE) || [null])[0];
  if (key) {
    const summary = t.text.replace(new RegExp("^\\s*" + key + "\\s*[—–-]\\s*"), "").trim() || t.text;
    if (!jira.items.some((x) => x.key === key)) {
      jira.items.push({ id: uid(), key, summary, status: null, addedAt: new Date().toISOString() });
    }
    jira.dismissed = jira.dismissed.filter((k) => k !== key);
    if (t.status === "fokus") stopFocus(t);
    tasks = tasks.filter((x) => x.id !== t.id);
    save(); saveJira();
  } else {
    t.sprintId = null;
    if (typeof nantiOpen !== "undefined") nantiOpen = true;
    save();
  }
}

// Menu popup pilih sprint. Dipakai tombol 🏃 di baris tugas, tiket Jira, dan
// kolom catat. anchor = elemen tombol; currentId = sprint yang sedang dipilih
// (untuk tanda ✓); onPick(idAtauNull) dipanggil saat memilih.
let sprintMenuEl = null;
function tutupSprintMenu() {
  if (sprintMenuEl) { sprintMenuEl.remove(); sprintMenuEl = null; }
  document.removeEventListener("mousedown", onDocSprintMenu, true);
  document.removeEventListener("keydown", onDocSprintMenu, true);
}
// Tutup hanya bila klik/tekan di LUAR menu (klik item ditangani sendiri).
function onDocSprintMenu(e) {
  if (e.type === "keydown" && e.key !== "Escape") return;
  if (e.type === "mousedown" && sprintMenuEl && sprintMenuEl.contains(e.target)) return;
  tutupSprintMenu();
}
function bukaSprintMenu(anchor, currentId, onPick) {
  tutupSprintMenu();
  const menu = el("div", "sprint-menu");
  sprintMenuEl = menu;
  const pilih = (id) => (ev) => { ev.stopPropagation(); tutupSprintMenu(); onPick(id); };
  for (const s of sprintAktifList()) {
    const item = el("button", "sprint-menu-item" + (currentId === s.id ? " aktif" : ""));
    item.append(el("span", "sprint-menu-tick", currentId === s.id ? "✓" : ""));
    item.append(el("span", null, s.nama + " · " + fmtSisaSprint(s)));
    item.onclick = pilih(s.id);
    menu.append(item);
  }
  if (currentId) {
    const keluar = el("button", "sprint-menu-item danger");
    keluar.append(el("span", "sprint-menu-tick", ""));
    keluar.append(el("span", null, "Keluarkan dari sprint"));
    keluar.onclick = pilih(null);
    menu.append(keluar);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  menu.style.left = Math.max(8, left) + "px";
  // Buka ke bawah; kalau ruang bawah kurang, balik ke atas tombol.
  const top = (r.bottom + 4 + mh > window.innerHeight - 8 && r.top - mh - 4 > 8)
    ? r.top - mh - 4 : r.bottom + 4;
  menu.style.top = top + "px";
  // Tutup saat klik di luar / Escape (dipasang setelah event klik ini selesai).
  setTimeout(() => {
    document.addEventListener("mousedown", onDocSprintMenu, true);
    document.addEventListener("keydown", onDocSprintMenu, true);
  }, 0);
}
