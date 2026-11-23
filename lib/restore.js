// Chunked, memory-aware restore. A restore is a job persisted in meta.job:
//   {gids:[...], gi, nextSeq, total, done, remove, windowId, newWindow, auto, interrupted, paused}
// Opening tabs runs outside the queue; removing restored items runs inside it (only after the tab was created).

import { RESTORE_DISCARD_TIMEOUT_MS } from './constants.js';
import { isRestorableUrl, tgOf } from './formats.js';
import * as db from './db.js';
import { runExclusive } from './queue.js';
import { getSettings } from './settings.js';
import { post } from './bus.js';
import { freeRatio, levelIndexFor } from './mem.js';
import { scheduleBadge } from './suspend.js';
import * as act from './activity.js';
import { runPool, waitFor, settle } from './opener.js';
import { svIndex, isPair, pairUnits, createSplitSafe } from './splitview.js';

let autoRunning = false;
let stopFlag = false;

async function resolveWindow(windowId) {
  if (windowId != null) {
    try {
      const w = await chrome.windows.get(windowId);
      if (w.type === 'normal' && !w.incognito) return w.id;
    } catch { /* gone */ }
  }
  try {
    const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const w = ws.find((x) => x.focused && !x.incognito) || ws.find((x) => !x.incognito);
    return w ? w.id : null;
  } catch {
    return null;
  }
}

const isLoaded = (tab) => tab.status === 'complete' && !tab.pendingUrl && !!tab.url && tab.url !== 'about:blank';

/** Freezes a tab (url + title survive) once its navigation committed. Never touches an active tab. */
async function freeze(tab, timeoutMs = RESTORE_DISCARD_TIMEOUT_MS * 2) {
  const r = await waitFor(tab, { until: 'commit', timeoutMs });
  if (r === 'gone') return 'gone';
  if (r === 'timeout') {
    // still no commit: leave it alone (a pending navigation would be lost by a discard)
    try { const t = await chrome.tabs.get(tab.id); if (!t.url || t.pendingUrl) return 'slow'; } catch { return 'gone'; }
  }
  await settle(tab, 500); // let the real title / favicon arrive (otherwise the frozen tab shows the bare url)
  try {
    const t = await chrome.tabs.get(tab.id);
    if (t.active || t.audible || t.pendingUrl || !t.url) return 'kept'; // never freeze a tab that is playing sound
    await chrome.tabs.discard(tab.id);
    return 'discarded';
  } catch { return 'kept'; }
}

// ---------- Chrome tab groups ----------
// grp = {state: Map(key -> {groupId, tail, def, touched, collapsedDone}), keyOf(item) -> key|null, defOf(item) -> def}
// key = "<stash group id>:<tg index>" (one Chrome tab group per key per restore job; persisted in job.tgMap between steps).
// Tabs are grouped RIGHT AFTER creation (before any discard) and strictly in item order (tickets), so the tab order
// inside a group is kept and a group split across chunks / pool workers still ends up as ONE Chrome tab group.
// Grouping failures are swallowed: they never fail the restore.
function tgReserve(state, key, def) {
  let s = state.get(key);
  if (!s) { s = { groupId: null, tail: Promise.resolve(), def, touched: false, collapsedDone: false }; state.set(key, s); }
  if (!s.def) s.def = def;
  let release;
  const mine = new Promise((r) => { release = r; });
  const prev = s.tail;
  s.tail = mine;
  return { s, prev, release };
}

async function tgJoin(tk, tabId, windowId) {
  try {
    await tk.prev;
    if (tabId == null || !chrome.tabs.group || !chrome.tabGroups) return;
    const s = tk.s;
    if (s.groupId != null) {
      try {
        await chrome.tabs.group({ groupId: s.groupId, tabIds: [tabId] });
        s.touched = true;
        return;
      } catch { s.groupId = null; /* the Chrome group is gone: start a new one */ }
    }
    const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    s.groupId = gid;
    s.touched = true;
    s.collapsedDone = false;
    try { await chrome.tabGroups.update(gid, { title: s.def.title || '', color: s.def.color || 'grey' }); } catch { /* cosmetic */ }
  } catch { /* tab closed / API error: the tab simply stays ungrouped */ } finally {
    tk.release();
  }
}

