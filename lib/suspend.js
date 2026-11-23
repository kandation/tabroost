// Auto-suspend sweep, dirty-form probe, alarms and the toolbar badge.

import {
  KEYS, ALARMS, MB_PER_TAB_EST, PROBE_TIMEOUT_MS, AUDIBLE_GRACE_MS, STR_SW,
} from './constants.js';
import { hostOf } from './formats.js';
import { getSettings, isWhitelisted } from './settings.js';
import * as lockrt from './lockrt.js';
import { LOCK_TH } from './lockstr.js';
import { LOCK_EN } from './i18n.js';
import { swLang, swStr } from './swstr.js';
import * as db from './db.js';
import * as act from './activity.js';
import * as firstseen from './firstseen.js';
import { hasHost } from './perms.js';
import { splitIdOf, splitGuard } from './splitview.js';

// ---------- badge ----------
let badgeTimer = null; // debounce handle only; no data lives here

export function scheduleBadge() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadge().catch(() => {});
  }, 500);
}

export async function updateBadge() {
  const meta = await db.getMeta();
  if (meta.drain && !meta.drain.needsConfirm) return; // the drain owns the badge while it runs
  const n = (await chrome.tabs.query({ discarded: true })).length;
  const cached = (await chrome.storage.session.get(KEYS.S_LINKCOUNT))[KEYS.S_LINKCOUNT];
  let links;
  if (cached && cached.rev === meta.rev) links = cached.count;
  else {
    links = 0;
    for (const g of await db.listGroups()) if (g.phase !== 'writing') links += g.count;
    await chrome.storage.session.set({ [KEYS.S_LINKCOUNT]: { rev: meta.rev, count: links } });
  }
  const gb = ((n * MB_PER_TAB_EST) / 1024).toFixed(1);
  await chrome.action.setBadgeText({ text: n === 0 ? '' : n > 999 ? '999+' : String(n) });
  await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  const sw = await swStr();
  await chrome.action.setTitle({ title: lockrt.isLocked() ? ((await swLang()) === 'en' ? LOCK_EN : LOCK_TH).swBadgeLocked(links) : sw.badgeTitle(n, links, gb) });
}

export async function setDrainBadge(text, color, title) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (title) await chrome.action.setTitle({ title });
  } catch { /* ignore */ }
}

export async function clearDrainBadge() {
  scheduleBadge();
}

export async function setErrorBadge(text = '!') {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    await chrome.action.setTitle({ title: (await swStr()).errorTitle });
  } catch { /* ignore */ }
}

export async function flashBadge(text, ms = 2000) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#616161' });
  } catch { /* ignore */ }
  setTimeout(() => scheduleBadge(), ms);
}

// ---------- alarms ----------
export async function ensureAlarms(force) {
  const want = [[ALARMS.SWEEP, 2], [ALARMS.DAILY, 1440], [ALARMS.VAULT, 30], [ALARMS.SYNC_CHECK, 60], [ALARMS.PURGE, 360]];
  for (const [name, period] of want) {
    if (force || !(await chrome.alarms.get(name))) {
      await chrome.alarms.create(name, { periodInMinutes: period, delayInMinutes: period });
    }
  }
}

// ---------- shared exclusion rules (used by sweep, clean-all and auto-stash) ----------
// Protection follows PLAYBACK STATE, not the site: a YouTube tab that is not playing is discarded like any other tab.
//   - audible now / audible (or media-active) within `mediaGraceMin`  -> protected
//   - a probe (see probe()) finds a <video>/<audio> that is playing (even muted), media-session playing, or picture-in-picture
//   - a paused-but-progressed media element is protected while the last playback is inside the grace window
//   - per-tab override stored in chrome.storage.session: 'keep' (never suspend), 'allow' (ignore media protection), 'now' (suspend ASAP)
// "Doubt" never discards: any probe error / timeout skips the tab.
export function mediaGraceMs(settings) {
  if (settings.mediaProtect === false) return AUDIBLE_GRACE_MS;
  const m = Number(settings.mediaGraceMin);
  return (m > 0 ? m : 30) * 60000;
}

