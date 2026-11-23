// Chrome split view (two tabs side by side): pure pairing helpers + guarded wrappers around the tabs API.
//
// Facts (measured on Chrome 158, see docs/split-view-findings.md): both panes are ordinary tabs; they share a per-session random
// `splitViewId` (never persisted: it only means something inside ONE tabs.query result); tabs.createSplit([a, b]) needs two
// ADJACENT tabs of the same window with the same pinned state and groupId; discarding a pane gives it a NEW tab id but keeps the
// pairing; moving / closing one pane dissolves the split.
//
// Every use of the API is guarded (Chrome < 155 has no createSplit, Chrome < 140 has no splitViewId): without them everything
// behaves exactly as before. Saved items carry `sv` = a small pair index (like `tg`), set ONLY when both panes are saved together.

/** The (session-local) split view id of a tab, or -1 when it is not part of a split view / the browser has no such field. */
export function splitIdOf(t) {
  return t && typeof t.splitViewId === 'number' && t.splitViewId >= 0 ? t.splitViewId : -1;
}

/** A valid saved pair index (item field `sv`) or -1. */
export function svIndex(it) {
  return it && Number.isInteger(it.sv) && it.sv >= 0 && it.sv < 65536 ? it.sv : -1;
}

/**
 * keys[i] = a pairing key (any string / number) or null/undefined for entries that are not split panes. Returns, per entry, a pair
 * index 0.. (or -1): only keys that occur EXACTLY twice and on two neighbouring entries become a pair (anything else is plain).
 */
export function pairIndexes(keys) {
  const n = keys.length;
  const count = new Map();
  for (const k of keys) if (k != null) count.set(k, (count.get(k) || 0) + 1);
  const out = new Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i + 1 < n; i++) {
    const k = keys[i];
    if (k != null && keys[i + 1] === k && count.get(k) === 2) { out[i] = out[i + 1] = next++; i++; }
  }
  return out;
}

/** True when saved items a and b (neighbours, in order) are the two panes of one saved split pair. */
export function isPair(a, b) {
  return !!a && !!b && svIndex(a) >= 0 && a.sv === b.sv && a.g === b.g && (a.w || 1) === (b.w || 1) && (a.tg == null ? -1 : a.tg) === (b.tg == null ? -1 : b.tg);
}

/** Groups item positions into restore units: [[0], [1, 2], [3]] (a pair is one unit when `allow`). */
export function pairUnits(items, allow = true) {
  const units = [];
  for (let i = 0; i < items.length; i++) {
    if (allow && i + 1 < items.length && isPair(items[i], items[i + 1])) { units.push([i, i + 1]); i++; } else units.push([i]);
  }
  return units;
}

/**
 * Sweep / auto-stash helper. `cands` = tabs that passed the individual idle checks, `all` = every tab of the browser (a query
 * WITHOUT the sweep's pre-filters). A split pane stays a candidate only when EVERY other (not yet discarded) pane of its split view
 * is a candidate too: an active, audible, loading, protected or recently used partner shields the whole pair.
 * Returns {ok: candidates that may go, units: Map(tabId -> [candidate panes of the same split view]), blocked: Set(tabId)}.
 */
export function splitGuard(cands, all) {
  const units = new Map();
  const blocked = new Set();
  if (!cands.some((t) => splitIdOf(t) >= 0)) return { ok: cands, units, blocked };
  const candIds = new Set(cands.map((t) => t.id));
  const members = new Map(); // key -> panes
  for (const t of all) {
    if (splitIdOf(t) < 0) continue;
    const k = t.windowId + ':' + splitIdOf(t);
    if (!members.has(k)) members.set(k, []);
    members.get(k).push(t);
  }
  const ok = [];
  for (const t of cands) {
    const sv = splitIdOf(t);
    if (sv < 0) { ok.push(t); continue; }
    const list = members.get(t.windowId + ':' + sv) || [t];
    const live = list.filter((m) => !m.discarded);
    const bad = list.length < 2 || live.some((m) => !candIds.has(m.id)); // list < 2: cannot tell (unexpected) -> doubt never discards
    const unit = live.filter((m) => candIds.has(m.id));
    units.set(t.id, unit);
    if (bad) blocked.add(t.id); else ok.push(t);
  }
  return { ok, units, blocked };
}

// ---------- guarded browser calls ----------
let apiOff = false; // dev-only switch (sw.js debug:splitApi): behave like Chrome < 155
export const debugDisableSplit = (v) => { apiOff = !!v; };
export const canSplit = () => !apiOff && typeof chrome !== 'undefined' && !!chrome.tabs && typeof chrome.tabs.createSplit === 'function';

/**
 * Splits two tabs that were just created (same window / pinned / groupId expected; adjacency is repaired when needed).
 * Never throws. Returns {ok, id?, reason?}.
 */
export async function createSplitSafe(idA, idB) {
  try {
    if (!canSplit()) return { ok: false, reason: 'unsupported' };
    let a = await chrome.tabs.get(idA);
    let b = await chrome.tabs.get(idB);
    if (a.windowId !== b.windowId) return { ok: false, reason: 'window' };
    if ((a.groupId == null ? -1 : a.groupId) !== (b.groupId == null ? -1 : b.groupId) || !!a.pinned !== !!b.pinned) return { ok: false, reason: 'group' };
    if (splitIdOf(a) >= 0 || splitIdOf(b) >= 0) return { ok: false, reason: 'already' };
    if (Math.abs(a.index - b.index) !== 1) {
      // a concurrent worker inserted a tab in between: bring the second pane next to the first
      const first = a.index < b.index ? a : b;
      const second = first === a ? b : a;
      try { await chrome.tabs.move(second.id, { index: first.index + 1 }); } catch { /* handled by the check below */ }
      a = await chrome.tabs.get(idA);
      b = await chrome.tabs.get(idB);
      if (Math.abs(a.index - b.index) !== 1) return { ok: false, reason: 'adjacent' };
    }
    const first = a.index < b.index ? a : b;
    const second = first === a ? b : a;
    const id = await chrome.tabs.createSplit([first.id, second.id]);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

/** True when a split partner of this tab is the active tab of its window or is playing sound (never discard this tab then). */
export async function partnerBusy(tab) {
  try {
    const sv = splitIdOf(tab);
    if (sv < 0) return false;
    const list = await chrome.tabs.query({ windowId: tab.windowId, splitViewId: sv });
    return list.some((m) => m.id !== tab.id && (m.active || m.audible));
  } catch {
    return false;
  }
}
