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
for (let i = 0; i < 600; i++) records.set('Wc' + i, raw('Wc' + i, ['Wseed', 'Wr' + (i % 169), 'Wr' + ((i * 7) % 169), 'Wx' + (i % 12)]));
for (let i = 0; i < 12; i++) records.set('Wx' + i, raw('Wx' + i, ['Wr' + i]));
async function mock(page, { extraDelay = 350, slowSeed = false, failExtra = false } = {}) {
  const urls = [];
  await page.route('https://api.openalex.org/**', async route => {
    const u = new URL(route.request().url()); urls.push(u.href);
    let data;
    const filter = u.searchParams.get('filter') || '';
    if (u.pathname.startsWith('/sources')) data = { results: [{ id: 'https://openalex.org/S1', summary_stats: { '2yr_mean_citedness': 3 } }] };
    else if (filter.startsWith('cites:')) {
      const low=filter.match(/cited_by_count:>(-?\d+)/),high=filter.match(/cited_by_count:<(\d+)/);
      let rows=Array.from({length:600},(_,i)=>records.get('Wc'+i));
      if(low)rows=rows.filter(p=>p.cited_by_count>Number(low[1]));
      if(high)rows=rows.filter(p=>p.cited_by_count<Number(high[1]));
      rows.sort(u.searchParams.get('sort')==='publication_date:desc'?(a,b)=>b.publication_year-a.publication_year:(a,b)=>b.cited_by_count-a.cited_by_count);
      const cursor=u.searchParams.get('cursor'),per=Number(u.searchParams.get('per-page')||100);
      const offset=cursor==='*'?0:cursor?Number(cursor):(Number(u.searchParams.get('page')||1)-1)*per;
      await new Promise(r=>setTimeout(r,100));
      data={meta:{count:rows.length,next_cursor:offset+per<rows.length?String(offset+per):null},results:rows.slice(offset,offset+per)};
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
 const page=await browser.newPage({viewport:{width:1280,height:900}});const urls=await mock(page);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{if(!sessionStorage.getItem('citation-current'))sessionStorage.setItem('citation-current',JSON.stringify({seedId:'Wseed',density:80,modeVersion:2}));});
 await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed&density=80');await settled(page);
 await page.click('#graph-options summary');
 await page.waitForFunction(()=>!document.getElementById('load-more-papers').disabled);
 assert.equal(await page.evaluate(()=>CitationPage.network.meta.adaptive),true);
 assert.equal(await page.evaluate(()=>CitationPage.network.meta.citingShown),250);
 assert.equal(await page.evaluate(()=>CG.minCitations),3500);
 const before=await page.evaluate(()=>({count:CG.nodes.length,x:CG.nodeById.Wr1.x,y:CG.nodeById.Wr1.y}));
 const lower=async value=>page.locator('#citation-min').evaluate((el,value)=>{el.value=Math.log1p(value)/Math.log1p(Number(el.dataset.citationMax))*1000;el.dispatchEvent(new Event('input',{bubbles:true}));},value);
 await lower(0);
 await page.waitForFunction(count=>CG.nodes.length>count,before.count);
 await page.waitForFunction(()=>!document.getElementById('load-more-papers').disabled);
 assert.equal(await page.evaluate(()=>CG.minCitations),0);
 assert((await page.evaluate(()=>CG.nodes.length))<=before.count+100);
 assert.deepEqual(await page.evaluate(()=>({x:CG.nodeById.Wr1.x,y:CG.nodeById.Wr1.y})),{x:before.x,y:before.y});
 assert(await page.locator('#citation-load-status').textContent());
 const count=await page.evaluate(()=>CG.nodes.length);
 await page.click('#load-more-papers');await page.waitForFunction(count=>CG.nodes.length>count,count);
 await page.waitForFunction(()=>!document.getElementById('load-more-papers').disabled);
 const req=urls.length;await lower(10);await lower(100);await lower(500);
 await page.waitForTimeout(1500);await page.waitForFunction(()=>!document.getElementById('load-more-papers').disabled || document.getElementById('load-more-papers').hidden);
 assert(urls.slice(req).filter(u=>u.includes('cursor=')).length<=2,'rapid range changes debounce');
 assert.equal(await page.evaluate(()=>CG.minCitations),500);
 // A late response from a superseded range must not overwrite the chosen range.
 await page.route('https://api.openalex.org/works?**',async route=>{
   const filter=new URL(route.request().url()).searchParams.get('filter')||'';
   if(filter.includes('cited_by_count:>122'))await new Promise(r=>setTimeout(r,700));
   await route.fallback();
 });
 await lower(123);await page.waitForTimeout(500);await lower(700);
 await page.waitForTimeout(1700);await page.waitForFunction(()=>!document.getElementById('load-more-papers').disabled || document.getElementById('load-more-papers').hidden);
 assert.equal(await page.evaluate(()=>CG.minCitations),700);
 assert.equal(await page.evaluate(()=>CitationPage.network.meta.expansion.min),700);
 await page.screenshot({path:path.join(output,'adaptive-expansion.png')});
 await page.reload();await settled(page);
 assert((await page.evaluate(()=>CG.nodes.length))>=count,'expanded network cached');
 assert.equal(errors.length,0,errors.join('\n'));
 await page.evaluate(()=>sessionStorage.setItem('citation-current',JSON.stringify({seedId:'Wseed',density:80,modeVersion:3})));
 await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
 assert.equal(new URL(await page.locator('[data-view="graph"]').getAttribute('href')).searchParams.get('density'),'0');
 console.log('Adaptive initial threshold, 100-paper expansion, stable positions, continued expansion, debounced ranges and cache passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
