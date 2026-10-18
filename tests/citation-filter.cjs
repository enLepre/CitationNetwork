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
 await mock(page); await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed&density=80&loading=fixed'); await settled(page);
 await page.click('#toggle-clusters');
 assert.equal(await page.locator('#toggle-clusters').getAttribute('aria-pressed'),'true');
 assert(await page.evaluate(()=>CG.clusters.length>0));
 await frames(page);
 const flag=page.locator('.cluster-flag:visible').first();
 await flag.click();
 assert(await page.evaluate(()=>Boolean(CG.activeCluster)));
 await frames(page);
 await page.screenshot({path:path.join(output,'research-groups.png')});
 const membership=await page.evaluate(()=>JSON.stringify(CG.clusters.map(c=>c.ids)));
 await page.click('#zoom-in');await frames(page);
 assert.equal(await page.evaluate(()=>JSON.stringify(CG.clusters.map(c=>c.ids))),membership);
 await page.click('#toggle-clusters');
 assert.equal(await page.evaluate(()=>CG.activeCluster),null);
 await page.click('#graph-search summary');
 await page.fill('#graph-search-query','connected wr12');
 assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)&&n.role!=='seed').length),11);
 await page.fill('#graph-search-query','researcher168');
 assert.deepEqual(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)&&n.role!=='seed').map(n=>n.id)),['Wr168']);
 await page.fill('#graph-search-query','CHEMISTRY');
 assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)).length),await page.evaluate(()=>CG.nodes.length));
 await page.screenshot({path:path.join(output,'graph-search.png')});
 await page.evaluate(()=>CG.setFilter({showRefs:false}));
 assert(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)).every(n=>n.role!=='ref')));
 await page.evaluate(()=>CG.setFilter({showRefs:true}));
 await page.fill('#graph-search-query','ÉNRICO');
 assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)).length),await page.evaluate(()=>CG.nodes.length));
 await page.fill('#graph-search-query','no-such-paper');
 assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)).length),1);
 await page.click('#graph-search-clear');
 assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>CG._visible(n)).length),await page.evaluate(()=>CG.nodes.length));
 await page.keyboard.press('Escape');
 assert(!(await page.locator('#graph-search').getAttribute('open')));
 assert(await page.locator('#citation-filter').isHidden());
 assert(await page.locator('#zoom-in').isVisible());
 assert(await page.locator('#zoom-fit').isVisible());
 await page.click('#zoom-in');
 assert.equal(await page.locator('#graph-options .settings-panel').count(),4);
 await page.click('#graph-options summary');
 assert(await page.locator('#citation-filter').isVisible());
 assert(await page.locator('#graph-center').isVisible());
 const force=page.locator('#graph-center'), tip=page.locator('.force-control').first().locator('label');
 await force.hover();assert(await tip.isVisible());assert(await tip.locator('output').isHidden());
 const forceBox=await force.boundingBox();
 await page.mouse.move(forceBox.x+forceBox.width/3,forceBox.y+15);await page.mouse.down();
 await page.mouse.move(forceBox.x+forceBox.width/2,forceBox.y+15);
 assert(await tip.locator('output').isVisible());
 assert.equal(await force.getAttribute('aria-valuetext'),await tip.locator('output').textContent());
 await page.mouse.up();assert(await tip.locator('output').isHidden());
 await force.focus();await page.keyboard.down('ArrowRight');assert(await tip.locator('output').isVisible());
 await page.keyboard.up('ArrowRight');assert(await tip.locator('output').isHidden());
 await page.locator('#graph-options summary').focus();await page.mouse.move(1000,100);assert(await tip.isHidden());
 const panels=await page.locator('#graph-options .settings-panel').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom};}));
 assert(panels.every(p=>p.x===panels[0].x));
 assert(panels.slice(1).every((p,i)=>p.y>=panels[i].bottom));
 assert.equal(await page.locator('#graph-options .settings-panel h2').count(),0);
 assert(await page.locator('#graph-options .settings-panel').nth(2).locator('#graph-links').count());
 assert(await page.locator('#graph-options .settings-panel').nth(1).locator('#citation-range').count());
 assert(await page.locator('#graph-options .settings-panel').nth(0).locator('#spread-nearby').count());
 assert(await page.locator('#graph-options .settings-panel').nth(3).locator('#recenter-selected').count());
 assert(await page.locator('#zoom-in').isVisible());
 await page.locator('#graph-options summary').focus();await page.keyboard.press('Enter');
 assert(await page.locator('#citation-filter').isHidden());
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('#citation-min').inputValue(),'0');
 const set=async value=>{await page.locator('#citation-min').evaluate((el,value)=>{el.value=Math.log1p(Number(value))/Math.log1p(Number(el.dataset.citationMax))*1000;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));await frames(page);};
 // A very highly cited outlier must not compress the low end of the slider.
 await page.evaluate(()=>{CG.nodes[1].cites=1000000;document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 await set(10);
 assert(Number(await page.locator('#citation-min').inputValue())>150);
 await page.locator('#citation-min').evaluate(el=>{el.value='500';el.dispatchEvent(new Event('input'));});
 assert.equal(await page.locator('#citation-min').getAttribute('data-count'),'999');
 await set(0);
 const before=await page.locator('#citation-histogram').textContent();
 await set(500);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||n.cites>=500))));
 assert(await page.evaluate(()=>CG.edges.every(e=>!CG._visible(CG.nodeById[e.s])||!CG._visible(CG.nodeById[e.t])?e.path.style.display==='none':true)));
 assert.equal(await page.locator('#citation-histogram').textContent(),before);
 await page.locator('#citation-min').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#citation-min').getAttribute('data-count'),'501');
 await page.click('#toggle-ref');await frames(page);
 assert(await page.evaluate(()=>CG.nodes.filter(n=>n.role==='ref').every(n=>n.gEl.style.display==='none')));
 await page.click('#toggle-ref');await set(0);
 assert(await page.evaluate(()=>CG.nodes.every(n=>n.gEl.style.display!=='none')));
 const setUpper=async value=>{await page.locator('#citation-upper').evaluate((el,value)=>{el.value=Math.log1p(Number(value))/Math.log1p(Number(el.dataset.citationMax))*1000;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));await frames(page);};
 await set(100);await setUpper(500);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||(n.cites>=100&&n.cites<=500)))));
 assert(await page.evaluate(()=>CG.edges.every(e=>(CG._visible(CG.nodeById[e.s])&&CG._visible(CG.nodeById[e.t]))||e.path.style.display==='none')));
 await page.locator('#citation-upper').focus();await page.keyboard.press('ArrowLeft');
 assert.equal(await page.locator('#citation-upper').getAttribute('data-count'),'499');
 await set(600);assert.equal(await page.locator('#citation-min').getAttribute('data-count'),'499');
 await setUpper(10);assert.equal(await page.locator('#citation-upper').getAttribute('data-count'),'499');
 await set(0);await setUpper(0);
 assert(await page.evaluate(()=>CG.nodes.every(n=>(n.gEl.style.display!=='none')===(n.role==='seed'||n.cites===0))));
 await page.locator('#citation-upper').evaluate(el=>{el.value='1000';el.dispatchEvent(new Event('input'));});await frames(page);
 assert(await page.evaluate(()=>CG.nodes.every(n=>n.gEl.style.display!=='none')));
 await setUpper(1000000);await set(0);
 assert.equal(await page.locator('#citation-exact, #citation-upper-exact, #citation-filter-note').count(),0);
 const track=await page.locator('#citation-range').boundingBox();
 await page.mouse.move(track.x+8,track.y+15);await page.mouse.down();
 await page.mouse.move(track.x+track.width*.3,track.y+15);
 assert(await page.locator('#citation-min-value').isVisible());
 assert(Number(await page.locator('#citation-min').getAttribute('data-count'))>0);
 await page.mouse.up();assert(await page.locator('#citation-min-value').isHidden());
 await page.mouse.move(track.x+track.width-8,track.y+15);await page.mouse.down();
 await page.mouse.move(track.x+track.width*.8,track.y+15);
 assert(await page.locator('#citation-upper-value').isVisible());
 await page.mouse.up();assert(await page.locator('#citation-upper-value').isHidden());
 await page.locator('#citation-upper').focus();await page.keyboard.down('ArrowLeft');
 assert(await page.locator('#citation-upper-value').isVisible());
 await page.keyboard.up('ArrowLeft');assert(await page.locator('#citation-upper-value').isHidden());
 await setUpper(1500);
 await set(500);await page.screenshot({path:path.join(output,'citation-filter-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.click('#theme-toggle');await page.click('#graph-options summary');await frames(page);
 const box=await page.locator('.graph-options-panel').boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=844);
 await page.locator('#recenter-selected').scrollIntoViewIfNeeded();
 assert(await page.locator('#recenter-selected').isVisible());
 await page.locator('#citation-min').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,'citation-filter-mobile.png')});
 await page.evaluate(()=>{CG.nodes.forEach(n=>n.cites=1);document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 assert(await page.locator('#citation-histogram rect').evaluateAll(bars=>bars.every(b=>Number(b.getAttribute('width'))>0)));
 await page.evaluate(()=>{CG.nodes.forEach(n=>n.cites=0);document.getElementById('citation-min').dispatchEvent(new Event('input'));});
 assert(await page.locator('#citation-min').isDisabled());
 assert.equal(await page.locator('#citation-min').inputValue(),'0');
 const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
 await mock(touch);await touch.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed&density=80&loading=fixed');await settled(touch);
 await touch.tap('#graph-options summary');
 const touchBox=await touch.locator('#citation-range').boundingBox();
 await touch.touchscreen.tap(touchBox.x+touchBox.width*.25,touchBox.y+15);
 assert(Number(await touch.locator('#citation-min').getAttribute('data-count'))>0);
 assert(await touch.locator('#citation-min-value').isHidden());await touch.close();
 console.log('Citation threshold, boundary, edges, stable histogram, keyboard, combined filters, reset, mobile and dark mode passed.');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
