// weekly-checkin.js — kontrak manual start/end-week untuk Weekly Wrapped.
// Local-first dan optional; tidak menjalankan collector, scoring, atau AI.
"use strict";

const WEEKLY_KEY = "catet.weekly.v1";
const WEEKLY_SCHEMA_VERSION = 1;
const WEEKLY_EFFORTS = new Set(["S", "M", "L"]);

function normalisasiWeeklyStore(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const weeks = source.weeks && typeof source.weeks === "object" && !Array.isArray(source.weeks) ? source.weeks : {};
  return { ...source, schemaVersion: WEEKLY_SCHEMA_VERSION, weeks };
}

let weekly = (() => {
  try { return normalisasiWeeklyStore(JSON.parse(localStorage.getItem(WEEKLY_KEY))); }
  catch { return normalisasiWeeklyStore(null); }
})();

function jakartaDateParts(date) {
  const values = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date)) values[part.type] = part.value;
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}
function isoWeekParts(date) {
  const parts = jakartaDateParts(date);
  const thursday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));
  return { year: weekYear, week };
}
function weeklyPeriodKey(date = new Date()) {
  const parts = isoWeekParts(date);
  return `${parts.year}-W${String(parts.week).padStart(2, "0")}`;
}
function weeklyPeriodDates(date = new Date()) {
  const parts = jakartaDateParts(date);
  const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const monday = new Date(current);
  monday.setUTCDate(current.getUTCDate() - ((current.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { monday, sunday };
}
function weeklyPeriodLabel(date = new Date()) {
  const { monday, sunday } = weeklyPeriodDates(date);
  const format = (d) => d.toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "short" });
  return `${format(monday)}–${format(sunday)} ${sunday.getUTCFullYear()}`;
}

function weeklyText(value, field, required = false, max = 1200) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (required && !clean) throw new Error(`${field} wajib diisi.`);
  if (clean.length > max) throw new Error(`${field} terlalu panjang.`);
  return clean;
}
function validateWeeklyStart(input) {
  const outcomes = Array.isArray(input && input.outcomes) ? input.outcomes : [];
  const active = outcomes.map((item) => ({
    outcome: weeklyText(item && item.outcome, "Outcome", false, 500),
    doneDefinition: weeklyText(item && item.doneDefinition, "Definition of done", false, 700),
    effort: WEEKLY_EFFORTS.has(item && item.effort) ? item.effort : "M",
    risk: weeklyText(item && item.risk, "Dependency/risk", false, 700),
  })).filter((item) => item.outcome || item.doneDefinition || item.risk);
  if (!active.length) throw new Error("Isi minimal satu outcome.");
  if (active.length > 3) throw new Error("Maksimal 3 outcome per minggu.");
  for (const item of active) {
    if (!item.outcome) throw new Error("Outcome wajib diisi.");
    if (!item.doneDefinition) throw new Error("Definition of done wajib diisi untuk setiap outcome.");
  }
  return {
    outcomes: active,
    capacityException: weeklyText(input && input.capacityException, "Capacity exception", false, 1000),
  };
}
function weeklyRating(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 5) throw new Error("Focus, energy, dan load harus 1–5.");
  return numeric;
}
function validateWeeklyEnd(input) {
  return {
    highestImpact: weeklyText(input && input.highestImpact, "Highest impact", true, 1500),
    hiddenWork: weeklyText(input && input.hiddenWork, "Hidden work", false, 1500),
    unfinished: weeklyText(input && input.unfinished, "Unfinished work", true, 1500),
    decisionToChange: weeklyText(input && input.decisionToChange, "Decision to change", true, 1500),
    externalFeedback: weeklyText(input && input.externalFeedback, "External feedback", false, 1500),
    wellbeingContext: weeklyText(input && input.wellbeingContext, "Rating context", false, 1000),
    focus: weeklyRating(input && input.focus),
    energy: weeklyRating(input && input.energy),
    load: weeklyRating(input && input.load),
  };
}

