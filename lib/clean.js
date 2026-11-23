// Opt-in "clean" actions that never stash or close real content: duplicate tabs, data-less internal pages, idle tabs.
// Duplicates are closed WITHOUT saving (the kept tab holds the same URL) but every closed URL goes into a small
// undo log (last 200) so nothing is unrecoverable.

import { KEYS, DUP_LOG_MAX, ALARMS } from './constants.js';
import { normalizeUrl, internalCategory } from './formats.js';
import * as db from './db.js';
import * as lockrt from './lockrt.js';
import { getSettings } from './settings.js';
import { closeTabsGently } from './gentle.js';
import { isBusy, skipReason, getAudibleMap, getOverrideMap, scheduleBadge, sweep } from './suspend.js';
import { post } from './bus.js';
import * as act from './activity.js';
import { splitIdOf, splitGuard } from './splitview.js';

const own = () => chrome.runtime.getURL('');

/** Duplicate tabs that may be closed: [{tab, keeper}]. Keeper preference: active, pinned, audible, oldest. */
export async function dupCandidates(settings) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const inDrain = await db.drainAllTabIds();
  const groups = new Map();
  for (const t of tabs) {
    if (t.incognito || inDrain.has(t.id)) continue;
    const u = t.pendingUrl || t.url || '';
    if (!/^https?:/i.test(u) || u.startsWith(own())) continue;
    const key = normalizeUrl(u, settings.dupIgnoreUtm);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rank = (t) => (t.active ? 0 : t.pinned ? 1 : t.audible ? 2 : 3);
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    const keeper = list[0];
    for (const t of list.slice(1)) {
      if (t.active || t.pinned || t.audible) continue; // never auto-close these
      if (splitIdOf(t) >= 0) continue; // closing one pane would dissolve the split view of the other
      out.push({ tab: t, keeper });
    }
  }
  return out;
}

async function logDuplicates(entries) {
  const r = await chrome.storage.local.get([KEYS.DUP_LOG, KEYS.DUP_TOTAL]);
  if (lockrt.enabled()) { await chrome.storage.local.set({ [KEYS.DUP_TOTAL]: (r[KEYS.DUP_TOTAL] || 0) + entries.length }); post({ type: 'duplog' }); return; } // password lock on: no list of closed pages is kept
  const log = entries.map((e) => ({ url: e.tab.pendingUrl || e.tab.url, title: e.tab.title || '', at: Date.now() })).concat(r[KEYS.DUP_LOG] || []).slice(0, DUP_LOG_MAX);
  await chrome.storage.local.set({ [KEYS.DUP_LOG]: log, [KEYS.DUP_TOTAL]: (r[KEYS.DUP_TOTAL] || 0) + entries.length });
  post({ type: 'duplog' });
}

/** Closes duplicate tabs (gently). Tabs whose unsaved-form probe is positive are left alone. */
export async function closeDuplicatesNow() {
  const settings = await getSettings();
  const cands = await dupCandidates(settings);
  const ok = [];
  for (const c of cands) {
    if (!c.tab.discarded && (await isBusy(c.tab.id))) continue;
    ok.push(c);
  }
  if (!ok.length) return { closed: 0, skippedBusy: cands.length };
  await logDuplicates(ok); // log first: even a crash mid-way leaves an undo trail
  const closed = await closeTabsGently(ok.map((c) => c.tab.id));
  scheduleBadge();
  if (closed) act.bump('clean', { n: closed, ram: true }).catch(() => {});
  return { closed, skippedBusy: cands.length - ok.length };
}

export async function dupLogRestore(indexes) {
  const r = await chrome.storage.local.get(KEYS.DUP_LOG);
  const log = r[KEYS.DUP_LOG] || [];
  const pick = indexes === 'all' ? log.map((_, i) => i) : indexes.filter((i) => i >= 0 && i < log.length);
  let opened = 0;
  for (const i of pick) {
    try { await chrome.tabs.create({ url: log[i].url, active: false }); opened++; } catch { /* keep in log */ }
  }
  const done = new Set(pick.slice(0, opened));
  if (opened) await chrome.storage.local.set({ [KEYS.DUP_LOG]: log.filter((_, i) => !done.has(i)) });
  post({ type: 'duplog' });
  return { opened };
}

export async function dupLogClear() {
  await chrome.storage.local.set({ [KEYS.DUP_LOG]: [] });
  post({ type: 'duplog' });
  return {};
}

/** Alarm for the "auto" mode, applied on boot and whenever settings change. */
export async function applyDupAlarm() {
  const s = await getSettings();
  try {
    if (s.closeDuplicates === 'auto') await chrome.alarms.create(ALARMS.DUP, { periodInMinutes: Math.max(1, s.dupAutoMinutes || 30), delayInMinutes: Math.max(1, s.dupAutoMinutes || 30) });
    else await chrome.alarms.clear(ALARMS.DUP);
  } catch { /* ignore */ }
}

/** The tabs "clean all" would touch in its internal-pages step: {close:[tabs], save:[tabs]} (own pages exempt). */
export async function internalTargets(settings) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const close = [];
  const save = [];
  for (const t of tabs) {
    if (t.incognito) continue;
    const u = t.pendingUrl || t.url || '';
    const cat = internalCategory(u);
    if (!cat || u.startsWith(own())) continue;
    if (cat === 'newtab' || settings.internalPages === 'close') close.push(t); // new-tab pages: always closed unsaved
    else save.push(t);
  }
  return { close, save };
}

async function idleCandidates(settings) {
  const tabs = await chrome.tabs.query({ active: false, pinned: false, audible: false, discarded: false, status: 'complete' });
  const audible = await getAudibleMap();
  const overrides = await getOverrideMap();
  const now = Date.now();
  let c = tabs.filter((t) => !skipReason(t, settings, now, 0, audible, overrides));
  if (c.some((t) => splitIdOf(t) >= 0)) { // same split view rule as the sweep (panes go together, never next to a busy partner)
    try { c = splitGuard(c, await chrome.tabs.query({})).ok; } catch { c = c.filter((t) => splitIdOf(t) < 0); }
  }
  return c;
}

/** Counts shown in the confirmation dialog before "clean all". */
export async function cleanSummary() {
  const settings = await getSettings();
  const dups = await dupCandidates(settings);
  const internal = await internalTargets(settings);
  const idle = await idleCandidates(settings);
  return { duplicates: dups.length, internalClose: internal.close.length, internalSave: internal.save.length, idle: idle.length };
}

/** Clean all: duplicates -> internal pages per the toggles -> discard idle tabs. Never stashes real content tabs. */
export async function cleanAll(stashInternal) {
  const dup = await closeDuplicatesNow();
  const settings = await getSettings();
  const internal = await internalTargets(settings);
  let closedInternal = 0;
  if (internal.close.length) closedInternal += await closeTabsGently(internal.close.map((t) => t.id));
  let savedInternal = 0;
  if (internal.save.length) {
    const r = await stashInternal();
    savedInternal = (r && r.tabs) || 0;
  }
  await sweep(0);
  return { duplicates: dup.closed, internalClosed: closedInternal, internalSaved: savedInternal };
}
