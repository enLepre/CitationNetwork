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
  await page.waitForFunction(() => !document.getElementById('status-counts').textContent.includes('finding') && !window.CitationPage?.network.meta.preview && (!window.CitationPage || window.CitationPage.ready));
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
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const urls=await mock(page,{extraDelay:900});
  await page.addInitScript(()=>{window.workerCount=0;const Native=Worker;window.Worker=class extends Native{constructor(...args){super(...args);workerCount++;}};});
  const base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/graph.html?seed=Wseed&density=80&loading=fixed');
  await page.waitForFunction(()=>window.CG?.nodes.length&&document.getElementById('loader').hidden);
  await page.evaluate(()=>{window.seedElement=CG.nodeById.Wseed.gEl;window.edgeElement=CG.edges[0].path;});
  await settled(page);
  assert(await page.evaluate(()=>seedElement===CG.nodeById.Wseed.gEl&&CG.edges.some(e=>e.path===edgeElement)),'enrichment must reuse SVG elements');
  await page.waitForFunction(()=>!CG._cancelWorker);
  await page.evaluate(async()=>{await CG.arrange(1.1);await new Promise(r=>setTimeout(r,350));window.savedWorker=CG._worker;await CG.arrange(1.2);});
  assert(await page.evaluate(()=>CG._worker===savedWorker),'completed refinements reuse their worker');
  await page.waitForFunction(()=>!CG._relocation);
  await page.evaluate(()=>{CG.select('Wr2');CG.setLinkMode('selected');});await page.waitForTimeout(250);
  const writes=await page.evaluate(async()=>{
    let paths=0,styles=0;const observer=new MutationObserver(rs=>{for(const r of rs){if(r.attributeName==='d'&&r.target.style.opacity==='0')paths++;if(['font-size','stroke-width','r'].includes(r.attributeName))styles++;}});
    observer.observe(CG.svg,{attributes:true,subtree:true});
    for(let i=0;i<12;i++){CG.previewSpacing(1.2+i*.01);await new Promise(requestAnimationFrame);}
    observer.disconnect();return {paths,styles};
  });assert.deepEqual(writes,{paths:0,styles:0},'spacing skips invisible paths and unchanged styling');
  await page.waitForFunction(()=>!CG._physicsRunning);
  await page.evaluate(()=>CG.setLinkMode('all'));await frames(page);
  assert(await page.evaluate(()=>CG.edges.every(e=>e._ax===CG.nodeById[e.s].x+(CG.nodeById[e.s]._ox||0))),'revealed edges refresh to current coordinates');
  const requests=urls.length;
  await page.goto(base+'/list.html?seed=Wseed&density=80&loading=fixed');await page.waitForFunction(()=>window.CitationPage?.ready);
  await page.evaluate(()=>window.firstRow=document.querySelector('tr[data-id="Wr2"]'));
  await page.locator('.list-sort button').first().click();
  assert(await page.evaluate(()=>firstRow===document.querySelector('tr[data-id="Wr2"]')),'sorting retains existing rows');
  await page.goto(base+'/graph.html?seed=Wseed&density=80&loading=fixed');await settled(page);
  assert.equal(await page.evaluate(()=>workerCount),0,'restored network and positions must skip layout workers');
  assert.equal(urls.length,requests,'cached navigation does not refetch papers');
  assert.equal(await idleWrites(page),0);
  // Expired network entries must not suppress a fresh load.
  await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('citation-workspace-v1');r.onsuccess=()=>resolve(r.result);});await new Promise(resolve=>{const tx=db.transaction('networks','readwrite'),store=tx.objectStore('networks'),r=store.getAll();r.onsuccess=()=>r.result.forEach(e=>store.put({...e,time:0}));tx.oncomplete=resolve;});sessionStorage.removeItem('citation-network-cache-v1');});
  await page.reload();await settled(page);assert(urls.length>requests,'expired cache refreshes');
  const denied=await browser.newPage();await mock(denied);
  await denied.addInitScript(()=>{indexedDB.open=()=>{throw new DOMException('Storage disabled','SecurityError');};});
  await denied.goto(base+'/graph.html?seed=Wseed&density=80&loading=fixed');await settled(denied);await denied.close();
  console.log('PASS: incremental graph, worker reuse, zero hidden-link/style writes, restored layout, keyed rows and cache expiry');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
