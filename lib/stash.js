// Stash protocol. Order matters (nothing is closed before it is saved and verified):
//   save everything -> verify every group -> create drain records -> beginDrain (one transaction) -> drain.
// The drain (discard first, then remove, in small memory-adaptive chunks) closes the tabs: ONE job per action,
// however many windows/groups it covers.

import { STASH_PAGE, APPEND_CHUNK, MAX_URL, MAX_TITLE, STR_SW } from './constants.js';
import { swStr } from './swstr.js';

let swS = STR_SW; // service-worker strings in the language in use (refreshed at the start of every save)
import { closeTabsGently } from './gentle.js';
import { id, classifyUrl, internalCategory, hostOf, hostMatches } from './formats.js';
import { siteOfUrl } from './site.js';
import * as db from './db.js';
import { dk } from './drainkey.js';
import { runExclusive } from './queue.js';
import { getSettings, isExcluded } from './settings.js';
import { post } from './bus.js';
import { setErrorBadge, setDrainBadge, scheduleBadge, skipReason, getAudibleMap, getOverrideMap } from './suspend.js';
import { runDrain, currentSession } from './drain.js';
import { runSnapshot } from './snapshot.js';
import * as act from './activity.js';
import * as firstseen from './firstseen.js';
import { splitIdOf, pairIndexes, splitGuard, partnerBusy } from './splitview.js';

const stashUrl = () => chrome.runtime.getURL(STASH_PAGE);
const isStashTab = (t) => ((t.pendingUrl || t.url || '').startsWith(stashUrl()));

/** A brand-new list page (never auto-discarded), created active in `windowId` BEFORE the old pages are closed. */
async function freshStashTab(windowId) {
  const t = await chrome.tabs.create({ windowId, url: stashUrl(), active: true });
  try { await chrome.tabs.update(t.id, { autoDiscardable: false }); } catch { /* ignore */ }
  return t.id;
}

/** Makes sure the window has a (never auto-discarded) stash page tab and activates it. */
export async function ensureStashTab(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  let ex = tabs.find(isStashTab);
  if (ex) await chrome.tabs.update(ex.id, { active: true, autoDiscardable: false });
  else {
    ex = await chrome.tabs.create({ windowId, url: stashUrl(), active: true });
    try { await chrome.tabs.update(ex.id, { autoDiscardable: false }); } catch { /* ignore */ }
  }
  return ex.id;
}

async function focusedWindowId() {
  try { return (await chrome.windows.getLastFocused()).id; } catch { return null; }
}

function writeProgress(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 100;
  post({ type: 'progress', op: 'stash', phase: 'writing', done, total });
  return setDrainBadge(pct + '%', '#1565c0', null);
}

/** Priority tier: already-discarded first, other windows, focused window, audible, window's active tab last. */
function prioOf(t, focusedId) {
  let tier;
  if (t.discarded) tier = 0;
  else if (t.audible) tier = 3;
  else if (t.active) tier = 4;
  else tier = t.windowId !== focusedId ? 1 : 2;
  return tier * 1e13 + (t.lastAccessed || 0);
}

/** Collects the saveable items and the tab records of one window's tabs. */
/** What to do with an internal/browser page: 'keep' | 'save' | 'close', or null for ordinary pages. */
function internalAction(url, settings) {
  const cat = internalCategory(url);
  if (!cat) return null;
  if (url.startsWith(chrome.runtime.getURL(''))) return 'keep'; // our own stash/popup pages are never touched
  if (cat === 'newtab') return 'close'; // new-tab / blank pages: always closed, never saved
  return settings.internalPages === 'close' ? 'close' : 'save'; // everything else: ONE choice (uniform for chrome://, about:, other extensions, devtools...)
}

/** Chrome tab-group info (title/color/collapsed) for every group id used by the tabs; read ONCE per id. */
async function loadTabGroupInfo(scopes, settings) {
  const info = new Map();
  if (!settings.keepTabGroups || !chrome.tabGroups) return info;
  const ids = new Set();
  for (const sc of scopes) for (const t of sc.tabs) if (t.groupId != null && t.groupId >= 0) ids.add(t.groupId);
  for (const gid of ids) {
    try {
      const g = await chrome.tabGroups.get(gid);
      info.set(gid, { title: String(g.title || '').slice(0, 200), color: g.color, collapsed: !!g.collapsed });
    } catch { /* group vanished: its tabs are stashed ungrouped */ }
  }
  return info;
}

/**
 * Items carry `tg` = window-local index into the returned `tabGroups` list (only groups that own at least one saved
 * item are listed). Tabs are walked in tab-strip order, so the tabs of one Chrome tab group stay adjacent.
 */
