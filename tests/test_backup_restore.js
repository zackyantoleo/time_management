const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const values = new Map([
  ['catet.jira.v1', JSON.stringify({key:'device-code',proxy:'https://synthetic.invalid',calIcs:'device-calendar',items:[]})],
  ['catet.tasks.v1', JSON.stringify([{id:'old',text:'Old task'}])],
  ['catet.syncAt.v1', '2026-01-01T00:00:00Z'],
]);
let reloads = 0;
const alerts = [];
const ctx = vm.createContext({Date, console, alert:m=>alerts.push(m),confirm:()=>true,
  location:{reload(){reloads++;}},localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)}});
vm.runInContext(fs.readFileSync(path.join(root,'assets/js/util.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'assets/js/backup.js'),'utf8'),ctx);
vm.runInContext('importDataFromText('+JSON.stringify(JSON.stringify({catetBackup:1,stores:{tasks:[{id:'restored',text:'Restored task'}],jira:{items:[]}}}))+')',ctx);
assert.equal(JSON.parse(values.get('catet.jira.v1')).key,'device-code','restore must preserve device access code');
assert.equal(JSON.parse(values.get('catet.jira.v1')).proxy,'https://synthetic.invalid');
assert.equal(JSON.parse(values.get('catet.jira.v1')).calIcs,'device-calendar');
assert.equal(JSON.parse(values.get('catet.tasks.v1'))[0].id,'restored');
assert.equal(values.get('catet.dirty.v1'),'1');
assert(values.get('catet.dirtyAt.v1'),'restore must establish a fresh dirty timestamp');
assert.equal(reloads,1);
assert.equal(values.get('catet.synced.v1'),'1','confirmed restore on new device must survive first pull');
assert.deepEqual(alerts,[]);
const before = JSON.stringify([...values]);
vm.runInContext('importDataFromText('+JSON.stringify(JSON.stringify({stores:{tasks:[],worklog:'bad',jira:{items:[]}}}))+')',ctx);
assert.equal(JSON.stringify([...values]),before,'invalid backup must not partially overwrite stores');
assert.equal(reloads,1);
vm.runInContext('importDataFromText('+JSON.stringify(JSON.stringify({stores:{tasks:[],routines:[{id:'r',text:'Malformed'}]}}))+')',ctx);
assert.equal(JSON.stringify([...values]),before,'missing routine days must not replace tasks');
assert.equal(reloads,1);
values.set('catet.jira.v1',JSON.stringify({key:'',items:[]}));
const signedOutBefore=JSON.stringify([...values]);
vm.runInContext('importDataFromText('+JSON.stringify(JSON.stringify({stores:{tasks:[{id:'x',text:'Restored'}],jira:{items:[]}}}))+')',ctx);
assert.equal(JSON.stringify([...values]),signedOutBefore,'signed-out import must ask sign-in, not erase restored data');
console.log('backup restore preserves device identity: PASS');
