// routines.js — rutinitas harian (standup, cek email, dst.): state, reset per
// tanggal, checklist, editor kelola, dan render section-nya.
// Kunci localStorage: catet.routines.v1, catet.routineday.v1.
"use strict";

/* ---------- daily routines (standup, cek email, dst.) ---------- */
const ROUTINE_KEY = "catet.routines.v1";
const RDAY_KEY = "catet.routineday.v1";
let routines = (() => {
  try { return JSON.parse(localStorage.getItem(ROUTINE_KEY)) || []; }
  catch { return []; }
})();
let rday = (() => {
  try { return JSON.parse(localStorage.getItem(RDAY_KEY)) || null; }
  catch { return null; }
})();
function saveRoutines() { localStorage.setItem(ROUTINE_KEY, JSON.stringify(routines)); if (typeof syncDirty === "function") syncDirty(); }
// Sengaja TIDAK memanggil syncDirty(): reset harian otomatis bukan perubahan
// dari pengguna — kalau ikut menandai dirty, perangkat yang baru dibuka akan
// mengaku "lebih baru" dan menimpa state server. Centang rutinitas tetap
// tersinkron karena toggleRoutine juga menulis worklog (yang menandai dirty).
function saveRday() { localStorage.setItem(RDAY_KEY, JSON.stringify(rday)); }
// Centang & status pengingat rutinitas hanya berlaku untuk satu tanggal;
// ganti hari = checklist kosong lagi.
function ensureRoutineDay() {
  const today = localDateStr(new Date());
  if (!rday || rday.date !== today) {
    rday = { date: today, doneIds: [], notifiedIds: [] };
    saveRday();
  }
}
function todaysRoutines() {
  ensureRoutineDay();
  const dow = new Date().getDay();
  return routines.filter((r) => r.days.includes(dow));
}
function routineInstanceId(r) { return "rutin:" + r.id + "@" + rday.date; }
function toggleRoutine(r) {
  ensureRoutineDay();
  const iid = routineInstanceId(r);
  if (rday.doneIds.includes(r.id)) {
    rday.doneIds = rday.doneIds.filter((id) => id !== r.id);
    for (let i = worklog.length - 1; i >= 0; i--) {
      if (worklog[i].taskId === iid) { worklog.splice(i, 1); break; }
    }
  } else {
    rday.doneIds.push(r.id);
    const now = new Date();
    worklog.push({
      id: uid(), taskId: iid, date: rday.date, ts: now.toISOString(),
      text: r.text, priority: "rutin", mins: 0,
    });
  }
  saveRday(); saveWorklog();
}

/* ---------- routines rendering ---------- */
let routineManageOpen = false;
let newRoutineDays = new Set([1, 2, 3, 4, 5]); // default hari kerja
function fmtDays(days) {
  if (days.length === 7) return "every day";
  const sorted = [...days].sort();
  if (sorted.join() === "1,2,3,4,5") return "Sen–Jum";
  return sorted.map((d) => HARI_PENDEK[d]).join(", ");
}
function renderRoutines(frag) {
  const items = todaysRoutines();
  const sec = el("section", "section s-rutin");
  sec.style.marginBottom = "18px";
  const head = el("div", "section-head");
  const doneCount = items.filter((r) => rday.doneIds.includes(r.id)).length;
  head.append(el("h2", null, "Today’s routines"));
  if (items.length) head.append(el("span", "count mono", doneCount + "/" + items.length));
  sec.append(head);

  if (items.length) {
    const card = el("div", "routine-card");
    for (const r of items.sort((a, b) => (a.time || "99") < (b.time || "99") ? -1 : 1)) {
      const done = rday.doneIds.includes(r.id);
      const row = el("div", "routine-row" + (done ? " done" : ""));
      const check = el("button", "check", "✓");
      if (done) { check.style.background = "var(--accent)"; check.style.borderColor = "var(--accent)"; check.style.color = "var(--accent-ink)"; }
      check.title = done ? "Tandai belum" : "Tandai selesai";
      check.setAttribute("aria-label", check.title);
      check.onclick = () => { toggleRoutine(r); render(); };
      row.append(check);
      row.append(el("span", "r-text", r.text));
      if (r.time) row.append(el("span", "due-badge mono", "🕑 " + r.time.replace(":", ".")));
      card.append(row);
    }
    sec.append(card);
  } else if (routines.length) {
    sec.append(el("div", "empty-note", "Tidak ada rutinitas untuk hari ini."));
  }

  const det = document.createElement("details");
  det.className = "routine-manage";
  det.open = routineManageOpen;
  det.addEventListener("toggle", () => { routineManageOpen = det.open; });
  const sum = document.createElement("summary");
  sum.textContent = routines.length ? "manage routines" : "+ add routine (mis. daily standup, cek email)";
  det.append(sum);

  const editor = el("div", "routine-editor");
  if (routines.length) {
    const list = el("ul", "routine-list");
    for (const r of routines) {
      const li = el("li");
      li.append(el("span", "r-text", r.text));
      if (r.time) li.append(el("span", "r-days mono", r.time.replace(":", ".")));
      li.append(el("span", "r-days", fmtDays(r.days)));
      const del = el("button", "icon-btn danger", "✕");
      del.title = "Hapus rutinitas"; del.setAttribute("aria-label", "Hapus rutinitas");
      del.onclick = () => {
        if (confirm("Hapus rutinitas “" + r.text + "”?")) {
          routines = routines.filter((x) => x.id !== r.id);
          saveRoutines(); render();
        }
      };
      li.append(del);
      list.append(li);
    }
    editor.append(list);
  }

  const form = el("div", "routine-form");
  const txt = document.createElement("input");
  txt.type = "text"; txt.id = "routine-text";
  txt.placeholder = "New routine… mis. “daily standup”";
  const time = document.createElement("input");
  time.type = "time"; time.id = "routine-time";
  time.title = "Jam pengingat (opsional)";
  const dayWrap = el("div", "day-chips");
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const chip = el("button", "day-chip", HARI_PENDEK[d]);
    chip.setAttribute("aria-pressed", String(newRoutineDays.has(d)));
    chip.onclick = () => {
      if (newRoutineDays.has(d)) newRoutineDays.delete(d); else newRoutineDays.add(d);
      chip.setAttribute("aria-pressed", String(newRoutineDays.has(d)));
    };
    dayWrap.append(chip);
  }
  const addBtn = el("button", "btn-solid", "Add");
  const addRoutine = () => {
    const text = txt.value.trim();
    if (!text || !newRoutineDays.size) return;
    routines.push({ id: uid(), text, time: time.value || null, days: [...newRoutineDays] });
    saveRoutines(); routineManageOpen = true; render();
  };
  addBtn.onclick = addRoutine;
  txt.addEventListener("keydown", (e) => { if (e.key === "Enter") addRoutine(); });
  form.append(txt, time, dayWrap, addBtn);
  editor.append(form);
  det.append(editor);
  sec.append(det);
  frag.append(sec);
}