export function skipReason(tab, settings, now, thresholdMin, audibleMap, overrides) {
  if (tab.autoDiscardable === false) return 'nodiscard';
  const u = tab.url || '';
  if (!/^https?:/i.test(u)) return 'scheme';
  const ov = overrides && overrides[tab.id];
  if (ov === 'keep') return 'override';
  if (isWhitelisted(settings, hostOf(u))) return 'whitelist';
  if (ov === 'now') return null; // the user asked for this tab to be suspended: no idle threshold, no media grace
  if (!tab.lastAccessed || now - tab.lastAccessed < thresholdMin * 60000) return 'recent';
  if (ov === 'allow') return null;
  const a = audibleMap && audibleMap[tab.id];
  if (a && now - a < mediaGraceMs(settings)) return 'audible';
  return null;
}

export async function getAudibleMap() {
  try {
    return (await chrome.storage.session.get(KEYS.S_AUDIBLE))[KEYS.S_AUDIBLE] || {};
  } catch {
    return {};
  }
}

export async function getOverrideMap() {
  try {
    return (await chrome.storage.session.get(KEYS.S_OVERRIDE))[KEYS.S_OVERRIDE] || {};
  } catch {
    return {};
  }
}

export async function setOverride(tabId, mode) { // mode: 'keep' | 'allow' | 'now' | null (clear)
  const cur = await getOverrideMap();
  if (mode) cur[tabId] = mode; else delete cur[tabId];
  await chrome.storage.session.set({ [KEYS.S_OVERRIDE]: cur });
}

async function stampMedia(tabId, ts) {
  try {
    const cur = await getAudibleMap();
    cur[tabId] = ts;
    await chrome.storage.session.set({ [KEYS.S_AUDIBLE]: cur });
  } catch { /* cosmetic */ }
}

// ---------- probe ----------
// Injected into the tab (top frame + every frame we may script): must be fully self-contained and cheap (<= 500 elements).
// Returns {b: unsaved input / editing, m: 0 none | 1 media ended | 2 paused but progressed | 3 playing (muted or not) / PiP / media session}.
function probe() {
  try {
    let b = false;
    let m = 0;
    let n = 0;
    const els = document.querySelectorAll('input,textarea,select,video,audio');
    for (const el of els) {
      if (++n > 500) break;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') {
        if (el.value !== el.defaultValue) b = true;
      } else if (tag === 'INPUT') {
        const t = (el.type || '').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'button') continue;
        if (t === 'checkbox' || t === 'radio') {
          if (el.checked !== el.defaultChecked) b = true;
        } else if (el.value !== el.defaultValue) b = true;
      } else if (tag === 'SELECT') {
        const opts = Array.from(el.options);
        const hasDefault = opts.some((o) => o.defaultSelected);
        if (!el.multiple && !hasDefault) {
          if (el.selectedIndex > 0) b = true; // browser silently selects option 0 when none is marked selected
        } else if (opts.some((o) => o.selected !== o.defaultSelected)) b = true;
      } else if (tag === 'VIDEO' || tag === 'AUDIO') {
        if (!el.paused && !el.ended) m = 3;
        else if (el.ended) { if (m < 1) m = 1; } else if (el.currentTime > 0 && el.readyState >= 2) { if (m < 2) m = 2; }
      }
      if (b) break;
    }
    if (m < 3) {
      try {
        if (document.pictureInPictureElement) m = 3;
        else if (navigator.mediaSession && navigator.mediaSession.playbackState === 'playing') m = 3;
      } catch { /* ignore */ }
    }
    const ae = document.activeElement;
    if (ae && ae.isContentEditable) b = true;
    return { b, m };
  } catch {
    return { b: true, m: 0 };
  }
}

