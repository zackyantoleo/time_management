// app.js — orkestrasi: state tampilan (papan/log), render(), dan inisialisasi.
// File ini dimuat TERAKHIR; semua binding DOM dan timer dipasang di sini.
"use strict";

let view = "papan"; // papan | log

function setView(v) {
  view = v;
  $("#tab-papan").setAttribute("aria-selected", String(v === "papan"));
  $("#tab-log").setAttribute("aria-selected", String(v === "log"));
  document.querySelectorAll(".board-view").forEach((n) => n.classList.toggle("hidden", v !== "papan"));
  $("#worklog").classList.toggle("hidden", v !== "log");
  render();
}

function render() {
  if (view === "papan") { renderFocus(); renderSections(); }
  else renderWorklog();
  renderTitle();
}

// Offline di HP: service worker hanya jalan bila di-serve lewat https/localhost,
// tidak dari file:// atau lingkungan tanpa dukungan SW.
function initApp() {
  $("#tab-papan").onclick = () => setView("papan");
  $("#tab-log").onclick = () => setView("log");
  initCapture();
  initReminders();
  backfillWorklog();
  setInterval(checkDue, 30000);
  setInterval(() => syncJira(false), 5 * 60 * 1000);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  render();
  if (jiraProxy()) syncJira(false);
}
initApp();
