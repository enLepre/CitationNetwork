/* Native appearance and notebook navigation controls. */
(() => {
  const palettes = [
    ['#715b49', '#8b795f', '#536b82', '#657b6a'],
    ['#805c57', '#68816c', '#74698a', '#7b815f'],
    ['#68645b', '#8a795f', '#586f80', '#727c68'],
    ['#886579', '#8a815c', '#567c83', '#6e816e']
  ];
  const tones = {
    warm: ['#f5f2ec', '#eeebe4'], cool: ['#f0f3f5', '#e7ecef'],
    neutral: ['#f4f4f2', '#eaeae7'], dark: ['#272c32', '#30363d']
  };
  const defaults = { palette: '0', paper: 'warm', serif: 'Georgia', links: 1, labels: true, nodeScale: 1 };
  const storageKey = 'citation-appearance-v2';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch (error) {}
  let settings = { ...defaults, ...saved };
  if (!palettes[settings.palette]) settings.palette = '0';
  if (!tones[settings.paper]) settings.paper = 'warm';
  if (!['Georgia', 'Spectral', 'Newsreader', 'Source Serif 4'].includes(settings.serif)) settings.serif = 'Georgia';
  for (const [key, min, max] of [['links', .1, 1], ['nodeScale', .7, 1.5]]) {
    settings[key] = Number.isFinite(+settings[key]) ? Math.max(min, Math.min(max, +settings[key])) : defaults[key];
  }
  settings.labels = settings.labels !== false;
  const root = document.getElementById('tweaks-root');
  root.innerHTML = `<aside class="appearance-panel" id="appearance-panel" aria-label="Appearance" hidden>
    <div class="appearance-heading"><strong>Appearance</strong><button type="button" id="appearance-close" aria-label="Close appearance">×</button></div>
    <label>Palette<select name="palette"><option value="0">Notebook</option><option value="1">Garden</option><option value="2">Earth</option><option value="3">Rose & sky</option></select></label>
    <label>Paper<select name="paper"><option value="warm">Warm</option><option value="cool">Cool</option><option value="neutral">Neutral</option><option value="dark">Dark</option></select></label>
    <label>Typeface<select name="serif"><option>Georgia</option><option>Spectral</option><option>Newsreader</option><option>Source Serif 4</option></select></label>
    <label>Connection lines<input name="links" type="range" min="0.1" max="1" step="0.05"></label>
    <label>Node size<input name="nodeScale" type="range" min="0.7" max="1.5" step="0.05"></label>
    <label>Paper labels<input name="labels" type="checkbox"></label>
    <button type="button" class="btn" id="appearance-reset">Reset appearance</button>
  </aside>`;
  const panel = document.getElementById('appearance-panel');
  const button = document.createElement('button');
  button.id = 'appearance-toggle'; button.className = 'share-btn'; button.textContent = 'Appearance';
  button.setAttribute('aria-controls', panel.id); button.setAttribute('aria-expanded', 'false');
  document.querySelector('.topbar').appendChild(button);
  const menuButton = document.getElementById('menu-toggle');
  const menu = document.getElementById('notebook-menu');
  const theme = document.getElementById('theme-toggle');
  const inputs = [...panel.querySelectorAll('[name]')];
  function persist() { try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch (error) {} }
  function syncInputs() {
    inputs.forEach(input => { if (input.type === 'checkbox') input.checked = settings[input.name]; else input.value = settings[input.name]; });
  }
  function apply() {
    const style = document.documentElement.style;
    const dark = settings.paper === 'dark';
    const accents = palettes[settings.palette];
    ['seed', 'ref', 'cite', 'linked'].forEach((name, i) => {
      const color = dark ? `color-mix(in srgb, ${accents[i]}, white 40%)` : accents[i];
      style.setProperty('--' + name, color);
      style.setProperty('--' + name + '-tint', `color-mix(in srgb, ${color} 8%, transparent)`);
    });
    ['bg', 'surface', 'panel'].forEach(name => style.setProperty('--' + name, tones[settings.paper][0]));
    style.setProperty('--bg-2', tones[settings.paper][1]);
    const ink = dark ? ['#e0e4e8', '#cdd4dc', '#adb5bf', '#414850', '#383f47'] : ['#34312c', '#514b43', '#70685e', '#ded8ce', '#e8e2d9'];
    ['ink', 'ink-soft', 'ink-faint', 'line', 'line-soft'].forEach((name, i) => style.setProperty('--' + name, ink[i]));
    style.setProperty('--serif', '"' + settings.serif + '", Georgia, serif');
    style.colorScheme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = tones[settings.paper][0];
    theme.setAttribute('aria-pressed', String(dark));
    if (window.CG) {
      window.CG.setFilter({ showLabels: settings.labels, linkOpacity: +settings.links });
      window.CG.setNodeScale(+settings.nodeScale);
      window.CG.nodes.forEach(n => { n.labelWidth = null; });
    }
  }
  function menuOpen(open, restore = false) {
    menu.hidden = !open; menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    menuButton.parentElement.classList.toggle('is-open', open);
    if (restore) menuButton.focus();
  }
  function setOpen(open, restore = true) {
    panel.hidden = !open; button.setAttribute('aria-expanded', String(open));
    if (open) { menuOpen(false); panel.querySelector('select').focus(); }
    else if (restore) button.focus();
  }
  menuButton.addEventListener('click', () => { setOpen(false, false); menuOpen(menu.hidden); });
  theme.addEventListener('click', () => { settings.paper = settings.paper === 'dark' ? 'warm' : 'dark'; syncInputs(); apply(); persist(); });
  button.addEventListener('click', () => setOpen(panel.hidden));
  document.getElementById('appearance-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('click', event => {
    if (!menu.hidden && !menuButton.parentElement.contains(event.target)) menuOpen(false);
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) setOpen(false, false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!panel.hidden) setOpen(false);
    if (!menu.hidden) menuOpen(false, true);
  });
  panel.addEventListener('input', event => {
    const input = event.target; if (!input.name) return;
    settings[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    apply(); persist();
  });
  document.getElementById('appearance-reset').addEventListener('click', () => { settings = { ...defaults }; syncInputs(); apply(); persist(); });
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    if (event.data?.type === '__activate_edit_mode') setOpen(true);
    if (event.data?.type === '__deactivate_edit_mode') setOpen(false);
  });
  window.applyAppearance = apply;
  syncInputs(); apply();
})();
