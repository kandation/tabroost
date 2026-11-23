// Service worker entry: listeners + routing only. All listeners are registered synchronously at top level.
// The worker is the ONLY writer of the database; every mutation goes through runExclusive (lib/queue.js).

import { KEYS, ALARMS, STR_SW, STASH_PAGE, APPEND_CHUNK, TRASH_DAYS, PURGE_CHUNK } from './lib/constants.js';
import { hostOf, normItem } from './lib/formats.js';
import { debugDisableSplit, canSplit } from './lib/splitview.js';
import * as db from './lib/db.js';
import { runExclusive } from './lib/queue.js';
import { post } from './lib/bus.js';
import * as settingsLib from './lib/settings.js';
import { stashWindow, stashAllWindows, autoStashOld, debugStashFake, stashInternalPages } from './lib/stash.js';
import * as clean from './lib/clean.js';
import {
  isRestoring, openTrashRecords, startRestore, restoreItemKeys, restoreSplitPair, restoreTabGroup, runAuto, stopRestore, continueRestore, markInterrupted, undoLastStash,
} from './lib/restore.js';
import * as drain from './lib/drain.js';
import * as snapshot from './lib/snapshot.js';
import { startRefresh, cancelRefresh, resumeRefresh } from './lib/refresh.js';
import { sweep, ensureAlarms, scheduleBadge, flashBadge, setErrorBadge, getOverrideMap, setOverride, protectedTabs, runProbe } from './lib/suspend.js';
import * as vault from './lib/vault.js';
import { installBookmarkListeners } from './lib/sync/transport-bookmarks.js';
import { has as hasPerm, hasHost, namesIn, bookmarksApi, sessionsApi } from './lib/perms.js';
import { createSyncController } from './lib/synccontrol.js';
import { migrate } from './lib/migrate.js';
import * as act from './lib/activity.js';
import * as firstseen from './lib/firstseen.js';
import { dayKey, weekKey } from './lib/time.js';
import { setMemStub } from './lib/mem.js';
import * as lockctl from './lib/lockctl.js';
import * as lockarchimp from './lib/lockarchimp.js';
import * as lockrt from './lib/lockrt.js';

const stashUrl = () => chrome.runtime.getURL(STASH_PAGE);
const isDev = () => !('update_url' in chrome.runtime.getManifest()); // unpacked installs only

db.setWriter(true);
// ---------- password lock (lib/lockctl.js): off unless the user turned it on in the settings ----------
const LOCKED_OK = new Set(['ping', 'openList', 'stashNow', 'snapNow', 'snapCheck', 'snapDismiss', 'stats', 'ram:info', 'act:stats', 'saveSettings', 'drain:pause', 'drain:resume', 'drain:stop', 'drain:continueAfterRestart', 'recentlyClosed']);
lockctl.bind({
  onLock: () => { try { createMenus(); } catch { /* ignore */ } scheduleBadge(); syncCtl.onLockChange().catch(() => {}); }, // sync stands still while locked
  onUnlock: () => { scheduleBadge(); syncCtl.onLockChange().catch(() => {}); }, // ... and resumes from its saved state (also after the lock was removed)
  extrasDone: (kind) => (kind === 'migrate' ? syncCtl.sealAtRest() : syncCtl.unsealAtRest()), // sync state is sealed under the lock key / released before it goes
  onSealed: () => { syncCtl.flushLocal().catch(() => {}); }, // groups stashed while locked are scanned for sync once they are sealed
});
// ---------- cross-device sync (lib/synccontrol.js) ----------
// The bookmark listeners MUST be registered synchronously at the top level (an event wakes a sleeping worker); events are queued
// inside the controller until its init() finished.
let syncBc = null;
// bookmarks is an OPTIONAL permission: chrome.bookmarks may be undefined, and may appear / vanish while the worker lives.
let permBm = !!bookmarksApi();
let bmListening = false;
const bmApi = () => (permBm ? bookmarksApi() : null);
function attachBookmarkListeners() {
  const a = bookmarksApi();
  if (bmListening || !a) return;
  installBookmarkListeners(a, (raw) => syncCtl.raw(raw));
  bmListening = true;
}
async function refreshBmPerm() { permBm = await hasPerm('bookmarks'); if (permBm) attachBookmarkListeners(); return permBm; }
const syncCtl = createSyncController({
  bookmarks: bmApi,
  ensure: refreshBmPerm,
  // no remote apply while a drain or a restore runs (RAM is what matters then)
  canApply: () => !drain.isRunning() && !isRestoring() && !lockrt.isLocked(),
  onStatus: (st) => { try { if (!syncBc) syncBc = new BroadcastChannel('cmr-sync'); syncBc.postMessage(st); } catch { /* ignore */ } },
  scheduleAlarm: (ms) => { chrome.alarms.create(ALARMS.SYNC_RETRY, { delayInMinutes: Math.max(1, Math.ceil(ms / 60000)) }).catch(() => {}); },
});
attachBookmarkListeners(); // top level, synchronous: only when the permission is already granted
chrome.permissions.onAdded.addListener((p) => { onPermChange(p, true); });
chrome.permissions.onRemoved.addListener((p) => { onPermChange(p, false); });
async function onPermChange(p, added) {
  try {
    const names = namesIn(p);
    if (names.includes('bookmarks')) {
      if (!added) { permBm = false; bmListening = false; } else await refreshBmPerm();
      await ready;
      await syncCtl.permChanged(); // paused cleanly when removed (local data untouched), reattached when granted
    }
    if (names.includes('host')) scheduleBadge();
  } catch { /* ignore */ }
}

let purgeFlushQueued = false;
let syncKickQueued = false;
// local writes -> sync ops: a debounced scan of the groups marked in meta.syncDirty (same transaction as the change)
function syncKick() {
  if (syncKickQueued || lockrt.isLocked()) return;
  syncKickQueued = true;
  setTimeout(() => { syncKickQueued = false; syncCtl.flushLocal().catch(() => {}); }, 1500); // not inside the writer queue: it is many small transactions
}
db.setOnWrite(() => {
  lockctl.aggSoon();
  if (syncCtl.status() && syncCtl.status().enabled) syncKick();
  if (!purgeFlushQueued && db.hasPurged()) { // purged groups lose their vault copy right away (queued behind the current writer task)
    purgeFlushQueued = true;
    Promise.resolve().then(() => runExclusive(async () => {
      purgeFlushQueued = false;
      if (await vault.flushPurged()) {
        const m = await db.getMeta();
        if (m.vaultMissing > 0) await db.setMeta({ vaultMissing: (await vault.missingFromDb()).length }); // a stale banner clears itself
      }
    })).catch(() => { purgeFlushQueued = false; });
  }
  chrome.alarms.get(ALARMS.VAULT_SOON).then((a) => {
    if (!a) chrome.alarms.create(ALARMS.VAULT_SOON, { delayInMinutes: 1 });
  }).catch(() => {});
});