/** Collapses the groups that were stashed collapsed. Done after the tabs exist (a collapsed group may not hold the active tab). */
async function tgFinish(state) {
  for (const s of state.values()) {
    if (!s.touched || s.groupId == null || s.collapsedDone || !s.def || !s.def.collapsed) continue;
    try { await chrome.tabGroups.update(s.groupId, { collapsed: true }); s.collapsedDone = true; } catch { /* ignore */ }
  }
}

const tgStateFrom = (o) => {
  const m = new Map();
  for (const [k, v] of Object.entries(o || {})) m.set(k, { groupId: v.g, tail: Promise.resolve(), def: null, touched: false, collapsedDone: !!v.c });
  return m;
};
const tgStateTo = (m) => {
  const o = {};
  for (const [k, s] of m) if (s.groupId != null) o[k] = { g: s.groupId, c: s.collapsedDone ? 1 : 0 };
  return o;
};

/** Grouping adapter for items of stash groups: `infoOf(gid)` returns the (cached) group record. */
function makeGrp(state, infoOf) {
  const defCache = new Map();
  const defOf = (it) => {
    if (tgOf(it) < 0) return null;
    const k = it.g + ':' + it.tg;
    if (!defCache.has(k)) {
      const g = infoOf(it.g);
      defCache.set(k, ((g && g.tabGroups) || []).find((x) => x.i === it.tg) || null);
    }
    return defCache.get(k);
  };
  return { state, keyOf: (it) => (defOf(it) ? it.g + ':' + it.tg : null), defOf };
}

/**
 * Opens `items` ([{url, seq...}]) into a window. Returns {created:[indexes], failed, windowId}.
 * opts: {windowId, newWindow, pool, keepFirstLoaded, activateFirst, grp}
 */
async function openItems(items, opts) {
  const grp = opts.grp || null;
  const tickets = items.map((it) => {
    const k = grp ? grp.keyOf(it) : null;
    return k ? tgReserve(grp.state, k, grp.defOf(it)) : null;
  });
  try {
    return await openItemsInner(items, opts, tickets);
  } finally {
    for (const tk of tickets) if (tk) tk.release();
  }
}

