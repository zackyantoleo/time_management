const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const updater = fs.readFileSync(path.join(root, 'scripts/update_daily_priority.js'), 'utf8');

assert(html.indexOf('assets/js/priority-engine.js') < html.indexOf('assets/js/tasks.js'),
  'browser must load the shared engine before tasks.js');
assert(sw.includes('assets/js/priority-engine.js'), 'service worker must cache the shared engine');
assert(updater.includes('../assets/js/priority-engine.js'), 'Node updater must load the browser engine file');
assert(updater.includes('process.env.TZ = "Asia/Jakarta"'), 'Node updater must calculate the daily snapshot in WIB');
assert(!updater.includes('console.log(JSON.stringify(snapshot))'),
  'updater logs must not print task text or ticket keys');

console.log(JSON.stringify({ ok: true }));