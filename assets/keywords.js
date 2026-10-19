/* Keyword selection is separate from the lightweight, live graph search. */
(function (root) {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const abstractText = paper => /^No abstract available from OpenAlex\.?$/i.test(paper.abstract || '') ? '' : paper.abstract || '';
  function terms(values) {
    return [...new Set(values.map(normalize).filter(Boolean))];
  }
  function matches(paper, filters) {
    const keywords = terms(filters.terms || []);
    if (!keywords.length) return true;
    const text = (filters.fields || []).map(field => normalize(field === 'authors' ? paper.searchAuthors || paper.authors : field === 'abstract' ? abstractText(paper) : paper.title));
    const contains = keyword => text.some(value => value.includes(keyword));
    return filters.mode === 'all' ? keywords.every(contains) : keywords.some(contains);
  }
  function subset(net, filters) {
    const papers = net.papers.filter(p => p.id === net.seedId || matches(p, filters));
    const ids = new Set(papers.map(p => p.id));
    return { ...net, papers, edges: net.edges.filter(e => ids.has(e.s) && ids.has(e.t)) };
  }
  const stop = new Set('a an the and or of in on for to with by from at as is are was were be this that these those using use used study studies analysis approach based new results effect effects research paper unknown authors available abstract openalex into through between their its our we can not'.split(' '));
  const catalogs = new WeakMap();
  function suggestions(papers, fields, query = '', selected = []) {
    const key = fields.slice().sort().join(',') + ':' + (fields.includes('abstract') ? papers.filter(p=>p.abstract != null).length : '');
    let cache = catalogs.get(papers);
    if (!cache) { cache = new Map(); catalogs.set(papers,cache); }
    let entries = cache.get(key);
    if (!entries) {
      const counts = new Map(), labels = new Map();
      const add = (label, seen) => {
        const key = normalize(label);
        if (!key || seen.has(key)) return;
        seen.add(key); labels.set(key, label); counts.set(key, (counts.get(key) || 0) + 1);
      };
      for (const paper of papers) {
        const seen = new Set();
        if (fields.includes('authors')) for (const author of (paper.searchAuthors || paper.authors || '').split(/,\s*/)) {
          if (!/^(unknown authors|et al\.?)$/i.test(author)) add(author, seen);
        }
        for (const text of [fields.includes('title') ? paper.title : '', fields.includes('abstract') ? abstractText(paper) : '']) {
          const words = normalize(text).match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [];
          for (let i = 0; i < words.length; i++) {
            if (words[i].length < 3 || stop.has(words[i])) continue;
            add(words[i], seen);
            if (words[i+1]?.length >= 3 && !stop.has(words[i+1])) add(words[i] + ' ' + words[i+1], seen);
          }
        }
      }
      entries = [...counts].map(([key,count]) => ({key,count,term:labels.get(key)}));
      if (cache.size >= 8) cache.clear();
      cache.set(key,entries);
    }
    const chosen = new Set(terms(selected)), q = normalize(query);
    return entries.filter(({key}) => !chosen.has(key) && (!q || key.includes(q)))
      .sort((a,b) => b.count-a.count || a.key.localeCompare(b.key)).slice(0,12);
  }

  class Controller {
    constructor(element, { rebuild, abstracts }) {
      this.element = element; this.rebuild = rebuild; this.abstracts = abstracts;
      this.selected = []; this.applied = {terms:[],fields:['title','authors'],mode:'any'};
      this.$ = id => element.querySelector('#'+id);
      this.$('keyword-query').addEventListener('input', () => this.render());
      this.$('keyword-query').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); this.add(this.$('keyword-query').value); }
      });
      this.$('keyword-add').addEventListener('click', () => this.add(this.$('keyword-query').value));
      element.querySelectorAll('[name="keyword-field"]').forEach(input => input.addEventListener('change', () => {
        this.render();
        if (input.value === 'abstract' && input.checked) this.prepareAbstracts();
      }));
      this.$('keyword-mode').addEventListener('change', () => this.render());
      this.$('keyword-rebuild').addEventListener('click', () => this.commit());
      this.$('keyword-reset').addEventListener('click', () => this.commit(true));
      element.closest('details').addEventListener('toggle',()=>{if(element.closest('details').open)this.render();});
      this.setBusy(false);
    }
    fields() { return [...this.element.querySelectorAll('[name="keyword-field"]:checked')].map(el => el.value); }
    cancel() { this.request?.abort(); this.request = null; this.setBusy(false); }
    setBusy(busy) {
      this.busy = busy;
      this.element.setAttribute('aria-busy', String(busy));
      this.element.querySelectorAll('input,select,button').forEach(el => { el.disabled = busy; });
      if (!busy) this.render();
    }
    async source(net, {signal} = {}) {
      if (this.net?.seedId !== net.seedId) {
        this.cancel(); this.selected = []; this.applied = {terms:[],fields:['title','authors'],mode:'any'};
        this.$('keyword-query').value = ''; this.$('keyword-status').textContent = '';
        this.$('keyword-mode').value = 'any';
        this.element.querySelectorAll('[name="keyword-field"]').forEach(el => { el.checked = el.value !== 'abstract'; });
        try {
          const saved = JSON.parse(sessionStorage.getItem('citation-keywords') || 'null');
          if (saved?.seedId === net.seedId && Array.isArray(saved.filters?.terms) && saved.filters.fields?.length) {
            this.applied = {terms:terms(saved.filters.terms),fields:saved.filters.fields.filter(f=>['title','authors','abstract'].includes(f)),mode:saved.filters.mode === 'all'?'all':'any'};
            this.selected = this.applied.terms.slice(); this.$('keyword-mode').value = this.applied.mode;
            this.element.querySelectorAll('[name="keyword-field"]').forEach(el => { el.checked = this.applied.fields.includes(el.value); });
          }
        } catch (_) {}
      }
      this.net = net;
      this.element.closest('details').classList.toggle('has-keywords',!!this.applied.terms.length);
      this.render();
      if (this.applied.terms.length && this.applied.fields.includes('abstract')) await this.abstracts(net.papers, {signal});
      this.render();
      return subset(net, this.applied);
    }
    add(value) {
      value = value.trim(); if (!value) return;
      if (!terms(this.selected).includes(normalize(value))) this.selected.push(value);
      this.$('keyword-query').value = ''; this.render(); this.$('keyword-query').focus();
    }
    render() {
      if (!this.net || this.busy || !this.element.closest('details').open) return;
      const chosen = this.$('keyword-selected'); chosen.replaceChildren();
      for (const term of this.selected) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'keyword-chip'; button.textContent = term + ' ×'; button.setAttribute('aria-label','Remove keyword '+term);
        button.addEventListener('click', () => { this.selected = this.selected.filter(t=>t!==term); this.render(); this.$('keyword-query').focus(); });
        chosen.append(button);
      }
      const box = this.$('keyword-suggestions'); box.replaceChildren();
      for (const {term,count} of suggestions(this.net.papers,this.fields(),this.$('keyword-query').value,this.selected)) {
        const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
        input.type = 'checkbox'; input.addEventListener('change', () => this.add(term));
        text.textContent = term + ' ('+count+')'; label.append(input,text); box.append(label);
      }
      if (!box.children.length) { const message = document.createElement('p'); message.textContent = 'No suggestions. Add your own keyword.'; box.append(message); }
      this.$('keyword-add').disabled = !this.$('keyword-query').value.trim();
      this.$('keyword-rebuild').disabled = !this.fields().length;
      this.$('keyword-reset').hidden = !this.applied.terms.length && !this.selected.length;
      const missing = this.net.papers.filter(p=>p.abstract != null && !abstractText(p)).length;
      this.$('keyword-coverage').textContent = `Filter ${this.net.papers.length} loaded papers. The starting paper stays as an anchor.` +
        (this.fields().includes('abstract') ? ` Abstracts: ${this.net.papers.filter(p=>abstractText(p)).length} available, ${missing} unavailable.` : '');
      this.element.closest('details').classList.toggle('has-keywords',!!this.applied.terms.length);
    }
    async prepareAbstracts() {
      if (!this.net || this.busy) return;
      const net = this.net, controller = this.request = new AbortController();
      this.setBusy(true); this.$('keyword-status').textContent = 'Loading abstracts…';
      try {
        await this.abstracts(net.papers,{signal:controller.signal});
        if (controller.signal.aborted || this.net !== net) return;
        this.$('keyword-status').textContent = 'Abstracts ready. Choose keywords, then rebuild.';
      } catch (error) {
        if (!controller.signal.aborted) {
          this.$('keyword-status').textContent = 'Could not load all abstracts. Rebuild graph will retry; your graph is unchanged.';
          controller.abort();
        }
      } finally { if (this.request === controller) { this.request = null; this.setBusy(false); } }
    }
    async commit(reset = false) {
      if (!this.net || this.busy) return;
      const fields = this.fields(); if (!reset && !fields.length) return;
      const pending = this.$('keyword-query').value.trim();
      const filters = reset ? {terms:[],fields:['title','authors'],mode:'any'} : {terms:terms([...this.selected,pending]),fields,mode:this.$('keyword-mode').value};
      const previous = this.applied, net = this.net, controller = this.request = new AbortController();
      this.setBusy(true); this.$('keyword-status').textContent = 'Rebuilding graph…';
      try {
        if (filters.terms.length && fields.includes('abstract') && !reset) await this.abstracts(net.papers,{signal:controller.signal});
        if (controller.signal.aborted || this.net !== net) return;
        this.applied = filters;
        await this.rebuild(controller.signal);
        if (controller.signal.aborted || this.net !== net) return;
        this.selected = filters.terms.slice(); this.$('keyword-query').value = '';
        this.$('keyword-mode').value = filters.mode;
        this.element.querySelectorAll('[name="keyword-field"]').forEach(el => { el.checked = filters.fields.includes(el.value); });
        const count = net.papers.filter(p=>p.id!==net.seedId && matches(p,filters)).length;
        this.$('keyword-status').textContent = filters.terms.length ? `${count} matching ${count === 1 ? 'paper' : 'papers'} + starting paper. Other graph filters still apply.` : 'Full loaded graph restored.';
        try { sessionStorage.setItem('citation-keywords',JSON.stringify({seedId:net.seedId,filters})); } catch (_) {}
      } catch (error) {
        if (!controller.signal.aborted) {
          this.applied = previous;
          this.$('keyword-status').textContent = 'Could not rebuild graph. Please try again.';
          controller.abort();
        }
      } finally { if (this.request === controller) { this.request = null; this.setBusy(false); } }
    }
  }
  const api = {normalize,matches,subset,suggestions,Controller};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CitationKeywords = api;
})(typeof window !== 'undefined' ? window : globalThis);
