import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
const source=await readFile(new URL('../worker/worker.js',import.meta.url),'utf8');const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
let stored=null;const env={CATET_KV:{get:async()=>stored,put:async(k,v)=>stored=v}};
const req=body=>new Request('https://worker.test/state',{method:'PUT',headers:{Origin:'https://zackyantoleo.github.io','Content-Type':'application/json'},body:JSON.stringify(body)});
const good={updatedAt:'2026-10-09T02:00:00Z',stores:{tasks:[{id:'t',text:'Synthetic',extra:true}],worklog:[],routines:[],routineday:{},jira:{items:[]},sprints:{list:[],aktif:null},weekly:{weeks:{}}}};
assert.equal((await worker.fetch(req(good),env)).status,200);const before=stored;
for(const bad of [null,[],{tasks:'bad'},{tasks:[null]},{tasks:[{id:'t',text:4}]},{tasks:[{id:'t',text:null}]},{routines:[{id:'r',text:'Synthetic'}]},{routines:[{id:'r',text:'Synthetic',days:[8]}]},{worklog:[{id:'l',text:'Synthetic'}]},{worklog:[{id:'l',text:'Synthetic',date:'2026-02-30',ts:'2026-10-09T02:00:00Z'}]},{jira:{items:'bad'}},{sprints:{list:{}}},{routineday:{doneIds:'bad'}},{weekly:{weeks:[]}}]){
 const r=await worker.fetch(req({...good,stores:bad}),env);assert.equal(r.status,400,'invalid stores rejected');assert.equal(stored,before,'invalid PUT does not alter valid state');
}
assert.equal((await worker.fetch(req({...good,updatedAt:'not-a-date'}),env)).status,400);
assert.equal((await worker.fetch(req({...good,stores:{tasks:[{id:'t',text:'😀'.repeat(140000)}]}}),env)).status,413,'limit counts UTF-8 bytes');
const ctx=vm.createContext({document:{querySelector:()=>null}});vm.runInContext(await readFile(new URL('../assets/js/util.js',import.meta.url),'utf8'),ctx);
for(const stores of [good.stores,{tasks:'bad'},null,[],{weekly:{weeks:[]}}]){
 const valid=vm.runInContext('validCatetStores('+JSON.stringify(stores)+')',ctx);const r=await worker.fetch(req({...good,stores}),env);assert.equal(valid,r.status===200,'browser and Worker validation agree');
}
console.log('state validation + immutable invalid writes + byte limit: PASS');
