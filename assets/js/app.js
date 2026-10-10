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
function labelTabJira() {
  const btn = $("#tab-jira");
  btn.innerHTML = "<span aria-hidden=\"true\">◫</span><span class=\"tab-label\">Jira" +
    (jira.items.length ? " (" + jira.items.length + ")" : "") + "</span>";
}

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
  document.querySelectorAll("[role=tab]").forEach(n => {
    n.tabIndex = n.getAttribute("aria-selected") === "true" || (v === "settings" && n.id === "tab-papan") ? 0 : -1;
  });
  $("#settings-btn").setAttribute("aria-pressed", String(v === "settings"));
  document.querySelectorAll(".board-view").forEach((n) => n.classList.toggle("hidden", v !== "papan"));
  $("#jiraview").classList.toggle("hidden", v !== "jira");
  $("#calview").classList.toggle("hidden", v !== "kalender");
  $("#worklog").classList.toggle("hidden", v !== "log");
  $("#settingsview").classList.toggle("hidden", v !== "settings");
  render();
}

function updateBoardLayout() {
  if (view !== "papan") return;
  renderSprintContext();
  renderRoutineContext();
}

function render() {
  const active = document.activeElement;
  const owner = active && active.closest("[data-task-id], [data-log-id]");
  const focus = owner && { task: owner.dataset.taskId, log: owner.dataset.logId,
    index: [...owner.querySelectorAll("button, a, summary")].indexOf(active) };
  // One immutable evaluator snapshot per synchronous render, never across edits.
  renderPriorityEvaluator = CatetPriorityEngine.createEvaluator({ tasks, sprints, jira, now: new Date() });
  try { renderView(); } finally { renderPriorityEvaluator = null; }
  if (focus && !active.isConnected) {
    const row = [...document.querySelectorAll("[data-task-id], [data-log-id]")]
      .find(n => focus.task ? n.dataset.taskId === focus.task : n.dataset.logId === focus.log);
    const control = row && row.querySelectorAll("button, a, summary")[focus.index];
    if (control) control.focus({ preventScroll: true });
  }
}

function renderView() {
  const signedIn = !!jiraProxy();
  document.body.classList.toggle("signed-out", !signedIn);
  if (!signedIn) {
    dailyPriority = null;
    const targets = [$("#focus-card"), $("#daily-priority"), $("#sections"),
      $("#sprint-context"), $("#routine-context"), $("#jiraview"), $("#calview"), $("#worklog")];
    for (const n of targets) if (n) n.innerHTML = "";
    if (view === "settings") renderSettings();
    else {
      const target = view === "papan" ? $("#sections")
        : view === "jira" ? $("#jiraview")
        : view === "kalender" ? $("#calview") : $("#worklog");
      target.append(el("div", "empty-note auth-empty",
        "Belum ada data. Sign in dengan access code lewat ⚙ Settings."));
    }
    labelTabJira();
    updateSprintChip();
    renderTitle();
    renderReadyNotifications();
    return;
  }
  if (view === "papan") { renderDailyPriority(); renderFocus(); renderSections(); updateBoardLayout(); }
  else if (view === "jira") renderJiraInbox();
  else if (view === "kalender") renderCalendar();
  else if (view === "settings") renderSettings();
  else renderWorklog();
  labelTabJira();
  updateSprintChip();
  renderTitle();
  renderReadyNotifications();
}

// Offline di HP: service worker hanya jalan bila di-serve lewat https/localhost,
// tidak dari file:// atau lingkungan tanpa dukungan SW.
function initApp() {
  initThemeToggle();
  $("#tab-papan").onclick = () => setView("papan");
  $("#tab-jira").onclick = () => setView("jira");
  $("#tab-kalender").onclick = () => setView("kalender");
  $("#tab-log").onclick = () => setView("log");
  const tabs = ["papan", "jira", "kalender", "log"];
  document.querySelectorAll("[role=tab]").forEach((tab, index, nodes) => {
    tab.onkeydown = e => {
      let next;
      if (e.key === "ArrowRight") next = (index + 1) % nodes.length;
      else if (e.key === "ArrowLeft") next = (index + nodes.length - 1) % nodes.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = nodes.length - 1;
      else return;
      e.preventDefault(); setView(tabs[next]); nodes[next].focus();
    };
  });
  $("#settings-btn").onclick = () => setView("settings");
  $("#ready-alert-btn").onclick = () => {
    const panel = $("#ready-alert-panel");
    const open = panel.classList.toggle("hidden");
    $("#ready-alert-btn").setAttribute("aria-expanded", String(!open));
  };
  $("#ready-alert-close").onclick = () => {
    $("#ready-alert-panel").classList.add("hidden");
    $("#ready-alert-btn").setAttribute("aria-expanded", "false");
  };
  $("#capture-more").onclick = () => {
    const panel = $("#capture-options");
    const open = panel.classList.toggle("hidden") === false;
    $("#capture-more").setAttribute("aria-expanded", String(open));
    $("#capture-more").textContent = open ? "Less" : "Options";
  };
  $("#search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    searchPerTab[view] = searchQuery;
    render();
  });
  $("#search").placeholder = SEARCH_PLACEHOLDER[view];
  initCapture();
  initReminders();
  initBackup();
  initWeeklyCheckin();
  backfillWorklog();
  arsipkanTugasSelesai(); // setelah backfill — log-nya dijamin sudah tercatat
  // Calendar import berjalan setiap kali data kalender berhasil ditarik. Saat
  // data sudah ada sebelum refresh, import ulang tetap aman karena idempotent.
  // Collapse dulu entri dobel dari key scheme lama (UID vs fallback).
  if (typeof dedupeCalendarWorklogEntries === "function" &&
      dedupeCalendarWorklogEntries()) {
    if (typeof saveWorklog === "function") saveWorklog();
    else if (typeof saveWorklogTanpaSinkron === "function") saveWorklogTanpaSinkron();
  }
  if (typeof importLoadedCalendarEvents === "function") importLoadedCalendarEvents();
  // checkDue melewatkan render saat tab tersembunyi; segarkan waktu relatif
  // yang basi begitu tab terlihat lagi.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !sedangMengetik()) {
      render();
      if (typeof refreshWrappedWeekChip === "function") refreshWrappedWeekChip();
    }
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
  initWrappedWeekChip();
  initSync(); // pull state → sinkron Jira → push tertunda (urutan di sync.js)
}
initApp();
