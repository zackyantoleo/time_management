// app.js — orkestrasi: state tampilan (papan/jira/log), pencarian, render(),
// dan inisialisasi. File ini dimuat TERAKHIR; semua binding DOM dan timer
// dipasang di sini.
"use strict";

let view = "papan"; // papan | jira | log
// Pencarian per tab — query Board tidak ikut memfilter Jira/Log, dan
// sebaliknya. Kotaknya satu; isinya mengikuti tab aktif.
let searchPerTab = { papan: "", jira: "", log: "" };
let searchQuery = ""; // query tab aktif (dibaca para renderer)
const SEARCH_PLACEHOLDER = {
  papan: "Search tasks…",
  jira: "Search tickets / sprints / topics…",
  log: "Search work log…",
};

function setView(v) {
  view = v;
  searchQuery = searchPerTab[v] || "";
  const s = $("#search");
  s.value = searchQuery;
  s.placeholder = SEARCH_PLACEHOLDER[v];
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
    searchPerTab[view] = searchQuery;
    render();
  });
  $("#search").placeholder = SEARCH_PLACEHOLDER[view];
  initCapture();
  initReminders();
  initBackup();
  backfillWorklog();
  arsipkanTugasSelesai(); // setelah backfill — log-nya dijamin sudah tercatat
  // checkDue melewatkan render saat tab tersembunyi; segarkan waktu relatif
  // yang basi begitu tab terlihat lagi.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !sedangMengetik()) render();
  });
  setInterval(checkDue, 30000);
  setInterval(() => syncJira(false), 5 * 60 * 1000);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    // Auto-update: begitu service worker versi baru mengambil alih, muat ulang
    // sekali supaya pengguna langsung dapat build terbaru (tanpa clear cache
    // manual). Juga cek update tiap kali app kembali aktif.
    let sudahReload = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (sudahReload) return;
      sudahReload = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.update();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
    }).catch(() => {});
  }
  render();
  initSync(); // pull state → sinkron Jira → push tertunda (urutan di sync.js)
}
initApp();
