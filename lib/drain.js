// Memory-aware, resumable drain: after a stash is saved + verified, the saved tabs are frozen (discard) and
// closed in small adaptive chunks. A tab is only ever touched if it has a drain record (= its URL was saved).

import {
  DRAIN_LEVELS, DRAIN_CALL_TIMEOUT_MS, DRAIN_BACKOFF_MS, DRAIN_STALL_AFTER, RECONCILE_EVERY, KEYS, ALARMS,
} from './constants.js';
import * as db from './db.js';
import { dk } from './drainkey.js';
import { post } from './bus.js';
import { freeRatio, levelIndexFor } from './mem.js';
import { setDrainBadge, clearDrainBadge, scheduleBadge } from './suspend.js';
import { runSnapshot } from './snapshot.js';
import { swStr } from './swstr.js';

let running = false;
let latAdj = 0; // 0 or 1: extra slowdown beyond what free RAM asks for
let fastStreak = 0;
let timeoutStreak = 0;
let tick = 0;
let removalsSince = 0;
const replaced = new Map(); // old tabId -> new tabId (tabs.onReplaced)

// test hooks (dev builds only, wired from sw.js)
let hooks = { hangRemove: false, abort: false, noFast: false, noWindow: false, timeoutMs: DRAIN_CALL_TIMEOUT_MS, backoffMs: DRAIN_BACKOFF_MS };
let fastSize = 120; // fast path: tabs per remove() call, grows/shrinks with the measured latency
let fastOff = false; // set when the fast path misbehaved for this job: the gentle path finishes it
let lastJob = null;
let liveMap = null; // {at, map} one tabs.query({}) result reused as the next batch's drift-check map
const RISKY_REMOVE_MS = 3000; // tabs that could not be frozen: remove with a short timeout (a beforeunload dialog would hang it)
export function debugHooks(patch) { hooks = { ...hooks, ...patch }; }
export function isRunning() { return running; }