// ---------- toolbar icon: stash immediately, or open the popup ----------
async function applyIconAction() {
  try {
    const s = await settingsLib.getSettings();
    await chrome.action.setPopup({ popup: s.iconClickAction === 'popup' ? 'popup.html' : '' });
  } catch { /* ignore */ }
}

/** The configured "stash now" (icon click in stash mode, Alt+Shift+S): scope + grouping from settings. */
async function stashNow(windowId) {
  const s = await settingsLib.getSettings();
  if (s.iconScope === 'all') return stashAllWindows(windowId, s.stashGrouping, 'click');
  return stashWindow(windowId, 'click', 'all');
}

// ---------- helpers ----------
async function pickWindowId(windowId) {
  if (windowId != null) {
    try {
      const w = await chrome.windows.get(windowId);
      if (w.type === 'normal' && !w.incognito) return w.id;
    } catch { /* gone */ }
  }
  const ws = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const w = ws.find((x) => x.focused && !x.incognito) || ws.find((x) => !x.incognito);
  return w ? w.id : null;
}

async function openList(windowId, query = '') {
  const wid = await pickWindowId(windowId);
  if (wid == null) {
    await chrome.windows.create({ url: stashUrl() + query, focused: true });
    return;
  }
  const tabs = await chrome.tabs.query({ windowId: wid });
  const ex = tabs.find((t) => (t.url || t.pendingUrl || '').startsWith(stashUrl()));
  if (ex) await chrome.tabs.update(ex.id, { active: true });
  else await chrome.tabs.create({ windowId: wid, url: stashUrl() + query, active: true });
  await chrome.windows.update(wid, { focused: true });
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    const items = [
      ['open-list', STR_SW.menuOpen],
      ['stash-tab', STR_SW.menuTab],
      ['stash-others', STR_SW.menuOthers],
      ['stash-right', STR_SW.menuRight],
      ['stash-allwin', STR_SW.menuAll],
      ['whitelist-toggle', STR_SW.menuWhitelist],
    ];
    for (const [id, title] of items) chrome.contextMenus.create({ id, title, contexts: ['action'] });
    // per-tab media-aware override (right-click on a page): session-only, see lib/suspend.js
    chrome.contextMenus.create({ id: 'keep-tab', title: STR_SW.menuKeepTab, contexts: ['page'] });
    chrome.contextMenus.create({ id: 'suspend-now', title: STR_SW.menuSuspendNow, contexts: ['page'] });
  });
}

async function currentWindowId() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return w.incognito ? null : w.id;
  } catch {
    return null;
  }
}

async function run(kind, tab) {
  const windowId = tab && tab.windowId != null ? tab.windowId : await currentWindowId();
  if (windowId == null) return;
  if (tab && tab.incognito) { await flashBadge('–'); return; }
  switch (kind) {
    case 'stash-tab': await stashWindow(windowId, 'tab', 'tab'); break;
    case 'stash-others': await stashWindow(windowId, 'others', 'others'); break;
    case 'stash-right': await stashWindow(windowId, 'right', 'right'); break;
    case 'stash-allwin': await stashAllWindows(windowId); break;
    default: break;
  }
}

// ---------- vault ----------
async function runVault() {
  const m = await db.getMeta();
  if (!(m.vaultDirty || []).length) return;
  let hold = false; // true while a drain runs below "healthy": the vault sync waits
  const checkHold = async () => {
    const mm = await db.getMeta();
    hold = !!(mm.drain && mm.drain.level && mm.drain.level !== 'healthy');
  };
  await checkHold();
  if (hold) { chrome.alarms.create(ALARMS.VAULT_SOON, { delayInMinutes: 2 }).catch(() => {}); return; }
  await vault.syncDirty({
    step: async (fn) => { await runExclusive(fn); await checkHold(); },
    shouldStop: () => hold,
  });
  if (hold) chrome.alarms.create(ALARMS.VAULT_SOON, { delayInMinutes: 2 }).catch(() => {});
}

// ---------- trash retention (per type; chunks <= PURGE_CHUNK per transaction; resumable) ----------
async function purgeClockNow() {
  if (!isDev()) return Date.now();
  try { return Date.now() + (((await chrome.storage.local.get('debugClock')).debugClock) || 0) * 86400000; } catch { return Date.now(); } // dev-only clock override
}
let purging = false;
async function runPurge() {
  if (purging) return;
  purging = true;
  try {
    const st = await settingsLib.getSettings();
    await db.purgeAll({ now: await purgeClockNow(), days: { deleted: st.trashDaysDeleted, opened: st.trashDaysOpened } }, (fn) => runExclusive(fn));
  } finally { purging = false; }
}

async function dailyMaintenance() {
  await runExclusive(async () => {
    const st = await settingsLib.getSettings();
    await db.integrityCheck();
    const missing = await vault.missingFromDb();
    await db.setMeta({ vaultMissing: missing.length });
  });
  await act.prune().catch(() => {});
  await runVault();
}

// ---------- crash-recovery snapshots: ONE alarm, no tab listeners ----------
async function applySnapshotAlarm() {
  try {
    const s = await settingsLib.getSettings();
    if (s.autoSnapshot) await chrome.alarms.create(ALARMS.SNAPSHOT, { periodInMinutes: s.snapshotMinutes || 3 });
    else await chrome.alarms.clear(ALARMS.SNAPSHOT);
  } catch { /* ignore */ }
}

async function snapBanner() {
  const b = await snapshot.checkMissing();
  await chrome.storage.local.set({ [KEYS.SNAP_BANNER]: b || null });
  post({ type: 'snapbanner', banner: b || null });
  return b;
}

// ---------- one-time background backfill of the per-site index (resumable: a processed group has `agg`) ----------
let backfilling = false;
async function runBackfill() {
  if (backfilling) return;
  backfilling = true;
  try {
    let last = 0;
    for (;;) {
      const m = await db.getMeta();
      if (m.drain && m.drain.level && m.drain.level !== 'healthy') { await new Promise((r) => setTimeout(r, 3000)); continue; } // never compete with a slow drain
      const r = await runExclusive(() => db.backfillStep());
      const now = Date.now();
      if (r.done || now - last > 400) { last = now; post({ type: 'migr', remaining: r.remaining, total: r.total }); }
      if (r.done) break;
      await new Promise((res) => setTimeout(res, 4));
    }
    for (;;) { // items written before DB v6: fill the sort keys of the flat view's sparse indexes
      const t = await runExclusive(() => db.backfillTkStep());
      if (t.done) break;
      await new Promise((res) => setTimeout(res, 8));
    }
  } catch { /* retried at the next start */ } finally {
    backfilling = false;
  }
}

