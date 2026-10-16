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
  await page.click('#menu-toggle');
  await page.click('#notebook-menu [data-view="' + view + '"]');
}
async function appearance(page) {
  await page.click('#menu-toggle');
  await page.click('#appearance-toggle');
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
    for (const version of ['before', 'after']) {
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
        await page.goto(base + (version === 'before' ? '/before.html' : '/') + '?seed=Wseed');
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
        if (trial === 0) await page.screenshot({ path: path.join(output, version + '-graph.png') });
        runs.push(timing); await context.close();
      }
      const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[1];
      report.cold[version] = { readyMs: median('readyMs'), directReadyMs: median('directReadyMs'), bytes: median('bytes'), maxLongTaskMs: median('maxLongTaskMs'), idleAttributeWritesIn500ms: median('idleAttributeWritesIn500ms'), labels: runs[1].labels, runs };
    }

    // Compare the same larger graph, including the time spent blocking the UI.
    for (const version of ['before', 'after']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage(); await mock(page);
      const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(base + (version === 'before' ? '/before.html' : '/') + '?seed=Wseed'); await settled(page);
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
      await page.screenshot({ path: path.join(output, version + '-500.png') });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); const urls = await mock(page, { extraDelay: 1600, slowSeed: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/?seed=Wseed');
    await page.waitForFunction(() => window.CG?.nodes.length && document.getElementById('loader').hidden);
    const direct = await page.evaluate(() => CG.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })));
    assert.equal(direct.length, 250, 'direct graph appears before delayed enrichment');
    await settled(page);
    const expanded = await page.evaluate(() => CG.nodes.map(n => ({ id: n.id, x: n.x, y: n.y })));
    assert.equal(expanded.length, 262);
    for (const old of direct) { const n = expanded.find(n => n.id === old.id); assert.equal(n.x, old.x); assert.equal(n.y, old.y); }
    report.checks.push('Direct graph appears before delayed enrichment; existing paper positions stay fixed');
    const labels = await labelStats(page);
    assert(labels.visible > 4); assert(labels.minScreenFontPx >= 12.99); assert.equal(labels.overlappingPairs, 0);
    for (let i = 0; i < 3; i++) await page.click('#zoom-in');
    await frames(page);
    const zoomLabels = await labelStats(page); assert.equal(zoomLabels.overlappingPairs, 0); assert(zoomLabels.minScreenFontPx >= 12.99);
    await page.click('#zoom-fit'); await frames(page);
    report.checks.push('Labels remain at least 13 screen pixels and do not overlap at overview or zoom');
    assert.equal(await idleWrites(page), 0); report.checks.push('Zero idle SVG mutations');
    for (const role of ['cite', 'ref', 'linked']) {
      const target = await page.evaluate(role => {
        const stage = document.getElementById('graph-canvas').getBoundingClientRect();
        return CG.nodes.filter(n => n.role === role).sort((a, b) => a.rad - b.rad).map(n => {
          const r = n.cEl.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          return { id: n.id, title: n.title, x, y, hit: document.elementFromPoint(x, y)?.closest('[data-paper-id]')?.dataset.paperId };
        }).find(n => n.hit === n.id && n.x > 60 && n.x < stage.right - 60 && n.y > stage.top + 180 && n.y < stage.bottom - 100);
      }, role);
      assert(target, 'a visible ' + role + ' paper is required');
      await page.mouse.move(target.x, target.y); await page.mouse.down();
      await page.mouse.move(target.x + 1, target.y + 1); await page.mouse.up(); await frames(page);
      assert.equal(await page.evaluate(() => CG.selected), target.id, role + ' paper must select with pointer jitter');
      assert.equal(await page.locator('#d-title').textContent(), target.title);
      await page.click('#detail-close'); await page.waitForTimeout(350); await frames(page);
    }
    report.checks.push('Mouse clicks with slight movement open the correct citing, reference and co-cited details');
    const zoomBefore = await page.evaluate(() => CG.scale); await page.click('#zoom-in'); await frames(page);
    assert((await page.evaluate(() => CG.scale)) > zoomBefore);
    await page.click('#toggle-ref'); await frames(page);
    assert.equal(await page.locator('.gnode').evaluateAll(nodes => nodes.filter(n => n.style.display !== 'none').length), 93);
    await page.click('#toggle-ref'); await frames(page);
    const node = page.locator('.gnode[data-id="Wseed"]'); await node.focus(); await page.keyboard.press('Enter'); await frames(page);
    await page.waitForFunction(() => document.getElementById('d-abstract').textContent === 'This is an abstract');
    assert.equal(await page.evaluate(() => CG.selected), 'Wseed');
    await page.click('#detail-close');
    const oldPosition = await page.evaluate(() => ({ x: CG.nodeById.Wseed.x, y: CG.nodeById.Wseed.y }));
    const circle = page.locator('.gnode[data-id="Wseed"] circle').last(); const box = await circle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20); await page.mouse.up(); await frames(page);
    assert.notEqual(await page.evaluate(() => CG.nodeById.Wseed.x), oldPosition.x);
    report.checks.push('Zoom, role filters, keyboard selection, abstract details and dragging');
    await appearance(page); await page.selectOption('[name="paper"]', 'cool'); await page.selectOption('[name="serif"]', 'Newsreader');
    await page.uncheck('[name="labels"]'); await frames(page);
    assert.equal(await page.locator('.glabel').evaluateAll(nodes => nodes.filter(n => getComputedStyle(n).display !== 'none').length), 0);
    await page.check('[name="labels"]'); await page.click('#appearance-close');
    const downloadPromise = page.waitForEvent('download'); await navigate(page, 'list'); await page.click('#export-bib');
    const download = await downloadPromise; assert(download.suggestedFilename().endsWith('.bib'));
    await navigate(page, 'graph'); await frames(page);
    report.checks.push('Appearance controls, font changes, list view and BibTeX export');
    assert.equal(await page.locator('a[href*="Personal-Blog"]').count(), 0);
    assert.equal(await page.locator('.notebook-footer, .examples, .howto').count(), 0);
    assert.equal(await page.locator('#view-search .search-wrap > *').count(), 4);
    assert.equal(await page.locator('#view-search').textContent().then(s => /Enrico|Lepre|A few starting points/.test(s)), false);
    for (const view of ['search', 'list', 'graph']) {
      await page.click('#menu-toggle');
      await page.click('#notebook-menu [data-view="' + view + '"]');
      assert.equal(await page.locator('#view-' + view).isVisible(), true);
      assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#notebook-menu [data-view="' + view + '"]').getAttribute('aria-current'), 'page');
      if (view === 'list') {
        assert.match(await page.locator('#list-seed').textContent(), /^262 papers · \d+ links · top 80 of 160 citing$/);
        await page.screenshot({ path: path.join(output, 'after-list.png') });
      }
    }
    report.checks.push('Independent Search/Graph/List menu, no personal attribution, minimal search and counts-only list summary');
    await page.click('#menu-toggle'); await page.click('#notebook-menu .menu-brand');
    assert(await page.locator('#view-search').isVisible());
    assert(await page.locator('#notebook-menu').evaluate(el => el.inert));
    await navigate(page, 'graph');
    await appearance(page); await page.click('#appearance-reset'); await page.click('#appearance-close');
    await page.click('#menu-toggle');
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.waitForTimeout(450);
    assert(await page.locator('.site-menu').evaluate(el => parseFloat(getComputedStyle(el, '::before').width) >= 311));
    await page.click('#theme-toggle'); await frames(page);
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), 'true');
    assert(await page.locator('#theme-toggle .theme-sun').isVisible());
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(39, 44, 50)');
    await page.screenshot({ path: path.join(output, 'after-dark-graph.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#menu-toggle').evaluate(el => el === document.activeElement), true);
    await page.reload(); await settled(page);
    assert.equal(await page.locator('#theme-toggle').getAttribute('aria-pressed'), 'true');
    await page.click('#menu-toggle'); await page.click('#theme-toggle'); await page.keyboard.press('Escape');
    await navigate(page, 'search'); await frames(page);
    await page.waitForTimeout(250); await page.screenshot({ path: path.join(output, 'after-search.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.menu-toggle span').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert(await page.locator('.site-menu').evaluate(el => getComputedStyle(el, '::before').transitionDuration === '0s'));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await navigate(page, 'graph'); await frames(page);
    await page.locator('.gnode[data-id="Wseed"]').focus(); await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    assert(await page.locator('.topbar').evaluate(el => el.getBoundingClientRect().top >= 0), 'keyboard focus must not scroll the page out of view');
    await page.waitForSelector('#detail:not(.closed)');
    const detailBounds = await page.locator('#detail').evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: innerWidth }));
    assert(detailBounds.right <= detailBounds.width + 1 && detailBounds.left >= -1, JSON.stringify(detailBounds));
    await page.screenshot({ path: path.join(output, 'after-details.png') });
    await page.click('#detail-close');
    report.checks.push('Notebook palette, accessible diamond navigation, persisted dark paper, reduced motion and article-style details');
    const countBeforeReload = urls.length; await page.reload(); await settled(page);
    assert.equal(urls.length, countBeforeReload, 'reload should reuse session cache');
    report.checks.push('Reload reuses cached API responses');
    await page.selectOption('#density', '120'); await settled(page);
    assert.equal(await page.evaluate(() => CG.nodes.filter(n => n.role === 'cite').length), 120);
    report.checks.push('120-paper density loads correctly');
    // Start a slow seed, then immediately pick a faster one. The slow response must not win.
    await page.evaluate(() => { document.getElementById('mini-input').value = ''; });
    await navigate(page, 'search'); await page.fill('#big-input', 'slow'); await page.click('#big-go');
    await page.waitForSelector('.presult');
    // Exercise load overlap through the exposed shared-link route by clicking results supplied by search.
    await page.evaluate(() => {
      const originalSearch = OpenAlex.search;
      OpenAlex.search = async q => [{ id: q === 'slow' ? 'Wslow' : 'Wfast', title: q, short: 'Author', year: 2025, refsLoaded: false }];
      window.restoreSearch = () => { OpenAlex.search = originalSearch; };
    });
    await page.fill('#picker-input', 'slow'); await page.press('#picker-input', 'Enter'); await page.waitForSelector('.presult'); await page.click('.presult');
    await navigate(page, 'search'); await page.fill('#big-input', 'fast'); await page.click('#big-go'); await page.waitForSelector('.presult'); await page.click('.presult');
    await settled(page); await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => CG.seedId), 'Wfast'); report.checks.push('Overlapping loads keep the newest seed');
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 }); await navigate(page, 'search'); await frames(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.locator('#big-go').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    assert.equal(await page.locator('.topbar > button:not(.brand), .topnav, .topbar > .mini-search').count(), 0);
    await page.click('#menu-toggle');
    assert(await page.locator('#appearance-toggle').isVisible());
    assert(await page.locator('#theme-toggle .theme-moon').isVisible());
    assert.equal((await page.locator('#theme-toggle').textContent()).trim(), '');
    assert.equal(await page.locator('#notebook-menu .menu-brand').textContent(), 'Citation Network');
    assert(await page.locator('.site-menu').evaluate(el => parseFloat(getComputedStyle(el, '::before').borderTopWidth) >= 1));
    assert(await page.locator('#notebook-menu').evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().bottom <= innerHeight));
    await page.waitForTimeout(250); await page.screenshot({ path: path.join(output, 'after-mobile-menu.png') });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(output, 'after-mobile.png') });
    await navigate(page, 'graph'); await frames(page);
    assert(await page.evaluate(() => document.querySelector('.filterbar').getBoundingClientRect().top > document.querySelector('.seed-banner').getBoundingClientRect().bottom));
    await page.screenshot({ path: path.join(output, 'after-mobile-graph.png') });
    report.checks.push('Mobile search controls fit; graph filters do not overlap the heading');
    await context.close();

    const fallback = await browser.newContext(); const fallbackPage = await fallback.newPage(); await mock(fallbackPage, { failExtra: true });
    await fallbackPage.addInitScript(() => { window.Worker = undefined; });
    await fallbackPage.goto(base + '/?seed=Wseed'); await settled(fallbackPage);
    assert.equal(await fallbackPage.evaluate(() => CG.nodes.length), 250);
    assert((await fallbackPage.locator('#status-counts').textContent()).includes('unavailable'));
    report.checks.push('Time-sliced layout works without Workers; failed optional lookup preserves direct graph');
    await fallback.close();
    if (process.env.RUN_LIVE === '1') {
      const live = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const livePage = await live.newPage();
      const liveErrors = []; livePage.on('pageerror', error => liveErrors.push(error.message));
      await livePage.goto(base + '/?seed=W2741809807');
      await settled(livePage);
      assert.deepEqual(liveErrors, []);
      report.live = await livePage.evaluate(() => ({ seed: CG.seedId, papers: CG.nodes.length, edges: CG.edges.length,
        title: document.getElementById('seed-title').textContent, status: document.getElementById('status-counts').textContent }));
      assert(report.live.papers > 10);
      report.live.labels = await labelStats(livePage);
      await livePage.screenshot({ path: path.join(output, 'after-live.png') });
      await livePage.click('.gnode[data-id="W2741809807"]');
      await livePage.waitForFunction(() => !document.getElementById('d-abstract').classList.contains('loading'));
      report.live.abstract = await livePage.locator('#d-abstract').textContent();
      report.checks.push('Live OpenAlex paper, network and abstract load successfully');
      await live.close();
    }
    assert(report.cold.after.bytes < report.cold.before.bytes * 0.2);
    assert(report.cold.after.readyMs < report.cold.before.readyMs);
    assert(report.graph.after.synchronousMs < report.graph.before.synchronousMs * 0.5);
    fs.writeFileSync(path.join(output, 'performance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
