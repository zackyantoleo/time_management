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
// Ikon + label terpisah: di layar sempit label disembunyikan lewat CSS
// (.btn-label) supaya header tidak dipenuhi tombol bertumpuk tiga baris.
// Detail status ("di tab ini", dst.) cukup di title/tooltip.
function updateNotifBtn() {
  const btn = $("#notif-btn");
  let icon, label, title;
  if (!remindersOn) {
    icon = "🔕"; label = "Reminders off";
    title = "Klik untuk menyalakan pengingat waktu";
  } else if (sysNotifAvailable()) {
    icon = "🔔"; label = "Reminders on";
    title = "Pengingat lewat notifikasi sistem + di dalam halaman. Klik untuk mematikan.";
  } else {
    icon = "🔔"; label = "Reminders on";
    title = "Pengingat muncul di dalam halaman ini — notifikasi sistem belum diizinkan browser. Klik untuk mematikan.";
  }
  btn.textContent = icon;
  btn.append(el("span", "btn-label", " " + label));
  btn.title = title;
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
    el("div", "toast-title", "⏰ Time’s up!"),
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
  // Penanda notified = perubahan mesin — simpan tanpa mengklaim dirty,
  // supaya tab yang cuma nunggu pengingat tidak mendorong state basi.
  if (changed) saveTanpaSinkron();
  // Rutinitas berjam: ingatkan sekali per hari sampai dicentang.
  ensureRoutineDay();
  const nowHM = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  let rdayChanged = false;
  for (const r of todaysRoutines()) {
    if (r.time && r.time <= nowHM &&
        !rday.doneIds.includes(r.id) && !rday.notifiedIds.includes(r.id)) {
      rday.notifiedIds.push(r.id); rdayChanged = true;
      dueNow.push({ text: "Routine: " + r.text });
    }
  }
  if (rdayChanged) saveRday();
  // Meeting kalender yang baru mulai — pengingat "sudah jam meeting".
  // Tarik berkala (throttle di dalam) supaya notif jalan di tab mana pun.
  if (typeof tarikKalender === "function") tarikKalender(false);
  if (typeof checkMeetingsDue === "function") {
    for (const e of checkMeetingsDue()) {
      dueNow.push({ text: "📅 " + (e.summary || "(tanpa judul)") + " — " + fmtClock(new Date(e.start)) });
    }
  }
  if (remindersOn) {
    for (const t of dueNow) {
      showToast(t);
      if (sysNotifAvailable()) {
        try { new Notification("Catet — time’s up!", { body: t.text }); } catch {}
      }
    }
    if (dueNow.length) beep();
  }
  // Penyegaran berkala (waktu relatif, badge terlambat) hanya bila aman:
  // saat pengguna mengetik, render menghapus ketikannya; saat tab
  // tersembunyi, hasilnya tidak dilihat siapa-siapa (hemat baterai).
  // Toast/notifikasi di atas tetap tampil terlepas dari ini.
  if (!document.hidden && !sedangMengetik()) render();
}
