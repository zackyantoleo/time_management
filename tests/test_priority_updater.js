const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const marker = 'PRIVATE-TICKET-123 must-not-leak';
const state = {
  stores: {
    tasks: [{ id: 'a', text: marker, priority: 'urgent', status: 'aktif', createdAt: new Date().toISOString() }],
    sprints: { list: [] }, jira: {},
  },
};

let seenKeys = [];
const server = http.createServer((req, res) => {
  seenKeys.push(req.headers['x-catet-key'] || '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
});

function run(port, key) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CATET_ACCESS_KEY;
    if (key) env.CATET_ACCESS_KEY = key;
    const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/update_daily_priority.js'),
      '--dry-run', '--worker-url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    const missing = await run(port, '');
    assert.notStrictEqual(missing.code, 0, 'updater must refuse to run without an access code');
    assert.deepStrictEqual(seenKeys, [], 'no anonymous request is sent');
    const { code, stdout, stderr } = await run(port, 'synthetic-code');
    assert.strictEqual(code, 0, stderr);
    assert.deepStrictEqual(seenKeys, ['synthetic-code'], 'state read carries the access code');
    assert(!stdout.includes(marker), 'updater stdout leaked task text');
    const meta = JSON.parse(stdout);
    assert.deepStrictEqual(Object.keys(meta).sort(), ['active', 'date', 'dryRun', 'items', 'today']);
    assert.strictEqual(meta.items, 1);
    console.log(JSON.stringify({ ok: true, metadataOnly: true, requiresAccessCode: true }));
  } finally { server.close(); }
});