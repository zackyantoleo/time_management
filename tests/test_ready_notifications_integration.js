const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const jira = fs.readFileSync(path.join(root, 'assets/js/jira.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'assets/js/sync.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/calm-workbench.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const matcher = fs.readFileSync(path.join(root, 'assets/js/dependency-matcher.js'), 'utf8');

assert(html.includes('id="ready-alert-btn"'), 'header must expose ready-to-test notification entry point');
assert(html.includes('id="ready-alert-panel"'), 'app must provide a persistent ready-to-test panel');
assert(html.includes('id="ready-alert-list"'), 'panel must provide a list target');
assert(html.indexOf('assets/js/ready-notifications.js') < html.indexOf('assets/js/jira.js'),
  'ready state machine must load before Jira integration');
assert(sw.includes('assets/js/ready-notifications.js'), 'service worker must cache notification state machine');
assert(jira.includes('CatetReadyNotifications.normalize(readyState)'),
  'legacy Jira stores must be normalized');
assert(jira.includes('rekonsiliasiReadyNotifications(feed)'),
  'every successful Jira sync must detect readiness transitions');
assert(jira.includes('CatetReadyNotifications.visible'), 'UI must hide notices only after retention expires');
assert(jira.includes('localStorage.setItem(READY_NOTIFICATIONS_KEY'),
  'device-local edge history must persist independently from remote Jira snapshots');
assert(sync.includes('delete j.readyNotifications'),
  'device-local edge history must not be overwritten by cloud snapshot conflicts');
assert(worker.includes('const doneAt = done ? (f.resolutiondate || f.statuscategorychangedate || null) : null;'),
  'Worker must expose authoritative Jira Done time for readiness retention');
assert(jira.includes('readyAt: f.deps.every((d) => d.done)'),
  'native dependency readiness must carry the final Done timestamp');
assert(matcher.includes('doneAt: dev.doneAt || null'),
  'inferred dependency readiness must preserve Jira Done timestamp');
assert(css.includes('.ready-alert-panel') && css.includes('.ready-alert-item'),
  'notification surface must be styled');
assert(css.includes('.ready-alert-btn[hidden]'),
  'component display styles must not override the native hidden state');

console.log(JSON.stringify({ ok: true, surface: 'header-panel', durable: true }));
