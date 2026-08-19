const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require('path').join(__dirname, '../assets/js/priority-engine.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const engine = ctx.CatetPriorityEngine;
assert(engine, 'CatetPriorityEngine must be exported globally');

const now = new Date('2026-08-20T08:00:00+07:00');
const tasks = [
  { id: 'urgent', text: 'OPS-1 urgent', priority: 'urgent', status: 'aktif', createdAt: '2026-08-20T00:00:00+07:00' },
  { id: 'ready', text: 'QA-1 ready', priority: 'sedang', status: 'aktif', createdAt: '2026-08-01T00:00:00+07:00', sprintId: 'jira:1' },
  { id: 'blocked', text: 'QA-2 blocked', priority: 'sedang', status: 'aktif', createdAt: '2026-08-01T00:00:00+07:00', sprintId: 'jira:1' },
  { id: 'low', text: 'low', priority: 'rendah', status: 'aktif', createdAt: '2026-08-20T00:00:00+07:00' },
];
const inputCopy = JSON.parse(JSON.stringify(tasks));
const sprints = { list: [{ id: 'jira:1', selesai: '2026-08-22' }], aktif: 'jira:1' };
const jira = { deps: { 'QA-2': { ready: false, wait: [{ key: 'DEV-1' }] } } };
const snapshot = engine.snapshot({ tasks, sprints, jira, now });
assert.deepStrictEqual(tasks, inputCopy, 'snapshot must not mutate tasks');
assert.strictEqual(snapshot.date, '2026-08-20');
assert.strictEqual(snapshot.active, 4);
assert.deepStrictEqual(new Set(Array.from(snapshot.items, x => x.taskId)), new Set(['urgent', 'ready']));
assert.strictEqual(snapshot.items[0].rank, 1);
assert(snapshot.items[0].score >= snapshot.items[1].score);

const dueCases = [
  ['overdue', '2026-08-20T07:59:00+07:00', 4],
  ['24h', '2026-08-21T08:00:00+07:00', 3],
  ['48h', '2026-08-22T08:00:00+07:00', 2],
  ['later', '2026-08-23T08:00:00+07:00', 1],
];
for (const [name, due, expected] of dueCases) {
  assert.strictEqual(engine.duePoints({ due }, now), expected, name);
}
console.log(JSON.stringify({ ok: true, items: snapshot.items }));
