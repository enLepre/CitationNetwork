const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('assets/openalex.js', 'utf8');
function client(fetch, saved = new Map()) {
  const context = { window: {}, fetch, AbortController, setTimeout, clearTimeout,
    sessionStorage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) } };
  vm.createContext(context); vm.runInContext(source, context);
  return context.window.OpenAlex;
}
const raw = (id, refs = []) => ({ id: 'https://openalex.org/' + id, display_name: 'Paper ' + id,
  referenced_works: refs.map(r => 'https://openalex.org/' + r), publication_year: 2025 });
const ok = data => ({ ok: true, status: 200, json: async () => data });

test('search is lightweight; selecting a result still loads its references', async () => {
  const urls = [];
  const api = client(async url => {
    urls.push(new URL(url));
    if (url.includes('/works/W1?')) return ok(raw('W1', ['W2']));
    const hit = raw('W1'); delete hit.referenced_works;
    return ok({ results: [hit] });
  });
  const [hit] = await api.search('Paper W1');
  assert.equal(hit.refsLoaded, false);
  assert.equal(urls.length, 2);
  for (const url of urls) assert(!/abstract|referenced_works/.test(url.searchParams.get('select')));
  const seed = await api.byId(hit.id);
  assert.equal(seed.refsLoaded, true); assert.deepEqual([...seed.refs], ['W2']);
});

test('reference records and repeated queries use caches, including across reload', async () => {
  let calls = 0; const saved = new Map();
  const fetch = async () => { calls++; return ok({ results: [raw('W1'), raw('W2')] }); };
  const api = client(fetch, saved);
  await api.fetchByIds(['W1', 'W2']); await api.fetchByIds(['W2']);
  assert.equal(calls, 1);
  await client(fetch, saved).fetchByIds(['W1', 'W2']);
  assert.equal(calls, 1);
});

test('the direct graph paints before optional co-cited lookup; enrichment can fail safely', async () => {
  let painted = false;
  const api = client(async url => {
    if (url.includes('cites:')) return ok({ results: [], meta: { count: 0 } });
    if (url.includes('Wextra')) { assert(painted); throw new Error('Optional request failed'); }
    return ok({ results: ['W1', 'W2', 'W3'].map(id => raw(id, ['Wextra'])) });
  });
  const seed = api.toPaper(raw('Wseed', ['W1', 'W2', 'W3']));
  const net = await api.buildNetwork(seed, { onDirect: direct => { painted = true; assert.equal(direct.papers.length, 4); } });
  assert(painted); assert(net.enrichmentFailed); assert.equal(net.papers.length, 4);
});

test('120 density paginates and returns the requested number without duplicates', async () => {
  const pages = [];
  const api = client(async url => {
    const u = new URL(url), page = +u.searchParams.get('page'), per = +u.searchParams.get('per-page');
    pages.push(page); assert(per <= 100);
    return ok({ meta: { count: 300 }, results: Array.from({ length: per }, (_, i) => raw('W' + ((page - 1) * per + i))) });
  });
  const result = await api.citing('Wseed', 120);
  assert.equal(result.papers.length, 120); assert.equal(new Set(result.papers.map(p => p.id)).size, 120);
  assert.deepEqual(pages, [1, 2]);
});

test('cancelled search aborts both underlying requests and cannot return stale results', async () => {
  let aborted = 0;
  const api = client((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(signal.reason); });
  }));
  const controller = new AbortController();
  const pending = api.search('old query', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(aborted, 2);
});

test('transient rate limiting retries; cancellation interrupts a retry delay', async () => {
  let calls = 0;
  const api = client(async () => ++calls === 1
    ? { ok: false, status: 429, headers: { get: () => '0.25' } } : ok(raw('W1')));
  assert.equal((await api.byId('W1')).id, 'W1'); assert.equal(calls, 2);
  const controller = new AbortController();
  const limited = client(async () => ({ ok: false, status: 429, headers: { get: () => '5' } }));
  const pending = limited.byId('W2', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
});
