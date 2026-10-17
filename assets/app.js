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
    window.CG = graph;
    if (window.applyAppearance) window.applyAppearance();
  }

  /* ---------------- inline search ---------------- */
  let searchTimer = null, searchController = null, searchSeq = 0;
  let searchPageNumber = 1, searchRows = [], selectedAuthor = null, retryMore = false, searchKey = '';
  function cancelSearch() {
    clearTimeout(searchTimer); searchSeq++;
    searchController?.abort();
  }
  function renderSearchRows(rows, authors) {
    const box = $('search-results');
    const focusedId = box.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    box.innerHTML = rows.map(p => authors ? `
      <button type="button" class="presult author-result" data-id="${esc(p.id)}">
        <div><div class="pt">${esc(p.name)}</div><div class="pm">${esc(p.institution || 'Affiliation unavailable')}</div><div class="pm">${esc(p.orcid ? 'ORCID ' + p.orcid.split('/').pop() : '')}</div></div>
        <div class="pc">${fmt(p.works || 0)}<small>works</small></div>
      </button>` : `
      <button type="button" class="presult" data-id="${esc(p.id)}">
        <div><div class="pt">${esc(p.title)}</div><div class="result-authors">${esc(p.authors)}</div><div class="pm">${esc(p.year)} · ${esc(p.venue)}</div></div>
        <div class="pc">${fmt(p.cites)}<small>citations</small></div>
      </button>`).join('');
    const byId = new Map(rows.map(p => [p.id, p]));
    box.querySelectorAll('.presult').forEach(button => button.addEventListener('click', () => {
      const item = byId.get(button.dataset.id);
      if (authors) { selectedAuthor = item; doSearch(); }
      else { cancelSearch(); loadSeed(item); }
    }));
    if (focusedId) [...box.children].find(el => el.dataset.id === focusedId)?.focus({ preventScroll: true });
  }
  async function doSearch(loadMore = false) {
    if (!$('big-input')) return;
    cancelSearch();
    const seq = searchSeq, term = $('big-input').value.trim();
    const status = $('search-status'), box = $('search-results'), more = $('search-more');
    more.hidden = true; $('search-retry').hidden = true; box.setAttribute('aria-busy', 'false');
    if (!term) {
      searchRows = []; selectedAuthor = null; box.replaceChildren(); status.textContent = '';
      $('author-back').hidden = true; $('search-source').hidden = true;
      document.body.classList.remove('has-search'); return;
    }
    const from = $('search-from'), to = $('search-to');
    if (!from.validity.valid || !to.validity.valid || (from.value && to.value && +from.value > +to.value)) {
      status.textContent = 'Enter a valid year range, with the start year before the end year.'; return;
    }
    const key = JSON.stringify([term, $('search-mode').value, from.value, to.value, selectedAuthor?.id]);
    if (key !== searchKey) loadMore = false;
    const authors = $('search-mode').value === 'authors' && !selectedAuthor;
    const page = loadMore ? searchPageNumber + 1 : 1;
    const previous = loadMore ? searchRows.slice() : [];
    searchController = new AbortController();
    const options = { signal: searchController.signal, page, mode: $('search-mode').value,
      yearFrom: from.value, yearTo: to.value, authorId: selectedAuthor?.id };
    document.body.classList.add('has-search');
    box.setAttribute('aria-busy', 'true');
    $('author-back').hidden = !selectedAuthor;
    status.textContent = loadMore ? 'Loading more results…' : selectedAuthor ? `Finding papers by ${selectedAuthor.name}…` : searchRows.length ? 'Updating results… Previous results remain below.' : 'Searching…';
    retryMore = loadMore;
    const apply = result => {
      if (seq !== searchSeq) return;
      const unique = new Map(previous.map(p => [p.id, p]));
      result.results.forEach(p => unique.set(p.id, p));
      searchRows = [...unique.values()]; searchKey = key;
      renderSearchRows(searchRows, authors);
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
        : authors ? 'No authors found. Try a full name or a different spelling.' : result.exact ? 'That DOI was not found, or is outside your year range.' : 'No papers found. Try fewer words, a DOI, or a wider year range.';
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
  let loading = false;
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
  async function startLoad(resolveSeed, title) {
    if (loadController) loadController.abort();
    loadController = new AbortController();
    const signal = loadController.signal, seq = ++netSeq;
    loading = true;
    if (PAGE === 'graph') { ensureGraph(); graph.cancelLayout(); }
    setLoader('loading', title, 'Fetching paper details from OpenAlex');
    let directShown = false;
    try {
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
    return startLoad(options => OpenAlex.byId(id, options), 'Opening shared graph…');
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

    const applied = graph ? await graph.setData(net.papers, net.edges, net.seedId, { preserve }) : true;
    if (!applied || seq !== netSeq || (signal && signal.aborted)) return;
    populateTypeFilter();

    // Journal impact factor loads in the background — it only refines node
    // sizes, so we never block the first paint on it. Patch sizes in when it arrives.
    OpenAlex.sourceImpact(net.papers.map(p => p.sourceId), { signal }).then(ifIdx => {
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
    if (!preserve && graph) graph.select(null);
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
    const schedule = () => {
      cancelSearch(); selectedAuthor = null;
      if (!input.value.trim()) { doSearch(); return; }
      searchTimer = setTimeout(() => doSearch(), 450);
    };
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
      $('search-hint').textContent = authors ? 'Choose an author to explore their publications. Year filters apply to their papers.' : 'Find a paper by title, topic, or DOI. Choose Authors to find someone’s publications.';
      doSearch();
    });
    for (const id of ['search-from', 'search-to']) $(id).addEventListener('change', () => doSearch());
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
    $("zoom-in")?.addEventListener("click", () => graph && graph.zoomBy(1.25));
    $("zoom-out")?.addEventListener("click", () => graph && graph.zoomBy(0.8));
    $("zoom-fit")?.addEventListener("click", () => graph && graph.fit());
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
    const old = new Map([...detail.children].map(card => [card.dataset.id, card.getBoundingClientRect().top]));
    const existing = new Map([...detail.children].map(card => [card.dataset.id, card]));
    detail.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    detail.hidden = !paperCards.length;
    renderTooltip(null);
    for (const [index, paper] of paperCards.entries()) {
      let card = existing.get(paper.id);
      if (!card) {
        card = document.createElement('article');
        card.className = 'node-popup paper-card'; card.dataset.id = paper.id;
        card.innerHTML = '<button class="popup-close" type="button" title="Close">×</button><h2><button class="card-title" type="button"></button></h2><div class="card-body"><p class="card-authors"></p><p class="popup-meta"><span class="card-year"></span><span class="card-venue"></span></p><a class="card-link" target="_blank" rel="noopener noreferrer"></a></div>';
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
    for (const [id, card] of existing) if (!paperCards.some(p => p.id === id)) card.remove();
    graph.selectedIds = new Set(paperCards.map(p => p.id));
    graph.selected = selectedId = paperCards[0]?.id || null;
    if (window.CitationPage) window.CitationPage.selectedId = selectedId;
    graph._invalidate();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const card of detail.children) {
        const previous = old.get(card.dataset.id);
        card.getAnimations().forEach(animation => animation.cancel());
        const offset = previous == null ? -16 : previous - card.getBoundingClientRect().top;
        card.animate([{ transform: `translateY(${offset}px)`, opacity: previous == null ? 0 : 1 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
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
    tb.innerHTML = rows.map(p => {
      const nb = CURRENT.neighbors[p.id] || [];
      const refs = nb.filter(n => n.dir === "cites").length;
      const cited = nb.filter(n => n.dir === "citedby").length;
      return `<tr data-id="${p.id}" tabindex="0" aria-label="Open summary: ${esc(p.title)}">
        <td><div class="pt">${esc(p.title)}</div><div class="pa">${esc(p.authors)}</div></td>
        <td><span class="rolepill ${p.role}">${roleLabel[p.role]}</span></td>
        <td class="venue mono" style="font-size:11.5px;color:var(--ink-soft)">${esc(p.venue)}</td>
        <td class="num"><span class="mono">${p.year}</span></td>
        <td class="num"><span class="mono">${fmt(p.cites)}</span></td>
        <td class="num"><span class="mono" style="color:var(--ink-soft)">${refs}↓ ${cited}↑</span></td>
      </tr>`;
    }).join("");
    if (!rows.length) tb.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:var(--ink-faint);font-family:var(--mono);font-size:13px">No papers of this type in the graph.</td></tr>`;
    tb.querySelectorAll('tr[data-id]').forEach(tr => {
      const select = () => { renderDetail(CURRENT.byId[tr.dataset.id]); tb.querySelectorAll('tr').forEach(row => row.classList.toggle('selected', row === tr)); };
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
    });
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
    if (event.key === 'Escape' && PAGE === 'graph' && detail && !detail.hidden) { event.preventDefault(); closeDetail(); }
  });
  const initialDensity = params.get('density') || remembered?.density;
  if (['40','80','120'].includes(String(initialDensity))) citeLimit = +initialDensity;
  buildSearch(); wireControls(); updateNavigation();
  window.addEventListener('pageshow', () => {
    try { remembered = JSON.parse(sessionStorage.getItem('citation-current') || 'null'); } catch (_) {}
    if (PAGE === 'search' && ['40','80','120'].includes(String(remembered?.density))) citeLimit = +remembered.density;
    updateNavigation();
  });
  window.addEventListener('pagehide', () => { loadController?.abort(); graph?.cancelLayout(); cancelSearch(); });
  if (PAGE !== 'search') {
    const id = sharedSeed || remembered?.seedId;
    if (id) loadSeedById(id, params.get('density') || remembered?.density);
    else {
      if (PAGE === 'list') renderList();
      setLoader('empty', 'Choose a paper to begin', '<a href="index.html">Go to Search →</a>');
    }
  }
})();