export function noteReplaced(added, removed) { replaced.set(removed, added); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleeps in slices of <= 20 s with a chrome.* heartbeat so the service worker is never idle for long. */
async function sleepSlices(ms) {
  let left = ms;
  while (left > 0) {
    const s = Math.min(left, 20000);
    await sleep(s);
    left -= s;
    if (left > 0) { try { await chrome.system.memory.getInfo(); } catch { /* ignore */ } }
  }
}

function withTimeout(p, ms) {
  let t;
  const timer = new Promise((resolve) => { t = setTimeout(() => resolve({ timeout: true }), ms); });
  return Promise.race([
    Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    timer,
  ]).finally(() => clearTimeout(t));
}

export async function currentSession() {
  const r = await chrome.storage.session.get(KEYS.S_BSESS);
  if (r[KEYS.S_BSESS]) return r[KEYS.S_BSESS];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await chrome.storage.session.set({ [KEYS.S_BSESS]: id });
  return id;
}

async function progress(d, extra = {}) {
  const free = await freeRatio();
  post({
    type: 'progress', op: 'stash', job: d.job, total: d.total, closed: d.closed, skipped: d.skipped,
    discarded: d.discarded, dfail: d.dfail || 0, lastProgressAt: d.lastProgressAt || null, level: d.level, paused: d.paused, needsConfirm: !!d.needsConfirm,
    free: free == null ? null : Math.round(free * 100), ...extra,
  });
  const pct = d.total ? Math.floor((d.closed / d.total) * 100) : 100;
  const sw = await swStr();
  if (d.paused) await setDrainBadge('||', '#757575', sw.drainPaused);
  else {
    const f = free == null ? '?' : Math.round(free * 100);
    await setDrainBadge(pct + '%', d.level === 'healthy' ? '#ef6c00' : '#c62828', sw.drainTitle(d.closed, d.total, f, d.level));
  }
}

/** Drops records whose tab no longer exists (closed by the user / Chrome / a previous run). */
async function reconcile(d) {
  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const live = new Set(tabs.map((t) => t.id));
  const recs = (await db.drainRecords(d.job, 'queued')).concat(await db.drainRecords(d.job, 'discarded'));
  const del = recs.filter((r) => !live.has(r.tabId) && !replaced.has(r.tabId)).map((r) => r.tabId);
  if (del.length) await db.drainApply({ del, patch: (dd) => { dd.closed += del.length; } });
  removalsSince = 0;
}

async function resolveTab(r) {
  try { return await chrome.tabs.get(r.tabId); } catch { /* maybe replaced */ }
  const nid = replaced.get(r.tabId);
  if (nid != null) { try { return await chrome.tabs.get(nid); } catch { /* gone */ } }
  return null;
}

/**
 * One chunk = a pipeline over SMALL groups of tabs (healthy 4 / low 3 / critical 2 / severe 1):
 *   discard the group in parallel (frees the renderers at once) -> remove it right away; while a group is being removed the
 *   next one is already being discarded. So RAM is released continuously and the counters move after every few tabs,
 *   instead of "discard 40 tabs sequentially, THEN remove 80".
 * Rules: a discard that times out / is refused (active, audible, beforeunload...) never stalls the job: that tab goes on to
 * removal; the closure is verified (a tab kept alive by a beforeunload dialog is retried, then reported, never counted as
 * closed). Bookkeeping + progress are flushed at most every 250 ms (reconcile() makes an unflushed tail safe after a crash).
 * Returns 'continue' | 'done' | 'paused'.
 */


/**
 * WINDOW FAST PATH. Measured on 300 loaded tabs: tabs.remove(all ids) / in chunks of 120 / chunks of 40 all take ~9 s (Chrome
 * tears the tabs down one by one, the batching makes no difference) while chrome.windows.remove(windowId) takes ~2.5 s.
 * So when EVERY tab of a window belongs to this job (nothing pinned / kept / drifted in it) the whole window is closed with one
 * windows.remove call. Our own list page in such a window is replaced: ONE fresh list page opens in a new window with the same
 * bounds BEFORE the old window is removed (the browser always keeps a window). Outcome is reconciled with one tabs.query({}):
 * saved-but-still-open tabs simply stay queued for the batch / gentle path. Returns true when something was done.
 */
let winPassJob = null;
const WINDOW_MIN_TABS = 120; // below this a new window + windows.remove costs more than it saves (measured: 50 tabs 2.3 s vs 1.0 s)

async function windowFastPath(d) {
  if (winPassJob === d.job) return false;
  winPassJob = d.job;
  const recs = (await db.drainRecords(d.job, 'queued')).concat(await db.drainRecords(d.job, 'discarded'));
  if (recs.length < WINDOW_MIN_TABS) return false;
  let tabs;
  let wins;
  try {
    tabs = await chrome.tabs.query({});
    wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  } catch { return false; }
  const stashUrl = chrome.runtime.getURL('stash.html');
  const isOwn = (t) => (t.url || t.pendingUrl || '').startsWith(stashUrl);
  const recByTab = new Map(recs.map((r) => [r.tabId, r]));
  const byWin = new Map();
  for (const t of tabs) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t); }
  const eligible = [];
  for (const w of wins) {
    if (w.incognito) continue;
    const inW = byWin.get(w.id) || [];
    const job = inW.filter((t) => recByTab.has(t.id));
    const own = inW.filter((t) => !recByTab.has(t.id) && isOwn(t));
    if (job.length < WINDOW_MIN_TABS || job.length + own.length !== inW.length) continue; // pinned / kept tabs live here: tabs.remove path
    if (job.some((t) => dk(t.pendingUrl || t.url || '') !== recByTab.get(t.id).url)) continue; // drift: never close an unsaved URL
    eligible.push({ w, job, own });
  }
  if (!eligible.length) return false;
  // the browser must keep a window with our fresh list page: one new window, same bounds as the window that had the old page
  const survivors = wins.filter((w) => !w.incognito && !eligible.some((e) => e.w.id === w.id));
  const hadOwn = eligible.find((e) => e.own.length) || null;
  let fresh = null;
  if (hadOwn || !survivors.length) {
    const src = (hadOwn || eligible[0]).w;
    const opt = { url: stashUrl, focused: true };
    if (src.state === 'normal' || !src.state) { opt.left = src.left; opt.top = src.top; opt.width = src.width; opt.height = src.height; } else opt.state = src.state;
    try {
      fresh = await chrome.windows.create(opt);
      if (fresh.tabs && fresh.tabs[0]) { try { await chrome.tabs.update(fresh.tabs[0].id, { autoDiscardable: false }); } catch { /* ignore */ } }
    } catch { return false; }
  }
  for (const e of eligible) {
    if (hooks.abort) return true;
    const res = await withTimeout(hooks.hangRemove ? new Promise(() => {}) : chrome.windows.remove(e.w.id), RISKY_REMOVE_MS + 2000);
    if (res.timeout) break; // a confirm-to-leave dialog or a slow Chrome: the rest goes through the gentle path
  }
  await sleep(150);
  let alive;
  try { alive = new Map((await chrome.tabs.query({})).map((t) => [t.id, t])); } catch { alive = new Map(); }
  const del = [];
  const put = [];
  let closed = 0;
  const ownIds = new Set(eligible.flatMap((e) => e.job.map((t) => t.id)));
  for (const r of recs) {
    if (!ownIds.has(r.tabId)) continue;
    if (alive.has(r.tabId)) { put.push({ ...r, state: 'queued', attempts: (r.attempts || 0) + 1, fastTried: true }); } else { del.push(r.tabId); closed++; }
  }
  if (put.length) { fastOff = true; latAdj = 1; }
  liveMap = { at: Date.now(), map: alive };
  await db.drainApply({ put, del, patch: (dd) => { dd.closed += closed; dd.lastProgressAt = Date.now(); dd.fast = true; dd.winRemoved = (dd.winRemoved || 0) + eligible.length; } });
  const fresh2 = (await db.getMeta()).drain;
  if (fresh2 && fresh2.job === d.job) await progress(fresh2);
  return true;
}

