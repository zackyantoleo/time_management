// weekly-wrapped-signal.js — stempel ISO week di header CATET.
// Muncul hanya untuk report live yang belum di-ack. Bukan tab, bukan QA inbox.
"use strict";

const WRAPPED_SIGNAL_ISO_WEEK = /^\d{4}-W\d{2}$/;
let wrappedSignalToken = 0;

function wrappedWeekChipDecision(reportBody, correctionBody) {
  const reportId = reportBody && typeof reportBody.report_id === "string"
    ? reportBody.report_id.trim() : "";
  const live = !!(reportBody
    && reportBody.schema_version === 1
    && reportBody.report
    && WRAPPED_SIGNAL_ISO_WEEK.test(reportId));
  if (!live) return { show: false, reportId: "" };
  if (correctionBody && correctionBody.correction) return { show: false, reportId: reportId };
  return { show: true, reportId: reportId };
}

function wrappedSignalConnection() {
  const key = typeof jira !== "undefined" && jira && typeof jira.key === "string" ? jira.key.trim() : "";
  const proxy = typeof jiraProxy === "function" ? jiraProxy() : "";
  return { key, proxy };
}

function hideWrappedWeekChip() {
  const chip = $("#wrapped-week-chip");
  if (!chip) return;
  chip.hidden = true;
  chip.removeAttribute("aria-label");
  const label = $("#wrapped-week-chip-label");
  const status = $("#wrapped-week-chip-status");
  if (label) label.textContent = "";
  if (status) status.textContent = "";
}

function showWrappedWeekChip(reportId) {
  const chip = $("#wrapped-week-chip");
  if (!chip) return;
  const label = $("#wrapped-week-chip-label");
  const status = $("#wrapped-week-chip-status");
  const message = "Weekly Wrapped " + reportId + " siap ditinjau";
  if (label) label.textContent = reportId;
  chip.setAttribute("aria-label", message);
  if (status) status.textContent = message;
  chip.hidden = false;
}

async function refreshWrappedWeekChip() {
  const chip = $("#wrapped-week-chip");
  if (!chip) return;
  const token = ++wrappedSignalToken;
  const { key, proxy } = wrappedSignalConnection();
  if (!key || !proxy) {
    hideWrappedWeekChip();
    return;
  }
  try {
    const reportRes = await fetch(proxy + "/weekly-wrapped", {
      headers: headerAkses(),
      cache: "no-store",
    });
    if (token !== wrappedSignalToken) return;
    if (!reportRes.ok) {
      hideWrappedWeekChip();
      return;
    }
    const reportBody = await reportRes.json().catch(() => null);
    if (token !== wrappedSignalToken) return;
    const reportId = reportBody && typeof reportBody.report_id === "string" ? reportBody.report_id.trim() : "";
    const preview = wrappedWeekChipDecision(reportBody, null);
    if (!preview.show) {
      hideWrappedWeekChip();
      return;
    }
    const corrRes = await fetch(proxy + "/weekly-wrapped/corrections?report_id=" + encodeURIComponent(reportId), {
      headers: headerAkses(),
      cache: "no-store",
    });
    if (token !== wrappedSignalToken) return;
    let correctionBody = null;
    if (corrRes.ok) correctionBody = await corrRes.json().catch(() => null);
    if (token !== wrappedSignalToken) return;
    const decision = wrappedWeekChipDecision(reportBody, correctionBody);
    if (decision.show) showWrappedWeekChip(decision.reportId);
    else hideWrappedWeekChip();
  } catch {
    if (token !== wrappedSignalToken) return;
    hideWrappedWeekChip();
  }
}

function initWrappedWeekChip() {
  refreshWrappedWeekChip();
}
