// app.js — orkestrasi: state tampilan (papan/jira/log), pencarian, render(),
// dan inisialisasi. File ini dimuat TERAKHIR; semua binding DOM dan timer
// dipasang di sini.
"use strict";

// Tab aktif diingat per perangkat — refresh tidak melempar balik ke Board.
const VIEW_KEY = "catet.view.v1";
let view = (() => {
  const v = localStorage.getItem(VIEW_KEY);
  return ["papan", "jira", "kalender", "log", "settings"].includes(v) ? v : "papan";
})(); // papan | jira | kalender | log | settings
// Pencarian per tab — query Board tidak ikut memfilter Jira/Log, dan
// sebaliknya. Kotaknya satu; isinya mengikuti tab aktif. Settings tak punya
// isi yang bisa dicari, jadi kotaknya disembunyikan di tab itu.
let searchPerTab = { papan: "", jira: "", kalender: "", log: "", settings: "" };
let searchQuery = ""; // query tab aktif (dibaca para renderer)
const SEARCH_PLACEHOLDER = {
  papan: "Search tasks…",
  jira: "Search tickets / sprints / topics…",
  kalender: "Search events…",
  log: "Search work log…",
  settings: "",
};

function setView(v) {
  view = v;
  localStorage.setItem(VIEW_KEY, v); // preferensi perangkat, tidak ikut sinkron
  searchQuery = searchPerTab[v] || "";
  const s = $("#search");
  s.value = searchQuery;
  s.placeholder = SEARCH_PLACEHOLDER[v];
  s.classList.toggle("hidden", v === "settings");
  $("#tab-papan").setAttribute("aria-selected", String(v === "papan"));
  $("#tab-jira").setAttribute("aria-selected", String(v === "jira"));
  $("#tab-kalender").setAttribute("aria-selected", String(v === "kalender"));
  $("#tab-log").setAttribute("aria-selected", String(v === "log"));
  $("#settings-btn").setAttribute("aria-pressed", String(v === "settings"));
  document.querySelectorAll(".board-view").forEach((n) => n.classList.toggle("hidden", v !== "papan"));
  $("#jiraview").classList.toggle("hidden", v !== "jira");
  $("#calview").classList.toggle("hidden", v !== "kalender");
  $("#worklog").classList.toggle("hidden", v !== "log");
  $("#settingsview").classList.toggle("hidden", v !== "settings");
  render();
}

function render() {
  const signedIn = !!jiraProxy();
  document.body.classList.toggle("signed-out", !signedIn);
  if (!signedIn) {
    dailyPriority = null;
    const targets = [$("#sections"), $("#jiraview"), $("#calview"), $("#worklog")];
    for (const n of targets) if (n) n.innerHTML = "";
    if (view === "settings") renderSettings();
    else {
      const target = view === "papan" ? $("#sections")
        : view === "jira" ? $("#jiraview")
        : view === "kalender" ? $("#calview") : $("#worklog");
      target.append(el("div", "empty-note auth-empty",
        "Belum ada data. Sign in dengan access code lewat ⚙ Settings."));
    }
    $("#tab-jira").textContent = "🎫 Jira";
    updateSprintChip();
    renderTitle();
    return;
  }
  if (view === "papan") { renderDailyPriority(); renderFocus(); renderSections(); }
  else if (view === "jira") renderJiraInbox();
  else if (view === "kalender") renderCalendar();
  else if (view === "settings") renderSettings();
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
  $("#tab-kalender").onclick = () => setView("kalender");
  $("#tab-log").onclick = () => setView("log");
  $("#settings-btn").onclick = () => setView("settings");
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
  setView(view); // pulihkan tab terakhir (markup default HTML = papan)
  initSync(); // pull state → sinkron Jira → push tertunda (urutan di sync.js)
}
initApp();
