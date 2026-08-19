const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function waitForServer(url, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => fetch(url).then(() => resolve()).catch((error) => {
      if (Date.now() - started >= timeoutMs) reject(error);
      else setTimeout(attempt, 100);
    });
    attempt();
  });
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], {
    cwd: require('path').resolve(__dirname, '..'), stdio: 'ignore',
  });
  try {
    await waitForServer('http://127.0.0.1:8765/');
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const task = {
    id: 'smoke-1', text: 'QA-999 — Smoke daily priority', priority: 'tinggi', due: null,
    createdAt: new Date(now - 4 * 86400000).toISOString(), status: 'aktif', doneAt: null,
    focusedAt: null, notified: false,
  };
  const snapshot = { date: localDate, generatedAt: now.toISOString(), active: 1, today: 1,
    items: [{ taskId: task.id, text: task.text, score: 7, rank: 1 }] };
  const state = {
    updatedAt: now.toISOString(),
    stores: {
      tasks: [task], worklog: [], routines: [], routineday: {},
      jira: { site: 'https://example.atlassian.net', items: [], dismissed: [], deps: {}, bau: {} },
      sprints: { list: [], aktif: null },
    },
  };

  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium' });
  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'light' });
  const page = await context.newPage();
  const browserErrors = [];
  let phase = 'http';
  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: x }) => {
    browserErrors.push(`exception(${phase}): ${(x.exception && x.exception.description) || x.text} ${x.url || ''}:${x.lineNumber || 0}:${x.columnNumber || 0}`);
  });
  page.on('console', (msg) => { if (msg.type() === 'error') browserErrors.push(`console(${phase}): ` + msg.text()); });
  await page.addInitScript((seed) => {
    localStorage.setItem('catet.tasks.v1', JSON.stringify(seed.stores.tasks));
    localStorage.setItem('catet.worklog.v1', '[]');
    localStorage.setItem('catet.routines.v1', '[]');
    localStorage.setItem('catet.routineday.v1', '{}');
    localStorage.setItem('catet.jira.v1', JSON.stringify(seed.stores.jira));
    localStorage.setItem('catet.sprints.v1', JSON.stringify(seed.stores.sprints));
  }, state);
  await page.route('**/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
  await page.route('**/priority-snapshot', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) }));
  await page.route('**/tickets*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route((url) => url.pathname === '/calendar', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[]}' }));
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((seed) => { terapkanRemote(seed.stores); render(); }, state);
  await page.waitForFunction(() => document.querySelector('#daily-priority')?.textContent.includes('Prioritas hari ini'));
  const card = await page.locator('#daily-priority').innerText();
  const row = await page.locator('.task').first().textContent();
  if (!card.includes('Smoke daily priority') || !card.includes('score 7/10')) {
    throw new Error(`bad card: ${JSON.stringify(card)} html=${await page.locator('#daily-priority').evaluate((n) => n.outerHTML)}`);
  }
  if (!row.includes('score') || row.includes('priority today')) {
    throw new Error(`bad task row: ${JSON.stringify(row)} html=${await page.locator('.task').first().evaluate((n) => n.outerHTML)}`);
  }
  await page.evaluate(() => {
    dailyPriority = { date: '2000-01-01', items: [] };
    renderDailyPriority();
  });
  if (!(await page.locator('#daily-priority').evaluate((n) => n.classList.contains('hidden')))) {
    throw new Error('stale snapshot must be hidden');
  }
  await page.evaluate((value) => { dailyPriority = value; renderDailyPriority(); }, snapshot);
  const shots = path.resolve(__dirname, 'screenshots');
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, 'daily-priority-light.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: path.join(shots, 'daily-priority-dark.png'), fullPage: true });

  phase = 'file';
  await page.goto('file://' + path.resolve(__dirname, '../index.html'), { waitUntil: 'domcontentloaded' });
  await page.evaluate((seed) => { terapkanRemote(seed.stores); render(); }, state);
  await page.waitForFunction(() => typeof CatetPriorityEngine === 'object' && document.querySelector('.task'));
  if (browserErrors.length) throw new Error(browserErrors.join('\n'));

  console.log(JSON.stringify({ httpCard: true, fileMode: true, screenshots: 2, browserErrors: 0 }));
  await browser.close();
  } finally {
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error); process.exit(1); });