async function openItemsInner(items, opts, tickets) {
  let windowId = opts.newWindow ? null : await resolveWindow(opts.windowId);
  const created = [];
  const createdTabs = []; // tab ids (for "refresh all")
  let failed = 0;
  let splits = 0; // split views recreated
  let splitFailed = 0; // pairs that stay two plain tabs (Chrome without createSplit, or Chrome refused): never an error for the restore
  let startIdx = 0;
  let existing = 0;
  const pre = new Set(); // item indexes whose tab already exists (the first tab of a freshly created window)
  const preTab = new Map();
  if (windowId == null) {
    try {
      // never steal focus: the new window is created unfocused (the user keeps typing where they were)
      const w = await chrome.windows.create({ url: items[0].url, focused: false, incognito: !!opts.incognito });
      windowId = w.id;
      if (opts.onWindow) { try { await opts.onWindow(windowId); } catch { /* bookkeeping only */ } } // persisted at once: a restart must find this window
      startIdx = 1;
      existing = 1;
      created.push(0);
      let tid = w.tabs && w.tabs[0] && w.tabs[0].id;
      if (tid == null) { try { tid = (await chrome.tabs.query({ windowId }))[0].id; } catch { tid = null; } }
      if (tid != null) { createdTabs.push(tid); pre.add(0); preTab.set(0, { id: tid }); }
      if (tickets[0]) await tgJoin(tickets[0], tid, windowId);
    } catch {
      return { created, failed: items.length, windowId: null, tabIds: [] };
    }
  } else {
    try { existing = (await chrome.tabs.query({ windowId })).length; } catch { existing = 0; }
  }
  const off = existing - startIdx;
  const mode = opts.mode || 'auto';
  const discard = opts.discard !== false && mode !== 'loadAll' && items.length > 1;
  // A unit is one tab, or the two panes of a split view (opts.split): both tabs are created back to back by the same worker,
  // grouped (same Chrome tab group), split, and only then frozen, so the pair is never cut by the pool / a chunk boundary.
  const splitOn = !!opts.split && items.length > 1;
  const units = pairUnits(items, splitOn);
  const startUnit = startIdx === 1 && units[0].length === 1 ? 1 : 0;
  const run = async (u) => {
    const made = []; // [{i, tab, grouping}]
    for (const i of units[u]) {
      if (pre.has(i)) { made.push({ i, tab: preTab.get(i), grouping: null }); continue; }
      let tab;
      try {
        // active:false ALWAYS (except the single tab the user explicitly clicked): no tab switching, no focus changes
        tab = await chrome.tabs.create({ windowId, url: items[i].url, active: !!opts.activateFirst && i === 0, index: off + i });
      } catch {
        failed++;
        if (tickets[i]) tickets[i].release();
        continue;
      }
      created.push(i);
      createdTabs.push(tab.id);
      made.push({ i, tab, grouping: tickets[i] ? tgJoin(tickets[i], tab.id, windowId) : null }); // runs while the navigation commits
    }
    const stayLoaded = made.some((m) => pre.has(m.i) || (m.i === 0 && (opts.keepFirstLoaded || opts.activateFirst))); // a pair stays loaded as a whole
    if (made.length === 2 && splitOn) {
      for (const m of made) if (m.grouping) { await m.grouping; m.grouping = null; } // same groupId first (createSplit needs it)
      const r = await createSplitSafe(made[0].tab.id, made[1].tab.id);
      if (r.ok) splits++; else splitFailed++;
    }
    await Promise.all(made.map(async (m) => {
      if (discard && !stayLoaded) await freeze(m.tab);
      else if (!stayLoaded && mode === 'loadAll') await waitFor(m.tab, { until: 'complete', timeoutMs: 20000 });
      if (m.grouping) await m.grouping;
    }));
  };
  await runPool({
    count: units.length, startIdx: startUnit, mode, run,
    stop: () => !!(opts.stop && opts.stop()),
    onPause: opts.onPause, onTier: opts.onTier,
  });
  return { created, failed, windowId, tabIds: createdTabs, splits, splitFailed };
}

// ---------- single / few items (search results, group rows) ----------
/** keys: ["gid:seq", ...]. Opens them (no job), removes them from their groups afterwards. */
let restoring = 0;
/** True while a restore is opening tabs (the sync engine does not apply remote changes meanwhile). */
export const isRestoring = () => restoring > 0;
async function busy(fn) { restoring++; try { return await fn(); } finally { restoring--; } }
export const restoreItemKeys = (keys, opts = {}) => busy(() => restoreItemKeysInner(keys, opts));
async function restoreItemKeysInner(keys, opts = {}) {
  const settings = await getSettings();
  const recs = [];
  for (const k of keys) {
    const i = k.lastIndexOf(':');
    const rec = await db.getItem(k.slice(0, i), Number(k.slice(i + 1)));
    if (rec && isRestorableUrl(rec.url)) recs.push(rec);
  }
  if (!recs.length) return { restored: 0, failed: 0 };
  const r = await openItems(recs, {
    windowId: opts.windowId, newWindow: !!opts.newWindow, mode: settings.restoreMode, discard: settings.discardOnRestore !== false,
    keepFirstLoaded: true, activateFirst: recs.length === 1 && !opts.newWindow && settings.singleRestore !== 'stay', // (only a single explicit click may activate)
  });
  await rememberRestore([...new Set(recs.map((x) => x.g))], r.tabIds);
  const remove = typeof opts.remove === 'boolean' ? opts.remove : settings.restoreRemovesItem !== false; // per-action choice wins over the setting
  if (remove) {
    const byG = new Map();
    for (const idx of r.created) {
      const rec = recs[idx];
      if (!byG.has(rec.g)) byG.set(rec.g, []);
      byG.get(rec.g).push(rec.seq);
    }
    for (const [g, seqs] of byG) await runExclusive(() => db.removeOpened(g, seqs)); // soft delete: type 'opened' (recoverable in the trash)
  }
  scheduleBadge();
  if (r.created.length) act.bump('restore', { n: r.created.length }).catch(() => {});
  return { restored: r.created.length, failed: r.failed };
}

