/* Shared notebook theme; page content belongs to separate documents. */
(() => {
  const theme = document.getElementById('theme-toggle');
  let dark = false;
  try {
    const saved = localStorage.getItem('citation-theme');
    dark = saved ? saved === 'dark' : JSON.parse(localStorage.getItem('citation-appearance-v2') || '{}').paper === 'dark';
  } catch (_) {}
  function apply() {
    const root = document.documentElement, style = root.style;
    root.dataset.theme = dark ? 'dark' : 'light'; style.colorScheme = dark ? 'dark' : 'light';
    const colors = dark ? ['#272c32','#30363d','#e0e4e8','#cdd4dc','#adb5bf','#414850','#383f47'] : ['#f5f2ec','#eeebe4','#34312c','#514b43','#70685e','#ded8ce','#e8e2d9'];
    ['bg','bg-2','ink','ink-soft','ink-faint','line','line-soft'].forEach((key,i) => style.setProperty('--'+key,colors[i]));
    ['surface','panel'].forEach(key => style.setProperty('--'+key,colors[0]));
    ['seed','ref','cite','linked'].forEach((key,i) => { const color=['#715b49','#8b795f','#536b82','#875f7b'][i]; style.setProperty('--'+key,key === 'linked' ? (dark ? '#bea2b6' : color) : dark ? `color-mix(in srgb, ${color}, white 40%)` : color); });
    style.setProperty('--seed', dark ? '#91aaa5' : '#007f78');
    document.querySelector('meta[name="theme-color"]').content = colors[0];
    theme.setAttribute('aria-pressed', String(dark)); theme.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; theme.setAttribute('aria-label',theme.title);
    if (window.CG) window.CG._invalidate({ paint:true,labels:true });
  }
  theme.addEventListener('click',() => {
    dark=!dark;
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.dataset.slide) {
      document.documentElement.dataset.themeChange = 'true';
      const transition = document.startViewTransition(apply);
      transition.ready.catch(() => {}); transition.updateCallbackDone.catch(() => {});
      transition.finished.finally(() => delete document.documentElement.dataset.themeChange).catch(() => {});
    } else apply();
    try { localStorage.setItem('citation-theme',dark ? 'dark':'light'); } catch (_) {} });
  window.applyAppearance = apply; apply();
})();
