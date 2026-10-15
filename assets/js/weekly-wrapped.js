// weekly-wrapped.js — report-first; legacy story remains optional.
"use strict";

const WRAPPED_DEMO_URL = "assets/data/weekly-wrapped.sample.json";
const WRAPPED_PATTERN_DEMO_URL = "assets/data/work-patterns.sample.json";
const WRAPPED_PROXY_DEFAULT = "https://catet-jira-proxy.zackyanto-leo.workers.dev";
const WRAPPED_JIRA_KEY = "catet.jira.v1";
const SLIDE_MS = 8000;
let wrappedData = null;
let slideIndex = 0;
let autoAdvance = null;
let touchStartX = null;
let wrappedLoadToken = 0;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function wrappedEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function wrappedConnection() {
  try {
    const jira = JSON.parse(localStorage.getItem(WRAPPED_JIRA_KEY) || "null") || {};
    const key = typeof jira.key === "string" ? jira.key.trim() : "";
    const proxy = typeof jira.proxy === "string" && jira.proxy.trim() ? jira.proxy.trim() : WRAPPED_PROXY_DEFAULT;
    return { key, proxy: proxy.replace(/\/+$/, "") };
  } catch { return { key: "", proxy: WRAPPED_PROXY_DEFAULT }; }
}
function headerAksesWrapped(key) { return key ? { "X-Catet-Key": key } : {}; }
function setWrappedSource(source, label) {
  const badge = document.querySelector("#wrapped-source-status");
  badge.dataset.source = source;
  badge.textContent = label;
}
async function fetchWeeklyWrappedReport(loadToken) {
  const { key, proxy } = wrappedConnection();
  const explicitDemo = new URLSearchParams(location.search).get('demo');
  if (key && !explicitDemo) {
    const response = await fetch(proxy + "/weekly-wrapped", { headers: headerAksesWrapped(key), cache: "no-store" });
    if (response.ok) {
      const report = await response.json();
      if (report && report.report === null && report.updatedAt === null && Object.keys(report).length === 2) {
        // Existing Worker uses an explicit empty sentinel instead of HTTP 404.
      } else {
        if (loadToken !== wrappedLoadToken) return null;
        validateWrappedData(report);
        setWrappedSource("live", "Live report");
        return report;
      }
    }
    if (!response.ok && response.status !== 404) throw new Error(`live HTTP ${response.status}`);
  }
  const demo = await fetch(explicitDemo === 'legacy' ? WRAPPED_DEMO_URL : WRAPPED_PATTERN_DEMO_URL, { cache: "no-store" });
  if (!demo.ok) throw new Error(`demo HTTP ${demo.status}`);
  const report = await demo.json();
  if (loadToken !== wrappedLoadToken) return null;
  validateWrappedData(report);
  setWrappedSource("demo", key && !explicitDemo ? "Demo · no report yet" : "Demo · synthetic example");
  return report;
}

function wrappedRefs(ids) {
  const evidence = new Map(wrappedData.report.evidence.map((item) => [item.id, item]));
  return ids.map((id) => evidence.get(id)).filter(Boolean);
}

function renderProgress() {
  const host = document.querySelector("#story-progress");
  host.replaceChildren();
  wrappedData.slides.forEach((slide, index) => {
    const button = wrappedEl("button");
    button.type = "button";
    button.setAttribute("aria-label", `Buka slide ${index + 1}: ${slide.eyebrow}`);
    if (index === slideIndex) button.setAttribute("aria-current", "step");
    if (index < slideIndex) button.classList.add("is-complete");
    button.onclick = () => {
      stopAutoAdvance();
      renderSlide(index);
    };
    host.append(button);
  });
}