/**
 * The split-view icon of a row: opens that saved tab TOGETHER with its partner pane as a split view (key = "gid:seq" of either pane).
 * Without a valid partner (or a Chrome without createSplit) it just opens the clicked tab (and the partner as a plain tab when it exists).
 */
export const restoreSplitPair = (key, opts = {}) => busy(() => restoreSplitPairInner(key, opts));
async function restoreSplitPairInner(key, opts = {}) {
  const settings = await getSettings();
  const i = String(key).lastIndexOf(':');
  const gid = String(key).slice(0, i);
  const seq = Number(String(key).slice(i + 1));
  const rec = await db.getItem(gid, seq);
  if (!rec || !isRestorableUrl(rec.url)) return { restored: 0, failed: 0 };
  let recs = [rec];
  if (svIndex(rec) >= 0) {
    const next = (await db.getItemsPage(gid, seq, 1))[0];
    if (next && isPair(rec, next) && isRestorableUrl(next.url)) recs = [rec, next];
    else {
      const prev = (await db.getItemsPage(gid, Math.max(0, seq - 8), 8)).filter((x) => x.seq < seq).pop();
      if (prev && isPair(prev, rec) && isRestorableUrl(prev.url)) recs = [prev, rec];
    }
  }
  const r = await openItems(recs, {
    windowId: opts.windowId, newWindow: !!opts.newWindow, mode: settings.restoreMode, discard: false,
    keepFirstLoaded: true, activateFirst: !opts.newWindow && settings.singleRestore !== 'stay', split: recs.length === 2, // (an explicit click may activate, like a single tab)
  });
  await rememberRestore([gid], r.tabIds);
  const remove = typeof opts.remove === 'boolean' ? opts.remove : settings.restoreRemovesItem !== false;
  if (remove && r.created.length) await runExclusive(() => db.removeOpened(gid, r.created.map((x) => recs[x].seq)));
  scheduleBadge();
  if (r.created.length) act.bump('restore', { n: r.created.length }).catch(() => {});
  return { restored: r.created.length, failed: r.failed, splits: r.splits || 0 };
}

/**
 * The "open as tab group" button of one tab-group sub-header: opens every item of group `gid` whose tg === `tg`
 * (in seq order) and recreates the Chrome tab group. Same removal rule as single items. No job (tab groups are small).
 */
export const restoreTabGroup = (gid, tg, opts = {}) => busy(() => restoreTabGroupInner(gid, tg, opts));
async function restoreTabGroupInner(gid, tg, opts = {}) {
  const settings = await getSettings();
  const g = await db.getGroup(gid);
  if (!g || g.deletedAt != null || g.phase === 'writing' || !Number.isInteger(tg)) return { restored: 0, failed: 0 };
  const recs = [];
  let after = 0;
  for (;;) {
    const page = await db.getItemsPage(gid, after, 1000);
    if (!page.length) break;
    for (const it of page) if (it.tg === tg && isRestorableUrl(it.url)) recs.push(it);
    after = page[page.length - 1].seq;
    if (page.length < 1000) break;
  }
  if (!recs.length) return { restored: 0, failed: 0 };
  const state = new Map();
  const r = await openItems(recs, {
    windowId: opts.windowId, newWindow: !!opts.newWindow, mode: settings.restoreMode, discard: settings.discardOnRestore !== false,
    keepFirstLoaded: true, activateFirst: false, grp: makeGrp(state, () => g), split: true,
  });
  await rememberRestore([gid], r.tabIds);
  await tgFinish(state);
  const removeTg = typeof opts.remove === 'boolean' ? opts.remove : settings.restoreRemovesGroup !== false;
  if (removeTg && !g.locked && r.created.length) {
    await runExclusive(() => db.removeOpened(gid, r.created.map((i) => recs[i].seq)));
  }
  scheduleBadge();
  return { restored: r.created.length, failed: r.failed };
}

