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

(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.argv.includes('--edge')?{channel:'msedge'}:{})});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const dense of [false,true]) {
   await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html');
   await page.evaluate(async dense=>{
    document.getElementById('loader').hidden=true;
    window.CG=new CitationGraph(document.getElementById('graph-canvas'),{motion:false});
    const papers=Array.from({length:90},(_,i)=>({id:'P'+i,title:'Paper '+i,short:'Author'+i,year:2025,cites:2}));
    const edges=papers.slice(1).flatMap((p,i)=>dense?Array.from({length:20},(_,j)=>({s:p.id,t:'P'+((i+j)%90)})).filter(e=>e.s!==e.t):[{s:p.id,t:'P0'},{s:p.id,t:'P'+(i||2)}]);
    await CG.setData(papers,edges,'P0');
    window.hoverEvents=[];CG.onHover=n=>hoverEvents.push(n?.id||null);
    window.labelState=()=>CG.nodes.map(n=>[n.id,n.tEl.style.display,n.tEl.getAttribute('x'),n.tEl.getAttribute('y')]);
   },dense);await frame(page);
   const targets=await page.evaluate(()=>CG.nodes.filter(n=>n.tEl.style.display!=='none').map(n=>{
    const r=n.tEl.getBoundingClientRect();return {id:n.id,x:r.x+r.width/2,y:r.y+r.height/2};
   }).filter(p=>p.x>50&&p.x<1350&&p.y>100&&p.y<900).slice(0,12));
   assert(targets.length>=5);
   const seedPoint=await page.evaluate(()=>{const r=CG.nodeById[CG.seedId].cEl.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
   const assertSeedDrawn=async()=>{
    const png=await page.screenshot();
    const visible=await page.evaluate(async({data,point})=>{
     const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
     const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
     const pixel=ctx.getImageData(point.x,point.y,1,1).data;
     const color=getComputedStyle(CG.nodeById[CG.seedId].cEl).fill.match(/[\d.]+/g).slice(0,3).map(Number);
     return color.every((v,i)=>Math.abs(v-pixel[i])<10);
    },{data:png.toString('base64'),point:seedPoint});
    assert(visible,'central paper stays painted under a stationary pointer');
   };
   for(const target of targets){
    await page.mouse.move(5,5);await frame(page);
    const before=await page.evaluate(()=>{hoverEvents=[];return {labels:labelState(),positions:CG.nodes.map(n=>[n.x,n.y])};});
    await page.mouse.move(target.x,target.y);await page.waitForTimeout(350);
    const after=await page.evaluate(()=>({labels:labelState(),positions:CG.nodes.map(n=>[n.x,n.y]),hover:CG.hovered?.id,events:hoverEvents}));
    await assertSeedDrawn();
    assert(await page.evaluate(()=>CG.nodes.every(n=>getComputedStyle(n.gEl).opacity==='1')&&getComputedStyle(CG.nodes[0].gEl).transitionDuration==='0s'),'hover avoids animated group opacity');
    assert.equal(after.hover,target.id,'stationary pointer keeps its paper');
    assert(after.events.length>0&&after.events.every(id=>id===target.id),'no pointer enter/leave feedback loop');
    assert.deepEqual(after.labels,before.labels,'hover cannot reposition or hide clickable labels');
    assert.deepEqual(after.positions,before.positions,'hover cannot restart graph layout');
   }
   // Direct transitions between papers keep highlighting and label selection working.
   const target=targets[2];await page.mouse.click(target.x,target.y);await frame(page);
   assert.equal(await page.evaluate(()=>CG.selected),target.id);
   console.log('PASS: stable label hover, node positions and label selection ('+(dense?'batched':'individual')+' connections)');
  }
  assert.deepEqual(errors,[]);
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
