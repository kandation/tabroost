// Pointer-based drag and drop with a real drag UI (works with the virtual list and with touch; not HTML5 DnD).
//  - starts after 5 px of movement (mouse/pen) or a 350 ms long press (touch); Esc or pointercancel cancels
//  - a floating ghost (first title + count badge) follows the pointer; the dragged rows are dimmed (body.dnd-active .sel)
//  - valid sidebar targets get an outline + "วางที่นี่", the others are dimmed; the list edges auto-scroll
//  - tabs can also be dropped on another tab-set card; with sort = manual, tab sets can be dropped between cards to reorder
import { strings } from './selstr.js';
import { kindOfKey } from './selection.js';

const THRESH = 5;
const EDGE = 56;

export function createDnd(ctx, sel, actions) {
  const { scroller, S, V } = ctx;
  const T = () => strings(S.lang || 'th');
  let d = null;
  let justDragged = false;
  let ghost = null;
  let line = null;
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const targetEls = () => [...document.querySelectorAll('#nav .navi, .sidefoot .navi, #nav [data-act="catAdd"]')];
  function navTarget(el, kind) {
    if (el.dataset.act === 'catAdd') return { t: 'newcat' };
    const nv = el.dataset.nav;
    if (nv === 'pinned') return { t: 'pin' };
    if (nv === 'starred') return { t: 'star' };
    if (nv === 'pending') return { t: 'pending' };
    if (nv === 'archived') return { t: 'archive' };
    if (nv === 'trash') return { t: 'trash' };
    if (nv === 'cat') return { t: 'cat', cat: el.dataset.cat };
    if (nv === 'uncat') return kind === 'i' ? { t: 'new' } : { t: 'uncat' };
    return null;
  }

  function buildGhost() {
    const g = document.createElement('div');
    g.className = 'dnd-ghost';
    g.setAttribute('aria-hidden', 'true');
    g.append(Object.assign(document.createElement('span'), { className: 'gh-t' }), Object.assign(document.createElement('span'), { className: 'gh-n' }));
    document.body.appendChild(g);
    return g;
  }
  function titleOf(row) {
    const el = row.querySelector('.gt') || row.querySelector('a.ilink');
    return (el && el.textContent) || '';
  }

  function start(e) {
    const row = d.row;
    if (!sel.has(row._key)) sel.select(row._key, 'one');
    d.p = actions.payloadOf();
    d.on = true;
    d.kind = d.p.kind;
    justDragged = true;
    getSelection().removeAllRanges();
    document.body.classList.add('dnd-active');
    ghost = buildGhost();
    const n = d.p.keys.length;
    ghost.firstChild.textContent = d.kind === 'g' ? (n === 1 ? titleOf(row) || T().setsN(1) : T().setsN(n)) : (n === 1 ? titleOf(row) : titleOf(row));
    ghost.lastChild.textContent = d.kind === 'g' ? T().setsN(n) : T().tabsN(n);
    ghost.classList.toggle('multi', n > 1);
    for (const el of targetEls()) {
      const tg = navTarget(el, d.kind);
      el.classList.toggle('dnd-ok', !!tg);
      el.classList.toggle('dnd-bad', !tg);
      el.dataset.drop = T().dropHere;
    }
    try { scroller.setPointerCapture(d.pid); } catch { /* touch has implicit capture */ }
    ctx.say(T().dragHint);
    place(e);
    loop();
  }
  function place(e) {
    d.x = e.clientX; d.y = e.clientY;
    if (ghost) ghost.style.transform = `translate(${d.x + 14}px, ${d.y + 12}px) scale(1.03)`;
  }

  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const nav = el.closest && el.closest('#nav .navi, .sidefoot .navi, #nav [data-act="catAdd"]');
    if (nav) { const tg = navTarget(nav, d.kind); return tg ? { tg, el: nav } : { tg: null, el: nav }; }
    const r = scroller.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const row = el.closest('.vrow');
      if (d.kind === 'i' && row && row.dataset.kind === 'group' && row._key) {
        const gid = row.dataset.g;
        const g = ctx.groupOf(gid);
        if (g && !g.locked) return { tg: { t: 'set', gid }, el: row };
      }
      if (d.kind === 'g' && S.vs.sort === 'manual' && V.mode === 'groups') {
        const cy = scroller.scrollTop + (y - r.top);
        let i = 0;
        const n = S.groups.length;
        while (i < n && V.tops[i] + (V.bucketAt[i] ? ctx.H.bucket : 0) + ctx.H.group / 2 < cy) i++; // insertion index (before group i)
        const prev = S.groups[i - 1]; const next = S.groups[i];
        const dir = S.vs.sortRev ? -1 : 1;
        const a = prev ? prev.ord : next ? next.ord - 2 * dir : 0;
        const b = next ? next.ord : prev ? prev.ord + 2 * dir : 1;
        const topY = i < n ? V.tops[i] : V.total;
        return { tg: { t: 'order', lo: Math.min(a, b), hi: Math.max(a, b) }, lineY: topY - scroller.scrollTop + r.top, lineX: r };
      }
    }
    return null;
  }

  function hover() {
    const hit = targetAt(d.x, d.y);
    const el = hit && hit.el;
    if (d.over !== el) {
      if (d.over) d.over.classList.remove('dnd-over');
      if (el && hit.tg) el.classList.add('dnd-over');
      d.over = el && hit.tg ? el : null;
    }
    d.hit = hit && hit.tg ? hit : null;
    ghost.classList.toggle('ok', !!d.hit);
    if (hit && hit.lineY != null) {
      if (!line) { line = document.createElement('div'); line.className = 'dnd-line'; document.body.appendChild(line); }
      line.style.cssText = `top:${hit.lineY - 1}px;left:${hit.lineX.left + 8}px;width:${hit.lineX.width - 24}px`;
    } else if (line) { line.remove(); line = null; }
  }

  function loop() {
    if (!d || !d.on) return;
    const r = scroller.getBoundingClientRect();
    let v = 0;
    if (d.x >= r.left && d.x <= r.right) {
      if (d.y < r.top + EDGE) v = -Math.min(1, (r.top + EDGE - d.y) / EDGE) * 20;
      else if (d.y > r.bottom - EDGE) v = Math.min(1, (d.y - (r.bottom - EDGE)) / EDGE) * 20;
    }
    if (v) scroller.scrollTop += v;
    hover();
    d.raf = requestAnimationFrame(loop);
  }

  function finish(cancelled) {
    const cur = d;
    d = null;
    if (!cur) return;
    clearTimeout(cur.timer);
    window.removeEventListener('touchmove', blockTouch);
    if (!cur.on) return;
    cancelAnimationFrame(cur.raf);
    document.body.classList.remove('dnd-active');
    for (const el of targetEls()) { el.classList.remove('dnd-ok', 'dnd-bad', 'dnd-over'); delete el.dataset.drop; }
    if (cur.over) cur.over.classList.remove('dnd-over');
    if (line) { line.remove(); line = null; }
    const g = ghost; ghost = null;
    try { scroller.releasePointerCapture(cur.pid); } catch { /* ignore */ }
    setTimeout(() => { justDragged = false; }, 0);
    const hit = cancelled ? null : cur.hit;
    if (g) {
      if (reduce()) g.remove();
      else {
        const to = hit && hit.el && hit.el.getBoundingClientRect ? hit.el.getBoundingClientRect() : null;
        const tx = to ? to.left + 20 : cur.x + 14; const ty = to ? to.top + to.height / 2 - 14 : cur.y + 12;
        const a = g.animate([{ transform: g.style.transform, opacity: 1 }, { transform: `translate(${tx}px, ${ty}px) scale(${hit ? 0.4 : 0.9})`, opacity: 0 }], { duration: hit ? 200 : 140, easing: 'cubic-bezier(.2,.8,.2,1)' });
        a.onfinish = () => g.remove();
        setTimeout(() => g.remove(), 400);
      }
    }
    if (hit) actions.applyTarget(cur.p, hit.tg);
    else if (cancelled) { sel.announce(T().dragCancel); }
  }

  const blockTouch = (e) => { if (d && d.on && e.cancelable) e.preventDefault(); };

  function wire() {
    scroller.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      if (e.altKey) return; // Alt+drag is the box selection
      const row = e.target.closest && e.target.closest('.vrow');
      if (!row || !row._key || !kindOfKey(row._key) || row.dataset.kind === 'bucket') return;
      if (e.target.closest('button, input, select, textarea, [data-act], [contenteditable]')) return;
      if (row.dataset.kind === 'item' && row._skel) return;
      d = { row, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, touch: e.pointerType === 'touch' };
      if (d.touch) {
        d.timer = setTimeout(() => { if (d && !d.on) { window.addEventListener('touchmove', blockTouch, { passive: false }); start({ clientX: d.x, clientY: d.y }); } }, 350);
      }
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.pid) return;
      if (!d.on) {
        const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
        d.x = e.clientX; d.y = e.clientY;
        if (d.touch) { if (dist > 10) { clearTimeout(d.timer); d = null; } return; }
        if (dist < THRESH) return;
        start(e);
        return;
      }
      place(e);
    });
    window.addEventListener('pointerup', (e) => { if (d && e.pointerId === d.pid) finish(false); });
    window.addEventListener('pointercancel', (e) => { if (d && e.pointerId === d.pid) finish(true); });
    window.addEventListener('keydown', (e) => {
      if (d && d.on && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(true); }
    }, true);
    scroller.addEventListener('click', (e) => { if (justDragged) { e.preventDefault(); e.stopPropagation(); } }, true);
    window.addEventListener('blur', () => finish(true));
  }

  return { wire, active: () => !!(d && d.on), dragged: () => justDragged };
}
