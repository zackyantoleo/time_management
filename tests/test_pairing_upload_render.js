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

console.log(JSON.stringify({ ok: true }));