/**
 * FAST PATH (healthy RAM + low latency): no discard, tabs.remove on LARGE id batches (~120, adaptive 40..400 while each call
 * stays < 300 ms), the drift check uses ONE tabs.query({}) map per batch (reused as the next batch's map), bookkeeping is
 * flushed concurrently with the next call. A batch that is slow or leaves tabs alive (confirm-to-leave dialogs) switches the
 * rest of the job to the gentle discard -> remove path. Returns 'continue' | 'done' | 'paused' | 'fallback'.
 */
async function fastChunk(d) {
  const work = (await db.drainBatch(d.job, 'discarded', fastSize)).concat(await db.drainBatch(d.job, 'queued', fastSize));
  const batch = work.slice(0, fastSize);
  if (!batch.length) {
    const left = (await db.drainCount(d.job, 'queued')) + (await db.drainCount(d.job, 'discarded'));
    return left === 0 ? 'done' : 'fallback';
  }
  let map;
  if (liveMap && Date.now() - liveMap.at < 500) map = liveMap.map;
  else { try { map = new Map((await chrome.tabs.query({})).map((t) => [t.id, t])); } catch { return 'fallback'; } }

  const put = [];
  const del = [];
  let closed = 0;
  let skipped = 0;
  const toClose = [];
  for (const r of batch) {
    let tab = map.get(r.tabId);
    if (!tab && replaced.has(r.tabId)) tab = map.get(replaced.get(r.tabId));
    if (!tab) { del.push(r.tabId); closed++; continue; }
    const cur = tab.pendingUrl || tab.url || '';
    if (dk(cur) !== r.url) { put.push({ ...r, state: 'skipped', reason: 'changed' }); skipped++; continue; }
    toClose.push({ r, id: tab.id });
  }
  let ms = 0;
  let timedOut = false;
  if (toClose.length) {
    const ids = toClose.map((x) => x.id);
    const t1 = Date.now();
    const p = hooks.hangRemove ? new Promise(() => {}) : chrome.tabs.remove(ids);
    const res = await withTimeout(p, RISKY_REMOVE_MS);
    ms = Date.now() - t1;
    timedOut = !!res.timeout;
    if (timedOut) await sleep(700); else await sleep(30);
    let aliveSet;
    try { map = new Map((await chrome.tabs.query({})).map((t) => [t.id, t])); aliveSet = map; } catch { aliveSet = new Map(); }
    liveMap = { at: Date.now(), map };
    for (const x of toClose) {
      if (!aliveSet.has(x.id)) { del.push(x.id); closed++; removalsSince++; continue; }
      // still open after the call: hand it to the gentle path (discard first), at most one retry there
      put.push({ ...x.r, tabId: x.id, state: 'queued', attempts: (x.r.attempts || 0) + 1, fastTried: true });
    }
  }
  const stillOpen = put.filter((r) => r.state === 'queued').length;
  if (timedOut || stillOpen) { fastOff = true; latAdj = 1; }
  else if (ms < 300) fastSize = Math.min(400, Math.round(fastSize * 1.5));
  else if (ms > 1500) { fastOff = true; latAdj = 1; }
  else if (ms > 600) fastSize = Math.max(40, fastSize >> 1);
  await db.drainApply({
    put, del,
    patch: (dd) => { dd.closed += closed; dd.skipped += skipped; dd.lastProgressAt = Date.now(); dd.fast = !fastOff; },
  });
  const fresh = (await db.getMeta()).drain;
  if (fresh && fresh.job === d.job) await progress(fresh);
  if (removalsSince >= RECONCILE_EVERY) { await reconcile(d); liveMap = null; }
  const left = (await db.drainCount(d.job, 'queued')) + (await db.drainCount(d.job, 'discarded'));
  return left === 0 ? 'done' : 'continue';
}

