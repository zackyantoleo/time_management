// sync.js — sinkronisasi data antar perangkat lewat Cloudflare Worker + D1/KV
// (endpoint GET/PUT /state; lihat worker/README.md). localStorage tetap jadi
// sumber utama (offline-first): setiap perubahan didorong ke Worker beberapa
// detik kemudian, dan saat aplikasi dibuka/kembali aktif data terbaru ditarik.
//
// Strategi konflik (satu pengguna, multi-perangkat):
// - Perangkat bersih → selalu tarik & adopsi server.
// - Perangkat dirty → cek dulu updatedAt server. Kalau server lebih baru dari
//   saat edit lokal dimulai (dirtyAt), ADOPSI server — jangan timpa fokus/
//   perubahan dari perangkat lain dengan state basi. Kalau edit lokal lebih
//   baru (atau setara/tidak diketahui), DORONG lokal.
// - Pull berkala ~20 dtk saat tab terlihat, supaya status fokus ikut pindah
//   antar perangkat tanpa menunggu 5 menit.
"use strict";

const DIRTY_KEY = "catet.dirty.v1";
// Kapan flag dirty pertama kali di-set (ISO). Dipakai membandingkan dengan
// updatedAt server — bukan jam wall-clock antar perangkat untuk LWW murni,
// melainkan "apakah server bergerak SETELAH kita mulai edit lokal".
const DIRTY_AT_KEY = "catet.dirtyAt.v1";
// updatedAt server yang terakhir kita tarik atau dorong sukses — skip
// terapkanRemote kalau belum berubah (hindari reset UI tiap poll).
const LAST_SERVER_AT_KEY = "catet.syncAt.v1";
// Perangkat yang sudah pernah sinkron dengan server ini. Perangkat BARU
// (belum pernah) akan mengadopsi data server saat pertama tersambung, bukan
// menimpanya — mencegah browser kosong menghapus data yang sudah ada di KV/D1.
const SYNCED_KEY = "catet.synced.v1";

const PULL_INTERVAL_MS = 20 * 1000; // poll antar perangkat (fokus, dll.)
const PULL_THROTTLE_MS = 8 * 1000;  // batas bawah saat tidak dipaksa
const PUSH_DEBOUNCE_MS = 3000;

let syncPushTimer = null;
let syncStatus = ""; // teks kecil di footer
let syncLastPull = 0;
let syncReady = false;   // push ditahan sampai pull pertama selesai
let syncPendingPush = false;
let syncPendingSegera = false;
let syncPushing = false;
let syncPushLagi = false; // ada edit baru selama push in-flight

function isDirty() { return localStorage.getItem(DIRTY_KEY) === "1"; }

function syncAktif() {
  return typeof jiraProxy === "function" && !!jiraProxy();
}
function setSyncStatus(msg) {
  syncStatus = msg;
  const n = $("#sync-status");
  if (n) n.textContent = msg ? " · ☁ " + msg : "";
}
function bersihkanDirty() {
  localStorage.removeItem(DIRTY_KEY);
  localStorage.removeItem(DIRTY_AT_KEY);
}
function catatServerAt(iso) {
  if (iso) localStorage.setItem(LAST_SERVER_AT_KEY, iso);
}
function tandaiDirty() {
  if (!localStorage.getItem(DIRTY_AT_KEY)) {
    localStorage.setItem(DIRTY_AT_KEY, new Date().toISOString());
  }
  localStorage.setItem(DIRTY_KEY, "1");
}

// Dipanggil oleh semua fungsi save*() — tandai ada perubahan lokal lalu
// jadwalkan push (debounce, supaya rentetan edit jadi satu kiriman).
// segera=true: dorong sekarang (fokus/pause/selesai — biar perangkat lain
// cepat melihat status "In progress").
// Flag dirty persisten: kalau tab ditutup sebelum push, perangkat ini tetap
// tahu punya perubahan yang belum terkirim saat dibuka lagi.
function syncDirty(segera) {
  tandaiDirty();
  if (!syncAktif()) return;
  if (!syncReady) {
    syncPendingPush = true;
    if (segera) syncPendingSegera = true;
    return;
  }
  // Push sedang jalan — minta satu putaran lagi dengan snapshot terbaru.
  if (syncPushing) {
    syncPushLagi = true;
    return;
  }
  clearTimeout(syncPushTimer);
  if (segera) pushState();
  else syncPushTimer = setTimeout(pushState, PUSH_DEBOUNCE_MS);
}

function kumpulkanStores() {
  const ambil = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const j = ambil("catet.jira.v1");
  // kredensial per perangkat tidak ikut diunggah ke server
  if (j) { delete j.key; delete j.proxy; delete j.calIcs; }
  return {
    tasks: ambil("catet.tasks.v1"),
    worklog: ambil("catet.worklog.v1"),
    routines: ambil("catet.routines.v1"),
    routineday: ambil("catet.routineday.v1"),
    jira: j,
    sprints: ambil("catet.sprints.v1"),
  };
}

