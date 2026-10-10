const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../assets/js/sync.js'),'utf8');
function setup(){
 const values=new Map([['catet.synced.v1','1'],['catet.syncAt.v1','2026-01-01T00:00:00Z']]);
 const requests=[],timers=[];
 const ctx=vm.createContext({Date,console,$:()=>null,render(){},fmtClock:()=>'',normalisasiJira:j=>j,
  setTimeout:f=>{timers.push(f);return timers.length},clearTimeout(){},
  jiraProxy:()=> 'https://synthetic.invalid',headerAkses:()=>({'X-Catet-Key':'test-code'}),
  localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},
  fetch:(url,options={})=>new Promise(resolve=>requests.push({url,options,resolve}))});
 vm.runInContext("let tasks=[],worklog=[],routines=[],rday=null,sprints={list:[]},jira={key:'test-code'},weekly={},view='papan';",ctx);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/js/util.js'),'utf8').replace('const $ = (sel) => document.querySelector(sel);',''),ctx);
 vm.runInContext(source,ctx);vm.runInContext('syncReady=true',ctx);
 return {ctx,values,requests,timers,run:s=>vm.runInContext(s,ctx)};
}
const reply=(req,data)=>req.resolve({ok:true,json:async()=>data});
(async()=>{
 const c=setup();const p=c.run('pullState(true)');
 c.run("tasks=[{id:'local',text:'Edit during GET'}];localStorage.setItem('catet.tasks.v1',JSON.stringify(tasks));syncDirty(true)");
 assert.equal(c.requests.length,1,'edit while pull pending must not launch a concurrent PUT');
 reply(c.requests[0],{updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:[]}});
 await new Promise(r=>setImmediate(r));
 if(c.requests[1])reply(c.requests[1],{ok:true});
 await p;
 assert.equal(c.run('tasks[0].id'),'local','late GET must not erase newer local edit');
 assert.equal(c.requests[1].options.method,'PUT');
 assert.equal(JSON.parse(c.requests[1].options.body).stores.tasks[0].id,'local');
 const d=setup();const pull=d.run('pullState(true)');d.run('pullState(true)');
 assert.equal(d.requests.length,1,'overlapping pulls must be single-flight');
 reply(d.requests[0],{updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:[]}});await pull;
 const e=setup();e.run("tasks=[{id:'old',text:'Old'}];syncDirty()");const pushing=e.run('pushState()');
 e.run('pullState(true)');assert.equal(e.requests.length,1,'pull must wait for in-flight push');
 e.run("tasks=[{id:'new',text:'New'}];localStorage.setItem('catet.tasks.v1',JSON.stringify(tasks));syncDirty()");
 reply(e.requests[0],{ok:true});await new Promise(r=>setImmediate(r));
 assert.equal(e.requests.length,2,'edit during PUT must produce a second current snapshot');reply(e.requests[1],{ok:true});await pushing;
 assert.equal(JSON.parse(e.requests[1].options.body).stores.tasks[0].id,'new');
 assert.equal(e.run('isDirty()'),false);
 const bad=setup();bad.run("tasks=[{id:'keep',text:'Keep'}];localStorage.setItem('catet.tasks.v1',JSON.stringify(tasks));syncDirty()");const invalid=bad.run('pullState(true)');
 reply(bad.requests[0],{updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:'invalid'}});await invalid;
 assert.equal(bad.requests.length,1,'invalid remote response must not trigger blind PUT');assert.equal(bad.run('tasks[0].id'),'keep');assert.equal(bad.run('isDirty()'),true);
 const conflict=setup();conflict.run("tasks=[{id:'local',text:'Local'}];syncDirty();localStorage.setItem('catet.dirtyAt.v1','2026-01-01T00:00:00Z')");const conflicted=conflict.run('pullState(true)');
 reply(conflict.requests[0],{updatedAt:'2026-01-03T00:00:00Z',stores:{tasks:[{id:'server',text:'Newer server'}]}});await conflicted;
 assert.equal(conflict.run('tasks[0].id'),'server','accepted newer-server snapshot policy remains intact');assert.equal(conflict.requests.length,1);
 const startup=setup();startup.ctx.document={visibilityState:'visible',addEventListener(){}};startup.ctx.setInterval=()=>0;startup.ctx.syncJira=()=>{};
 const held=[];startup.ctx.fetch=(url,options={})=>url.endsWith('/state')?new Promise(resolve=>{const req={url,options,resolve};startup.requests.push(req);held.push(req)}):Promise.resolve({ok:true,json:async()=>({items:[]})});
 startup.run('syncReady=false');const init=startup.run('initSync()');startup.run("tasks=[{id:'startup-edit',text:'Startup edit'}];localStorage.setItem('catet.tasks.v1',JSON.stringify(tasks));syncDirty(true)");
 reply(held[0],{updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:'invalid'}});await new Promise(r=>setImmediate(r));
 assert.equal(startup.requests.length,1,'initSync must not drain pending push after invalid GET');assert.equal(startup.run('isDirty()'),true);assert.equal(startup.run('syncReady'),false);await init;
 startup.run('syncDirty(true);pushState()');assert.equal(startup.requests.length,1,'later edits remain local while state is invalid');
 const recovery=startup.run('pullState(true)');reply(held[1],{updatedAt:'2026-01-02T00:00:00Z',stores:{tasks:[]}});await new Promise(r=>setImmediate(r));
 assert.equal(startup.requests.length,3,'a valid recovery GET safely drains current local state');reply(held[2],{ok:true});await recovery;
 assert.equal(startup.run('syncReady'),true);assert.equal(JSON.parse(held[2].options.body).stores.tasks[0].id,'startup-edit');
 console.log('sync races: PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