let FS = null; // first-seen map for the stash in progress (null = stats off)
function gatherWindow(tabs, settings, inDrain, now, includePinned, internalOnly, tgInfo, closeOwn) {
  const items = [];
  const records = [];
  const seen = new Map(); // url -> item index
  const tabGroups = []; // [{i, title, color, collapsed}] (windowIdx is added by planGroups)
  const tgLocal = new Map(); // chrome groupId -> local index
  // split view: panes of one split view in this scope (a pair is only saved as a pair when BOTH panes are saved)
  const svCount = new Map();
  for (const t of tabs) { const s = splitIdOf(t); if (s >= 0) svCount.set(s, (svCount.get(s) || 0) + 1); }
  if ((tgInfo && tgInfo.size && tabs.some((t) => t.groupId >= 0)) || svCount.size) tabs = tabs.slice().sort((a, b) => a.index - b.index);
  for (const t of tabs) {
    if (t.incognito || (t.pinned && !includePinned) || inDrain.has(t.id)) continue;
    if (isStashTab(t)) {
      // old copies of our own list page are closed too (a fresh one is opened first); pinned ones are never touched
      if (closeOwn && !t.pinned) records.push({ tab: t, url: t.pendingUrl || t.url || '', itemIdx: -1 });
      continue;
    }
    const u = t.pendingUrl || t.url || '';
    if (/^https?:/i.test(u) && ((settings.excludeSites && settings.excludeSites.length) || settings.exSet) && isExcluded(settings, hostOf(u))) continue; // excluded site: stays open
    const ia = internalAction(u, settings);
    if (internalOnly && ia === null) continue; // "clean all" never touches real content tabs
    if (ia === 'keep') continue;
    if (ia === 'close') { records.push({ tab: t, url: u, itemIdx: -1 }); continue; }
    if (ia === null) {
      const c = classifyUrl(u);
      if (c === 'keep') continue;
      if (c === 'drop') { records.push({ tab: t, url: u, itemIdx: -1 }); continue; }
    }
    if (u.length > MAX_URL) continue; // too big to save -> its tab stays open
    // documented exception: the two panes of a split view are never collapsed by dedupeOnStash (even with the same url they are two panes)
    const pane = svCount.get(splitIdOf(t)) === 2;
    let idx = settings.dedupeOnStash && !pane ? seen.get(u) : undefined;
    if (idx === undefined) {
      const item = { url: u, title: String(t.title || u).slice(0, MAX_TITLE), ts: now };
      const dd = act.itemD(t, now, FS && FS[t.id]); // idle / lifetime before this stash (undefined when stats are off)
      if (dd) item.d = dd;
      const info = tgInfo && t.groupId >= 0 ? tgInfo.get(t.groupId) : null;
      if (info) {
        let li = tgLocal.get(t.groupId);
        if (li === undefined) {
          li = tabGroups.length;
          tgLocal.set(t.groupId, li);
          tabGroups.push({ i: li, title: info.title, color: info.color, collapsed: info.collapsed });
        }
        item.tg = li;
      }
      items.push(item);
      idx = items.length - 1;
      if (settings.dedupeOnStash && !pane) seen.set(u, idx);
    }
    records.push({ tab: t, url: u, itemIdx: idx });
  }
  if (svCount.size) {
    // `sv` = window-local pair index, only for two neighbouring SAVED items that were the two panes of one split view
    const keys = new Array(items.length).fill(null);
    for (const r of records) if (r.itemIdx >= 0 && svCount.get(splitIdOf(r.tab)) === 2) keys[r.itemIdx] = splitIdOf(r.tab);
    pairIndexes(keys).forEach((p, i) => { if (p >= 0) items[i].sv = p; });
  }
  return { items, records, tabGroups };
}

/**
 * Opt-in auto categories (settings.autoRulesOn). One rule per line: "github.com=Work" (the session's main site ends with it) or
 * "contains:youtube=Later" (any saved url contains it). First match wins; unknown category names are ignored.
 */
