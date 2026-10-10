const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');const root=path.resolve(__dirname,'..');
assert(fs.existsSync(path.join(root,'scripts/check.js')),'one runnable test gate must exist');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/pages.yml'),'utf8');
assert(workflow.includes('pull_request:'),'PRs must run verification');assert(/deploy:[\s\S]*needs: verify/.test(workflow),'deploy must depend on verification');assert(!/path: \.(?:\n|$)/.test(workflow),'Pages must not upload repository root');
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'catet-stage-'));
try{
 const r=spawnSync(process.execPath,[path.join(root,'scripts/stage-pages.js'),dir],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 for(const name of ['index.html','weekly-wrapped.html','sw.js','assets/js/app.js'])assert(fs.existsSync(path.join(dir,name)));
 for(const name of ['worker','tests','scripts','graphify-out','.git','.wrangler','README.md'])assert(!fs.existsSync(path.join(dir,name)),'non-frontend file excluded: '+name);
 const refused=spawnSync(process.execPath,[path.join(root,'scripts/stage-pages.js'),root],{encoding:'utf8'});assert.notEqual(refused.status,0,'nonempty target refused without deleting data');
}finally{fs.rmSync(dir,{recursive:true,force:true})}
console.log('delivery gate and frontend-only artifact: PASS');