// ---------- boot ----------
async function fullInit() {
  const h = await db.dbHealth();
  if (!h.ok) {
    await setErrorBadge('ERR');
    post({ type: 'dberror', error: h.error });
    return false;
  }
  await settingsLib.ensureInstallSettings();
  await migrate({ step: runExclusive });
  await runExclusive(async () => {
    await db.recoverPending();
    await db.integrityCheck();
    const missing = await vault.missingFromDb();
    await db.setMeta({ vaultMissing: missing.length }); // (every write also makes sure meta.dbId exists)
  });
  return true;
}

async function boot() {
  try { await lockctl.init(); } catch { /* lock state unknown: treated as locked by every reader */ }
  const s = await chrome.storage.session.get(KEYS.S_BOOTED);
  if (!s[KEYS.S_BOOTED]) {
    const ok = await fullInit();
    if (!ok) return;
    await chrome.storage.session.set({ [KEYS.S_BOOTED]: true });
    runPurge().catch(() => {}); // once per browser session (the PURGE alarm repeats it every 6 h)
  }
  const h = await db.dbHealth();
  if (!h.ok) return;
  await drain.currentSession();
  await markInterrupted();
  await drain.resumeDrain();
  await resumeRefresh();
  scheduleBadge();
  runBackfill();
}

const ready = boot().then(() => act.ensure()).then(() => { applyPreciseListener(); act.resumePurge(ex).catch(() => {}); }).then(() => syncCtl.init().catch(() => {})).then(applyIconAction).then(() => clean.applyDupAlarm()).then(() => applySnapshotAlarm()).catch(() => {});
ensureAlarms(false).catch(() => {});

// ---------- precise open time: the onCreated listener exists only while the mode is ON ----------
// registered synchronously here (MV3 needs top-level registration to wake the worker), removed after init when OFF
function onTabCreated(tab) { firstseen.noteCreated(tab); }
chrome.tabs.onCreated.addListener(onTabCreated);
function applyPreciseListener() {
  const want = act.A.on && act.A.precise;
  if (want) { if (!chrome.tabs.onCreated.hasListener(onTabCreated)) chrome.tabs.onCreated.addListener(onTabCreated); }
  else { chrome.tabs.onCreated.removeListener(onTabCreated); firstseen.dropBuffer(); }
}

// ---------- lifecycle ----------
chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  applyIconAction();
  ensureAlarms(true).catch(() => {});
  if (details.reason === 'install') chrome.tabs.create({ url: stashUrl() + '?welcome=1' }).catch(() => {});
  scheduleBadge();
});

chrome.runtime.onStartup.addListener(() => {
  applyIconAction();
  ensureAlarms(false).catch(() => {});
  chrome.alarms.create(ALARMS.STARTUP, { delayInMinutes: 1 }).catch(() => {});
  chrome.alarms.create(ALARMS.SNAPCHECK, { delayInMinutes: 0.75 }).catch(() => {}); // after Chrome's own session restore had its chance
});

// ---------- user entry points ----------
// only fires while no popup is set (setting iconClickAction = 'stash')
function onIconClick(tab) {
  if (tab.incognito) { flashBadge('–'); return Promise.resolve(); }
  return ready.then(() => stashNow(tab.windowId)).catch(() => {});
}
chrome.action.onClicked.addListener((tab) => { onIconClick(tab); });

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    await ready;
    if (cmd === 'open-list') {
      await openList(await currentWindowId());
    } else if (cmd === 'stash-tab') {
      const wid = await currentWindowId();
      if (wid != null) await stashWindow(wid, 'tab', 'tab');
    } else if (cmd === 'stash-now') {
      const wid = await currentWindowId();
      if (wid != null) await stashNow(wid);
    } else if (cmd === 'stash-all') {
      const wid = await currentWindowId();
      if (wid != null) await stashAllWindows(wid);
    }
  } catch { /* ignore */ }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await ready;
    const id = info.menuItemId;
    if (id === 'open-list') await openList(tab ? tab.windowId : await currentWindowId());
    else if (id === 'keep-tab') {
      if (tab && tab.id != null) { const ov = await getOverrideMap(); await setOverride(tab.id, ov[tab.id] === 'keep' ? null : 'keep'); await flashBadge(ov[tab.id] === 'keep' ? '×' : '✓', 1500); }
    } else if (id === 'suspend-now') {
      if (tab && tab.id != null) {
        if (!(await hasHost())) { await flashBadge('!', 2500); return; } // cannot check the page for typed text / playing media: do not sleep it
        await setOverride(tab.id, 'now');
        if (!tab.active) { try { const d = await chrome.tabs.discard(tab.id); await setOverride(tab.id, null); if (d) { act.bump('discard', { n: 1 }).catch(() => {}); firstseen.markFrozen(tab.id).catch(() => {}); } } catch { /* sweep retries */ } } else await flashBadge('…', 1500); // the tab in use is suspended by the next sweep once you leave it
      }
    } else if (id === 'whitelist-toggle') {
      const host = tab && tab.url ? hostOf(tab.url) : '';
      if (!host || !/^https?:/i.test(tab.url)) { await flashBadge('–'); return; }
      const r = await settingsLib.toggleWhitelist(host);
      await flashBadge(r.whitelisted ? '✓' : '×', 1500);
    } else await run(id, tab);
  } catch { /* ignore */ }
});

// ---------- alarms ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    await ready;
    if (alarm.name === ALARMS.SWEEP) await sweep();
    else if (alarm.name === ALARMS.DAILY) {
      await dailyMaintenance();
      await autoStashOld();
    } else if (alarm.name === ALARMS.STARTUP) {
      const s = await settingsLib.getSettings();
      if (s.startupDiscard) await sweep(0);
    } else if (alarm.name === ALARMS.VAULT || alarm.name === ALARMS.VAULT_SOON) await runVault();
    else if (alarm.name === ALARMS.PURGE) await runPurge();
    else if (alarm.name === ALARMS.DRAIN) await drain.resumeDrain();
    else if (alarm.name === ALARMS.SNAPSHOT) await snapshot.runSnapshot({ kind: 'auto' });
    else if (alarm.name === ALARMS.SNAPCHECK) await snapBanner();
    else if (alarm.name === ALARMS.DUP) await clean.closeDuplicatesNow();
    else if (alarm.name === ALARMS.SYNC_CHECK || alarm.name === ALARMS.SYNC_RETRY) { if (!lockrt.isLocked()) await syncCtl.tick(); }
    else if (alarm.name === ALARMS.LOCK) await lockctl.onAlarm();
  } catch { /* ignore */ }
});

// ---------- tab tracking ----------
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible === undefined) return;
  runExclusive(async () => {
    const cur = (await chrome.storage.session.get(KEYS.S_AUDIBLE))[KEYS.S_AUDIBLE] || {};
    cur[tabId] = Date.now();
    await chrome.storage.session.set({ [KEYS.S_AUDIBLE]: cur });
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.discarded !== undefined) scheduleBadge();
});