const GROUP_BY_LEVEL = [4, 3, 2, 1];
const FLUSH_MS = 250;

async function chunk(d) {
  const t0 = Date.now();
  const ratio = await freeRatio();
  const li = Math.min(DRAIN_LEVELS.length - 1, levelIndexFor(ratio) + latAdj);
  const L = DRAIN_LEVELS[li];
  tick++;
  if (d.level !== L.name) {
    d.level = L.name;
    await db.metaQuiet((m) => { if (m.drain) m.drain.level = L.name; });
  }
  if (d.job !== lastJob) { lastJob = d.job; fastOff = false; fastSize = 120; liveMap = null; winPassJob = null; }
  if (!fastOff && !hooks.noFast && latAdj === 0 && li <= 1) {
    // whole windows (>= 120 tabs): windows.remove, fine while free RAM is >= 12 % (it loads nothing, it only tears down)
    if (!hooks.noWindow && (await windowFastPath(d))) return 'continue';
    if (li === 0) { // big tabs.remove batches only while RAM is healthy (>= 25 %)
      const fr = await fastChunk(d);
      if (fr !== 'fallback') return fr;
    }
  }
  const severeDiscardOnly = li === DRAIN_LEVELS.length - 1 && tick % 2 === 1; // severe: remove only every second chunk
  const G = GROUP_BY_LEVEL[li];

  // work list: tabs frozen earlier but not removed yet (resume / severe), then the next queued ones
  const budget = Math.max(L.discard, L.remove);
  const leftover = await db.drainBatch(d.job, 'discarded', budget);
  const queued = leftover.length >= budget ? [] : await db.drainBatch(d.job, 'queued', budget - leftover.length);
  const work = leftover.concat(queued);
  if (!work.length) {
    const none = (await db.drainCount(d.job, 'queued')) + (await db.drainCount(d.job, 'discarded'));
    if (none === 0) return 'done';
  }

  // incremental bookkeeping (flushed every FLUSH_MS)
  const ctx = { put: [], del: [], closed: 0, skipped: 0, discarded: 0, dfail: 0, last: Date.now() };
  const flush = async (force) => {
    if (!force && Date.now() - ctx.last < FLUSH_MS) return;
    ctx.last = Date.now();
    if (!ctx.put.length && !ctx.del.length && !ctx.closed && !ctx.skipped && !ctx.discarded && !ctx.dfail && !force) return;
    const snap = { put: ctx.put, del: ctx.del, closed: ctx.closed, skipped: ctx.skipped, discarded: ctx.discarded, dfail: ctx.dfail };
    ctx.put = []; ctx.del = []; ctx.closed = 0; ctx.skipped = 0; ctx.discarded = 0; ctx.dfail = 0;
    await db.drainApply({
      put: snap.put, del: snap.del,
      patch: (dd) => {
        dd.closed += snap.closed; dd.skipped += snap.skipped; dd.discarded += snap.discarded; dd.dfail = (dd.dfail || 0) + snap.dfail;
        dd.lastProgressAt = Date.now();
      },
    });
    const fresh = (await db.getMeta()).drain;
    if (fresh && fresh.job === d.job) await progress(fresh);
  };

  let stalled = false;
  const noteTimeout = () => { timeoutStreak++; latAdj = 1; if (timeoutStreak >= DRAIN_STALL_AFTER) stalled = true; };

  const discardOne = async (r) => {
    if (r.state === 'discarded') return { r, tabId: r.tabId, frozen: true, counted: true }; // frozen earlier (resume / retry)
    if (r.discardedAtStart) return { r, tabId: r.tabId, frozen: true };
    const res = await withTimeout(chrome.tabs.discard(r.tabId), hooks.timeoutMs);
    if (res.timeout) { noteTimeout(); return { r, tabId: r.tabId, frozen: false, fail: 'timeout' }; }
    timeoutStreak = 0;
    if (res.ok && res.v) {
      const nid = res.v.id != null ? res.v.id : r.tabId;
      return { r, tabId: nid, oldId: nid !== r.tabId ? r.tabId : null, frozen: true };
    }
    return { r, tabId: r.tabId, frozen: false, fail: res.ok ? 'refused' : 'error' }; // active / audible / blocked: still removable
  };

  const removeGroup = async (results) => {
    const toClose = [];
    for (const x of results) {
      const r = x.r;
      if (x.oldId != null) ctx.del.push(x.oldId);
      if (!x.counted) { if (x.frozen) ctx.discarded++; else ctx.dfail++; }
      const tab = await resolveTab({ ...r, tabId: x.tabId });
      if (!tab) { ctx.del.push(x.tabId); ctx.closed++; continue; }
      const cur = tab.pendingUrl || tab.url || '';
      if (dk(cur) !== r.url) { ctx.put.push({ ...r, tabId: x.tabId, state: 'skipped', reason: 'changed' }); ctx.skipped++; continue; }
      if (severeDiscardOnly) { ctx.put.push({ ...r, tabId: x.tabId, state: 'discarded' }); continue; }
      toClose.push({ r, id: tab.id, frozen: x.frozen });
    }
    if (!toClose.length) return;
    // tabs that were frozen cannot show a "Leave site?" dialog: remove them as ONE call. Tabs that could not be frozen
    // (refused / timed out) are removed one by one with a short timeout, in parallel: a dialog must not stall the rest.
    const frozenOnes = toClose.filter((x) => x.frozen);
    const risky = toClose.filter((x) => !x.frozen);
    const tasks = [];
    if (frozenOnes.length) {
      tasks.push((async () => {
        const ids = frozenOnes.map((x) => x.id);
        const p = hooks.hangRemove ? new Promise(() => {}) : chrome.tabs.remove(ids);
        const res = await withTimeout(p, hooks.timeoutMs);
        if (res.timeout) {
          noteTimeout();
          for (const x of frozenOnes) ctx.put.push({ ...x.r, tabId: x.id, state: 'discarded', attempts: x.r.attempts || 0 });
          return;
        }
        timeoutStreak = 0;
        await sleep(40);
        for (const x of frozenOnes) {
          let alive = false;
          try { await chrome.tabs.get(x.id); alive = true; } catch { alive = false; }
          if (!alive) { ctx.del.push(x.id); ctx.closed++; removalsSince++; continue; }
          const attempts = (x.r.attempts || 0) + 1;
          if (attempts >= 3) { ctx.put.push({ ...x.r, tabId: x.id, state: 'skipped', reason: 'blocked', attempts }); ctx.skipped++; }
          else ctx.put.push({ ...x.r, tabId: x.id, state: 'discarded', attempts });
        }
      })());
    }
    for (const x of risky) {
      tasks.push((async () => {
        const p = hooks.hangRemove ? new Promise(() => {}) : chrome.tabs.remove(x.id);
        const res = await withTimeout(p, RISKY_REMOVE_MS);
        let alive = false;
        if (res.timeout) alive = true; else { await sleep(40); try { await chrome.tabs.get(x.id); alive = true; } catch { alive = false; } }
        if (!alive) { ctx.del.push(x.id); ctx.closed++; removalsSince++; return; }
        // still open (a confirm-to-leave dialog, or Chrome refused): leave it open, report it, never claim it closed
        ctx.put.push({ ...x.r, tabId: x.id, state: 'skipped', reason: 'blocked', attempts: (x.r.attempts || 0) + 1 });
        ctx.skipped++;
      })());
    }
    await Promise.all(tasks);
  };

  // pipeline: discard(group k+1) overlaps remove(group k)
  let prev = Promise.resolve();
  for (let i = 0; i < work.length; i += G) {
    if (hooks.abort) { await prev; return 'continue'; }
    if (stalled) break;
    const group = work.slice(i, i + G);
    const dp = Promise.all(group.map(discardOne));
    await prev; // removal of the previous group must be done before this group's removal starts (and bounds the memory in flight)
    const results = await dp;
    prev = removeGroup(results).then(() => flush(false));
    if (!stalled && timeoutStreak >= 2 && results.some((x) => x.fail === 'timeout')) await sleepSlices(hooks.backoffMs[Math.min(Math.max(0, timeoutStreak - 2), hooks.backoffMs.length - 1)] || 1000); // one slow tab never delays the others
  }
  await prev;
  await flush(true);
  if (stalled) {
    await db.metaQuiet((m) => { if (m.drain) m.drain.paused = 'stalled'; });
    return 'paused';
  }

  // ---- adaptive pacing ----
  const apiMs = Date.now() - t0;
  if (apiMs > 2000 * Math.max(1, work.length / 8)) { latAdj = 1; fastStreak = 0; } else if (apiMs < 300 * Math.max(1, work.length / 8)) {
    fastStreak++;
    if (fastStreak >= 3 && latAdj > 0) { latAdj = 0; fastStreak = 0; }
  } else fastStreak = 0;

  if (removalsSince >= RECONCILE_EVERY) await reconcile(d);
  const leftQ = await db.drainCount(d.job, 'queued');
  const leftD = await db.drainCount(d.job, 'discarded');
  if (leftQ + leftD === 0) return 'done';
  await sleepSlices(severeDiscardOnly ? Math.min(L.delay, 500) : L.delay);
  return 'continue';
}

