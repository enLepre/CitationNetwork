/* Run before first paint: retain the workspace chrome across documents. */
(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Set();
  window.CitationMotion = {
    animate(element, frames, duration = 240) {
      if (reduced.matches || document.hidden) return null;
      element.getAnimations().forEach(animation => animation.cancel());
      const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.22,.68,.25,1)' });
      running.add(animation);
      animation.finished.catch(() => {}).finally(() => running.delete(animation));
      return animation;
    }
  };
  reduced.addEventListener('change', () => { if (reduced.matches) for (const animation of running) animation.cancel(); });
  // Warm only the small destination document on navigation intent.
  const prefetched = new Set();
  function prefetch(event) {
    const link = event.target.closest?.('a[data-view]');
    if (!link || link.getAttribute('aria-current') === 'page' || prefetched.has(link.href) || navigator.connection?.saveData) return;
    prefetched.add(link.href);
    const hint = document.createElement('link'); hint.rel = 'prefetch'; hint.href = link.href; document.head.appendChild(hint);
  }
  addEventListener('pointerover', prefetch, { passive: true });
  addEventListener('focusin', prefetch);
  function restore() {
    try { root.dataset.workspace = JSON.parse(sessionStorage.getItem('citation-current') || 'null')?.seedId ? 'active' : 'empty'; } catch (_) { root.dataset.workspace = 'empty'; }
    try {
      const saved = localStorage.getItem('citation-theme');
      root.dataset.theme = (saved ? saved === 'dark' : JSON.parse(localStorage.getItem('citation-appearance-v2') || '{}').paper === 'dark') ? 'dark' : 'light';
    } catch (_) {}
  }
  restore();
  addEventListener('pagereveal', restore);
  addEventListener('pageshow', restore);
  // Re-selecting the current view must not reload its contents.
  addEventListener('click', event => {
    const link = event.target.closest?.('a[data-view]');
    if (link?.getAttribute('aria-current') === 'page' && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault();
  });
})();
