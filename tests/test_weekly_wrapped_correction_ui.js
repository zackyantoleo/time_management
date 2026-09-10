const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'weekly-wrapped.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/weekly-wrapped.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'assets/js/weekly-correction.js'), 'utf8');
const wrapped = fs.readFileSync(path.join(root, 'assets/js/weekly-wrapped.js'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/weekly-wrapped.sample.json'), 'utf8'));
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert(html.includes('id="wrapped-correction"'), 'report page must expose a default correction panel');
assert(html.includes('id="correction-looks-right"'), 'default path must include Looks right');
assert(html.includes('Looks right'), 'Looks right label must be visible');
assert(html.includes('id="correction-wrong"'), 'default path must include Ada yang salah');
assert(html.includes('Ada yang salah'), 'Ada yang salah label must be visible');
assert(html.includes('id="correction-missed"'), 'default path must include Yang terlewat');
assert(html.includes('Yang terlewat'), 'Yang terlewat label must be visible');
assert(html.includes('id="correction-note"'), 'free-text missed note must exist');
assert(html.includes('id="correction-save-missed"'), 'Yang terlewat must have an explicit save action');
assert(html.includes('id="wrapped-advanced"'), 'long form must live under Advanced');
assert(html.includes('<details'), 'Advanced must be collapsed by default via details');
assert(html.indexOf('id="wrapped-correction"') < html.indexOf('id="wrapped-advanced"'),
  'correction actions must appear before Advanced');
assert(html.indexOf('id="wrapped-report"') < html.indexOf('id="wrapped-correction"'),
  'report must be visible without opening Advanced');
assert(html.includes('id="weekly-start-form"') && html.includes('id="weekly-end-form"'),
  'Advanced may keep the long start/end-week forms, but they are not the default path');
assert(html.includes('assets/js/weekly-correction.js'), 'correction script must load on the report page');
assert(html.includes('assets/js/weekly-checkin.js'), 'Advanced long form needs the existing check-in script');
assert(html.includes('assets/js/util.js'), 'check-in script depends on util helpers');

assert(index.includes('<details') && index.includes('id="weekly-advanced"'),
  'index check-in long form must move into collapsed Advanced');
assert(index.indexOf('id="weekly-advanced"') < index.indexOf('id="weekly-start-form"'),
  'start/end-week forms must sit inside Advanced on index.html');
assert(index.includes('Open Wrapped'), 'index Advanced still points people to the report, not the other way around');

assert(css.includes('.wrapped-correction'), 'correction panel must have explicit CATET-token styling');
assert(css.includes('var(--accent)'), 'correction styling must reuse CATET tokens');
assert(css.includes('#wrapped-advanced'), 'Advanced collapse must be styled, not redesigned as a new product');
assert(css.includes('@media (max-width: 760px)'), 'correction actions must remain usable on mobile');

assert(js.includes('function sanitizeWeeklyCorrectionNote'), 'free text must be sanitized in one place');
assert(js.includes('function buildWeeklyCorrection'), 'correction records must be built separately from report rendering');
assert(js.includes('function shouldPersistWeeklyCorrection'), 'demo must not silently write production corrections');
assert(js.includes('looks_right'), 'Looks right must persist an explicit ack verdict');
assert(js.includes('/weekly-wrapped/corrections'), 'live corrections go to a dedicated Worker route');
assert(!js.includes('catet.tasks.v1') && !js.includes('catet.worklog.v1'),
  'corrections must not write canonical task/worklog state');
assert(!wrapped.includes('function buildReport') && !wrapped.includes('function analyzeEvidence'),
  'CATET must remain a viewer, not an analysis engine');
assert(wrapped.includes('initWeeklyCorrection'), 'report viewer must wire correction actions after load');

assert.strictEqual(sample.schema_version, 1, 'demo fixture must declare the live report schema');
assert.strictEqual(sample.report_id, '2026-W35', 'demo fixture must carry the actual report_id identity');
assert(sample.generated_at, 'demo fixture must carry generated_at so corrections can point at a snapshot');
assert.strictEqual(sample.period.timezone, 'Asia/Jakarta', 'demo fixture timezone must match the Worker contract');
assert(sw.includes('assets/js/weekly-correction.js'), 'offline cache must include correction behavior');
const cacheVersion = Number((sw.match(/const CACHE = "catet-v(\d+)"/) || [])[1]);
assert(Number.isInteger(cacheVersion) && cacheVersion >= 67,
  'service worker cache must bump for the correction assets');

console.log('Weekly Wrapped correction UI contract passed.');
