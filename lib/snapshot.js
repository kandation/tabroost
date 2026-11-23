// Crash-recovery snapshots ("จำแท็บที่เปิดอยู่ไว้กู้คืน").
//
// Cost model: NO tab event listeners. One chrome.alarms alarm (default every 3 min) runs ONE tabs.query({}) (+ tabGroups.query
// only when tab groups are kept), hashes the sorted (windowId, index, url) list (FNV-1a, <1 ms for 500 tabs) and writes ONLY when
// the hash changed: one gzip record per snapshot in IDB `snapshots` (titles <= 120 chars; internal / new-tab pages skipped).
// Tiered retention (snapfmt.planAutoTrim): newest 5 + fullest per hour (24 h) + fullest per day (7 d); a snapshot with far fewer tabs than
// the best recent one (right after a crash) is stored but flagged `degraded` and never evicts the fuller ones. + the last "pre-close" one (taken right before a stash starts) + manual ones are kept.
// After an unexpected close (browser/OS crash, killed process) the open tabs are compared with the newest snapshot; if many of its
// tabs are missing a dismissible banner offers to restore them through the same memory-aware, background restore scheduler.

import * as db from './db.js';
import * as lockrt from './lockrt.js';
import { classifyUrl } from './formats.js';
import { sessionsApi } from './perms.js';
import { getSettings } from './settings.js';
import { freeRatio } from './mem.js';
import { gzipJson, gunzipJson, diffTabs, isDegraded, bannerCandidates, DAY } from './snapfmt.js';
import * as firstseen from './firstseen.js';
import * as act from './activity.js';
export { diffTabs };
import { post } from './bus.js';
import { startRestore } from './restore.js';
import { runExclusive } from './queue.js';
import { splitIdOf, pairIndexes } from './splitview.js';

export const SNAP_KEEP_AUTO = 5;
export const SNAP_KEEP_MANUAL = 10;
export const BANNER_MAX_AGE = 7 * 86400000;
export const MISSING_MIN = 5; // "more than N tabs missing" (default 5) ...
export const MISSING_RATIO = 0.3; // ... or more than 30 % of the snapshot's tabs

const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Open tabs as snapshot rows (+ tab group defs). Sorted by (window, index). */
export async function collectTabs(keepTabGroups) {
  const tabs = await chrome.tabs.query({});
  const rows = [];
  const fsm = await firstseen.observe(tabs, Date.now(), db, gunzipJson).catch(() => null); // opened-at bookkeeping rides on this query (null when stats are off)
  for (const t of tabs) {
    if (t.incognito) continue;
    const u = t.pendingUrl || t.url || '';
    if (!u || classifyUrl(u) !== 'save') continue; // skips chrome://, new-tab pages, our own pages
    rows.push({ w: t.windowId, i: t.index, url: u, title: String(t.title || '').slice(0, 120), g: t.groupId >= 0 ? t.groupId : -1, p: t.pinned ? 1 : 0, f: fsm && fsm[t.id] ? fsm[t.id].f : 0, s: splitIdOf(t) });
  }
  rows.sort((a, b) => a.w - b.w || a.i - b.i);
  let hash = 2166136261;
  for (const r of rows) hash = (Math.imul(hash ^ fnv(r.w + '|' + r.i + '|' + r.url), 16777619)) >>> 0;
  let groups = [];
  if (keepTabGroups && chrome.tabGroups && rows.some((r) => r.g >= 0)) {
    try { groups = (await chrome.tabGroups.query({})).map((g) => ({ id: g.id, title: String(g.title || '').slice(0, 80), color: g.color, collapsed: !!g.collapsed })); } catch { groups = []; }
  }
  return { rows, hash, groups };
}

/** Rows -> compact record body: windows renumbered 1..n, tab-group ids -> local indexes. */
function pack(rows, groups) {
  const wmap = new Map();
  const gmap = new Map();
  const defs = [];
  // split view: `sv` = pair index (two neighbouring rows of one window that were the two panes of one split view); the raw id is never stored
  const pairs = rows.some((r) => r.s >= 0) ? pairIndexes(rows.map((r) => (r.s >= 0 ? r.w + ':' + r.s : null))) : null;
  const tabs = rows.map((r, ri) => {
    if (!wmap.has(r.w)) wmap.set(r.w, wmap.size + 1);
    const o = { w: wmap.get(r.w), i: r.i, url: r.url, title: r.title };
    if (r.p) o.pinned = 1;
    if (r.f) o.f = r.f; // first-seen minute (only present when stats are on)
    if (pairs && pairs[ri] >= 0) o.sv = pairs[ri];
    if (r.g >= 0) {
      if (!gmap.has(r.g)) { const d = groups.find((x) => x.id === r.g); gmap.set(r.g, defs.length); defs.push(d ? { title: d.title, color: d.color, collapsed: d.collapsed } : { title: '', color: 'grey', collapsed: false }); }
      o.tg = gmap.get(r.g);
    }
    return o;
  });
  return { v: 1, tabs, groups: defs, windows: wmap.size };
}

