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
  api.flushCache(); // pagehide flushes batched writes before a document switch.
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

test('exact Unicode titles beat longer titles; short scientific terms and whole words matter', async () => {
  const items = ['AI in catalysis: a review', 'Chair designs for catalysis', 'AI in catalysis', 'Étude du café'].map((title,i)=>({...raw('W'+i),display_name:title}));
  const api = client(async()=>ok({results:items}));
  assert.equal((await api.search('AI in catalysis'))[0].id,'W2');
  assert.equal((await api.search('Étude du café'))[0].id,'W3');
  const results = await api.search('AI');
  assert(results.findIndex(p=>p.id==='W0')<results.findIndex(p=>p.id==='W1'));
});

test('fast results appear before the slower source and survive its failure', async () => {
  let fail;
  const slow = new Promise((_,reject)=>{fail=reject;});
  const updates=[];
  const api=client(async url=>url.includes('search.title=')?ok({results:[{...raw('W1'),display_name:'Catalysis'}]}):slow);
  const pending=api.searchPage('Catalysis',{onUpdate:r=>updates.push(r)});
  await new Promise(r=>setTimeout(r,5));
  assert.equal(updates[0].results[0].id,'W1');
  fail(new Error('network failed'));
  const result=await pending;assert(result.partial);assert.equal(result.results.length,1);
});

test('author search resolves identities and retrieves papers by author ID with years and pagination', async () => {
  const urls=[];
  const api=client(async url=>{
    urls.push(new URL(url));
    return url.includes('/authors?')?ok({meta:{count:1},results:[{id:'https://openalex.org/A1',display_name:'Jane Doe',last_known_institutions:[{display_name:'University'}],works_count:30}]}):ok({meta:{count:60},results:[raw('W1')]});
  });
  const authors=await api.searchAuthors('Jane Doe');assert.equal(authors.results[0].institution,'University');
  const works=await api.searchPage('Jane Doe',{authorId:'A1',yearFrom:'2020',yearTo:'2025',page:2});
  assert(works.hasMore);assert.equal(urls[1].searchParams.get('page'),'2');
  assert.equal(urls[1].searchParams.get('filter'),'from_publication_date:2020-01-01,to_publication_date:2025-12-31,authorships.author.id:A1');
  assert.equal(urls[1].searchParams.get('search'),null);
});

test('weak searches recover spelling alternatives, but exact matches do not add requests', async () => {
  const urls=[];
  const api=client(async url=>{urls.push(new URL(url));return ok({results:url.includes('~1')?[{...raw('W1'),display_name:'Catalysis'}]:[]});});
  const result=await api.searchPage('catalyssi');assert(result.fuzzy);assert.equal(result.results[0].id,'W1');assert.equal(urls.length,3);
});

test('DOI lookup stays exact, handles missing records, and does not hide network failures', async () => {
  let calls=0;
  const api=client(async url=>{calls++;assert(url.includes('/works/https://doi.org/10.1000%2Ftest'));return ok(raw('W1'));});
  assert.equal((await api.search('https://doi.org/10.1000/test'))[0].id,'W1');assert.equal(calls,1);
  const missing=client(async()=>({ok:false,status:404}));assert.equal((await missing.search('10.1000/missing')).length,0);
  const broken=client(async()=>{throw new Error('offline');});await assert.rejects(broken.search('10.1000/missing'),/offline/);
});


test('response cache batches writes and limits the saved payload', async () => {
  let writes=0; const values=new Map();
  const saved={get:k=>values.get(k),set:(k,v)=>{writes++;values.set(k,v);}};
  const api=client(async url=>ok({...raw(url.includes('W2')?'W2':'W1'),display_name:'x'.repeat(100000)}),saved);
  await api.byId('W1'); await api.byId('W2');
  assert.equal(writes,0,'successful responses do not synchronously write storage');
  api.flushCache(); assert.equal(writes,1);api.flushCache();assert.equal(writes,1);
  assert([...values.values()].every(v=>v.length<500100));
});


test('paper ordering reaches the API and preserves merged ordering and missing years', async()=>{
 const urls=[];
 const api=client(async url=>{urls.push(new URL(url));return ok({results:[{...raw('W1'),publication_year:2000,cited_by_count:90},{...raw('W2'),publication_year:2025,cited_by_count:10},{...raw('W3'),publication_year:null,cited_by_count:3}]});});
 for(const [sort,expected,param] of [['newest',['W2','W1','W3'],'publication_date:desc'],['oldest',['W1','W2','W3'],'publication_date:asc'],['citations',['W1','W2','W3'],'cited_by_count:desc']]) {
   const result=await api.searchPage('Paper',{sort,page:2});
   assert.deepEqual(Array.from(result.results,p=>p.id),expected);
   assert(urls.slice(-2).every(u=>u.searchParams.get('sort')===param&&u.searchParams.get('page')==='2'));
 }
});
