// One dependency-free gate; isolated HOME/TMPDIR and no inherited credentials.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');const root=path.resolve(__dirname,'..');
const scratch=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'catet-check-'));
const env={PATH:process.env.PATH,HOME:scratch,TMPDIR:scratch,TZ:'Asia/Jakarta'};
let failed=0,count=0;
function run(name,args,input){const r=spawnSync(process.execPath,args,{cwd:root,env,input,encoding:'utf8',timeout:90000});count++;if(r.status!==0){failed++;console.error('FAIL '+name+'\n'+(r.stdout||'')+(r.stderr||'')+(r.error||''));}else console.log('PASS '+name);}
try{
 for(const name of fs.readdirSync(path.join(root,'tests')).filter(n=>/^test_.*\.(js|mjs)$/.test(n)).sort())run(name,['tests/'+name]);
 for(const name of fs.readdirSync(path.join(root,'assets/js')).filter(n=>n.endsWith('.js')))run('syntax '+name,['--check','assets/js/'+name]);
 for(const name of fs.readdirSync(path.join(root,'scripts')).filter(n=>n.endsWith('.js')))run('syntax '+name,['--check','scripts/'+name]);
 run('syntax sw.js',['--check','sw.js']);run('syntax Worker',['--input-type=module','--check'],fs.readFileSync(path.join(root,'worker/worker.js'),'utf8'));
 console.log(JSON.stringify({checks:count,passed:count-failed,failed}));process.exitCode=failed?1:0;
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
