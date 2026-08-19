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

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/update_daily_priority.js'),
    '--dry-run', '--worker-url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => {
    server.close();
    assert.strictEqual(code, 0, stderr);
    assert(!stdout.includes(marker), 'updater stdout leaked task text');
    const meta = JSON.parse(stdout);
    assert.deepStrictEqual(Object.keys(meta).sort(), ['active', 'date', 'dryRun', 'items', 'today']);
    assert.strictEqual(meta.items, 1);
    console.log(JSON.stringify({ ok: true, metadataOnly: true }));
  });
});