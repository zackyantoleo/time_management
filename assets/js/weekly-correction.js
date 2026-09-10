// weekly-correction.js — koreksi ringan untuk Weekly Wrapped.
// Record terpisah dari task/worklog/weekly commitment. Bukan engine analisis.
"use strict";

const WEEKLY_CORRECTION_SCHEMA = 1;
const WEEKLY_CORRECTION_NOTE_MAX = 500;
const WEEKLY_CORRECTION_VERDICTS = { looks_right: true, wrong: true, missed: true };
const WEEKLY_CORRECTION_DEMO_KEY = "catet.weekly.corrections.demo.v1";
const WEEKLY_CORRECTION_ISO_WEEK = /^\d{4}-W\d{2}$/;

function weeklyCorrectionBlocked(note) {
  const text = typeof note === "string" ? note : "";
  return /https?:\/\//i.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:ghp_|github_pat_|gho_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/i.test(text)
    || /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text);
}

function sanitizeWeeklyCorrectionNote(note) {
  let clean = typeof note === "string" ? note : "";
  clean = clean
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/\b(?:ghp_|github_pat_|gho_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/gi, " ")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length > WEEKLY_CORRECTION_NOTE_MAX) throw new Error("Catatan terlalu panjang.");
  return clean;
}

function weeklyCorrectionIdentity(report) {
  const reportId = report && typeof report.report_id === "string" ? report.report_id.trim() : "";
  const generatedAt = report && typeof report.generated_at === "string" ? report.generated_at.trim() : "";
  if (!WEEKLY_CORRECTION_ISO_WEEK.test(reportId)) throw new Error("report_id Weekly Wrapped tidak valid.");
  if (!generatedAt || isNaN(new Date(generatedAt))) throw new Error("generated_at snapshot tidak valid.");
  return { reportId, generatedAt };
}

function weeklyCorrectionIdempotencyKey(reportId, generatedAt, verdict, note) {
  return [reportId, generatedAt, verdict, note].join("|");
}

function buildWeeklyCorrection(input) {
  const source = input && input.source;
  const verdict = input && input.verdict;
  if (!WEEKLY_CORRECTION_VERDICTS[verdict]) throw new Error("Pilih Looks right, Ada yang salah, atau Yang terlewat.");
  const { reportId, generatedAt } = weeklyCorrectionIdentity(input && input.report);
  if (weeklyCorrectionBlocked(input && input.note)) throw new Error("Catatan tidak boleh berisi email, URL, atau token.");
  let note = sanitizeWeeklyCorrectionNote(input && input.note);
  if (verdict === "looks_right") note = "";
  if (verdict === "missed" && !note) throw new Error("Yang terlewat wajib diisi.");
  return {
    schema_version: WEEKLY_CORRECTION_SCHEMA,
    correction_id: "corr-" + reportId,
    report_id: reportId,
    generated_at: generatedAt,
    verdict,
    note,
    source: source === "demo" ? "demo" : "live",
    idempotency_key: weeklyCorrectionIdempotencyKey(reportId, generatedAt, verdict, note),
    revision: 1,
    saved_at: new Date().toISOString(),
  };
}

function shouldPersistWeeklyCorrection(source) {
  return source === "live";
}

function saveDemoWeeklyCorrection(record) {
  const incoming = record && typeof record === "object" ? { ...record, source: "demo" } : null;
  if (!incoming || incoming.report_id == null) throw new Error("Correction demo tidak valid.");
  let existing = null;
  try { existing = JSON.parse(localStorage.getItem(WEEKLY_CORRECTION_DEMO_KEY) || "null"); } catch { existing = null; }
  if (existing && existing.report_id === incoming.report_id && existing.idempotency_key === incoming.idempotency_key) {
    return existing;
  }
  const next = {
    ...incoming,
    source: "demo",
    correction_id: existing && existing.report_id === incoming.report_id ? existing.correction_id : incoming.correction_id,
    revision: existing && existing.report_id === incoming.report_id ? Number(existing.revision || 1) + 1 : 1,
    saved_at: new Date().toISOString(),
  };
  localStorage.setItem(WEEKLY_CORRECTION_DEMO_KEY, JSON.stringify(next));
  return next;
}

function weeklyCorrectionStatusText(record) {
  if (!record) return "Belum ada koreksi untuk report ini.";
  if (record.verdict === "looks_right") return "Looks right tersimpan.";
  if (record.verdict === "wrong") return "Ada yang salah tersimpan.";
  return "Yang terlewat tersimpan.";
}

function setWeeklyCorrectionStatus(text, isError) {
  const node = document.querySelector("#correction-status");
  if (!node) return;
  node.textContent = text;
  node.dataset.state = isError ? "error" : "ok";
}

function paintWeeklyCorrection(record) {
  const note = document.querySelector("#correction-note");
  if (note && record && record.note) note.value = record.note;
  document.querySelectorAll("[data-correction-verdict]").forEach((button) => {
    const active = record && button.getAttribute("data-correction-verdict") === record.verdict;
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  setWeeklyCorrectionStatus(weeklyCorrectionStatusText(record), false);
}

async function persistLiveWeeklyCorrection(record, connection) {
  const key = connection && connection.key;
  const proxy = connection && connection.proxy;
  if (!key || !proxy) throw new Error("Koreksi live membutuhkan kode akses CATET.");
  const response = await fetch(proxy + "/weekly-wrapped/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Catet-Key": key },
    body: JSON.stringify({
      schema_version: record.schema_version,
      report_id: record.report_id,
      generated_at: record.generated_at,
      verdict: record.verdict,
      note: record.note,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 409) throw new Error("Report sudah berganti. Refresh dulu, lalu koreksi ulang.");
  if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
  return body;
}

async function loadLiveWeeklyCorrection(report, connection) {
  const key = connection && connection.key;
  const proxy = connection && connection.proxy;
  if (!key || !proxy || !report || !report.report_id) return null;
  const response = await fetch(proxy + "/weekly-wrapped/corrections?report_id=" + encodeURIComponent(report.report_id), {
    headers: { "X-Catet-Key": key },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  return body && body.correction ? body.correction : null;
}

async function submitWeeklyCorrection(verdict, options) {
  const noteNode = document.querySelector("#correction-note");
  const record = buildWeeklyCorrection({
    report: options.report,
    verdict,
    note: noteNode ? noteNode.value : "",
    source: options.source,
  });
  const saved = shouldPersistWeeklyCorrection(options.source)
    ? await persistLiveWeeklyCorrection(record, options.connection)
    : saveDemoWeeklyCorrection(record);
  paintWeeklyCorrection(saved);
  return saved;
}

function initWeeklyCorrection(options) {
  const root = document.querySelector("#wrapped-correction");
  if (!root || !options || !options.report) return;
  const looksRight = document.querySelector("#correction-looks-right");
  const wrong = document.querySelector("#correction-wrong");
  const missed = document.querySelector("#correction-save-missed");
  const run = (verdict) => submitWeeklyCorrection(verdict, options).catch((error) => {
    setWeeklyCorrectionStatus(error.message, true);
  });
  if (looksRight) looksRight.onclick = () => run("looks_right");
  if (wrong) wrong.onclick = () => run("wrong");
  if (missed) missed.onclick = () => run("missed");
  if (options.source === "demo") {
    try { paintWeeklyCorrection(JSON.parse(localStorage.getItem(WEEKLY_CORRECTION_DEMO_KEY) || "null")); }
    catch { paintWeeklyCorrection(null); }
    return;
  }
  loadLiveWeeklyCorrection(options.report, options.connection).then(paintWeeklyCorrection).catch(() => paintWeeklyCorrection(null));
}
