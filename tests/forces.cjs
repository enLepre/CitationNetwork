const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + (file === '/' ? '/index.html' : file));
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
const raw = (id, refs = []) => ({ id: 'https://openalex.org/' + id,
  display_name: id === 'Wseed' ? 'Catalytic pathways and connected research in chemistry' : 'Connected research paper ' + id,
  publication_year: 2000 + (parseInt(id.replace(/\D/g, '')) || 25) % 26,
  cited_by_count: 50, type: 'article', doi: 'https://doi.org/10.1000/' + id,
  authorships: [{ author: { display_name: 'Enrico Researcher' + id.replace(/\D/g, '') } }],
  primary_location: { source: { id: 'https://openalex.org/S1', display_name: 'Journal of Chemistry' } },
  referenced_works: refs.map(r => 'https://openalex.org/' + r),
  abstract_inverted_index: { This: [0], is: [1], an: [2], abstract: [3] } });
const records = new Map();
const seedRefs = Array.from({ length: 169 }, (_, i) => 'Wr' + i);
records.set('Wseed', raw('Wseed', seedRefs));
for (let i = 0; i < 169; i++) records.set('Wr' + i, raw('Wr' + i, [i ? 'Wr' + (i - 1) : 'Wr168', 'Wx' + (i % 12)]));
for (let i = 0; i < 160; i++) records.set('Wc' + i, raw('Wc' + i, ['Wseed', 'Wr' + (i % 169), 'Wr' + ((i * 7) % 169), 'Wx' + (i % 12)]));
for (let i = 0; i < 12; i++) records.set('Wx' + i, raw('Wx' + i, ['Wr' + i]));
async function mock(page, { extraDelay = 350, slowSeed = false, failExtra = false } = {}) {
  const urls = [];
  await page.route('https://api.openalex.org/**', async route => {
    const u = new URL(route.request().url()); urls.push(u.href);
    let data;
    const filter = u.searchParams.get('filter') || '';
    if (u.pathname.startsWith('/sources')) data = { results: [{ id: 'https://openalex.org/S1', summary_stats: { '2yr_mean_citedness': 3 } }] };
    else if (filter.startsWith('cites:')) {
      const per = +(u.searchParams.get('per-page') || 80), pageNo = +(u.searchParams.get('page') || 1);
      data = { meta: { count: 160 }, results: Array.from({ length: per }, (_, i) => records.get('Wc' + ((pageNo - 1) * per + i))).filter(Boolean) };
    } else if (filter.startsWith('openalex_id:')) {
      const ids = filter.slice(12).split('|');
      if (ids.some(id => id.startsWith('Wx'))) {
        await new Promise(r => setTimeout(r, extraDelay));
        if (failExtra) return route.fulfill({ status: 500, body: '{}' });
      }
      data = { results: ids.map(id => records.get(id)).filter(Boolean) };
    } else if (u.pathname === '/works') data = { results: [records.get('Wseed')] };
    else {
      const id = u.pathname.split('/').pop();
      if (slowSeed && id === 'Wslow') await new Promise(r => setTimeout(r, 600));
      data = records.get(id) || raw(id, []);
    }
    // Respect select= so search cannot accidentally work because of over-rich fixtures.
    const select = u.searchParams.get('select');
    if (select) {
      const pick = item => Object.fromEntries(select.split(',').filter(k => k in item).map(k => [k, item[k]]));
      data = data.results ? { ...data, results: data.results.map(pick) } : pick(data);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  return urls;
}
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function settled(page) {
  await page.waitForFunction(() => window.CG?.nodes.length && document.getElementById('loader').hidden);
  await page.waitForFunction(() => !document.getElementById('status-counts').textContent.includes('finding'));
  await page.waitForFunction(() => !window.CG?._motionActive);
  await page.evaluate(() => document.fonts.ready); await frames(page);
}
async function idleWrites(page) {
  return page.evaluate(async () => {
    let count = 0;
    const observer = new MutationObserver(records => count += records.filter(r => r.type === 'attributes').length);
    observer.observe(document.getElementById('graph-canvas'), { attributes: true, subtree: true });
    await new Promise(r => setTimeout(r, 500)); observer.disconnect(); return count;
  });
}
async function navigate(page, view) {

  await page.click('#notebook-menu [data-view="' + view + '"]');
}

async function labelStats(page) {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll('.glabel')].filter(el => getComputedStyle(el).display !== 'none' && getComputedStyle(el.closest('.gnode')).display !== 'none');
    const boxes = labels.map(el => el.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]; if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps++;
    }
    return { visible: labels.length, overlappingPairs: overlaps, minScreenFontPx: Math.min(...labels.map(el => +el.getAttribute('font-size') * window.CG.scale)) };
  });
}