// ---------- chunked jobs ----------
/** Remembers which tabs a restore opened (last 3 restores, 5000 ids each) so "refresh all" can target a session. */
async function rememberRestore(gids, tabIds) {
  if (!tabIds || !tabIds.length) return;
  try {
    await db.metaQuiet((m) => {
      const list = (m.restored || []).filter((r) => !gids.some((g) => (r.gids || []).includes(g)));
      list.unshift({ gids, at: Date.now(), tabIds: tabIds.slice(-5000) });
      m.restored = list.slice(0, 3);
    });
  } catch { /* cosmetic */ }
}

const jobView = (j) => (j ? { total: j.total, done: j.done, auto: !!j.auto, interrupted: !!j.interrupted, paused: j.paused || null } : null);

async function emit(job, extra = {}) {
  post({ type: 'progress', op: 'restore', job: jobView(job), ...extra });
}

/** Creates the job (one at a time) and runs the first step. */
export async function startRestore({ gids, newWindow, windowId, forceRemove, remove, perWindow, here, incognito, asTabGroup }) {
  const meta = await db.getMeta();
  if (meta.job) return { error: 'busy' };
  const settings = await getSettings();
  let total = 0;
  const live = [];
  for (const gid of gids) {
    const g = await db.getGroup(gid);
    if (!g || g.deletedAt != null || g.phase === 'writing') continue;
    live.push(gid);
    total += g.count;
  }
  if (!live.length || !total) return { restored: 0, failed: 0 };
  const chunk = settings.restoreChunk || 100;
  // where the tabs go: "here" = the caller's window, otherwise the groupRestore setting decides (auto = new window for big sessions)
  let nw = !!newWindow;
  if (!nw && !here) nw = settings.groupRestore === 'new' ? true : settings.groupRestore === 'current' ? false : total > chunk;
  if (incognito) nw = true;
  const job = {
    gids: live, gi: 0, nextSeq: 0, total, done: 0, remove: !!forceRemove || (typeof remove === 'boolean' ? remove : settings.restoreRemovesGroup !== false), // persisted per job: survives SW restarts
    windowId: nw || windowId == null ? null : windowId, newWindow: nw, incognito: !!incognito, asTabGroup: !!asTabGroup,
    perWindow: !!perWindow, winMap: {}, keepTg: settings.keepTabGroups !== false, tgMap: {},
    auto: false, interrupted: false, paused: null, failed: 0,
  };
  await db.metaQuiet((m) => { m.job = job; });
  return restoreStep();
}

