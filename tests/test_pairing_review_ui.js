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
assert(jira.includes('const actionable = warnings.filter((w) => w.type === "qa-ambiguous")'),
  'ambiguous QA tickets must be prioritized separately');
assert(jira.includes('const audit = warnings.filter((w) => w.type !== "qa-ambiguous")'),
  'missing-pair audit must be grouped away from actionable items');
assert(jira.includes('document.createElement("details")'), 'large missing-pair audit must be collapsible');
assert(jira.includes('pairing-summary'), 'pairing review must use a compact summary component');
assert(!jira.includes('row.append(el("span", "jira-summary", w.summary || ""), warningBadge(w));'),
  'warning badge must not be duplicated in both row and dependency review');
assert(css.includes('.pairing-summary'), 'compact pairing summary must be styled');
assert(css.includes('.pairing-audit'), 'collapsible audit list must be styled');
assert(worker.includes('sprint in ('), 'worker candidate source remains Jira sprint query');

console.log(JSON.stringify({ ok: true }));
