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
  cited_by_count: id === 'Wseed' ? 0 : (parseInt(id.replace(/\D/g, '')) || 0) * 10, type: 'article', doi: 'https://doi.org/10.1000/' + id,
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
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await mock(page); await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed'); await settled(page);
 assert.equal(await page.locator('#citation-min').inputValue(),'0');
 const set=async value=>{await page.locator('#citation-exact').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));await frames(page);};
 // A very highly cited outlier must not compress the low end of the slider.
 await page.evaluate(()=>{CG.nodes[1].cites=1000000;document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 await set(10);
 assert(Number(await page.locator('#citation-min').inputValue())>150);
 await page.locator('#citation-min').evaluate(el=>{el.value='500';el.dispatchEvent(new Event('input'));});
 assert.equal(await page.locator('#citation-exact').inputValue(),'999');
 await set(0);
 const before=await page.locator('#citation-histogram').textContent();
 await set(500);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||n.cites>=500))));
 assert(await page.evaluate(()=>CG.edges.every(e=>!CG._visible(CG.nodeById[e.s])||!CG._visible(CG.nodeById[e.t])?e.path.style.display==='none':true)));
 assert.equal(await page.locator('#citation-histogram').textContent(),before);
 await page.locator('#citation-min').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#citation-exact').inputValue(),'501');
 await page.click('#graph-options summary');await page.click('#toggle-ref');await frames(page);
 assert(await page.evaluate(()=>CG.nodes.filter(n=>n.role==='ref').every(n=>n.gEl.style.display==='none')));
 await page.click('#toggle-ref');await page.click('#graph-options summary');await set(0);
 assert(await page.evaluate(()=>CG.nodes.every(n=>n.gEl.style.display!=='none')));
 const setUpper=async value=>{await page.locator('#citation-upper-exact').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));await frames(page);};
 await set(100);await setUpper(500);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||(n.cites>=100&&n.cites<=500)))));
 assert(await page.evaluate(()=>CG.edges.every(e=>(CG._visible(CG.nodeById[e.s])&&CG._visible(CG.nodeById[e.t]))||e.path.style.display==='none')));
 await page.locator('#citation-upper').focus();await page.keyboard.press('ArrowLeft');
 assert.equal(await page.locator('#citation-upper-exact').inputValue(),'499');
 await set(600);assert.equal(await page.locator('#citation-exact').inputValue(),'499');
 await setUpper(10);assert.equal(await page.locator('#citation-upper-exact').inputValue(),'499');
 await set(0);await setUpper(0);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||n.cites===0))));
 await page.locator('#citation-upper').evaluate(el=>{el.value='1000';el.dispatchEvent(new Event('input'));});await frames(page);
 assert(await page.evaluate(()=>CG.nodes.every(n=>n.gEl.style.display!=='none')));
 await setUpper(1500);
 await set(500);await page.screenshot({path:path.join(output,'citation-filter-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.click('#theme-toggle');await frames(page);
 const box=await page.locator('#citation-filter').boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=844);
 await page.screenshot({path:path.join(output,'citation-filter-mobile.png')});
 await page.evaluate(()=>{CG.nodes.forEach(n=>n.cites=1);document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 assert(await page.locator('#citation-histogram rect').evaluateAll(bars=>bars.every(b=>Number(b.getAttribute('width'))>0)));
 await page.evaluate(()=>{CG.nodes.forEach(n=>n.cites=0);document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 assert(await page.locator('#citation-min').isDisabled());
 assert.equal(await page.locator('#citation-exact').inputValue(),'0');
 console.log('Citation threshold, boundary, edges, stable histogram, keyboard, combined filters, reset, mobile and dark mode passed.');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
