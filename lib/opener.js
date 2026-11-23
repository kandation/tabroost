// Memory-aware tab opening pipeline shared by restore and refresh.
//
// Measured on the isolated test Chrome (150 heavy local pages, 4 s baseline vs peak working set of the whole browser):
//   A sequential, wait 'complete' then discard      4.8 tabs/s  +168 MB
//   B pool 4,   wait 'complete' then discard       14.5 tabs/s  +275 MB
//   D pool 1,   discard as soon as the url COMMITS  6.1 tabs/s  +111 MB
//   D pool 4,   discard on commit                  19.2 tabs/s  +211 MB   <- default when RAM is healthy
//   D pool 8,   discard on commit                  22.6 tabs/s  +427 MB   <- 'fast'
//   C fire everything, then discard (120 tabs)                 +8.3 GB     <- never
// So: discard right when the navigation commits (the url and title survive), a small pool, and the pool shrinks with
// free RAM (tiers below). Nothing here ever activates a tab or focuses a window.

import { freeRatio } from './mem.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- commit tracking: ONE listener pair, installed while somebody waits ----------
const waiters = new Map(); // tabId -> {done(result)}
const settlers = new Map(); // tabId -> finish() : waits for the first title / favicon update after commit
let listening = false;

const committed = (t) => !!t && !!t.url && !t.pendingUrl && t.url !== 'about:blank';

function onUpd(tabId, info, tab) {
  const w = waiters.get(tabId);
  if (w && committed(tab)) w.done('commit');
  const st = settlers.get(tabId);
  if (st && (info.title !== undefined || info.favIconUrl !== undefined)) st(info.title !== undefined ? 'title' : 'icon');
}
function onRem(tabId) {
  const w = waiters.get(tabId);
  if (w) w.done('gone');
}
function ensureListening() {
  if (listening) return;
  listening = true;
  chrome.tabs.onUpdated.addListener(onUpd);
  chrome.tabs.onRemoved.addListener(onRem);
}
/**
 * After the url committed, give the page a moment to deliver its real title (and favicon) before the tab is frozen:
 * a tab frozen at the very instant of the commit keeps the bare url as its title. Resolves early on the first title event.
 */
export function settle(tab, ms = 500) {
  if (!ms) return Promise.resolve('skip');
  return new Promise((resolve) => {
    let timer = null;
    const finish = (r) => {
      clearTimeout(timer);
      if (settlers.get(tab.id) === finish) settlers.delete(tab.id);
      maybeStopListening();
      resolve(r);
    };
    settlers.set(tab.id, finish);
    ensureListening();
    timer = setTimeout(() => finish('timeout'), ms);
    chrome.tabs.get(tab.id).then((t) => {
      // already titled (real title differs from the url without its scheme)?
      const bare = String(t.url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      if (t.title && t.title !== bare && t.title !== t.url) finish('title');
    }).catch(() => finish('gone'));
  });
}

function maybeStopListening() {
  if (!listening || waiters.size || settlers.size) return;
  listening = false;
  chrome.tabs.onUpdated.removeListener(onUpd);
  chrome.tabs.onRemoved.removeListener(onRem);
}

/** Resolves 'commit' | 'complete' | 'gone' | 'timeout'. `until` = 'commit' (default) or 'complete'. */
export function waitFor(tab, { until = 'commit', timeoutMs = 15000 } = {}) {
  const id = tab.id;
  const ok = (t) => (until === 'complete' ? !!t && t.status === 'complete' && committed(t) : committed(t));
  if (ok(tab)) return Promise.resolve(until === 'complete' ? 'complete' : 'commit');
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (waiters.get(id) === w) waiters.delete(id);
      maybeStopListening();
      resolve(r);
    };
    const w = {
      done: (r) => {
        if (r === 'gone') return finish('gone');
        // the listener only knows "committed"; for 'complete' re-check the tab
        if (until === 'complete') {
          chrome.tabs.get(id).then((t) => { if (ok(t)) finish('complete'); }).catch(() => finish('gone'));
          return null;
        }
        return finish('commit');
      },
    };
    waiters.set(id, w);
    ensureListening();
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    // closes the race between create() returning and the listener existing
    chrome.tabs.get(id).then((t) => { if (ok(t)) finish(until === 'complete' ? 'complete' : 'commit'); }).catch(() => finish('gone'));
    if (until === 'complete') {
      // status flips to 'complete' with an update event that carries no url change: poll cheaply as a safety net
      const poll = async () => {
        while (!finished) {
          await sleep(400);
          if (finished) return;
          try { const t = await chrome.tabs.get(id); if (ok(t)) { finish('complete'); return; } } catch { finish('gone'); return; }
        }
      };
      poll();
    }
  });
}

