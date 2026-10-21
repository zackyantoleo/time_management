import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL("../worker/worker.js", import.meta.url), "utf8")).replace("../assets/js/work-pattern-report-contract.js", new URL("../assets/js/work-pattern-report-contract.js", import.meta.url).href);
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
// Global JIRA_* secrets stay in env to prove they are never used.
const env = { JIRA_SITE: 'https://owner.invalid', JIRA_EMAIL: 'owner@example.invalid', JIRA_API_TOKEN: 'owner-secret',
  CATET_DB: { async exec() {}, prepare() { return { bind() { return this; }, async first() { return {
    id: 'synthetic-user', jira_site: 'https://jira.test', jira_email: 'synthetic@example.invalid', jira_token: 'synthetic',
  }; } }; } } };
const issue = (key, name = 'Task', status = 'Done', timespent = null) => ({ key, fields: {
  summary: 'Synthetic ' + key, issuetype: { id: name === 'QAlity Test' ? '55' : '1', name },
  status: { name: status }, created: '2026-10-12T02:00:00Z', timespent,
  issuelinks: [{ type: { name: 'QAlity Test' } }],
} });
const pages = {
  assigned: [[issue('QA-1'), issue('QA-2', 'Task', 'In Progress', 1200)], [issue('QA-3', 'QAlity Test'), issue('QA-4', 'Bug'), issue('QA-5', 'Task', 'To Do')]],
  worked: [[{ key: 'QA-5' }]],
};
const original = globalThis.fetch;
let calls = [], malformed = false, repeat = false, denied = false, invalidToken;
globalThis.fetch = async (url, options = {}) => {
  assert.equal(options.method || 'GET', 'GET', 'research endpoint never writes Jira');
  const u = new URL(url); calls.push(u);
  assert.equal(u.origin, 'https://jira.test');
  assert.equal(u.pathname, '/rest/api/3/search/jql');
  const jql = u.searchParams.get('jql');
  assert(jql.includes('assignee = currentUser()'));
  assert(!jql.includes('statusCategory'), 'Done and non-sprint included');
  const which = jql.includes('worklogAuthor = currentUser()') ? 'worked' : 'assigned';
  const next = u.searchParams.get('nextPageToken');
  if (denied) return new Response('{}', { status: 403 });
  if (malformed) return new Response(JSON.stringify({ isLast: true }));
  if (invalidToken !== undefined) return new Response(JSON.stringify({ issues: which === 'worked' ? [] : pages[which][0], nextPageToken: invalidToken }));
  return new Response(JSON.stringify({ issues: pages[which][next ? 1 : 0] || [],
    ...(repeat ? { nextPageToken: 'same' } : (!next && which === 'assigned' ? { nextPageToken: 'next' } : { isLast: true })) }));
};
const request = (key = 'synthetic-code') => new Request('https://worker.test/missing-worklog', { headers: { Origin: 'https://zackyantoleo.github.io', ...(key ? { 'X-Catet-Key': key } : {}) } });
try {
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200, 'missing-worklog endpoint exists');
  const data = await response.json();
  assert.deepEqual(data.items.map(x => x.key), ['QA-1', 'QA-2', 'QA-4']);
  assert.equal(data.items[0].status, 'Done');
  assert.equal(data.items[1].key, 'QA-2', 'someone else\'s logged time does not hide my missing worklog');
  assert.equal(data.items[2].issueType, 'Bug', 'linked Bug retained');
  assert.equal(data.total, 3); assert.equal(data.excludedQality, 1);
  assert.equal(data.complete, true); assert(!Number.isNaN(Date.parse(data.checkedAt)));
  assert.equal(calls.length, 3, 'all pages fetched, no per-ticket fan-out');
  malformed = true;
  assert.equal((await worker.fetch(request(), env)).status, 502, 'malformed feed never appears empty');
  malformed = false; repeat = true;
  assert.equal((await worker.fetch(request(), env)).status, 502, 'repeated token fails closed');
  repeat = false; denied = true;
  assert.equal((await worker.fetch(request(), env)).status, 502, 'Jira errors never return a partial result');
  denied = false;
  for (const token of [0, false, [], {}]) {
    invalidToken = token;
    assert.equal((await worker.fetch(request(), env)).status, 502, 'invalid raw page token rejected: ' + JSON.stringify(token));
  }
  invalidToken = undefined;
  const before = calls.length;
  assert.equal((await worker.fetch(request(''), env)).status, 401, 'no access code is always rejected');
  assert.equal(calls.length, before, 'rejected request never reaches Jira');
  let authorization;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { authorization = options.headers.Authorization; return previousFetch(url, options); };
  const userEnv = { ...env, CATET_DB: { async exec() {}, prepare() { return { bind() { return this; }, async first() { return {
    id: 'synthetic-user', jira_site: 'https://jira.test', jira_email: 'user@example.invalid', jira_token: 'user-synthetic',
  }; } }; } } };
  const userReq = new Request('https://worker.test/missing-worklog', { headers: { Origin: 'https://zackyantoleo.github.io', 'X-Catet-Key': 'synthetic-code' } });
  assert.equal((await worker.fetch(userReq, userEnv)).status, 200);
  assert.equal(authorization, 'Basic ' + btoa('user@example.invalid:user-synthetic'), 'per-user credentials, never global owner');
  userEnv.CATET_DB.prepare = () => ({ bind() { return this; }, async first() { return { id: 'synthetic-user' }; } });
  assert.equal((await worker.fetch(userReq, userEnv)).status, 400, 'missing user credentials never fall back globally');
  console.log('missing worklog: all statuses, own author, QAlity type, pagination, failure/auth/user isolation: PASS');
} finally { globalThis.fetch = original; }
