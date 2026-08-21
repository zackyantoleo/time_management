const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sprintsSource = fs.readFileSync(path.join(root, 'assets/js/sprints.js'), 'utf8');
const jiraSource = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'assets/js/sync.js'), 'utf8');
const updaterSource = fs.readFileSync(path.join(root, 'scripts/update_daily_priority.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/styles.css'), 'utf8');

const values = new Map([
  ['catet.sprints.v1', JSON.stringify({
    list: [{
      id: 's1', nama: 'Sprint 1', selesai: '2026-08-31',
      prdLinks: [
        { id: 'p1', title: 'Checkout PRD', url: 'https://docs.example.com/checkout' },
        { id: 'bad', title: 'Unsafe', url: 'javascript:alert(1)' },
      ],
    }],
    aktif: 's1',
  })],
]);
let dirtyCalls = 0;
const context = vm.createContext({
  localStorage: {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  },
  syncDirty() { dirtyCalls += 1; },
  URL,
  tasks: [],
  worklog: [],
  uid: () => 'new-id',
  localDateStr: () => '2026-08-21',
});
vm.runInContext(sprintsSource, context);

assert.strictEqual(vm.runInContext('sprintPrdLinks(sprintById("s1")).length', context), 1,
  'unsafe PRD URLs must not be exposed as usable links');
assert.strictEqual(vm.runInContext('sprintPrdLinks(sprintById("s1"))[0].title', context), 'Checkout PRD',
  'saved PRD title must remain available to the UI and AI context');
assert.strictEqual(vm.runInContext('tambahSprintPrd(sprintById("s1"), " Search PRD ", "docs.example.com/search")', context), true,
  'a hostname-only HTTPS link should be normalized and saved');
assert.strictEqual(vm.runInContext('sprintPrdLinks(sprintById("s1"))[1].url', context), 'https://docs.example.com/search',
  'hostname-only input must normalize to an HTTPS URL');
assert.strictEqual(vm.runInContext('sprintById("s1").prdLinks.length', context), 3,
  'saving a new PRD must not silently delete an older invalid entry');
assert.strictEqual(dirtyCalls, 1, 'saving a PRD link must participate in device sync');
assert.strictEqual(vm.runInContext('tambahSprintPrd(sprintById("s1"), "Duplicate", "https://docs.example.com/search")', context), false,
  'duplicate PRD links must be rejected');
assert.strictEqual(vm.runInContext('hapusSprintPrd(sprintById("s1"), "new-id")', context), true,
  'a saved PRD link must be removable');
assert.strictEqual(dirtyCalls, 2, 'removing a PRD link must participate in device sync');

assert(syncSource.includes('sprints: ambil("catet.sprints.v1")'),
  'synced AI-readable state must include sprint PRD links');
assert(updaterSource.includes('sprints: state.stores.sprints'),
  'the external automation context must receive the sprint store containing PRD links');
assert(jiraSource.includes('function renderSprintPrd(s)'), 'sprint UI must have a dedicated PRD renderer');
assert(jiraSource.includes('prdLinks.length + " PRD"'), 'collapsed sprint row must expose the saved PRD count');
assert(jiraSource.includes('target = "_blank"'), 'PRD links must open without replacing Catet');
assert(jiraSource.includes('rel = "noopener noreferrer"'), 'external PRD links must isolate the opener');
assert(jiraSource.includes('aria-expanded'), 'the compact PRD control must expose its expanded state');
assert(css.includes('.sprint-prd-panel'), 'PRD panel must have responsive component styling');

console.log('sprint PRD link tests: OK');