chrome.tabs.onReplaced.addListener((added, removed) => drain.noteReplaced(added, removed));

chrome.tabs.onRemoved.addListener((tabId) => {
  if (lockrt.enabled()) chrome.tabs.query({ url: stashUrl() }).then((l) => lockctl.onPageClosed(l.length)).catch(() => {});
  runExclusive(async () => {
    const cur = (await chrome.storage.session.get(KEYS.S_AUDIBLE))[KEYS.S_AUDIBLE] || {};
    if (tabId in cur) {
      delete cur[tabId];
      await chrome.storage.session.set({ [KEYS.S_AUDIBLE]: cur });
    }
    await setOverride(tabId, null).catch(() => {});
  }).catch(() => {});
  scheduleBadge();
});

// OS screen lock (optional permission-free: `idle` is a required permission without an install warning)
if (chrome.idle && chrome.idle.onStateChanged) chrome.idle.onStateChanged.addListener((s) => { if (s === 'locked') lockctl.onOsLock().catch(() => {}); });

// ---------- messages from stash.html ----------
const ex = (fn) => runExclusive(fn);
const strs = (a) => (Array.isArray(a) ? a.map(String) : []);
const nums = (a) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n)) : []);
const boolOrUndef = (v) => (typeof v === 'boolean' ? v : undefined);

