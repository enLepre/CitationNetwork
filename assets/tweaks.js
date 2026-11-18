/* Shared notebook theme; page content belongs to separate documents. */
(() => {
  const theme = document.getElementById('theme-toggle');
  let dark = false;
  try {
    const saved = localStorage.getItem('citation-theme');
    dark = saved ? saved === 'dark' : JSON.parse(localStorage.getItem('citation-appearance-v2') || '{}').paper === 'dark';
  } catch (_) {}
  function apply() {
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#272c32' : '#f5f2ec';
    theme.setAttribute('aria-pressed', String(dark)); theme.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; theme.setAttribute('aria-label',theme.title);
    if (window.CG) window.CG._invalidate({ paint:true,labels:true });
  }
  theme.addEventListener('click',() => {
    dark=document.documentElement.dataset.theme !== 'dark';
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.dataset.slide) {
      document.documentElement.dataset.themeChange = 'true';
      const transition = document.startViewTransition(apply);
      transition.ready.catch(() => {}); transition.updateCallbackDone.catch(() => {});
      transition.finished.finally(() => delete document.documentElement.dataset.themeChange).catch(() => {});
    } else apply();
    try { localStorage.setItem('citation-theme',dark ? 'dark':'light'); } catch (_) {} });
  window.applyAppearance = () => { dark = document.documentElement.dataset.theme === 'dark'; apply(); }; apply();
})();
