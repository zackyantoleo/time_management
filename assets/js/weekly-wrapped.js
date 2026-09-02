// weekly-wrapped.js — slideshow-first presentation followed by an auditable report.
"use strict";

const WRAPPED_DATA_URL = "assets/data/weekly-wrapped.sample.json";
const SLIDE_MS = 8000;
let wrappedData = null;
let slideIndex = 0;
let autoAdvance = null;
let touchStartX = null;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function wrappedEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  if (!data || !Array.isArray(data.slides) || data.slides.length < 1 || !data.report) throw new Error("missing story/report");
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

async function initWrapped() {
  try {
    const response = await fetch(WRAPPED_DATA_URL, {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    wrappedData = await response.json();
    validateWrappedData(wrappedData);
    document.querySelector("#wrapped-period").textContent = wrappedData.period.label;
    document.querySelector("#report-summary").textContent = wrappedData.report.summary;
    document.querySelector("#report-status").textContent = wrappedData.report.status;
    renderCommitments();
    renderScorecard();
    renderClaims();
    renderNextWeek();
    renderEvidence();
    bindWrappedEvents();
    renderSlide(0);
    startAutoAdvance();
  } catch (error) {
    console.error("Weekly Wrapped init failed", error);
    document.querySelector("#wrapped-story").classList.add("hidden");
    document.querySelector("#wrapped-report").classList.add("hidden");
    document.querySelector("#wrapped-error").classList.remove("hidden");
  }
}

initWrapped();
