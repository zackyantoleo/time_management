'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/work-patterns.sample.json')));
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const etag = x => '"sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable(x))).digest('hex') + '"';
async function main() {
  const source = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8').replace('../assets/js/work-pattern-report-contract.js', pathToFileURL(path.join(root, 'assets/js/work-pattern-report-contract.js')).href);
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  let row, writes = 0, race;
  const env = { REQUIRE_AUTH: '1', WEEKLY_WRAPPED_SERVICE_TOKEN: 'synthetic-service', CATET_DB: {
    prepare(sql) { return { bind(...args) { return {
      async first() {
        if (sql.includes('FROM users WHERE token_hash')) return args[0] === crypto.createHash('sha256').update('synthetic-access').digest('hex') ? { id: 'synthetic-user' } : null;
        if (sql.includes('FROM weekly_wrapped_reports')) return row ? { ...row } : null;
        throw new Error('unexpected SQL read');
      },
      async run() {
        if (race) { row = race; race = null; }
        if (sql.startsWith('UPDATE weekly_wrapped_reports')) {
          if (!row || row.blob !== args[4] || row.updated_at !== args[5]) return { meta: { changes: 0 } };
        } else {
          assert(sql.includes('INSERT INTO weekly_wrapped_reports'));
          if (sql.includes('json_extract') && row && JSON.parse(row.blob).schema_version !== 1) return { meta: { changes: 0 } };
        }
        row = { report_id: args[1], blob: args[2], updated_at: args[3] }; writes++;
        return { meta: { changes: 1 } };
      }, async all() { return { results: [] }; },
    }; } }; }, async exec() {}, async batch() { return []; },
  } };
  const call = (method, body, extra = {}, auth = true) => worker.fetch(new Request('https://synthetic.invalid/weekly-wrapped', {
    method, headers: { Origin: 'https://zackyantoleo.github.io', 'Content-Type': 'application/json',
      ...(auth ? { 'X-Catet-Key': 'synthetic-access', Authorization: 'Bearer synthetic-service' } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  assert.equal((await call('PUT', fixture, {}, false)).status, 401);
  assert.equal((await call('PUT', fixture)).status, 428, 'v2 writes need an exact conditional-write precondition');
  assert.equal(writes, 0);
  const old = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/weekly-wrapped.sample.json')));
  assert.equal((await call('PUT', old)).status, 200, 'legacy v1 initial write preserved');
  const get = await call('GET'); assert.equal(get.headers.get('ETag'), etag(old));
  assert.match(get.headers.get('Cache-Control'), /no-transform/, 'edge must preserve strong digest ETag');
  assert.equal(get.headers.get('Content-Encoding'), 'identity');
  assert.equal((await call('PUT', fixture, { 'If-Match': etag(fixture) })).status, 412);
  assert.equal((await call('PUT', fixture, { 'If-Match': etag(old) })).status, 200);
  assert.deepEqual(JSON.parse(row.blob), fixture);
  assert.equal((await call('PUT', old)).status, 428, 'legacy writer cannot silently downgrade v2');
  assert.equal((await call('PUT', old, { 'If-Match': etag(old) })).status, 412);
  assert.equal((await call('PUT', old, { 'If-Match': etag(fixture) })).status, 200, 'conditional rollback to v1');
  race = { report_id: fixture.report_id, blob: JSON.stringify(fixture), updated_at: 'synthetic-concurrent-version' };
  assert.equal((await call('PUT', fixture, { 'If-Match': etag(old) })).status, 412, 'atomic CAS catches write after pre-read');
  assert.equal(row.updated_at, 'synthetic-concurrent-version');
  // The unconditioned legacy writer must also lose a race against newly installed v2.
  row = { report_id: old.report_id, blob: JSON.stringify(old), updated_at: 'synthetic-before' };
  race = { report_id: fixture.report_id, blob: JSON.stringify(fixture), updated_at: 'synthetic-racer' };
  assert.equal((await call('PUT', old)).status, 412);
  assert.equal(row.updated_at, 'synthetic-racer');
  console.log('WEEKLY_WRAPPED_PUBLISH_GATE_OK: auth; v2 precondition; exact ETag; atomic CAS; v1 compatibility; guarded rollback; legacy race');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
