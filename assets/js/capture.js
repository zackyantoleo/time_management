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

let capSprintId = null; // chip "🏃 Sprint": sprint tujuan untuk tugas baru

function addTask(text) {
  text = text.trim();
  if (!text) return;
  const s = scoreOpen ? hitungSkor() : null;
  const sprint = capSprintId ? sprintById(capSprintId) : null;
  tasks.push({
    id: uid(), text, priority: capPriority, due: resolveDue(),
    createdAt: new Date().toISOString(),
    status: "aktif", doneAt: null, focusedAt: null, notified: false,
    dampak: s ? scDampak : null, usaha: s ? scUsaha : null, skor: s ? s.skor : null,
    sprintId: sprint ? sprint.id : null,
  });
  resetScore();
  save(); render();
}

// Chip sprint: tampil bila ada sprint; klik → menu pilih sprint tujuan.
// Sprint yang dipilih menempel sampai diganti (sticky, seperti chip prioritas).
function updateSprintChip() {
  const btn = $("#sprint-capture");
  if (!sprintAktifList().length) { capSprintId = null; btn.classList.add("hidden"); return; }
  if (capSprintId && !sprintById(capSprintId)) capSprintId = null; // sprint dihapus
  const s = capSprintId ? sprintById(capSprintId) : null;
  btn.classList.remove("hidden");
  btn.textContent = s ? "🏃 " + s.nama : "🏃 Sprint";
  btn.title = s ? "Tugas baru masuk sprint “" + s.nama + "” — klik untuk ganti/lepas"
    : "Pilih sprint untuk tugas baru";
  btn.setAttribute("aria-pressed", String(!!s));
}

/* ---------- skoring: "seberapa penting & harus mulai kapan?" ----------
   Tiga masukan: dampak kalau ditunda (1–3), perkiraan usaha (S/M/L), dan
   tenggat yang sudah dipilih di chip "Kapan". Hasilnya saran prioritas +
   kapan mulai — chip prioritas ikut di-set otomatis, tapi tetap bisa
   diubah manual. Inti aturannya: tugas LAMA yang bertenggat harus dimulai
   jauh lebih awal daripada tugas cepat, walau dampaknya sama. */
let scoreOpen = false;
let scDampak = null; // 1 aman | 2 mengganggu | 3 memblokir
let scUsaha = null;  // S ≤1 jam | M ±setengah hari | L ≥1 hari

function duePoints() {
  if (capDue.kind === "today") return 3;
  if (capDue.kind === "tomorrow-am") return 2;
  if (capDue.kind === "custom" && capDue.value) {
    const h = (new Date(capDue.value) - Date.now()) / 3600000;
    return h <= 24 ? 3 : h <= 48 ? 2 : 1;
  }
  return 0;
}
function hitungSkor() {
  if (!scDampak) return null;
  const dPts = duePoints();
  const uPts = scUsaha === "L" ? 2 : scUsaha === "M" ? 1 : 0;
  const skor = Math.min(10, Math.round((scDampak * 2 + dPts + uPts) / 11 * 10));

  let prio;
  if (scDampak === 3 && (dPts >= 2 || uPts === 2)) prio = "urgent";
  else if (scDampak === 3 || (scDampak === 2 && dPts >= 2)) prio = "tinggi";
  else if (scDampak === 2 || dPts >= 2) prio = "sedang";
  else prio = "rendah";

  let saran;
  if (dPts >= 3) saran = "mulai sekarang — tenggatnya hari ini";
  else if (scUsaha === "L" && dPts >= 2) saran = "mulai hari ini — tugas lama dengan tenggat dekat, cicil dari sekarang";
  else if (scDampak === 3) saran = "kerjakan hari ini — ada yang terblokir";
  else if (scUsaha === "L") saran = "jadwalkan blok waktu — jangan tunggu mepet";
  else if (dPts >= 2) saran = "kerjakan besok pagi";
  else saran = "selipkan saat senggang";
  return { skor, prio, saran };
}
const PRIO_LABEL_SARAN = { urgent: "Urgent", tinggi: "Tinggi", sedang: "Sedang", rendah: "Rendah" };
function updateScoreVerdict() {
  const v = $("#score-verdict");
  const s = hitungSkor();
  if (!s) { v.textContent = "Pilih dampak (dan usaha) — saran prioritas & kapan mulai muncul di sini."; return; }
  v.innerHTML = "";
  v.append("Skor ", el("strong", null, s.skor + "/10"), " — saran: prioritas ",
    el("strong", null, PRIO_LABEL_SARAN[s.prio]), ", " + s.saran + ".");
  setPriority(s.prio);
}
function resetScore() {
  scDampak = null; scUsaha = null;
  document.querySelectorAll(".chip.sc").forEach((b) => b.setAttribute("aria-pressed", "false"));
  if (scoreOpen) updateScoreVerdict();
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
  $("#sprint-capture").onclick = (e) => {
    e.stopPropagation();
    bukaSprintMenu($("#sprint-capture"), capSprintId, (id) => { capSprintId = id; updateSprintChip(); });
  };
  $("#score-toggle").onclick = () => {
    scoreOpen = !scoreOpen;
    $("#score-toggle").setAttribute("aria-pressed", String(scoreOpen));
    $("#score-panel").classList.toggle("hidden", !scoreOpen);
    if (scoreOpen) updateScoreVerdict();
  };
  document.querySelectorAll(".chip.sc[data-dampak]").forEach((btn) => {
    btn.onclick = () => {
      scDampak = Number(btn.dataset.dampak);
      document.querySelectorAll(".chip.sc[data-dampak]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      updateScoreVerdict();
    };
  });
  document.querySelectorAll(".chip.sc[data-usaha]").forEach((btn) => {
    btn.onclick = () => {
      scUsaha = btn.dataset.usaha;
      document.querySelectorAll(".chip.sc[data-usaha]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      updateScoreVerdict();
    };
  });
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

  // Skor ikut tenggat: perubahan chip "Kapan" menyegarkan saran.
  document.querySelectorAll(".chip[data-due]").forEach((btn) => {
    const orig = btn.onclick;
    btn.onclick = () => { orig(); if (scoreOpen) updateScoreVerdict(); };
  });
  const origDueCustom = $("#cap-due-custom").onchange;
  $("#cap-due-custom").onchange = (e) => { origDueCustom(e); if (scoreOpen) updateScoreVerdict(); };
}
