const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'assets/css/calm-workbench.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert(css.includes('@media (max-width: 760px)'), 'mobile breakpoint must remain explicit');
assert(css.includes('min-width: 0; max-width: 100%;'), 'mobile descendants need a shrink boundary');
assert(css.includes('.task-actions { width: 100%;'), 'task actions must move below task content on narrow phones');
assert(css.includes('.jira-summary { flex-basis: 100%;'), 'Jira summary must get its own mobile row');
assert(css.includes('.focus-actions > button'), 'focus actions need full-width mobile controls');
assert(css.includes('.sprint-prd-form { grid-template-columns: 1fr;'), 'PRD form must stack on mobile');
assert(css.includes('.log-entry .log-text { flex-basis: calc(100% - 28px);'), 'work-log text must reserve a stable row');
assert(css.includes('@media (max-width: 360px)'), 'extra-small phones need a dedicated breakpoint');
assert(css.includes('.brand .tag { display: none; }'), 'extra-small header must hide secondary tagline');
assert(css.includes('.tabs { width: 100%;'), 'mobile tabs must fit the viewport');
assert(css.includes('.tab { flex: 1 1 0;'), 'mobile tab targets must share available width');
assert(/const CACHE = "catet-v\d+"/.test(sw), 'service worker cache must be versioned');

console.log('mobile layout contract tests: OK');
