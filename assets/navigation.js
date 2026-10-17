/* Run before first paint: retain the workspace chrome across documents. */
(() => {
  const root = document.documentElement;
  function restore() {
    try { root.dataset.workspace = JSON.parse(sessionStorage.getItem('citation-current') || 'null')?.seedId ? 'active' : 'empty'; } catch (_) { root.dataset.workspace = 'empty'; }
    try {
      const saved = localStorage.getItem('citation-theme');
      root.dataset.theme = (saved ? saved === 'dark' : JSON.parse(localStorage.getItem('citation-appearance-v2') || '{}').paper === 'dark') ? 'dark' : 'light';
    } catch (_) {}
  }
  restore();
  const order = { 'index.html': 0, '': 0, 'paper.html': 1, 'graph.html': 2, 'list.html': 3 };
  function direction(from, to) {
    if (!from || !to) return null;
    const a = new URL(from), b = new URL(to);
    if (a.origin !== b.origin || a.pathname.slice(0,a.pathname.lastIndexOf('/')) !== b.pathname.slice(0,b.pathname.lastIndexOf('/'))) return null;
    const x = order[a.pathname.split('/').pop()], y = order[b.pathname.split('/').pop()];
    return x === undefined || y === undefined || x === y ? null : y > x ? 'forward' : 'backward';
  }
  function prepare(transition, from, to) {
    if (!transition) return;
    // A quick second navigation or reload can cancel a pending transition.
    transition.ready.catch(() => {});
    transition.updateCallbackDone.catch(() => {});
    transition.finished.catch(() => {});
    const value = direction(from, to);
    if (!value || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.dataset.slide = value;
    transition.finished.finally(() => delete root.dataset.slide).catch(() => {});
  }
  addEventListener('pageswap', event => prepare(event.viewTransition, event.activation?.from?.url, event.activation?.entry?.url));
  addEventListener('pagereveal', event => {
    restore();
    prepare(event.viewTransition, window.navigation?.activation?.from?.url, window.navigation?.activation?.entry?.url);
  });
  addEventListener('pageshow', restore);
  // Re-selecting the current view must not reload its contents.
  addEventListener('click', event => {
    const link = event.target.closest?.('a[data-view]');
    if (link?.getAttribute('aria-current') === 'page' && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault();
  });
})();
