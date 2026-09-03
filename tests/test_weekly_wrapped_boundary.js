const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const wrapped = fs.readFileSync(path.join(root, 'assets/js/weekly-wrapped.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'weekly-wrapped.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

assert(worker.includes('CREATE TABLE IF NOT EXISTS weekly_wrapped_reports'), 'Worker needs a derived weekly report store');
assert(worker.includes('url0.pathname === "/weekly-wrapped"'), 'Worker must expose the weekly report endpoint');
assert(worker.includes('WEEKLY_WRAPPED_SERVICE_TOKEN'), 'private engine writes must use a dedicated service token');
assert(worker.includes('validateWeeklyWrappedReport'), 'Worker must validate the sanitized report contract');
assert(worker.includes('schema_version !== 1'), 'Worker must pin the report contract version');
assert(worker.includes('item.sensitivity !== "sanitized"'), 'Worker must reject raw evidence');
assert(worker.includes('Snapshot Weekly Wrapped dipisah'), 'report must be documented as derived state, not canonical CATET state');
assert(wrapped.includes('fetchWeeklyWrappedReport'), 'CATET viewer must fetch its report through the Worker');
assert(wrapped.includes('headerAksesWrapped'), 'CATET viewer must use the existing per-device CATET access key');
assert(wrapped.includes('assets/data/weekly-wrapped.sample.json'), 'viewer may retain a clearly labelled demo fallback');
assert(html.includes('id="wrapped-source-status"'), 'viewer must disclose whether data is live or demo');
assert(!wrapped.includes('function buildReport') && !wrapped.includes('function analyzeEvidence'),
  'CATET must remain a viewer, not an analysis/generation engine');
const cacheVersion = Number((sw.match(/const CACHE = "catet-v(\d+)"/) || [])[1]);
assert(Number.isInteger(cacheVersion) && cacheVersion >= 65,
  'service worker cache must not regress below the viewer-boundary release');

console.log('Weekly Wrapped viewer/engine boundary contract passed.');