function renderSlide(index) {
  const slides = wrappedData.slides;
  slideIndex = Math.max(0, Math.min(index, slides.length - 1));
  const slide = slides[slideIndex];
  const card = document.querySelector("#story-card");
  card.classList.add("is-changing");
  const apply = () => {
    card.dataset.tone = slide.tone || "accent";
    document.querySelector("#story-eyebrow").textContent = slide.eyebrow;
    document.querySelector("#story-title").textContent = slide.title;
    document.querySelector("#story-body").textContent = slide.body;
    document.querySelector("#story-metric").textContent = slide.metric;
    document.querySelector("#story-metric-label").textContent = slide.metric_label;
    document.querySelector("#story-index").textContent = `${String(slideIndex + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
    document.querySelector("#story-prev").disabled = slideIndex === 0;
    const last = slideIndex === slides.length - 1;
    document.querySelector("#story-next").classList.toggle("hidden", last);
    document.querySelector("#view-report").classList.toggle("hidden", !last);
    renderProgress();
    card.classList.remove("is-changing");
  };
  if (reduceMotion.matches) apply();
  else setTimeout(apply, 110);
}

function nextSlide() {
  if (slideIndex >= wrappedData.slides.length - 1) {
    stopAutoAdvance();
    return;
  }
  renderSlide(slideIndex + 1);
}

function previousSlide() {
  if (slideIndex > 0) renderSlide(slideIndex - 1);
}

function startAutoAdvance() {
  if (reduceMotion.matches || autoAdvance) return;
  autoAdvance = setInterval(nextSlide, SLIDE_MS);
  document.querySelector("#story-pause").textContent = "Pause";
  document.querySelector("#story-pause").setAttribute("aria-pressed", "false");
}

function stopAutoAdvance() {
  if (autoAdvance) clearInterval(autoAdvance);
  autoAdvance = null;
  const button = document.querySelector("#story-pause");
  button.textContent = "Play";
  button.setAttribute("aria-pressed", "true");
}

function toggleAutoAdvance() {
  if (autoAdvance) stopAutoAdvance();
  else startAutoAdvance();
}

function goToReport() {
  stopAutoAdvance();
  document.querySelector("#wrapped-story").classList.add("hidden");
  const report = document.querySelector("#wrapped-report");
  report.classList.remove("hidden");
  report.scrollIntoView({behavior: reduceMotion.matches ? "auto" : "smooth", block: "start"});
  document.querySelector("#report-title").focus({preventScroll: true});
}

function replayStory() {
  document.querySelector("#wrapped-report").classList.add("hidden");
  const story = document.querySelector("#wrapped-story");
  story.classList.remove("hidden");
  renderSlide(0);
  story.scrollIntoView({behavior: reduceMotion.matches ? "auto" : "smooth", block: "start"});
  document.querySelector("#story-card").focus({preventScroll: true});
  startAutoAdvance();
}

function renderCommitments() {
  const host = document.querySelector("#commitment-list");
  host.replaceChildren();
  wrappedData.report.commitments.forEach((item) => {
    const row = wrappedEl("div", "commitment-row");
    row.dataset.status = item.status;
    const mark = wrappedEl("span", "commitment-mark", item.status === "shipped" ? "✓" : "→");
    mark.setAttribute("aria-hidden", "true");
    row.append(mark, wrappedEl("span", "", item.outcome), wrappedEl("span", "status-chip", item.status));
    host.append(row);
  });
}

function renderScorecard() {
  const rows = wrappedData.report.scorecard;
  const scored = rows.filter((item) => item.score !== null);
  const overall = scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : null;
  document.querySelector("#overall-score").textContent = overall === null ? "—" : overall.toFixed(1);
  const host = document.querySelector("#scorecard-list");
  host.replaceChildren();
  rows.forEach((item) => {
    const row = wrappedEl("div", "score-row");
    const label = wrappedEl("div");
    label.append(wrappedEl("strong", "", item.dimension));
    const value = wrappedEl("strong", "mono", item.score === null ? "—" : `${item.score}/5`);
    const meta = wrappedEl("div", "score-meta");
    meta.append(wrappedEl("span", "", item.confidence === "insufficient" ? "insufficient evidence" : `${item.confidence} confidence`));
    const bar = wrappedEl("div", "score-bar");
    const fill = wrappedEl("i");
    fill.style.width = item.score === null ? "0" : `${item.score * 20}%`;
    bar.append(fill);
    row.append(label, value, meta, bar);
    host.append(row);
  });
}

function renderClaims() {
  const host = document.querySelector("#claim-list");
  host.replaceChildren();
  wrappedData.report.claims.forEach((item) => {
    const card = wrappedEl("article", "claim-card");
    card.dataset.kind = item.kind;
    card.append(wrappedEl("span", "section-eyebrow", `${item.kind} · ${item.confidence} confidence`));
    card.append(wrappedEl("h3", "", item.title));
    card.append(wrappedEl("p", "", item.impact));
    if (item.corrective_action) {
      const corrective = wrappedEl("div", "corrective-move");
      corrective.append(wrappedEl("b", "", "Corrective move"), wrappedEl("span", "", item.corrective_action));
      card.append(corrective);
    }
    const tags = wrappedEl("div", "claim-tags");
    wrappedRefs(item.evidence_refs).forEach((evidence) => tags.append(wrappedEl("span", "", evidence.ref)));
    card.append(tags);
    host.append(card);
  });
}

function renderNextWeek() {
  const host = document.querySelector("#next-outcomes");
  host.replaceChildren(...wrappedData.report.next_week.outcomes.map((item) => wrappedEl("li", "", item)));
  const guardrails = document.querySelector("#next-guardrails");
  guardrails.replaceChildren();
  [
    ["Stop", wrappedData.report.next_week.stop],
    ["Clear this blocker", wrappedData.report.next_week.blocker],
    ["Success means", wrappedData.report.next_week.success_definition]
  ].forEach(([label, value]) => {
    const item = wrappedEl("div", "guardrail");
    item.append(wrappedEl("b", "", label), wrappedEl("span", "", value));
    guardrails.append(item);
  });
}

function renderEvidence() {
  const host = document.querySelector("#evidence-list");
  host.replaceChildren();
  wrappedData.report.evidence.forEach((item) => {
    const row = wrappedEl("article", "evidence-item");
    const source = wrappedEl("div");
    source.append(wrappedEl("span", "evidence-source", item.source), wrappedEl("span", "evidence-ref", item.ref));
    row.append(source, wrappedEl("p", "", item.observation));
    host.append(row);
  });
}

function validateWrappedData(data) {
  if (data?.schema_version === 2) return WorkPatternReportContract.validateWorkPatternReport(data);
  if (!data || (data.schema_version !== undefined && data.schema_version !== 1) || !Array.isArray(data.slides) || data.slides.length < 1 || !data.report) throw new Error("missing story/report");
  if (!Array.isArray(data.report.scorecard) || !Array.isArray(data.report.evidence)) throw new Error("invalid report collections");
  if (data.report.evidence.some((item) => item.sensitivity !== "sanitized")) throw new Error("unsanitized evidence rejected");
  if ((data.report.next_week?.outcomes || []).length > 3) throw new Error("more than three next-week outcomes");
}

function bindWrappedEvents() {
  document.querySelector("#story-next").onclick = () => { stopAutoAdvance(); nextSlide(); };
  document.querySelector("#story-prev").onclick = () => { stopAutoAdvance(); previousSlide(); };
  document.querySelector("#story-pause").onclick = toggleAutoAdvance;
  document.querySelector("#view-report").onclick = goToReport;
  document.querySelector("#replay-story").onclick = replayStory;
  initThemeToggle();
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("#wrapped-story").classList.contains("hidden")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); stopAutoAdvance(); nextSlide(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); stopAutoAdvance(); previousSlide(); }
    if (event.key === "Escape") goToReport();
  });
  const card = document.querySelector("#story-card");
  card.addEventListener("touchstart", (event) => { touchStartX = event.changedTouches[0].clientX; }, {passive: true});
  card.addEventListener("touchend", (event) => {
    if (touchStartX === null) return;
    const distance = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(distance) < 48) return;
    stopAutoAdvance();
    if (distance < 0) nextSlide(); else previousSlide();
  }, {passive: true});
}

function showWrappedError() {
  stopAutoAdvance();
  for (const id of ['wrapped-story', 'wrapped-report', 'work-pattern-report']) document.getElementById(id).classList.add('hidden');
  document.querySelector('#wrapped-error').classList.remove('hidden');
  setWrappedSource('error', 'Report error');
}

function renderWorkPatternReport(data) {
  const report = data.report;
  document.querySelector('#work-pattern-summary').textContent = report.summary;
  document.querySelector('#work-pattern-snapshot').textContent = `Snapshot ${data.generated_at} · ${data.report_id} · total pekerjaan unik unknown`;
  const evidence = new Map(report.evidence.map(e => [e.id, e]));
  for (const [hostId, items] of [
    ['work-pattern-highlights', report.insights.filter(i => i.dimension !== 'activity')],
    ['work-pattern-item-list', report.insights.filter(i => i.dimension === 'activity')],
  ]) {
    const host = document.getElementById(hostId);
    host.replaceChildren();
    if (!items.length) host.append(wrappedEl('p', '', 'Belum ada fakta bersitasi pada scope ini; bukan berarti tidak ada kerja.'));
    for (const item of items) {
      const card = wrappedEl('article', 'claim-card');
      card.append(wrappedEl('span', 'section-eyebrow', `${item.source} · recorded fact`), wrappedEl('h3', '', item.observation), wrappedEl('p', '', item.interpretation));
      const details = wrappedEl('details', 'pattern-evidence');
      details.append(wrappedEl('summary', '', `Evidence & limits · ${item.evidence_refs.length} refs`));
      details.append(wrappedEl('p', '', `Batas interpretasi: ${item.interpretation_limits.join(' ')}`),
        wrappedEl('p', '', `Konteks tandingan: ${item.counter_context.join(' ')}`),
        wrappedEl('p', '', `Keyakinan: ${item.confidence_reason}`),
        wrappedEl('p', '', `Dampak ${item.impact.status}: ${item.impact.reason}`));
      if (item.observed_by_day) for (const [day, count] of Object.entries(item.observed_by_day)) details.append(wrappedEl('p', '', `${day}: ${count} rekaman teramati.`));
      for (const ref of item.evidence_refs) {
        const e = evidence.get(ref);
        const row = wrappedEl('div', 'pattern-ref');
        row.append(wrappedEl('strong', '', `${e.source} · ${e.kind}`), wrappedEl('span', '', e.event_at), wrappedEl('code', '', e.id), wrappedEl('code', '', e.provenance_ref));
        details.append(row);
      }
      card.append(details); host.append(card);
    }
  }
  const abstentions = document.querySelector('#work-pattern-abstentions');
  const labels = { communication: 'Communication', focus: 'Focus', workload: 'Actual workload', feedback: 'Critique / appreciation', comparison: 'Trends' };
  abstentions.replaceChildren(...Object.entries(report.abstentions).map(([key, value]) => {
    const item = wrappedEl('details', 'pattern-abstention');
    item.append(wrappedEl('summary', '', `${labels[key]} · not assessed`), wrappedEl('p', '', value.reason));
    return item;
  }));
  const sources = document.querySelector('#work-pattern-source-list');
  sources.replaceChildren(...Object.entries(report.coverage).map(([source, c]) => {
    const row = wrappedEl('p', '', `${source}: ${c.status}; ${c.observed_event_count} observed; weekly total unknown. ${c.reason}`);
    return row;
  }));
  document.querySelector('#work-pattern-agent-gap').textContent = `${report.agent_scope.included_refs} accepted / ${report.agent_scope.excluded_refs} excluded agent refs. ${report.agent_scope.reason}`;
  const ledger = document.querySelector('#work-pattern-evidence');
  ledger.replaceChildren(...report.evidence.map(e => {
    const row = wrappedEl('div', 'pattern-ref');
    row.append(wrappedEl('strong', '', `${e.source} · ${e.kind} · ${e.attribution}`), wrappedEl('span', '', e.event_at), wrappedEl('code', '', e.id), wrappedEl('code', '', e.provenance_ref));
    return row;
  }));
}

function applyWrappedReport(data) {
  validateWrappedData(data);
  wrappedData = data;
  stopAutoAdvance();
  document.querySelector('#wrapped-error').classList.add('hidden');
  document.querySelector('#wrapped-story').classList.add('hidden');
  document.querySelector('#wrapped-period').textContent = data.period.label;
  const patterns = data.schema_version === 2;
  document.querySelector('#wrapped-report').classList.toggle('hidden', patterns);
  document.querySelector('#work-pattern-report').classList.toggle('hidden', !patterns);
  if (patterns) { renderWorkPatternReport(data); return; }
  document.querySelector('#report-summary').textContent = data.report.summary;
  document.querySelector('#report-status').textContent = data.report.status;
  renderCommitments(); renderScorecard(); renderClaims(); renderNextWeek(); renderEvidence();
  if (typeof initWeeklyCheckin === 'function') initWeeklyCheckin();
  if (typeof initWeeklyCorrection === 'function') initWeeklyCorrection({ report: data,
    source: document.querySelector('#wrapped-source-status').dataset.source === 'live' ? 'live' : 'demo', connection: wrappedConnection() });
  renderSlide(0);
}

async function initWrapped() {
  const token = ++wrappedLoadToken;
  try {
    const embedded = document.querySelector('#wrapped-local-report');
    if (embedded) {
      const data = JSON.parse(embedded.textContent);
      if (data.schema_version !== 2) throw new Error('invalid local schema');
      applyWrappedReport(data);
      setWrappedSource('local', 'Local draft · not published');
    } else {
      const data = await fetchWeeklyWrappedReport(token);
      if (token === wrappedLoadToken && data) applyWrappedReport(data);
    }
  } catch { if (token === wrappedLoadToken) showWrappedError(); }
}

bindWrappedEvents();
document.querySelector('#wrapped-retry').onclick = initWrapped;
document.querySelector('#wrapped-local-input').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  const token = ++wrappedLoadToken;
  try {
    if (file.size > 256 * 1024) throw new Error('oversize');
    const data = JSON.parse(await file.text());
    if (token !== wrappedLoadToken) return;
    if (data.schema_version !== 2) throw new Error('local mode accepts work-pattern reports only');
    applyWrappedReport(data);
    setWrappedSource('local', 'Local draft · not published');
    document.querySelector('#wrapped-local-status').textContent = 'Draft lokal dibuka di memory browser saja; tidak diunggah atau disimpan.';
  } catch { if (token === wrappedLoadToken) { showWrappedError(); document.querySelector('#wrapped-local-status').textContent = 'File invalid atau terlalu besar; tidak disimpan.'; } }
  event.target.value = '';
};
initWrapped();