/** Runs the probe in every frame we may script. Returns {ok, b, m}; ok=false on any error / timeout (the caller then skips the tab). */
export async function runProbe(tabId) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), PROBE_TIMEOUT_MS); });
  try {
    let r = await Promise.race([chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probe }).catch(() => null), timeout]);
    if (r === 'timeout') return { ok: false, b: true, m: 0 };
    if (!r) { // frames refused (e.g. a frame we may not script): fall back to the top frame only
      r = await Promise.race([chrome.scripting.executeScript({ target: { tabId }, func: probe }), timeout]);
      if (r === 'timeout') return { ok: false, b: true, m: 0 };
    }
    if (!Array.isArray(r) || !r.length) return { ok: false, b: true, m: 0 };
    let b = false; let m = 0; let good = 0;
    for (const f of r) {
      const v = f && f.result;
      if (!v || typeof v !== 'object') { b = true; continue; } // a frame that failed to answer counts as doubt
      good++;
      if (v.b) b = true;
      if (v.m > m) m = v.m;
    }
    return { ok: good > 0, b, m };
  } catch {
    return { ok: false, b: true, m: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Legacy yes/no used by duplicate closing: true when the tab holds unsaved input or is playing. Anything uncertain counts as busy. */
export async function isBusy(tabId) {
  const r = await runProbe(tabId);
  return !r.ok || r.b || r.m >= 3;
}

/**
 * Probe-based protection for one candidate tab. Returns null (free to discard) or a reason:
 * 'probe' (doubt) | 'form' | 'media-playing' | 'media-paused' | 'media-ended'. Playing media refreshes the "last media" stamp that
 * survives service-worker restarts (chrome.storage.session), which gives the paused-after-play grace.
 */
export async function probeProtect(tabId, settings, now, audibleMap) {
  const r = await runProbe(tabId);
  if (!r.ok) return 'probe';
  if (r.b) return 'form';
  if (settings.mediaProtect === false) return r.m >= 3 ? 'media-playing' : null;
  if (r.m >= 3) { await stampMedia(tabId, now); if (audibleMap) audibleMap[tabId] = now; return 'media-playing'; }
  const last = audibleMap && audibleMap[tabId];
  if (r.m === 2 && last && now - last < mediaGraceMs(settings)) return 'media-paused';
  if (r.m === 1 && last && now - last < (Number(settings.mediaEndedMin) || 0) * 60000) return 'media-ended';
  return null;
}

async function noteSweepStatus(reason) {
  try { await chrome.storage.session.set({ [KEYS.S_SWEEPSTAT]: { reason, t: Date.now() } }); } catch { /* cosmetic */ }
}

async function noteProtected(map) {
  try { await chrome.storage.session.set({ [KEYS.S_PROTECT]: map }); } catch { /* cosmetic */ }
}

// ---------- sweep ----------
export async function sweep(overrideMin) {
  const settings = await getSettings();
  if (!settings.autoSuspend) return;
  // Without access to pages the form/media check cannot run, and a tab that cannot be checked is never put to sleep:
  // auto-sleep simply waits (the settings page and the popup say so and offer a one-click permission request).
  if (!(await hasHost())) { await noteSweepStatus('noHostAccess'); await updateBadge().catch(() => {}); return { skipped: 'noHostAccess' }; }
  await noteSweepStatus(null);
  let threshold = settings.suspendAfterMin;
  if (typeof overrideMin === 'number') threshold = overrideMin;
  else {
    try {
      const m = await chrome.system.memory.getInfo();
      if (m.capacity > 0 && m.availableCapacity / m.capacity < settings.lowMemRatio) {
        threshold = Math.min(settings.suspendAfterMin, settings.lowMemThresholdMin);
      }
    } catch { /* keep default threshold */ }
  }
  const tabs = await chrome.tabs.query({
    active: false, pinned: false, audible: false, discarded: false, status: 'complete',
  });
  const audible = await getAudibleMap();
  const overrides = await getOverrideMap();
  const now = Date.now();
  const prot = {};
  act.setFrom(settings);
  const availBefore = act.A.on ? await act.availNow() : 0;
  let slept = 0;
  const cand = tabs.filter((t) => !skipReason(t, settings, now, threshold, audible, overrides));
  // Split view: the two panes are ONE unit. A pane is only put to sleep together with its partner, and never while the partner is
  // the window's active tab, audible, loading, protected or recently used (the user would see half of the split go blank).
  let guard = null;
  if (cand.some((t) => splitIdOf(t) >= 0)) {
    try { guard = splitGuard(cand, await chrome.tabs.query({})); } catch { guard = { units: new Map(), blocked: new Set(cand.filter((t) => splitIdOf(t) >= 0).map((t) => t.id)) }; }
  }
  const handled = new Set();
  const sleepOne = async (tab) => {
    try { const d = await chrome.tabs.discard(tab.id); if (d) { slept++; firstseen.markFrozen(tab.id).catch(() => {}); } } catch { /* ignore */ }
    if (overrides[tab.id] === 'now') await setOverride(tab.id, null).catch(() => {});
  };
  for (const tab of cand) {
    if (handled.has(tab.id)) continue;
    const unit = guard && guard.units.get(tab.id);
    if (unit) {
      for (const m of unit) handled.add(m.id);
      if (guard.blocked.has(tab.id)) { for (const m of unit) prot[m.id] = { r: 'split-partner', t: now }; continue; }
      let bad = null;
      for (const m of unit) { const w = await probeProtect(m.id, settings, now, audible); if (w) { bad = { m, w }; break; } }
      if (bad) { for (const m of unit) { if (m === bad.m) { if (bad.w !== 'probe') prot[m.id] = { r: bad.w, t: now }; } else prot[m.id] = { r: 'split-partner', t: now }; } continue; }
      for (const m of unit) await sleepOne(m); // both panes (their ids change on discard, the pairing stays)
      continue;
    }
    const why = await probeProtect(tab.id, settings, now, audible);
    if (why) { if (why !== 'probe') prot[tab.id] = { r: why, t: now }; continue; }
    await sleepOne(tab);
  }
  await noteProtected(prot);
  if (slept) { act.bump('suspend', { n: slept, ram: true }).catch(() => {}); act.calibrate(slept, availBefore).catch(() => {}); }
  await updateBadge().catch(() => {});
  return { slept };
}

/** For the popup: tabs that are NOT being suspended and why. Cheap: static rules + the last sweep's probe results (no probing here). */
export async function protectedTabs() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ discarded: false });
  const audible = await getAudibleMap();
  const overrides = await getOverrideMap();
  const cache = (await chrome.storage.session.get(KEYS.S_PROTECT).catch(() => ({})))[KEYS.S_PROTECT] || {};
  const now = Date.now();
  const out = [];
  const panes = new Map(); // windowId:splitViewId -> panes (the partner of a pane in use keeps it awake)
  for (const t of tabs) { if (splitIdOf(t) >= 0) { const k = t.windowId + ':' + splitIdOf(t); if (!panes.has(k)) panes.set(k, []); panes.get(k).push(t); } }
  for (const t of tabs) {
    if (t.incognito || t.active || t.pinned || !/^https?:/i.test(t.url || '')) continue;
    const host = hostOf(t.url);
    const ago = (ts) => Math.max(1, Math.round((now - ts) / 60000));
    let kind = null; let mins = 0;
    if (overrides[t.id] === 'keep') kind = 'keep';
    else if (t.audible) kind = 'audible';
    else if (isWhitelisted(settings, host)) kind = 'whitelist';
    else if (cache[t.id] && cache[t.id].r !== 'form' && now - cache[t.id].t < 15 * 60000) { kind = cache[t.id].r; mins = ago(audible[t.id] || cache[t.id].t); }
    else if (audible[t.id] && now - audible[t.id] < mediaGraceMs(settings) && overrides[t.id] !== 'allow' && overrides[t.id] !== 'now') { kind = 'recent-audio'; mins = ago(audible[t.id]); }
    else if (splitIdOf(t) >= 0 && (panes.get(t.windowId + ':' + splitIdOf(t)) || []).some((m) => m.id !== t.id && (m.active || m.audible || overrides[m.id] === 'keep' || isWhitelisted(settings, hostOf(m.url || ''))))) kind = 'split-partner';
    if (!kind) continue;
    out.push({ id: t.id, title: t.title || t.url, host, kind, mins });
  }
  return out;
}