async function applyAutoRules(plan, settings) {
  const rules = String(settings.autoRulesText || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.includes('=')).map((l) => {
    const i = l.lastIndexOf('=');
    let key = l.slice(0, i).trim().toLowerCase();
    let kind = 'site';
    if (key.startsWith('contains:')) { kind = 'contains'; key = key.slice(9); } else if (key.startsWith('site:')) key = key.slice(5);
    return { kind, key, cat: l.slice(i + 1).trim().toLowerCase() };
  }).filter((r) => r.key && r.cat);
  if (!rules.length) return;
  const cats = await db.listCategories();
  for (const p of plan) {
    const counts = new Map();
    for (const it of p.items) { const s = siteOfUrl(it.url); counts.set(s, (counts.get(s) || 0) + 1); }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    const mainSite = top ? top[0] : '';
    for (const r of rules) {
      const hit = r.kind === 'contains' ? p.items.some((it) => it.url.toLowerCase().includes(r.key)) : (mainSite === r.key || mainSite.endsWith('.' + r.key));
      if (!hit) continue;
      const c = cats.find((x) => x.name.trim().toLowerCase() === r.cat);
      if (c) { await db.updateGroup(p.gid, { cat: c.id }); break; }
    }
  }
}

/** Turns per-window gathers into the groups to write. 'session' merges every window into ONE group. */
function planGroups(perWindow, multi, grouping, settings) {
  if (multi && grouping === 'session') {
    const items = [];
    const recs = [];
    const seen = new Map();
    const tabGroups = [];
    for (const w of perWindow) {
      let first = true;
      const map = new Map(); // window-local item idx -> merged seq
      const tgMap = new Map(); // window-local tab-group index -> merged index (a tab group never spans windows)
      w.items.forEach((it, i) => {
        let seq = settings.dedupeOnStash && it.sv == null ? seen.get(it.url) : undefined; // split panes are never collapsed
        if (seq === undefined) {
          const merged = { ...it, w: w.no, ws: first };
          if (it.tg != null) {
            let mi = tgMap.get(it.tg);
            if (mi === undefined) {
              mi = tabGroups.length;
              tgMap.set(it.tg, mi);
              tabGroups.push({ ...w.tabGroups[it.tg], i: mi, windowIdx: w.no });
            }
            merged.tg = mi;
          }
          items.push(merged);
          first = false;
          seq = items.length;
          if (settings.dedupeOnStash && it.sv == null) seen.set(it.url, seq);
        }
        map.set(i, seq);
      });
      for (const r of w.records) recs.push({ tab: r.tab, url: r.url, seq: r.itemIdx < 0 ? 0 : map.get(r.itemIdx) });
    }
    return [{ items, windowCount: perWindow.length, title: '', recs, tabGroups }];
  }
  return perWindow.map((w) => ({
    items: w.items,
    windowCount: 1,
    tabGroups: w.tabGroups.map((x) => ({ ...x, windowIdx: 1 })),
    title: multi ? swS.windowTitle(w.no, w.items.length) : '', // default name uses the language at the time of saving
    recs: w.records.map((r) => ({ tab: r.tab, url: r.url, seq: r.itemIdx < 0 ? 0 : r.itemIdx + 1 })),
  }));
}

/**
 * Must be called while holding runExclusive.
 * scopes: [{windowId, tabs}] - one entry for a single window, several for "all windows".
 * grouping ('window' | 'session') only matters with 2+ scopes. focusWindowId is the only window that gets (and
 * keeps) the stash page tab; other windows may close when emptied.
 */
