/* ============================================================
   App wiring — live OpenAlex data
   Router · inline search · graph loading · detail · list
   ============================================================ */
(function () {
  const roleLabel = { seed: "Seed paper", ref: "Reference", cite: "Citing paper", linked: "Co-cited" };
  const fmt = n => (typeof n !== "number") ? n :
    n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : "" + n;

  /* ---- current network state ---- */
  let CURRENT = { seedId: null, papers: [], byId: {}, edges: [], neighbors: {}, meta: {} };
  let graph = null;
  let citeLimit = 80;
  let lastSeed = null;          // paper object used for retry
  let sortKey = "role";
  let sortDir = "asc";          // "asc" | "desc" — toggled by clicking the active sort
  let typeFilter = "";          // "" = all paper types
  let loadController = null;
  let netSeq = 0;               // bumped each load; guards stale background patches

  const $ = id => document.getElementById(id);
  const PAGE = document.body.dataset.page;
  let selectedId = null;
  const params = new URLSearchParams(location.search);
  const sharedSeed = params.get('seed');
  let remembered = null;
  try { remembered = JSON.parse(sessionStorage.getItem('citation-current') || 'null'); } catch (_) {}
  function pageUrl(view, seedId = CURRENT.seedId || sharedSeed || remembered?.seedId) {
    const url = new URL(view === 'search' ? 'index.html' : view + '.html', location.href);
    if (view !== 'search' && seedId) { url.searchParams.set('seed', seedId); url.searchParams.set('density', String(citeLimit)); }
    return url.href;
  }
  function updateNavigation() {
    document.querySelectorAll('[data-view]').forEach(link => {
      link.href = pageUrl(link.dataset.view);
      link.classList.toggle('active', link.dataset.view === PAGE);
      if (link.dataset.view === PAGE) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    refreshShareBtn();
  }
  function show(view) { location.assign(pageUrl(view)); }
  window.__show = show;

  /* ---------------- graph init ---------------- */
  function ensureGraph() {
    if (graph) return;
    graph = new CitationGraph($("graph-canvas"), {
      onSelect: node => renderDetail(node),
      onHover: (node, x, y) => renderTooltip(node, x, y)
    });
    try {
      const saved = JSON.parse(sessionStorage.getItem('citation-layout-controls') || '{}');
      graph.spacing = Math.max(.8, Math.min(1.8, Number(saved.spacing) || 1));
      graph.bondStrength = Math.max(.5, Math.min(2, Number(saved.bondStrength) || 1));
      graph.setLinkMode(saved.links);
    } catch (_) {}
    window.CG = graph;
    if (window.applyAppearance) window.applyAppearance();
  }

  /* ---------------- inline search ---------------- */
  let searchTimer = null, searchController = null, searchSeq = 0;
  let searchPageNumber = 1, searchRows = [], selectedAuthor = null, retryMore = false, searchKey = '', resumeSearch = false;
  function cancelSearch() {
    clearTimeout(searchTimer); searchSeq++;
    searchController?.abort();
  }
  const motion = (element, frames, duration = 240) => window.CitationMotion.animate(element, frames, duration);
  function enterSearch() {
    if (document.body.classList.contains('has-search')) return;
    const elements = [...document.querySelectorAll('.search-wrap > h1, .search-wrap > .lede, .bigsearch, .search-options')];
    const before = elements.map(el => el.getBoundingClientRect());
    try { sessionStorage.setItem('citation-search-compact', '1'); } catch (_) {}
    document.body.classList.add('has-search');
    const after = elements.map(el => el.getBoundingClientRect());
    elements.forEach((el, i) => motion(el, [
      { transform: `translate(${before[i].x-after[i].x}px, ${before[i].y-after[i].y}px)` },
      { transform: 'translate(0,0)' }
    ], 280));
  }
  const resultVisibility = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    for (const entry of entries) entry.target._inViewport=entry.isIntersecting;
  }, {root:$('view-search'),rootMargin:'120px'}) : null;
  function renderSearchRows(rows, authors, protect = true) {
    const box = $('search-results');
    const existing = new Map([...box.children].map(el => [el.dataset.id, el]));
    const interacting = box._pointerRow?.matches(':hover') || box.contains(document.activeElement);
    // Never reorder or remove a result while it is being read or activated.
    if (protect && interacting && existing.size) {
      box._pendingRows = { rows, authors };
      rows = [...existing.values()].map(el => el._paper).concat(rows.filter(p => !existing.has(p.id)));
    } else box._pendingRows = null;
    const old = new Map([...existing].filter(([,el])=>el._inViewport!==false).map(([id, el]) => [id, el.getBoundingClientRect().top]));
    const keep = new Set(rows.map(p => p.id));
    for (const [id, el] of existing) if (!keep.has(id)) { resultVisibility?.unobserve(el); el.remove(); }
    rows.forEach((p, index) => {
      let button = existing.get(p.id);
      const fresh = !button;
      if (!button) {
        button = document.createElement('button'); button._inViewport=index<15; resultVisibility?.observe(button); button.type = 'button'; button.className = 'presult'; button.dataset.id = p.id;
        button.addEventListener('click', () => {
          if (button._author) { selectedAuthor = button._paper; doSearch(); }
          else { cancelSearch(); loadSeed(button._paper); }
        });
      }
      button._paper = p; button._author = authors;
      button.classList.toggle('author-result', authors);
      const html = authors
        ? `<div><div class="pt">${esc(p.name)}</div><div class="pm">${esc(p.institution || 'Affiliation unavailable')}</div><div class="pm">${esc(p.orcid ? 'ORCID ' + p.orcid.split('/').pop() : '')}</div></div><div class="pc">${fmt(p.works || 0)}<small>works</small></div>`
        : `<div><div class="pt">${esc(p.title)}</div><div class="result-authors">${esc(p.authors)}</div><div class="pm">${esc(p.year)} · ${esc(p.venue)}</div></div><div class="pc">${fmt(p.cites)}<small>citations</small></div>`;
      if (button._html !== html) { button.innerHTML = html; button._html = html; }
      if (box.children[index] !== button) box.insertBefore(button, box.children[index] || null);
      button._fresh = fresh;
    });
    // Read layout once after all writes; animate only visible changed rows.
    const positions = [...box.children].filter(el=>el._inViewport!==false).map(el => [el, el.getBoundingClientRect()]);
    for (const [el, rect] of positions) {
      const delta = old.has(el.dataset.id) ? old.get(el.dataset.id) - rect.top : 6;
      if (rect.bottom < 0 || rect.top > innerHeight || (!el._fresh && Math.abs(delta) < .5)) continue;
      motion(el, [{ opacity: el._fresh ? 0 : 1, transform: `translateY(${delta}px)` }, { opacity: 1, transform: 'translateY(0)' }], 170);
    }
  }
  async function doSearch(loadMore = false) {
    if (!$('big-input')) return;
    cancelSearch();
    const seq = searchSeq, term = $('big-input').value.trim();
    const status = $('search-status'), box = $('search-results'), more = $('search-more');
    box._pendingRows = null;
    more.hidden = true; $('search-retry').hidden = true; box.setAttribute('aria-busy', 'false');
    if (!term) {
      searchRows = []; selectedAuthor = null; resultVisibility?.disconnect(); box.replaceChildren(); status.textContent = '';
      $('author-back').hidden = true; $('search-source').hidden = true;
      box._pendingRows = null; return;
    }
    const key = JSON.stringify([term, $('search-mode').value, $('search-sort').value, selectedAuthor?.id]);
    if (key !== searchKey) loadMore = false;
    const authors = $('search-mode').value === 'authors' && !selectedAuthor;
    $('search-sort').disabled = authors;
    const page = loadMore ? searchPageNumber + 1 : 1;
    const previous = loadMore ? searchRows.slice() : [];
    searchController = new AbortController();
    const options = { signal: searchController.signal, page, mode: $('search-mode').value,
      sort: $('search-sort').value, authorId: selectedAuthor?.id };
    enterSearch();
    box.setAttribute('aria-busy', 'true');
    $('author-back').hidden = !selectedAuthor;
    status.textContent = loadMore ? 'Loading more results…' : selectedAuthor ? `Finding papers by ${selectedAuthor.name}…` : searchRows.length ? 'Updating results… Previous results remain below.' : 'Searching…';
    retryMore = loadMore;
    const apply = result => {
      if (seq !== searchSeq) return;
      const unique = new Map(previous.map(p => [p.id, p]));
      result.results.forEach(p => unique.set(p.id, p));
      const protect = searchKey === key;
      searchRows = authors ? [...unique.values()] : OpenAlex.sortResults([...unique.values()], $('search-sort').value); searchKey = key;
      renderSearchRows(searchRows, authors, protect);
      $('search-source').hidden = !searchRows.length;
      $('search-source').textContent = authors ? 'Results from OpenAlex · choose an author to see their publications' : 'Results from OpenAlex · choose a paper to explore its connections';
    };
    options.onUpdate = result => {
      if (seq !== searchSeq || !result.results.length) return;
      apply(result); status.textContent = `${searchRows.length} papers found · checking additional matches…`;
    };
    try {
      const result = authors ? await OpenAlex.searchAuthors(term, options) : await OpenAlex.searchPage(term, options);
      if (seq !== searchSeq) return;
      apply(result); searchPageNumber = page;
      more.hidden = !result.hasMore;
      status.textContent = searchRows.length
        ? `${searchRows.length} ${authors ? (searchRows.length === 1 ? 'author' : 'authors') + ' — choose a person to see their papers' : (searchRows.length === 1 ? 'paper' : 'papers') + (selectedAuthor ? ' by ' + selectedAuthor.name : '')}${result.fuzzy ? ' · includes spelling alternatives' : ''}${result.partial ? ' · some results are unavailable; try again for the complete search' : ''}`
        : authors ? 'No authors found. Try a full name or a different spelling.' : result.exact ? 'That DOI was not found.' : 'No papers found. Try fewer words or a DOI.';
      $('search-retry').hidden = !result.partial;
      if (result.partial) retryMore = false;
    } catch (error) {
      if (seq !== searchSeq || options.signal.aborted) return;
      status.textContent = `Search is temporarily unavailable. ${searchRows.length ? 'Previous results are still shown. ' : ''}Please try again.`;
      $('search-retry').hidden = false;
    } finally {
      if (seq === searchSeq) box.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- loading a seed network ---------------- */
  let loading = false, resumeLoad = false;
  function setLoader(state, title, sub) {
    const ov = $("loader");
    ov.hidden = false;
    $("loader-spin").hidden = state === "empty";
    $("loader-spin").className = state === "error" ? "spinner error" : "spinner";
    if (state === "error") $("loader-spin").textContent = "⚠"; else $("loader-spin").textContent = "";
    $("loader-title").textContent = title;
    $("loader-sub").innerHTML = sub;
    $("loader-actions").hidden = state !== "error";
  }
  function hideLoader() { $("loader").hidden = true; }

  // One owner for every load, including examples, retries, density and shared URLs.
  // Cancel network requests and worker jobs as soon as the user chooses a new seed.
  async function startLoad(resolveSeed, title, cacheId = null) {
    if (loadController) loadController.abort();
    loadController = new AbortController();
    const signal = loadController.signal, seq = ++netSeq;
    loading = true;
    if (PAGE === 'graph') { ensureGraph(); graph.cancelLayout(); }
    setLoader('loading', title, 'Fetching paper details from OpenAlex');
    let directShown = false;
    try {
      const cached = cacheId ? await OpenAlex.cachedNetwork(cacheId, citeLimit) : null;
      if (signal.aborted || seq !== netSeq) return;
      if (cached) {
        lastSeed=cached.papers.find(p=>p.id===cached.seedId);
        await applyNetwork(cached,{seq,signal});
        if(signal.aborted || seq!==netSeq) return;
        hideLoader(); return;
      }
      const seed = await resolveSeed({ signal });
      if (signal.aborted || seq !== netSeq) return;
      if (!seed) throw new Error('That paper could not be found on OpenAlex.');
      lastSeed = seed;
      setLoader('loading', 'Building citation graph…', 'Mapping <b>' + esc(truncate(seed.title, 60)) + '</b><br>Fetching references and citing papers');
      const net = await OpenAlex.buildNetwork(seed, {
        citeLimit, signal,
        onDirect: async direct => {
          if (signal.aborted || seq !== netSeq) return;
          await applyNetwork(direct, { seq, signal });
          if (signal.aborted || seq !== netSeq) return;
          directShown = true;
          hideLoader();
          $('status-counts').textContent += ' · finding co-cited papers…';
        }
      });
      if (signal.aborted || seq !== netSeq) return;
      if (net.linkedShown) await applyNetwork(net, { seq, signal, preserve: true });
      if (signal.aborted || seq !== netSeq) return;
      await OpenAlex.saveNetwork(net, citeLimit);
      if (signal.aborted || seq !== netSeq) return;
      updateStatus(net);
      if (net.enrichmentFailed) $('status-counts').textContent += ' · co-cited papers unavailable';
      hideLoader();
    } catch (err) {
      if (signal.aborted || seq !== netSeq) return;
      if (directShown) $('status-counts').textContent += ' · some extra papers unavailable';
      else setLoader('error', 'Couldn’t build the graph', esc(err.message || 'Network error') + '.<br>Try again, or explore the sample graph.');
    } finally { if (seq === netSeq) loading = false; }
  }

  function loadSeed(seed) { if (PAGE !== 'graph' && PAGE !== 'paper') { location.assign(pageUrl('graph', seed.id)); return; } return startLoad(() => Promise.resolve(seed), 'Building citation graph…'); }
  function loadSeedById(id, density) {
    if (density && ['40', '80', '120'].includes(String(density))) {
      citeLimit = +density; if ($('density')) $('density').value = String(citeLimit);
    }
    return startLoad(options => OpenAlex.byId(id, options), 'Opening shared graph…', id);
  }
  function updateStatus(net) {
    $('status-counts').textContent = net.refShown + ' references · top ' + net.citingShown + ' of ' + fmt(net.citingTotal) + ' citing'
      + (net.linkedShown ? ' · ' + net.linkedShown + ' co-cited' : '');
  }

  async function applyNetwork(net, { seq = netSeq, signal, preserve = false } = {}) {
    CURRENT.seedId = net.seedId;
    CURRENT.papers = net.papers;
    CURRENT.edges = net.edges;
    CURRENT.byId = {}; net.papers.forEach(p => (CURRENT.byId[p.id] = p));
    CURRENT.neighbors = computeNeighbors(net.edges, CURRENT.byId);
    CURRENT.meta = net;

    let view = null;
    if (graph && !preserve) {
      try { const saved = JSON.parse(sessionStorage.getItem('citation-graph-view') || 'null'); if (saved?.seedId === net.seedId && saved.density === citeLimit && Array.isArray(saved.positions) && Number.isFinite(saved.scale) && saved.scale > 0) view = saved; } catch (_) {}
    }
    const applied = graph ? await graph.setData(net.papers, net.edges, net.seedId, { preserve, view }) : true;
    if (!applied || seq !== netSeq || (signal && signal.aborted)) return;
    populateTypeFilter();

    // Journal impact factor loads in the background — it only refines node
    // sizes, so we never block the first paint on it. Patch sizes in when it arrives.
    if (graph) OpenAlex.sourceImpact(net.papers.map(p => p.sourceId), { signal }).then(ifIdx => {
      if (seq !== netSeq) return; // a newer graph loaded; drop this
      const ifByNode = {};
      net.papers.forEach(p => { p.journalIF = ifIdx[p.sourceId] || 0; ifByNode[p.id] = p.journalIF; });
      if (graph) graph.applyJournalImpact(ifByNode);
    }).catch(() => {});

    const seed = CURRENT.byId[net.seedId];
    if ($("seed-title")) $("seed-title").textContent = seed.title;
    document.title = seed.title + ({ graph: " — Graph", paper: " — Paper", list: " — List" }[PAGE]);
    $("status-counts").textContent =
      `${net.refShown} references · top ${net.citingShown} of ${fmt(net.citingTotal)} citing` +
      (net.linkedShown ? ` · ${net.linkedShown} co-cited` : "");
    if (!preserve && graph) {
      graph.select(null);
      if (Array.isArray(view?.cards) && view.cards.length) {
        paperCards = view.cards.map(id => graph.nodeById[id]).filter(Boolean).slice(0,4);
        updatePaperCards();
      }
    }
    if (PAGE === "list") renderList();
    if (PAGE === "paper") {
      let selection;
      try { selection = JSON.parse(sessionStorage.getItem('citation-selected') || 'null'); } catch (_) {}
      renderDetail(CURRENT.byId[selectedId] || (selection?.seedId === net.seedId && CURRENT.byId[selection.paperId]) || seed);
    }
    if (graph) graph.setFilter(readFilters());
    syncShareUrl();
    updateNavigation();
    window.CitationPage = { network: CURRENT, ready: true, selectedId };
    syncLayoutControls();
  }

  /* ---------------- share ---------------- */
  // A shared graph is fully reproducible from the seed id + density: the network
  // is rebuilt live from OpenAlex, so the link only needs those two values.
  function shareUrl() { return pageUrl('graph'); }
  function syncShareUrl() {
    if (!CURRENT.seedId || PAGE === 'search') return;
    try { sessionStorage.setItem('citation-current', JSON.stringify({ seedId: CURRENT.seedId, density: citeLimit })); } catch (_) {}
    history.replaceState(null, '', pageUrl(PAGE));
  }
  function refreshShareBtn() {
    const seedId = CURRENT.seedId || (PAGE === 'search' ? remembered?.seedId : sharedSeed || remembered?.seedId);
    const button = $('share-btn');
    if (button) { button.hidden = false; button.disabled = !seedId; }
    if (seedId) document.documentElement.dataset.workspace = 'active';
  }

  let toastTimer = null;
  function showToast(msg, url) {
    const t = $("toast");
    t.hidden = false;
    t.querySelector(".tmsg").textContent = msg;
    const urlEl = $("toast-url");
    if (url) { urlEl.value = url; urlEl.hidden = false; } else { urlEl.hidden = true; }
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => { t.hidden = true; }, 240);
    }, url ? 7000 : 2400);
  }

  const shareBtn = $("share-btn");
  shareBtn?.addEventListener("click", async () => {
    if (!(CURRENT.seedId || remembered?.seedId || (PAGE !== 'search' && sharedSeed))) return;
    const url = shareUrl();
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (e) { copied = false; }
    if (copied) {
      shareBtn.classList.add("copied");
      shareBtn.setAttribute("aria-label", "Graph link copied");
      showToast("Link copied — anyone who opens it sees this graph");
      setTimeout(() => {
        shareBtn.classList.remove("copied");
        shareBtn.setAttribute("aria-label", "Share graph");
      }, 1600);
    } else {
      // Clipboard blocked (e.g. no https / permission) — surface the link to copy by hand.
      showToast("Copy this link:", url);
      const urlEl = $("toast-url");
      urlEl.focus(); urlEl.select();
    }
  });

  function computeNeighbors(edges, byId) {
    const nb = {}; Object.keys(byId).forEach(id => (nb[id] = []));
    edges.forEach(e => {
      if (nb[e.s] && nb[e.t]) {
        nb[e.s].push({ id: e.t, dir: "cites" });
        nb[e.t].push({ id: e.s, dir: "citedby" });
      }
    });
    return nb;
  }

  /* ---- density control ---- */
  $("density")?.addEventListener("change", e => {
    citeLimit = +e.target.value;
    if (lastSeed) loadSeed(CURRENT.byId[CURRENT.seedId] || lastSeed);
  });

  /* ---- loader error actions ---- */
  $("loader-retry")?.addEventListener("click", () => { if (lastSeed) loadSeed(lastSeed); });
  $("loader-sample")?.addEventListener("click", loadSample);

  /* ---------------- search screen ---------------- */
  function buildSearch() {
    const input = $('big-input');
    if (!input) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem('citation-search-view') || 'null');
      if (saved && Array.isArray(saved.rows) && typeof saved.query === 'string' && ['papers','title','authors'].includes(saved.mode)) {
        input.value = saved.query; $('search-mode').value = saved.mode;
        $('search-sort').value = ['newest','oldest','citations'].includes(saved.sort) ? saved.sort : 'relevance';
        selectedAuthor = saved.author; searchRows = saved.rows; searchPageNumber = saved.page; searchKey = saved.key;
        document.body.classList.add('has-search');
        renderSearchRows(searchRows, saved.mode === 'authors' && !selectedAuthor, false);
        $('search-status').textContent = saved.status;
        $('view-search').scrollTop = saved.scroll || 0;
        $('search-source').hidden = !searchRows.length;
        $('author-back').hidden = !selectedAuthor; $('search-more').hidden = !saved.more;
        if (saved.mode === 'authors') { input.placeholder = 'Author’s name…'; input.setAttribute('aria-label', 'Search authors'); }
      }
    } catch (_) {}
    const schedule = () => {
      cancelSearch(); selectedAuthor = null;
      if (!input.value.trim()) { doSearch(); return; }
      searchTimer = setTimeout(() => doSearch(), 450);
    };
    try { if (sessionStorage.getItem('citation-search-compact')) document.body.classList.add('has-search'); } catch (_) {}
    input.addEventListener('focus', enterSearch);
    const flushRows = () => requestAnimationFrame(() => { const pending = $('search-results')._pendingRows; if (pending) renderSearchRows(pending.rows, pending.authors); });
    $('search-results').addEventListener('pointermove', event => { $('search-results')._pointerRow = event.target.closest('.presult'); });
    $('search-results').addEventListener('pointerleave', () => { $('search-results')._pointerRow = null; flushRows(); });
    $('search-results').addEventListener('focusout', flushRows);
    input.addEventListener('input', event => { if (!event.isComposing) schedule(); });
    input.addEventListener('compositionend', schedule);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); doSearch(); }
      if (event.key === 'ArrowDown') { const first = $('search-results').querySelector('button'); if (first) { event.preventDefault(); first.focus(); } }
    });
    $('big-go').addEventListener('click', () => doSearch());
    $('search-more').addEventListener('click', () => doSearch(true));
    $('search-retry').addEventListener('click', () => doSearch(retryMore));
    $('author-back').addEventListener('click', () => { selectedAuthor = null; doSearch(); });
    $('search-mode').addEventListener('change', () => {
      selectedAuthor = null;
      const authors = $('search-mode').value === 'authors';
      input.placeholder = authors ? 'Author’s name…' : 'Paper title, topic, or DOI…';
      input.setAttribute('aria-label', authors ? 'Search authors' : 'Search papers');
      $('search-sort').disabled = authors;
      doSearch();
    });
    $('search-sort').disabled = $('search-mode').value === 'authors' && !selectedAuthor;
    $('search-sort').addEventListener('change', () => doSearch());
    $('search-results').addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
      const buttons = [...$('search-results').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      if (event.key === 'Escape' || (event.key === 'ArrowUp' && index <= 0)) input.focus();
      else buttons[Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
    });
  }

  /* ---------------- graph controls ---------------- */
  function readFilters() {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('citation-filters') || '{}'); } catch (_) {}
    return { showRefs: saved?.showRefs !== false, showCites: saved?.showCites !== false, showLinked: saved?.showLinked !== false };
  }
  let layoutTimer = null, layoutRequest = 0;
  function syncLayoutControls() {
    if (!$('graph-spacing') || !graph) return;
    $('graph-spacing').disabled = !graph._dataReady;
    $('graph-spacing').value = String(Math.round(graph.spacing * 100));
    $('spacing-value').textContent = Math.round(graph.spacing * 100) + '%';
    $('graph-bonds').disabled = !graph._dataReady;
    $('graph-bonds').value = String(Math.round(graph.bondStrength*100));
    $('bonds-value').textContent = Math.round(graph.bondStrength*100)+'%';
    $('graph-links').value = graph.linkMode;
    const canSpread = !!graph.selected && graph._dataReady && (graph.adj[graph.selected]?.size || 0) > 0;
    $('spread-nearby').disabled = !canSpread;
    $('graph-layout-hint').textContent = graph.linkMode === 'shared' && graph.selectedIds.size < 2
      ? 'Select at least two papers to see shared connections.'
      : graph.linkMode === 'selected' && !graph.selected
      ? 'Select a paper to see its connections.'
      : canSpread ? 'Spread the active paper’s neighbors. Dragged papers stay in place.' : 'Select a paper to spread its neighbors.';
  }
  function saveLayoutControls() {
    try { sessionStorage.setItem('citation-layout-controls', JSON.stringify({spacing:graph.spacing,bondStrength:graph.bondStrength,links:graph.linkMode})); } catch (_) {}
  }
  async function arrangeGraph(value, centerId = null, bonds = false) {
    if (!graph) return;
    const request = ++layoutRequest;
    $('graph-layout-status').textContent = bonds ? 'Adjusting bonds…' : 'Adjusting spacing…';
    try {
      const changed = await graph.arrange(value, centerId);
      if (request !== layoutRequest) return;
      if (changed) saveLayoutControls();
      $('graph-layout-status').textContent = changed ? (bonds ? 'Bonds updated.' : 'Spacing updated.') : '';
    } catch (_) {
      if (request === layoutRequest) $('graph-layout-status').textContent = 'Could not adjust spacing. Please try again.';
    } finally { if (request === layoutRequest) syncLayoutControls(); }
  }
  function wireControls() {
    const filters = readFilters();
    for (const [id, key] of [['toggle-ref','showRefs'], ['toggle-cite','showCites'], ['toggle-linked','showLinked']]) {
      const button = $(id);
      if (!button) continue;
      button.setAttribute('aria-pressed', String(filters[key]));
      button.addEventListener('click', () => {
        filters[key] = !filters[key];
        button.setAttribute('aria-pressed', String(filters[key]));
        try { sessionStorage.setItem('citation-filters', JSON.stringify(filters)); } catch (_) {}
        if (graph) graph.setFilter(filters);
      });
    }
    $("zoom-in")?.addEventListener("click", () => graph && graph.zoomBy(1.25, undefined, undefined, true));
    $("zoom-out")?.addEventListener("click", () => graph && graph.zoomBy(0.8, undefined, undefined, true));
    $("zoom-fit")?.addEventListener("click", () => graph && graph.fit(true));
    $('graph-spacing')?.addEventListener('input', event => {
      const value = +event.target.value / 100;
      $('spacing-value').textContent = event.target.value + '%';
      clearTimeout(layoutTimer);
      // Cancel obsolete work immediately; only the latest slider value is applied.
      layoutRequest++; graph?.previewSpacing(value);
      if (graph) saveLayoutControls();
      layoutTimer = setTimeout(() => arrangeGraph(value), 180);
    });
    $('graph-bonds')?.addEventListener('input', event => {
      const value=+event.target.value/100;
      $('bonds-value').textContent=event.target.value+'%';
      clearTimeout(layoutTimer); layoutRequest++;
      graph?.previewBonds(value); if(graph) saveLayoutControls();
      layoutTimer=setTimeout(()=>arrangeGraph(graph.spacing,null,true),180);
    });
    $('graph-links')?.addEventListener('change', event => {
      graph?.setLinkMode(event.target.value); if (graph) saveLayoutControls(); syncLayoutControls();
    });
    $('spread-nearby')?.addEventListener('click', () => { clearTimeout(layoutTimer); if (graph?.selected) arrangeGraph(graph.spacing, graph.selected); });
    $('graph-options')?.addEventListener('toggle', event => {
      if (event.target.open) window.CitationMotion.animate(document.querySelector('.graph-options-panel'), [{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],150);
    });
    document.addEventListener('pointerdown', event => { const panel=$('graph-options'); if (panel?.open && !panel.contains(event.target)) panel.open=false; });
    document.addEventListener('keydown', event => { const panel=$('graph-options'); if (event.key==='Escape' && panel?.open) { event.preventDefault(); panel.open=false; panel.querySelector('summary').focus(); event.stopImmediatePropagation(); } });
  }

  /* ---------------- tooltip ---------------- */
  const tip = $('gtooltip');
  let tipNode = null, tipFrame = null, tipPoint = null, tipWidth = 0, tipHeight = 0;
  function renderTooltip(node, x, y) {
    if (node && PAGE === 'graph' && !$('detail').hidden) node = null;
    if (!node) {
      tip.classList.remove('show'); tipNode = null; tipPoint = null;
      if (tipFrame != null) cancelAnimationFrame(tipFrame);
      tipFrame = null; return;
    }
    if (tipNode !== node) {
      tipNode = node;
      tip.querySelector('.tt').textContent = node.title;
      tip.querySelector('.tm').textContent = node.short + ' · ' + node.year + ' · ' + roleLabel[node.role];
      tip.classList.add('show');
      tipWidth = tip.offsetWidth; tipHeight = tip.offsetHeight;
    }
    tipPoint = { x, y };
    if (tipFrame != null) return;
    tipFrame = requestAnimationFrame(() => {
      tipFrame = null;
      if (!tipPoint) return;
      const stage = document.querySelector('.graph-viewport').getBoundingClientRect();
      let lx = tipPoint.x + 16, ly = tipPoint.y + 16;
      if (lx + tipWidth > stage.width - 8) lx = tipPoint.x - tipWidth - 16;
      if (ly + tipHeight > stage.height - 8) ly = tipPoint.y - tipHeight - 16;
      tip.style.left = Math.max(8, lx) + 'px'; tip.style.top = Math.max(8, ly) + 'px';
    });
  }

  /* ---------------- detail panel ---------------- */
  const detail = $("detail");
  let paperCards = [];
  function updatePaperCards() {
    const old = new Map([...detail.children].map(card => [card.dataset.id, card.getBoundingClientRect()]));
    const existing = new Map([...detail.children].map(card => [card.dataset.id, card]));
    detail.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    detail.hidden = !paperCards.length;
    renderTooltip(null);
    for (const [index, paper] of paperCards.entries()) {
      let card = existing.get(paper.id);
      if (!card) {
        card = document.createElement('article');
        card.className = 'node-popup paper-card'; card.dataset.id = paper.id;
        card.innerHTML = '<button class="popup-close" type="button" title="Close">×</button><h2><button class="card-title" type="button"></button></h2><div class="card-body"><p class="card-authors"></p><p class="popup-meta"><span class="card-year"></span><span class="card-venue"></span></p><p class="card-citations"></p><a class="card-link" target="_blank" rel="noopener noreferrer"></a></div>';
        card.querySelector('.card-title').addEventListener('click', () => graph.select(paper.id));
        card.querySelector('.popup-close').addEventListener('click', () => closePaperCard(paper.id));
      }
      card.classList.toggle('is-front', index === 0);
      card.style.zIndex = String(4 - index);
      card.style.maxHeight = index === 0 ? Math.max(80, detail.parentElement.clientHeight - 40 - (paperCards.length - 1) * 44) + 'px' : '';
      const title = card.querySelector('.card-title');
      title.textContent = paper.title || 'Untitled paper'; title.title = title.textContent;
      title.setAttribute('aria-expanded', String(index === 0));
      card.querySelector('.popup-close').setAttribute('aria-label', 'Close ' + title.textContent);
      card.querySelector('.card-authors').textContent = paper.authors || 'Authors unavailable';
      card.querySelector('.card-year').textContent = paper.year || 'Year unavailable';
      card.querySelector('.card-venue').textContent = paper.venue || 'Journal unavailable';
      const citations = Number.isFinite(paper.cites) ? paper.cites : null;
      card.querySelector('.card-citations').textContent = citations == null ? 'Citation count unavailable' : new Intl.NumberFormat('en').format(citations) + (citations === 1 ? ' citation' : ' citations');
      const link = card.querySelector('.card-link');
      let url = null;
      try { const parsed = new URL(paper.url); if (['https:', 'http:'].includes(parsed.protocol)) url = parsed.href; } catch (_) {}
      link.hidden = !url; link.href = url || '#'; link.textContent = url || '';
      card.querySelector('.card-body').hidden = index !== 0;
      if (index === 0) {
        for (const [selector, id] of [['.card-title','d-title'],['.popup-close','detail-close'],['.card-authors','d-authors'],['.card-year','d-year'],['.card-venue','d-venue'],['.card-link','d-link']]) card.querySelector(selector).id = id;
      }
      detail.appendChild(card);
    }
    document.querySelectorAll('.motion-ghost').forEach(el => el.remove());
    for (const [id, card] of existing) if (!paperCards.some(p => p.id === id)) {
      const rect = old.get(id);
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const ghost = card.cloneNode(true);
        const style = getComputedStyle(card), heading = getComputedStyle(card.querySelector('h2'));
        ghost.className = 'node-popup motion-ghost' + (card.classList.contains('is-front') ? ' is-front' : '');
        ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
        Object.assign(ghost.style, { left: rect.x+'px', top: rect.y+'px', width: rect.width+'px', height: rect.height+'px', maxHeight:'none', padding:style.padding, transform:'none' });
        Object.assign(ghost.querySelector('h2').style, {fontSize:heading.fontSize, margin:heading.margin});
        document.body.appendChild(ghost);
        const exit = motion(ghost, [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-6px)'}], 150);
        if (exit) exit.finished.catch(() => {}).finally(() => ghost.remove()); else ghost.remove();
      }
      card.remove();
    }
    graph.selectedIds = new Set(paperCards.map(p => p.id));
    graph.selected = selectedId = paperCards[0]?.id || null;
    if (window.CitationPage) window.CitationPage.selectedId = selectedId;
    graph._invalidate();
    syncLayoutControls();
    const positions = [...detail.children].map(card => {
      card.getAnimations().forEach(animation => animation.cancel());
      return [card, card.getBoundingClientRect()];
    });
    for (const [card, rect] of positions) {
      const previous = old.get(card.dataset.id);
      const offset = previous ? previous.top - rect.top : 8;
      const ratio = previous && rect.height ? previous.height / rect.height : 1;
      card.style.transformOrigin = 'top center';
      motion(card, [{ transform: `translateY(${offset}px) scaleY(${ratio})`, opacity: previous ? 1 : 0 }, { transform: 'translateY(0) scaleY(1)', opacity: 1 }], 260);
      // Counter-scale content so the paper itself does not squash with its card.
      for (const child of card.children) {
        child.style.transformOrigin = 'top center';
        const reveal = child.classList.contains('card-body') && card.classList.contains('is-front') && (!previous || previous.height < 60);
        const inverse = Array.from({length:61}, (_,i) => {
          const t = i/60;
          return { offset:t, transform:`scaleY(${1/(ratio+(1-ratio)*t)})`, opacity:reveal ? Math.min(1,t*2) : 1 };
        });
        motion(child, inverse, 260);
      }

    }
  }

  function closePaperCard(id) {
    paperCards = paperCards.filter(p => p.id !== id);
    updatePaperCards();
    if (paperCards.length) detail.querySelector('.card-title').focus({ preventScroll: true });
    else graph.nodeById[id]?.gEl.focus({ preventScroll: true });
  }
  if (PAGE === 'graph') new ResizeObserver(() => {
    const front = detail.firstElementChild;
    if (front) front.style.maxHeight = Math.max(80, detail.parentElement.clientHeight - 40 - (paperCards.length - 1) * 44) + 'px';
  }).observe(detail.parentElement);
  function renderDetail(node) {
    if (!detail) return;
    selectedId = node?.id || null;
    if (window.CitationPage) window.CitationPage.selectedId = selectedId;
    if (node) {
      try { sessionStorage.setItem('citation-selected', JSON.stringify({ seedId: CURRENT.seedId, paperId: node.id })); } catch (_) {}
    }
    if (PAGE === 'graph') {
      paperCards = node ? [node, ...paperCards.filter(p => p.id !== node.id)].slice(0, 4) : [];
      updatePaperCards();
      return;
    }
    if (!node) { detail.classList.add("closed"); return; }
    detail.classList.remove("closed");
    detail.querySelector(".role").className = "role " + node.role;
    detail.querySelector(".role").textContent = roleLabel[node.role];
    $("d-title").textContent = node.title;
    $("d-title").hidden = false;
    $("detail-close").hidden = PAGE === "paper";
    $("d-authors").textContent = node.authors;
    $("d-venue").textContent = `${node.venue} · ${node.year}`
      + (node.journalIF ? `  ·  journal impact factor: ${node.journalIF.toFixed(1)}` : "");
    const link = $("d-link");
    const href = node.url || (node.id ? "https://openalex.org/" + node.id : null);
    if (href) {
      link.href = href; link.style.display = "";
      const host = (() => { try { return new URL(href).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })();
      link.firstChild.textContent = (!host || host === "doi.org") ? "View at publisher " : `View on ${host} `;
    } else {
      link.style.display = "none";
    }

    const nb = CURRENT.neighbors[node.id] || [];
    const refs = nb.filter(n => n.dir === "cites");
    const cited = nb.filter(n => n.dir === "citedby");
    $("d-cites").textContent = fmt(node.cites);
    $("d-refs").textContent = refs.length;
    $("d-citedhere").textContent = cited.length;
    const abEl = $("d-abstract");
    if (node.abstract == null) {
      // Lite fetch — abstract wasn't loaded with the graph; pull it on demand.
      abEl.textContent = "Loading abstract\u2026";
      abEl.classList.add("loading");
      OpenAlex.abstractFor(node.id).then(text => {
        node.abstract = text;
        // Only write if this paper is still the one on screen.
        if (selectedId === node.id) { abEl.textContent = text; abEl.classList.remove("loading"); }
      }).catch(() => {
        node.abstract = "No abstract available from OpenAlex.";
        if (selectedId === node.id) { abEl.textContent = node.abstract; abEl.classList.remove("loading"); }
      });
    } else {
      abEl.textContent = node.abstract;
      abEl.classList.remove("loading");
    }

    const mk = n => {
      const p = CURRENT.byId[n.id]; if (!p) return "";
      return `<div class="conn" data-id="${p.id}">
        <span class="bullet ${p.role}"></span>
        <span><span class="ct">${esc(p.title)}</span>
        <span class="cm">${esc(p.short)} · ${p.year}</span></span></div>`;
    };
    let html = "";
    if (refs.length) html += `<span class="lbl">References in graph — ${refs.length}</span>` + refs.map(mk).join("");
    if (cited.length) html += `<span class="lbl">Cited by ${cited.length} in this graph</span>` + cited.map(mk).join("");
    if (!refs.length && !cited.length) html += `<span class="lbl">Connections</span><p class="abstract">No links to other papers in the current view.</p>`;
    $("d-conns").innerHTML = html;
    $("d-conns").querySelectorAll(".conn").forEach(c => c.addEventListener("click", () => graph ? graph.focusNode(c.dataset.id) : renderDetail(CURRENT.byId[c.dataset.id])));

    $("d-recenter").onclick = () => { const p = CURRENT.byId[node.id]; if (p) loadSeed(p); };
  }

  /* ---------------- list view ---------------- */
  function renderList() {
    const tb = $("papers-body");
    const exp = $("export-bib");
    if (exp) exp.disabled = !CURRENT.seedId || !CURRENT.papers.length;
    if (!CURRENT.seedId) { tb.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--ink-faint);font-family:var(--mono);font-size:13px">No graph loaded yet — search a paper first.</td></tr>`; $("list-seed").textContent = ""; return; }
    const m = CURRENT.meta;
    $("list-seed").textContent =
      `${CURRENT.papers.length} papers · ${CURRENT.edges.length} links · top ${m.citingShown} of ${fmt(m.citingTotal)} citing`;

    const linkCount = p => (CURRENT.neighbors[p.id] || []).length;
    const base = (a, b) => {
      if (sortKey === "year") return (a.year || 0) - (b.year || 0);
      if (sortKey === "cites") return a.cites - b.cites;
      if (sortKey === "links") return linkCount(a) - linkCount(b);
      const o = { seed: 0, ref: 1, linked: 2, cite: 3 }; // role
      return (o[a.role] - o[b.role]) || (b.cites - a.cites);
    };
    const dir = sortDir === "asc" ? 1 : -1;
    const rows = CURRENT.papers.slice()
      .filter(p => !typeFilter || p.type === typeFilter)
      .sort((a, b) => base(a, b) * dir);
    const existingRows = new Map([...tb.querySelectorAll('tr[data-id]')].map(row=>[row.dataset.id,row]));
    tb.querySelectorAll('tr:not([data-id])').forEach(row=>row.remove());
    const keep = new Set(rows.map(p=>p.id));
    for(const [id,row] of existingRows) if(!keep.has(id)) row.remove();
    rows.forEach((p,index) => {
      const nb = CURRENT.neighbors[p.id] || [];
      const refs = nb.filter(n => n.dir === "cites").length;
      const cited = nb.filter(n => n.dir === "citedby").length;
      const html = `<tr data-id="${p.id}" tabindex="0" aria-label="Open summary: ${esc(p.title)}">
        <td><div class="pt">${esc(p.title)}</div><div class="pa">${esc(p.authors)}</div></td>
        <td><span class="rolepill ${p.role}">${roleLabel[p.role]}</span></td>
        <td class="venue mono" style="font-size:11.5px;color:var(--ink-soft)">${esc(p.venue)}</td>
        <td class="num"><span class="mono">${p.year}</span></td>
        <td class="num"><span class="mono">${fmt(p.cites)}</span></td>
        <td class="num"><span class="mono" style="color:var(--ink-soft)">${refs}↓ ${cited}↑</span></td>
      </tr>`.replace(/(<td\b[^>]*>)/g, '$1<div class="list-cell">').replace(/<\/td>/g, '</div></td>');
      let row=existingRows.get(p.id);
      if(!row) { const template=document.createElement('template'); template.innerHTML=html; row=template.content.firstElementChild; row._html=html; }
      else if(row._html!==html) { const template=document.createElement('template'); template.innerHTML=html; row.replaceChildren(...template.content.firstElementChild.childNodes); row._html=html; }
      row.classList.toggle('selected',p.id===selectedId);
      if(tb.children[index]!==row) tb.insertBefore(row,tb.children[index]||null);
    });
    if (!rows.length) tb.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--ink-faint);font-family:var(--mono);font-size:13px">No papers of this type in the graph.</td></tr>`;
    if(!tb._wired) {
      tb._wired=true;
      const select = event => {
        if(event.type==='keydown' && event.key!=='Enter' && event.key!==' ') return;
        const row=event.target.closest('tr[data-id]'); if(!row) return;
        if(event.type==='keydown') event.preventDefault();
        renderDetail(CURRENT.byId[row.dataset.id]);
        tb.querySelectorAll('tr.selected').forEach(el=>el.classList.remove('selected')); row.classList.add('selected');
      };
      tb.addEventListener('click',select); tb.addEventListener('keydown',select);
    }
    document.querySelectorAll(".list-sort button").forEach(b => {
      const active = b.dataset.sort === sortKey;
      b.classList.toggle("active", active);
      b.setAttribute("data-dir", active ? (sortDir === "asc" ? "↑" : "↓") : "");
    });
  }

  // Fill the type dropdown with the paper types present in the current graph.
  function populateTypeFilter() {
    const sel = $("type-filter");
    if (!sel) return;
    const types = [...new Set(CURRENT.papers.map(p => p.type).filter(Boolean))].sort();
    typeFilter = "";
    sel.innerHTML = `<option value="">All types</option>` +
      types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  }

  document.querySelectorAll(".list-sort button").forEach(b =>
    b.addEventListener("click", () => {
      const k = b.dataset.sort;
      if (k === sortKey) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = k; sortDir = (k === "role") ? "asc" : "desc"; }
      renderList();
    }));
  document.getElementById("type-filter")?.addEventListener("change", e => { typeFilter = e.target.value; renderList(); });

  /* ---------------- BibTeX export ---------------- */
  // Map OpenAlex display types to BibTeX entry types.
  function bibEntryType(t) {
    const s = (t || "").toLowerCase();
    if (s.includes("book chapter") || s.includes("chapter")) return "incollection";
    if (s.includes("book")) return "book";
    if (s.includes("dissertation") || s.includes("thesis")) return "phdthesis";
    if (s.includes("dataset") || s.includes("report") || s.includes("other")) return "misc";
    if (s.includes("conference") || s.includes("proceedings")) return "inproceedings";
    return "article";
  }

  // Strip braces / illegal chars from a BibTeX cite key.
  function keyToken(s) {
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]/g, "");
  }

  function authorsToBib(authors) {
    if (!authors || authors === "Unknown authors") return null;
    return authors.split(", ")
      .map(a => a.trim() === "et al." ? "others" : a.trim())
      .filter(Boolean)
      .join(" and ");
  }

  function toBibEntry(p, key) {
    const lines = [];
    const F = (k, v) => { if (v != null && v !== "" && v !== "—") lines.push(`  ${k} = {${v}}`); };
    F("title", p.title);
    F("author", authorsToBib(p.authors));
    F("year", p.year);
    const et = bibEntryType(p.type);
    if (et === "incollection" || et === "inproceedings") F("booktitle", p.venue);
    else F("journal", p.venue);
    if (p.doi) F("doi", String(p.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
    if (p.url) F("url", p.url);
    F("note", `OpenAlex ${p.id}`);
    return `@${et}{${key},\n${lines.join(",\n")}\n}`;
  }

  function buildBib(papers) {
    const seen = {};
    return papers.map(p => {
      const lead = keyToken((p.short || p.authors || "Anon").split(/[ ,]/)[0]) || "Anon";
      let key = `${lead}${p.year && p.year !== "—" ? p.year : ""}`;
      if (seen[key] != null) { seen[key]++; key += String.fromCharCode(96 + seen[key]); }
      else seen[key] = 0;
      return toBibEntry(p, key);
    }).join("\n\n") + "\n";
  }

  const exportBtn = $("export-bib");
  if (exportBtn) exportBtn.addEventListener("click", () => {
    if (!CURRENT.seedId || !CURRENT.papers.length) return;
    // Export exactly what the list currently shows (respects the type filter).
    const papers = CURRENT.papers.filter(p => !typeFilter || p.type === typeFilter);
    if (!papers.length) return;
    const bib = buildBib(papers);
    const seed = CURRENT.byId[CURRENT.seedId];
    const fname = "citegraph-" + (keyToken((seed && seed.short || "references").split(/[ ,]/)[0]) || "references").toLowerCase() + ".bib";
    const blob = new Blob([bib], { type: "application/x-bibtex;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  /* ---------------- offline sample fallback ---------------- */
  async function loadSample() {
    if (loadController) loadController.abort();
    ++netSeq; loading = true;
    ensureGraph(); graph.cancelLayout();
    const papers = window.PAPERS, edges = window.EDGES, seedId = window.SEED_ID;
    const role = { [seedId]: "seed" };
    edges.forEach(e => { if (e.s === seedId) role[e.t] = role[e.t] || "ref"; if (e.t === seedId) role[e.s] = role[e.s] || "cite"; });
    const withRoles = papers.map(p => ({ ...p, role: role[p.id] || "ref", refs: edges.filter(e => e.s === p.id).map(e => e.t) }));
    await applyNetwork({
      papers: withRoles, edges, seedId,
      refShown: edges.filter(e => e.s === seedId).length,
      citingShown: edges.filter(e => e.t === seedId).length,
      citingTotal: edges.filter(e => e.t === seedId).length
    });
    $("status-counts").textContent += " · sample data";
    loading = false; hideLoader();
  }

  /* ---------------- helpers ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* Each document boots only its own page. Home never reads a seed or starts a graph. */
  function closeDetail() {
    if (graph) {
      const node = graph.nodeById[graph.selected];
      closePaperCard(graph.selected);
      node?.cEl?.closest('.gnode')?.focus({ preventScroll: true });
    } else renderDetail(null);
  }
  $('detail-close')?.addEventListener('click', closeDetail);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && PAGE === 'graph' && detail && !detail.hidden && !$('graph-options')?.open) { event.preventDefault(); closeDetail(); }
  });
  const initialDensity = params.get('density') || remembered?.density;
  if (['40','80','120'].includes(String(initialDensity))) citeLimit = +initialDensity;
  buildSearch(); wireControls(); updateNavigation();
  window.addEventListener('pageshow', event => {
    try { remembered = JSON.parse(sessionStorage.getItem('citation-current') || 'null'); } catch (_) {}
    if (PAGE === 'search' && ['40','80','120'].includes(String(remembered?.density))) citeLimit = +remembered.density;
    updateNavigation();
    if (event.persisted && resumeSearch && PAGE === 'search') { resumeSearch = false; doSearch(); }
    if (event.persisted && resumeLoad && PAGE !== 'search') { resumeLoad = false; const id = CURRENT.seedId || sharedSeed || remembered?.seedId; if (id) loadSeedById(id, citeLimit); }
  });
  window.addEventListener('pagehide', () => {
    try {
      if (graph?.nodes.length && !loading) sessionStorage.setItem('citation-graph-view', JSON.stringify({
        seedId: CURRENT.seedId, density: citeLimit, width: graph.W, height: graph.H,
        scale: graph.scale, tx: graph.tx, ty: graph.ty,
        spacing: graph.spacing, bondStrength: graph.bondStrength, positions: graph.nodes.map(n => ({id:n.id,x:n.x+(n._ox||0),y:n.y+(n._oy||0),userPinned:!!n.userPinned})), cards: paperCards.map(p=>p.id)
      }));
      if (PAGE === 'search') sessionStorage.setItem('citation-search-view', JSON.stringify({
        query: $('big-input').value, mode: $('search-mode').value, sort: $('search-sort').value,
        author: selectedAuthor, rows: searchRows, page: searchPageNumber, key: searchKey, scroll: $('view-search').scrollTop,
        more: !$('search-more').hidden, status: $('search-results').getAttribute('aria-busy') === 'true' ? 'Previous results — press Enter to update.' : $('search-status').textContent
      }));
    } catch (_) {}
    clearTimeout(layoutTimer); layoutRequest++;
    resumeSearch = PAGE === 'search' && $('search-results').getAttribute('aria-busy') === 'true';
    resumeLoad = loading;
    loadController?.abort(); graph?.cancelLayout(); cancelSearch();
  });
  if (PAGE !== 'search') {
    const id = sharedSeed || remembered?.seedId;
    if (id) loadSeedById(id, params.get('density') || remembered?.density);
    else {
      if (PAGE === 'list') renderList();
      setLoader('empty', 'Choose a paper to begin', '<a href="index.html">Go to Search →</a>');
    }
  }
})();