function saveWeeklyStore() {
  localStorage.setItem(WEEKLY_KEY, JSON.stringify(weekly));
  if (typeof syncDirty === "function") syncDirty();
}
function saveWeeklyStart(periodKey, input, savedAt = new Date().toISOString()) {
  const current = weekly.weeks[periodKey] && typeof weekly.weeks[periodKey] === "object" ? weekly.weeks[periodKey] : {};
  weekly.weeks[periodKey] = { ...current, start: { ...validateWeeklyStart(input), savedAt } };
  saveWeeklyStore();
  return weekly.weeks[periodKey].start;
}
function saveWeeklyEnd(periodKey, input, savedAt = new Date().toISOString()) {
  const current = weekly.weeks[periodKey] && typeof weekly.weeks[periodKey] === "object" ? weekly.weeks[periodKey] : {};
  weekly.weeks[periodKey] = { ...current, end: { ...validateWeeklyEnd(input), savedAt } };
  saveWeeklyStore();
  return weekly.weeks[periodKey].end;
}
function adoptWeeklyStore(value) {
  weekly = normalisasiWeeklyStore(value);
  localStorage.setItem(WEEKLY_KEY, JSON.stringify(weekly));
}

function weeklyOutcomeRow(index, value = {}) {
  const row = el("div", "weekly-outcome-row");
  row.dataset.index = String(index);
  const number = el("span", "weekly-outcome-number mono", String(index + 1).padStart(2, "0"));
  const fields = el("div", "weekly-outcome-fields");
  const outcomeWrap = el("label", "weekly-control"); outcomeWrap.append(el("span", "", "Outcome *"));
  const outcome = el("input");
  outcome.type = "text"; outcome.name = "outcome"; outcome.maxLength = 500;
  outcome.placeholder = "Hasil yang harus nyata selesai"; outcome.value = value.outcome || ""; outcomeWrap.append(outcome);
  const doneWrap = el("label", "weekly-control"); doneWrap.append(el("span", "", "Definition of done *"));
  const done = el("input");
  done.type = "text"; done.name = "doneDefinition"; done.maxLength = 700;
  done.placeholder = "Kondisi objektif bahwa outcome selesai"; done.value = value.doneDefinition || ""; doneWrap.append(done);
  const bottom = el("div", "weekly-outcome-meta");
  const effortWrap = el("label", "weekly-control"); effortWrap.append(el("span", "", "Effort"));
  const effort = el("select"); effort.name = "effort"; effort.setAttribute("aria-label", `Effort outcome ${index + 1}`);
  for (const [key, label] of [["S", "S · ≤1 h"], ["M", "M · ±½ day"], ["L", "L · ≥1 day"]]) {
    const option = el("option", "", label); option.value = key; option.selected = (value.effort || "M") === key; effort.append(option);
  }
  effortWrap.append(effort);
  const riskWrap = el("label", "weekly-control"); riskWrap.append(el("span", "", "Dependency / risk"));
  const risk = el("input"); risk.type = "text"; risk.name = "risk"; risk.maxLength = 700;
  risk.placeholder = "Optional"; risk.value = value.risk || ""; riskWrap.append(risk);
  bottom.append(effortWrap, riskWrap); fields.append(outcomeWrap, doneWrap, bottom); row.append(number, fields);
  return row;
}
function weeklyField(label, name, value, required = false) {
  const wrap = el("label", "weekly-field");
  const caption = el("span", "", label + (required ? " *" : ""));
  const area = el("textarea"); area.name = name; area.rows = 2; area.maxLength = 1500; area.value = value || "";
  wrap.append(caption, area); return wrap;
}
function weeklyRatings(saved = {}) {
  const wrap = el("div", "weekly-ratings");
  for (const [name, label] of [["focus", "Focus"], ["energy", "Energy"], ["load", "Load"]]) {
    const field = el("label", "weekly-rating"); field.append(el("span", "", label));
    const select = el("select"); select.name = name;
    for (let score = 1; score <= 5; score += 1) {
      const option = el("option", "", String(score)); option.value = String(score);
      option.selected = Number(saved[name] || 3) === score; select.append(option);
    }
    field.append(select); wrap.append(field);
  }
  return wrap;
}
function weeklyFormStatus(form, message, error = false) {
  const node = form.querySelector(".weekly-form-status");
  node.textContent = message; node.classList.toggle("error", error);
}
function renderWeeklyCheckin() {
  const startForm = $("#weekly-start-form");
  const endForm = $("#weekly-end-form");
  if (!startForm || !endForm) return;
  const periodKey = weeklyPeriodKey();
  const saved = weekly.weeks[periodKey] || {};
  $("#weekly-period-label").textContent = `${periodKey} · ${weeklyPeriodLabel()}`;

  const outcomesHost = $("#weekly-outcomes"); outcomesHost.replaceChildren();
  const outcomes = saved.start && Array.isArray(saved.start.outcomes) ? saved.start.outcomes : [{}];
  outcomes.slice(0, 3).forEach((item, index) => outcomesHost.append(weeklyOutcomeRow(index, item)));
  startForm.elements.capacityException.value = (saved.start && saved.start.capacityException) || "";
  weeklyFormStatus(startForm, saved.start ? `Saved ${new Date(saved.start.savedAt).toLocaleString("id-ID")}` : "Belum ada commitment minggu ini.");

  for (const name of ["highestImpact", "hiddenWork", "unfinished", "decisionToChange", "externalFeedback", "wellbeingContext", "focus", "energy", "load"]) {
    if (endForm.elements[name]) endForm.elements[name].value = saved.end && saved.end[name] != null ? saved.end[name] : (["focus", "energy", "load"].includes(name) ? "3" : "");
  }
  weeklyFormStatus(endForm, saved.end ? `Saved ${new Date(saved.end.savedAt).toLocaleString("id-ID")}` : "Belum ada end-week reflection.");
}
function initWeeklyCheckin() {
  const startForm = $("#weekly-start-form");
  const endForm = $("#weekly-end-form");
  if (!startForm || !endForm) return;
  $("#weekly-add-outcome").onclick = () => {
    const host = $("#weekly-outcomes");
    if (host.children.length >= 3) { weeklyFormStatus(startForm, "Maksimal 3 outcome. Kalau semuanya prioritas, ya tidak ada yang prioritas.", true); return; }
    host.append(weeklyOutcomeRow(host.children.length));
  };
  startForm.onsubmit = (event) => {
    event.preventDefault();
    try {
      const outcomes = [...$("#weekly-outcomes").children].map((row) => ({
        outcome: row.querySelector('[name="outcome"]').value,
        doneDefinition: row.querySelector('[name="doneDefinition"]').value,
        effort: row.querySelector('[name="effort"]').value,
        risk: row.querySelector('[name="risk"]').value,
      }));
      const saved = saveWeeklyStart(weeklyPeriodKey(), { outcomes, capacityException: startForm.elements.capacityException.value });
      weeklyFormStatus(startForm, `Start-of-week commitment saved · ${saved.outcomes.length} outcome.`);
    } catch (error) { weeklyFormStatus(startForm, error.message, true); }
  };
  endForm.onsubmit = (event) => {
    event.preventDefault();
    try {
      const value = {}; for (const name of ["highestImpact", "hiddenWork", "unfinished", "decisionToChange", "externalFeedback", "wellbeingContext", "focus", "energy", "load"]) value[name] = endForm.elements[name].value;
      saveWeeklyEnd(weeklyPeriodKey(), value);
      weeklyFormStatus(endForm, "End-of-week reflection saved.");
    } catch (error) { weeklyFormStatus(endForm, error.message, true); }
  };
  renderWeeklyCheckin();
}
