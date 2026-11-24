// Search box of the settings page: filters the cards / rows by what the user sees (labels, hints, option names, buttons).
// A card whose title matches stays whole; otherwise only its matching rows stay. The side links of hidden cards are hidden too.
// Cards that are drawn by code (lock, sync, permissions, backup) are included because the text is read at filter time.

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Everything a person can read in one row: text, tooltips, the names of select options. */
function textOf(el) {
  let t = el.textContent || '';
  for (const x of el.querySelectorAll('[title], [aria-label]')) t += ' ' + (x.getAttribute('title') || '') + ' ' + (x.getAttribute('aria-label') || '');
  for (const x of el.querySelectorAll('input[type="text"], textarea')) t += ' ' + (x.placeholder || '');
  return norm(t);
}

const SVGNS = 'http://www.w3.org/2000/svg';
// one icon per settings card (cards and side links are text-only otherwise, which is hard to scan)
const ICONS = { appearance: 'palette', privacy: 'shield', storing: 'save', opening: 'open', organise: 'layers', deleted: 'trash', suspend: 'moon', shortcuts: 'keyboard', lock: 'lock', sync: 'cloud', perms: 'key', backup: 'box' };
const icon = (name) => {
  const sv = document.createElementNS(SVGNS, 'svg');
  sv.setAttribute('class', 'mi sico');
  sv.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  sv.appendChild(u);
  return sv;
};
/** Puts the icon in front of the element's text. A data-s element is wrapped first: the string table rewrites its textContent (and would drop the icon). */
function decorate(el, name) {
  if (!el || !name || el.querySelector(':scope > svg.sico')) return;
  if (el.dataset.s) {
    const span = document.createElement('span');
    span.dataset.s = el.dataset.s;
    span.textContent = el.textContent;
    el.removeAttribute('data-s');
    el.textContent = '';
    el.append(span);
  }
  el.prepend(icon(name));
}
function decorateAll(panel, nav) {
  for (const [k, name] of Object.entries(ICONS)) {
    const card = panel.querySelector('#s-' + k);
    if (card) decorate(card.querySelector(':scope > h2'), name);
    decorate(nav.querySelector('a[href="#s-' + k + '"]'), name);
  }
  decorate(nav.querySelector('a[href="about.html"]'), 'info');
}

export function initSettingsSearch({ panel, nav, input, empty, t }) {
  let timer = 0;
  decorateAll(panel, nav);
  // the lock / permissions cards and the permissions link are redrawn by code: put the icons back when that happens
  const mo = new MutationObserver(() => { mo.disconnect(); decorateAll(panel, nav); watch(); });
  const watch = () => { mo.observe(panel, { childList: true, subtree: true }); mo.observe(nav, { childList: true, subtree: true }); };
  watch();

  function apply() {
    const q = norm(input.value);
    const words = q ? q.split(' ') : [];
    const hit = (txt) => words.every((w) => txt.includes(w));
    let shown = 0;
    const cards = [...panel.querySelectorAll(':scope > section.card')];
    for (const card of cards) {
      const kids = [...card.children].filter((k) => !k.matches('h2'));
      for (const k of kids) k.hidden = false;
      if (!words.length) { card.hidden = false; continue; }
      const head = card.querySelector('h2');
      if (head && hit(norm(head.textContent))) { card.hidden = false; shown++; continue; } // the card's own name matches: keep it whole
      let any = false;
      let h3 = null;
      let h3Hit = false;
      for (const k of kids) {
        if (k.matches('h3')) { h3 = k; h3Hit = false; k.hidden = true; continue; }
        const ok = hit(textOf(k)) || (h3 && hit(norm(h3.textContent)));
        k.hidden = !ok;
        if (ok) { any = true; if (h3) { h3.hidden = false; h3Hit = true; } }
      }
      void h3Hit;
      card.hidden = !any;
      if (any) shown++;
    }
    for (const a of nav.querySelectorAll('a[href^="#s-"]')) {
      const c = panel.querySelector(a.getAttribute('href'));
      a.hidden = !!(c && c.hidden);
    }
    empty.hidden = !(words.length && !shown);
    if (!empty.hidden) empty.textContent = t.noResult(input.value.trim());
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 80); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); }
  });
  return { apply, clear() { input.value = ''; apply(); } };
}
