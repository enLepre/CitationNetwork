const { chromium } = require('playwright');
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
let failAbstracts = false;
const raw = (id, refs = []) => ({ id: 'https://openalex.org/' + id,
  display_name: id === 'Wseed' ? 'Catalytic pathways and connected research in chemistry' : 'Connected research paper ' + id + ' '+['photoredox catalysis','protein folding','carbon nitride','water splitting','oxygen reduction','carbon dots','single atoms','organic frameworks','hydrogen peroxide','solar cells','graphene oxide','metal oxides'][(parseInt(id.replace(/\D/g,''))||0)%12],
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
    if (failAbstracts && u.searchParams.get('select') === 'id,abstract_inverted_index') return route.fulfill({status:400,body:'{}'});
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
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try {
  records.get('Wc5').abstract_inverted_index={Quantum:[0],selectivity:[1]};
  records.get('Wr0').abstract_inverted_index=null;
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const urls=await mock(page,{extraDelay:20});
  await page.goto('http://127.0.0.1:'+server.address().port+'/graph.html?seed=Wseed&density=80&loading=fixed'); await settled(page);
  const total=await page.evaluate(()=>CG.nodes.length);
  assert(total>80);
  assert(!urls.some(u=>new URL(u).searchParams.get('select')==='id,abstract_inverted_index'));
  await page.click('#graph-search > summary');
  assert(await page.locator('#keyword-suggestions label').count()>1);
  await page.locator('#keyword-suggestions label').first().click();
  assert(await page.locator('.keyword-chip').count());
  await page.click('#keyword-reset');
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('restored'));
  await page.fill('#keyword-query','photoredox');
  await page.click('#keyword-rebuild');
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('matching'));
  const filtered=await page.evaluate(()=>({ids:CG.nodes.map(n=>n.id),titles:CG.nodes.map(n=>n.title),edges:CG.edges.map(e=>[e.s,e.t]),original:CitationPage.network.papers.length}));
  assert(filtered.ids.length<total && filtered.ids.length>1); assert.equal(filtered.original,total);
  filtered.titles.slice(1).forEach(t=>assert(t.includes('photoredox')));
  filtered.edges.forEach(e=>e.forEach(id=>assert(filtered.ids.includes(id))));
  await page.fill('#keyword-query','protein folding'); await page.press('#keyword-query','Enter');
  await page.click('#keyword-rebuild'); await page.waitForFunction(()=>document.getElementById('keyword-filter').getAttribute('aria-busy')==='false');
  assert(await page.evaluate(()=>CG.nodes.length)>filtered.ids.length);
  await page.selectOption('#keyword-mode','all'); await page.click('#keyword-rebuild');
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.startsWith('0 matching'));
  assert.equal(await page.evaluate(()=>CG.nodes.length),1);
  await page.click('#keyword-reset'); await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('restored'));
  assert.equal(await page.evaluate(()=>CG.nodes.length),total);
  await page.locator('[name="keyword-field"][value="title"]').uncheck();
  await page.fill('#keyword-query','Researcher5'); await page.click('#keyword-rebuild');
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('matching'));
  assert(await page.evaluate(()=>CG.nodes.slice(1).every(n=>n.searchAuthors.includes('Researcher5'))));
  await page.reload(); await settled(page);
  assert(await page.evaluate(()=>CG.nodes.slice(1).every(n=>n.searchAuthors.includes('Researcher5'))));
  await page.click('#graph-search > summary');
  await page.click('#keyword-reset'); await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('restored'));
  await page.locator('[name="keyword-field"][value="title"]').uncheck();
  await page.locator('[name="keyword-field"][value="authors"]').uncheck();
  assert(await page.locator('#keyword-rebuild').isDisabled());
  failAbstracts=true;
  await page.locator('[name="keyword-field"][value="abstract"]').check();
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('Could not load'));
  assert.equal(await page.evaluate(()=>CG.nodes.length),total);
  await page.fill('#keyword-query','quantum'); await page.click('#keyword-rebuild');
  await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('Could not rebuild'));
  assert.equal(await page.evaluate(()=>CG.nodes.length),total);
  failAbstracts=false;
  await page.click('#keyword-rebuild'); await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('matching'));
  assert.deepEqual(await page.evaluate(()=>CG.nodes.map(n=>n.id)),['Wseed','Wc5']);
  assert((await page.locator('#keyword-coverage').textContent()).includes('1 unavailable'));
  await page.screenshot({path:path.join(output,'keyword-rebuild-desktop.png')});
  await page.click('#keyword-reset'); await page.waitForFunction(()=>document.getElementById('keyword-status').textContent.includes('restored'));
  assert.equal(await page.evaluate(()=>CG.nodes.length),total);
  await page.setViewportSize({width:390,height:844});
  await page.click('#theme-toggle');
  await page.click('#graph-search > summary');
  await page.locator('#keyword-rebuild').scrollIntoViewIfNeeded();
  const box=await page.locator('.graph-search-panel').boundingBox(); assert(box.x>=0 && box.x+box.width<=391 && box.y>=0 && box.y+box.height<=844);
  await page.screenshot({path:path.join(output,'keyword-rebuild-mobile-dark.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: keyword suggestions, title/author/abstract fields, any/all, induced graph, anchor, missing abstracts, failure retry, reset, reload and mobile dark mode');
  await context.close();
 } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
