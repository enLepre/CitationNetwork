const { chooseOption } = require('./dropdown-helper.cjs');
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const papers = [
  { id: 'W1', title: 'Catalysis with light', authors: 'José García', venue: 'Chemistry Journal', year: 2024, doi: '10.1234/light', role: 'seed', type: 'article', cites: 30 },
  { id: 'W2', title: 'Thermal catalysis', authors: 'Alice Smith', venue: 'Energy Letters', year: 2022, doi: '10.1234/heat', role: 'ref', type: 'article', cites: 10 },
  { id: 'W3', title: 'Light and energy', authors: 'Alice Smith', venue: 'Physics Reports', year: 2025, doi: '10.1234/energy', role: 'cite', type: 'review', cites: 50 }
];
const network = { seedId: 'W1', papers, edges: [], refShown: 1, citingShown: 1, citingTotal: 1, linkedShown: 0, adaptive: true };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/assets/openalex.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.OpenAlex = { cachedNetwork: async () => (' + JSON.stringify(network) + ') };' }));
    await page.goto('http://127.0.0.1:' + server.address().port + '/list.html?seed=W1');
    await page.waitForFunction(() => window.CitationPage?.ready);
    const input = page.locator('#list-search');
    const ids = () => page.locator('#papers-body tr[data-id]').evaluateAll(rows => rows.map(row => row.dataset.id).sort());
    assert.deepEqual(await ids(), ['W1','W2','W3']);
    for (const query of ['GARCIA', 'jose 2024', 'Chemistry Journal', '10.1234/light']) {
      await input.fill(query); assert.deepEqual(await ids(), ['W1'], query);
    }
    await input.fill('alice'); assert.deepEqual(await ids(), ['W2','W3']);
    await chooseOption(page, '#role-filter', 'ref'); assert.deepEqual(await ids(), ['W2']);
    await chooseOption(page, '#type-filter', 'review'); assert.deepEqual(await ids(), []);
    assert.match(await page.locator('#papers-body').innerText(), /No papers match/);
    assert(await page.locator('#export-bib').isDisabled());
    await chooseOption(page, '#type-filter', '');
    await chooseOption(page, '#role-filter', '');
    await page.locator('[data-sort=year]').click(); assert.deepEqual(await ids(), ['W2','W3']);
    assert.match(await page.locator('#list-seed').innerText(), /2 of 3 papers/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-bib').click();
    const download = await downloadPromise;
    const bib = fs.readFileSync(await download.path(), 'utf8');
    assert(bib.includes('Thermal catalysis') && bib.includes('Light and energy') && !bib.includes('Catalysis with light'));
    await page.locator('#list-search-clear').click(); assert.deepEqual(await ids(), ['W1','W2','W3']);
    assert(await input.evaluate(el => el === document.activeElement));
    await input.fill('   '); assert.deepEqual(await ids(), ['W1','W2','W3']);
    await input.fill('<script>'); assert.deepEqual(await ids(), []);
    await page.setViewportSize({ width: 390, height: 800 });
    const box = await input.boundingBox(); assert(box.x >= 0 && box.x + box.width <= 390);
    assert.deepEqual(errors, []);
    console.log('PASS: list search fields, accents/case, combined filters, sorting, empty state, filtered export, clearing and mobile width');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
