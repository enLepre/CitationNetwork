/* ============================================================
   CitationGraph — force-directed SVG graph engine
   Vanilla JS. Hover / select / drag nodes, pan, zoom, filter.
   Renders to SVG (inspectable + screenshot-able). Colors read
   from CSS custom properties so Tweaks recolor live.
   Edge {s,t} means paper s cites paper t.
   ============================================================ */
(function () {
  const SVGNS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const workerUrl = new URL("layout-worker.js", document.currentScript.src);

  class CitationGraph {
    constructor(svg, opts) {
      this.svg = svg;
      this.opts = opts || {};
      this.onSelect = this.opts.onSelect || function () {};
      this.onHover = this.opts.onHover || function () {};

      this.vp = el("g", { class: "vp" });          // viewport (pan/zoom)
      this.edgeLayer = el("g", { class: "edges" });
      // Expanded targets sit behind the visible circles, so a nearby target
      // never steals a click directly on another paper.
      this.hitLayer = el('g', { class: 'node-hit-layer' });
      this.nodeLayer = el("g", { class: "nodes" });
      this.vp.appendChild(this.edgeLayer);
      this.vp.appendChild(this.hitLayer);
      this.vp.appendChild(this.nodeLayer);
      this.svg.appendChild(this.vp);

      this.nodes = []; this.edges = []; this.nodeById = {};
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.hovered = null; this.selected = null;
      this.dragNode = null; this.dragMoved = false; this.panning = false;
      this._pointerId = null;
      this.showRefs = true; this.showCites = true; this.showLinked = true; this.showLabels = true; this.linkOpacity = 1;
      this._nodeScale = 1;

      this._bind();
      this._active = true;
      this._layoutSeq = 0;
      this._frame = null;
      this._dirty = {};
      this._width = svg.clientWidth;
      this._height = svg.clientHeight;
      this._labelFamily = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
      this._measure = document.createElement('canvas').getContext('2d');
      this.ready = Promise.resolve();
      this._resizeObserver = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (!width || !height || (width === this._width && height === this._height)) return;
        this._width = width; this._height = height;
        if (this._active && this.nodes.length) this.fit();
      });
      this._resizeObserver.observe(svg);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this._invalidate(); });
      document.fonts.ready.then(() => { this.nodes.forEach(n => { n.labelWidth = null; }); this._invalidate(); });
    }

    get W() { return this._width || this.svg.clientWidth || this.svg.parentNode.clientWidth; }
    get H() { return this._height || this.svg.clientHeight || this.svg.parentNode.clientHeight; }

    /* ---------- data ---------- */
    async setData(papers, edges, seedId, { preserve = false } = {}) {
      const previous = preserve && this.seedId === seedId ? this.nodeById : {};
      const selected = preserve ? this.selected : null;
      this.cancelLayout();
      const seq = this._layoutSeq;
      this.seedId = seedId;
      this._endPointer(null, true);
      this.hovered = null; this.dragNode = null;
      const cx = this.W / 2, cy = this.H / 2;

      const role = { [seedId]: "seed" };
      edges.forEach(e => {
        if (e.s === seedId) role[e.t] = role[e.t] || "ref";
        if (e.t === seedId) role[e.s] = role[e.s] || "cite";
      });

      // wipe DOM
      this.edgeLayer.textContent = ""; this.hitLayer.textContent = ''; this.nodeLayer.textContent = "";

      // count in-graph cross-citations (how many graph papers cite each paper)
      // — this drives node size, so hubs stand out strongly from leaves.
      const pset = new Set(papers.map(p => p.id));
      const citedHere = {};
      edges.forEach(e => {
        if (e.s !== e.t && pset.has(e.s) && pset.has(e.t)) citedHere[e.t] = (citedHere[e.t] || 0) + 1;
      });

      this.nodes = papers.map((p, i) => {
        const r = p.role || role[p.id] || "ref";
        const ang = (i / papers.length) * Math.PI * 2;
        const rad = p.id === seedId ? 0 : 220 + (i % 5) * 26;
        const ch = citedHere[p.id] || 0;
        const rr = this._radius(r, ch, p.journalIF) * this._nodeScale;
        const old = previous[p.id];
        return {
          ...p, role: r, citedHere: ch,
          x: old ? old.x : cx + Math.cos(ang) * rad,
          y: old ? old.y : cy + Math.sin(ang) * rad,
          fixed: !!old || p.id === seedId,
          vx: 0, vy: 0, baseR: rr / this._nodeScale, rad: rr
        };
      });
      this.nodeById = {};
      this.nodes.forEach(n => (this.nodeById[n.id] = n));

      this.adj = {};
      this.nodes.forEach(n => (this.adj[n.id] = new Set()));
      this.edges = edges.filter(e => this.nodeById[e.s] && this.nodeById[e.t]).map(e => {
        this.adj[e.s].add(e.t); this.adj[e.t].add(e.s);
        let kind = "cross";
        if (e.s === seedId) kind = "ref";
        else if (e.t === seedId) kind = "cite";
        const path = el("path", { class: "gedge", fill: "none" });
        this.edgeLayer.appendChild(path);
        return { s: e.s, t: e.t, kind, path };
      });

      // Degree = number of links. Flag the three most-linked papers (excluding
      // the seed, which is always labelled) so their titles stay visible even
      // when zoomed all the way out.
      this.nodes.forEach(n => { n.degree = this.adj[n.id] ? this.adj[n.id].size : 0; });
      const topHubs = this.nodes
        .filter(n => n.id !== seedId)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 3);
      this.nodes.forEach(n => { n.topHub = false; });
      topHubs.forEach(n => { n.topHub = true; });

      // build node groups
      this.nodes.forEach(n => {
        const g = el("g", { class: "gnode", "data-id": n.id, 'data-paper-id': n.id });
        n.hitEl = el('circle', { class: 'node-hit-target', 'data-paper-id': n.id,
          fill: 'transparent', 'pointer-events': 'all', 'aria-hidden': 'true' });
        this.hitLayer.appendChild(n.hitEl);
        const c = el("circle", { r: n.rad });
        const halo = el("circle", { class: "halo", r: n.rad });
        const t = el("text", { class: "glabel", "text-anchor": "middle" });
        t.textContent = `${shortAuthor(n.short)} ${n.year}`;
        // top-linked hubs are labelled with their (truncated) title
        const tHub = el("text", { class: "glabel ghub", "text-anchor": "middle" });
        tHub.textContent = truncTitle(n.title);
        tHub.style.display = "none";
        g.appendChild(halo); g.appendChild(c); g.appendChild(t); g.appendChild(tHub);
        n.gEl = g; n.cEl = c; n.haloEl = halo; n.tEl = t; n.tHubEl = tHub;
        g.setAttribute('role', 'button');
        g.setAttribute('tabindex', '0');
        g.setAttribute('aria-label', n.title + ', ' + n.short + ', ' + n.year);
        const title = el('title'); title.textContent = n.title; g.appendChild(title);
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.focusNode(n.id); } });
        this._wireNode(n);
        this._wireNode(n, n.hitEl);
        this.nodeLayer.appendChild(g);
      });

      this.selected = selected && this.nodeById[selected] ? selected : null;
      this._invalidate({ positions: true, paint: true, labels: true });
      this.ready = this._layout(seq);
      const positions = await this.ready;
      if (!positions || seq !== this._layoutSeq) return false;
      positions.forEach(p => { const n = this.nodeById[p.id]; if (n && !n.movedDuringLayout) { n.x = p.x; n.y = p.y; } });
      if (!preserve && this._active) this.fit();
      this.onSelect(this.selected ? this.nodeById[this.selected] : null);
      this._invalidate({ positions: true, paint: true, labels: true });
      return true;
    }

    cancelLayout() {
      this._layoutSeq++;
      if (this._cancelWorker) this._cancelWorker();
    }

    async _layout(seq) {
      const input = {
        width: this.W, height: this.H,
        nodes: this.nodes.map(n => ({ id: n.id, role: n.role, rad: n.rad, x: n.x, y: n.y,
          ...(n.fixed ? { fx: n.x, fy: n.y } : {}) })),
        edges: this.edges.map(({ s, t }) => ({ s, t }))
      };
      if (typeof Worker !== 'undefined') {
        try {
          return await new Promise((resolve, reject) => {
            const worker = new Worker(workerUrl);
            const finish = () => { worker.terminate(); this._cancelWorker = null; };
            this._cancelWorker = () => { finish(); resolve(null); };
            worker.onmessage = ({ data }) => { finish(); data.error ? reject(new Error(data.error)) : resolve(data.positions); };
            worker.onerror = e => { e.preventDefault(); finish(); reject(new Error('Worker unavailable')); };
            worker.postMessage(input);
          });
        } catch (error) { /* CSP or file URLs may block workers; yield between fallback batches. */ }
      }
      if (seq !== this._layoutSeq) return null;
      return CitationLayout.layout(input, () => seq !== this._layoutSeq);
    }

    // Node radius. Seed is fixed-large. Every other paper takes the LARGER of
    // two signals: its in-graph importance (cross-citations) and its journal's
    // impact factor. Journal sizing is calibrated for OpenAlex 2-year mean
    // citedness, where a top multidisciplinary journal (IF≈18) reads large,
    // a strong specialist venue (IF≈6) lands medium, and routine journals
    // (IF≈2) read small. Co-cited papers, rarely cross-cited here, are sized
    // by journal impact alone.
    _radius(role, citedHere, journalIF) {
      if (role === "seed") return 32;
      const cross = Math.min(26, Math.sqrt(citedHere || 0) * 6.8);
      const jour = Math.min(24, Math.sqrt(journalIF || 0) * 4.6);
      if (role === "linked") return 8 + jour;
      return 7 + Math.max(cross, jour);
    }

    _palette() {
      const style = getComputedStyle(document.documentElement);
      const read = name => style.getPropertyValue('--' + name).trim();
      return { seed: read('seed'), ref: read('ref'), cite: read('cite'), linked: read('linked'),
        ink: read('ink'), line: read('line'), bg: read('bg'), faint: read('ink-faint') };
    }
    _color(role, p) {
      return role === 'seed' ? p.seed : role === 'cite' ? p.cite : role === 'linked' ? (p.linked || p.ref) : p.ref;
    }

    _visible(n) {
      if (n.role === "seed") return true;
      if (n.role === "ref" && !this.showRefs) return false;
      if (n.role === "cite" && !this.showCites) return false;
      if (n.role === "linked" && !this.showLinked) return false;
      return true;
    }

    setFilter(opts) {
      if ("showRefs" in opts) this.showRefs = opts.showRefs;
      if ("showCites" in opts) this.showCites = opts.showCites;
      if ("showLinked" in opts) this.showLinked = opts.showLinked;
      if ("showLabels" in opts) this.showLabels = opts.showLabels;
      if ("linkOpacity" in opts) this.linkOpacity = opts.linkOpacity;
      this._invalidate({ positions: true, paint: true, labels: true });
    }

    /* ---------- transforms ---------- */
    _toWorld(sx, sy) { return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale]; }
    _applyTransform() {
      this._invalidate({ transform: true, positions: this.scale !== this._renderScale, labels: true });
    }

    fit() {
      const vis = this.nodes.filter(n => this._visible(n));
      if (!vis.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      vis.forEach(n => {
        minX = Math.min(minX, n.x - n.rad); maxX = Math.max(maxX, n.x + n.rad);
        minY = Math.min(minY, n.y - n.rad); maxY = Math.max(maxY, n.y + n.rad);
      });
      const pad = 96, w = this.W, h = this.H;
      const ns = Math.min(2, Math.max(0.08, Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1))));
      this.scale = ns;
      this.tx = w / 2 - ((minX + maxX) / 2) * ns;
      this.ty = h / 2 - ((minY + maxY) / 2) * ns;
      this._applyTransform();
    }

    zoomBy(factor, ox, oy) {
      const w = this.W, h = this.H;
      ox = ox == null ? w / 2 : ox; oy = oy == null ? h / 2 : oy;
      const [wx, wy] = this._toWorld(ox, oy);
      this.scale = Math.min(3, Math.max(0.08, this.scale * factor));
      this.tx = ox - wx * this.scale; this.ty = oy - wy * this.scale;
      this._applyTransform();
    }

    select(id) {
      this.selected = id;
      this.onSelect(id ? this.nodeById[id] : null);
      this._invalidate();
    }

    /* ---------- interaction ---------- */
    _wireNode(n, g = n.gEl) {
      g.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !e.isPrimary || this._pointerId != null) return;
        // Native SVG focus can scroll the graph before pointerup. Focus it
        // explicitly without scrolling, and keep normal keyboard navigation.
        e.preventDefault();
        e.stopPropagation();
        n.gEl.focus({ preventScroll: true });
        this.dragNode = n; this.dragMoved = false;
        const r = this.svg.getBoundingClientRect();
        this._dragStart = { sx: e.clientX - r.left, sy: e.clientY - r.top, x: n.x, y: n.y };
        this._pointerId = e.pointerId;
        this._dragThreshold = e.pointerType === 'touch' ? 8 : 4;
        this.onHover(null);
        this.svg.setPointerCapture(e.pointerId);
      });
      g.addEventListener("pointerenter", e => {
        if (this.dragNode || this.panning) return;
        this.hovered = n; this._invalidate();
        const r = this.svg.getBoundingClientRect();
        this.onHover(n, e.clientX - r.left, e.clientY - r.top);
      });
      g.addEventListener("pointermove", e => {
        if (this.dragNode || this.panning) return;
        const r = this.svg.getBoundingClientRect();
        this.onHover(n, e.clientX - r.left, e.clientY - r.top);
      });
      g.addEventListener("pointerleave", e => {
        if (this.dragNode || this.panning) return;
        if (e.relatedTarget?.closest?.('[data-paper-id]')?.dataset.paperId === n.id) return;
        if (this.hovered === n) { this.hovered = null; this._invalidate(); this.onHover(null); }
      });
    }

    _bind() {
      const svg = this.svg;
      const pos = e => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

      svg.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !e.isPrimary || this._pointerId != null) return;
        e.preventDefault();
        this.panning = true; this.dragMoved = false;
        this._pointerId = e.pointerId;
        this._dragThreshold = e.pointerType === 'touch' ? 8 : 4;
        const [sx, sy] = pos(e);
        this._panStart = [sx, sy, this.tx, this.ty];
        svg.classList.add("grabbing");
        svg.setPointerCapture(e.pointerId);
      });
      svg.addEventListener("pointermove", e => {
        if (e.pointerId !== this._pointerId) return;
        const [sx, sy] = pos(e);
        if (this.dragNode) {
          const start = this._dragStart;
          if (!this.dragMoved && Math.hypot(sx - start.sx, sy - start.sy) < this._dragThreshold) return;
          this.dragNode.x = start.x + (sx - start.sx) / this.scale;
          this.dragNode.y = start.y + (sy - start.sy) / this.scale;
          this.dragNode.vx = 0; this.dragNode.vy = 0;
          this.dragNode.movedDuringLayout = true;
          this.dragMoved = true;
          this._invalidate({ positions: true, labels: true });
        } else if (this.panning) {
          const [s0x, s0y, t0x, t0y] = this._panStart;
          if (!this.dragMoved && Math.hypot(sx - s0x, sy - s0y) < this._dragThreshold) return;
          this.tx = t0x + (sx - s0x); this.ty = t0y + (sy - s0y);
          if (Math.abs(sx - s0x) + Math.abs(sy - s0y) > 3) this.dragMoved = true;
          this._applyTransform();
        }
      });
      svg.addEventListener("pointerup", e => this._endPointer(e));
      svg.addEventListener("pointercancel", e => this._endPointer(e, true));
      svg.addEventListener('lostpointercapture', e => this._endPointer(e, true));

      svg.addEventListener("wheel", e => {
        e.preventDefault();
        const [sx, sy] = pos(e);
        this.zoomBy(e.deltaY < 0 ? 1.12 : 0.89, sx, sy);
      }, { passive: false });
    }

    _endPointer(event, cancelled = false) {
      if (this._pointerId == null || (event && event.pointerId !== this._pointerId)) return;
      const id = this._pointerId, node = this.dragNode, moved = this.dragMoved;
      this._pointerId = null; this.dragNode = null; this.panning = false;
      this.dragMoved = false;
      this._dragStart = null;
      this.svg.classList.remove('grabbing');
      if (this.svg.hasPointerCapture(id)) this.svg.releasePointerCapture(id);
      if (!cancelled && !moved) this.select(node ? node.id : null);
    }

    /* ---------- render ---------- */
    setActive(active) {
      this._active = active;
      if (!active && this._frame != null) { cancelAnimationFrame(this._frame); this._frame = null; }
      if (active) this._invalidate();
    }

    _invalidate(changes = { paint: true, labels: true }) {
      for (const [key, dirty] of Object.entries(changes)) if (dirty) this._dirty[key] = true;
      if (!this._active || document.hidden || this._frame != null) return;
      this._frame = requestAnimationFrame(() => {
        this._frame = null;
        const dirty = this._dirty; this._dirty = {};
        if (dirty.transform) this.vp.setAttribute('transform', 'translate(' + this.tx + ' ' + this.ty + ') scale(' + this.scale + ')');
        if (dirty.paint) this._paint();
        if (dirty.positions) { this._renderPositions(); this._renderScale = this.scale; }
        if (dirty.labels) this._layoutLabels();
      });
    }

    _renderPositions() {
      const inv = 1 / this.scale;
      this.nodes.forEach(n => {
        if (n.gEl.style.display === "none") return;
        n.gEl.setAttribute("transform", `translate(${n.x} ${n.y})`);
        n.hitEl.setAttribute('transform', `translate(${n.x} ${n.y})`);
        n.hitEl.setAttribute('r', Math.max(n.rad, 10 * inv));
        // counter-scale stroke + label so they stay constant in screen px
        n.cEl.setAttribute("stroke-width", 1.5 * inv);
        const labelFs = (n.role === "seed" ? 15 : 13) * inv;
        n.tEl.setAttribute("font-size", labelFs);
        n.tEl.setAttribute("y", n.rad + 6 * inv + labelFs);
        n.tEl.setAttribute("stroke-width", 3.2 * inv);
        if (n.tHubEl) {
          const hubFs = 12 * inv;
          n.tHubEl.setAttribute("font-size", hubFs);
          n.tHubEl.setAttribute("y", n.rad + 6 * inv + hubFs);
          n.tHubEl.setAttribute("stroke-width", 3.6 * inv);
        }
      });
      this.edges.forEach(e => {
        if (e.path.style.display === "none") return;
        const a = this.nodeById[e.s], b = this.nodeById[e.t];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const bow = Math.min(30, len * 0.08);
        const nx = -dy / len, ny = dx / len;
        e.path.setAttribute("d", `M${a.x} ${a.y}Q${mx + nx * bow} ${my + ny * bow} ${b.x} ${b.y}`);
        e.path.setAttribute("stroke-width", (e._lit ? 1.3 : 0.8) / this.scale);
      });
    }

    // colors / opacity / visibility — only when state changes
    _paint() {
      const pal = this._palette();
      const focus = this.hovered || (this.selected && this.nodeById[this.selected]);
      const neigh = focus ? this.adj[focus.id] : null;
      const isLit = id => !focus || focus.id === id || (neigh && neigh.has(id));

      this.nodes.forEach(n => {
        const vis = this._visible(n);
        n.gEl.style.display = vis ? "" : "none";
        n.hitEl.style.display = vis ? '' : 'none';
        if (!vis) return;
        const lit = isLit(n.id);
        const col = this._color(n.role, pal);
        const isSel = this.selected === n.id;
        n.cEl.setAttribute("fill", col);
        n.cEl.setAttribute("stroke", pal.bg);
        n.gEl.style.opacity = lit ? 1 : 0.2;
        // halo
        if (isSel || n.role === "seed") {
          n.haloEl.setAttribute("r", n.rad + (isSel ? 8 : 6));
          n.haloEl.setAttribute("fill", col);
          n.haloEl.style.opacity = isSel ? 0.2 : 0.12;
        } else { n.haloEl.style.opacity = 0; }
        // label
        const big = n.role === "seed";
        // top-linked hubs keep their author/year label visible at any zoom
        const showLbl = this.showLabels && (big || (focus && lit) || !focus);
        n.labelCandidate = showLbl;
        n.tEl.setAttribute("fill", pal.ink);
        n.tEl.setAttribute("stroke", pal.bg);
        if (n.tHubEl) n.tHubEl.style.display = "none";
      });

      this.edges.forEach(e => {
        const a = this.nodeById[e.s], b = this.nodeById[e.t];
        const vis = this._visible(a) && this._visible(b);
        e.path.style.display = vis ? "" : "none";
        if (!vis) return;
        const lit = focus ? (focus.id === e.s || focus.id === e.t) : true;
        e._lit = focus && lit;
        const col = e.kind === "cite" ? pal.cite : e.kind === "ref" ? pal.ref : pal.faint;
        e.path.setAttribute("stroke", col);
        e.path.setAttribute("stroke-width", (e._lit ? 1.3 : 0.8) / this.scale);
        const base = focus ? (lit ? 0.8 : 0.04) : (e.kind === "cross" ? 0.20 : 0.32);
        e.path.style.opacity = base * this.linkOpacity;
      });
    }

    // Screen-space label boxes: keep readable text sizes and suppress collisions.
    // Focused/selected papers and the seed win, then the strongest hubs.
    _layoutLabels() {
      const focus = this.hovered ? this.hovered.id : this.selected;
      const boxes = [];
      const widthPx = this.W, heightPx = this.H;
      const maxLabels = Math.max(12, Math.min(80, Math.floor(widthPx * heightPx / 18000)));
      const ordered = this.nodes.slice().sort((a, b) => {
        const rank = n => n.id === focus ? 1e9 : n.role === 'seed' ? 1e8 : n.topHub ? 1e7 + n.degree : n.degree;
        return rank(b) - rank(a);
      });
      ordered.forEach(n => {
        if (!n.labelCandidate || !this._visible(n) || boxes.length >= maxLabels) { n.tEl.style.display = 'none'; return; }
        const fs = n.role === 'seed' ? 15 : 13;
        // Canvas measures without interleaving SVG writes and layout reads.
        if (n.labelWidth == null) {
          this._measure.font = '400 ' + fs + 'px ' + this._labelFamily;
          n.labelWidth = this._measure.measureText(n.tEl.textContent).width + n.tEl.textContent.length * fs * 0.01;
        }
        const width = n.labelWidth;
        const x = n.x * this.scale + this.tx, cy = n.y * this.scale + this.ty;
        const radius = n.rad * this.scale, gap = radius + 7;
        // Try each side before hiding a label in a crowded region.
        const candidates = [
          { x, y: cy + gap }, { x, y: cy - gap - fs - 5 },
          { x: x + gap + width / 2, y: cy - fs / 2 },
          { x: x - gap - width / 2, y: cy - fs / 2 }
        ];
        const priority = n.id === focus || n.role === 'seed';
        let chosen;
        for (const candidate of candidates) {
          const box = { l: candidate.x - width / 2 - 4, r: candidate.x + width / 2 + 4, t: candidate.y, b: candidate.y + fs + 5 };
          const outside = box.l < 0 || box.r > widthPx || box.t < 0 || box.b > heightPx;
          const overlaps = boxes.some(b => box.l < b.r && box.r > b.l && box.t < b.b && box.b > b.t);
          const hitsNode = this.nodes.some(other => {
            if (other === n || !this._visible(other)) return false;
            const nx = other.x * this.scale + this.tx, ny = other.y * this.scale + this.ty;
            const r = other.rad * this.scale + 3;
            const dx = nx - Math.max(box.l, Math.min(nx, box.r));
            const dy = ny - Math.max(box.t, Math.min(ny, box.b));
            return dx * dx + dy * dy < r * r;
          });
          if (!outside && !overlaps && (!hitsNode || priority)) { chosen = { ...candidate, box }; break; }
        }
        n.tEl.style.display = chosen ? '' : 'none';
        if (chosen) {
          n.tEl.setAttribute('x', (chosen.x - x) / this.scale);
          n.tEl.setAttribute('y', (chosen.y + fs - cy) / this.scale);
          boxes.push(chosen.box);
        }
      });
    }

    focusNode(id) {
      const n = this.nodeById[id]; if (!n) return;
      this.select(id);
      const w = this.W, h = this.H;
      this.scale = Math.max(this.scale, 0.95);
      this.tx = w / 2 - n.x * this.scale; this.ty = h / 2 - n.y * this.scale;
      this._applyTransform();
    }

    setNodeScale(s) {
      this._nodeScale = s;
      this.nodes.forEach(n => { n.rad = n.baseR * s; n.cEl.setAttribute("r", n.rad); n.haloEl.setAttribute("r", n.rad); });
      this._invalidate({ positions: true, paint: true, labels: true });
    }

    // Patch in journal-impact sizing once impact-factor data arrives (background
    // fetch, after first paint). ifById maps node id -> journal impact factor.
    // Only sizes change — topology and layout positions are untouched, so this
    // is a smooth in-place resize with no jolt.
    applyJournalImpact(ifById) {
      const s = this._nodeScale || 1;
      this.nodes.forEach(n => {
        const v = ifById[n.id];
        if (v == null) return;
        n.journalIF = v;
        const rr = this._radius(n.role, n.citedHere, v);
        n.baseR = rr; n.rad = rr * s;
        n.cEl.setAttribute("r", n.rad);
        n.haloEl.setAttribute("r", n.rad);
      });
      this._invalidate({ positions: true, paint: true, labels: true });
    }
  }

  function shortAuthor(s) {
    return s.split(/[\s,&]+/)[0] || s;
  }
  function truncTitle(t) {
    if (!t) return "";
    return t.length > 42 ? t.slice(0, 40).trimEnd() + "…" : t;
  }
  window.CitationGraph = CitationGraph;
})();