/** One chunk of the active job. Returns {restored, failed, remaining, done, paused?}. */
export async function restoreStep() {
  const meta = await db.getMeta();
  const job = meta.job;
  if (!job) return { done: true, restored: 0, failed: 0, remaining: 0 };
  const settings = await getSettings();
  const ratio = await freeRatio();
  const li = levelIndexFor(ratio);
  const drainLevel = meta.drain && meta.drain.level;
  if (li >= 3) {
    await db.metaQuiet((m) => { if (m.job) m.job.paused = 'memory'; });
    const j = { ...job, paused: 'memory' };
    await emit(j);
    return { paused: 'memory', remaining: job.total - job.done };
  }
  if (meta.drain && drainLevel && drainLevel !== 'healthy') {
    await db.metaQuiet((m) => { if (m.job) m.job.paused = 'drain'; });
    await emit({ ...job, paused: 'drain' });
    return { paused: 'drain', remaining: job.total - job.done };
  }
  let chunk = settings.restoreChunk || 100;
  if (li === 2) chunk = Math.min(20, chunk);
  const popts = {
    mode: settings.restoreMode, discard: settings.discardOnRestore !== false,
    stop: () => stopFlag, incognito: !!job.incognito, split: !job.asTabGroup, // (a job that opens everything as ONE tab group has no split views)
    onPause: (p) => { emit({ ...job, paused: p ? 'memory' : null }); },
  };
  let tabIds = [];
  const reconcile = !!job.reconcile; // first step after an interruption: skip items whose tab already exists (no duplicates)
  let openCounts = null;
  if (reconcile) {
    openCounts = new Map();
    const wins = [job.windowId, ...Object.values(job.winMap || {})].filter((x) => x != null);
    for (const wid of new Set(wins)) {
      let tabs = [];
      try { tabs = await chrome.tabs.query({ windowId: wid }); } catch { /* window gone */ }
      for (const t of tabs) {
        const u = t.url || t.pendingUrl;
        if (!u) continue;
        if (!openCounts.has(u)) openCounts.set(u, []);
        openCounts.get(u).push(t);
      }
    }
  }

  // fill the chunk across groups (many small groups must not need one "continue" click each)
  const groupInfo = new Map();
  const getG = async (gid) => {
    if (!groupInfo.has(gid)) groupInfo.set(gid, (await db.getGroup(gid)) || null);
    return groupInfo.get(gid);
  };
  const batch = []; // [{it, gid}]
  let gi = job.gi;
  let nextSeq = job.nextSeq;
  while (batch.length < chunk && gi < job.gids.length) {
    const gid = job.gids[gi];
    const g = await getG(gid);
    if (!g || g.deletedAt != null) { gi++; nextSeq = 0; continue; }
    const want = chunk - batch.length;
    const page = await db.getItemsPage(gid, nextSeq, want);
    for (const it of page) batch.push({ it, gid });
    if (page.length) nextSeq = page[page.length - 1].seq;
    if (page.length < want) { gi++; nextSeq = 0; }
  }
  // a split pair is never cut by a chunk boundary: when the chunk ends on the first pane, its partner comes along (chunk + 1)
  if (batch.length && gi < job.gids.length) {
    const last = batch[batch.length - 1];
    if (svIndex(last.it) >= 0 && job.gids[gi] === last.gid) {
      const nx = (await db.getItemsPage(last.gid, nextSeq, 1))[0];
      if (nx && isPair(last.it, nx)) { batch.push({ it: nx, gid: last.gid }); nextSeq = nx.seq; }
    }
  }
  // skip over groups that are already fully consumed so a finished job really ends
  while (gi < job.gids.length) {
    const gid = job.gids[gi];
    const g = await getG(gid);
    if (!g || g.deletedAt != null || (await db.getItemsPage(gid, nextSeq, 1)).length === 0) { gi++; nextSeq = 0; } else break;
  }

  let created = []; // [{it, gid}]
  let failed = 0;
  let splits = 0;
  let splitFailed = 0;
  let windowId = job.windowId;
  const tgState = tgStateFrom(job.tgMap);
  const grp = job.asTabGroup
    ? { state: tgState, keyOf: () => 'all', defOf: () => ({ title: ((groupInfo.get(job.gids[0]) || {}).title || '').slice(0, 80), color: 'blue', collapsed: false }) }
    : (job.keepTg ? makeGrp(tgState, (gid) => groupInfo.get(gid)) : null);
  let saveable = batch.filter((b) => isRestorableUrl(b.it.url));
  const already = [];
  if (openCounts) {
    const thaw = []; // tabs that were opened before the interruption but never frozen
    saveable = saveable.filter((b) => {
      const list = openCounts.get(b.it.url);
      if (list && list.length) { const t = list.shift(); already.push(b); if (!t.discarded && !t.active && popts.discard) thaw.push(t.id); return false; }
      return true;
    });
    for (const id of thaw) { try { await chrome.tabs.discard(id); } catch { /* active / gone */ } }
  }
  const winMap = { ...(job.winMap || {}) };
  if (saveable.length && job.perWindow) {
    // recreate the original windows: one new window per (group, window number); chunks are in seq order
    const parts = new Map();
    for (const b of saveable) {
      const k = `${b.gid}:${b.it.w || 1}`;
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(b);
    }
    for (const [k, list] of parts) {
      let wid = winMap[k];
      if (wid != null) { try { await chrome.windows.get(wid); } catch { wid = null; } }
      const r = await openItems(list.map((b) => b.it), {
        ...popts, windowId: wid, newWindow: wid == null, keepFirstLoaded: !wid, activateFirst: false, grp,
        onWindow: (nw) => db.metaQuiet((m) => { if (m.job) { m.job.winMap = { ...(m.job.winMap || {}), [k]: nw }; } }),
      });
      tabIds = tabIds.concat(r.tabIds || []);
      splits += r.splits || 0; splitFailed += r.splitFailed || 0;
      if (r.windowId != null) winMap[k] = r.windowId;
      created = created.concat(r.created.map((i) => list[i]));
      failed += r.failed;
    }
  } else if (saveable.length) {
    const r = await openItems(saveable.map((b) => b.it), {
      ...popts, windowId: job.windowId, newWindow: job.newWindow && job.done === 0 && job.windowId == null,
      keepFirstLoaded: job.done === 0, activateFirst: false, grp,
      onWindow: (wid) => db.metaQuiet((m) => { if (m.job) m.job.windowId = wid; }),
    });
    tabIds = tabIds.concat(r.tabIds || []);
    splits += r.splits || 0; splitFailed += r.splitFailed || 0;
    created = r.created.map((i) => saveable[i]);
    failed = r.failed;
    if (r.windowId != null) windowId = r.windowId;
  }
  created = created.concat(already);
  if (grp) await tgFinish(tgState);
  if (job.remove && created.length) {
    const byG = new Map();
    for (const c of created) {
      const g = groupInfo.get(c.gid);
      if (!g || g.locked) continue;
      if (!byG.has(c.gid)) byG.set(c.gid, []);
      byG.get(c.gid).push(c.it.seq);
    }
    for (const [gid, seqs] of byG) await runExclusive(() => db.removeOpened(gid, seqs));
  }
  // advance
  const allTabIds = (job.tabIds || []).concat(tabIds).slice(-5000);
  const upd = { ...job, reconcile: false, tabIds: allTabIds, windowId, winMap, tgMap: grp ? tgStateTo(tgState) : (job.tgMap || {}), done: job.done + created.length + failed, failed: (job.failed || 0) + failed, splits: (job.splits || 0) + splits, splitFailed: (job.splitFailed || 0) + splitFailed, paused: null, gi, nextSeq };
  if (stopFlag) { stopFlag = false; await db.metaQuiet((m) => { m.job = null; }); await emit(null, { finished: true }); return { restored: created.length, failed, done: true, remaining: 0 }; }
  const finished = gi >= job.gids.length;
  await db.metaQuiet((m) => { m.job = finished ? null : upd; });
  scheduleBadge();
  if (finished) {
    const trackOn = await act.ensure();
    for (const gid of job.gids) { try { await runExclusive(() => db.updateGroup(gid, trackOn ? { lastRestoredAt: Date.now(), rcInc: true } : { lastRestoredAt: Date.now() })); } catch { /* group gone */ } }
    if (trackOn) act.bump('restore', { n: upd.done - (upd.failed || 0), opened: job.gids.length, gid: job.gids[0] }).catch(() => {});
    await rememberRestore(job.gids, allTabIds);
    await emit(null, { finished: true, restored: upd.done - (upd.failed || 0), failed: upd.failed || 0 });
  }
  else await emit(upd);
  return { restored: created.length, failed, done: finished, remaining: Math.max(0, job.total - upd.done), splits, splitFailed };
}