async function pushState() {
  if (!syncAktif()) return;
  if (syncPushing) { syncPushLagi = true; return; }
  clearTimeout(syncPushTimer);
  syncPushing = true;
  setSyncStatus("saving…");
  try {
    do {
      syncPushLagi = false;
      const updatedAt = new Date().toISOString();
      const r = await fetch(jiraProxy() + "/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headerAkses() },
        body: JSON.stringify({ updatedAt, stores: kumpulkanStores() }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || ("HTTP " + r.status));
      // Hanya bersihkan dirty kalau tidak ada edit baru selama request.
      if (!syncPushLagi) {
        bersihkanDirty();
        catatServerAt(updatedAt);
        localStorage.setItem(SYNCED_KEY, "1");
        setSyncStatus("synced " + fmtClock(new Date()));
      }
    } while (syncPushLagi);
  } catch (e) {
    setSyncStatus("save failed: " + (e && e.message ? e.message : "koneksi"));
  } finally {
    syncPushing = false;
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
    stores.jira.calIcs = jira.calIcs;
    // Data server bisa berasal dari versi lama (belum punya bau, dsb.) —
    // lengkapi dulu, jangan sampai render crash karena struktur bolong.
    normalisasiJira(stores.jira);
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

// true kalau updatedAt server lebih baru dari acuan lokal (dirtyAt / last sync).
function serverLebihBaru(serverAt, acuanIso) {
  if (!serverAt || !acuanIso) return false;
  const s = new Date(serverAt).getTime();
  const a = new Date(acuanIso).getTime();
  if (isNaN(s) || isNaN(a)) return false;
  return s > a;
}

async function pullState(paksa) {
  if (!syncAktif()) return;
  const pernahSinkron = localStorage.getItem(SYNCED_KEY) === "1";
  const now = Date.now();
  if (!paksa && now - syncLastPull < PULL_THROTTLE_MS) return;

  // Dirty + sudah pernah sync: JANGAN langsung push (bisa menimpa fokus dari
  // perangkat lain). Ambil server dulu, bandingkan updatedAt vs dirtyAt.
  if (isDirty() && pernahSinkron) {
    syncLastPull = now;
    try {
      const r = await fetch(jiraProxy() + "/state", { headers: headerAkses() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      const dirtyAt = localStorage.getItem(DIRTY_AT_KEY);
      const acuan = dirtyAt || localStorage.getItem(LAST_SERVER_AT_KEY);
      if (data.stores && serverLebihBaru(data.updatedAt, acuan)) {
        // Perangkat lain menulis SETELAH edit lokal kita dimulai → ikut server
        // (edit lokal yang belum terkirim dan lebih tua dilepas).
        terapkanRemote(data.stores);
        bersihkanDirty();
        catatServerAt(data.updatedAt);
        localStorage.setItem(SYNCED_KEY, "1");
        setSyncStatus("synced " + fmtClock(new Date()));
        return;
      }
      // Edit lokal lebih baru / setara / acuan tak ada → dorong.
      await pushState();
    } catch (e) {
      // GET gagal: tetap coba dorong niat lokal (offline-first).
      setSyncStatus("pull failed: " + (e && e.message ? e.message : "koneksi"));
      await pushState();
    }
    return;
  }

  syncLastPull = now;
  try {
    const r = await fetch(jiraProxy() + "/state", { headers: headerAkses() });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    if (data.stores) {
      // Sudah punya versi ini — jangan render ulang (panel edit, dsb.).
      const last = localStorage.getItem(LAST_SERVER_AT_KEY);
      if (data.updatedAt && last && data.updatedAt === last) {
        setSyncStatus("synced " + fmtClock(new Date()));
        return;
      }
      // Server punya data → adopsi (termasuk pada perangkat baru). Perubahan
      // lokal yang belum terkirim di perangkat baru sengaja dilepas: onboarding
      // = ikut data bersama, bukan menimpanya. (Backup dulu via Ekspor kalau
      // data lokalnya penting.)
      terapkanRemote(data.stores);
      bersihkanDirty();
      catatServerAt(data.updatedAt);
      localStorage.setItem(SYNCED_KEY, "1");
      setSyncStatus("synced " + fmtClock(new Date()));
    } else if (tasks.length || worklog.length || routines.length) {
      await pushState(); // server masih kosong — unggah data perangkat ini
    } else {
      localStorage.setItem(SYNCED_KEY, "1"); // server & lokal sama-sama kosong
    }
  } catch (e) {
    setSyncStatus("pull failed: " + (e && e.message ? e.message : "koneksi"));
  }
}

// Dipanggil sekali dari app.js. Urutan start-up: tarik state dulu, baru
// sinkron tiket Jira, baru push tertunda.
async function initSync() {
  document.addEventListener("visibilitychange", () => {
    // Paksa tarik saat tab aktif lagi — fokus dari perangkat lain langsung
    // kelihatan tanpa menunggu interval.
    if (document.visibilityState === "visible") pullState(true);
  });
  setInterval(() => {
    // Poll hanya saat tab terlihat — hemat baterai/kuota di latar.
    if (document.visibilityState === "visible") pullState(false);
  }, PULL_INTERVAL_MS);
  try { await pullState(true); } finally { syncReady = true; }
  if (jiraProxy()) syncJira(false);
  if (syncPendingPush) {
    const segera = syncPendingSegera;
    syncPendingPush = false;
    syncPendingSegera = false;
    syncDirty(segera);
  }
}
