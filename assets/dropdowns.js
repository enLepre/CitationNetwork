'use strict';
// Enhance native selects while retaining their options, values and change events.
(() => {
  const controls = [];
  for (const select of document.querySelectorAll('select')) {
    const id = select.id;
    if (!select) continue;
    const label = select.labels?.[0];
    const name = select.getAttribute('aria-label') || (label ? [...label.childNodes].filter(node => node !== select).map(node => node.textContent).join(' ').trim() : id.replaceAll('-', ' '));
    const wrapper = document.createElement('div');
    wrapper.className = 'source-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = id + '-trigger';
    trigger.className = 'source-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id + '-panel');
    const caption = document.createElement('span');
    const arrow = document.createElement('span');
    arrow.className = 'source-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(caption, arrow);
    const panel = document.createElement('div');
    panel.id = id + '-panel';
    panel.className = 'source-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose ' + name.toLowerCase());
    panel.hidden = true;
    const list = document.createElement('div');
    list.id = id + '-options';
    list.className = 'source-options';
    list.tabIndex = 0;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', name);
    const empty = document.createElement('p');
    empty.className = 'source-empty';
    empty.setAttribute('role', 'status');
    empty.textContent = 'No available options.';
    panel.append(list, empty);
    wrapper.append(trigger, panel);
    select.after(wrapper);
    select.hidden = true;
    if (label) label.htmlFor = trigger.id;
    panel.setAttribute('popover', 'manual');
    let choices = [], active = -1, signature = '';
    function activate(index) {
      active = index;
      [...list.children].forEach((option, i) => option.classList.toggle('is-active', i === index));
      const option = list.children[index];
      if (option) {
        list.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView?.({ block: 'nearest' });
      } else list.removeAttribute('aria-activedescendant');
    }
    function close(focus = false) {
      if (panel.matches(':popover-open')) panel.hidePopover();
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (focus) trigger.focus();
    }
    function choose(index) {
      if (!choices[index]) return;
      select.value = choices[index].value;
      close(true);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
    function filter() {
      choices = [...select.options].filter(option => !option.disabled);
      list.replaceChildren();
      choices.forEach((option, i) => {
        const row = document.createElement('div');
        row.id = id + '-option-' + i;
        row.className = 'source-option';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.value === select.value));
        row.textContent = option.textContent;
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', event => { event.preventDefault(); choose(i); });
        list.append(row);
      });
      empty.hidden = choices.length > 0;
      activate(choices.length ? Math.max(0, choices.findIndex(option => option.value === select.value)) : -1);
    }
    function open() {
      controls.forEach(control => control.close());
      sync();
      if (select.disabled) return;
      panel.hidden = false;
      panel.showPopover();
      position();
      trigger.setAttribute('aria-expanded', 'true');
      filter();
      list.focus();
      position();
    }
    function position() {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 32);
      const below = window.innerHeight - rect.bottom - 22;
      const above = rect.top - 22;
      panel.style.width = width + 'px';
      panel.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + 'px';
      panel.style.maxHeight = Math.max(100, Math.min(360, Math.max(below, above))) + 'px';
      panel.style.top = (below >= 240 || below >= above ? rect.bottom + 6 : Math.max(16, rect.top - panel.getBoundingClientRect().height - 6)) + 'px';
    }
    function sync() {
      trigger.disabled = select.disabled;
      if (select.disabled && !panel.hidden) close();
      const selected = select.selectedOptions[0];
      caption.textContent = selected?.textContent || name;
      trigger.setAttribute('aria-label', name + ': ' + caption.textContent);
      const next = JSON.stringify([...select.options].map(option => [option.value, option.textContent, option.disabled])) + select.value;
      if (signature !== next && !panel.hidden) filter();
      signature = next;
    }
    trigger.addEventListener('click', () => panel.hidden ? open() : close());
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
    });
    list.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (choices.length) activate((active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); activate(event.key === 'Home' ? 0 : choices.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
      else if (event.key === 'Escape') { event.preventDefault(); close(true); }
    });
    wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
    window.addEventListener('resize', () => { if (!panel.hidden) position(); });
    window.addEventListener('scroll', () => { if (!panel.hidden) position(); }, true);
    controls.push({ sync, close });
    sync();
  }
  document.addEventListener('change', () => queueMicrotask(() => controls.forEach(control => control.sync())));
  window.addEventListener('pageshow', () => controls.forEach(control => control.sync()));
  window.SourceDropdowns = { sync: () => controls.forEach(control => control.sync()) };
})();
