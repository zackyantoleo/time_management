// board.js — render papan: kartu fokus "Sedang dikerjakan", baris tugas,
// section per prioritas, bagian Selesai, dan badge judul tab.
"use strict";

function renderFocus() {
  const card = $("#focus-card");
  card.innerHTML = "";
  const t = tasks.find((x) => x.status === "fokus");
  const eyebrow = el("div", "eyebrow");
  if (t) {
    card.classList.remove("empty");
    const dot = el("span", "dot"); dot.setAttribute("aria-hidden", "true");
    eyebrow.append(dot, "Sedang dikerjakan");
    card.append(eyebrow);
    const ftext = el("div", "focus-text");
    ftext.append(linkify(t.text));
    card.append(ftext);
    const meta = el("div", "focus-meta mono");
    meta.textContent = "fokus sejak " + fmtAgo(t.focusedAt) +
      (t.due ? " · tenggat: " + fmtDue(t.due) : "");
    card.append(meta);
    const actions = el("div", "focus-actions");
    const doneBtn = el("button", "btn-solid", "✓ Selesai");
    doneBtn.onclick = () => { completeTask(t); render(); };
    const pauseBtn = el("button", "btn-line", "Tunda — balikin ke daftar");
    pauseBtn.onclick = () => { stopFocus(t); t.status = "aktif"; save(); render(); };
    const intBtn = el("button", "btn-line", "⚡ Ada interupsi? Catat dulu");
    intBtn.title = "Fokus tetap di tugas ini; catat interupsinya di kolom bawah";
    intBtn.onclick = () => { $("#cap-text").focus(); };
    actions.append(doneBtn, pauseBtn, intBtn);
    card.append(actions);
  } else {
    card.classList.add("empty");
    eyebrow.textContent = "Sedang dikerjakan";
    card.append(eyebrow);
    card.append(el("div", "focus-text",
      "Belum ada tugas yang difokuskan. Tekan ▶ pada tugas di daftar supaya tidak hilang saat kamu diinterupsi."));
  }
}

function taskRow(t) {
  const li = el("li", "task p-" + t.priority + (t.status === "selesai" ? " done" : ""));

  const check = el("button", "check", "✓");
  check.title = t.status === "selesai" ? "Tandai belum selesai" : "Tandai selesai";
  check.setAttribute("aria-label", check.title);
  check.onclick = () => {
    if (t.status === "selesai") uncompleteTask(t);
    else completeTask(t);
    render();
  };

  const body = el("div", "task-body");
  const text = el("div", "task-text");
  text.append(linkify(t.text));
  text.title = "Klik dua kali untuk mengedit";
  text.ondblclick = () => {
    text.contentEditable = "true"; text.focus();
    const range = document.createRange(); range.selectNodeContents(text);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  };
  const commit = () => {
    text.contentEditable = "false";
    const v = text.textContent.trim();
    if (v && v !== t.text) { t.text = v; save(); }
    render();
  };
  text.onblur = commit;
  text.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); text.blur(); }
    if (e.key === "Escape") { text.textContent = t.text; text.blur(); }
  };
  body.append(text);

  const meta = el("div", "task-meta");
  if (t.due && t.status !== "selesai") {
    const late = new Date(t.due) < new Date();
    meta.append(el("span", "due-badge mono" + (late ? " late" : ""), (late ? "⚠ " : "🕑 ") + fmtDue(t.due)));
  }
  if (t.status !== "selesai") {
    meta.append(el("span", "pr-tag pr-" + t.priority, PR_LABEL[t.priority]));
    meta.append(el("span", "effort-badge mono", "skor " + skorTugas(t) + "/10"));
    if (t.usaha) {
      const usahaLabel = { S: "⚡ ≤1 jam", M: "⏱ ±½ hari", L: "⏳ ≥1 hari" };
      meta.append(el("span", "effort-badge", usahaLabel[t.usaha]));
    }
    const sprint = t.sprintId ? sprintById(t.sprintId) : null;
    if (sprint) {
      const sb = el("span", "effort-badge" + (sprintPts(t) >= 3 ? " sprint-mepet" : ""), "🏃 " + sprint.nama);
      sb.title = "Sprint berakhir " + fmtDayName(sprint.selesai) + " (" + fmtSisaSprint(sprint) + ")";
      meta.append(sb);
    }
  }
  meta.append(el("span", "mono", "dicatat " + fmtAgo(t.createdAt)));
  if (t.status === "selesai" && t.doneAt) meta.append(el("span", "mono", "selesai " + fmtAgo(t.doneAt)));
  body.append(meta);

  const actions = el("div", "task-actions");
  if (t.status !== "selesai") {
    const focusBtn = el("button", "icon-btn", "▶");
    focusBtn.title = "Kerjakan sekarang (jadikan fokus)";
    focusBtn.setAttribute("aria-label", focusBtn.title);
    focusBtn.onclick = () => {
      const cur = tasks.find((x) => x.status === "fokus");
      if (cur && cur !== t) { stopFocus(cur); cur.status = "aktif"; }
      t.status = "fokus"; t.focusedAt = new Date().toISOString();
      save(); render();
    };
    actions.append(focusBtn);
  }
  const delBtn = el("button", "icon-btn danger", "✕");
  delBtn.title = "Hapus"; delBtn.setAttribute("aria-label", "Hapus");
  delBtn.onclick = () => {
    if (confirm("Hapus catatan ini?\n\n“" + t.text + "”")) {
      tasks = tasks.filter((x) => x.id !== t.id); save(); render();
    }
  };
  actions.append(delBtn);

  li.append(check, body, actions);
  return li;
}

