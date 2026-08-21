const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/calm-workbench.css'), 'utf8');
const board = fs.readFileSync(path.join(root, 'assets/js/board.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');

assert(html.includes('class="brand-mark"'), 'header must expose the compact CATET brand mark');
for (const label of ['Board', 'Jira', 'Calendar', 'Work log']) {
  assert(html.includes('aria-label="' + label + '"'),
    'icon-only mobile tab must retain accessible name: ' + label);
}
assert(html.includes('class="desktop-shell board-view"'), 'board must use a dedicated desktop workbench shell');
assert(html.includes('id="board-main"') && html.includes('id="board-sidebar"'),
  'board must split primary work from contextual sidebar');
assert(html.includes('id="capture-options"'), 'quick capture secondary controls need a disclosure container');
assert(html.includes('id="capture-more"') && html.includes('aria-expanded="false"'),
  'quick capture must expose secondary controls through an accessible native button');
assert(html.indexOf('id="capture-options"') < html.indexOf('id="sections"'),
  'capture options must stay coupled to quick capture before task sections');
assert(html.includes('id="sprint-context"') && html.includes('id="routine-context"'),
  'desktop sidebar must reserve sprint and routine context');
assert(app.includes('function updateBoardLayout()'), 'render cycle must populate contextual board sidebar');
assert(board.includes('function renderSprintContext()'), 'board must render active sprint progress and PRDs');
assert(board.includes('function renderRoutineContext()'), 'board must render today routines in the sidebar');
assert(board.includes('sprintEditId = s.id') && board.includes('setView("jira")'),
  'PRD context card must lead to its existing sprint editor');
assert(css.includes('.desktop-shell') && css.includes('grid-template-columns: minmax(0,1fr) 300px'),
  'desktop workbench needs the approved two-column layout');
assert(css.includes('@media (max-width: 760px)') && css.includes('grid-template-columns: 1fr'),
  'workbench must collapse to one column on mobile');
assert(css.includes('.focus-card:not(.empty)') && css.includes('--focus-surface'),
  'active focus must receive the approved high-emphasis treatment');
assert(css.includes('.capture-options.hidden'), 'secondary capture options must be truly collapsible');
assert(css.includes('.context-prd-link'), 'sprint PRD links need dedicated compact styling');

console.log('calm workbench UI tests: OK');