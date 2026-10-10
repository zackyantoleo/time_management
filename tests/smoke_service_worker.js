const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');const root=path.resolve(__dirname,'..');
(async()=>{
 let failAsset=false;const server=http.createServer((req,res)=>{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html';const file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return}
  if(failAsset&&name==='assets/js/priority-engine.js'){res.writeHead(503);res.end('temporary failure');return}
  const ext=path.extname(file);res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json'})[ext]||'application/octet-stream');res.end(fs.readFileSync(file));
 });let browser;
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**',route=>route.abort());await page.goto(base);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.waitForFunction(async()=>!!await (await caches.open('catet-v73')).match(new URL('assets/js/priority-engine.js',location.href).href));
  failAsset=true;
  const healthy=await page.evaluate(async()=>{const r=await fetch('assets/js/priority-engine.js',{cache:'no-store'});return {status:r.status,text:await r.text()}});
  assert.equal(healthy.status,200);assert(healthy.text.includes('createEvaluator'));
  assert.equal(await page.evaluate(async()=>{const r=await (await caches.open('catet-v73')).match(new URL('assets/js/priority-engine.js',location.href).href);return r.status}),200);
  await context.setOffline(true);await page.reload();await page.waitForFunction(()=>typeof CatetPriorityEngine==='object');assert.equal(await page.locator('h1').innerText(),'CATET');assert.deepEqual(errors,[]);
  console.log('PASS real service worker: install, controller, 503 fallback preserves 200, offline reload');await context.close();
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