async function handleDebug(msg) {
  switch (msg.type) {
    case 'debug:seed': {
      const t0 = Date.now();
      let n = 0;
      const { groups = 1, perGroup = 1000, spreadDays = 0, offset = 0, tgSize = 0 } = msg;
      for (let g = 0; g < groups; g++) {
        await ex(async () => {
          const tgList = tgSize > 0 ? Array.from({ length: Math.ceil(perGroup / (tgSize * 2)) }, (_, k) => ({ i: k, title: `TG ${k}`, color: ['blue', 'red', 'green', 'orange'][k % 4], collapsed: false, windowIdx: 1 })) : undefined;
          const grp = await db.createGroup({ source: 'debug', tabGroups: tgList, title: `seed ${offset + g}`, createdAt: Date.now() - Math.floor(((offset + g) * spreadDays * 86400000) / Math.max(1, msg.totalGroups || groups)) });
          for (let i = 0; i < perGroup; i += APPEND_CHUNK) {
            const items = [];
            for (let j = i; j < Math.min(perGroup, i + APPEND_CHUNK); j++) {
              const it = { url: `https://example.test/g${g}/i${j}?q=word${Math.floor(Math.random() * 1e6)}`, title: `Seed ${g}-${j} lorem ipsum ${j % 97}` };
              if (tgSize > 0 && j % (tgSize * 2) < tgSize) it.tg = Math.floor(j / (tgSize * 2)); // tgSize tabs in a tab group, then tgSize ungrouped
              items.push(it);
            }
            await db.appendItems(grp.id, items);
            n += items.length;
          }
          await db.setPhase(grp.id, 'committed');
        });
      }
      return { items: n, ms: Date.now() - t0 };
    }
    // DEV only: realistic seed. Hosts follow a Zipf law over `hosts` names h<k>.localhost:8766 (a local server gives the first
    // ones real favicons). Sessions have 1..maxPer tabs, mixed Thai/English titles, 20% own tab groups, dates spread over days.
    case 'debug:seedHosts': {
      const t0 = Date.now();
      const { groups = 100, itemsTotal = 10000, hosts = 2000, maxPer = 4000, spreadDays = 120, port = 8766, offset = 0 } = msg;
      const th = ['ข่าว', 'บทความ', 'ซื้อของ', 'วิธีทำ', 'รีวิว', 'สอนใช้งาน', 'ราคา', 'โปรแกรม', 'เรียนออนไลน์', 'หนังสือ'];
      const en = ['Dashboard', 'Pull request', 'Documentation', 'Video', 'Inbox', 'Search results', 'Article', 'Settings', 'Issue', 'Notebook'];
      const w = new Float64Array(hosts);
      let sum = 0;
      for (let k = 0; k < hosts; k++) { w[k] = 1 / Math.pow(k + 1, 1.1); sum += w[k]; }
      const cum = new Float64Array(hosts);
      let acc = 0;
      for (let k = 0; k < hosts; k++) { acc += w[k] / sum; cum[k] = acc; }
      const pick = () => { const r = Math.random(); let lo = 0; let hi = hosts - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; } return lo; };
      const avg = Math.max(1, Math.round(itemsTotal / groups));
      let n = 0;
      for (let g = 0; g < groups; g++) {
        const per = Math.max(1, Math.min(maxPer, Math.round(avg * (0.2 + Math.random() * 1.6))));
        const withTg = Math.random() < 0.2;
        await ex(async () => {
          const tgList = withTg ? Array.from({ length: Math.max(1, Math.ceil(per / 12)) }, (_, k) => ({ i: k, title: k % 3 ? `กลุ่ม ${k}` : '', color: ['blue', 'red', 'green', 'orange', 'purple'][k % 5], collapsed: false, windowIdx: 1 })) : undefined;
          const created = Date.now() - Math.floor(((offset + g) / groups) * spreadDays * 86400000) - Math.floor(Math.random() * 3600000);
          const grp = await db.createGroup({ source: 'debug', tabGroups: tgList, title: Math.random() < 0.3 ? `${th[g % th.length]} ${g}` : '', createdAt: created, windowCount: 1 });
          for (let i = 0; i < per; i += APPEND_CHUNK) {
            const items = [];
            for (let j = i; j < Math.min(per, i + APPEND_CHUNK); j++) {
              const h = pick();
              const title = (Math.random() < 0.4 ? th : en)[j % 10] + ' ' + (j * 7 + g) % 1000 + (Math.random() < 0.3 ? ' — ' + en[(j + g) % 10] : '');
              const it = { url: `http://h${h}.localhost:${port}/p/${g}-${j}?q=${Math.floor(Math.random() * 1e6)}`, title, ts: created + ((j * 7919 + g * 104729) % 86400000) };
              if (withTg && j % 12 < 8) it.tg = Math.floor(j / 12);
              items.push(it);
            }
            await db.appendItems(grp.id, items);
            n += items.length;
          }
          await db.setPhase(grp.id, 'committed');
        });
      }
      return { items: n, ms: Date.now() - t0 };
    }
    case 'debug:stripSite': return ex(() => db.debugStripSite());
    case 'debug:siteCheck': return db.siteIdxCheck({ deep: !!msg.deep });
    case 'debug:backfillTimed': { const t0 = performance.now(); let steps = 0; for (;;) { const r = await ex(() => db.backfillStep()); steps++; if (r.done) break; if (msg.sleep) await new Promise((rs) => setTimeout(rs, msg.sleep)); } return { ms: Math.round(performance.now() - t0), steps }; }
    case 'debug:backdateTrash': return ex(async () => { await db.debugBackdateTrash(msg.days || 40, msg.only || null); return {}; });
    case 'debug:purge': return ex(async () => { await db.purgeExpired(msg.days); return {}; });
    // DEV only: synthetic usage history (n days back, weeks, events) for the retention / size / cap tests; and direct prune / bump / tick
    case 'debug:actInject': {
      const { days = 1095, weeks = 157, events = 400, hosts = 50 } = msg;
      const now = Date.now();
      const rows = [];
      for (let i = 0; i < days; i++) { const k = 'd:' + dayKey(now - i * 86400000); rows.push({ k, s: 20 + (i % 30), g: 2, r: 5, o: 1, a: 12, m: 1, x: 2, ram: 3000, pk: 80, ls: 900, h: new Array(24).fill(1), hi: new Array(8).fill(3), hl: new Array(8).fill(2) }); }
      for (let i = 0; i < weeks; i++) { const k = 'w:' + weekKey(now - i * 7 * 86400000); const h = {}; for (let j = 0; j < hosts; j++) h['site' + j + '.example.com'] = 1 + ((i + j) % 40); rows.push({ k, hosts: h }); }
      for (let i = 0; i < events; i++) { const t = now - i * 3600000; rows.push({ k: 'e:' + String(t).padStart(13, '0') + 'x' + i, t, type: 'stash', n: 3, gid: null }); }
      await db.actTx(async (st) => { for (const r of rows) st.put(r); });
      return { rows: rows.length };
    }
    case 'debug:actPrune': return act.prune();
    case 'debug:actBump': await act.bump(msg.kind || 'stash', msg.f || { n: 1 }); return {};
    case 'debug:actMeta': return { A: { ...act.A }, rows: (await db.actDumpAll()).length };
    case 'debug:splitApi': { debugDisableSplit(!!msg.off); return { has: canSplit() }; } // dev only (handleDebug is gated by installType): simulate Chrome < 155
    case 'debug:sweep': await sweep(typeof msg.min === 'number' ? msg.min : 0); return {};
    case 'debug:stamp': { const cur = await chrome.storage.session.get(KEYS.S_AUDIBLE); const m = cur[KEYS.S_AUDIBLE] || {}; m[msg.tabId] = Date.now() - (Number(msg.agoMin) || 0) * 60000; await chrome.storage.session.set({ [KEYS.S_AUDIBLE]: m }); return {}; }
    case 'debug:probeTime': { const t0 = performance.now(); const r = await runProbe(msg.tabId); return { ms: Math.round((performance.now() - t0) * 10) / 10, r }; }
    case 'debug:clock': await chrome.storage.local.set({ debugClock: Number(msg.days) || 0 }); return {}; // dev only (handleDebug is gated by installType)
    case 'debug:runPurge': { const t0 = performance.now(); await runPurge(); return { ms: Math.round(performance.now() - t0), meta: (await db.getMeta()).lastPurge || null }; }
    case 'debug:removeOpenedBulk': { // times the removal step of a restore on the DB side (no tabs): {gid, n}
      const t0 = performance.now(); const seqs = [];
      for (let after = 0; seqs.length < msg.n;) { const page = await db.getItemsPage(msg.gid, after, 1000); if (!page.length) break; for (const it of page) seqs.push(it.seq); after = page[page.length - 1].seq; }
      const want = seqs.slice(0, msg.n); const per = []; const chunk = msg.chunk || 100;
      for (let i = 0; i < want.length; i += chunk) { const t1 = performance.now(); await ex(() => db.removeOpened(msg.gid, want.slice(i, i + chunk))); per.push(performance.now() - t1); }
      return { ms: Math.round(performance.now() - t0), steps: per.length, maxStep: Math.round(Math.max(...per)), n: want.length };
    }
    case 'debug:snapAuto': { const p0 = performance.now(); const r = await snapshot.runSnapshot({ kind: 'auto', force: !!msg.force }); return { ...r, wallMs: Math.round((performance.now() - p0) * 10) / 10 }; } // wall time of exactly what the SNAPSHOT alarm runs
    case 'debug:seedGroup': return ex(async () => { const g = await db.createGroup({ source: 'debug', title: String(msg.title || ''), createdAt: msg.createdAt || Date.now(), tabGroups: msg.tabGroups }); return { gid: g.id }; });
    case 'debug:seedItems': return ex(async () => db.appendItems(msg.gid, Array.isArray(msg.items) ? msg.items : []));
    case 'debug:seedDone': return ex(async () => { await db.setPhase(msg.gid, 'committed'); return {}; });
    case 'debug:stashFake': return debugStashFake(msg.n || 4000);
    case 'debug:memStub': setMemStub(msg.ratio); return {};
    case 'debug:drainHooks': drain.debugHooks(msg.patch || {}); return {};
    case 'debug:abortDrain': drain.debugHooks({ abort: true }); return {};
    case 'debug:resumeDrain': await drain.resumeDrain(); return {};
    case 'debug:dbFail': db.debugFail(msg.on); return {};
    case 'debug:staleRefresh': await db.metaQuiet((m) => { m.refresh = { id: 'stale', ids: [999991, 999992], done: 0, skipped: 0, scope: 'window', rediscard: false, paused: null, startedAt: 1 }; }); return {}; // dev only: a refresh job left behind by a dead worker
    case 'debug:meta': return { meta: await db.getMeta(), running: drain.isRunning() };
    case 'debug:vaultSync': return { n: await vault.syncDirty({ step: ex }) };
    case 'debug:stashWindow': return stashWindow(msg.windowId, 'click', 'all');
    case 'debug:iconClick': return onIconClick({ windowId: msg.windowId, incognito: false }).then(() => ({}));
    case 'debug:stashAll': return stashAllWindows(msg.windowId, msg.grouping, 'click');
    case 'debug:fullInit':
      if (msg.reset) await db.setMeta({ migration: {} });
      return { ok: await fullInit() };
    default: throw new Error('unknown message');
  }
}