async function finishJob(d) {
  if (d.cancelled && d.dropRemaining) {
    // keep only what was really closed: drop the still-open tabs' items from the saved group
    const open = (await db.drainRecords(d.job, 'queued')).concat(await db.drainRecords(d.job, 'discarded'));
    const byGroup = new Map();
    for (const r of open) {
      if (!(r.seq > 0)) continue;
      if (!byGroup.has(r.gid)) byGroup.set(r.gid, new Set());
      byGroup.get(r.gid).add(r.seq);
    }
    for (const [gid, set] of byGroup) {
      try { await db.removeItems(gid, [...set]); } catch { /* ignore */ }
    }
  }
  const res = await db.finishDrain(d.job);
  post({ type: 'progress', op: 'stash', finished: true, job: d.job, closed: res.closed, skipped: res.skipped, skippedList: res.skippedList });
  scheduleBadge();
  runSnapshot({ kind: 'auto', force: true, ignoreBusy: true }).catch(() => {}); // the new (post-close) state is the newest snapshot
}

async function ensureAlarm() {
  try { await chrome.alarms.create(ALARMS.DRAIN, { periodInMinutes: 0.5, delayInMinutes: 0.5 }); } catch { /* ignore */ }
}

/** The drain loop. Safe to call repeatedly; only one loop runs. */
export async function runDrain() {
  if (running) return;
  running = true;
  hooks.abort = false;
  try {
    await ensureAlarm();
    let first = true;
    for (;;) {
      const meta = await db.getMeta();
      const d = meta.drain;
      if (!d || d.needsConfirm || d.paused) break;
      if (first) { await reconcile(d); first = false; }
      if (d.cancelled) { await finishJob(d); first = true; continue; }
      const r = await chunk(d);
      if (hooks.abort) { hooks.abort = false; return; } // test only: simulates the worker dying mid-job
      if (r === 'paused') { const m = await db.getMeta(); if (m.drain) await progress(m.drain); break; }
      if (r === 'done') {
        const m = await db.getMeta();
        await finishJob(m.drain && m.drain.job === d.job ? m.drain : d);
        first = true;
      }
    }
  } finally {
    running = false;
  }
  const m = await db.getMeta();
  if (!m.drain) { try { await chrome.alarms.clear(ALARMS.DRAIN); } catch { /* ignore */ } await clearDrainBadge(); }
}

