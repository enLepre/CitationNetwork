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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await mock(page);await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed&density=80');await settled(page);
 await page.click('#graph-options summary');
 const pinned=await page.evaluate(()=>{const n=CG.nodeById.Wr1;n.userPinned=true;return {x:n.x,y:n.y,scale:CG.scale};});
 const setBond=async value=>{
  const immediate=await page.locator('#graph-bonds').evaluate((el,value)=>{const n=CG.nodes.find(n=>n.role==='cite'),x=n.x,y=n.y;el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));return CG.bondStrength===value/100;},String(value));assert(immediate,'link force updates immediately');
  await page.waitForTimeout(200);await page.waitForFunction(()=>!CG._cancelWorker&&!CG._relocation&&!CG._physicsRunning&&document.getElementById('graph-layout-status').textContent==='Forces updated.');
  return page.evaluate(()=>CG.edges.reduce((sum,e)=>{const a=CG.nodeById[e.s],b=CG.nodeById[e.t];return sum+Math.hypot(a.x-b.x,a.y-b.y);},0)/CG.edges.length);
 };
 const weak=await setBond(50),strong=await setBond(200);assert(strong<weak*.9,'stronger bonds shorten connections');
 assert.deepEqual(await page.evaluate(()=>({x:CG.nodeById.Wr1.x,y:CG.nodeById.Wr1.y,scale:CG.scale})),pinned);
 for(const [id,role] of [['toggle-ref','ref'],['toggle-cite','cite'],['toggle-linked','linked']]){
   await page.locator('#'+id+' .legend-dot').click();await frames(page);
   assert(await page.evaluate(role=>CG.nodes.filter(n=>n.role===role).every(n=>n.gEl.style.display==='none'&&n.hitEl.style.display==='none'),role));
   assert.equal(await page.locator('#'+id).getAttribute('aria-pressed'),'false');
   await page.locator('#'+id).focus();await page.keyboard.press('Space');await frames(page);
   assert(await page.evaluate(role=>CG.nodes.filter(n=>n.role===role).every(n=>n.gEl.style.display!=='none'),role));
 }
 await page.click('#toggle-ref');await page.reload();await settled(page);
 assert.equal(await page.evaluate(()=>CG.bondStrength),2);assert.equal(await page.evaluate(()=>CG.showRefs),false);
 await page.click('#theme-toggle');await page.waitForTimeout(250);await page.click('#graph-options summary');
 assert(await page.evaluate(()=>getComputedStyle(document.querySelector('.legend-dot.cite')).color===getComputedStyle(CG.nodes.find(n=>n.role==='cite').cEl).fill),'legend uses graph colors in dark mode');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
 const box=await page.locator('.graph-options-panel').boundingBox();assert(box.y>=68&&box.x>=0&&box.x+box.width<=390&&box.y+box.height<=844);
 await page.screenshot({path:path.join(output,'bond-controls-mobile.png')});
 await page.emulateMedia({reducedMotion:'reduce'});await setBond(100);assert.equal(await page.evaluate(()=>!!CG._relocation),false);
 assert.equal(await idleWrites(page),0);
 console.log(JSON.stringify({checks:'bond response, shorter links, pinned nodes, legend toggles, keyboard, persistence, dark mode, mobile and reduced motion passed',weakMeanLength:weak,strongMeanLength:strong}));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
