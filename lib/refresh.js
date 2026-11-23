// "Refresh all": reloads frozen (discarded) tabs of the current window or of a restored session, in the background and in
// small memory-aware steps (same pipeline as restore). A refresh never activates a tab or focuses a window.
//   rediscard = true  -> every tab is frozen again as soon as it finished loading (fresh content, flat RAM)
//   rediscard = false -> tabs stay loaded; the pool still limits how many load at once
// The job lives in meta.refresh, so it survives a service-worker restart (resumeRefresh) and can be cancelled.

import * as db from './db.js';
import { post } from './bus.js';
import { getSettings } from './settings.js';
import { runPool, waitFor } from './opener.js';
import { STASH_PAGE } from './constants.js';
import { partnerBusy } from './splitview.js';
import { runProbe } from './suspend.js';
import * as perms from './perms.js';

let running = false;
let cancelFlag = false;
let lastEmit = 0;

const view = (j, extra = {}) => (j ? { total: j.ids.length, done: j.done, skipped: j.skipped || 0, rediscard: !!j.rediscard, scope: j.scope, paused: j.paused || null, ...extra } : null);

function emit(job, extra = {}, force = false) {
  const now = Date.now();
  if (!force && now - lastEmit < 250) return;
  lastEmit = now;
  post({ type: 'progress', op: 'refresh', job: view(job), ...extra });
}

async function collectTargets(scope, { windowId, gid }) {
  const stashUrl = chrome.runtime.getURL(STASH_PAGE);
  const all = await chrome.tabs.query({});
  const byId = new Map(all.map((t) => [t.id, t]));
  let ids = [];
  if (scope === 'session') {
    const meta = await db.getMeta();
    const entry = (meta.restored || []).find((r) => !gid || (r.gids || []).includes(gid)) || null;
    ids = entry ? entry.tabIds.filter((id) => byId.has(id)) : [];
  } else {
    ids = all.filter((t) => windowId == null || t.windowId === windowId).map((t) => t.id);
  }
  return ids.filter((id) => {
    const t = byId.get(id);
    // every web tab except the one in use counts; loaded tabs are checked for unsaved input / playing media right before the reload
    return t && !t.incognito && !t.active && !(t.url || '').startsWith(stashUrl) && /^(https?|file|ftp):/i.test(t.url || t.pendingUrl || '');
  });
}

export async function startRefresh({ scope = 'window', windowId, gid, rediscard } = {}) {
  const meta = await db.getMeta();
  if (meta.refresh && running) return { error: 'busy' };
  if (meta.refresh) await db.metaQuiet((m) => { m.refresh = null; }); // a leftover job from a worker that died: drop it instead of blocking every new refresh
  const settings = await getSettings();
  const ids = await collectTargets(scope === 'session' ? 'session' : 'window', { windowId, gid });
  if (!ids.length) return { total: 0 };
  // loaded tabs can only be refreshed after the page check, which needs the optional host access: tell the UI so it can explain
  const idSet = new Set(ids);
  const loadedN = (await chrome.tabs.query({})).filter((t) => idSet.has(t.id) && !t.discarded).length;
  const noAccess = loadedN > 0 && !(await perms.hasHost());
  const job = {
    id: Date.now().toString(36), ids, done: 0, skipped: 0, scope: scope === 'session' ? 'session' : 'window',
    rediscard: rediscard == null ? settings.refreshRediscard !== false : !!rediscard, paused: null, startedAt: Date.now(),
  };
  await db.metaQuiet((m) => { m.refresh = job; });
  emit(job, {}, true);
  runRefresh().catch(() => {});
  return { total: ids.length, noAccess, loaded: loadedN };
}

export async function runRefresh() {
  if (running) return;
  running = true;
  cancelFlag = false;
  try {
    const meta = await db.getMeta();
    const job = meta.refresh;
    if (!job) return;
    const settings = await getSettings();
    let completed = job.done;
    let skipped = job.skipped || 0;
    const startIdx = Math.max(0, job.done - 8); // reload is idempotent: redo the few that were in flight
    let sinceSave = 0;
    const why = { form: 0, media: 0, access: 0 }; // why loaded tabs were skipped (shown in the finished message)
    const save = async () => { sinceSave = 0; await db.metaQuiet((m) => { if (m.refresh && m.refresh.id === job.id) { m.refresh.done = completed; m.refresh.skipped = skipped; } }); };
    await runPool({
      count: job.ids.length, startIdx, mode: settings.restoreMode,
      stop: () => cancelFlag,
      onPause: (p) => { job.paused = p ? 'memory' : null; emit({ ...job, done: completed }, {}, true); },
      run: async (i) => {
        const id = job.ids[i];
        try {
          const t = await chrome.tabs.get(id);
          if (t.active) { skipped++; return; } // the tab in use is never touched
          if (!t.discarded) {
            // a loaded tab: reloading would drop unsaved form input or stop playing media, so it needs the page check (host access)
            if (t.audible) { skipped++; why.media++; return; }
            if (!(await perms.hasHost())) { skipped++; why.access++; return; }
            const pr = await runProbe(id);
            if (!pr.ok) { skipped++; why.access++; return; }
            if (pr.b) { skipped++; why.form++; return; }
            if (pr.m >= 2 || (await partnerBusy(t))) { skipped++; why.media++; return; }
          }
          await chrome.tabs.reload(id);
          const tab = await chrome.tabs.get(id);
          const r = await waitFor(tab, { until: 'complete', timeoutMs: 25000 });
          if (job.rediscard && r === 'complete') {
            try { const t2 = await chrome.tabs.get(id); if (!t2.active && !t2.audible && !(await partnerBusy(t2))) await chrome.tabs.discard(id); } catch { /* stays loaded */ }
          }
          if (r === 'gone') skipped++;
        } catch { skipped++; } finally {
          completed++;
          emit({ ...job, done: completed, skipped });
          if (++sinceSave >= 25) await save();
        }
      },
    });
    if (cancelFlag) { await db.metaQuiet((m) => { m.refresh = null; }); emit(null, { finished: true, cancelled: true }, true); return; }
    await db.metaQuiet((m) => { m.refresh = null; });
    emit(null, { finished: true, total: job.ids.length, skipped, why }, true);
  } finally {
    running = false;
  }
}

export async function cancelRefresh() {
  cancelFlag = true;
  if (!running) { await db.metaQuiet((m) => { m.refresh = null; }); emit(null, { finished: true, cancelled: true }, true); }
  return {};
}

/** SW start: continue a job that was running when the worker died. */
export async function resumeRefresh() {
  const m = await db.getMeta();
  if (m.refresh && !running) runRefresh().catch(() => {});
}

export const isRefreshing = () => running;