async function handleLock(msg) {
  switch (msg.type) {
    case 'lock.status': return lockctl.status();
    case 'lock.enable': return lockctl.enable({ password: msg.password, withRecovery: msg.withRecovery !== false }); // sync and the lock work together (lib/syncseal.js)
    case 'lock.unlock': return lockctl.unlock({ password: msg.password, recoveryKey: msg.recoveryKey, newPassword: msg.newPassword, backupPassword: msg.backupPassword, slot: msg.slot });
    case 'lock.slotAddPassword': return lockctl.slotAddPassword({ password: msg.password, backup: msg.backup });
    case 'lock.slotAddPrf': return lockctl.slotAddPrf({ password: msg.password, name: msg.name, cid: msg.cid, psalt: msg.psalt, prf: msg.prf });
    case 'lock.slotRemove': return lockctl.slotRemove({ password: msg.password, id: msg.id });
    case 'lock.lockNow': return lockctl.lockNow('manual');
    case 'lock.changePassword': return lockctl.changePassword({ old: msg.old, new: msg.new });
    case 'lock.newRecovery': return lockctl.newRecovery({ password: msg.password });
    case 'lock.removeRecovery': return lockctl.removeRecovery({ password: msg.password });
    case 'lock.disable': return lockctl.disable({ password: msg.password });
    case 'lock.cancelMigration': return lockctl.cancelMigration();
    case 'lock.resetErase': return lockctl.resetErase({ confirm: msg.confirm });
    case 'lock.setPolicy': return lockctl.setPolicy({ idleMin: msg.idleMin, onScreenLock: msg.onScreenLock, onPageClose: msg.onPageClose });
    case 'lock.touch': return lockctl.touch();
    case 'lock.archive.begin': return lockarchimp.begin({ header: msg.header, password: msg.password, recoveryKey: msg.recoveryKey, backupPassword: msg.backupPassword, slot: msg.slot });
    case 'lock.archive.rows': return lockarchimp.rows({ lines: msg.lines });
    case 'lock.archive.end': return lockarchimp.end();
    case 'lock.archive.abort': return lockarchimp.abort();
    default: throw new Error('unknown message');
  }
}

