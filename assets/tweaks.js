/* Appearance controls use native inputs; no React or runtime compiler needed. */
(() => {
  const palettes = [
    ['oklch(0.55 0.135 38)', 'oklch(0.64 0.085 78)', 'oklch(0.60 0.072 238)'],
    ['oklch(0.52 0.13 25)', 'oklch(0.62 0.09 150)', 'oklch(0.55 0.10 285)'],
    ['oklch(0.5 0.02 60)', 'oklch(0.62 0.085 70)', 'oklch(0.55 0.075 230)'],
    ['oklch(0.55 0.14 330)', 'oklch(0.66 0.10 95)', 'oklch(0.58 0.09 200)']
  ];
  const tones = {
    warm: ['oklch(0.971 0.006 83)', 'oklch(0.945 0.007 83)', 'oklch(0.992 0.004 83)', 'oklch(0.984 0.005 83)'],
    cool: ['oklch(0.972 0.005 250)', 'oklch(0.946 0.006 250)', 'oklch(0.994 0.003 250)', 'oklch(0.986 0.004 250)'],
    neutral: ['oklch(0.972 0.001 0)', 'oklch(0.946 0.001 0)', 'oklch(0.995 0 0)', 'oklch(0.986 0.001 0)']
  };
  const defaults = { palette: '0', paper: 'warm', serif: 'Spectral', links: 1, labels: true, nodeScale: 1 };
  let settings = { ...defaults };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem('citation-appearance') || '{}') }; } catch (error) {}
  const root = document.getElementById('tweaks-root');
  root.innerHTML = `<aside class="appearance-panel" id="appearance-panel" aria-label="Appearance" hidden>
    <div class="appearance-heading"><strong>Appearance</strong><button type="button" id="appearance-close" aria-label="Close appearance">×</button></div>
    <label>Palette<select name="palette"><option value="0">Terracotta & blue</option><option value="1">Green & violet</option><option value="2">Muted earth</option><option value="3">Rose & sky</option></select></label>
    <label>Paper<select name="paper"><option>warm</option><option>cool</option><option>neutral</option></select></label>
    <label>Typeface<select name="serif"><option>Spectral</option><option>Newsreader</option><option>Source Serif 4</option></select></label>
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
  const inputs = [...panel.querySelectorAll('[name]')];
  function syncInputs() {
    inputs.forEach(input => {
      if (input.type === 'checkbox') input.checked = !!settings[input.name];
      else input.value = settings[input.name];
      if (input.type === 'select-one' && !input.value) { input.value = defaults[input.name]; settings[input.name] = input.value; }
    });
  }
  function apply() {
    const style = document.documentElement.style;
    const accents = palettes[settings.palette] || palettes[0];
    ['seed', 'ref', 'cite'].forEach((name, i) => {
      style.setProperty('--' + name, accents[i]);
      style.setProperty('--' + name + '-tint', accents[i].replace(')', ' / 0.12)'));
    });
    ['bg', 'bg-2', 'surface', 'panel'].forEach((name, i) => style.setProperty('--' + name, (tones[settings.paper] || tones.warm)[i]));
    style.setProperty('--serif', '"' + settings.serif + '", Georgia, serif');
    if (window.CG) {
      window.CG.setFilter({ showLabels: settings.labels, linkOpacity: +settings.links });
      window.CG.setNodeScale(+settings.nodeScale);
      window.CG.nodes.forEach(n => { n.labelWidth = null; });
    }
  }
  function setOpen(open) {
    panel.hidden = !open; button.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('select').focus();
    else button.focus();
  }
  button.addEventListener('click', () => setOpen(panel.hidden));
  document.getElementById('appearance-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) setOpen(false); });
  panel.addEventListener('input', event => {
    const input = event.target;
    if (!input.name) return;
    settings[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    apply();
    try { localStorage.setItem('citation-appearance', JSON.stringify(settings)); } catch (error) {}
  });
  document.getElementById('appearance-reset').addEventListener('click', () => {
    settings = { ...defaults }; syncInputs(); apply();
    try { localStorage.removeItem('citation-appearance'); } catch (error) {}
  });
  // Retain the original embedded-prototype activation hook.
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    if (event.data?.type === '__activate_edit_mode') setOpen(true);
    if (event.data?.type === '__deactivate_edit_mode') setOpen(false);
  });
  window.applyAppearance = apply;
  syncInputs(); apply();
})();
