/* ============================================================
   OpenAlex live data layer
   Free, key-less, CORS-enabled scholarly graph (a merged catalog
   of Crossref, MAG, PubMed, DOAJ & more). Docs: docs.openalex.org
   Edge {s,t} means paper s cites paper t.
   ============================================================ */
window.OpenAlex = (function () {
  const API = "https://api.openalex.org";
  const paperCache = new Map();
  const responseCache = new Map();
  const inFlight = new Map();
  const TTL = 15 * 60 * 1000;
  const STORAGE_KEY = 'citation-network-cache-v1';
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    saved.filter(([, e]) => Date.now() - e.time < TTL).forEach(([k, e]) => responseCache.set(k, e));
  } catch (error) { /* Storage may be unavailable or full. */ }
  const serializedCache = new Map();
  let cacheTimer = null, cacheIdle = null;
  const oversizedCache = new Set();
  const dirtyCache = new Set();
  function flushCache() {
    clearTimeout(cacheTimer); cacheTimer = null;
    if(cacheIdle != null) { window.cancelIdleCallback?.(cacheIdle); cacheIdle=null; }
    if (!dirtyCache.size) return;
    try {
      for (const key of dirtyCache) {
        const entry = responseCache.get(key);
        if (!entry || entry.persist === false) continue;
        const value = JSON.stringify([key, entry]);
        if (value.length < 150000) { serializedCache.set(key, value); oversizedCache.delete(key); }
        else { serializedCache.delete(key); oversizedCache.add(key); }
      }
      dirtyCache.clear();
      // Bound synchronous fallback storage to 500 KB, including restored entries.
      let size=0; const small=[];
      for (const [key,entry] of [...responseCache].reverse()) {
        if (Date.now()-entry.time >= TTL || oversizedCache.has(key) || entry.persist === false) continue;
        let value=serializedCache.get(key);
        if (!value) { value=JSON.stringify([key,entry]); if(value.length>=150000) { oversizedCache.add(key); continue; } serializedCache.set(key,value); }
        if (size+value.length > 500000 || small.length>=30) break;
        size+=value.length; small.push(value);
      }
      for(const key of serializedCache.keys()) if(!responseCache.has(key)) serializedCache.delete(key);
      for(const key of oversizedCache) if(!responseCache.has(key)) oversizedCache.delete(key);
      sessionStorage.setItem(STORAGE_KEY, '['+small.reverse().join(',')+']');
    } catch (_) { /* Memory caching remains available when storage is full. */ }
  }
  function persistCache(key) {
    dirtyCache.add(key);
    if (cacheTimer == null && cacheIdle == null) cacheTimer=setTimeout(()=>{
      cacheTimer=null;
      if(window.requestIdleCallback) cacheIdle=window.requestIdleCallback(()=>{cacheIdle=null;flushCache();},{timeout:2000});
      else flushCache();
    }, 600);
  }
  window.addEventListener?.('pagehide', flushCache);

  // Large assembled networks use asynchronous storage; keep only three recent ones.
  let database;
  const memoryNetworks = new Map();
  function openDatabase() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!database) database=new Promise(resolve=>{
      let request;
      try { request=indexedDB.open('citation-workspace-v1',1); } catch (_) { resolve(null); return; }
      request.onupgradeneeded=()=>request.result.createObjectStore('networks',{keyPath:'key'});
      request.onsuccess=()=>resolve(request.result);
      request.onerror=request.onblocked=()=>resolve(null);
    });
    return database;
  }
  async function cachedNetwork(seedId, density) {
    const key='adaptive-v2:'+seedId+':'+density;
    let entry=memoryNetworks.get(key);
    if (!entry) {
      const db=await openDatabase();
      if (db) entry=await new Promise(resolve=>{
        try { const request=db.transaction('networks').objectStore('networks').get(key);
          request.onsuccess=()=>resolve(request.result); request.onerror=()=>resolve(null);
        } catch (_) { resolve(null); }
      });
    }
    return entry && Date.now()-entry.time<TTL ? entry.network : null;
  }
  async function saveNetwork(network, density) {
    if (network.enrichmentFailed || network.loadWarning) return;
    const entry={key:'adaptive-v2:'+network.seedId+':'+density,time:Date.now(),network};
    memoryNetworks.set(entry.key,entry);
    if(memoryNetworks.size>3) memoryNetworks.delete(memoryNetworks.keys().next().value);
    const db=await openDatabase(); if(!db) return;
    await new Promise(resolve=>{
      try {
        const tx=db.transaction('networks','readwrite'), store=tx.objectStore('networks');
        store.put(entry);
        const all=store.getAll();
        all.onsuccess=()=>all.result.sort((a,b)=>b.time-a.time).forEach((e,i)=>{if(i>=3||Date.now()-e.time>=TTL)store.delete(e.key);});
        tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();
      } catch (_) { resolve(); }
    });
  }
  const abort = signal => { if (signal) signal.throwIfAborted(); };
  const isAbort = error => error.name === 'AbortError';
  // Full record (with abstract) — only for the seed / search results, which are
  // few. The bulk fetches (citing, references, co-cited) use the LITE select,
  // which omits the heavyweight abstract_inverted_index; abstracts are fetched
  // one paper at a time, on demand, when a node is opened.
  const SELECT = "id,display_name,publication_year,cited_by_count,authorships,primary_location,referenced_works,abstract_inverted_index,type,doi";
  const SELECT_SEARCH = "id,display_name,publication_year,cited_by_count,authorships,primary_location,type,doi";
  const SELECT_LITE = "id,display_name,publication_year,cited_by_count,authorships,primary_location,referenced_works,type,doi";

  const shortId = u => (u || "").replace("https://openalex.org/", "");
  const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const lastName = name => {
    if (!name) return "Unknown";
    const p = name.trim().split(/\s+/);
    return p[p.length - 1];
  };

  function abstractFromInverted(inv) {
    if (!inv) return "";
    const words = []; let max = 0;
    for (const k in inv) for (const pos of inv[k]) { words[pos] = k; if (pos > max) max = pos; }
    return words.slice(0, max + 1).join(" ").replace(/\s+/g, " ").trim();
  }

  function toPaper(w) {
    const names = (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean);
    const n = names.length;
    const lead = n ? lastName(names[0]) : "Unknown";
    const short = n > 1 ? `${lead} et al.` : (lead || "Unknown");
    const authors = n <= 6 ? names.join(", ") : names.slice(0, 6).join(", ") + ", et al.";
    const src = (w.primary_location && w.primary_location.source) || null;
    const venue = (src && src.display_name)
      || (w.type === "preprint" ? "Preprint" : (w.type ? cap(w.type) : "Unpublished"));
    const p = {
      id: shortId(w.id),
      title: w.display_name || "Untitled",
      authors: authors || "Unknown authors",
      searchAuthors: names.join(", "),
      short,
      year: w.publication_year || "—",
      venue,
      type: w.type ? cap(w.type.replace(/-/g, " ")) : "Article",
      sourceId: src ? shortId(src.id) : null,
      journalIF: null,
      cites: w.cited_by_count || 0,
      // null = not loaded yet (lite fetch). A string (incl. the fallback) means
      // the abstract field was present and resolved.
      abstract: ("abstract_inverted_index" in w)
        ? (abstractFromInverted(w.abstract_inverted_index) || "No abstract available from OpenAlex.")
        : null,
      refs: (w.referenced_works || []).map(shortId),
      refsLoaded: "referenced_works" in w,
      doi: w.doi || null,
      // Best public link: publisher landing page → DOI → OpenAlex record.
      url: (w.primary_location && w.primary_location.landing_page_url)
        || w.doi
        || w.id
        || null
    };
    const old = paperCache.get(p.id);
    if (old && old.expires > Date.now()) {
      if (!p.refsLoaded && old.paper.refsLoaded) { p.refs = old.paper.refs; p.refsLoaded = true; }
      if (p.abstract == null) p.abstract = old.paper.abstract;
    }
    paperCache.set(p.id, { paper: p, expires: Date.now() + TTL });
    if (paperCache.size > 1500) paperCache.delete(paperCache.keys().next().value);
    return p;
  }

  async function getJSON(url, { signal } = {}) {
    abort(signal);
    const cached = responseCache.get(url);
    if (cached && Date.now() - cached.time < TTL) return cached.data;
    if (!signal && inFlight.has(url)) return inFlight.get(url);
    const request = (async () => {
      for (let attempt = 0; ; attempt++) {
        abort(signal);
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(() => controller.abort(new Error('OpenAlex request timed out. Please retry.')), 15000);
        let r, data;
        try {
          r = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (r.ok) data = await r.json();
        }
        finally { clearTimeout(timeout); if (signal) signal.removeEventListener('abort', cancel); }
        if ((r.status === 429 || r.status === 503) && attempt < 2) {
          const delay = Math.min(5000, Math.max(250, Number(r.headers.get('Retry-After')) * 1000 || 500 * 2 ** attempt));
          await new Promise((resolve, reject) => {
            const cancelWait = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', cancelWait); resolve(); }, delay);
            if (signal) signal.addEventListener('abort', cancelWait, { once: true });
            if (signal && signal.aborted) cancelWait();
          });
          continue;
        }
        if (!r.ok) { const error = new Error('OpenAlex request failed (' + r.status + ')'); error.status = r.status; throw error; }
        abort(signal);
        // Complete networks are stored asynchronously in IndexedDB. Do not
        // stringify megabytes of bulk reference/abstract records on the UI thread.
        const persist = !(data.results?.length > 20 && /referenced_works|abstract_inverted_index/.test(url));
        responseCache.set(url, { data, time: Date.now(), persist });
        if (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
        persistCache(url);
        return data;
      }
    })();
    if (!signal) inFlight.set(url, request);
    try { return await request; } finally { if (!signal) inFlight.delete(url); }
  }

  // Pull a DOI out of free text — bare (10.1021/jacs.5c12957) or as a
  // doi.org / dx.doi.org URL. Trailing punctuation is trimmed.
  const DOI_RE = /10\.\d{4,9}\/[^\s"<>]+/i;
  function doiFromQuery(q) {
    const m = (q || "").match(DOI_RE);
    return m ? m[0].toLowerCase().replace(/[).,;]+$/, "") : null;
  }

  // Resolve a work straight from its OpenAlex id (e.g. "W2766852927"). Used to
  // rebuild a shared graph from a link — the seed id is all we need to
  // regenerate the identical neighborhood live.
  async function byId(id, options = {}) {
    if (!id) return null;
    const clean = shortId(id);
    abort(options.signal);
    const cached = paperCache.get(clean);
    if (cached && cached.expires > Date.now() && cached.paper.refsLoaded) return { ...cached.paper };
    const w = await getJSON(`${API}/works/${encodeURIComponent(clean)}?select=${SELECT}`, options);
    return (w && w.id) ? toPaper(w) : null;
  }

  const normalize = text => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  const stopWords = new Set(['a', 'an', 'the', 'of', 'and', 'in', 'on', 'for', 'to', 'with']);
  function queryWords(q) { return [...new Set(normalize(q).split(' ').filter(w => w && !stopWords.has(w)))]; }
  function titleScore(p, q) {
    const title = normalize(p.title), query = normalize(q);
    if (title === query) return 4;
    if (query && (' ' + title + ' ').includes(' ' + query + ' ')) return 3;
    const words = queryWords(q), tokens = new Set(queryWords(title));
    const overlap = words.filter(w => tokens.has(w)).length;
    const coverage = words.length ? overlap / words.length : 0;
    // Only promote strong title matches; broad topic results retain provider relevance.
    return coverage >= 0.6 ? coverage + overlap / Math.max(tokens.size, 1) : 0;
  }
  function rankByTitle(list, q) {
    return list.map((p, i) => ({ p, i, score: titleScore(p, q) }))
      .sort((a, b) => b.score - a.score || a.i - b.i).map(item => item.p);
  }
  function sortResults(rows, order) {
    if (!['newest','oldest','citations'].includes(order)) return rows;
    return rows.slice().sort((a,b)=>{
      if(order==='citations') return (b.cites||0)-(a.cites||0);
      const ay=Number(a.year),by=Number(b.year);
      if(!Number.isFinite(ay)) return Number.isFinite(by)?1:0;
      if(!Number.isFinite(by)) return -1;
      return order==='oldest'?ay-by:by-ay;
    });
  }
  const searchOrder = order => ({newest:'publication_date:desc',oldest:'publication_date:asc',citations:'cited_by_count:desc'}[order]);
  const paramsFor = params => Object.entries(params).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  function searchFilter(options) {
    const filters = [];
    if (options.yearFrom) filters.push(`from_publication_date:${options.yearFrom}-01-01`);
    if (options.yearTo) filters.push(`to_publication_date:${options.yearTo}-12-31`);
    if (options.authorId) filters.push(`authorships.author.id:${options.authorId}`);
    return filters.join(',');
  }
  async function searchAuthors(q, options = {}) {
    const page = options.page || 1;
    const data = await getJSON(`${API}/authors?${paramsFor({ search: q.trim(), 'per-page': 20, page, select: 'id,display_name,works_count,last_known_institutions,orcid' })}`, options);
    return { results: (data.results || []).map(a => ({ id: shortId(a.id), name: a.display_name, works: a.works_count, institution: (a.last_known_institutions || []).map(i => i.display_name).join(' · '), orcid: a.orcid })), hasMore: data.meta ? page * 20 < data.meta.count : (data.results || []).length === 20 };
  }
  async function searchPage(q, options = {}) {
    const term = q.trim(), page = options.page || 1, size = 25;
    if (!term && !options.authorId) return { results: [], hasMore: false };
    const doi = doiFromQuery(term);
    if (doi && !options.authorId) {
      // An identifier is an exact lookup, never a broad text query.
      const w = await getJSON(`${API}/works/https://doi.org/${encodeURIComponent(doi)}?select=${SELECT_SEARCH}`, options).catch(error => {
        if (error.status === 404) return null;
        throw error;
      });
      const paper = w?.id ? toPaper(w) : null;
      const matchesYear = paper && (!options.yearFrom || paper.year >= +options.yearFrom) && (!options.yearTo || paper.year <= +options.yearTo);
      return { results: matchesYear ? [paper] : [], hasMore: false, exact: true };
    }
    const common = { 'per-page': size, page, select: SELECT_SEARCH, filter: searchFilter(options), sort: searchOrder(options.sort) };
    if (options.authorId) {
      const data = await getJSON(`${API}/works?${paramsFor({ ...common, sort: searchOrder(options.sort) || 'publication_date:desc' })}`, options);
      return { results: (data.results || []).map(toPaper), hasMore: data.meta ? page * size < data.meta.count : (data.results || []).length === size };
    }
    const sources = options.mode === 'title' ? ['search.title'] : ['search.title', 'search'];
    const batches = new Map(), failures = [], more = new Map();
    function snapshot() {
      const unique = new Map();
      // Broad relevance breaks ties independently of which response arrived first.
      for (const source of ['search', 'search.title', 'fuzzy']) for (const paper of batches.get(source) || []) if (!unique.has(paper.id)) unique.set(paper.id, paper);
      return { results: searchOrder(options.sort) ? sortResults([...unique.values()],options.sort) : rankByTitle([...unique.values()], term), hasMore: [...more.values()].some(Boolean), partial: failures.length > 0, fuzzy: batches.has('fuzzy') };
    }
    await Promise.all(sources.map(async source => {
      try {
        const data = await getJSON(`${API}/works?${paramsFor({ ...common, [source]: term })}`, options);
        batches.set(source, (data.results || []).map(toPaper));
        more.set(source, data.meta ? page * size < data.meta.count : (data.results || []).length === size);
        abort(options.signal);
        options.onUpdate?.(snapshot());
      } catch (error) { if (isAbort(error) || options.signal?.aborted) throw error; failures.push(error); }
    }));
    if (!batches.size) throw failures[0];
    let result = snapshot();
    // Recover spelling variants only when no strong title match was found.
    const words = queryWords(term);
    if (!failures.length && words.length && words.length <= 12 && !result.results.some(p => titleScore(p, term) >= 1)) {
      try {
        const fuzzy = words.map(w => /^\p{L}{4,}$/u.test(w) ? w + '~1' : w).join(' ');
        if (fuzzy !== words.join(' ')) {
          const data = await getJSON(`${API}/works?${paramsFor({ ...common, 'search.title': fuzzy })}`, options);
          if (data.results?.length) {
            batches.set('fuzzy', data.results.map(toPaper));
            more.set('fuzzy', data.meta ? page * size < data.meta.count : data.results.length === size);
          }
          result = snapshot();
        }
      } catch (error) { if (isAbort(error) || options.signal?.aborted) throw error; }
    }
    abort(options.signal);
    return result;
  }
  async function search(q, options = {}) { return (await searchPage(q, options)).results; }
  async function resolveTop(q, options = {}) {
    const results = await search(q, options);
    if (!results.length) throw new Error('No matching paper found.');
    return results[0];
  }

  async function fetchByIds(ids, options = {}) {
    abort(options.signal);
    const out = [], missing = [];
    [...new Set(ids)].forEach(id => {
      const cached = paperCache.get(id);
      if (cached && cached.expires > Date.now() && cached.paper.refsLoaded) out.push({ ...cached.paper });
      else missing.push(id);
    });
    const chunks = [];
    for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const j = await getJSON(API + '/works?filter=openalex_id:' + chunk.join('|') + '&per-page=50&select=' + SELECT_LITE, options);
        out.push(...(j.results || []).map(toPaper));
      }
    }));
    const index = new Map(out.map(p => [p.id, p]));
    return [...new Set(ids)].map(id => index.get(id)).filter(Boolean);
  }

  // Lazily fetch a single paper's abstract (the field omitted from bulk fetches).
  // Keyword rebuilds request only IDs and abstracts, in bounded bulk batches.
  async function abstractsFor(papers, options = {}) {
    abort(options.signal);
    const missing = [];
    for (const paper of papers) {
      const cached = paperCache.get(paper.id);
      if (paper.abstract == null && cached?.expires > Date.now() && cached.paper.abstract != null) paper.abstract = cached.paper.abstract;
      if (paper.abstract == null) missing.push(paper);
    }
    let next = 0;
    const chunks = [];
    for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i,i+50));
    await Promise.all(Array.from({length:Math.min(3,chunks.length)},async () => {
      while (next < chunks.length) {
        abort(options.signal);
        const chunk = chunks[next++];
        const data = await getJSON(API + '/works?filter=openalex_id:' + chunk.map(p=>p.id).join('|') + '&per-page=50&select=id,abstract_inverted_index',options);
        abort(options.signal);
        if (!Array.isArray(data.results)) throw new Error('Abstract response unavailable.');
        const index = new Map(data.results.map(w=>[shortId(w.id),w]));
        for (const paper of chunk) {
          const record = index.get(paper.id);
          paper.abstract = abstractFromInverted(record?.abstract_inverted_index) || 'No abstract available from OpenAlex.';
          const cached = paperCache.get(paper.id);
          if (cached) cached.paper.abstract = paper.abstract;
        }
      }
    }));
  }

  async function abstractFor(id) {
    if (!id) return "";
    const cached = paperCache.get(id);
    if (cached && cached.expires > Date.now() && cached.paper.abstract != null) return cached.paper.abstract;
    const j = await getJSON(API + '/works/' + id + '?select=abstract_inverted_index');
    const text = abstractFromInverted(j.abstract_inverted_index) || 'No abstract available from OpenAlex.';
    if (cached) cached.paper.abstract = text;
    return text;
  }

  // Fetch journal impact factor (2-year mean citedness — the impact-factor
  // formula computed on OpenAlex's open data) for a set of source ids.
  const sourceCache = new Map();
  async function sourceImpact(ids, options = {}) {
    const out = {};
    const uniq = [...new Set(ids.filter(Boolean))].sort().filter(id=>{
      const cached=sourceCache.get(id);
      if(cached && Date.now()-cached.time<TTL){out[id]=cached.value;return false;}
      return true;
    });
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      if (!chunk.length) continue;
      try {
        const j = await getJSON(`${API}/sources?filter=openalex_id:${chunk.join("|")}&per-page=50&select=id,summary_stats`, options);
        (j.results || []).forEach(s => {
          const id=shortId(s.id), value=(s.summary_stats && s.summary_stats["2yr_mean_citedness"]) || 0;
          out[id]=value;sourceCache.set(id,{time:Date.now(),value});
        });
      } catch (e) { if (isAbort(e)) throw e; /* non-fatal: leave missing */ }
    }
    return out;
  }

  async function citing(seedId, limit, options = {}) {
    const papers = [];
    let total = 0;
    // Use pages of at most 100, including the 120-paper density option.
    for (let page = 1; papers.length < limit; page++) {
      const per = Math.min(100, limit);
      const j = await getJSON(API + '/works?filter=cites:' + seedId + '&sort=cited_by_count:desc&per-page=' + per + '&page=' + page + '&select=' + SELECT_LITE, options);
      total = (j.meta && j.meta.count) || 0;
      const batch = (j.results || []).map(toPaper);
      papers.push(...batch);
      if (batch.length < per || papers.length >= total) break;
    }
    return { total, papers: papers.slice(0, limit) };
  }

  function network(papers, seed, citeRes, refPapers, linkedShown = 0) {
    const ids = new Set(papers.map(p => p.id)), edges = [], seen = new Set();
    papers.forEach(p => (p.refs || []).forEach(t => {
      const key = p.id + '>' + t;
      if (t !== p.id && ids.has(t) && !seen.has(key)) { seen.add(key); edges.push({ s: p.id, t }); }
    }));
    return { papers, edges, seedId: seed.id, citingTotal: citeRes.total, citingShown: citeRes.papers.length,
      refTotal: seed.refs.length, refShown: refPapers.length, linkedShown };
  }

  function initialBudget(total) { return total <= 300 ? total : total <= 2000 ? 250 : 300; }

  async function citingPage(seedId, { min = 0, max = null, cursor = '*', recent = false, signal } = {}) {
    const filters = ['cites:' + seedId, 'cited_by_count:>' + (min - 1)];
    if (Number.isFinite(max)) filters.push('cited_by_count:<' + (max + 1));
    // Basic pagination is supported without a key for the first 10,000 results.
    const page = cursor === '*' ? 1 : Number(String(cursor).replace('page:', ''));
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('OpenAlex allows 10,000 results per range without authenticated cursor paging. Narrow the citation range to continue.');
    const query = paramsFor({ filter: filters.join(','), sort: recent ? 'publication_date:desc' : 'cited_by_count:desc',
      'per-page': 100, page, select: SELECT_LITE });
    const result = await getJSON(API + '/works?' + query, { signal });
    const papers = (result.results || []).map(toPaper), total = result.meta?.count || 0;
    return { papers, total, next: papers.length && page * 100 < total ? 'page:' + (page + 1) : null };
  }

  // Shared references beyond the seed provide a bibliographic-coupling signal.
  // Weight common references less and reserve 20% for recent candidates.
  function rankExpansion(candidates, loaded, seedId, limit = 100) {
    const known = new Set(loaded.map(p => p.id));
    const pool = [...new Map(candidates.filter(p => !known.has(p.id)).map(p => [p.id, p])).values()];
    const frequency = new Map(), loadedFrequency = new Map();
    const refs = p => [...new Set(p.refs || [])].filter(id => id !== seedId);
    for (const p of [...loaded, ...pool]) for (const id of refs(p)) frequency.set(id, (frequency.get(id) || 0) + 1);
    for (const p of loaded) for (const id of refs(p)) loadedFrequency.set(id, (loadedFrequency.get(id) || 0) + 1);
    const scored = pool.map(p => ({ p, refs: refs(p), score: refs(p).reduce((sum, id) => {
      const count = frequency.get(id) || 1;
      return sum + ((loadedFrequency.get(id) || 0) + Math.max(0, count - (loadedFrequency.get(id) || 0) - 1)) / Math.sqrt(count);
    }, 0) / Math.sqrt(Math.max(1, refs(p).length)) }));
    const selected = [], used = new Map();
    const recent = pool.slice().sort((a,b) => (b.year || 0) - (a.year || 0) || a.id.localeCompare(b.id));
    const recentIds = new Set(recent.slice(0, Math.min(Math.ceil(limit * .2), pool.length)).map(p => p.id));
    let remaining = scored.filter(item => !recentIds.has(item.p.id));
    while (selected.length < Math.floor(limit * .8) && remaining.length) {
      let best = 0, bestScore = -Infinity;
      remaining.forEach((item, i) => {
        const overlap = item.refs.reduce((sum,id) => sum + (used.get(id) || 0), 0) / Math.max(1, item.refs.length);
        const score = item.score / (1 + overlap);
        if (score > bestScore) { best = i; bestScore = score; }
      });
      const item = remaining.splice(best,1)[0]; selected.push(item.p);
      item.refs.forEach(id => used.set(id, (used.get(id) || 0) + 1));
    }
    for (const p of recent) if (selected.length < limit && !selected.some(n => n.id === p.id)) selected.push(p);
    return selected;
  }

  async function expandNetwork(net, min, max, { signal } = {}) {
    abort(signal);
    const key = min + ':' + (Number.isFinite(max) ? max : 'all');
    const previous = net.expansion?.key === key ? net.expansion : null;
    const state = previous ? { ...previous, pool: previous.pool.slice() } : { key, min, max, top: '*', recent: '*', pool: [], total: null };
    // At most two API pages per expansion; keep unused candidates for later.
    if (state.pool.length < 100) {
      const requests = [['top',false],['recent',true]].filter(([name]) => state[name]);
      const pages = await Promise.all(requests.map(async ([name,recent]) => [name, await citingPage(net.seedId, {min,max,cursor:state[name],recent,signal})]));
      abort(signal);
      for (const [name,page] of pages) { state[name] = page.next; state.total = page.total; state.pool.push(...page.papers); }
    }
    const known = new Set(net.papers.map(p => p.id));
    state.pool = [...new Map(state.pool.filter(p => !known.has(p.id) && p.cites >= min && (!Number.isFinite(max) || p.cites <= max)).map(p => [p.id,p])).values()];
    const chosen = rankExpansion(state.pool, net.papers, net.seedId);
    const chosenIds = new Set(chosen.map(p => p.id));
    state.pool = state.pool.filter(p => !chosenIds.has(p.id));
    const papers = net.papers.concat(chosen.map(p => ({...p, role:'cite'})));
    const citingIds = [...new Set([...(net.citingIds || []), ...chosenIds])];
    const citingSet = new Set(citingIds);
    const loadedInRange = papers.filter(p => citingSet.has(p.id) && p.cites >= min && (!Number.isFinite(max) || p.cites <= max)).length;
    state.done = loadedInRange >= state.total || (!state.top && !state.recent && !state.pool.length);
    const seed = papers.find(p => p.id === net.seedId);
    const result = network(papers, seed, { total:net.citingTotal, papers:citingIds }, papers.filter(p => p.role === 'ref'), net.linkedShown);
    return { ...net, ...result, citingIds, expansion:state };
  }

  // Build the full citation neighborhood around a seed paper object.
  async function buildNetwork(seed, opts) {
    opts = opts || {};
    const citeLimit = opts.citeLimit || 80;
    abort(opts.signal);
    if (!seed.refsLoaded) seed = await byId(seed.id, opts);

    const adaptive = opts.adaptive === true;
    let readyRefs = [];
    const references = (seed.refs?.length ? fetchByIds(seed.refs, opts) : Promise.resolve([])).then(papers => (readyRefs = papers));
    const combine = (citingPapers, refs) => {
      const map = new Map([[seed.id,{...seed,role:'seed'}]]);
      for (const [papers,role] of [[refs,'ref'],[citingPapers,'cite']]) for (const p of papers) if(!map.has(p.id))map.set(p.id,{...p,role});
      return [...map.values()];
    };
    const loadCiting = async () => {
      if (!adaptive) return citing(seed.id, citeLimit, opts);
      let page = await citingPage(seed.id, {signal:opts.signal});
      const total = page.total, budget = initialBudget(total), collected = page.papers.slice();
      // Once the authoritative total is known, the remaining initial pages can
      // run concurrently while a smaller, usable preview is being displayed.
      const rest = [];
      for(let next=2; (next-1)*100<budget; next++) rest.push(citingPage(seed.id,{cursor:'page:'+next,signal:opts.signal}));
      const pending = Promise.allSettled(rest);
      if(opts.onPreview && total>100) {
        const previewRefs=readyRefs.slice(0,60);
        const preview=network(combine(collected,previewRefs),seed,{total,papers:collected},previewRefs);
        await opts.onPreview({...preview,adaptive:true,preview:true,initialMin:0,citingIds:collected.map(p=>p.id)});
      }
      let loadWarning = '';
      for(const result of await pending) {
        abort(opts.signal);
        if(result.status==='rejected') {loadWarning='Some citing papers could not be loaded. '+result.reason.message;break;}
        collected.push(...result.value.papers);
      }
      const unique = [...new Map(collected.map(p => [p.id,p])).values()];
      return {total, papers:unique.slice(0,budget), loadWarning};
    };
    const [refPapers, citeRes] = await Promise.all([
      references,
      loadCiting()
    ]);

    // node map — seed first, then references, then citing (first writer wins)
    const map = new Map();
    const seedClean = { ...seed, role: "seed" };
    map.set(seed.id, seedClean);
    refPapers.forEach(p => { if (!map.has(p.id)) map.set(p.id, { ...p, role: "ref" }); });
    citeRes.papers.forEach(p => { if (!map.has(p.id)) map.set(p.id, { ...p, role: "cite" }); });

    let papers = [...map.values()];
    const ids = new Set(papers.map(p => p.id));

    const decorate = net => adaptive ? { ...net, adaptive:true, loadWarning: citeRes.loadWarning || '',
      initialMin: citeRes.total > 300 && citeRes.papers.length ? Math.max(0, citeRes.papers[citeRes.papers.length-1].cites || 0) : 0,
      citingIds: [...new Set([...citeRes.papers.map(p=>p.id), ...refPapers.filter(p=>(p.refs||[]).includes(seed.id)).map(p=>p.id)])] } : net;
    const direct = decorate(network(papers, seed, citeRes, refPapers));
    abort(opts.signal);

    // ---- second-degree expansion ----
    // A paper that isn't in the graph yet but is referenced by several papers
    // that ARE in the graph is a shared foundation worth surfacing. Pull in any
    // such work cited by at least `minShared` (default 3) in-graph papers.
    const minShared = opts.minShared || 3;
    const extCount = new Map();
    papers.forEach(p => {
      (p.refs || []).forEach(t => {
        if (t !== p.id && !ids.has(t)) extCount.set(t, (extCount.get(t) || 0) + 1);
      });
    });
    const promote = [...extCount.entries()]
      .filter(([, c]) => c >= minShared)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([id]) => id);
    let linkedShown = 0;
    // Fetch optional enrichment during direct layout, rather than after it.
    const enrichment = promote.length ? fetchByIds(promote, opts).then(papers=>({papers}),error=>({error})) : Promise.resolve({papers:[]});
    if (opts.onDirect) await opts.onDirect(direct);
    abort(opts.signal);
    if (promote.length) {
      const result = await enrichment;
      if(result.error) {if(isAbort(result.error))throw result.error;return {...direct,enrichmentFailed:true};}
      const extra = result.papers;
      extra.forEach(p => {
        if (!ids.has(p.id)) { map.set(p.id, { ...p, role: "linked" }); ids.add(p.id); linkedShown++; }
      });
      papers = [...map.values()];
    }

    abort(opts.signal);
    return decorate(network(papers, seed, citeRes, refPapers, linkedShown));
  }

  return { initialBudget, rankExpansion, expandNetwork, citingPage, sortResults, cachedNetwork, saveNetwork, flushCache, search, searchPage, searchAuthors, resolveTop, byId, fetchByIds, abstractFor, abstractsFor, citing, sourceImpact, buildNetwork, toPaper };
})();
