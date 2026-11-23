// Multi-selection of the virtual list: tab-set cards (kind 'g') or single tabs (kind 'i'), never mixed.
// The selection is a Set of ROW KEYS ('g:<gid|vk>', 'i:<gid>:<pos>', 'f:<index>', 'h:<gid>:<seq>'): independent of DOM recycling, and a
// shift-range across pages that are not loaded yet works from positions only. Any data change clears it (positions would be stale).
import { strings } from './selstr.js';

export const MAX_RANGE = 20000;
export const kindOfKey = (k) => (k && k[0] === 'g' ? 'g' : k && (k[0] === 'i' || k[0] === 'f' || k[0] === 'h') ? 'i' : null);

export function createSelection(ctx) {
  const { scroller, spacer, S, V } = ctx;
  const T = () => strings(S.lang || 'th');
  const st = { kind: null, keys: new Set(), anchor: null, cursor: null };
  const subs = [];
  let live = null;

  function announce(text) {
    if (!live) { live = document.createElement('div'); live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); document.body.appendChild(live); }
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  }

  /** keys of the rows between two keys of the same kind (inclusive), in display order; null when they cannot be ordered */
  function between(a, b) {
    const ka = kindOfKey(a); const kb = kindOfKey(b);
    if (!ka || ka !== kb) return null;
    if (ka === 'g') {
      const ia = V.vIdx.get(a.slice(2)); const ib = V.vIdx.get(b.slice(2));
      if (ia == null || ib == null) return null;
      const out = [];
      for (let i = Math.min(ia, ib); i <= Math.max(ia, ib); i++) { const g = S.groups[i]; out.push('g:' + (g.vk || g.id)); }
      return out;
    }
    if (a[0] === 'f' && b[0] === 'f') {
      const x = +a.slice(2); const y = +b.slice(2);
      const out = [];
      for (let i = Math.min(x, y); i <= Math.max(x, y) && out.length <= MAX_RANGE; i++) out.push('f:' + i);
      return out;
    }
    if (a[0] === 'h' && b[0] === 'h') {
      const idx = new Map();
      V.srows.forEach((h, i) => { if (h.t === 'hit') idx.set('h:' + h.rec.g + ':' + h.rec.seq, i); });
      const x = idx.get(a); const y = idx.get(b);
      if (x == null || y == null) return null;
      const out = [];
      for (let i = Math.min(x, y); i <= Math.max(x, y); i++) if (V.srows[i].t === 'hit') out.push('h:' + V.srows[i].rec.g + ':' + V.srows[i].rec.seq);
      return out;
    }
    if (a[0] === 'i' && b[0] === 'i') {
      const pa = a.split(':'); const pb = b.split(':');
      const ga = pa[1]; const gb = pb[1];
      const x = +pa[2]; const y = +pb[2];
      if (ga === gb) { const out = []; for (let p = Math.min(x, y); p <= Math.max(x, y); p++) out.push(`i:${ga}:${p}`); return out; }
      let ia = V.idxOf.get(ga); let ib = V.idxOf.get(gb);
      if (ia == null || ib == null) return null;
      let lo = [ga, x]; let hi = [gb, y];
      if (ia > ib) { [ia, ib] = [ib, ia]; lo = [gb, y]; hi = [ga, x]; }
      const out = [];
      for (let p = lo[1]; p < ctx.groupOf(lo[0]).count; p++) out.push(`i:${lo[0]}:${p}`);
      for (let i = ia + 1; i < ib && out.length <= MAX_RANGE; i++) { const g = S.groups[i]; if (ctx.isOpen(g)) for (let p = 0; p < g.count; p++) out.push(`i:${g.id}:${p}`); }
      for (let p = 0; p <= hi[1]; p++) out.push(`i:${hi[0]}:${p}`);
      return out;
    }
    return null;
  }

  const emit = () => { for (const f of subs) f(); };
  function changed(quiet) {
    paintAll();
    emit();
    if (!quiet) announce(st.keys.size ? T().announceSel(st.keys.size) : T().announceNone);
  }
  function setKeys(keys, kind, { anchor, quiet } = {}) {
    st.keys = new Set(keys);
    st.kind = st.keys.size ? kind : null;
    if (anchor !== undefined) st.anchor = anchor;
    if (!st.keys.size) st.anchor = null;
    changed(quiet);
  }
  function clear() { if (!st.keys.size && !st.anchor) return; st.keys = new Set(); st.kind = null; st.anchor = null; st.cursor = null; changed(); }
  /** false (and a hint) when the key would mix tab sets with tabs */
  function allowed(key) {
    const k = kindOfKey(key);
    if (!k) return false;
    if (st.kind && st.kind !== k && st.keys.size) { ctx.toast(T().mixedHint, null, null, 3000); return false; }
    return true;
  }
  function select(key, mode) { // mode: 'one' | 'toggle' | 'range' | 'add'
    if (!allowed(key)) return;
    const k = kindOfKey(key);
    st.cursor = key;
    if (mode === 'one') setKeys([key], k, { anchor: key });
    else if (mode === 'toggle') {
      const n = new Set(st.keys);
      if (n.has(key)) n.delete(key); else n.add(key);
      setKeys(n, k, { anchor: key });
    } else if (mode === 'add') { const n = new Set(st.keys); n.add(key); setKeys(n, k, { anchor: st.anchor || key }); }
    else if (mode === 'range') {
      const r = st.anchor && kindOfKey(st.anchor) === k ? between(st.anchor, key) : null;
      if (!r) { setKeys([key], k, { anchor: key }); return; }
      if (r.length > MAX_RANGE) { ctx.toast(T().rangeBig(MAX_RANGE), null, null, 3000); return; }
      setKeys(r, k); // anchor stays: the range follows the pointer
    }
  }

  // ----- painting (called for every filled row and after a change) -----
  function paintRow(n) {
    const key = n._key;
    const sel = !!key && st.keys.has(key);
    if (n.classList.contains('sel') !== sel) n.classList.toggle('sel', sel);
    const ok = n.dataset.kind === 'item' ? !n._skel : n.dataset.kind === 'group';
    if (n._ariaInit !== ok) {
      n._ariaInit = ok;
      if (ok) { n.setAttribute('role', 'option'); n.tabIndex = -1; } else { n.removeAttribute('aria-selected'); n._ariaSel = null; n.setAttribute('role', 'presentation'); n.removeAttribute('tabindex'); }
    }
    if (ok) { const v = sel ? 'true' : 'false'; if (n._ariaSel !== v) { n._ariaSel = v; n.setAttribute('aria-selected', v); } }
    const cur = !!st.cursor && key === st.cursor;
    if (n.classList.contains('cur') !== cur) n.classList.toggle('cur', cur);
  }
  function paintAll() { for (const [, n] of V.live) paintRow(n); document.body.classList.toggle('has-sel', st.keys.size > 0); }

  // ----- pointer / keyboard -----
  const INTERACTIVE = 'button, input, select, textarea, [data-act], [contenteditable], summary';
  const rowOf = (el) => (el && el.closest ? el.closest('.vrow') : null);

  function onClick(e) {
    if (e.button !== 0 || ctx.dragged()) return;
    const row = rowOf(e.target);
    if (!row || !row._key) return;
    const key = row._key;
    if (!kindOfKey(key)) return;
    if (e.target.closest(INTERACTIVE) && !e.target.closest('a')) return;
    const link = e.target.closest('a.ilink');
    const title = e.target.closest('.gt');
    const mod = e.ctrlKey || e.metaKey;
    if (link && !e.shiftKey && !(mod && st.keys.size)) return; // a plain click on the link opens the tab (existing behaviour)
    if (title && !e.shiftKey && !mod && S.settings.titleClick === 'restore') return;
    if (e.target.closest('input')) return;
    e.preventDefault();
    e.stopPropagation();
    row.focus({ preventScroll: true });
    if (e.shiftKey) { getSelection().removeAllRanges(); select(key, 'range'); } else if (mod) select(key, 'toggle'); else select(key, 'one');
  }

  const liveRows = (kind) => [...V.live.values()].filter((n) => n._key && kindOfKey(n._key) === kind && !n.hidden && !n._skel).sort((a, b) => (a._top || 0) - (b._top || 0));
  function move(from, dir) {
    const kind = kindOfKey(from._key);
    const rows = liveRows(kind);
    const i = rows.indexOf(from);
    return rows[i + dir] || null;
  }
  function onKey(e) {
    const t = e.target;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
    const row = rowOf(t);
    const key = e.key;
    const kb = (n) => !ctx.kbOn || ctx.kbOn(n);
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'a') {
      if (!kb('kbSelect')) return;
      const base = (row && row._key) || st.cursor || st.anchor;
      const k = kindOfKey(base);
      if (!k) return;
      e.preventDefault();
      let all = null;
      if (k === 'g') all = S.groups.map((g) => 'g:' + (g.vk || g.id));
      else if (base[0] === 'i') { const gid = base.split(':')[1]; const g = ctx.groupOf(gid); if (g) all = between(`i:${gid}:0`, `i:${gid}:${Math.max(0, g.count - 1)}`); } else if (base[0] === 'f') all = between('f:0', 'f:' + Math.max(0, (V.fl ? V.fl.obj.total : 1) - 1));
      else all = between(V.srows.find((h) => h.t === 'hit') ? 'h:' + V.srows.find((h) => h.t === 'hit').rec.g + ':' + V.srows.find((h) => h.t === 'hit').rec.seq : '', base);
      if (all && all.length > MAX_RANGE) { ctx.toast(T().rangeBig(MAX_RANGE), null, null, 3000); all = all.slice(0, MAX_RANGE); }
      if (all) setKeys(all, k, { anchor: all[0] });
      return;
    }
    if (key === 'Escape' && st.keys.size && !ctx.menuOpen()) { e.preventDefault(); clear(); return; }
    if (!row || !row._key || !kindOfKey(row._key)) return;
    if ((key === ' ' || key === 'Spacebar') && !t.closest('button') && kb('kbSelect')) { e.preventDefault(); select(row._key, e.shiftKey ? 'range' : 'toggle'); return; }
    if ((key === 'ArrowDown' || key === 'ArrowUp') && kb('kbSelect')) {
      if (t.closest('button') && t !== row) return;
      const nx = move(row, key === 'ArrowDown' ? 1 : -1);
      if (!nx) return;
      e.preventDefault();
      nx.focus();
      st.cursor = nx._key;
      if (e.shiftKey) select(nx._key, 'range'); else if (e.ctrlKey || e.metaKey) paintAll(); else select(nx._key, 'one');
      return;
    }
    if (key === 'Enter' && t === row && st.keys.size && kb('kbSelect')) { e.preventDefault(); ctx.actions.openSel(); return; }
    if ((key === 'Delete' || key === 'Backspace') && kb('kbDelete')) {
      if (t.closest('button') && t !== row) return;
      e.preventDefault();
      if (!st.keys.has(row._key)) select(row._key, 'one');
      ctx.actions.deleteSel();
    }
  }

  function wire() {
    scroller.addEventListener('click', onClick, true);
    scroller.addEventListener('keydown', onKey);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !st.keys.size || ctx.menuOpen() || ctx.dragActive()) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
      clear();
    });
    scroller.addEventListener('dragstart', (e) => e.preventDefault(), true); // links / old HTML5 drag: the pointer drag replaces it
    spacer.setAttribute('role', 'listbox');
    spacer.setAttribute('aria-multiselectable', 'true');
    scroller.removeAttribute('role');
    spacer.setAttribute('aria-label', T().listLabel);
    scroller.setAttribute('aria-describedby', 'selHelp');
    const h = document.createElement('span'); h.id = 'selHelp'; h.className = 'sr-only'; h.textContent = T().kbHelp; document.body.appendChild(h);
  }

  return {
    st, wire, paintRow, paintAll, clear, select, setKeys, between, announce, allowed,
    get kind() { return st.kind; }, get keys() { return st.keys; }, get size() { return st.keys.size; },
    has: (k) => st.keys.has(k),
    onChange: (f) => subs.push(f),
  };
}
