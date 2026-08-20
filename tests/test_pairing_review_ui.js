const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/styles.css'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');

assert(jira.includes('const sprintIds = new Set'), 'matcher input must be limited to active Jira sprint ids');
assert(jira.includes('.filter((i) => i.sprintId && sprintIds.has(String(i.sprintId)))'),
  'non-sprint pairing issues must be excluded before matching');
assert(jira.includes('function warningsUntukSprint(s)'), 'pairing warnings must be grouped by their Jira sprint');
assert(jira.includes('String(w.sprintId) === String(s.jiraId)'), 'warning-to-sprint mapping must use Jira sprint id');
assert(jira.includes('function renderSprintPairing(s)'), 'each sprint must own its pairing review renderer');
assert(jira.includes('row.append(el("span", "pairing-sprint-count", pairCount + " pairing"))'),
  'sprint header must expose its own pairing count');
assert(jira.includes('const pairing = renderSprintPairing(s);'), 'sprint row must render its pairing review inline');
assert(!jira.includes('const pairWarn = renderPairingWarnings();'), 'global pairing section must be removed from Jira inbox');
assert(jira.includes('const actionable = warnings.filter((w) => w.type === "qa-ambiguous")'),
  'ambiguous QA tickets must be prioritized separately inside a sprint');
assert(jira.includes('document.createElement("details")'), 'large missing-pair audit must remain collapsible');
assert(!jira.includes('row.append(el("span", "jira-summary", w.summary || ""), warningBadge(w));'),
  'warning badge must not be duplicated in both row and dependency review');
assert(css.includes('.pairing-sprint-review'), 'inline sprint pairing review must be styled');
assert(css.includes('.pairing-audit'), 'collapsible audit list must be styled');
assert(worker.includes('sprint in ('), 'worker candidate source remains Jira sprint query');

console.log(JSON.stringify({ ok: true }));
