const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/js/ready-notifications.js'), 'utf8');

function load() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.CatetReadyNotifications;
}

const ready = load();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function dep(isReady, dev = 'DEV-1', readyAt = null) {
  return { ready: isReady, keys: [dev], source: 'jira-native', readyAt };
}

// First observation is a baseline, not a fake notification avalanche.
{
  const state = ready.normalize(null);
  const result = ready.reconcile(state, { 'QA-1': dep(true), 'QA-2': dep(false) }, {}, NOW);
  assert.strictEqual(result.added.length, 0);
  assert.deepStrictEqual(Object.keys(result.state.items), []);
  assert.strictEqual(result.state.readiness['QA-1'], true);
}

// Only false/missing -> true after baseline creates a notification.
{
  let state = ready.reconcile(ready.normalize(null), { 'QA-1': dep(false) }, {}, NOW).state;
  const meta = { 'QA-1': { summary: 'Test login', sprintId: null } };
  const result = ready.reconcile(state, { 'QA-1': dep(true, 'DEV-9') }, meta, NOW + DAY);
  assert.strictEqual(JSON.stringify(result.added), JSON.stringify(['QA-1']));
  assert.strictEqual(result.state.items['QA-1'].summary, 'Test login');
  assert.strictEqual(result.state.items['QA-1'].sprintId, null);
  assert.strictEqual(JSON.stringify(result.state.items['QA-1'].devKeys), JSON.stringify(['DEV-9']));
}

// A reliable Jira Done timestamp can recover a recent event on first observation.
{
  const readyAt = NOW - 2 * DAY;
  const result = ready.reconcile(ready.normalize(null), {
    'QA-RECENT': dep(true, 'DEV-RECENT', new Date(readyAt).toISOString()),
  }, {}, NOW);
  assert.strictEqual(result.added.includes('QA-RECENT'), true);
  assert.strictEqual(result.state.items['QA-RECENT'].readyAt, readyAt);
  assert.strictEqual(result.state.items['QA-RECENT'].expiresAt, readyAt + 7 * DAY);
}

// An old ready timestamp must not resurrect historical backlog.
{
  const readyAt = NOW - 8 * DAY;
  const result = ready.reconcile(ready.normalize(null), {
    'QA-OLD': dep(true, 'DEV-OLD', new Date(readyAt).toISOString()),
  }, {}, NOW);
  assert.strictEqual(result.added.length, 0);
  assert.strictEqual(result.state.items['QA-OLD'], undefined);
}

// Feed disappearance is unknown, not false; reappearance must not alert.
{
  let state = ready.reconcile(ready.normalize(null), { 'QA-1': dep(true) }, {}, NOW).state;
  state = ready.reconcile(state, {}, {}, NOW + DAY).state;
  const result = ready.reconcile(state, { 'QA-1': dep(true) }, {}, NOW + 2 * DAY);
  assert.strictEqual(result.added.length, 0);
}

// Sprint membership is metadata only: sprint and non-sprint both qualify.
{
  let state = ready.reconcile(ready.normalize(null), {
    'QA-SPRINT': dep(false), 'QA-BACKLOG': dep(false),
  }, {}, NOW).state;
  const meta = {
    'QA-SPRINT': { summary: 'Sprint ticket', sprintId: '11136', sprintName: 'Sprint 2' },
    'QA-BACKLOG': { summary: 'Backlog ticket', sprintId: null, sprintName: null },
  };
  const result = ready.reconcile(state, {
    'QA-SPRINT': dep(true), 'QA-BACKLOG': dep(true),
  }, meta, NOW + DAY);
  assert.strictEqual(JSON.stringify([...result.added].sort()), JSON.stringify(['QA-BACKLOG', 'QA-SPRINT']));
}

// Notice remains visible for at least seven full days, then expires.
{
  let state = ready.reconcile(ready.normalize(null), { 'QA-1': dep(false) }, {}, NOW).state;
  state = ready.reconcile(state, { 'QA-1': dep(true) }, {}, NOW + DAY).state;
  assert.strictEqual(ready.visible(state, NOW + 8 * DAY - 1).length, 1);
  assert.strictEqual(ready.visible(state, NOW + 8 * DAY).length, 0);
}

// A ready -> false -> ready transition creates a fresh seven-day window.
{
  let state = ready.reconcile(ready.normalize(null), { 'QA-1': dep(false) }, {}, NOW).state;
  state = ready.reconcile(state, { 'QA-1': dep(true) }, {}, NOW + DAY).state;
  const firstAt = state.items['QA-1'].readyAt;
  state = ready.reconcile(state, { 'QA-1': dep(false) }, {}, NOW + 2 * DAY).state;
  state = ready.reconcile(state, { 'QA-1': dep(true) }, {}, NOW + 3 * DAY).state;
  assert(state.items['QA-1'].readyAt > firstAt);
  assert.strictEqual(ready.visible(state, NOW + 10 * DAY - 1).length, 1);
}

console.log(JSON.stringify({ ok: true, retentionDays: 7, sprintAgnostic: true }));
