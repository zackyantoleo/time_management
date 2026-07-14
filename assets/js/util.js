// util.js — helper umum: seleksi DOM, pembuatan elemen, id, format tanggal/waktu, salin teks.
// Tidak menyentuh state aplikasi; aman dipakai dari file mana pun.
"use strict";

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function localDateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/* ---------- time formatting ---------- */
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
function fmtClock(d) {
  return String(d.getHours()).padStart(2, "0") + "." + String(d.getMinutes()).padStart(2, "0");
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtDue(iso) {
  const d = new Date(iso), now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d < now) {
    const mins = Math.round((now - d) / 60000);
    if (mins < 60) return "terlambat " + mins + " mnt";
    if (mins < 60 * 24) return "terlambat " + Math.round(mins / 60) + " jam";
    return "terlambat " + Math.round(mins / 1440) + " hari";
  }
  if (sameDay(d, now)) return "hari ini " + fmtClock(d);
  if (sameDay(d, tomorrow)) return "besok " + fmtClock(d);
  return HARI[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1) + " " + fmtClock(d);
}
function fmtAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return mins + " mnt lalu";
  const h = Math.floor(mins / 60);
  if (h < 24) return h + " jam " + (mins % 60) + " mnt";
  return Math.floor(h / 24) + " hari lalu";
}

const HARI_PENDEK = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const HARI_FULL = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
function fmtDayName(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return HARI_FULL[date.getDay()] + ", " + d + " " + BULAN[m - 1] + " " + y;
}
function fmtDayHeading(dateStr) {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  let label = fmtDayName(dateStr);
  if (dateStr === localDateStr(new Date())) label = "Hari ini — " + label;
  else if (dateStr === localDateStr(yesterday)) label = "Kemarin — " + label;
  return label;
}
function fmtMins(mins) {
  if (!mins || mins < 1) return null;
  if (mins < 60) return mins + " mnt";
  return Math.floor(mins / 60) + " j " + (mins % 60) + " mnt";
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = "Tersalin ✓";
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch {}
  ta.remove();
}