// ---------- memory tiers ----------
// ratio = free RAM / total RAM. `resume` is the hysteresis threshold to leave the paused state.
export const MODES = ['auto', 'sequential', 'fast', 'loadAll'];

export function tierFor(mode, ratio) {
  const r = ratio == null ? 0.2 : ratio;
  const healthy = r >= 0.25;
  const low = r >= 0.12;
  const critical = r >= 0.05;
  if (!critical) return { name: 'severe', pool: 0, delay: 0 };
  if (mode === 'sequential') return { name: healthy ? 'healthy' : low ? 'low' : 'critical', pool: 1, delay: healthy ? 0 : low ? 100 : 400 };
  if (mode === 'fast' || mode === 'loadAll') {
    if (healthy || mode === 'loadAll' && low) return { name: 'healthy', pool: 8, delay: 0 };
    return { name: low ? 'low' : 'critical', pool: low ? 4 : 2, delay: low ? 50 : 300 };
  }
  // auto
  if (healthy) return { name: 'healthy', pool: 3, delay: 0 };
  if (low) return { name: 'low', pool: 3, delay: 100 };
  return { name: 'critical', pool: 1, delay: 400 };
}

/**
 * Runs `run(i)` for i = startIdx..count-1 with a memory-adaptive number of concurrent runs.
 *  - mode: 'auto' | 'sequential' | 'fast' | 'loadAll'
 *  - run(i) does the whole per-item sequence (create -> wait for commit -> discard) and resolves when its slot may be reused
 *  - stop(): true = stop starting new items; pause hook: onPause(bool) is called when entering / leaving the "RAM critical" pause
 *  - onTier(name, ratio) lets the caller show the level
 * Returns the number of items started.
 */
export async function runPool({ count, startIdx = 0, mode = 'auto', run, stop = () => false, onPause = () => {}, onTier = () => {} }) {
  let next = startIdx;
  let live = 0;
  let started = 0;
  let paused = false;
  let tier = { name: 'healthy', pool: 3, delay: 0 };
  let tierAt = 0;
  let lastDelayAt = 0;

  const refresh = async (force) => {
    const now = Date.now();
    if (!force && now - tierAt < 300) return tier;
    tierAt = now;
    const ratio = await freeRatio();
    let t = tierFor(mode, ratio);
    if (paused && ratio != null && ratio < 0.12) t = { name: 'severe', pool: 0, delay: 0 }; // hysteresis: resume at >= 12 %
    if (t.name !== tier.name) onTier(t.name, ratio);
    tier = t;
    return tier;
  };

  const worker = async () => {
    for (;;) {
      if (stop()) return;
      let t = await refresh(false);
      while (t.pool === 0) {
        if (!paused) { paused = true; onPause(true); }
        await sleep(2000);
        if (stop()) { if (paused) { paused = false; onPause(false); } return; }
        t = await refresh(true);
      }
      if (paused) { paused = false; onPause(false); }
      if (live >= t.pool) { await sleep(15); continue; }
      if (next >= count) return;
      const i = next++;
      live++;
      started++;
      try {
        if (t.delay) {
          const wait = lastDelayAt + t.delay - Date.now();
          lastDelayAt = Math.max(Date.now(), lastDelayAt) + (wait > 0 ? 0 : 0);
          if (wait > 0) await sleep(wait);
          lastDelayAt = Date.now();
        }
        await run(i);
      } catch { /* run() reports its own failures */ } finally {
        live--;
      }
    }
  };
  const n = Math.max(1, Math.min(8, count - startIdx));
  await Promise.all(Array.from({ length: n }, worker));
  return started;
}
