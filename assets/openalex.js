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
  function persistCache() {
    try {
      const small = [...responseCache].filter(([, e]) => JSON.stringify(e).length < 150000).slice(-30);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(small));
    } catch (error) { /* The memory cache is still available. */ }
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
        if (!r.ok) throw new Error('OpenAlex request failed (' + r.status + ')');
        abort(signal);
        responseCache.set(url, { data, time: Date.now() });
        if (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
        persistCache();
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

  // Resolve a work straight from its DOI. This is the ONLY reliable way to find
  // a freshly published paper: text/relevance search can miss it for days while
  // OpenAlex's search index settles, but the DOI single-entity lookup hits the
  // record the moment it's ingested.
  async function byDoi(doi, options = {}) {
    try {
      const w = await getJSON(`${API}/works/doi:${doi}?select=${SELECT}`, options);
      return (w && w.id) ? toPaper(w) : null;
    } catch (e) { if (isAbort(e)) throw e; return null; }
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

  // Two complementary queries, merged & de-duped:
  //  1. relevance search (OpenAlex default ranking — good for well-cited work)
  //  2. title-filter sorted by publication date (surfaces brand-new papers that
  //     have ~0 citations and so never rank in the relevance query)
  // Without (2), recently published papers are invisible even on an exact title
  // match, because relevance_score is dominated by cited_by_count.
  async function search(q, options = {}) {
    if (!q || !q.trim()) return [];
    const term = q.trim();
    // DOI pasted (or a doi.org link)? Resolve it directly and return that one
    // paper — don't dilute an exact match with fuzzy text hits.
    const doi = doiFromQuery(term);
    if (doi) {
      const hit = await byDoi(doi, options);
      if (hit) return [hit];
      // DOI didn't resolve (typo / not yet ingested) — fall through to text search.
    }
    const enc = encodeURIComponent(term);
    const [byRelevance, byTitleRecent] = await Promise.all([
      getJSON(`${API}/works?search=${enc}&per-page=25&select=${SELECT_SEARCH}`, options),
      getJSON(`${API}/works?filter=title.search:${enc}&sort=publication_date:desc&per-page=25&select=${SELECT_SEARCH}`, options)
        .catch(error => { if (isAbort(error)) throw error; return { results: [] }; })
    ]);
    const map = new Map();
    // Relevance batch first so it wins ties (preserves OpenAlex's ranking for
    // topic / author queries, where titles rarely contain the query words).
    [...(byRelevance.results || []), ...(byTitleRecent.results || [])].forEach(w => {
      const p = toPaper(w);
      if (!map.has(p.id)) map.set(p.id, p);
    });
    // Re-rank the merged list by TITLE-WORD overlap with the query. A precise
    // title match scores ~1 and floats to the top even with 0 citations — which
    // is exactly the recent-paper case relevance search buries. When titles
    // don't contain the query words (author / topic search) every score is 0
    // and the stable sort leaves OpenAlex's original relevance order intact.
    return rankByTitle([...map.values()], term);
  }

  // Fraction of query words (length > 2) that appear in a paper's title.
  function titleScore(p, qwords) {
    if (!qwords.length) return 0;
    const t = (p.title || "").toLowerCase();
    return qwords.filter(w => t.includes(w)).length / qwords.length;
  }
  function queryWords(q) {
    return q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2);
  }
  function rankByTitle(list, q) {
    const qw = queryWords(q);
    return list
      .map((p, i) => ({ p, i, s: titleScore(p, qw) }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i)) // score desc, else keep original order
      .map(o => o.p);
  }

  // Resolve a free-text query to its best title match. Ranking favors how well
  // the title matches the query, then RECENCY — never citation count, which
  // would always bury a newly published paper under older, well-cited ones.
  async function resolveTop(q, options = {}) {
    const results = await search(q, options);
    if (!results.length) throw new Error("No matching paper found.");
    // search() already ranks DOI / title matches first, so the head of the list
    // is the best match. Break exact-score ties toward the more recent paper.
    const qw = queryWords(q);
    const yr = p => (typeof p.year === "number" ? p.year : 0);
    return results.slice().sort((a, b) => (titleScore(b, qw) - titleScore(a, qw)) || (yr(b) - yr(a)))[0];
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
  async function sourceImpact(ids, options = {}) {
    const out = {};
    const uniq = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 50) {
      const chunk = uniq.slice(i, i + 50);
      if (!chunk.length) continue;
      try {
        const j = await getJSON(`${API}/sources?filter=openalex_id:${chunk.join("|")}&per-page=50&select=id,summary_stats`, options);
        (j.results || []).forEach(s => {
          out[shortId(s.id)] = (s.summary_stats && s.summary_stats["2yr_mean_citedness"]) || 0;
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

  // Build the full citation neighborhood around a seed paper object.
  async function buildNetwork(seed, opts) {
    opts = opts || {};
    const citeLimit = opts.citeLimit || 80;
    abort(opts.signal);
    if (!seed.refsLoaded) seed = await byId(seed.id, opts);

    const [refPapers, citeRes] = await Promise.all([
      seed.refs && seed.refs.length ? fetchByIds(seed.refs, opts) : Promise.resolve([]),
      citing(seed.id, citeLimit, opts)
    ]);

    // node map — seed first, then references, then citing (first writer wins)
    const map = new Map();
    const seedClean = { ...seed, role: "seed" };
    map.set(seed.id, seedClean);
    refPapers.forEach(p => { if (!map.has(p.id)) map.set(p.id, { ...p, role: "ref" }); });
    citeRes.papers.forEach(p => { if (!map.has(p.id)) map.set(p.id, { ...p, role: "cite" }); });

    let papers = [...map.values()];
    const ids = new Set(papers.map(p => p.id));

    const direct = network(papers, seed, citeRes, refPapers);
    if (opts.onDirect) await opts.onDirect(direct);
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
    if (promote.length) {
      let extra;
      try { extra = await fetchByIds(promote, opts); }
      catch (error) { if (isAbort(error)) throw error; return { ...direct, enrichmentFailed: true }; }
      extra.forEach(p => {
        if (!ids.has(p.id)) { map.set(p.id, { ...p, role: "linked" }); ids.add(p.id); linkedShown++; }
      });
      papers = [...map.values()];
    }

    abort(opts.signal);
    return network(papers, seed, citeRes, refPapers, linkedShown);
  }

  return { search, resolveTop, byId, fetchByIds, abstractFor, citing, sourceImpact, buildNetwork, toPaper };
})();
