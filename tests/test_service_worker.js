const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
 const listeners={},cache=new Map();let status=503,offline=false,writes=0;
 const ctx=vm.createContext({URL,Response,self:{location:{origin:'https://app.test'},addEventListener:(n,f)=>listeners[n]=f},
  fetch:async()=>{if(offline)throw Error('offline');return new Response('NETWORK',{status})},
  caches:{open:async()=>({put:async(r,s)=>{writes++;cache.set(r.url,s)}}),match:async r=>cache.get(r.url)}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),ctx);
 const request=new Request('https://app.test/index.html');cache.set(request.url,new Response('GOOD',{status:200}));
 async function fetchEvent(){let response;const lifetimes=[];listeners.fetch({request,respondWith:p=>response=p,waitUntil:p=>lifetimes.push(p)});const r=await response;await Promise.all(lifetimes);return {r,lifetimes}}
 const error=await fetchEvent();assert.equal(await error.r.text(),'GOOD','503 must fall back to healthy cached asset');assert.equal(cache.get(request.url).status,200);assert.equal(writes,0);
 status=200;const good=await fetchEvent();assert.equal(await good.r.text(),'NETWORK');assert(good.lifetimes.length,'cache write must be held by event lifetime');assert.equal(writes,1);
 offline=true;assert.equal((await fetchEvent()).r.status,200);cache.clear();assert.equal((await fetchEvent()).r.status,503,'cold offline returns explicit response');
 console.log('service worker cache errors/lifetime/offline: PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
