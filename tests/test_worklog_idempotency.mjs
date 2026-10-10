import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const rows = new Map();
const rowKey = (userId, entryId) => JSON.stringify([userId, entryId]);
const users = {
  'test-code': { id: 'user-a', jira_site: 'https://jira.test', jira_email: 'a@example.invalid', jira_token: 'synthetic-a' },
  'other-code': { id: 'user-b', jira_site: 'https://jira.test', jira_email: 'b@example.invalid', jira_token: 'synthetic-b' },
};
const hash = async text => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
const usersByHash = new Map(await Promise.all(Object.entries(users).map(async ([code, user]) => [await hash(code), user])));
const env = {
  REQUIRE_AUTH: '1',
  CATET_DB: {
    async exec() {},
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes('FROM users')) return usersByHash.get(this.args[0]) || null;
          if (sql.includes('FROM worklog_requests')) return rows.get(rowKey(...this.args)) || null;
          return null;
        },
        async run() {
          const a = this.args;
          if (sql.includes('INSERT INTO worklog_requests')) {
            const key = rowKey(a[0], a[1]);
            if (rows.has(key)) return { meta: { changes: 0 } };
            rows.set(key, { payload_hash: a[2], worklog_id: null });
          } else if (sql.includes('UPDATE worklog_requests')) {
            rows.get(rowKey(a[1], a[2])).worklog_id = a[0];
          } else if (sql.includes('DELETE FROM worklog_requests')) {
            rows.delete(rowKey(a[0], a[1]));
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  },
};
let remote = [], posts = 0, loseResponse = false, holdPost = false, release;
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    posts++;
    const payload = JSON.parse(options.body);
    const log = { ...payload, id: String(posts) };
    if (holdPost) await new Promise(resolve => { release = resolve; });
    remote.push(log);
    if (loseResponse) throw Error('response lost');
    return new Response(JSON.stringify(log), { status: 201 });
  }
  if (/\/worklog\?/.test(url)) return new Response(JSON.stringify({ worklogs: remote, total: remote.length, startAt: 0 }));
  const id = url.match(/\/worklog\/(\d+)/)?.[1];
  return new Response(JSON.stringify(remote.find(x => x.id === id)), { status: 200 });
};
const body = { entryId: 'entry-1', key: 'QA-999', started: '2026-10-09T02:00:00Z', timeSpentSeconds: 1800, comment: 'Synthetic' };
const req = (b, code = 'test-code') => new Request('https://worker.test/worklog', {
  method: 'POST', headers: { Origin: 'https://zackyantoleo.github.io', 'X-Catet-Key': code, 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});
try {
  const first = await worker.fetch(req(body), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).worklogId, '1', 'write returns verified remote identity');
  const again = await worker.fetch(req(body), env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).worklogId, '1');
  assert.equal(posts, 1, 'duplicate must not POST again');
  assert.equal((await worker.fetch(req({ ...body, comment: 'Changed' }), env)).status, 409);
  loseResponse = true;
  assert.equal((await worker.fetch(req({ ...body, entryId: 'entry-2' }), env)).status, 502);
  loseResponse = false;
  const retry = await worker.fetch(req({ ...body, entryId: 'entry-2' }), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).worklogId, '2');
  assert.equal(posts, 2, 'ambiguous retry reconciles property, never repeats POST');
  assert.equal((await worker.fetch(req({ ...body, timeSpentSeconds: 'bad' }), env)).status, 400);
  assert.equal(posts, 2);
  holdPost = true;
  const inFlight = worker.fetch(req({ ...body, entryId: 'overlap' }), env);
  for (let i = 0; !release; i++) { assert(i < 100, 'POST reached'); await new Promise(r => setTimeout(r, 5)); }
  const overlap = await worker.fetch(req({ ...body, entryId: 'overlap' }), env);
  assert.equal(overlap.status, 409, 'second in-flight sender cannot POST');
  assert.equal(posts, 3);
  holdPost = false; release();
  assert.equal((await inFlight).status, 200);
  assert.equal((await worker.fetch(req({ ...body, entryId: 'overlap' }), env)).status, 200);
  assert.equal(posts, 3);
  const other = await worker.fetch(req(body, 'other-code'), env);
  assert.equal(other.status, 200, 'same entry ID belongs to separate users');
  assert.equal(posts, 4);
  assert.notEqual(rows.get(rowKey('user-a', 'entry-1')).worklog_id, rows.get(rowKey('user-b', 'entry-1')).worklog_id);
  console.log('worklog idempotency/read-back/reconciliation/overlap/user isolation: PASS');
} finally { globalThis.fetch = original; }
