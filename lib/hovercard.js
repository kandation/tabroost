// Hover / focus card: one element, shown 400 ms after the pointer rests on a row (or immediately on keyboard focus), hidden on leave,
// scroll, click, Esc. Rendered in the top layer (Popover API) so the virtual list can never clip it. Text only (textContent), no innerHTML.

export function createHoverCard({ root, rowsFor, delay = 400, selector = '[data-hc]', skip = '', id = 'hcard', cls = '', enabled = null }) {
  const card = document.createElement('div');
  card.className = 'hcard' + (cls ? ' ' + cls : '');
  card.setAttribute('role', 'tooltip');
  card.id = id;
  card.setAttribute('popover', 'manual');
  document.body.appendChild(card);
  let timer = 0;
  let cur = null;
  let seq = 0; // a newer hover / hide cancels a lookup that is still running (rowsFor may be async)

  function hide() {
    if (timer) { clearTimeout(timer); timer = 0; }
    seq++;
    cur = null;
    try { if (card.matches(':popover-open')) card.hidePopover(); } catch { /* ignore */ }
  }
  async function show(target) {
    const my = ++seq;
    let rows; try { rows = await rowsFor(target); } catch { return; }
    if (my !== seq || !rows || !rows.length || !target.isConnected) return;
    card.textContent = '';
    for (const r of rows) {
      const l = document.createElement('div'); l.className = 'hl'; l.textContent = r.label;
      const v = document.createElement('div'); v.className = 'hv'; v.textContent = r.value;
      if (r.tip) v.title = r.tip;
      card.append(l, v);
    }
    try { card.showPopover(); } catch { return; }
    const r = target.getBoundingClientRect();
    const w = card.offsetWidth; const h = card.offsetHeight;
    const vw = window.innerWidth; const vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    let left = Math.min(Math.max(8, r.left + 24), vw - w - 8);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    cur = target;
  }
  function arm(target, d) {
    if (target === cur) return;
    hide();
    if (enabled && !enabled()) return;
    timer = setTimeout(() => { timer = 0; show(target); }, d);
  }
  const find = (e) => (e.target && e.target.closest && !(skip && e.target.closest(skip)) ? e.target.closest(selector) : null);
  root.addEventListener('pointerover', (e) => { if (e.pointerType === 'touch') return; const t = find(e); if (t) arm(t, delay); else if (cur || timer) hide(); });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focusin', (e) => { const t = find(e); if (t) arm(t, 120); });
  root.addEventListener('focusout', hide);
  root.addEventListener('scroll', hide, { passive: true });
  root.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('blur', hide);
  return { hide };
}
