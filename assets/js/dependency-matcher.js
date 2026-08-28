// dependency-matcher.js — deterministic QA ↔ dev matcher untuk tiket satu sprint.
// Tidak memakai LLM dan tidak menulis Jira. Hasilnya hanya metadata CATET.
"use strict";

(function (root) {
  const ROLE_WORDS = new Set([
    "test", "testing", "qa", "quality", "assurance", "verify", "verification",
    "validate", "validation", "scenario", "case", "cases", "implement", "implementation",
    "develop", "development", "fix", "adjust", "adjustment", "enhance", "enhancement",
    "add", "update", "change", "handling", "handle", "support", "service",
  ]);
  const STOP_WORDS = new Set([
    "a", "an", "and", "atau", "based", "by", "dalam", "dan", "dari", "di", "for",
    "from", "in", "into", "is", "ke", "ketika", "mapping", "new", "of", "on", "pada",
    "the", "to", "untuk", "using", "when", "with", "yang",
  ]);
  const ROLE_LABELS = new Set(["qa", "test", "testing", "backend", "frontend", "dev", "development"]);
  const NON_DELIVERY_TYPES = /epic|initiative|theme|spike|research|documentation|sub-task qa|test/i;
  const NON_DELIVERY_LABELS = /^(no-qa|non-code|documentation|research|spike)$/;

  function uniq(xs) { return [...new Set((xs || []).filter(Boolean))]; }
  function words(text) {
    return uniq(String(text || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .map((x) => x.replace(/(ing|tion|ment|ed|es|s)$/i, ""))
      .filter((x) => x.length > 1 && !STOP_WORDS.has(x) && !ROLE_WORDS.has(x)));
  }
  function bracketService(summary) {
    const m = String(summary || "").match(/\[([^\]]+)\]/);
    return m ? words(m[1]).join(" ") : "";
  }
  function intersect(a, b) {
    const bs = new Set(b || []);
    return uniq((a || []).filter((x) => bs.has(x)));
  }
  function isQa(i) {
    const kind = String(i.issueType || "").toLowerCase();
    const labels = (i.labels || []).map((x) => String(x).toLowerCase());
    const title = String(i.summary || "").toLowerCase();
    return /(^|\b)(qa|test|testing)(\b|$)/.test(kind) ||
      labels.some((x) => /^(qa|test|testing|quality-assurance)$/.test(x)) ||
      /(^|[\]\)\s:_-])(test|testing|qa)\b/i.test(title);
  }
  function isDeliveryDev(i) {
    if (isQa(i)) return false;
    const kind = String(i.issueType || "").toLowerCase();
    if (NON_DELIVERY_TYPES.test(kind)) return false;
    const labels = (i.labels || []).map((x) => String(x).toLowerCase());
    if (labels.some((x) => NON_DELIVERY_LABELS.test(x))) return false;
    return true;
  }
  function scorePair(qa, dev) {
    const evidence = [];
    const linked = new Set(qa.linkedKeys || []);
    const mentioned = new Set(qa.mentionedKeys || []);
    if (linked.has(dev.key)) return { score: 100, evidence: ["issue link Jira"], source: "jira-link" };
    if (mentioned.has(dev.key)) return { score: 95, evidence: ["key disebut di description"], source: "jira-description" };

    let score = 0;
    if (qa.parentKey && dev.parentKey && qa.parentKey === dev.parentKey) {
      score += 42; evidence.push("parent sama");
    }
    const comps = intersect((qa.components || []).map((x) => String(x).toLowerCase()),
      (dev.components || []).map((x) => String(x).toLowerCase()));
    if (comps.length) { score += 22; evidence.push("component sama: " + comps.join(", ")); }
    const serviceQa = bracketService(qa.summary), serviceDev = bracketService(dev.summary);
    if (serviceQa && serviceQa === serviceDev) { score += 16; evidence.push("service pada judul sama"); }
    const labelsQa = (qa.labels || []).map((x) => String(x).toLowerCase()).filter((x) => !ROLE_LABELS.has(x));
    const labelsDev = (dev.labels || []).map((x) => String(x).toLowerCase()).filter((x) => !ROLE_LABELS.has(x));
    const labels = intersect(labelsQa, labelsDev);
    if (labels.length) { score += Math.min(10, 5 + labels.length * 2); evidence.push("label sama: " + labels.join(", ")); }

    const qw = words(qa.summary), dw = words(dev.summary), shared = intersect(qw, dw);
    if (shared.length) {
      const coverage = shared.length / Math.max(1, Math.min(qw.length, dw.length));
      const similarity = shared.length / Math.max(1, new Set([...qw, ...dw]).size);
      const titleScore = Math.round(Math.min(35, coverage * 24 + similarity * 18));
      score += titleScore;
      evidence.push("konsep judul sama: " + shared.slice(0, 6).join(", "));
    }
    if (qa.sprintId && dev.sprintId && String(qa.sprintId) === String(dev.sprintId)) {
      score += 4; evidence.push("sprint sama");
    }
    return { score, evidence, source: "auto" };
  }

  function matchSprintIssues(issues, options) {
    const all = Array.isArray(issues) ? issues.filter((x) => x && x.key) : [];
    const byKey = new Map(all.map((x) => [x.key, x]));
    const qas = all.filter(isQa), devs = all.filter(isDeliveryDev);
    const qaByKey = new Map(qas.map((x) => [x.key, x]));
    const overrides = (options && options.overrides) || {};
    const matches = [], suggestions = [], warnings = [];
    const coveredDevs = new Set();
    // Tiket dev yang secara eksplisit menunjuk tiket QA sudah punya pasangan.
    // Native relation ini juga harus menekan warning "dev belum punya QA",
    // meski arah link/mention berasal dari dev, bukan QA.
    for (const dev of devs) {
      const explicitQa = [...(dev.linkedKeys || []), ...(dev.mentionedKeys || [])].find((k) => qaByKey.has(k));
      if (explicitQa) coveredDevs.add(dev.key);
    }

    for (const qa of qas) {
      const chosen = overrides[qa.key];
      if (chosen && byKey.has(chosen) && isDeliveryDev(byKey.get(chosen))) {
        const dev = byKey.get(chosen);
        matches.push({ qaKey: qa.key, devKey: dev.key, status: dev.status || "?", done: !!dev.done, doneAt: dev.doneAt || null,
          source: "manual", score: 100, evidence: ["dipilih manual di CATET"], sprintId: qa.sprintId || null });
        coveredDevs.add(dev.key);
        continue;
      }
      const ranked = devs
        .filter((d) => !qa.sprintId || !d.sprintId || String(d.sprintId) === String(qa.sprintId))
        .map((dev) => ({ dev, ...scorePair(qa, dev) }))
        .sort((a, b) => b.score - a.score || a.dev.key.localeCompare(b.dev.key));
      const best = ranked[0], second = ranked[1];
      const hard = best && (best.source === "jira-link" || best.source === "jira-description");
      const margin = best ? best.score - (second ? second.score : 0) : 0;
      const auto = best && (hard || (best.score >= 58 && margin >= 15) || (best.score >= 78 && margin >= 8));
      if (auto) {
        matches.push({ qaKey: qa.key, devKey: best.dev.key, status: best.dev.status || "?", done: !!best.dev.done, doneAt: best.dev.doneAt || null,
          source: best.source, score: best.score, evidence: best.evidence, sprintId: qa.sprintId || null });
        coveredDevs.add(best.dev.key);
        continue;
      }
      const candidates = ranked.filter((x) => x.score >= 32).slice(0, 3).map((x) => ({
        key: x.dev.key, summary: x.dev.summary || "", status: x.dev.status || "?", done: !!x.dev.done,
        score: x.score, evidence: x.evidence,
      }));
      if (candidates.length) {
        suggestions.push({ qaKey: qa.key, qaSummary: qa.summary || "", sprintId: qa.sprintId || null, candidates });
        for (const c of candidates) coveredDevs.add(c.key);
        warnings.push({ type: "qa-ambiguous", key: qa.key, summary: qa.summary || "", sprintId: qa.sprintId || null,
          message: "Beberapa tiket dev mungkin cocok — perlu dipilih." });
      } else {
        warnings.push({ type: "qa-missing-dev", key: qa.key, summary: qa.summary || "", sprintId: qa.sprintId || null,
          message: "Tiket QA ini mungkin belum punya tiket dev." });
      }
    }
    for (const dev of devs) {
      if (coveredDevs.has(dev.key)) continue;
      warnings.push({ type: "dev-missing-qa", key: dev.key, summary: dev.summary || "", sprintId: dev.sprintId || null,
        message: "Tiket dev ini mungkin belum punya tiket testing/QA." });
    }
    return { matches, suggestions, warnings, generatedAt: new Date().toISOString() };
  }

  root.CatetDependencyMatcher = { isQa, isDev: isDeliveryDev, scorePair, matchSprintIssues, words };
})(typeof globalThis !== "undefined" ? globalThis : this);