let lastHash = null; // in this worker's memory only (a worker restart simply writes one extra snapshot)

/** kind: 'auto' | 'pre-close' | 'manual'. Returns {saved:boolean, id?, tabs?}. */
export async function runSnapshot({ kind = 'auto', force = false, inQueue = false, ignoreBusy = false } = {}) {
  const settings = await getSettings();
  if (kind === 'auto' && !settings.autoSnapshot) return { saved: false, reason: 'off' };
  const meta = await db.getMeta();
  if (kind === 'auto' && !ignoreBusy && (meta.drain || meta.job || meta.refresh)) return { saved: false, reason: 'busy' }; // never while a drain / restore runs
  const ratio = await freeRatio();
  if (kind === 'auto' && ratio != null && ratio < 0.05) return { saved: false, reason: 'ram' };
  const t0 = Date.now();
  const p0 = performance.now();
  const { rows, hash, groups } = await collectTabs(settings.keepTabGroups !== false);
  const p1 = performance.now(); // tabs.query + normalise + hash
  if (!rows.length) return { saved: false, reason: 'empty' };
  if (kind === 'auto') act.tick(rows.length, null).catch(() => {});
  if (kind === 'auto' && !force && hash === lastHash) return { saved: false, reason: 'same', tabs: rows.length, ms: Date.now() - t0 };
  const body = pack(rows, groups);
  const p2 = performance.now();
  const gz = await gzipJson(body);
  const p3 = performance.now();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const q = inQueue ? (fn) => fn() : runExclusive; // a stash calls this from INSIDE the write queue (no nested wait)
  const now = Date.now();
  let degraded = false;
  if (kind === 'auto') {
    try { degraded = isDegraded(rows.length, (await db.snapList()).filter((s) => (s.kind || 'auto') === 'auto' && now - s.ts <= DAY)); } catch { degraded = false; }
  }
  await q(() => db.snapPut({ id, ts: now, kind, tabCount: rows.length, windowCount: body.windows, hash, gz, ...(degraded ? { degraded: true } : {}) }));
  if (kind === 'auto') lastHash = hash;
  await q(() => db.snapTrim(SNAP_KEEP_AUTO, SNAP_KEEP_MANUAL));
  post({ type: 'snapshots' });
  const p4 = performance.now();
  return { saved: true, id, degraded, tabs: rows.length, bytes: gz.byteLength, ms: Date.now() - t0, stages: { collect: Math.round((p1 - p0) * 10) / 10, pack: Math.round((p2 - p1) * 10) / 10, gzip: Math.round((p3 - p2) * 10) / 10, db: Math.round((p4 - p3) * 10) / 10 } };
}

/**
 * Chrome's own "recently closed" list (chrome.sessions) as an EXTRA source next to our snapshots: a flat list of closed tabs
 * (tabs of closed windows are included) that are not open now. [{sid, title, url, ts, win}], newest first. Never throws.
 */
export async function recentlyClosed(max = 25) {
  try {
    if (!sessionsApi()) return []; // optional permission not granted
    const open = new Set((await chrome.tabs.query({})).map((t) => t.pendingUrl || t.url || ''));
    const out = [];
    for (const s of await chrome.sessions.getRecentlyClosed({ maxResults: max })) {
      if (s.tab) { if (s.tab.url && !open.has(s.tab.url)) out.push({ sid: s.tab.sessionId, title: s.tab.title || s.tab.url, url: s.tab.url, ts: (s.lastModified || 0) * 1000, win: false }); }
      else if (s.window) {
        const tabs = (s.window.tabs || []).filter((t) => t.url && !open.has(t.url));
        if (tabs.length) out.push({ sid: s.window.sessionId, title: tabs[0].title || tabs[0].url, url: tabs[0].url, ts: (s.lastModified || 0) * 1000, win: true, n: tabs.length });
      }
    }
    return out;
  } catch { return []; }
}

