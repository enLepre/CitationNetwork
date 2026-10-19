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

test('keyword abstracts use bounded batches, cache results, and resolve unavailable abstracts', async () => {
  let calls=0,active=0,peak=0;
  const api=client(async url=>{
    calls++; active++; peak=Math.max(peak,active);
    const u=new URL(url); assert.equal(u.searchParams.get('select'),'id,abstract_inverted_index');
    const ids=u.searchParams.get('filter').slice(12).split('|'); assert(ids.length<=50);
    await new Promise(r=>setTimeout(r,5)); active--;
    return ok({results:ids.map(id=>({id:'https://openalex.org/'+id,abstract_inverted_index:id==='W0'?null:{Quantum:[0],catalysis:[1]}}))});
  });
  const papers=Array.from({length:201},(_,i)=>api.toPaper(raw('W'+i)));
  await api.abstractsFor(papers);
  assert.equal(calls,5); assert(peak<=3); assert.equal(papers[1].abstract,'Quantum catalysis');
  assert.equal(papers[0].abstract,'No abstract available from OpenAlex.');
  await api.abstractsFor(papers); assert.equal(calls,5);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(api.abstractsFor([{id:'Wnew',abstract:null}],{signal:controller.signal}),{name:'AbortError'});
});

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

function adaptiveFixture(count, tied = false) {
  const records = Array.from({length:count}, (_,i) => ({...raw('W'+i, ['Wseed']), cited_by_count:tied ? 10 : count-i, publication_year:2000+i%26}));
  const urls=[];
  const api=client(async url=>{
    const u=new URL(url);urls.push(u);
    const filter=u.searchParams.get('filter')||'';
    let rows=records.slice();
    const low=filter.match(/cited_by_count:>(-?\d+)/), high=filter.match(/cited_by_count:<(\d+)/);
    if(low) rows=rows.filter(p=>p.cited_by_count>Number(low[1]));
    if(high) rows=rows.filter(p=>p.cited_by_count<Number(high[1]));
    if(u.searchParams.get('sort')==='publication_date:desc') rows.sort((a,b)=>b.publication_year-a.publication_year);
    const size=Number(u.searchParams.get('per-page')||100),offset=(Number(u.searchParams.get('page')||1)-1)*size;
    return ok({meta:{count:rows.length,next_cursor:offset+size<rows.length?String(offset+size):null},results:rows.slice(offset,offset+size)});
  });
  const seed=api.toPaper({...raw('Wseed'),cited_by_count:count});
  return {api,seed,urls};
}

test('adaptive loading uses authoritative totals, complete small graphs and a stable rank threshold',async()=>{
  for(const [total,budget,minimum] of [[0,0,0],[160,160,0],[300,300,0],[301,250,52],[2000,250,1751],[2001,300,1702],[13000,300,12701]]) {
    const {api,seed}=adaptiveFixture(total);seed.cites=1; // selection uses API total, not stale seed metadata
    const net=await api.buildNetwork(seed,{adaptive:true,minShared:99999});
    assert.equal(net.citingTotal,total);assert.equal(net.citingShown,budget);
    assert.equal(net.initialMin,minimum);assert.equal(net.citingIds.length,budget);
    assert.equal(net.papers.length,budget+1);
  }
});

test('expansion queries the selected inclusive range, batches results and exhausts tied counts without duplicates',async()=>{
  const {api,seed,urls}=adaptiveFixture(600);
  let net=await api.buildNetwork(seed,{adaptive:true,minShared:99999});
  assert.equal(net.initialMin,351);
  const original=net.papers.length;
  for(let i=0;i<8;i++) {
    const before=net.papers.length;net=await api.expandNetwork(net,20,240);
    assert(net.papers.length-before<=100);
    assert.equal(new Set(net.papers.map(p=>p.id)).size,net.papers.length);
    if(net.expansion.done)break;
  }
  assert(net.expansion.done);assert.equal(net.expansion.total,221);
  assert.equal(net.papers.length,original+221);assert.equal(net.initialMin,351);
  assert(net.papers.slice(original).every(p=>p.cites>=20&&p.cites<=240));
  assert(urls.some(u=>u.searchParams.get('filter').includes('cited_by_count:>19,cited_by_count:<241')));
  assert(urls.some(u=>u.searchParams.get('sort')==='publication_date:desc'));
  const next=await api.expandNetwork(net,0,10);
  assert.equal(next.expansion.total,10);assert(next.expansion.done);
  assert.equal(net.expansion.total,221,'changing range must not mutate previous state');
});

