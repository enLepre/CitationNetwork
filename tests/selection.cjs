const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function point(page, id) {
  return page.evaluate(id => {
    const n = CG.nodeById[id], rect = n.cEl.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, wx: n.x, wy: n.y, radius: rect.width / 2 };
  }, id);
}
async function fixture(page) {
  if (process.env.SELECTION_BASELINE === '1') {
    for (const file of ['assets/graph.js', 'assets/styles.css']) {
      const body = execFileSync('git', ['show', 'e6273312c0195597cf0f049e535d18591c7a1963:' + file], { cwd: root });
      await page.route('**/' + file + '*', route => route.fulfill({ contentType: types[path.extname(file)], body }));
    }
  }
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(async () => {
    document.getElementById('view-search').hidden = true;
    document.getElementById('view-graph').hidden = false;
    window.selectedPapers = [];
    window.CG = new CitationGraph(document.getElementById('graph-canvas'), { onSelect: n => selectedPapers.push(n?.id || null) });
    const roles = ['seed', 'cite', 'ref', 'linked'];
    const papers = roles.map((role, i) => ({ id: role, role, title: role + ' paper', short: 'Author' + i, year: 2025, cites: 0 }));
    await CG.setData(papers, [{ s: 'cite', t: 'seed' }, { s: 'seed', t: 'ref' }, { s: 'linked', t: 'ref' }], 'seed');
    CG.nodes.forEach((n, i) => { n.x = 240 + i * 240; n.y = 350; });
    CG.scale = 1; CG.tx = 0; CG.ty = 0; CG._applyTransform();
    CG._renderPositions(); CG._paint();
    if (CG._layoutLabels) CG._layoutLabels();
    await document.fonts.ready;
  });
  await frame(page);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await fixture(page);
    for (const id of ['cite', 'ref', 'linked', 'seed']) {
      const p = await point(page, id);
      await page.mouse.move(p.x, p.y); await page.mouse.down();
      await page.mouse.move(p.x + 1, p.y + 1); await page.mouse.up(); await frame(page);
      assert.equal(await page.evaluate(() => CG.selected), id, id + ' must select despite one-pixel pointer jitter');
      const after = await point(page, id);
      assert.equal(after.wx, p.wx, 'a click must not move the node'); assert.equal(after.wy, p.wy);
      await page.evaluate(() => CG.select(null));
    }
    console.log('PASS: seed, citing, reference and co-cited papers select with small pointer movements');
    // Actual drags keep the grab offset and must not open a paper.
    const start = await point(page, 'cite');
    await page.mouse.move(start.x + 3, start.y + 2); await page.mouse.down();
    await page.mouse.move(start.x + 28, start.y + 17); await page.mouse.up(); await frame(page);
    const end = await point(page, 'cite');
    assert(Math.abs(end.wx - start.wx - 25) < 0.01); assert(Math.abs(end.wy - start.wy - 15) < 0.01);
    assert.equal(await page.evaluate(() => CG.selected), null);
    console.log('PASS: real dragging preserves the grab offset without selecting');

    await page.evaluate(() => {
      document.getElementById('seed-title').textContent = 'A long seed heading above the graph should not block paper selection';
      CG.nodeById.cite.x = 200; CG.nodeById.cite.y = 45;
      CG._invalidate({ positions: true, paint: true, labels: true });
    }); await frame(page);
    const underHeading = await point(page, 'cite'); await page.mouse.click(underHeading.x, underHeading.y); await frame(page);
    assert.equal(await page.evaluate(() => CG.selected), 'cite', 'the static seed heading must not intercept graph clicks');
    await page.evaluate(() => { CG.nodeById.cite.x = 480; CG.nodeById.cite.y = 350; });
    console.log('PASS: the static seed banner does not intercept clicks on papers');

    await page.evaluate(() => { CG.scale = 0.25; CG.tx = 250; CG.ty = 180; CG._applyTransform(); CG._invalidate({ positions: true, paint: true, labels: true }); });
    await frame(page);
    const small = await point(page, 'cite'); assert(small.radius < 5);
    await page.mouse.click(small.x + 8, small.y); await frame(page);
    assert.equal(await page.evaluate(() => CG.selected), 'cite', 'small citing papers need a usable click area at low zoom');
    await page.evaluate(() => { CG.select(null); CG.hovered = CG.nodeById.cite; CG._invalidate(); }); await frame(page);
    const label = await page.locator('.gnode[data-id="cite"] .glabel').first().boundingBox();
    assert(label); await page.mouse.click(label.x + 5, label.y + label.height / 2); await frame(page);
    assert.equal(await page.evaluate(() => CG.selected), 'cite', 'paper labels must also select their paper');
    console.log('PASS: small circles and their labels are clickable when zoomed out');

    // An expanded target may overlap another circle; the visible circle wins.
    await page.evaluate(() => {
      CG.select(null); CG.hovered = null;
      CG.nodeById.ref.x = CG.nodeById.cite.x + 28; CG.nodeById.ref.y = CG.nodeById.cite.y;
      CG._invalidate({ positions: true, paint: true, labels: true });
    }); await frame(page);
    const visible = await point(page, 'ref'); await page.mouse.click(visible.x, visible.y); await frame(page);
    assert.equal(await page.evaluate(() => CG.selected), 'ref', 'expanded targets must not steal clicks on visible nodes');
    await page.evaluate(() => { CG.select(null); CG.setFilter({ showCites: false }); }); await frame(page);
    assert.equal(await page.locator('.node-hit-target[data-paper-id="cite"]').evaluate(el => getComputedStyle(el).display), 'none');
    console.log('PASS: visible papers win over nearby expanded targets; filters hide targets');

    // Cancellation must release drag state without opening a detail panel.
    const cancelPoint = await point(page, 'linked');
    await page.mouse.move(cancelPoint.x, cancelPoint.y); await page.mouse.down();
    await page.evaluate(() => CG.svg.dispatchEvent(new PointerEvent('pointercancel', { pointerId: CG._pointerId, bubbles: true })));
    await page.mouse.up();
    assert.equal(await page.evaluate(() => CG.selected), null);
    assert.equal(await page.evaluate(() => CG.dragNode), null);
    const keyboardNode = page.locator('.gnode[data-id="ref"]'); await keyboardNode.focus(); await page.keyboard.press('Enter'); await frame(page);
    assert.equal(await page.evaluate(() => CG.selected), 'ref');
    console.log('PASS: cancellation clears capture; keyboard selection still works');

    const touchPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    await fixture(touchPage);
    for (const id of ['cite', 'ref', 'linked']) { const p = await point(touchPage, id); await touchPage.touchscreen.tap(p.x, p.y); await frame(touchPage); assert.equal(await touchPage.evaluate(() => CG.selected), id); }
    console.log('PASS: touch taps select all three paper types');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
