const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=spawn('python3',['-m','http.server','18875','--bind','127.0.0.1'],{cwd:root,stdio:'ignore'});let browser;
 try{
  for(let i=0;;i++){try{assert((await fetch('http://127.0.0.1:18875/')).ok);break}catch(e){if(i>50)throw e;await wait(100)}}
  browser=await chromium.launch({headless:true,args:['--allow-file-access-from-files'],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  for(const mode of ['http','file']){
   const context=await browser.newContext({serviceWorkers:'block',timezoneId:'Asia/Jakarta'});const page=await context.newPage();const errors=[],pending=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('dialog',d=>d.accept());
   await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){
    localStorage.setItem('catet.jira.v1',JSON.stringify({key:'synthetic-code',proxy:'https://synthetic.invalid',site:'https://jira.invalid',items:[],bau:{items:[],alias:{}}}));
    localStorage.setItem('catet.tasks.v1',JSON.stringify([{id:'t1',text:'QA-999 — Synthetic task',status:'aktif',priority:'urgent',createdAt:new Date().toISOString()}]));
    localStorage.setItem('catet.worklog.v1','[]');localStorage.setItem('catet.weekly.v1',JSON.stringify({weeks:{'2026-W40':{marker:'ACCOUNT_A'}}}));sessionStorage.setItem('seeded','1');
   }});
   await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.protocol==='file:'||u.origin==='http://127.0.0.1:18875')return route.continue();if(u.hostname!=='synthetic.invalid')return route.abort();
    if(u.pathname==='/worklog'){pending.push(route);return}
    await route.fulfill({json:u.pathname==='/worklog-report'?{days:{},summaries:{}}:u.pathname==='/me'?{name:'Synthetic'}:u.pathname==='/state'?{stores:null,updatedAt:null,ok:true}:{items:[],events:[]}});
   });
   await page.goto(mode==='http'?'http://127.0.0.1:18875/':'file://'+path.join(root,'index.html'));await page.waitForFunction(()=>typeof syncReady!=='undefined'&&syncReady);
   const evaluatorCount=await page.evaluate(()=>{let count=0;const original=CatetPriorityEngine.createEvaluator;CatetPriorityEngine.createEvaluator=(...args)=>{count++;return original(...args)};render();CatetPriorityEngine.createEvaluator=original;return count});
   assert.equal(evaluatorCount,1,'one evaluator per board render');
   await page.locator('#sections button').first().focus();
   const focusedLabel=await page.evaluate(()=>document.activeElement.getAttribute('aria-label'));
   await page.evaluate(()=>checkDue());
   assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),focusedLabel,'timer render retains task action focus');
   await page.locator('#tab-papan').focus();await page.keyboard.press('ArrowRight');
   assert.equal(await page.evaluate(()=>view),'jira','ArrowRight activates next tab');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-jira');
   assert.deepEqual(await page.locator('[role=tab]').evaluateAll(ns=>ns.map(n=>n.tabIndex)),[-1,0,-1,-1]);
   await page.locator('#settings-btn').click();
   assert.equal(await page.locator('[role=tab]').evaluateAll(ns=>ns.filter(n=>n.tabIndex===0).length),1,'Settings retains one keyboard-reachable tab');
   await page.locator('#tab-papan').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>view),'papan');
   for(const width of [360,375,430]){
    await page.setViewportSize({width,height:812});
    const boxes=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {w:r.width,h:r.height,y:r.y}};return {input:box('#cap-text'),save:box('#cap-save'),options:box('#capture-more'),check:box('.task .check'),fits:document.documentElement.scrollWidth<=innerWidth}});
    assert(boxes.input.w>=width-70,'capture input needs its own wide row');assert(boxes.save.y>boxes.input.y);
    assert(boxes.save.h>=44&&boxes.options.h>=44&&boxes.check.w>=44&&boxes.check.h>=44,'primary mobile hit targets >=44px');assert(boxes.fits);
   }
   await page.setViewportSize({width:1280,height:900});
   await page.evaluate(()=>{const n=new Date();worklog=[{id:'l1',text:'QA-999 — Synthetic task',priority:'tinggi',mins:30,ts:n.toISOString(),date:localDateStr(n)}];saveWorklogTanpaSinkron();setView('log')});
   await page.waitForFunction(()=>!lapJiraLoading);await page.evaluate(()=>render());await page.getByRole('button',{name:'→ Jira',exact:true}).click();
   for(let i=0;pending.length<1;i++){if(i>50)throw Error('missing request');await wait(20)}
   assert.equal(await page.getByRole('button',{name:'Hapus dari log',exact:true}).isDisabled(),true,'delete locked immediately, before rerender');
   assert.equal(await page.getByRole('button',{name:'Pindahkan tanggal',exact:true}).isDisabled(),true);
   assert.equal(await page.locator('.log-mins').filter({hasText:'✎'}).isDisabled(),true);
   await page.evaluate(()=>checkDue());
   assert.equal(await page.getByRole('button',{name:'sending…',exact:true}).isDisabled(),true,'rerender must retain worklog send lock');
   assert.equal(pending.length,1);assert.equal(pending[0].request().postDataJSON().entryId,'l1');
   await page.evaluate(()=>{terapkanRemote({worklog:JSON.parse(JSON.stringify(worklog))})});
   await pending[0].fulfill({json:{ok:true,worklogId:'123'}});await page.waitForFunction(()=>worklog[0].jiraLogged,{},{timeout:3000});
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('catet.worklog.v1'))[0].jiraWorklogId),'123');
   for(const change of ['payload','account']){
    await page.evaluate(()=>{const n=new Date();worklog=[{id:'negative',text:'QA-999 — Synthetic task',priority:'tinggi',mins:30,ts:n.toISOString(),date:localDateStr(n)}];saveWorklogTanpaSinkron();render()});
    const index=pending.length;await page.getByRole('button',{name:'→ Jira',exact:true}).click();
    for(let i=0;pending.length===index;i++){if(i>50)throw Error('missing negative request');await wait(20)}
    await page.evaluate(kind=>{worklog=JSON.parse(JSON.stringify(worklog));if(kind==='payload')worklog[0].mins=45;else jira.key='other-code';saveWorklogTanpaSinkron()},change);
    await pending[index].fulfill({json:{ok:true,worklogId:'456'}});await page.waitForFunction(()=>worklogSending.size===0);
    assert.equal(await page.evaluate(()=>worklog[0].jiraLogged||false),false,'changed payload/account is not marked sent');
    await page.evaluate(()=>{jira.key='synthetic-code';render()});
   }
   const race=await page.evaluate(async()=>{
    const original=window.fetch;let release;const puts=[];
    localStorage.setItem('catet.synced.v1','1');localStorage.setItem('catet.syncAt.v1','2026-01-01T00:00:00Z');bersihkanDirty();
    window.fetch=(url,options={})=>options.method==='PUT'?(puts.push(JSON.parse(options.body)),Promise.resolve(new Response('{"ok":true}',{status:200}))):new Promise(r=>release=r);
    const pulling=pullState(true);tasks.push({id:'late',text:'Synthetic late edit',priority:'urgent',status:'aktif',createdAt:new Date().toISOString()});save(true);
    release(new Response(JSON.stringify({updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:[]}}),{status:200}));await pulling;window.fetch=original;
    return {kept:tasks.some(t=>t.id==='late'),puts:puts.length};
   });assert.deepEqual(race,{kept:true,puts:1});
   const backup=await page.evaluate(()=>({catetBackup:1,stores:kumpulkanStores()}));
   await Promise.all([page.waitForEvent('load'),page.evaluate(b=>importDataFromText(JSON.stringify(b)),backup)]);await page.waitForFunction(()=>typeof syncReady!=='undefined'&&syncReady);
   assert.equal(await page.evaluate(()=>jira.key),'synthetic-code');assert.equal(await page.evaluate(()=>tasks.some(t=>t.id==='late')),true,'restore survives reload');
   await page.locator('#settings-btn').click();await page.locator('summary').filter({hasText:'account settings'}).click();await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Sign out',exact:true}).click()]);
   await page.waitForLoadState();await page.waitForFunction(()=>document.body.classList.contains('signed-out'));
   assert.equal(await page.evaluate(()=>localStorage.getItem('catet.weekly.v1')),null);
   const shots=path.join(__dirname,'screenshots');fs.mkdirSync(shots,{recursive:true});
   await page.evaluate(()=>{jira.key='synthetic-code';jira.proxy='https://synthetic.invalid';tasks=[{id:'preview',text:'Synthetic QA task',priority:'urgent',status:'aktif',createdAt:new Date().toISOString()}];setView('papan')});
   for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.setViewportSize({width:375,height:812});await page.screenshot({path:path.join(shots,`reliability-${mode}-${theme}.png`),fullPage:true})}
   assert.deepEqual(errors,[]);console.log('PASS '+mode+': evaluator, focus/tabs, 360/375/430px, send lock, pull race, backup reload, sign-out, themes');await context.close();
  }
 }finally{if(browser)await browser.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
