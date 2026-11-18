'use strict';
(() => {
  const menu = document.querySelector('.menu');
  const toggle = menu?.querySelector('.menu-toggle');
  const nav = menu?.querySelector('nav');
  if (!menu || !toggle || !nav) return;
  const fitMenu = () => {
    const { width, height } = nav.getBoundingClientRect();
    if (!width || !height) return;
    menu.style.setProperty('--menu-width', width + 'px');
    menu.style.setProperty('--menu-height', height + 'px');
    menu.style.setProperty('--menu-scale-x', 14.4 / width);
    menu.style.setProperty('--menu-scale-y', 14.4 / height);
  };
  fitMenu();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitMenu).observe(nav);
  window.addEventListener('resize', fitMenu);
  document.fonts?.ready.then(fitMenu);
  const setOpen = open => {
    if (open) fitMenu();
    menu.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    nav.inert = !open;
  };
  toggle.addEventListener('click', () => setOpen(!menu.classList.contains('is-open')));
  menu.addEventListener('focusout', event => {
    if (!menu.contains(event.relatedTarget)) setOpen(false);
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { toggle.focus(); setOpen(false); }
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) setOpen(false);
  });
  nav.addEventListener('click', event => { if (event.target.closest('a')) { toggle.focus(); setOpen(false); } });
})();
