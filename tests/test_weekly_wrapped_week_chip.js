const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/calm-workbench.css'), 'utf8');
const signal = fs.readFileSync(path.join(root, 'assets/js/weekly-wrapped-signal.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/weekly-wrapped.sample.json'), 'utf8'));

assert(!index.includes('id="tab-wrapped"'), 'primary nav must not keep a Wrapped tab');
assert(!index.includes('role="tab"') || !/tab-wrapped/.test(index), 'Wrapped must not impersonate a CATET tab');
assert(index.includes('id="wrapped-week-chip"'), 'header must expose the week chip');
assert(/id="wrapped-week-chip"[^>]*hidden/.test(index), 'week chip must be hidden until a live unacked report exists');
assert(index.includes('href="weekly-wrapped.html"'), 'week chip must deep-link to the report page');
assert(index.includes('Open Wrapped'), 'Settings still points people to the report, not the other way around');
assert(index.includes('assets/js/weekly-wrapped-signal.js'), 'index must load the signal script');
assert(index.indexOf('assets/js/weekly-wrapped-signal.js') < index.indexOf('assets/js/app.js'),
  'signal script must load before app.js init');
assert(!index.includes('ready-alert-count') || !signal.includes('ready-alert'),
  'Wrapped must not reuse the QA inbox count');
assert(!signal.includes('weekly-wrapped.sample.json') && !signal.includes('WRAPPED_DEMO_URL'),
  'header signal must never fall back to the demo fixture');

assert(css.includes('.week-chip[hidden]'), 'hidden chip must not occupy header space');
assert(css.includes('prefers-reduced-motion'), 'week-chip pulse must yield to reduced motion');
assert(css.includes('.week-chip-status'), 'async chip changes need a contextual status, not a bare live number');
assert(!css.includes('.week-chip-count'), 'week chip is a stamp, not a count badge');

assert(app.includes('initWrappedWeekChip'), 'app init must start the week-chip refresh');
assert(app.includes('refreshWrappedWeekChip'), 'returning to the tab must refresh the chip');
assert(jira.includes('refreshWrappedWeekChip'), 'signing in must refresh the chip after the access code lands');
assert(sw.includes('assets/js/weekly-wrapped-signal.js'), 'offline cache must include the signal script');
const cacheVersion = Number((sw.match(/const CACHE = "catet-v(\d+)"/) || [])[1]);
assert(Number.isInteger(cacheVersion) && cacheVersion >= 68,
  'service worker cache must bump for the week-chip asset');

const context = {
  jira: { key: '' },
  jiraProxy() { return ''; },
  headerAkses() { return {}; },
  $() { return null; },
};
vm.createContext(context);
vm.runInContext(signal, context);
assert.strictEqual(typeof context.wrappedWeekChipDecision, 'function',
  'show/hide decision must be a pure function tests can execute');

function assertDecision(actual, expected, msg) {
  assert.strictEqual(actual.show, expected.show, msg);
  assert.strictEqual(actual.reportId, expected.reportId, msg);
}

const live = {
  schema_version: 1,
  report_id: '2026-W37',
  report: { scorecard: [] },
};
assertDecision(context.wrappedWeekChipDecision(null, null), { show: false, reportId: '' });
assertDecision(context.wrappedWeekChipDecision({ report: null, updatedAt: null }, null),
  { show: false, reportId: '' });
assertDecision(context.wrappedWeekChipDecision(sample, null),
  { show: true, reportId: sample.report_id },
  'a schema-valid body is eligible; the fetch path is what forbids demo');
assertDecision(context.wrappedWeekChipDecision(live, null), { show: true, reportId: '2026-W37' });
assertDecision(context.wrappedWeekChipDecision(live, { correction: null }),
  { show: true, reportId: '2026-W37' });
assertDecision(context.wrappedWeekChipDecision(live, { correction: { verdict: 'looks_right' } }),
  { show: false, reportId: '2026-W37' });
assertDecision(context.wrappedWeekChipDecision(live, { correction: { verdict: 'wrong' } }),
  { show: false, reportId: '2026-W37' });
assertDecision(context.wrappedWeekChipDecision(live, { correction: { verdict: 'missed' } }),
  { show: false, reportId: '2026-W37' });
assertDecision(context.wrappedWeekChipDecision({ schema_version: 1, report_id: 'nope', report: {} }, null),
  { show: false, reportId: '' });

console.log('Weekly Wrapped week-chip contract passed.');
