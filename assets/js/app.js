// app.js — orkestrasi: state tampilan (papan/jira/log), pencarian, render(),
// dan inisialisasi. File ini dimuat TERAKHIR; semua binding DOM dan timer
// dipasang di sini.
"use strict";

let view = "papan"; // papan | jira | log
let searchQuery = ""; // filter untuk view yang sedang aktif

function setView(v) {
  view = v;
  $("#tab-papan").setAttribute("aria-selected", String(v === "papan"));
  $("#tab-jira").setAttribute("aria-selected", String(v === "jira"));
  $("#tab-log").setAttribute("aria-selected", String(v === "log"));
  document.querySelectorAll(".board-view").forEach((n) => n.classList.toggle("hidden", v !== "papan"));
  $("#jiraview").classList.toggle("hidden", v !== "jira");
  $("#worklog").classList.toggle("hidden", v !== "log");
  render();
}

function render() {
  if (view === "papan") { renderFocus(); renderSections(); }
  else if (view === "jira") renderJiraInbox();
  else renderWorklog();
  $("#tab-jira").textContent = "🎫 Jira" + (jira.items.length ? " (" + jira.items.length + ")" : "");
  updateSprintChip();
  renderTitle();
}

// Offline di HP: service worker hanya jalan bila di-serve lewat https/localhost,
// tidak dari file:// atau lingkungan tanpa dukungan SW.
function initApp() {
  $("#tab-papan").onclick = () => setView("papan");
  $("#tab-jira").onclick = () => setView("jira");
  $("#tab-log").onclick = () => setView("log");
  $("#search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });
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
