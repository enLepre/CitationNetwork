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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html');
  await page.evaluate(async()=>{
   document.getElementById('loader').hidden=true;window.CG=new CitationGraph(document.getElementById('graph-canvas'),{motion:false});
   window.testPapers=Array.from({length:1000},(_,i)=>({id:'P'+i,role:i?'cite':'seed',title:'Research on catalysis '+i,short:'Author '+i,authors:'Enrico Researcher',searchAuthors:'Enrico Researcher',year:2025,cites:i,refs:['P0','P'+(i%30)]}));
   window.testEdges=testPapers.slice(1).flatMap((p,i)=>Array.from({length:8},(_,j)=>({s:p.id,t:'P'+((i+j*17)%1000)}))).filter(e=>e.s!==e.t);
   await CG.setData(testPapers,testEdges,'P0');
  });await frame(page);
  assert(await page.evaluate(()=>CG._batchedEdges));
  assert(await page.locator('.edges path').count()<30);
  const geometryCount=()=>page.evaluate(()=>[...CG.edgeLayer.children].reduce((sum,p)=>sum+(p.getAttribute('d').match(/M/g)||[]).length,0));
  assert.equal(await geometryCount(),await page.evaluate(()=>CG.edges.length),'batching retains every connection');
  const cache=await page.evaluate(()=>{
   const normalize=String.prototype.normalize;let normalizations=0;String.prototype.normalize=function(...args){normalizations++;return normalize.apply(this,args);};
   CG.setFilter({searchQuery:'research',searchField:'all'});CG.nodes.forEach(n=>CG._visible(n));const first=normalizations;
   let checks=0;const visible=CG._visible.bind(CG);CG._visible=n=>{checks++;return visible(n);};
   const start=performance.now();CG._layoutLabels();CG._layoutLabels();const labelMs=(performance.now()-start)/2;String.prototype.normalize=normalize;CG._visible=visible;
   return {first,extra:normalizations-first,checks,labelMs};
  });
  assert(cache.first<=1001);assert.equal(cache.extra,0);assert(cache.checks<=2000,'label collision checks use nearby cells, not full scans');
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  fs.writeFileSync(path.join(root,'test-results','large-graph-performance.json'),JSON.stringify({
   ...(await page.evaluate(()=>({papers:CG.nodes.length,connections:CG.edges.length,svgElements:CG.svg.querySelectorAll('*').length,edgePaths:CG.edgeLayer.children.length}))),...cache
  },null,2));
  await page.evaluate(()=>CG.setFilter({showCites:false}));await page.waitForTimeout(220);assert.equal(await geometryCount(),0);
  await page.evaluate(()=>{CG.setFilter({showCites:true});CG.selectedIds=new Set(['P1','P2']);CG.select('P1');CG.setLinkMode('shared');});await frame(page);await page.waitForTimeout(220);
  assert.equal(await geometryCount(),await page.evaluate(()=>CG.edges.filter(e=>e._alpha&&e.path.style.display!=='none').length));
  await page.evaluate(()=>{CG.setLinkMode('all');CG.select(null);CG.zoomBy(1.25);});await frame(page);await page.waitForTimeout(220);
  assert(await page.evaluate(()=>[...CG.edgeLayer.children].every(p=>Number(p.getAttribute('stroke-width'))>0)));
  await page.evaluate(()=>{CG.toggleClusters(true);CG.toggleClusters(false);});assert.equal(await page.evaluate(()=>CG._clusterPending),false);
  await page.evaluate(async()=>{CG.toggleClusters(true);await CG.clustersReady;});assert.equal(await page.evaluate(()=>CG._clusterWorker),null);
  await page.screenshot({path:path.join(root,'test-results','batched-large-graph.png')});
  await page.evaluate(async()=>{
   CG.toggleClusters(false);
   const adding=CG.setData([...testPapers,{...testPapers[1],id:'new-paper'}],[...testEdges,{s:'new-paper',t:'P0'}],'P0',{preserve:true});
   if(CG._dataReady)throw new Error('Expected incremental layout to be pending');
   if(CG._visible(CG.nodeById['new-paper']))throw new Error('New papers should wait for their layout');
   const n=CG.nodeById.P3;n.x+=50;n.movedDuringLayout=true;CG._releasePhysics(n);
   await adding;
   if(!CG._physicsRunning)throw new Error('A release during loading must resume the graph forces');
  });await page.waitForFunction(()=>!CG._physicsRunning);await frame(page);
  await page.evaluate(async()=>{await CG.setData(testPapers.slice(0,30),testEdges.filter(e=>Number(e.s.slice(1))<30&&Number(e.t.slice(1))<30),'P0',{preserve:true});});await frame(page);
  assert.equal(await page.evaluate(()=>CG._batchedEdges),false);assert(await page.evaluate(()=>CG.edges.every(e=>e.path.parentNode===CG.edgeLayer&&e.path.getAttribute('d'))));
  assert.deepEqual(errors,[]);console.log('PASS: dense connection batching, search match cache, spatial label index, filtering/highlights/zoom, worker cancellation and sparse fallback');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