async function stashInner(scopes, source, focusWindowId, grouping = 'window', opts = {}) {
  swS = await swStr();
  const health = await db.dbHealth();
  if (!health.ok) {
    await setErrorBadge('ERR');
    post({ type: 'dberror', error: health.error });
    return { stashed: 0, error: 'db-unavailable' };
  }
  const settings = await getSettings();
  act.setFrom(settings);
  // the state of ALL tabs right before anything is closed (crash recovery / a safety net for the stash itself)
  if (source !== 'auto' && settings.autoSnapshot !== false) { try { await runSnapshot({ kind: 'pre-close', force: true, inQueue: true }); } catch { /* never blocks a stash */ } }

  FS = act.A.on ? await firstseen.load().catch(() => null) : null; // after the pre-close snapshot above refreshed it
  // B1: gather (url/title come from the tab objects, no page has to load).
  const inDrain = await db.drainAllTabIds();
  const now = Date.now();
  const multi = scopes.length > 1;
  const perWindow = [];
  const dropOnly = [];
  let no = 0;
  const tgInfo = await loadTabGroupInfo(scopes, settings);
  const closeOwn = !!settings.closeOwnPages && source !== 'auto' && !opts.internalOnly;
  for (const sc of scopes) {
    const g = gatherWindow(sc.tabs, settings, inDrain, now, opts.includePinned == null ? !!settings.includePinned : !!opts.includePinned, !!opts.internalOnly, tgInfo, closeOwn);
    if (g.items.length) perWindow.push({ ...g, windowId: sc.windowId, no: ++no });
    else for (const r of g.records) dropOnly.push(r.tab.id);
  }
  if (!perWindow.length) {
    // data-less internal pages only ("clean all"): nothing to save, so just close them gently
    if (opts.internalOnly && dropOnly.length) return { stashed: 0, tabs: 0, closed: await closeTabsGently(dropOnly) };
    if (source !== 'auto' && !opts.internalOnly) { try { await ensureStashTab(focusWindowId); } catch { /* ignore */ } }
    return { stashed: 0 };
  }

  // B0: the stash page first (cheap) so the focused window can never end up empty. Nothing was closed yet.
  if (source !== 'auto') {
    try {
      // closeOwnPages: open a FRESH list page first (so the window can never end up empty, and the drain panel has a home),
      // the old list pages are in the drain and get closed with everything else.
      if (closeOwn) await freshStashTab(focusWindowId); else await ensureStashTab(focusWindowId);
    } catch {
      try { await ensureStashTab(focusWindowId); } catch {
        await setErrorBadge();
        return { stashed: 0, error: 'stash-page' };
      }
    }
  }
  const plan = planGroups(perWindow, multi, grouping, settings);
  const totalItems = plan.reduce((a, p) => a + p.items.length, 0);

  // B2: save EVERYTHING first (chunked), verify every group, only then create the drain records.
  const job = id();
  const gids = [];
  const allRecs = [];
  try {
    let done = 0;
    for (const p of plan) {
      const gid = id();
      gids.push(gid);
      p.gid = gid;
      await db.createGroup({ id: gid, createdAt: now, source, title: p.title, windowCount: p.windowCount, tabGroups: p.tabGroups });
      p.journals = [];
      for (let i = 0; i < p.items.length; i += APPEND_CHUNK) {
        const ar = await db.appendItems(gid, p.items.slice(i, i + APPEND_CHUNK));
        if (ar && ar.journal) p.journals.push(ar.journal); // password lock on: the read-back check compares count + digest of the ciphertext
        done += Math.min(APPEND_CHUNK, p.items.length - i);
        await writeProgress(done, totalItems);
      }
    }
    for (const p of plan) {
      const ok = await db.verifyGroup(p.gid, p.items.length, {
        firstUrl: p.items[0].url, lastUrl: p.items[p.items.length - 1].url, journals: p.journals,
      });
      if (!ok) throw new Error('verify mismatch');
    }
    if (settings.autoRulesOn) { try { await applyAutoRules(plan, settings); } catch { /* cosmetic */ } }
    const focused = await focusedWindowId();
    for (const p of plan) {
      for (const r of p.recs) {
        allRecs.push({
          tabId: r.tab.id, job, gid: p.gid, seq: r.seq, url: dk(r.url), windowId: r.tab.windowId,
          lastAccessed: r.tab.lastAccessed || 0, discardedAtStart: !!r.tab.discarded, state: 'queued', reason: '',
          attempts: 0, prio: prioOf(r.tab, focused),
        });
      }
    }
    // drain records are inert until beginDrain references the job
    for (let i = 0; i < allRecs.length; i += APPEND_CHUNK) await db.createDrain(allRecs.slice(i, i + APPEND_CHUNK));
    const availBefore = act.A.on ? await act.availNow() : 0;
    await db.beginDrain({ job, gids, total: allRecs.length }, focusWindowId, await currentSession());
    if (act.A.on) {
      const all = plan.flatMap((p) => p.items);
      act.bump('stash', { n: allRecs.length, sessions: plan.length, gid: gids[0], ram: true, ...act.stashStats(all) }).catch(() => {});
      act.calibrate(allRecs.length, availBefore).catch(() => {});
    }
  } catch (e) {
    // nothing was closed: remove the partial groups + inert records and report
    for (const gid of gids) { try { await db.purgeGroup(gid, { force: true }); } catch { /* ignore */ } }
    try { await db.drainApply({ del: allRecs.map((r) => r.tabId).filter(Boolean) }); } catch { /* ignore */ }
    await setErrorBadge();
    post({ type: 'dberror', error: (e && e.name) || String(e && e.message) });
    return { stashed: 0, error: 'write-failed' };
  }

  // B3: the stash page is already active in the focused window. Start draining (outside this queue slot).
  Promise.resolve().then(() => runDrain()).catch(() => {});
  scheduleBadge();
  return { stashed: totalItems, tabs: allRecs.length, group: gids[0], groups: gids, windows: perWindow.length };
}

function select(tabs, how) {
  const active = tabs.find((t) => t.active);
  switch (how) {
    case 'all': return tabs;
    case 'tab': return active ? [active] : [];
    case 'others': return tabs.filter((t) => !t.active);
    case 'right': return active ? tabs.filter((t) => t.index > active.index) : [];
    default: return [];
  }
}