test('cluster ranking excludes the universal seed reference and reserves recent isolated candidates',()=>{
  const {api}=adaptiveFixture(0);
  const isolated=Array.from({length:120},(_,i)=>({id:'I'+i,year:2026,refs:['Wseed']}));
  const cluster=Array.from({length:40},(_,i)=>({id:'C'+i,year:2000,refs:['Wseed','shared-a','shared-b']}));
  const ranked=api.rankExpansion([...isolated,...cluster],[], 'Wseed',100);
  assert.equal(ranked.length,100);assert.equal(new Set(ranked.map(p=>p.id)).size,100);
  assert(ranked.slice(0,40).every(p=>p.id.startsWith('C')));
  assert(ranked.slice(80).every(p=>p.year===2026));
  const noSeed=api.rankExpansion([...isolated,...cluster].map(p=>({...p,refs:p.refs.filter(r=>r!=='Wseed')})),[],'Wseed',100);
  assert.deepEqual(ranked.map(p=>p.id),noSeed.map(p=>p.id));
});

test('aborted expansion leaves the existing graph intact',async()=>{
  const {api,seed}=adaptiveFixture(400);
  const net=await api.buildNetwork(seed,{adaptive:true,minShared:99999});
  const snapshot=JSON.stringify(net),controller=new AbortController();controller.abort();
  await assert.rejects(api.expandNetwork(net,0,null,{signal:controller.signal}));
  assert.equal(JSON.stringify(net),snapshot);
});


test('tied citation counts remain loadable beyond the adaptive budget',async()=>{
 const {api,seed}=adaptiveFixture(600,true);
 let net=await api.buildNetwork(seed,{adaptive:true,minShared:99999});
 assert.equal(net.initialMin,10);assert.equal(net.citingShown,250);
 for(let i=0;i<20;i++){net=await api.expandNetwork(net,10,10);if(net.expansion.done)break;}
 assert(net.expansion.done);assert.equal(net.citingIds.length,600);
 assert.equal(new Set(net.papers.map(p=>p.id)).size,601);
});

test('failed expansion preserves papers and pagination for a retry',async()=>{
 const {api,seed}=adaptiveFixture(400);
 const net=await api.buildNetwork(seed,{adaptive:true,minShared:99999}),snapshot=JSON.stringify(net);
 const failing=client(async()=>({ok:false,status:403,json:async()=>({error:'unavailable'})}));
 await assert.rejects(failing.expandNetwork(net,0,100));
 assert.equal(JSON.stringify(net),snapshot);
 const retried=await api.expandNetwork(net,0,100);
 assert(retried.papers.length>net.papers.length);
});

test('large keyless graphs build when OpenAlex rejects cursor pagination',async()=>{
 const calls=[];
 const api=client(async url=>{
  const u=new URL(url);calls.push(u);
  if(u.searchParams.has('cursor') && u.searchParams.get('cursor')!=='*')return {ok:false,status:401};
  const page=Number(u.searchParams.get('page')||1);
  return ok({meta:{count:13000,next_cursor:'next-page'},results:Array.from({length:100},(_,i)=>({...raw('W'+((page-1)*100+i),['Wseed']),cited_by_count:13000-(page-1)*100-i}))});
 });
 const net=await api.buildNetwork(api.toPaper(raw('Wseed')),{adaptive:true});
 assert.equal(net.citingShown,300);
 assert.equal(net.citingTotal,13000);
 assert.equal(calls.length,3);
 assert(calls.every(u=>!u.searchParams.has('cursor')));
});

test('a failed later citing page preserves the initial graph and reports partial loading',async()=>{
 const api=client(async url=>{
  const page=Number(new URL(url).searchParams.get('page')||1);
  if(page>1)return {ok:false,status:403};
  return ok({meta:{count:13000,next_cursor:'next'},results:Array.from({length:100},(_,i)=>({...raw('W'+i,['Wseed']),cited_by_count:13000-i}))});
 });
 const net=await api.buildNetwork(api.toPaper(raw('Wseed')),{adaptive:true});
 assert.equal(net.citingShown,100);
 assert.equal(net.papers.length,101);
 assert.match(net.loadWarning,/could not be loaded/);
 await api.saveNetwork(net,0);
 assert.equal(await api.cachedNetwork('Wseed',0),null);
});

test('numbered paging stops clearly at the API boundary rather than claiming exhaustion',async()=>{
 let calls=0;const api=client(async()=>{calls++;return ok({});});
 await assert.rejects(api.citingPage('Wseed',{cursor:'page:101'}),/Narrow the citation range/);
 assert.equal(calls,0);
});
