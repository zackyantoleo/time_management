/* ---------- reminders ----------
   Dua lapis, dengan toggle nyala/mati sendiri (terpisah dari izin browser):
   1. Toast dalam halaman + bip — selalu bisa, termasuk saat notifikasi
      browser diblokir atau halaman dibuka dari file://.
   2. Notifikasi sistem — bonus kalau izin browser diberikan. Sekali izin
      ditolak, browser tidak akan menampilkan prompt lagi; membukanya harus
      lewat pengaturan situs (ikon gembok), bukan dari halaman ini. */
"use strict";

const REMIND_KEY = "catet.reminders.v1";
let remindersOn = localStorage.getItem(REMIND_KEY) !== "0"; // default nyala

function sysNotifAvailable() {
  return "Notification" in window && Notification.permission === "granted";
}
function updateNotifBtn() {
  const btn = $("#notif-btn");
  if (!remindersOn) {
    btn.textContent = "🔕 Pengingat mati";
    btn.title = "Klik untuk menyalakan pengingat waktu";
  } else if (sysNotifAvailable()) {
    btn.textContent = "🔔 Pengingat aktif";
    btn.title = "Pengingat lewat notifikasi sistem + di dalam halaman. Klik untuk mematikan.";
  } else {
    btn.textContent = "🔔 Pengingat aktif (di tab ini)";
    btn.title = "Pengingat muncul di dalam halaman ini. Notifikasi sistem belum diizinkan browser. Klik untuk mematikan.";
  }
}

// Dipanggil sekali dari app.js.
function initReminders() {
  $("#notif-btn").onclick = () => {
    // Simpan state toggle dulu — permintaan izin browser bisa lama atau tidak
    // pernah terjawab, dan tidak boleh menyandera toggle-nya.
    remindersOn = !remindersOn;
    localStorage.setItem(REMIND_KEY, remindersOn ? "1" : "0");
    updateNotifBtn();
    if (remindersOn && "Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission().then(updateNotifBtn).catch(() => {});
      } else if (Notification.permission === "denied") {
        alert(
          "Pengingat dinyalakan — akan muncul di dalam halaman ini.\n\n" +
          "Notifikasi sistem sedang diblokir oleh browser (pernah ditolak, atau halaman dibuka dari file://). " +
          "Browser tidak mengizinkan halaman meminta ulang izinnya. Untuk membukanya:\n" +
          "• Klik ikon gembok/setelan di kiri address bar → Notifikasi → Izinkan, lalu muat ulang; atau\n" +
          "• Buka pengaturan situs browser dan hapus blokir notifikasi untuk halaman ini.\n\n" +
          "Tanpa itu pun pengingat di dalam halaman tetap jalan."
        );
      }
    }
  };
  updateNotifBtn();
}

function showToast(t) {
  const wrap = $("#toasts");
  const toast = el("div", "toast");
  toast.append(
    el("div", "toast-title", "⏰ Waktunya!"),
    el("div", "toast-body", t.text),
    el("div", "toast-hint", "klik untuk menutup")
  );
  toast.onclick = () => toast.remove();
  wrap.append(toast);
  setTimeout(() => toast.remove(), 30000);
}
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") { audioCtx.resume(); }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.5);
  } catch {}
}

function checkDue() {
  const now = new Date();
  let changed = false;
  let dueNow = [];
  for (const t of tasks) {
    if (t.status !== "selesai" && t.due && !t.notified && new Date(t.due) <= now) {
      t.notified = true; changed = true;
      dueNow.push(t);
    }
  }
  if (changed) save();
  // Rutinitas berjam: ingatkan sekali per hari sampai dicentang.
  ensureRoutineDay();
  const nowHM = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  let rdayChanged = false;
  for (const r of todaysRoutines()) {
    if (r.time && r.time <= nowHM &&
        !rday.doneIds.includes(r.id) && !rday.notifiedIds.includes(r.id)) {
      rday.notifiedIds.push(r.id); rdayChanged = true;
      dueNow.push({ text: "Rutinitas: " + r.text });
    }
  }
  if (rdayChanged) saveRday();
  if (remindersOn) {
    for (const t of dueNow) {
      showToast(t);
      if (sysNotifAvailable()) {
        try { new Notification("Catet — waktunya!", { body: t.text }); } catch {}
      }
    }
    if (dueNow.length) beep();
  }
  render(); // refresh relative times & overdue badges
}