/** SW start / 'drain' alarm. Never auto-continues across a browser restart (tab ids are invalid then). */
export async function resumeDrain() {
  const m = await db.getMeta();
  const d = m.drain;
  if (!d) return;
  const cur = await currentSession();
  if (d.browserSession !== cur) {
    // a new browser session: saved tab ids are meaningless now. Even a running loop stops at its next check.
    if (!d.needsConfirm) await db.metaQuiet((mm) => { if (mm.drain) mm.drain.needsConfirm = true; });
    const m2 = await db.getMeta();
    await progress(m2.drain);
    return;
  }
  if (running) return;
  if (d.paused === 'stalled') {
    timeoutStreak = 0;
    await db.metaQuiet((mm) => { if (mm.drain) mm.drain.paused = false; });
  } else if (d.paused) return; // paused by the user
  runDrain().catch(() => {});
}

export async function pauseDrain() {
  await db.metaQuiet((m) => { if (m.drain) m.drain.paused = 'user'; });
  const m = await db.getMeta();
  if (m.drain) await progress(m.drain);
}

export async function resumeUser() {
  timeoutStreak = 0;
  await db.metaQuiet((m) => { if (m.drain) { m.drain.paused = false; m.drain.needsConfirm = false; } });
  runDrain().catch(() => {});
}

