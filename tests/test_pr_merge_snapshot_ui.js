const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'assets/js/sync.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/calm-workbench.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert(html.includes('id="pr-merge-alert-list"'), 'ready panel must expose related PR merge list');
assert(html.includes('PR related sudah merged'), 'ready panel must explain the merge list');
assert(jira.includes('function renderPrMergeSnapshot()'), 'Jira UI must render shared PR merge snapshot');
assert(jira.includes('prMergeSnapshot.items'), 'render must consume snapshot items');
assert(jira.includes('item.prUrl'), 'merge rows must link to the exact pull request');
assert(sync.includes('fetch(jiraProxy() + "/pr-merge-snapshot"'), 'CATET must fetch the server-side merge snapshot');
assert(sync.includes('renderReadyNotifications()'), 'snapshot refresh must update the header count and rerender the list');
assert(css.includes('.pr-merge-alert-list'), 'merge list must have explicit styling');
assert(sw.includes('catet-v61'), 'service worker cache must be bumped for the new UI');

console.log('pr merge snapshot UI contract: ok');