/** Runs steps until the job ends, is stopped, or memory pauses it. Not awaited by callers. */
export const runAuto = () => busy(() => runAutoInner());
async function runAutoInner() {
  if (autoRunning) return;
  autoRunning = true;
  try {
    await db.metaQuiet((m) => { if (m.job) { m.job.auto = true; m.job.interrupted = false; m.job.paused = null; } });
    for (;;) {
      const m = await db.getMeta();
      if (!m.job || !m.job.auto) break;
      const r = await restoreStep();
      if (r.done || r.paused || r.error) break;
      await new Promise((res) => setTimeout(res, 300));
    }
  } finally {
    autoRunning = false;
  }
}

export async function stopRestore() {
  stopFlag = false;
  const meta = await db.getMeta();
  await db.metaQuiet((m) => { if (m.job) { m.job.auto = false; } });
  if (!autoRunning) { await db.metaQuiet((m) => { m.job = null; }); await emit(null, { finished: true }); } else stopFlag = true;
  return {};
}

export async function continueRestore() {
  await db.metaQuiet((m) => { if (m.job) { m.job.interrupted = false; m.job.paused = null; } });
  return restoreStep();
}

/** SW start: a job left in meta cannot be running -> mark it interrupted so the page offers Resume / Discard. */
export async function markInterrupted() {
  const m = await db.getMeta();
  if (m.job && !autoRunning) {
    await db.metaQuiet((mm) => { if (mm.job) { mm.job.interrupted = true; mm.job.auto = false; mm.job.reconcile = true; } });
    await emit({ ...m.job, interrupted: true });
  }
}