export async function stopDrain(dropRemaining) {
  await db.metaQuiet((m) => {
    if (m.drain) { m.drain.cancelled = true; m.drain.dropRemaining = !!dropRemaining; m.drain.paused = false; m.drain.needsConfirm = false; }
  });
  runDrain().catch(() => {});
}

/** After a browser restart: re-match remaining records to open tabs by exact URL (one tab per record), then resume. */
export async function continueAfterRestart() {
  const m = await db.getMeta();
  const d = m.drain;
  if (!d) return { matched: 0 };
  const cur = await currentSession();
  const tabs = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const t of tabs) {
    const u = dk(t.pendingUrl || t.url || '');
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u).push(t);
  }
  const recs = (await db.drainRecords(d.job, 'queued')).concat(await db.drainRecords(d.job, 'discarded'));
  const put = [];
  const del = [];
  let gone = 0;
  for (const r of recs) {
    const list = byUrl.get(r.url);
    const t = list && list.shift();
    del.push(r.tabId);
    if (!t) { gone++; continue; }
    put.push({ ...r, tabId: t.id, state: 'queued', windowId: t.windowId, discardedAtStart: !!t.discarded });
  }
  // drainApply deletes first, then puts (a new id may equal another record's old id)
  await db.drainApply({
    del, put,
    patch: (dd) => { dd.browserSession = cur; dd.needsConfirm = false; dd.paused = false; dd.closed += gone; },
  });
  runDrain().catch(() => {});
  return { matched: put.length, gone };
}
