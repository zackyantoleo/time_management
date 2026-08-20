const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const board = fs.readFileSync(path.join(root, 'assets/js/board.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'assets/js/sync.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');

assert(html.indexOf('assets/js/dependency-matcher.js') < html.indexOf('assets/js/tasks.js'),
  'browser must load dependency matcher before application features');
assert(sw.includes('assets/js/dependency-matcher.js'), 'service worker must cache dependency matcher');
assert(jira.includes('j.depOverrides = j.depOverrides || {}'), 'manual mapping must persist in the synced Jira store');
assert(sync.includes('delete j.pairingIssues') && sync.includes('delete j.depWarnings'),
  'large/ephemeral Jira pairing cache must not be copied into synced state');
assert(!sync.includes('delete j.depOverrides'), 'manual pairing overrides must remain synced');
assert(sync.includes('stores.jira.pairingIssues = jira.pairingIssues'),
  'pulling remote state must retain the device-local Jira candidate cache');
assert(jira.includes('hitungPasangan(nativeDeps)'), 'Jira sync must combine native and inferred mappings');
assert(jira.includes('filter((s) => !nativeKeys.has(s.qaKey))'),
  'native Jira dependencies must suppress inferred suggestions');
assert(jira.includes('filter((w) => !nativeKeys.has(w.key) && !nativeDevKeys.has(w.key))'),
  'native Jira dependencies must suppress false missing-pair warnings on both QA and dev');
assert(jira.includes('renderPairingWarnings()'), 'Jira tab must render pairing warnings');
assert(jira.includes('pilihDependency(key, c.key)'), 'ambiguous candidates must be manually confirmable');
assert(jira.includes('hapusPilihanDependency'), 'manual confirmation must be reversible');
assert(board.includes('warningBadge(warn)'), 'board must surface missing-pair warnings');
assert(worker.includes('pairingIssues'), 'worker must return sprint pairing metadata');
assert(worker.includes('sprint in ('), 'worker must search complete active sprints');
assert(!worker.includes('description: f.description'), 'raw Jira description must not be returned to browser');

console.log(JSON.stringify({ ok: true }));