/** how: "all" | "tab" | "others" | "right". Tabs are queried inside the queue so double clicks see fresh state. */
export function stashWindow(windowId, source, how, opts = {}) {
  return runExclusive(async () => {
    const tabs = await chrome.tabs.query({ windowId });
    return stashInner([{ windowId, tabs: select(tabs, how) }], source, windowId, 'window', opts);
  });
}

/**
 * Every normal, non-incognito window in ONE action: a single save phase and ONE drain job.
 * grouping: 'window' | 'session' (default: the stashGrouping setting). focusWindowId keeps the stash page.
 */
export function stashAllWindows(focusWindowId, grouping, source = 'allwin', opts = {}) {
  return runExclusive(async () => {
    const settings = await getSettings();
    const g = grouping || settings.stashGrouping || 'window';
    const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
    if (!wins.length) return { stashed: 0 };
    let focus = focusWindowId;
    if (!wins.some((w) => w.id === focus)) focus = (wins.find((w) => w.focused) || wins[0]).id;
    const scopes = [];
    for (const w of wins) scopes.push({ windowId: w.id, tabs: await chrome.tabs.query({ windowId: w.id }) });
    return stashInner(scopes, source, focus, g, opts);
  });
}

/** "Clean all": save/close ONLY the internal pages configured in settings (never real content tabs). */
export function stashInternalPages(focusWindowId) {
  return runExclusive(async () => {
    const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !w.incognito);
    if (!wins.length) return { stashed: 0 };
    let focus = focusWindowId;
    if (!wins.some((w) => w.id === focus)) focus = (wins.find((w) => w.focused) || wins[0]).id;
    const scopes = [];
    for (const w of wins) scopes.push({ windowId: w.id, tabs: await chrome.tabs.query({ windowId: w.id }) });
    return stashInner(scopes, 'clean', focus, 'session', { internalOnly: true, includePinned: false });
  });
}

/** autoStashDays: stash long-untouched background tabs, one group per window. Never creates/focuses a stash page. */
export async function autoStashOld() {
  const settings = await getSettings();
  if (!(settings.autoStashDays > 0)) return;
  const thresholdMin = settings.autoStashDays * 1440;
  const audible = await getAudibleMap();
  const overrides = await getOverrideMap();
  const now = Date.now();
  const tabs = await chrome.tabs.query({ active: false, pinned: false, audible: false });
  const byWin = new Map();
  let cands = tabs.filter((t) => !t.incognito && !isStashTab(t) && !skipReason(t, settings, now, thresholdMin, audible, overrides));
  if (cands.some((t) => splitIdOf(t) >= 0)) {
    // a split pane only goes together with its partner, and never while the partner is in use
    try { cands = splitGuard(cands, await chrome.tabs.query({})).ok; } catch { cands = cands.filter((t) => splitIdOf(t) < 0); }
  }
  for (const t of cands) {
    if (!byWin.has(t.windowId)) byWin.set(t.windowId, []);
    byWin.get(t.windowId).push(t);
  }
  for (const [windowId, list] of byWin) {
    await runExclusive(async () => {
      const fresh = [];
      for (const t of list) {
        try {
          const ft = await chrome.tabs.get(t.id);
          if (!ft.active && !ft.pinned && !ft.audible && !skipReason(ft, settings, Date.now(), thresholdMin, audible, overrides) && !(await partnerBusy(ft))) fresh.push(ft);
        } catch { /* tab gone */ }
      }
      if (fresh.length) await stashInner([{ windowId, tabs: fresh }], 'auto', windowId, 'window');
    });
  }
}

/** Test helper (dev builds only): the save+verify half of a stash with fabricated tabs; closes nothing. */
export async function debugStashFake(n) {
  return runExclusive(async () => {
    const t0 = Date.now();
    const gid = id();
    const items = Array.from({ length: n }, (_, i) => ({ url: `https://example.test/fake/${i}?q=${Math.random().toString(36).slice(2, 8)}`, title: `Fake tab ${i}`, ts: Date.now() }));
    await db.createGroup({ id: gid, source: 'debug' });
    for (let i = 0; i < items.length; i += APPEND_CHUNK) await db.appendItems(gid, items.slice(i, i + APPEND_CHUNK));
    const ok = await db.verifyGroup(gid, n, { firstUrl: items[0].url, lastUrl: items[n - 1].url });
    await db.setPhase(gid, 'committed');
    return { ok, ms: Date.now() - t0, gid };
  });
}
