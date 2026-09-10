const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/weekly-correction.js'), 'utf8');
const context = vm.createContext({
  console,
  localStorage: {
    _data: new Map(),
    getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
    setItem(key, value) { this._data.set(key, String(value)); },
    removeItem(key) { this._data.delete(key); },
  },
});
vm.runInContext(source, context);

const report = {
  schema_version: 1,
  report_id: '2026-W35',
  generated_at: '2026-09-02T13:00:00.000Z',
  period: { start: '2026-08-24', end: '2026-08-30', label: '24–30 Agustus 2026', timezone: 'Asia/Jakarta' },
};

const ack = vm.runInContext(
  'buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "looks_right", note: "ignore me", source: "live" })',
  context
);
assert.strictEqual(ack.schema_version, 1);
assert.strictEqual(ack.report_id, '2026-W35');
assert.strictEqual(ack.generated_at, '2026-09-02T13:00:00.000Z');
assert.strictEqual(ack.verdict, 'looks_right');
assert.strictEqual(ack.note, '', 'Looks right is an explicit ack record with empty note');
assert.ok(ack.correction_id && ack.idempotency_key);
assert.ok(!('slides' in ack) && !('evidence' in ack) && !('report' in ack),
  'correction must not embed the report or evidence bundle');

const missed = vm.runInContext(
  'buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "missed", note: "Hidden pairing review", source: "live" })',
  context
);
assert.strictEqual(missed.verdict, 'missed');
assert.strictEqual(missed.note, 'Hidden pairing review');

const stripped = vm.runInContext(
  'sanitizeWeeklyCorrectionNote("Gap di QA-12. Email zack@erajaya.com token ghp_abcdefghijklmnopqrstuvwxyz012345 jwt eyJhbGciOiJIUzI1NiJ9.aa.bb https://private.example/secret")',
  context
);
assert(!/zack@erajaya.com/.test(stripped), 'email must not be stored');
assert(!/ghp_/.test(stripped), 'token must not be stored');
assert(!/eyJhbGciOiJIUzI1NiJ9/.test(stripped), 'jwt must not be stored');
assert(!/https?:\/\//.test(stripped), 'URL must not be stored');
assert(stripped.includes('Gap di QA-12'), 'benign text may remain');

assert.throws(() => vm.runInContext('sanitizeWeeklyCorrectionNote("x".repeat(501))', context),
  /terlalu panjang|too long/i);
assert.throws(() => vm.runInContext(
  'buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "missed", note: "   ", source: "live" })',
  context), /wajib|required/i);
assert.throws(() => vm.runInContext(
  'buildWeeklyCorrection({ report: { report_id: "W35" }, verdict: "looks_right", source: "live" })',
  context), /report_id/);

assert.strictEqual(vm.runInContext('shouldPersistWeeklyCorrection("demo")', context), false,
  'demo fixture must not persist to production');
assert.strictEqual(vm.runInContext('shouldPersistWeeklyCorrection("live")', context), true);

const demoAck = vm.runInContext(
  'saveDemoWeeklyCorrection(buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "looks_right", source: "demo" }))',
  context
);
assert.strictEqual(demoAck.source, 'demo');
const stored = JSON.parse(context.localStorage.getItem('catet.weekly.corrections.demo.v1'));
assert.strictEqual(stored.report_id, '2026-W35');
assert.strictEqual(stored.verdict, 'looks_right');
assert.strictEqual(stored.source, 'demo', 'demo records stay clearly labelled demo');

const again = vm.runInContext(
  'saveDemoWeeklyCorrection(buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "looks_right", source: "demo" }))',
  context
);
assert.strictEqual(again.correction_id, demoAck.correction_id);
assert.strictEqual(again.revision, demoAck.revision, 'identical rerun must not create a duplicate revision');

const changed = vm.runInContext(
  'saveDemoWeeklyCorrection(buildWeeklyCorrection({ report: ' + JSON.stringify(report) + ', verdict: "wrong", note: "Scorecard kebanyakan", source: "demo" }))',
  context
);
assert.strictEqual(changed.verdict, 'wrong');
assert.strictEqual(changed.correction_id, demoAck.correction_id, 'one correction identity per report');
assert.ok(changed.revision > demoAck.revision, 'changed verdict updates the same record');
assert.strictEqual(JSON.parse(context.localStorage.getItem('catet.weekly.corrections.demo.v1')).verdict, 'wrong');
assert.strictEqual(context.localStorage.getItem('catet.tasks.v1'), null);
assert.strictEqual(context.localStorage.getItem('catet.weekly.v1'), null,
  'correction storage stays out of canonical weekly commitment state');

console.log('Weekly Wrapped correction contract tests passed.');