(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await mock(page);
  await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed');await settled(page);
  await page.click('#graph-options summary');
  const set=async(id,value)=>{
   await page.locator('#'+id).evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
   await page.waitForFunction(()=>!CG._physicsRunning);await frames(page);
  };
  const metrics=()=>page.evaluate(()=>{
   const c=CG.nodeById[CG.seedId];return {radius:CG.nodes.reduce((s,n)=>s+Math.hypot(n.x-c.x,n.y-c.y),0)/CG.nodes.length,
    link:CG.edges.reduce((s,e)=>s+Math.hypot(CG.nodeById[e.s].x-CG.nodeById[e.t].x,CG.nodeById[e.s].y-CG.nodeById[e.t].y),0)/CG.edges.length};
  });
  await set('graph-center',30);const loose=await metrics();
  await page.evaluate(()=>window.firstPhysicsWorker=CG._physicsWorker);
  await set('graph-center',300);const compact=await metrics();
  assert(compact.radius<loose.radius*.9,'center force compacts the network');
  assert(await page.evaluate(()=>firstPhysicsWorker===CG._physicsWorker),'same worker reused');
  await set('graph-bonds',300);await set('graph-distance',40);const short=await metrics();
  await set('graph-distance',300);const long=await metrics();
  assert(long.link>short.link*1.1,'link distance independently lengthens edges');
  assert.deepEqual(await page.evaluate(()=>CG._forceSettings()),{spacing:1,bondStrength:3,centerForce:3,linkDistance:300});
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  const responsiveness=await page.evaluate(async()=>{
   const gaps=[];let last=performance.now(),done=false;
   const sample=now=>{gaps.push(now-last);last=now;if(!done)requestAnimationFrame(sample);};requestAnimationFrame(sample);
   CG.updateForces({spacing:2});
   while(CG._physicsRunning)await new Promise(r=>setTimeout(r,30));
   done=true;gaps.sort((a,b)=>a-b);return {frames:gaps.length,p95:gaps[Math.floor(gaps.length*.95)]};
  });
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  assert(responsiveness.frames>10&&responsiveness.p95<80,'live physics stays responsive on a throttled CPU');
  await set('graph-center',0);await set('graph-spacing',0);await set('graph-bonds',0);
  assert(await page.evaluate(()=>CG.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y))),'zero forces remain finite');
  await page.reload();await settled(page);
  assert.deepEqual(await page.evaluate(()=>CG._forceSettings()),{spacing:0,bondStrength:0,centerForce:0,linkDistance:300});
  await page.click('#graph-options summary');await page.click('#reset-forces');
  await page.waitForFunction(()=>!CG._physicsRunning);await frames(page);
  assert.deepEqual(await page.evaluate(()=>CG._forceSettings()),{spacing:1,bondStrength:1,centerForce:1,linkDistance:145});
  assert.equal(await idleWrites(page),0,'no idle animation writes');
  // Block workers to exercise the time-sliced fallback.
  await page.evaluate(()=>{CG._stopPhysics();window.Worker=class{constructor(){throw Error('blocked');}};});
  await set('graph-distance',200);
  assert(await page.evaluate(()=>!!CG._physicsSim&&!CG._physicsRunning));
  assert.equal(await idleWrites(page),0);
  await page.evaluate(()=>{CG.updateForces({spacing:2});CG.setActive(false);});
  assert(await page.evaluate(()=>!CG._physicsRunning&&!CG._physicsSim&&!CG._physicsWorker));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks:'independent center/link distance, worker reuse, zero settings, persistence, reset, idle, fallback and inactive cleanup passed',loose,compact,short,long,responsiveness}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