// Papan fokus: satu daftar peringkat "Kerjakan hari ini" (diurutkan skor
// dinamis), sisanya dilipat ke "Nanti" supaya tidak mengganggu. Saat mencari,
// semua hasil (termasuk yang di Nanti) ditampilkan rata.
let nantiOpen = false;
function renderSections() {
  const wrap = $("#sections");
  wrap.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();
  const cocok = (t) => !q || t.text.toLowerCase().includes(q);
  const active = tasks.filter((t) => t.status === "aktif" && cocok(t)).sort(bandingkanTugas);

  const frag = document.createDocumentFragment();
  if (!q) renderRoutines(frag); // saat mencari, fokus ke hasil tugas saja

  const hariIni = q ? active : active.filter(masukHariIni);
  const nanti = q ? [] : active.filter((t) => !masukHariIni(t));

  const sec = el("section", "section s-today");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  head.append(el("h2", null, q ? "Hasil pencarian" : "🎯 Kerjakan hari ini"));
  if (hariIni.length) head.append(el("span", "count mono", String(hariIni.length)));
  sec.append(head);
  if (hariIni.length) {
    const ul = el("ul", "tasks");
    hariIni.forEach((t) => ul.append(taskRow(t)));
    sec.append(ul);
  } else {
    sec.append(el("div", "empty-note", q
      ? "Tidak ada tugas yang cocok dengan “" + searchQuery.trim() + "”. Coba juga tab Jira / Log kerja."
      : nanti.length
        ? "Tidak ada yang mendesak hari ini 🎉 — kalau senggang, ambil dari bagian “Nanti” di bawah."
        : "Daftar kosong. Semua yang mampir ke kepala — tiket baru, permintaan teman, follow-up meeting — catat di atas biar tidak lupa."));
  }
  frag.append(sec);

  if (nanti.length) {
    const det = document.createElement("details");
    det.className = "done-wrap section s-nanti";
    det.open = nantiOpen;
    det.addEventListener("toggle", () => { nantiOpen = det.open; });
    const sum = document.createElement("summary");
    sum.append("Nanti — belum perlu hari ini ", el("span", "count mono", String(nanti.length)));
    det.append(sum);
    const ul = el("ul", "tasks");
    nanti.forEach((t) => ul.append(taskRow(t)));
    det.append(ul);
    frag.append(det);
  }

  const done = tasks.filter((t) => t.status === "selesai" && cocok(t))
    .sort((a, b) => new Date(b.doneAt || 0) - new Date(a.doneAt || 0));
  if (done.length) {
    const det = document.createElement("details");
    det.className = "done-wrap section s-selesai";
    det.style.marginTop = "6px";
    const sum = document.createElement("summary");
    sum.append("Selesai ", el("span", "count mono", String(done.length)));
    const clear = el("button", "clear-done", "bersihkan");
    clear.onclick = (e) => {
      e.preventDefault();
      if (confirm("Hapus semua " + done.length + " catatan yang sudah selesai?")) {
        tasks = tasks.filter((t) => t.status !== "selesai"); save(); render();
      }
    };
    sum.append(clear);
    det.append(sum);
    const ul = el("ul", "tasks");
    done.forEach((t) => ul.append(taskRow(t)));
    det.append(ul);
    frag.append(det);
  }
  wrap.append(frag);
}

function renderTitle() {
  const urgent = tasks.filter((t) => t.status !== "selesai" &&
    (t.priority === "urgent" || (t.due && new Date(t.due) < new Date()))).length;
  document.title = (urgent ? "(" + urgent + ") " : "") + "Catet — catatan cepat berprioritas";
}
