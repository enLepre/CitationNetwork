/* ============================================================
   App wiring — live OpenAlex data
   Router · search picker · graph loading · detail · list
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
      onSelect: node => renderDetail(node || CURRENT.byId[CURRENT.seedId]),
      onHover: (node, x, y) => renderTooltip(node, x, y)
    });
    window.CG = graph;
    if (window.applyAppearance) window.applyAppearance();
  }

  /* ---------------- picker modal ---------------- */
  const picker = $("picker");
  let pickerSeq = 0;
  function openPicker(prefill) {
    cancelSearch();
    if (!picker) return;
    picker.hidden = false;
    const inp = $("picker-input");
    inp.value = prefill || "";
    setTimeout(() => inp.focus(), 30);
    if (prefill && prefill.trim()) doSearch(prefill);
    else $("picker-results").innerHTML = `<div class="picker-msg">Type a paper title, author, or DOI to begin.</div>`;
  }
  let searchController = null;
  function cancelSearch() {
    clearTimeout(searchTimer); pickerSeq++;
    if (searchController) searchController.abort();
  }
  function closePicker() { if (!picker) return; picker.hidden = true; cancelSearch(); }
  $("picker-close")?.addEventListener("click", closePicker);
  $("picker-backdrop")?.addEventListener("click", closePicker);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && picker && !picker.hidden) closePicker(); });

  let searchTimer = null;
  $("picker-input")?.addEventListener("input", e => {
    cancelSearch();
    const q = e.target.value;
    if (!q.trim()) { $("picker-results").innerHTML = `<div class="picker-msg">Type a paper title, author, or DOI to begin.</div>`; return; }
    searchTimer = setTimeout(() => doSearch(q), 350);
  });
  $("picker-input")?.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(searchTimer); doSearch(e.target.value); } });

  async function doSearch(q) {
    cancelSearch();
    if (!q.trim()) return;
    const seq = pickerSeq;
    searchController = new AbortController();
    const box = $("picker-results");
    box.innerHTML = `<div class="picker-msg"><div class="spin-inline"></div>Searching OpenAlex…</div>`;
    try {
      const results = await OpenAlex.search(q, { signal: searchController.signal });
      if (seq !== pickerSeq) return; // stale
      if (!results.length) { box.innerHTML = `<div class="picker-msg">No papers found for “${esc(q)}”. Try a different title or a DOI.</div>`; return; }
      box.innerHTML = results.map((p, i) => `
        <button type="button" class="presult" data-i="${i}">
          <div>
            <div class="pt">${esc(p.title)}</div>
            <div class="pm">${p.year} · ${esc(p.venue)}</div>
          </div>
          <div class="pc">${fmt(p.cites)}<small>citations</small></div>
        </button>`).join("");
      box.querySelectorAll(".presult").forEach(row =>
        row.addEventListener("click", () => { closePicker(); loadSeed(results[+row.dataset.i]); }));
    } catch (err) {
      if (err.name === "AbortError" || seq !== pickerSeq) return;
      box.innerHTML = `<div class="picker-msg">Couldn’t reach OpenAlex.<br>${esc(err.message || "Network error")}</div>`;
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

  function loadSeed(seed) { if (PAGE !== 'graph') { location.assign(pageUrl('graph', seed.id)); return; } return startLoad(() => Promise.resolve(seed), 'Building citation graph…'); }
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
    $("seed-title").textContent = seed.title;
    document.title = seed.title + (PAGE === "graph" ? " — Graph" : " — List");
    $("status-counts").textContent =
      `${net.refShown} references · top ${net.citingShown} of ${fmt(net.citingTotal)} citing` +
      (net.linkedShown ? ` · ${net.linkedShown} co-cited` : "");
    if (!preserve && graph) graph.select(null);
    if (PAGE === "list") renderList();
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
    if (!$("big-input")) return;
    const go = () => openPicker($("big-input").value);
    $("big-go").addEventListener("click", go);
    $("big-input").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  }

  /* ---------------- graph controls ---------------- */
  function wireControls() {
    if (PAGE !== "graph") return;
    const tRef = $("toggle-ref"), tCite = $("toggle-cite"), tLinked = $("toggle-linked");
    tRef.addEventListener("click", () => {
      const on = tRef.getAttribute("aria-pressed") === "true";
      tRef.setAttribute("aria-pressed", String(!on)); ensureGraph(); graph.setFilter({ showRefs: !on });
    });
    tCite.addEventListener("click", () => {
      const on = tCite.getAttribute("aria-pressed") === "true";
      tCite.setAttribute("aria-pressed", String(!on)); ensureGraph(); graph.setFilter({ showCites: !on });
    });
    tLinked.addEventListener("click", () => {
      const on = tLinked.getAttribute("aria-pressed") === "true";
      tLinked.setAttribute("aria-pressed", String(!on)); ensureGraph(); graph.setFilter({ showLinked: !on });
    });
    $("zoom-in").addEventListener("click", () => graph && graph.zoomBy(1.25));
    $("zoom-out").addEventListener("click", () => graph && graph.zoomBy(0.8));
    $("zoom-fit").addEventListener("click", () => graph && graph.fit());

  }

  /* ---------------- tooltip ---------------- */
  const tip = $('gtooltip');
  let tipNode = null, tipFrame = null, tipPoint = null, tipWidth = 0, tipHeight = 0;
  function renderTooltip(node, x, y) {
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
  function renderDetail(node) {
    if (!detail) return;
    selectedId = node?.id || null;
    if (window.CitationPage) window.CitationPage.selectedId = selectedId;
    if (!node) { detail.classList.add("closed"); return; }
    detail.classList.remove("closed");
    detail.querySelector(".role").className = "role " + node.role;
    detail.querySelector(".role").textContent = roleLabel[node.role];
    $("d-title").textContent = node.title;
    $("d-title").hidden = PAGE === "graph" && node.id === CURRENT.seedId;
    $("detail-close").hidden = PAGE === "graph" && (!graph.selected || node.id === CURRENT.seedId);
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
  $('detail-close')?.addEventListener('click', () => {
    if (graph) graph.select(null); else renderDetail(null);
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
