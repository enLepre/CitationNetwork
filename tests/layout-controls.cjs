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
    await page.waitForFunction(()=>!CG._motionActive);
    assert.equal(await page.locator('.graph-options-panel').isVisible(),false);
    await page.click('#graph-options summary');
    assert(await page.locator('#spread-nearby').isDisabled());
    const baseline=await page.evaluate(()=>{
      CG.nodeById.Wr1.userPinned=true;
      const center=CG.nodeById[CG.seedId];
      return {scale:CG.scale,pin:[CG.nodeById.Wr1.x,CG.nodeById.Wr1.y],radius:CG.nodes.reduce((sum,n)=>sum+Math.hypot(n.x-center.x,n.y-center.y),0)/CG.nodes.length};
    });
    await page.locator('#graph-spacing').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>CG.spacing===1.5&&!CG._relocation&&!CG._cancelWorker);
    const expanded=await page.evaluate(()=>{const c=CG.nodeById[CG.seedId];return {scale:CG.scale,pin:[CG.nodeById.Wr1.x,CG.nodeById.Wr1.y],radius:CG.nodes.reduce((sum,n)=>sum+Math.hypot(n.x-c.x,n.y-c.y),0)/CG.nodes.length};});
    assert.equal(expanded.scale,baseline.scale,'spacing must not be negated by automatic fitting');assert.deepEqual(expanded.pin,baseline.pin);
    assert(expanded.radius>baseline.radius*1.1,'larger spacing should spread the graph');
    await page.evaluate(()=>{CG.select('Wr2');CG.select('Wr3');});
    await page.selectOption('#graph-links','selected');await frames(page);
    assert(await page.evaluate(()=>CG.edges.filter(e=>e.path.style.display!=='none').every(e=>CG.selectedIds.has(e.s)||CG.selectedIds.has(e.t))));
    await page.selectOption('#graph-links','shared');await frames(page);
    assert(await page.evaluate(()=>CG.edges.some(e=>e.path.style.display!=='none')&&CG.edges.filter(e=>e.path.style.display!=='none').every(e=>e._shared)));
    const beforeLocal=await page.evaluate(()=>({center:CG.selected,points:CG.nodes.map(n=>({id:n.id,x:n.x,y:n.y})),near:[...CG.adj[CG.selected]]}));
    await page.click('#spread-nearby');await page.waitForFunction(()=>document.getElementById('graph-layout-status').textContent==='Spacing updated.'&&!CG._relocation&&!CG._cancelWorker);
    const afterLocal=await page.evaluate(()=>CG.nodes.map(n=>({id:n.id,x:n.x,y:n.y})));
    for(const before of beforeLocal.points) if(!beforeLocal.near.includes(before.id)||before.id==='Wr1')assert.deepEqual(afterLocal.find(n=>n.id===before.id),before,'local spreading preserves other papers');
    assert.equal(await page.evaluate(()=>CG.selected),beforeLocal.center);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.graph-options-panel').isVisible(),false);assert.equal(await page.locator('.paper-card').count(),2,'Escape closes controls without dismissing papers');
    await page.reload();await settled(page);assert.equal(await page.evaluate(()=>CG.spacing),1.5);assert.equal(await page.evaluate(()=>CG.linkMode),'shared');assert(await page.evaluate(()=>CG.nodeById.Wr1.userPinned));
    await page.setViewportSize({width:390,height:844});await page.click('#graph-options summary');await page.waitForTimeout(200);
    const panel=await page.locator('.graph-options-panel').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=390&&panel.y>=68&&panel.y+panel.height<=844);
    await page.screenshot({path:path.join(output,'layout-controls-mobile.png')});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#graph-spacing').evaluate(el=>{el.value='120';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>CG.spacing===1.2&&!CG._cancelWorker);assert.equal(await page.evaluate(()=>!!CG._relocation),false);
    await page.evaluate(async()=>{const a=CG.arrange(1.8);const b=CG.arrange(.9);await Promise.all([a,b]);});assert.equal(await page.evaluate(()=>CG.spacing),.9,'latest spacing request wins');
    assert.equal(await idleWrites(page),0);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks:'spacing, fixed papers, local spreading, link modes, rapid input, persistence, mobile and reduced motion passed',averageRadiusBefore:baseline.radius,averageRadiusAfter:expanded.radius}));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
