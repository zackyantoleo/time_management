// Synthetic fixtures only; all external requests are blocked.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = spawn('python3', ['-m', 'http.server', '18881', '--bind', '127.0.0.1'], {cwd: root, stdio: 'ignore'});
  let browser;
  try {
    for (let i=0; ;i++) {try {assert((await fetch('http://127.0.0.1:18881')).ok); break;} catch {assert(i<50); await new Promise(r=>setTimeout(r,100));}}
    browser = await chromium.launch({headless:true,args:['--allow-file-access-from-files']});
    for (const mode of ['http', 'file']) {
      const context = await browser.newContext({serviceWorkers:'block'});
      const page = await context.newPage(), errors=[];
      page.on('pageerror', e=>errors.push(e.message));
      await page.route('**/*', r=> /^(file:|http:\/\/127\.0\.0\.1:18881\/)/.test(r.request().url()) ? r.continue() : r.abort());
      await page.goto(mode==='http'?'http://127.0.0.1:18881':pathToFileURL(path.join(root,'index.html')).href);
      const result = await page.evaluate(() => {
        const base={text:'TEST-123 — Synthetic ticket',sprintId:'jira:1',priority:'sedang',createdAt:'2026-10-14T10:00:00Z'};
        tasks=[{...base,id:'old',status:'selesai',focusMins:25},{...base,id:'new',status:'aktif'}];
        worklog=[{id:'log',taskId:'old',mins:25}];
        sprints={list:[{id:'jira:1',jiraId:1,nama:'Synthetic sprint',auto:true,selesai:'2099-10-23'}],aktif:null};
        jira.dismissed=[];
        const before=JSON.stringify({tasks,worklog});
        sprintEditId='jira:1';
        const host=document.createElement('section'); document.body.replaceChildren(host);
        sprintRow(sprints.list[0],host);
        return {before,after:JSON.stringify({tasks,worklog}),rows:host.querySelectorAll('.sprint-tasks li').length,notice:host.textContent.includes('1 riwayat selesai'),run:host.querySelectorAll('.sprint-run').length};
      });
      assert.equal(result.rows,1); assert.equal(result.run,1); assert(result.notice); assert.equal(result.before,result.after);
      for(const theme of ['light','dark']) {await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme); await page.screenshot({path:path.join(process.env.TMPDIR,`catet-sprint-${mode}-${theme}.png`)});}
      assert.deepEqual(errors,[]); console.log(`PASS ${mode}: one active row, history notice, task/worklog unchanged, no page errors`);
      await context.close();
    }
  } finally {if(browser) await browser.close(); server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
