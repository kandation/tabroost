// Box selection: press-drag on empty space (list background, the gap above a card, section labels; or Alt+drag anywhere) draws a
// translucent rectangle; the rows it touches are selected live (one pass per animation frame). Geometry comes from the list's own
// row positions (rowsIn), not from the DOM, so it works with the virtual list and while the list auto-scrolls.
//   plain drag = replace, Shift = add to the selection, Ctrl/Cmd = toggle the touched rows. Esc cancels.
import { strings } from './selstr.js';

const THRESH = 5;
const EDGE = 48;

export function createMarquee(ctx, sel) {
  const { scroller, S } = ctx;
  const T = () => strings(S.lang || 'th');
  let m = null;
  let box = null;
  let was = false;

  function startOk(e) {
    if (e.button !== 0 || e.pointerType === 'touch') return false;
    const r = scroller.getBoundingClientRect();
    if (e.clientX - r.left >= scroller.clientWidth) return false; // the scrollbar
    if (e.target.closest('button, input, select, textarea, [data-act], [contenteditable]')) return false;
    if (e.altKey) return true; // Alt+drag starts anywhere (also on a title link)
    if (e.target.closest('a')) return false;
    if (e.target === scroller || e.target === ctx.spacer) return true;
    const row = e.target.closest('.vrow');
    if (!row) return false;
    if (e.target !== row) return false;
    const k = row.dataset.kind;
    if (k === 'bucket' || k === 'note' || k === 'sub') return true;
    if (k === 'group' && e.clientY - row.getBoundingClientRect().top < 8) return true; // the gap above the card
    return false;
  }

  function hits() {
    const r = scroller.getBoundingClientRect();
    const cy = scroller.scrollTop + (m.y - r.top);
    const y0 = Math.min(m.cy0, cy); const y1 = Math.max(m.cy0, cy);
    const gk = []; const ik = [];
    for (const row of ctx.rowsIn(y0, y1)) {
      const h = row.kind === 'group' ? ctx.H.group : row.kind === 'item' ? ctx.H.item : 0;
      if (!h || row.top + h <= y0 || row.top >= y1) continue;
      (row.kind === 'group' ? gk : ik).push(row.key);
    }
    return { gk, ik };
  }

  function frame() {
    m.raf = 0;
    if (!m || !m.on) return;
    const r = scroller.getBoundingClientRect();
    let v = 0;
    if (m.y < r.top + EDGE) v = -Math.min(1, (r.top + EDGE - m.y) / EDGE) * 18;
    else if (m.y > r.bottom - EDGE) v = Math.min(1, (m.y - (r.bottom - EDGE)) / EDGE) * 18;
    if (v) scroller.scrollTop += v;
    // rectangle on screen (clipped to the list)
    const x0 = m.cx0 + r.left; const y0s = m.cy0 - scroller.scrollTop + r.top;
    const L = Math.max(r.left, Math.min(x0, m.x)); const R = Math.min(r.left + scroller.clientWidth, Math.max(x0, m.x));
    const Tp = Math.max(r.top, Math.min(y0s, m.y)); const B = Math.min(r.bottom, Math.max(y0s, m.y));
    box.style.cssText = `left:${L}px;top:${Tp}px;width:${Math.max(0, R - L)}px;height:${Math.max(0, B - Tp)}px`;
    const { gk, ik } = hits();
    let kind = m.mode === 'replace' ? (ik.length ? 'i' : 'g') : (sel.kind || (ik.length ? 'i' : 'g'));
    if (m.mode !== 'replace' && m.base.size === 0) kind = ik.length ? 'i' : 'g';
    const touched = kind === 'i' ? ik : gk;
    let out;
    if (m.mode === 'replace') out = new Set(touched);
    else if (m.mode === 'add') { out = new Set(m.base); for (const k of touched) out.add(k); } else { out = new Set(m.base); for (const k of touched) { if (m.base.has(k)) out.delete(k); else out.add(k); } }
    sel.setKeys(out, kind, { quiet: true });
    if (v) m.raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (m && !m.raf) m.raf = requestAnimationFrame(frame); };

  function end(cancel) {
    const cur = m;
    m = null;
    if (!cur) return;
    cancelAnimationFrame(cur.raf);
    try { scroller.releasePointerCapture(cur.pid); } catch { /* ignore */ }
    if (box) { box.remove(); box = null; }
    document.body.classList.remove('marquee-on');
    if (!cur.on) { if (!cancel && cur.mode === 'replace') sel.clear(); return; }
    was = true; setTimeout(() => { was = false; }, 0);
    if (cancel) sel.setKeys(cur.base, cur.baseKind, { quiet: true });
    sel.announce(sel.size ? T().announceSel(sel.size) : T().announceNone);
  }

  function wire() {
    scroller.addEventListener('pointerdown', (e) => {
      if (ctx.dragActive() || !startOk(e)) return;
      const r = scroller.getBoundingClientRect();
      const mode = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace';
      m = { pid: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, cx0: e.clientX - r.left, cy0: scroller.scrollTop + e.clientY - r.top, mode, base: new Set(mode === 'replace' ? [] : sel.keys), baseKind: sel.kind, on: false, raf: 0 };
      if (mode === 'replace') { m.base = new Set(sel.keys); m.baseKind = sel.kind; }
      e.preventDefault(); // no native text selection / focus jump while boxing
      scroller.focus({ preventScroll: true });
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!m || e.pointerId !== m.pid) return;
      m.x = e.clientX; m.y = e.clientY;
      if (!m.on) {
        if (Math.hypot(m.x - m.x0, m.y - m.y0) < THRESH) return;
        m.on = true;
        box = document.createElement('div');
        box.className = 'marquee';
        document.body.appendChild(box);
        document.body.classList.add('marquee-on');
        try { scroller.setPointerCapture(m.pid); } catch { /* ignore */ }
      }
      kick();
    });
    window.addEventListener('pointerup', (e) => { if (m && e.pointerId === m.pid) end(false); });
    window.addEventListener('pointercancel', (e) => { if (m && e.pointerId === m.pid) end(true); });
    window.addEventListener('keydown', (e) => { if (m && m.on && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); } }, true);
    scroller.addEventListener('click', (e) => { if (was) { e.preventDefault(); e.stopPropagation(); } }, true);
    scroller.addEventListener('scroll', () => { if (m && m.on) kick(); }, { passive: true });
  }
  return { wire, active: () => !!(m && m.on) };
}