async function handle(msg, sender) {
  await ready;
  const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
  const t = msg && msg.type;
  if (typeof t === 'string' && t.startsWith('debug:')) {
    if (!isDev()) throw new Error('debug disabled');
    if (lockrt.enabled()) throw new Error('debug disabled while the password lock is on');
    return handleDebug(msg);
  }
  if (typeof t === 'string' && t.startsWith('lock.')) return handleLock(msg);
  if (lockrt.isLocked() && !LOCKED_OK.has(t)) return { error: 'locked' };
  switch (t) {
    // ----- restore -----
    case 'restoreSplit': return restoreSplitPair(String(msg.key || ''), { newWindow: !!msg.newWindow, windowId, remove: boolOrUndef(msg.remove) });
    case 'restoreItems': return restoreItemKeys(Array.isArray(msg.keys) ? msg.keys : [], { newWindow: !!msg.newWindow, windowId, remove: boolOrUndef(msg.remove) });
    case 'restoreTabGroup': return restoreTabGroup(msg.groupId, Number(msg.tg), { newWindow: !!msg.newWindow, windowId, remove: boolOrUndef(msg.remove) });
    case 'restoreGroup': return startRestore({ gids: [msg.groupId], newWindow: !!msg.newWindow, windowId, perWindow: !!msg.session, here: !!msg.here, incognito: !!msg.incognito, asTabGroup: !!msg.asTabGroup, remove: boolOrUndef(msg.remove) });
    case 'restoreOpenAll': {
      const gids = (await db.listGroups()).filter((g) => g.phase === 'committed').map((g) => g.id);
      return startRestore({ gids, windowId });
    }
    case 'restoreContinue': return continueRestore();
    case 'restoreRunAll': runAuto().catch(() => {}); return {};
    case 'restoreStop': return stopRestore();
    // ----- refresh all (reload frozen tabs in memory-aware steps; background, no focus change) -----
    case 'refreshAll': return startRefresh({
      scope: msg.scope === 'session' ? 'session' : 'window',
      windowId: msg.windowId != null ? msg.windowId : (windowId != null ? windowId : await currentWindowId()),
      gid: msg.gid, rediscard: typeof msg.rediscard === 'boolean' ? msg.rediscard : undefined,
    });
    case 'refreshCancel': return cancelRefresh();
    case 'undoLastStash': return undoLastStash(windowId);

    // ----- groups / items -----
    case 'deleteGroup': {
      const r = await ex(() => db.softDeleteGroup(msg.groupId));
      return r.error ? r : { undo: { type: 'undeleteGroup', groupId: msg.groupId } };
    }
    case 'undeleteGroup': return ex(() => db.undeleteGroup(msg.groupId));
    case 'purgeGroup': return ex(() => db.purgeGroup(msg.groupId));
    case 'deleteItems': {
      const seqs = Array.isArray(msg.seqs) ? msg.seqs.map(Number) : [];
      const g = await db.getGroup(msg.groupId);
      if (!g) return { error: 'notfound' };
      if (seqs.length >= g.count && g.phase === 'committed') {
        const r = await ex(() => db.softDeleteGroup(msg.groupId));
        return r.error ? r : { undo: { type: 'undeleteGroup', groupId: msg.groupId } };
      }
      const r = await ex(() => db.trashItems(msg.groupId, seqs));
      return r.error ? r : { undo: { type: 'undoTrash', tid: r.tid } };
    }
    case 'moveItems': { // {moves:[{gid, seqs}], dst:{gid}|{create:{title, starred, pinned, pending, archived, cat}}} -> one undo step list
      const moves = (Array.isArray(msg.moves) ? msg.moves : []).slice(0, 500).map((m) => ({ gid: String(m.gid), seqs: (Array.isArray(m.seqs) ? m.seqs : []).map(Number).filter((n) => n > 0) })).filter((m) => m.seqs.length);
      if (!moves.length || !msg.dst) return { error: 'notfound' };
      let dst = msg.dst.gid ? { gid: String(msg.dst.gid) } : { create: msg.dst.create || {} };
      const steps = []; let total = 0; let last = null;
      for (const m of moves) {
        if (dst.gid === m.gid) continue;
        for (let i = 0; i < m.seqs.length; i += PURGE_CHUNK) {
          const part = m.seqs.slice(i, i + PURGE_CHUNK);
          const r = await ex(() => db.moveItems(m.gid, part, dst));
          if (r.error) { if (!steps.length) return r; continue; }
          total += r.n; last = r.dst;
          steps.push({ from: m.gid, to: r.dst, orig: r.map.map((x) => x[0]), now: r.map.map((x) => x[1]), srcInfo: r.srcGone ? r.srcInfo : null, createdDst: !!r.created });
          dst = { gid: r.dst };
        }
      }
      if (!steps.length) return { error: 'notfound' };
      return { n: total, dst: last, undo: { type: 'undoMove', steps } };
    }
    case 'undoMove': { // put every moved item back under its old seq number (re-creates a source set the move had emptied)
      const steps = Array.isArray(msg.steps) ? msg.steps : [];
      let n = 0;
      for (const st of steps.slice().reverse()) {
        const r = await ex(() => db.moveItems(String(st.to), st.now.map(Number), { gid: String(st.from) }, { keepSeqs: st.orig.map(Number), recreate: st.srcInfo || undefined }));
        if (r && r.n) n += r.n;
      }
      return { n };
    }
    case 'undoTrash': return ex(() => db.undoTrash(Number(msg.tid)));
    case 'renameGroup': return ex(() => db.updateGroup(msg.groupId, { title: String(msg.title || '') }));
    case 'setOrd': return ex(() => db.updateGroup(String(msg.groupId), { ord: Number(msg.ord) }));
    case 'setFlag': {
      if (!['starred', 'locked', 'pinned', 'pending', 'archived', 'sync'].includes(msg.flag)) throw new Error('bad flag');
      return ex(() => db.updateGroup(msg.groupId, { [msg.flag]: !!msg.value }));
    }
    case 'saveView': {
      const v = msg.view && typeof msg.view === 'object' ? msg.view : {};
      const clean = {
        sort: ['created', 'createdAsc', 'mtime', 'lastRestored', 'title', 'count', 'sites', 'manual'].includes(v.sort) ? v.sort : 'created',
        starredFirst: !!v.starredFirst,
        groupBy: ['calendar', 'slot', 'site', 'tabgroup', 'count', 'category', 'none'].includes(v.groupBy) ? v.groupBy : 'calendar',
        slotMode: ['wdHour', 'hour', 'weekday', 'dom', 'partOfDay'].includes(v.slotMode) ? v.slotMode : 'wdHour',
        itemSort: ['stash', 'title', 'site', 'visited'].includes(v.itemSort) ? v.itemSort : 'stash',
        itemDir: v.itemDir === 'desc' ? 'desc' : 'asc',
        sortRev: !!v.sortRev,
        flat: !!v.flat,
        flatSort: ['stash', 'title', 'site', 'visited'].includes(v.flatSort) ? v.flatSort : 'stash',
        flatDir: v.flatDir === 'asc' ? 'asc' : 'desc',
      };
      await chrome.storage.local.set({ view: clean });
      return {};
    }
    // remove duplicate urls inside one session (they go to the trash as one entry, so it is undoable)
    case 'dedupeGroup': return ex(async () => {
      const g = await db.getGroup(msg.groupId);
      if (!g) return { error: 'notfound' };
      if (g.locked) return { error: 'locked' };
      const seen = new Set();
      const dup = [];
      let after = 0;
      for (;;) {
        const page = await db.getItemsPage(msg.groupId, after, 1000);
        if (!page.length) break;
        for (const it of page) { if (seen.has(it.url)) dup.push(it.seq); else seen.add(it.url); }
        after = page[page.length - 1].seq;
        if (page.length < 1000) break;
      }
      if (!dup.length) return { n: 0 };
      const r = await db.trashItems(msg.groupId, dup);
      return r.error ? r : { n: dup.length, undo: { type: 'undoTrash', tid: r.tid } };
    });
    case 'groupLook': return ex(() => db.updateGroup(msg.groupId, { ...('color' in msg ? { color: msg.color } : {}), ...('emoji' in msg ? { emoji: msg.emoji } : {}) }));
    case 'groupNote': return ex(() => db.updateGroup(msg.groupId, { note: String(msg.note || '') }));

    // ----- categories -----
    case 'catSave': return ex(async () => ({ cat: await db.saveCategory(msg.cat || {}) }));
    case 'catDelete': return ex(() => db.deleteCategory(String(msg.id)));
    case 'catReorder': return ex(() => db.reorderCategories(Array.isArray(msg.ids) ? msg.ids.map(String) : []));
    case 'groupsSetCat': return ex(() => db.setGroupsCategory(Array.isArray(msg.gids) ? msg.gids.map(String) : [], msg.cat == null ? null : String(msg.cat)));
    case 'emptyTrash': return db.purgeAll({ all: true }, ex);
    case 'trashRecover': return ex(() => db.recoverTrash({ gids: strs(msg.gids), tids: nums(msg.tids) }));
    case 'trashPurge': return db.purgeAll({ sel: { gids: strs(msg.gids), tids: nums(msg.tids) } }, ex);
    case 'trashEmptyType': return db.purgeAll({ all: true, only: msg.reason === 'opened' ? 'opened' : 'deleted' }, ex);
    case 'trashOpen': {
      const recs = [];
      for (const r of await db.trashRecords(nums(msg.tids))) for (const it of r.items) recs.push(it);
      for (const gid of strs(msg.gids)) { const g = await db.getGroup(gid); if (g && g.deletedAt != null) for (let after = 0; ;) { const page = await db.getItemsPage(gid, after, 1000); if (!page.length) break; for (const it of page) recs.push(it); after = page[page.length - 1].seq; } }
      return openTrashRecords(recs, { windowId });
    }

    // ----- import (streamed by the page) -----
    case 'import:begin': return { importId: Date.now().toString(36) };
    case 'import:group':
      return ex(async () => {
        const m = msg.meta || {};
        const g = await db.createGroup({
          title: String(m.title || ''), starred: !!m.starred, locked: !!m.locked, source: 'import',
          createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
          windowCount: typeof m.windowCount === 'number' ? m.windowCount : 1,
          tabGroups: m.tabGroups, // optional (older exports have none)
          color: m.color, emoji: m.emoji,
        });
        return { gid: g.id };
      });
    case 'import:items':
      return ex(async () => {
        const now = Date.now();
        const items = [];
        let skipped = 0;
        for (const raw of Array.isArray(msg.items) ? msg.items : []) {
          const it = normItem(raw, now);
          if (it) items.push(it); else skipped++;
        }
        if (items.length) await db.appendItems(msg.gid, items);
        return { added: items.length, skipped };
      });
    case 'import:abort':
      return ex(async () => {
        for (const gid of Array.isArray(msg.gids) ? msg.gids : []) await db.purgeGroup(gid, { force: true });
        return {};
      });
    case 'import:end':
      return ex(async () => {
        let groups = 0;
        for (const gid of Array.isArray(msg.gids) ? msg.gids : []) {
          const g = await db.getGroup(gid);
          if (!g) continue;
          if (g.count === 0) await db.purgeGroup(gid, { force: true });
          else { await db.setPhase(gid, 'committed'); groups++; }
        }
        return { groups };
      });

    // ----- settings / misc -----
    case 'saveSettings': {
      const r = await settingsLib.saveSettings(msg.patch);
      if (msg.patch && ('activityTracking' in msg.patch || 'preciseOpenTime' in msg.patch || 'ramCalibrate' in msg.patch || 'retentionDays' in msg.patch)) {
        act.setFrom(await settingsLib.getSettings());
        if (!act.A.on) { try { await chrome.storage.session.remove(['fs', 'actbuf']); } catch { /* ignore */ } }
        applyPreciseListener();
      }
      if (msg.patch && 'iconClickAction' in msg.patch) await applyIconAction();
      if (msg.patch && ('closeDuplicates' in msg.patch || 'dupAutoMinutes' in msg.patch)) await clean.applyDupAlarm();
      if (msg.patch && ('autoSnapshot' in msg.patch || 'snapshotMinutes' in msg.patch)) await applySnapshotAlarm();
      return r;
    }
    // popup.html: stash on demand. scope: 'tab' | 'window' | 'all'
    case 'stashNow': {
      const opts = { includePinned: !!msg.includePinned };
      const wid = msg.windowId != null ? msg.windowId : await currentWindowId();
      if (wid == null) return { error: 'nowindow' };
      if (msg.scope === 'tab') return stashWindow(wid, 'tab', 'tab', opts);
      if (msg.scope === 'all') {
        const s = await settingsLib.getSettings();
        return stashAllWindows(wid, s.stashGrouping, 'click', opts);
      }
      return stashWindow(wid, 'click', 'all', opts);
    }
    // clean actions (never stash/close real content tabs unless they are duplicates)
    case 'closeDuplicatesNow': return clean.closeDuplicatesNow();
    case 'cleanSummary': return clean.cleanSummary();
    case 'protectedTabs': return { tabs: await protectedTabs() };
    case 'sleepingTabs': return { tabs: await firstseen.sleepingList() };
    case 'protectSet': { // mode: 'keep' | 'allow' | 'now' | 'clear' | 'whitelistOff'
      const id = Number(msg.tabId);
      if (msg.mode === 'whitelistOff') { const host = String(msg.host || ''); const st = await settingsLib.getSettings(); if (host && st.whitelist.includes(host)) await settingsLib.toggleWhitelist(host); return {}; }
      if (msg.mode === 'allow') { const cur = await chrome.storage.session.get(KEYS.S_AUDIBLE); const m = cur[KEYS.S_AUDIBLE] || {}; delete m[id]; await chrome.storage.session.set({ [KEYS.S_AUDIBLE]: m }); }
      await setOverride(id, msg.mode === 'clear' ? null : msg.mode === 'keep' || msg.mode === 'allow' || msg.mode === 'now' ? msg.mode : null);
      return {};
    }
    case 'cleanAll': {
      const wid = msg.windowId != null ? msg.windowId : await currentWindowId();
      return clean.cleanAll(() => stashInternalPages(wid));
    }
    case 'dupLogRestore': return clean.dupLogRestore(msg.indexes === 'all' ? 'all' : (Array.isArray(msg.indexes) ? msg.indexes.map(Number) : []));
    case 'dupLogClear': return clean.dupLogClear();
    case 'openList': await openList(msg.windowId != null ? msg.windowId : await currentWindowId()); return {};
    // ----- local usage stats (lib/activity.js) -----
    case 'act:stats': return act.stats();
    case 'dash:live': {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      let ratio = null; let freeBytes = 0;
      try { const m = await chrome.system.memory.getInfo(); ratio = m.capacity > 0 ? m.availableCapacity / m.capacity : null; freeBytes = m.availableCapacity; } catch { /* ignore */ }
      return { open: tabs.filter((t) => !t.incognito).length, sleeping: tabs.filter((t) => t.discarded).length, media: tabs.filter((t) => t.audible).length, ratio, freeBytes };
    }
    case 'act:purge': { act.purge(ex).catch(() => {}); return { started: true }; }
    case 'act:export': return act.exportAll();
    case 'ram:reset': await act.ramReset(); return {};
    case 'ram:info': return act.ramInfo();
    case 'stats': {
      let discarded = 0;
      try { discarded = (await chrome.tabs.query({ discarded: true })).length; } catch { /* ignore */ }
      return { discarded };
    }

    // ----- drain control -----
    // leftovers of a finished drain (tabs that stayed open because they refused to close): try again, report honestly
    case 'closeLeftovers': {
      const m = await db.getMeta();
      const want = ((m.lastDrainResult && m.lastDrainResult.skippedList) || []).filter((x) => x.reason === 'blocked' || x.reason === 'failed').map((x) => x.url);
      if (!want.length) return { closed: 0, left: 0 };
      const tabs = await chrome.tabs.query({});
      const open = tabs.filter((t) => want.includes(t.pendingUrl || t.url || ''));
      let closed = 0;
      await Promise.all(open.map(async (t) => {
        const done = await Promise.race([chrome.tabs.remove(t.id).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
        if (done) closed++;
      }));
      return { closed, left: open.length - closed };
    }
    // ----- crash-recovery snapshots -----
    case 'snapNow': return snapshot.runSnapshot({ kind: 'manual', force: true });
    case 'snapCheck': return { banner: await snapBanner() };
    case 'snapDismiss': return ex(async () => { await db.setMeta({ snapAck: String(msg.id || '') }); await chrome.storage.local.set({ [KEYS.SNAP_BANNER]: null }); post({ type: 'snapbanner', banner: null }); return {}; });
    case 'snapDelete': return ex(async () => { await db.snapDelete(String(msg.id)); post({ type: 'snapshots' }); return {}; });
    case 'snapRestore': {
      const r = await snapshot.restoreItems(Array.isArray(msg.items) ? msg.items : [], Array.isArray(msg.groups) ? msg.groups : [], Number(msg.windows) || 1, { title: String(msg.title || '') });
      if (!r.error && msg.dismiss) { await ex(() => db.setMeta({ snapAck: String(msg.dismiss) })); await chrome.storage.local.set({ [KEYS.SNAP_BANNER]: null }); post({ type: 'snapbanner', banner: null }); }
      return r;
    }
    case 'drain:pause': await drain.pauseDrain(); return {};
    case 'drain:resume': await drain.resumeUser(); return {};
    case 'drain:stop': await drain.stopDrain(!!msg.dropRemaining); return {};
    case 'drain:continueAfterRestart': return drain.continueAfterRestart();

    // ----- vault / recovery -----
    case 'vault:info': return { ...(await vault.vaultInfo()), missing: (await vault.missingFromDb()).length };
    case 'vault:rebuild': {
      const r = await ex(() => vault.rebuild(Array.isArray(msg.gids) ? msg.gids : null));
      await ex(() => db.setMeta({ vaultMissing: 0 }));
      return r;
    }
    case 'dbReset': {
      if (msg.confirm !== 'RESET') throw new Error('confirmation required');
      await db.deleteDatabase();
      return {};
    }
    case 'ixlogTrim': return ex(async () => { await db.ixlogTrim(Number(msg.upto) || 0); return {}; });
    case 'recentlyClosed': return { list: await snapshot.recentlyClosed(Number(msg.max) || 25), perm: !!sessionsApi() };
    case 'ping': return { pong: true };
    default:
      if (typeof t === 'string' && t.startsWith('sync/')) return syncCtl.handle(msg);
      throw new Error('unknown message');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (r) => {
      const res = r || {};
      if (res.error) sendResponse({ ok: false, ...res });
      else sendResponse({ ok: true, ...res });
    },
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});