export async function undoLastStash(senderWindowId) {
  const meta = await db.getMeta();
  const ls = meta.lastStash;
  if (!ls) return { error: 'nothing' };
  const g = await db.getGroup(ls.groupId);
  const stillDraining = ((ls.groupIds || []).length ? await Promise.all(ls.groupIds.map((x) => db.getGroup(x))) : [g]).some((x) => x && x.phase === 'draining');
  if (stillDraining) return { error: 'draining' };
  if (!g || g.deletedAt != null) {
    await db.metaQuiet((m) => { if (m.lastStash && m.lastStash.groupId === ls.groupId) m.lastStash = null; });
    return { error: 'gone' };
  }
  if (g.phase === 'draining') return { error: 'draining' };
  let windowId = senderWindowId;
  try {
    const w = await chrome.windows.get(ls.windowId);
    if (w.type === 'normal' && !w.incognito) windowId = ls.windowId;
  } catch { /* use sender's window */ }
  const gids = (ls.groupIds && ls.groupIds.length ? ls.groupIds : [ls.groupId]);
  const r = await startRestore({ gids, windowId, forceRemove: true, perWindow: gids.length > 1 || g.windowCount > 1 });
  if (!r.error) await db.metaQuiet((m) => { if (m.lastStash && m.lastStash.groupId === ls.groupId) m.lastStash = null; });
  return r;
}

/** Re-opens trash records (no job, nothing is removed or recovered). recs = [{url, ...}] */
export const openTrashRecords = (recs, opts = {}) => busy(async () => {
  const settings = await getSettings();
  const list = (recs || []).filter((r) => r && isRestorableUrl(r.url));
  if (!list.length) return { restored: 0, failed: 0 };
  const r = await openItems(list, {
    windowId: opts.windowId, newWindow: list.length > 1 || !!opts.newWindow, mode: settings.restoreMode, discard: settings.discardOnRestore !== false,
    keepFirstLoaded: true, activateFirst: false,
  });
  scheduleBadge();
  return { restored: r.created.length, failed: r.failed };
});
