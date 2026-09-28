const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jiraSrc = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');

// Static contracts: optimistic upload state must match what depBadge expects.
const uploadFn = jiraSrc.slice(
  jiraSrc.indexOf('async function uploadDependencyKeJira'),
  jiraSrc.indexOf('function dependencyReview')
);
assert(
  /jira\.deps\[qaKey\]\s*=\s*\{[\s\S]*wait\s*:/.test(uploadFn),
  'upload must set deps.wait so depBadge does not crash before the next sync'
);
assert(
  /jira\.deps\[qaKey\]\s*=\s*\{[\s\S]*keys\s*:\s*\[devKey\]/.test(uploadFn),
  'upload must keep keys: [devKey] for the native pair'
);

const badgeFn = jiraSrc.slice(
  jiraSrc.indexOf('function depBadge(dep)'),
  jiraSrc.indexOf('/* ---------- sinkronisasi otomatis lewat proxy')
);
assert(
  /Array\.isArray\(dep\.wait\)/.test(badgeFn) || /dep\.wait\s*&&/.test(badgeFn) || /\(dep\.wait\s*\|\|\s*\[\]\)/.test(badgeFn),
  'depBadge must tolerate missing/empty wait arrays instead of throwing on wait[0]'
);

// Runtime: depBadge must not throw when wait is missing (the blank-page path).
const sandbox = {
  jira: { site: 'https://jira.test' },
  jiraSite() { return (sandbox.jira.site || '').trim().replace(/\/+$/, ''); },
  jiraUrl(key) { return sandbox.jiraSite() + '/browse/' + key; },
  el(tag, cls, text) {
    const node = {
      tagName: String(tag || 'span').toUpperCase(),
      className: cls || '',
      textContent: text == null ? '' : String(text),
      href: '',
      title: '',
      target: '',
      rel: '',
      onclick: null,
      children: [],
      append(...xs) { this.children.push(...xs); return this; },
    };
    return node;
  },
};
vm.createContext(sandbox);
vm.runInContext(badgeFn + '\nthis.depBadge = depBadge;', sandbox);

assert.doesNotThrow(() => {
  const badge = sandbox.depBadge({ keys: ['DEV-201'], done: false, source: 'jira-native' });
  assert.ok(badge, 'badge should render even without wait[]');
  assert.match(String(badge.textContent || badge.className), /dev: DEV-201|dep-wait|ready to test/);
}, 'depBadge must not throw when wait is missing — that blanked #jiraview after Upload ke Jira');

assert.doesNotThrow(() => {
  sandbox.depBadge({ keys: ['DEV-201'], ready: false, wait: [] });
}, 'depBadge must not throw on empty wait[]');

// Call sites must not append(null) if badge is skipped.
assert.match(jiraSrc, /const badge = dep \? depBadge\(dep\) : null/);
assert.match(jiraSrc, /if \(badge\) li\.append\(badge\)/);
assert.match(jiraSrc, /if \(badge\) row\.append\(badge\)/);
const boardSrc = fs.readFileSync(path.join(root, 'assets/js/board.js'), 'utf8');
assert.match(boardSrc, /const badge = dep && typeof depBadge === \"function\" \? depBadge\(dep\) : null/);
assert.match(boardSrc, /if \(badge\) meta\.append\(badge\)/);

const withWait = sandbox.depBadge({
  keys: ['DEV-201'],
  ready: false,
  wait: [{ key: 'DEV-201', status: 'In Progress' }],
});
assert.match(String(withWait.textContent), /DEV-201/);

// Runtime: pending upload + verified state must use pairingIssues link∩chip,
// not jira.deps.source === jira-native (feed items often lack issueType).
const helperSrc = [
  jiraSrc.slice(jiraSrc.indexOf('function pairingMilikSaya'), jiraSrc.indexOf('function terapkanHasilPasangan')),
  jiraSrc.slice(jiraSrc.indexOf('function pairingPendingUntukSprint'), jiraSrc.indexOf('function pairingActionableUntukSprint')),
].join('\n');
const pairSandbox = {
  jira: {
    depOverrides: {
      'QA-MINE': 'DEV-1',
      'QA-OTHER': 'DEV-2',
      'QA-DONE': 'DEV-3',
    },
    pairingIssues: [
      {
        key: 'QA-MINE', summary: 'Test mine', sprintId: '77', assignedToMe: true,
        linkedKeys: [], mentionedKeys: [],
      },
      {
        key: 'QA-OTHER', summary: 'Test other', sprintId: '77', assignedToMe: false,
        linkedKeys: [], mentionedKeys: [],
      },
      {
        key: 'QA-DONE', summary: 'Test done', sprintId: '77', assignedToMe: true,
        linkedKeys: ['DEV-3'], mentionedKeys: ['DEV-3'],
      },
      {
        key: 'QA-LINK-ONLY', summary: 'Link only', sprintId: '77', assignedToMe: true,
        linkedKeys: ['DEV-9'], mentionedKeys: [],
      },
    ],
    deps: {
      // Simulate post-sync matcher source that is NOT jira-native — the old
      // upload-done check required source === jira-native and stayed stuck.
      'QA-DONE': { keys: ['DEV-3'], source: 'jira-link', wait: [] },
    },
  },
  CatetDependencyMatcher: {
    assignedKeysFromIssues(issues) {
      const all = (issues || []).filter((x) => x && x.key);
      if (!all.some((x) => Object.prototype.hasOwnProperty.call(x, 'assignedToMe'))) return null;
      return new Set(all.filter((x) => x.assignedToMe).map((x) => x.key));
    },
  },
  kunciTiketAssigned() {
    return pairSandbox.CatetDependencyMatcher.assignedKeysFromIssues(pairSandbox.jira.pairingIssues);
  },
  depsTiket() { throw new Error('pending check must not use depsTiket for upload-done'); },
};
vm.createContext(pairSandbox);
vm.runInContext(
  helperSrc + '\nthis.pairingMilikSaya = pairingMilikSaya;\nthis.pairingSudahDiJira = pairingSudahDiJira;\nthis.pairingPendingUntukSprint = pairingPendingUntukSprint;',
  pairSandbox
);

assert.strictEqual(pairSandbox.pairingSudahDiJira('QA-DONE', 'DEV-3'), true,
  'link + chip means upload is done even when deps.source is jira-link');
assert.strictEqual(pairSandbox.pairingSudahDiJira('QA-LINK-ONLY', 'DEV-9'), false,
  'Relates alone is not enough — description chip still required');
assert.strictEqual(pairSandbox.pairingSudahDiJira('QA-MINE', 'DEV-1'), false,
  'selected but not yet on Jira stays pending');

const pending = pairSandbox.pairingPendingUntukSprint({ auto: true, jiraId: 77 });
// Array dari vm.createContext beda realm → deepStrictEqual gagal meski isinya sama.
const pendingKeys = [...pending.map((p) => p.key)].sort();
assert.deepStrictEqual(pendingKeys, ['QA-MINE'],
  'pending list keeps my unfinished pair and drops other-assignee + fully-uploaded rows');
assert.ok(!pendingKeys.includes('QA-OTHER'),
  'tickets not assigned to me must not appear in Ticket pairing');
assert.ok(!pendingKeys.includes('QA-DONE'),
  'fully uploaded pairs must leave the pending upload list');

console.log(JSON.stringify({ ok: true, pending: pendingKeys }));
