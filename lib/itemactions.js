// Actions on the selection (or on a dragged payload): copy, open, delete, move tabs between tab sets, apply a drop target.
// A PAYLOAD is {kind:'g'|'i', keys:[row keys]}. Tabs are resolved to {gid, seq, url, title} lazily (pages may not be loaded).
// Every change is one undo step: the toast's undo sends the inverse messages.
import { strings } from './selstr.js';

export function createActions(ctx, sel) {
  const { S, send } = ctx;
  const T = () => strings(S.lang || 'th');
  const payloadOf = (keys) => {
    const ks = [...(keys || sel.keys)];
    return { kind: sel.kind || (ks[0] && ks[0][0] === 'g' ? 'g' : 'i'), keys: ks };
  };
  const gidOfKey = (k) => { const id = k.slice(2); const i = ctx.V.vIdx.get(id); return i != null ? S.groups[i].id : id; };
  const gidsOf = (p) => (p.kind === 'g' ? [...new Set(p.keys.map(gidOfKey))] : []);
  const undoToast = (text, undos) => ctx.toast(text, T().undo, async () => { for (const u of undos.slice().reverse()) await send(u); ctx.toast(T().undo + ' ✓', null, null, 1800); }, 10000);

  async function tabsOf(p) { // [{gid, seq, url, title}] in display order
    if (p.kind === 'g') {
      const out = [];
      for (const gid of gidsOf(p)) for (const it of await ctx.allItemsOf(gid, 50000)) out.push({ gid, seq: it.seq, url: it.url, title: it.title });
      return out;
    }
    return ctx.resolveKeys(p.keys);
  }

  async function writeClip(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0'; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
  /** mode: 'title' | 'url' | 'both'. One line per tab. */
  async function copy(p, mode) {
    const tabs = await tabsOf(p);
    if (!tabs.length) return;
    const line = (t) => (mode === 'title' ? (t.title || t.url) : mode === 'url' ? t.url : `${t.title || t.url} | ${t.url}`);
    const ok = await writeClip(tabs.map(line).join('\n'));
    ctx.toast(ok ? T().copied(tabs.length) : T().copyFail, null, null, 2500);
    if (ok) sel.announce(T().copied(tabs.length));
  }

  async function openSel(p = payloadOf()) {
    if (p.kind === 'g') { for (const gid of gidsOf(p)) await ctx.doRestoreGroup(gid); return; }
    const tabs = await tabsOf(p);
    const r = await send({ type: 'restoreItems', keys: tabs.map((t) => t.gid + ':' + t.seq), newWindow: false });
    if (!r.ok) ctx.toastError(r);
  }

  async function deletePayload(p = payloadOf()) {
    const undos = []; let n = 0; let locked = 0;
    if (p.kind === 'g') {
      for (const gid of gidsOf(p)) {
        const g = ctx.groupOf(gid);
        if (g && g.locked) { locked++; continue; }
        const r = await send({ type: 'deleteGroup', groupId: gid });
        if (r.ok && r.undo) { undos.push(r.undo); n++; }
      }
    } else {
      const by = new Map();
      for (const t of await tabsOf(p)) { if (!by.has(t.gid)) by.set(t.gid, []); by.get(t.gid).push(t.seq); }
      for (const [gid, seqs] of by) {
        const g = ctx.groupOf(gid);
        if (g && g.locked) { locked += seqs.length; continue; }
        for (let i = 0; i < seqs.length; i += 2000) {
          const r = await send({ type: 'deleteItems', groupId: gid, seqs: seqs.slice(i, i + 2000) });
          if (r.ok && r.undo) { undos.push(r.undo); n += Math.min(2000, seqs.length - i); }
        }
      }
    }
    sel.clear();
    if (!n) { ctx.toast(locked ? ctx.STR.locked : T().moveFailed, null, null, 3000); return; }
    undoToast(T().deleted(n), undos);
    sel.announce(T().deleted(n));
  }
  const deleteSel = () => (sel.size ? deletePayload() : null);

  async function moveTabs(p, dst, text) { // dst: {gid} | {create:{...}}
    const tabs = await tabsOf(p);
    if (!tabs.length) return null;
    const by = new Map();
    for (const t of tabs) { if (!by.has(t.gid)) by.set(t.gid, []); by.get(t.gid).push(t.seq); }
    const moves = [...by].map(([gid, seqs]) => ({ gid, seqs }));
    const r = await send({ type: 'moveItems', moves, dst });
    if (!r.ok) { ctx.toast(r.error === 'locked' ? T().lockedSet : r.error === 'same' ? T().sameSet : T().moveFailed, null, null, 3000); return null; }
    sel.clear();
    undoToast(text(r.n), [r.undo]);
    return r;
  }

  // ----- apply a drop target to a payload -----
  const FLAG = { pin: 'pinned', star: 'starred', pending: 'pending', archive: 'archived' };
  async function applyTarget(p, tg) {
    const t = T();
    if (tg.t === 'newcat') {
      const c = await ctx.catAddPrompt();
      if (!c) return null;
      tg = { t: 'cat', cat: c.id };
    }
    if (p.kind === 'i') {
      if (tg.t === 'trash') return deletePayload(p);
      if (tg.t === 'set') {
        const g = ctx.groupOf(tg.gid);
        return moveTabs(p, { gid: tg.gid }, (n) => t.moved(n, (g && g.title) || t.ghostSets));
      }
      if (tg.t === 'new') return moveTabs(p, { create: {} }, t.movedNew);
      const create = {}; let did = '';
      if (FLAG[tg.t]) { create[FLAG[tg.t]] = true; did = t.did[tg.t === 'archive' ? 'archive' : tg.t === 'pending' ? 'pending' : tg.t]; }
      else if (tg.t === 'cat') { create.cat = tg.cat; did = t.did.cat; } else return null;
      return moveTabs(p, { create }, (n) => t.newFrom(n, did));
    }
    // whole tab sets
    const gids = gidsOf(p);
    if (tg.t === 'trash') return deletePayload(p);
    if (FLAG[tg.t]) {
      const f = FLAG[tg.t];
      const gs = gids.map(ctx.groupOf).filter(Boolean);
      const val = !gs.every((g) => g[f]);
      const prev = gs.map((g) => [g.id, !!g[f]]);
      for (const g of gs) await send({ type: 'setFlag', groupId: g.id, flag: f, value: val });
      sel.clear();
      const did = tg.t === 'pin' ? (val ? 'pin' : 'unpin') : tg.t === 'star' ? (val ? 'star' : 'unstar') : tg.t === 'pending' ? (val ? 'pending' : 'unpending') : 'archive';
      undoToast(t.setDone(gs.length, t.did[did]), prev.map(([id, v]) => ({ type: 'setFlag', groupId: id, flag: f, value: v })));
      return null;
    }
    if (tg.t === 'cat' || tg.t === 'uncat') {
      const cat = tg.t === 'cat' ? tg.cat : null;
      const gs = gids.map(ctx.groupOf).filter(Boolean);
      const prev = new Map();
      for (const g of gs) { const k = g.cat || ''; if (!prev.has(k)) prev.set(k, []); prev.get(k).push(g.id); }
      const r = await send({ type: 'groupsSetCat', gids, cat });
      if (!r.ok) { ctx.toastError(r); return null; }
      sel.clear();
      undoToast(t.setDone(gs.length, t.did[tg.t]), [...prev].map(([k, ids]) => ({ type: 'groupsSetCat', gids: ids, cat: k || null })));
      return null;
    }
    if (tg.t === 'order') { // manual order: new `ord` values between the neighbours
      const gs = gids.map(ctx.groupOf).filter(Boolean);
      const prev = gs.map((g) => [g.id, g.ord]);
      const step = (tg.hi - tg.lo) / (gs.length + 1);
      let k = 1;
      for (const g of gs) await send({ type: 'setOrd', groupId: g.id, ord: tg.lo + step * k++ });
      sel.clear();
      undoToast(t.setDone(gs.length, t.did.reorder), prev.map(([id, o]) => ({ type: 'setOrd', groupId: id, ord: o })));
    }
    return null;
  }

  return { payloadOf, gidsOf, tabsOf, copy, openSel, deleteSel, deletePayload, moveTabs, applyTarget, undoToast, deleteIfSelected(row) { if (row && row._key && sel.has(row._key) && sel.size > 1) { deletePayload(); return true; } return false; } };
}
