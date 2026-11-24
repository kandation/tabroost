// Wires the selection, the drag UI, the box selection and the item actions together, and draws the bulk-action bar and the
// move / copy menus. stash.js calls initSelUi(ctx) once and a few one-line hooks (paintRow, clear, decorateItemRow).
import { createSelection } from './selection.js';
import { createActions } from './itemactions.js';
import { createDnd } from './dnd.js';
import { createMarquee } from './marquee.js';
import { strings } from './selstr.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

export function initSelUi(ctx) {
  const { S } = ctx;
  const T = () => strings(S.lang || 'th');
  const sel = createSelection(ctx);
  const actions = createActions(ctx, sel);
  ctx.actions = actions;
  let dnd = null; let mq = null;
  ctx.dragged = () => !!(dnd && dnd.dragged());
  ctx.dragActive = () => !!((dnd && dnd.active()) || (mq && mq.active()));
  dnd = createDnd(ctx, sel, actions);
  mq = createMarquee(ctx, sel);

  // ----- menu / picker dialogs (native <dialog>: focus trap + Esc for free) -----
  function menuDialog(title, items, { search = null, empty = '' } = {}) {
    const prev = document.activeElement;
    const dlg = el('dialog', 'sel-dlg');
    dlg.setAttribute('aria-label', title);
    const head = el('h2', 'sd-h', title);
    const list = el('div', 'sd-list');
    list.setAttribute('role', 'menu');
    let input = null;
    const render = (q) => {
      list.textContent = '';
      let n = 0;
      for (const it of (typeof items === 'function' ? items(q || '') : items)) {
        if (it.sep) { list.appendChild(el('div', 'sd-sep')); continue; }
        const b = el('button', 'sd-item' + (it.danger ? ' danger' : '') + (it.strong ? ' strong' : ''));
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        if (it.dot) { const d = el('span', 'dot'); d.dataset.c = it.dot; b.appendChild(d); }
        b.appendChild(el('span', 'sd-l', it.label));
        if (it.hint) b.appendChild(el('span', 'sd-hint', it.hint));
        b.addEventListener('click', () => { dlg.close(); setTimeout(() => it.run(), 0); });
        list.appendChild(b);
        n++;
      }
      if (!n && empty) list.appendChild(el('div', 'sd-empty', empty));
    };
    dlg.append(head);
    if (search) {
      input = el('input', 'sd-search');
      input.type = 'search'; input.placeholder = search; input.setAttribute('aria-label', search);
      input.addEventListener('input', () => render(input.value.trim().toLowerCase()));
      dlg.append(input);
    }
    dlg.append(list);
    render('');
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const bs = [...list.querySelectorAll('button')];
      if (!bs.length) return;
      e.preventDefault();
      const i = bs.indexOf(document.activeElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true }); });
    document.body.appendChild(dlg);
    dlg.showModal();
    (input || list.querySelector('button') || dlg).focus();
    return dlg;
  }

  function setPicker(p, cat) {
    const t = T();
    const src = new Set(p.kind === 'i' ? ctx.srcGids(p.keys) : []);
    const items = (q) => {
      const out = [];
      if (cat != null && !q) out.push({ label: t.newInCat, strong: true, run: () => actions.applyTarget(p, { t: 'cat', cat }) });
      if (cat == null && !q) out.push({ label: t.newSet, strong: true, run: () => actions.applyTarget(p, { t: 'new' }) });
      let n = 0;
      for (const g of S.allGroups) {
        if (g.deletedAt != null || g.locked || (src.size === 1 && src.has(g.id)) || (cat != null && (g.cat || '') !== cat)) continue;
        const name = g.title && g.title.trim() ? g.title : ctx.fmtDate(g.createdAt);
        if (q && !name.toLowerCase().includes(q)) continue;
        out.push({ label: name, hint: t.tabsN(g.count), run: () => actions.applyTarget(p, { t: 'set', gid: g.id }) });
        if (++n >= 60) break;
      }
      return out;
    };
    menuDialog(t.pickSet, items, { search: t.pickSetPh, empty: t.pickNone });
  }

  function moveMenu(p = actions.payloadOf()) {
    if (!p.keys.length) return;
    const t = T();
    const flagItems = (labels) => labels.map(([k, label]) => ({ label, run: () => actions.applyTarget(p, { t: k }) }));
    const items = [];
    if (p.kind === 'i') items.push({ label: t.splitSet, strong: true, run: () => actions.applyTarget(p, { t: 'new' }) }, { label: t.otherSet, run: () => setPicker(p, null) }, { sep: true });
    items.push(...flagItems([['pin', t.pin], ['star', t.star], ['pending', t.todo], ['archive', t.archive]]));
    items.push({ sep: true });
    for (const c of S.cats) items.push({ label: c.name, dot: c.color, hint: p.kind === 'i' ? '…' : '', run: () => (p.kind === 'i' ? setPicker(p, c.id) : actions.applyTarget(p, { t: 'cat', cat: c.id })) });
    items.push({ label: t.noCat, run: () => actions.applyTarget(p, p.kind === 'i' ? { t: 'new' } : { t: 'uncat' }) }, { label: t.newCat, run: () => actions.applyTarget(p, { t: 'newcat' }) }, { sep: true }, { label: t.trash, danger: true, run: () => actions.applyTarget(p, { t: 'trash' }) });
    menuDialog(t.moveTo, items);
  }
  function copyMenu(p = actions.payloadOf()) {
    const t = T();
    menuDialog(t.copy, [{ label: t.copyTitle, run: () => actions.copy(p, 'title') }, { label: t.copyUrl, run: () => actions.copy(p, 'url') }, { label: t.copyBoth, run: () => actions.copy(p, 'both') }]);
  }

  // ----- the bulk-action bar -----
  const bar = el('div', 'selbar');
  bar.id = 'selbar'; bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  const barCount = el('span', 'sb-n');
  const btns = {};
  const mkBtn = (id, run, cls) => { const b = el('button', 'sb-b' + (cls ? ' ' + cls : '')); b.type = 'button'; b.addEventListener('click', run); btns[id] = b; return b; };
  bar.append(barCount, mkBtn('open', () => actions.openSel()), mkBtn('move', () => moveMenu()), mkBtn('copy', () => copyMenu()), mkBtn('star', () => actions.applyTarget(actions.payloadOf(), { t: 'star' })), mkBtn('pin', () => actions.applyTarget(actions.payloadOf(), { t: 'pin' })), mkBtn('del', () => actions.deleteSel(), 'danger'), mkBtn('clear', () => sel.clear(), 'ghost'));
  document.body.appendChild(bar);
  function renderBar() {
    const n = sel.size;
    bar.hidden = !n;
    if (!n) return;
    const t = T();
    bar.setAttribute('aria-label', t.bar);
    barCount.textContent = sel.kind === 'g' ? t.selSets(n) : t.selTabs(n);
    btns.open.textContent = t.open; btns.move.textContent = t.moveTo; btns.copy.textContent = t.copy;
    btns.star.textContent = t.star; btns.pin.textContent = t.pin; btns.del.textContent = t.del; btns.clear.textContent = t.clear;
    btns.star.hidden = btns.pin.hidden = sel.kind !== 'g';
  }
  sel.onChange(renderBar);

  sel.wire(); dnd.wire(); mq.wire();
  ctx.scroller.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act="copyTab"]');
    if (!b) return;
    e.stopPropagation();
    const row = b.closest('.vrow');
    if (row && row._key && sel.has(row._key)) copyMenu(); else if (row && row._key) copyMenu({ kind: 'i', keys: [row._key] });
  }, true);
  ctx.scroller.addEventListener('keydown', (e) => {
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey && sel.size && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); moveMenu(); }
  });

  /** per-row hover copy button; the delete button moves to the FRONT of the row */
  function decorateItemRow(n) {
    const t = T();
    n._cp = ctx.actBtn('copyTab', '', 'cpb', t.copy);
    n._cp.title = t.copy;
    n._cp.setAttribute('aria-label', t.copy);
    n._cp.appendChild(ctx.ICON('copy'));
    n._x.title = t.delTab; n._x.setAttribute('aria-label', t.delTab);
    n.prepend(n._x, n._cp); // delete, then copy, both in front of the favicon (at the far end they were too far from the title)
  }

  return { sel, actions, clear: () => sel.clear(), paintRow: (n) => sel.paintRow(n), decorateItemRow, moveMenu, copyMenu, menuDialog };
}
