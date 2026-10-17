const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const original = execFileSync('git', ['show', 'e67f123df074d87d5581472ede48bc558ef142ca:index.html'], { cwd: root, maxBuffer: 8e6 });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (file === '/before.html') { res.setHeader('Content-Type', mime['.html']); return res.end(original); }
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

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  const report = { environment: { browser: browser.version(), viewport: '1440x1000', cpuSlowdown: 4,
    network: '10 Mbit/s, 40 ms latency for local static assets; identical deterministic OpenAlex fixtures',
    note: 'Medians of three fresh browser contexts. API speedups use fixtures, not a claim about live OpenAlex latency.' }, cold: {}, graph: {}, checks: [] };
  try {
    for (const version of (process.env.PAGES_ONLY ? [] : ['before', 'after'])) {
      const runs = [];
      for (let trial = 0; trial < 3; trial++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const page = await context.newPage(); await mock(page);
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        const assetFailures = [];
        page.on('response', response => {
          if (response.url().startsWith(base) && response.status() >= 400) assetFailures.push(response.url() + ': ' + response.status());
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1250000, uploadThroughput: 1250000 });
        await page.addInitScript(() => { window.longTasks = []; new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true }); });
        await page.goto(base + (version === 'before' ? '/before.html' : '/graph.html') + '?seed=Wseed');
        await page.waitForFunction(() => window.CG?.nodes.length && document.getElementById('loader').hidden);
        const directReadyMs = await page.evaluate(() => performance.now());
        await settled(page);
        assert.deepEqual(errors, [], version + ' has browser errors');
        assert.deepEqual(assetFailures, [], version + ' has missing static assets');
        if (version === 'after') {
          assert(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Georgia') && getComputedStyle(document.body).backgroundColor === 'rgb(245, 242, 236)'));
          assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\.woff2(?:$|\?)/.test(r.name)).length), 0, 'default Georgia needs no font downloads');
        }
        const timing = await page.evaluate(() => ({ readyMs: performance.now(), bytes: performance.getEntriesByType('resource').filter(r => r.name.startsWith(location.origin)).reduce((s, r) => s + r.encodedBodySize, performance.getEntriesByType('navigation')[0].encodedBodySize), maxLongTaskMs: Math.max(0, ...longTasks) }));
        timing.directReadyMs = directReadyMs;
        timing.idleAttributeWritesIn500ms = await idleWrites(page);
        timing.labels = await labelStats(page);
        if (trial === 0) { await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({ path: path.join(output, version + '-graph.png') }); }
        runs.push(timing); await context.close();
      }
      const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[1];
      report.cold[version] = { readyMs: median('readyMs'), directReadyMs: median('directReadyMs'), bytes: median('bytes'), maxLongTaskMs: median('maxLongTaskMs'), idleAttributeWritesIn500ms: median('idleAttributeWritesIn500ms'), labels: runs[1].labels, runs };
    }

    // Compare the same larger graph, including the time spent blocking the UI.
    for (const version of (process.env.PAGES_ONLY ? [] : ['before', 'after'])) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage(); await mock(page);
      const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(base + (version === 'before' ? '/before.html' : '/graph.html') + '?seed=Wseed'); await settled(page);
      report.graph[version] = await page.evaluate(async () => {
        const papers = Array.from({ length: 500 }, (_, i) => ({ id: 'P' + i, title: 'Research paper ' + i, short: 'Author' + i, year: 2025, cites: 10, role: i ? 'ref' : 'seed' }));
        const edges = papers.slice(1).flatMap((p, i) => [{ s: p.id, t: 'P' + i }, { s: p.id, t: 'P' + Math.floor(i / 2) }]);
        const gaps = []; let last = performance.now(); const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 16);
        await new Promise(r => setTimeout(r, 30));
        const start = performance.now(); const pending = CG.setData(papers, edges, 'P0'); const synchronousMs = performance.now() - start;
        await pending; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const elapsedMs = performance.now() - start; clearInterval(timer);
        return { synchronousMs, elapsedMs, maxTimerGapMs: Math.max(0, ...gaps), nodes: CG.nodes.length };
      });
      if (version === 'after') await page.waitForFunction(()=>!CG._motionActive);
      report.graph[version].idleAttributeWritesIn500ms = await idleWrites(page);
      report.graph[version].medianHoverToFrameMs = await page.evaluate(async () => {
        const times = [];
        for (let i = 0; i < 9; i++) {
          const start = performance.now();
          CG.hovered = CG.nodes[10 + i];
          if (CG._invalidate) CG._invalidate(); else CG._paint();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          times.push(performance.now() - start);
        }
        CG.hovered = null;
        if (CG._invalidate) CG._invalidate(); else CG._paint();
        return times.sort((a, b) => a - b)[4];
      });
      await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({ path: path.join(output, version + '-500.png') });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      addEventListener('pagereveal', event => {
        const transition = event.viewTransition;
        if (!transition) return;
        transition.ready.then(() => {
          window.lastSlide = { direction: document.documentElement.dataset.slide, content: getComputedStyle(document.documentElement, '::view-transition-new(workspace)').animationName, header: getComputedStyle(document.documentElement, '::view-transition-group(navigation)').animationName };
        }).catch(() => {});
      });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedGraphUrl = text; } } });
    });
    const page = await context.newPage(); const urls = await mock(page, { extraDelay: 1600 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?seed=Wseed');
    assert.equal(await page.locator('main').count(), 1);
    assert.equal(await page.locator('#view-search').count(), 1);
    assert.equal(await page.locator('#graph-canvas, #view-list, .appearance-panel, #mini-input, .topbar .brand, .page-paper-title').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.CG), 'undefined');
    assert.equal(urls.length, 0, 'Home does not fetch a network, even with a legacy seed query');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => /layout|graph\.js/.test(r.name))), false);
    assert.equal(await page.locator('.search-intro').count(), 0);
    assert.equal(await page.locator('.topbar a:visible, #share-btn:visible, #menu-toggle').count(), 0);
    assert(await page.locator('#theme-toggle').isVisible());
    assert.equal((await page.locator('#big-go').textContent()).trim(), '→');
    const centered = await page.locator('.search-wrap').evaluate(el => { const r=el.getBoundingClientRect();return { x:r.x+r.width/2, y:r.y+r.height/2 }; });
    assert(Math.abs(centered.x - 720) < 12); assert(Math.abs(centered.y - 500) < 60);
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({ path: path.join(output, 'after-search.png') });
    await page.fill('#big-input', 'catalysis'); await page.click('#big-go'); await page.click('.presult');
    await page.waitForURL('**/graph.html?*');
    await page.waitForFunction(() => window.CG?.nodes.length && document.getElementById('loader').hidden);
    const direct = await page.evaluate(() => CG.nodes.map(n => ({ id:n.id, x:n.x, y:n.y })));
    assert.equal(direct.length, 250); await settled(page);
    const expanded = await page.evaluate(() => CG.nodes.map(n => ({ id:n.id,x:n.x,y:n.y })));
    assert.equal(expanded.length, 262);
    for (const old of direct) { const node=expanded.find(n=>n.id===old.id);assert.equal(node.x,old.x);assert.equal(node.y,old.y); }
    report.checks.push('Home is centered Search only; selecting a result opens a distinct Graph document; progressive layout stays stable');
    assert.equal(await page.locator('main').count(), 1);
    assert.equal(await page.locator('#view-search, #view-list').count(), 0);
    assert.deepEqual(await page.locator('.topbar a').allTextContents(), ['Search', 'Paper', 'Graph', 'List']);
    assert.equal(await page.locator('.topbar [aria-current=page]').textContent(), 'Graph');
    const nav = await page.locator('#notebook-menu').boundingBox();
    assert(Math.abs(nav.x + nav.width / 2 - 720) < 1);
    assert.equal(await page.locator('#seed-title, #graph-info, .filterbar, #d-abstract, .stats, #d-conns').count(),0);
    assert.equal(await page.locator('#detail').isVisible(),false);
    const graphBox = await page.locator('#graph-canvas').boundingBox();
    const headerBox = await page.locator('.topbar').boundingBox();
    assert.equal(graphBox.width,1440);assert.equal(graphBox.y,headerBox.height);assert.equal(graphBox.height,1000-headerBox.height);
    for (const role of ['cite','ref','linked','seed']) {
      const target = await page.evaluate(role=>{ const n=CG.nodes.find(n=>n.role===role);CG.focusNode(n.id);CG.select(null);return n.id; },role); await frames(page);
      const point = await page.evaluate(id=>{const r=CG.nodeById[id].cEl.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},target);
      await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+1,point.y+1);await page.mouse.up();await frames(page);
      assert.equal(await page.evaluate(()=>CG.selected),target);
      assert.equal(await page.locator('#d-title').textContent(),await page.evaluate(id=>CG.nodeById[id].title,target));
      assert(await page.locator('#detail').isVisible());
      assert.equal(await page.locator('#gtooltip').evaluate(el=>el.classList.contains('show')),false);
      assert.equal(await page.locator('#d-authors').textContent(),await page.evaluate(id=>CG.nodeById[id].authors,target));
      assert.equal(await page.locator('#d-year').textContent(),await page.evaluate(id=>String(CG.nodeById[id].year),target));
      assert.equal(await page.locator('#d-venue').textContent(),'Journal of Chemistry');
      assert.equal(await page.locator('#d-link').getAttribute('href'),await page.evaluate(id=>CG.nodeById[id].url,target));
      assert.equal(await page.locator('#d-link').getAttribute('target'),'_blank');
      assert.deepEqual(await page.locator('#graph-canvas').boundingBox(),graphBox,'Popup does not resize the graph');
      if (role === 'seed') { await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-popup.png')}); }
      await page.click('#detail-close');assert.equal(await page.locator('#detail').isVisible(),false);
      assert.equal(await page.evaluate(()=>CG.selected),null);

    }
    const stackIds = await page.evaluate(() => { const ids=CG.nodes.slice(0,5).map(n=>n.id); ids.forEach(id=>CG.select(id)); return ids; });
    assert.deepEqual(await page.locator('.paper-card').evaluateAll(cards=>cards.map(c=>c.dataset.id)),stackIds.slice(1).reverse());
    assert.equal(await page.evaluate(()=>CG.selectedIds.size),4);
    await page.waitForTimeout(300);
    const cardBoxes = await page.locator('.paper-card').evaluateAll(cards=>cards.map(c=>{const r=c.getBoundingClientRect();return {y:r.y,bottom:r.bottom};}));
    for(let i=1;i<4;i++) assert(cardBoxes[i].y >= cardBoxes[i-1].bottom-9);
    await page.locator('.paper-card').nth(3).locator('.card-title').click();
    assert.equal(await page.evaluate(()=>CG.selected),stackIds[1]);
    assert.equal(await page.locator('.paper-card').count(),4);
    await page.click('#detail-close');
    assert.equal(await page.locator('.paper-card').count(),3);
    assert.equal(await page.evaluate(id=>CG.selectedIds.has(id),stackIds[1]),false);
    await page.screenshot({path:path.join(output,'stack-cards.png')});
    await page.evaluate(()=>CG.select(null));
    await page.click('#zoom-fit'); await frames(page);
    const labels = await labelStats(page);assert(labels.visible>=1);assert.equal(labels.overlappingPairs,0);assert(labels.minScreenFontPx>=12.99);
    assert.equal(await idleWrites(page),0);
    const zoom=await page.evaluate(()=>CG.scale);await page.click('#zoom-in');await frames(page);assert(await page.evaluate(v=>CG.scale>v,zoom));
    await page.locator('.gnode[data-id="Wseed"]').focus();await page.keyboard.press('Enter');
    assert(await page.locator('#detail').isVisible());await page.keyboard.press('Escape');assert.equal(await page.locator('#detail').isVisible(),false);
    await navigate(page,'paper');await page.waitForFunction(()=>window.CitationPage?.ready&&!document.getElementById('status-counts').textContent.includes('finding'));
    assert.equal(await page.evaluate(()=>typeof window.CG),'undefined');
    assert.equal(await page.locator('#graph-canvas').count(),0);
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),nav);
    await page.waitForFunction(()=>document.getElementById('d-abstract').textContent==='This is an abstract');
    assert.equal(await page.locator('#d-title').textContent(),'Catalytic pathways and connected research in chemistry');
    assert(await page.locator('#d-conns .conn').count()>0);
    await page.selectOption('#density','120');
    await page.waitForFunction(()=>window.CitationPage?.network.meta.citingShown===120&&!document.getElementById('status-counts').textContent.includes('finding'));
    assert(new URL(page.url()).pathname.endsWith('/paper.html'));
    await page.click('#toggle-ref');
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-paper.png')});
    await navigate(page,'graph');await settled(page);
    assert.equal(await page.evaluate(()=>CG.nodes.filter(n=>n.role==='cite').length),120);
    assert.equal(await page.locator('.gnode').evaluateAll(nodes=>nodes.filter(n=>n.style.display!=='none').length),133);
    await navigate(page,'paper');await page.waitForFunction(()=>window.CitationPage?.ready);
    assert.equal(await page.locator('#toggle-ref').getAttribute('aria-pressed'),'false');await page.click('#toggle-ref');
    await navigate(page,'graph');await settled(page);
    report.checks.push('Graph fills the workspace; all paper types open compact closable popups; Paper holds abstracts, connections, density and persistent graph filters');
    assert.equal(await page.locator('#mini-input, #appearance-toggle').count(),0);
    assert.equal((await page.locator('#share-btn').textContent()).trim(),'');assert.equal(await page.locator('#share-btn').getAttribute('aria-label'),'Share graph');
    await page.click('#share-btn');const sharedUrl=await page.evaluate(()=>window.copiedGraphUrl);assert.equal(new URL(sharedUrl).pathname,'/graph.html');assert.equal(new URL(sharedUrl).searchParams.get('density'),'120');
    await page.click('#theme-toggle');assert(await page.locator('.theme-sun').isVisible());await page.keyboard.press('Escape');
    assert(await page.locator('#notebook-menu').isVisible());
    await page.reload();await settled(page);assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'),'true');
    await page.click('#theme-toggle');await page.keyboard.press('Escape');
    await page.emulateMedia({reducedMotion:'reduce'});assert(await page.locator('.notebook-menu').evaluate(el=>getComputedStyle(el,'::before').transitionDuration==='0s'));await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForTimeout(250); await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-details.png')});
    const apiBeforeList=urls.length;await navigate(page,'list');await page.waitForFunction(()=>window.CitationPage?.ready&&!document.getElementById('status-counts').textContent.includes('finding'));
    assert.equal(await page.locator('main').count(),1);assert.equal(await page.locator('#view-search, #view-graph, #graph-canvas').count(),0);
    assert.equal(await page.evaluate(()=>typeof window.CG),'undefined');
    assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').some(r=>/layout|graph\.js/.test(r.name))),false);
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),nav);
    assert.equal(urls.length,apiBeforeList,'List reuses the cached network responses');
    await page.waitForFunction(()=>window.lastSlide);
    assert.deepEqual(await page.evaluate(()=>window.lastSlide),{direction:'forward',content:'slide-in-right',header:'none'});
    assert.equal(await page.locator('#seed-title').textContent(),'Catalytic pathways and connected research in chemistry');
    assert.match(await page.locator('#list-seed').textContent(),/^302 papers · \d+ links · top 120 of 160 citing$/);
    const listUrl=page.url();await page.click('#papers-body tr[data-id="Wr0"]');
    await page.waitForFunction(()=>document.getElementById('d-abstract').textContent==='This is an abstract');
    assert.equal(page.url(),listUrl);assert(await page.locator('#detail').isVisible());assert.equal(await page.locator('#d-title').textContent(),'Connected research paper Wr0');
    assert(await page.locator('#detail').evaluate(el=>el.getBoundingClientRect().left>=innerWidth*.6));
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-list.png')});
    await page.locator('#papers-body tr[data-id="Wr1"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#d-title').textContent(),'Connected research paper Wr1');
    await page.click('#detail-close');assert.equal(await page.locator('#detail').isVisible(),false);
    await page.click('[data-sort="year"]');const years=await page.locator('#papers-body tr[data-id] td:nth-child(4)').allTextContents();assert(+years[0]>=+years[years.length-1]);
    await page.selectOption('#type-filter','Article');assert.equal(await page.locator('#papers-body tr[data-id]').count(),302);
    const downloadPromise=page.waitForEvent('download');await page.click('#export-bib');assert((await downloadPromise).suggestedFilename().endsWith('.bib'));
    report.checks.push('List loads independently without graph assets; clicking or keyboard-selecting a row opens its summary on the right, with sorting and export preserved');
    const beforeHome=urls.length;await page.click('[data-view=search]');await page.waitForURL('**/index.html');
    assert.equal(await page.locator('#view-search').count(),1);assert.equal(urls.length,beforeHome);assert.equal(new URL(page.url()).search,'');assert.equal(await page.evaluate(()=>typeof window.CG),'undefined');
    await page.waitForFunction(()=>window.lastSlide);
    assert.deepEqual(await page.evaluate(()=>window.lastSlide),{direction:'backward',content:'slide-in-left',header:'none'});
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),nav);
    assert.equal(await page.locator('.topbar a:visible').count(),4);
    assert.equal(await page.locator('[data-view=search]').getAttribute('aria-current'),'page');
    await page.click('#share-btn');
    assert.equal(new URL(await page.evaluate(()=>window.copiedGraphUrl)).searchParams.get('density'),'120');
    const timeOrigin=await page.evaluate(()=>performance.timeOrigin);
    await page.click('[data-view=search]');assert.equal(await page.evaluate(()=>performance.timeOrigin),timeOrigin);
    await page.reload();assert.equal(await page.locator('#view-search').count(),1);assert.equal(urls.length,beforeHome);
    await page.goBack();assert(new URL(page.url()).pathname.endsWith('/list.html'));await page.waitForFunction(()=>window.CitationPage?.ready);
    await navigate(page,'search');await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('#big-go').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-mobile.png')});
    const mobileNav=await page.locator('#notebook-menu').boundingBox();
    await navigate(page,'graph');await settled(page);assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),mobileNav);await page.mouse.move(0,0);await frames(page);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-mobile-graph.png')});
    const mobileGraph = await page.locator('#graph-canvas').boundingBox();
    assert.equal(mobileGraph.width,390);assert.equal(mobileGraph.height,844-68);
    await page.evaluate(()=>CG.focusNode('Wseed'));assert(await page.locator('#detail').isVisible());
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>{CG.select(null);CG.nodes.slice(0,5).forEach(n=>CG.select(n.id));});
    assert.equal(await page.locator('.paper-card').count(),4);
    assert.equal(await page.locator('#detail').evaluate(el=>el.getAnimations({subtree:true}).length),0);
    const mobilePopup=await page.locator('#detail').boundingBox();assert(mobilePopup.x>=0 && mobilePopup.x+mobilePopup.width<=390 && mobilePopup.y+mobilePopup.height<=844);
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-mobile-popup.png')});for(let i=0;i<4;i++) await page.click('#detail-close');assert.equal(await page.locator('#detail').isVisible(),false);
    await navigate(page,'paper');await page.waitForFunction(()=>window.CitationPage?.ready);
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),mobileNav);
    assert(await page.locator('#d-title').isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-mobile-paper.png')});
    await navigate(page,'list');await page.waitForFunction(()=>window.CitationPage?.ready);await page.click('#papers-body tr[data-id="Wr0"]');
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),mobileNav);
    assert(await page.locator('#detail').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));assert(new URL(page.url()).pathname.endsWith('/list.html'));await page.waitForFunction(()=>!document.documentElement.dataset.slide); await frames(page); await page.screenshot({path:path.join(output,'after-mobile-list.png')});await page.click('#detail-close');
    await page.emulateMedia({reducedMotion:'reduce'});
    await navigate(page,'search');await page.waitForURL('**/index.html');
    assert.equal(await page.evaluate(()=>window.lastSlide),undefined);
    assert.deepEqual(await page.locator('#notebook-menu').boundingBox(),mobileNav);
    assert.deepEqual(errors,[]);report.checks.push('Home and reload always show Search; browser Back restores List; mobile pages and menu remain usable');await context.close();
    const fallback=await browser.newContext();const fallbackPage=await fallback.newPage();await mock(fallbackPage,{failExtra:true});await fallbackPage.addInitScript(()=>{window.Worker=undefined;});
    await fallbackPage.goto(base+'/graph.html?seed=Wseed');await settled(fallbackPage);assert.equal(await fallbackPage.evaluate(()=>CG.nodes.length),250);assert((await fallbackPage.locator('#status-counts').textContent()).includes('unavailable'));await fallback.close();
    report.checks.push('Time-sliced layout and failed optional enrichment still preserve a usable graph');
    if (report.cold.after) { assert(report.cold.after.bytes<report.cold.before.bytes*.2);assert(report.cold.after.readyMs<report.cold.before.readyMs);assert(report.graph.after.synchronousMs<report.graph.before.synchronousMs*.5); }
    fs.writeFileSync(path.join(output,process.env.PAGES_ONLY ? 'pages-checks.json' : 'performance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally { await browser.close();server.close(); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