/** Locked: the tab lists are encrypted, so only the plain header counts are compared (snapshot tabs vs. tabs open now). */
async function checkMissingLocked() {
  const meta = await db.getMeta();
  const list = await db.snapList();
  const cands = bannerCandidates(list, { now: Date.now(), lastStashAt: meta.lastStash ? meta.lastStash.at : 0, lastCleanClose: meta.lastCleanClose || 0, snapAck: meta.snapAck || '' });
  if (!cands.length) return null;
  const mine = chrome.runtime.getURL('');
  const open = (await chrome.tabs.query({})).filter((t) => !t.incognito && !(t.pendingUrl || t.url || '').startsWith(mine)).length;
  let best = null;
  for (const c of cands) {
    const total = c.tabCount || c.nTabs || 0;
    const missing = Math.max(0, total - open);
    if (!best || missing > best.missing) best = { id: c.id, ts: c.ts, missing, total, locked: true };
  }
  if (!best) return null;
  const { missing, total } = best;
  if (!(missing > MISSING_MIN || (missing >= 3 && total && missing / total > MISSING_RATIO))) return null;
  return { ...best, recent: 0 };
}

/**
 * Banner decision. Compares the open tabs with the newest AND the fullest snapshot of the last 24 h (taken after the last deliberate
 * close) and uses the one with more missing tabs, so a crash followed by a partial session restore still offers the missing tabs.
 * Returns {id, ts, missing, total, recent} or null.
 */
export async function checkMissing() {
  if (lockrt.isLocked()) return checkMissingLocked();
  const meta = await db.getMeta();
  const list = await db.snapList();
  const cands = bannerCandidates(list, { now: Date.now(), lastStashAt: meta.lastStash ? meta.lastStash.at : 0, lastCleanClose: meta.lastCleanClose || 0, snapAck: meta.snapAck || '' });
  if (!cands.length) return null;
  const open = (await chrome.tabs.query({})).filter((t) => !t.incognito).map((t) => t.pendingUrl || t.url || '');
  let best = null;
  for (const c of cands) {
    const rec = await db.snapGet(c.id);
    if (!rec) continue;
    const body = await gunzipJson(rec.gz);
    const missing = diffTabs(body.tabs, open).length;
    if (!best || missing > best.missing) best = { id: c.id, ts: c.ts, missing, total: body.tabs.length };
  }
  if (!best) return null;
  const { missing, total } = best;
  if (!(missing > MISSING_MIN || (missing >= 3 && missing / total > MISSING_RATIO))) return null;
  return { ...best, recent: (await recentlyClosed(25)).filter((r) => r.ts >= best.ts).length };
}

/** Selected missing tabs -> a temporary stash group -> the normal memory-aware background restore (windows + tab groups). */
export async function restoreItems(items, groups, windowCount, { title = '' } = {}) {
  const clean = (items || []).filter((t) => t && classifyUrl(t.url) === 'save').slice(0, 20000);
  if (!clean.length) return { restored: 0 };
  const tgList = [];
  const gmap = new Map();
  const wlast = new Map();
  // a pair is kept only when both panes are among the tabs to open (neighbours, same window)
  const svPairs = pairIndexes(clean.map((t) => (Number.isInteger(t.sv) && t.sv >= 0 ? (t.w || 1) + ':' + t.sv : null)));
  const itemsOut = clean.map((t, ci) => {
    const it = { url: t.url, title: t.title || t.url, w: t.w || 1 };
    if (svPairs[ci] >= 0) it.sv = svPairs[ci];
    if (!wlast.has(it.w)) { it.ws = true; wlast.set(it.w, 1); }
    if (t.tg != null && groups && groups[t.tg]) {
      if (!gmap.has(t.tg)) { gmap.set(t.tg, tgList.length); tgList.push({ i: tgList.length, ...groups[t.tg], windowIdx: it.w }); }
      it.tg = gmap.get(t.tg);
    }
    return it;
  });
  const gid = await runExclusive(async () => {
    const g = await db.createGroup({ source: 'snapshot', title, windowCount: Math.max(1, windowCount || 1), tabGroups: tgList });
    for (let i = 0; i < itemsOut.length; i += 1000) await db.appendItems(g.id, itemsOut.slice(i, i + 1000));
    await db.setPhase(g.id, 'committed');
    return g.id;
  });
  return startRestore({ gids: [gid], forceRemove: true, perWindow: windowCount > 1 });
}
