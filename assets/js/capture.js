// capture.js — kolom "catat cepat": prioritas, waktu (kapan), dan pembuatan tugas.
"use strict";

let capPriority = "sedang";
let capDue = { kind: "none" }; // none | today | tomorrow-am | custom(value)

function resolveDue() {
  const now = new Date();
  if (capDue.kind === "today") {
    const d = new Date(now); d.setHours(17, 0, 0, 0);
    if (d <= now) d.setTime(now.getTime() + 60 * 60 * 1000);
    return d.toISOString();
  }
  if (capDue.kind === "tomorrow-am") {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
    return d.toISOString();
  }
  if (capDue.kind === "custom" && capDue.value) return new Date(capDue.value).toISOString();
  return null;
}

function addTask(text) {
  text = text.trim();
  if (!text) return;
  tasks.push({
    id: uid(), text, priority: capPriority, due: resolveDue(),
    createdAt: new Date().toISOString(),
    status: "aktif", doneAt: null, focusedAt: null, notified: false,
  });
  save(); render();
}

function setPriority(pr) {
  capPriority = pr;
  document.querySelectorAll(".chip[data-pr]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.pr === pr)));
}
function syncDueChips(activeKind) {
  document.querySelectorAll(".chip[data-due]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.due === activeKind)));
}

// Dipanggil sekali dari app.js setelah DOM siap.
function initCapture() {
  $("#cap-save").onclick = () => { addTask($("#cap-text").value); $("#cap-text").value = ""; $("#cap-text").focus(); };
  $("#cap-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { addTask(e.target.value); e.target.value = ""; }
  });
  document.querySelectorAll(".chip[data-pr]").forEach((btn) => {
    btn.onclick = () => setPriority(btn.dataset.pr);
  });
  document.querySelectorAll(".chip[data-due]").forEach((btn) => {
    btn.onclick = () => {
      capDue = { kind: btn.dataset.due === "none" ? "none" : btn.dataset.due };
      $("#cap-due-custom").value = "";
      syncDueChips(btn.dataset.due);
    };
  });
  $("#cap-due-custom").onchange = (e) => {
    if (e.target.value) { capDue = { kind: "custom", value: e.target.value }; syncDueChips(null); }
  };
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key >= "1" && e.key <= "4") {
      e.preventDefault();
      setPriority(PRIORITIES[Number(e.key) - 1].id);
      $("#cap-text").focus();
    }
  });
}
