const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function point(page, id) {
  return page.evaluate(id => {
    const n = CG.nodeById[id], rect = n.cEl.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, wx: n.x, wy: n.y, radius: rect.width / 2 };
  }, id);
}
async function setup(page, count = 80) {
  await page.mouse.move(0,0);
  await page.goto('http://127.0.0.1:' + server.address().port + '/graph.html');
  await page.evaluate(async count => {
    document.getElementById('loader').hidden = true;
    window.CG = new CitationGraph(document.getElementById('graph-canvas'));
    const papers = Array.from({length:count}, (_,i)=>({id:'P'+i,role:i?'ref':'seed',title:'Paper '+i,short:'Author'+i,year:2025,cites:2}));
    const edges = papers.slice(1).flatMap((n,i)=>[{s:n.id,t:'P0'},{s:n.id,t:'P'+(i||2)}]);
    window.motionMetrics={frames:[],labels:0};
    const render=CG._renderPositions.bind(CG), labels=CG._layoutLabels.bind(CG);
    CG._renderPositions=function(only){const t=performance.now();render(only);if(only)motionMetrics.frames.push(performance.now()-t);};
    CG._layoutLabels=function(){motionMetrics.labels++;labels();};
    await CG.setData(papers,edges,'P0');
  },count);
}
async function rest(page) { await page.waitForFunction(()=>!CG._motionActive&&!CG._physicsRunning);await frame(page); }
async function idle(page) {
  return page.evaluate(async()=>{let writes=0;const observer=new MutationObserver(records=>writes+=records.length);observer.observe(CG.svg,{subtree:true,attributes:true});await new Promise(r=>setTimeout(r,250));observer.disconnect();return writes;});
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await setup(page);
    assert(await page.evaluate(()=>CG._motionActive),'generation starts a short settling effect');
    const anchors=await page.evaluate(()=>CG.nodes.map(n=>[n.x,n.y]));
    await rest(page);
    assert.deepEqual(await page.evaluate(()=>CG.nodes.map(n=>[n.x,n.y])),anchors,'motion must preserve the computed layout');
    assert.equal(await idle(page),0,'no rendering when settled');
    assert(await page.evaluate(()=>motionMetrics.frames.length>2),'settling must be animated, not an instant jump');
    const zoomStart=await page.evaluate(()=>{const scale=CG.scale;CG.zoomBy(1.25,undefined,undefined,true);return scale;});
    await frame(page);
    assert(await page.evaluate(start=>CG.scale>start&&CG.scale<start*1.25,zoomStart),'zoom should interpolate');
    await page.evaluate(()=>CG.zoomBy(1.25,undefined,undefined,true));
    await page.waitForFunction(()=>!CG._camera);await frame(page);
    assert(Math.abs(await page.evaluate(()=>CG.scale)-zoomStart*1.25*1.25)<.0001,'rapid zooms retain the cumulative target');
    await page.evaluate(()=>CG.fit(true));await page.waitForFunction(()=>!CG._camera);await frame(page);
    assert.equal(await idle(page),0,'camera animation stops completely');
    const neighborPositions=await page.evaluate(()=>Object.fromEntries(CG.nodes.map(n=>[n.id,[n.x,n.y]])));
    const seedPosition=neighborPositions.P0;
    const p=await point(page,'P3');
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    await page.mouse.move(p.x+60,p.y+30,{steps:8});await page.waitForTimeout(100);
    assert(await page.evaluate(before=>CG.nodes.some(n=>n.id!=='P3'&&Math.hypot(n.x-before[n.id][0],n.y-before[n.id][1])>.1),neighborPositions),'connected neighbors should respond to dragging');
    const drop=await page.evaluate(()=>[CG.nodeById.P3.x,CG.nodeById.P3.y]);
    await page.mouse.up();assert(await page.evaluate(()=>CG._physicsRunning));
    await rest(page);
    assert(await page.evaluate(drop=>Math.hypot(CG.nodeById.P3.x-drop[0],CG.nodeById.P3.y-drop[1])>1,drop),'released papers must rejoin the forces');
    assert.deepEqual(await page.evaluate(()=>[CG.nodeById.P0.x,CG.nodeById.P0.y]),seedPosition,'only the central paper stays fixed');
    assert.equal(await page.evaluate(()=>CG.nodeById.P3.userPinned),false);
    assert.equal(await page.evaluate(()=>CG.selected),null,'dragging must not open the paper');
    assert.equal(await idle(page),0);
    const center=await point(page,'P0');
    await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+50,center.y+25,{steps:5});await page.mouse.up();await rest(page);
    assert.deepEqual(await page.evaluate(()=>[CG.nodeById.P0.x,CG.nodeById.P0.y]),seedPosition,'the central paper cannot be dragged away');
    await page.emulateMedia({reducedMotion:'reduce'});await setup(page);assert.equal(await page.evaluate(()=>CG._motionActive),false);assert.equal(await page.evaluate(()=>CG._motion.size),0);
    await page.emulateMedia({reducedMotion:'no-preference'});await setup(page);await page.emulateMedia({reducedMotion:'reduce'});await rest(page);assert.equal(await page.evaluate(()=>CG._motion.size),0);
    await page.emulateMedia({reducedMotion:'no-preference'});await setup(page);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.evaluate(()=>CG._motionActive),false);assert.equal(await idle(page),0,'hidden graphs do no SVG work');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await rest(page);
    await setup(page,500);await rest(page);
    const metrics=await page.evaluate(()=>motionMetrics);assert(metrics.frames.length<100,'large graphs have bounded animation work');
    assert.equal(await idle(page),0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await setup(page,500);await rest(page);assert.equal(await idle(page),0);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    const fallback=await browser.newPage({viewport:{width:1440,height:1000}});
    await fallback.addInitScript(()=>{window.Worker=undefined;});await setup(fallback);await rest(fallback);
    const fp=await point(fallback,'P3');
    await fallback.mouse.move(fp.x,fp.y);await fallback.mouse.down();await fallback.mouse.move(fp.x+70,fp.y+25,{steps:8});
    const fd=await fallback.evaluate(()=>[CG.nodeById.P3.x,CG.nodeById.P3.y]);
    await fallback.evaluate(()=>CG.svg.dispatchEvent(new PointerEvent('pointercancel',{pointerId:CG._pointerId,bubbles:true})));
    await fallback.mouse.up();await rest(fallback);
    assert(await fallback.evaluate(drop=>Math.hypot(CG.nodeById.P3.x-drop[0],CG.nodeById.P3.y-drop[1])>1,fd),'cancelled drags also release fallback simulation pins');
    assert(await fallback.evaluate(()=>CG._physicsSim.nodes().filter(n=>n.id!==CG.seedId).every(n=>n.fx==null&&n.fy==null)));
    assert.equal(await idle(fallback),0);await fallback.close();
    console.log(JSON.stringify({checks:'settling, released drag motion, fixed central paper, cancelled fallback drag, idle, reduced motion, hidden tab and 500 papers passed',motionFrames:metrics.frames.length,labels:metrics.labels,maxPositionFrameMs:Math.max(0,...metrics.frames)},null,2));
    assert.deepEqual(errors,[]);
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
