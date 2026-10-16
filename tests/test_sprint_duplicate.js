const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/js/sprints.js'), 'utf8');
function reconcile(existing, dismissed = []) {
  let sequence = 0;
  const context = vm.createContext({
    localStorage: {getItem: () => null, setItem() {}},
    tasks: existing, jira: {dismissed, items: []},
    JIRA_RE: /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g,
    uid: () => `new-${++sequence}`, saveTanpaSinkron() {},
    localDateStr: () => '2026-10-15',
    feed: [{key: 'TEST-123', summary: 'Synthetic ticket', sprint: {jiraId: 1, name: 'Synthetic sprint', endDate: '2026-10-23'}}],
  });
  vm.runInContext(source, context);
  vm.runInContext('rekonsiliasiSprintJira(feed); rekonsiliasiSprintJira(feed);', context);
  return context.tasks;
}
const completed = {id: 'original', text: 'TEST-123 — Synthetic ticket', status: 'selesai', sprintId: 'jira:1', doneAt: '2026-10-14', focusMins: 25};
assert.deepEqual(reconcile([{...completed}]), [completed], 'Completed ticket must not be auto-imported again after dismissed is pruned');
assert.equal(reconcile([{...completed, status: 'aktif'}]).length, 1);
assert.equal(reconcile([], ['TEST-123']).length, 0);
assert.equal(reconcile([]).length, 1, 'Repeated sync must be idempotent');
assert.equal(reconcile([{...completed, text: 'TEST-1234 — Different ticket', status: 'aktif'}]).length, 2, 'Ticket matching must use exact keys, not substrings');
const history = [{...completed}, {...completed, id: 'active-copy', status: 'aktif'}, {...completed, id: 'other', text: 'TEST-1234 — Other ticket'}];
const renderContext = vm.createContext({localStorage: {getItem: () => null}, tasks: history, JIRA_RE: /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g});
vm.runInContext(source, renderContext);
const shown = vm.runInContext('tugasSprintTampil("jira:1")', renderContext);
assert.deepEqual(Array.from(shown, t => t.id), ['active-copy', 'other']);
assert.equal(history.length, 3, 'Display grouping must not mutate stored history');
assert.deepEqual(history[0], completed);
console.log('PASS sprint duplicate regression: history preserved, import idempotent, exact keys, completed duplicates grouped');
