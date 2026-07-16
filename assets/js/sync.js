// sync.js — sinkronisasi data antar perangkat lewat Cloudflare Worker + KV
// (endpoint GET/PUT /state; lihat worker/README.md). localStorage tetap jadi
// sumber utama (offline-first): setiap perubahan didorong ke Worker beberapa
// detik kemudian, dan saat aplikasi dibuka/kembali aktif data terbaru ditarik.
// Strategi konflik: last-write-wins per seluruh state — cukup untuk satu
// pengguna yang berpindah perangkat.
"use strict";

// Model konsistensi: flag "dirty" yang persisten, BUKAN perbandingan jam.
// Membandingkan timestamp antar perangkat rapuh (jam bisa beda, push
// di-debounce sehingga stempel lebih tua dari isinya). Aturannya sederhana:
// ada perubahan lokal yang belum terkirim → jangan pernah timpa dengan data
// server (kirim dulu); tidak ada → selalu terima data server.
const DIRTY_KEY = "catet.dirty.v1";
// Perangkat yang sudah pernah sinkron dengan server ini. Perangkat BARU
// (belum pernah) akan mengadopsi data server saat pertama tersambung, bukan
// menimpanya — mencegah browser kosong menghapus data yang sudah ada di KV.
const SYNCED_KEY = "catet.synced.v1";

let syncPushTimer = null;
let syncStatus = ""; // teks kecil di footer
let syncLastPull = 0;
let syncReady = false;   // push ditahan sampai pull pertama selesai
let syncPendingPush = false;

function isDirty() { return localStorage.getItem(DIRTY_KEY) === "1"; }

function syncAktif() {
  return typeof jiraProxy === "function" && !!jiraProxy();
}
function setSyncStatus(msg) {
  syncStatus = msg;
  const n = $("#sync-status");
  if (n) n.textContent = msg ? " · ☁ " + msg : "";
}
// Dipanggil oleh semua fungsi save*() — tandai ada perubahan lokal lalu
// jadwalkan push (debounce, supaya rentetan edit jadi satu kiriman).
// Flag-nya persisten: kalau tab ditutup sebelum push, perangkat ini tetap
// tahu punya perubahan yang belum terkirim saat dibuka lagi.
function syncDirty() {
  localStorage.setItem(DIRTY_KEY, "1");
  if (!syncAktif()) return;
  if (!syncReady) { syncPendingPush = true; return; } // tunggu pull pertama
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(pushState, 3000);
}

function kumpulkanStores() {
  const ambil = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  return {
    tasks: ambil("catet.tasks.v1"),
    worklog: ambil("catet.worklog.v1"),
    routines: ambil("catet.routines.v1"),
    routineday: ambil("catet.routineday.v1"),
    jira: ambil("catet.jira.v1"),
    sprints: ambil("catet.sprints.v1"),
  };
}

async function pushState() {
  if (!syncAktif()) return;
  setSyncStatus("menyimpan…");
  try {
    const r = await fetch(jiraProxy() + "/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updatedAt: new Date().toISOString(), stores: kumpulkanStores() }),
    });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || ("HTTP " + r.status));
    localStorage.removeItem(DIRTY_KEY); // terkirim — perangkat ini bersih lagi
    localStorage.setItem(SYNCED_KEY, "1");
    setSyncStatus("tersinkron " + fmtClock(new Date()));
  } catch (e) {
    setSyncStatus("gagal simpan: " + (e && e.message ? e.message : "koneksi"));
  }
}

// Terapkan state dari server ke localStorage + variabel in-memory, lalu
// render ulang. proxy & kunci Jira milik perangkat ini tidak ikut ditimpa.
function terapkanRemote(stores) {
  const tulis = (k, v) => { if (v != null) localStorage.setItem(k, JSON.stringify(v)); };
  tulis("catet.tasks.v1", stores.tasks);
  tulis("catet.worklog.v1", stores.worklog);
  tulis("catet.routines.v1", stores.routines);
  tulis("catet.routineday.v1", stores.routineday);
  tulis("catet.sprints.v1", stores.sprints);
  if (stores.jira != null) {
    stores.jira.proxy = jira.proxy;
    stores.jira.key = jira.key;
    tulis("catet.jira.v1", stores.jira);
  }
  // muat ulang state global dari localStorage
  if (stores.tasks != null) tasks = stores.tasks;
  if (stores.worklog != null) worklog = stores.worklog;
  if (stores.routines != null) routines = stores.routines;
  if (stores.routineday != null) rday = stores.routineday;
  if (stores.sprints != null) sprints = stores.sprints;
  if (stores.jira != null) jira = stores.jira;
  render();
}

async function pullState(paksa) {
  if (!syncAktif()) return;
  const pernahSinkron = localStorage.getItem(SYNCED_KEY) === "1";
  // Perangkat yang SUDAH pernah sinkron & punya perubahan lokal belum terkirim:
  // lindungi — kirim dulu, jangan timpa dengan data server. Perangkat BARU
  // (belum pernah sinkron) TIDAK boleh mendorong dulu, supaya tidak menimpa
  // data yang sudah ada di server — dia harus mengadopsi server dulu.
  if (isDirty() && pernahSinkron) { pushState(); return; }
  const now = Date.now();
  if (!paksa && now - syncLastPull < 30000) return; // throttle
  syncLastPull = now;
  try {
    const r = await fetch(jiraProxy() + "/state");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    if (data.stores) {
      // Server punya data → adopsi (termasuk pada perangkat baru). Perubahan
      // lokal yang belum terkirim di perangkat baru sengaja dilepas: onboarding
      // = ikut data bersama, bukan menimpanya. (Backup dulu via Ekspor kalau
      // data lokalnya penting.)
      terapkanRemote(data.stores);
      localStorage.removeItem(DIRTY_KEY);
      localStorage.setItem(SYNCED_KEY, "1");
      setSyncStatus("tersinkron " + fmtClock(new Date()));
    } else if (tasks.length || worklog.length || routines.length) {
      pushState(); // server masih kosong — unggah data perangkat ini
    } else {
      localStorage.setItem(SYNCED_KEY, "1"); // server & lokal sama-sama kosong
    }
  } catch (e) {
    setSyncStatus("gagal tarik: " + (e && e.message ? e.message : "koneksi"));
  }
}

// Dipanggil sekali dari app.js. Urutan start-up penting: tarik state dulu
// (supaya perbandingan versi memakai localrev yang masih murni), baru
// sinkron tiket Jira (yang boleh menandai dirty), baru push tertunda.
async function initSync() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pullState(false);
  });
  setInterval(() => pullState(false), 5 * 60 * 1000);
  try { await pullState(true); } finally { syncReady = true; }
  if (jiraProxy()) syncJira(false);
  if (syncPendingPush) { syncPendingPush = false; syncDirty(); }
}
