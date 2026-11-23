// Local-only usage statistics: the ONE place that decides whether time / activity data is recorded.
//   A.on is a cached boolean (settings.activityTracking). EVERY function that records anything starts with `if (!(await ensure())) return`.
//   Rule for code review: `lastAccessed` is read only here and in firstseen.js.
// Nothing here is ever sent anywhere. Data: item.d (packed idle/lifetime), group.tm / group.rc, the `activity` store
// (d:YYYYMMDD day rows, w:YYYY-Www per-site weekly counts, e:<ms> recent events without urls or titles), meta.ramCal.

import * as db from './db.js';
import { getSettings } from './settings.js';
import { packD, unpackD, dayKey, weekKey } from './time.js';
import { hostOf } from './formats.js';
import { post } from './bus.js';
import { gzipJson, gunzipJson } from './snapfmt.js';

export const RAM_DEFAULT_MB = 100;
export const EVENTS_MAX = 200;
export const HOSTS_PER_WEEK = 50;
export const H_KEEP_DAYS = 90;

export const A = { on: true, loaded: false, precise: false, calibrate: true, retentionDays: 400 };

/** Apply a settings object (cheap, synchronous). Called by every caller that already has the settings. */
export function setFrom(s) {
  A.on = s.activityTracking !== false;
  A.precise = !!s.preciseOpenTime && A.on;
  A.calibrate = s.ramCalibrate !== false;
  A.retentionDays = typeof s.retentionDays === 'number' ? s.retentionDays : 400;
  A.loaded = true;
}

/** Loads the setting once per SW lifetime. Returns A.on. */
export async function ensure() {
  if (!A.loaded) { try { setFrom(await getSettings()); } catch { A.on = false; } }
  return A.on;
}

const nowOf = () => Date.now();
const idbGet = (st, k) => new Promise((res, rej) => { const r = st.get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbAll = (st, rng, keysOnly) => new Promise((res, rej) => { const r = keysOnly ? st.getAllKeys(rng) : st.getAll(rng); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Packed d for one tab at stash time. tab.lastAccessed is read ONLY here. fsEntry = {f, x?} from firstseen (exact when x). */
export function itemD(tab, now, fsEntry) {
  if (!A.on || !tab) return undefined;
  const la = tab.lastAccessed > 0 ? tab.lastAccessed : 0;
  const idle = la ? Math.max(0, Math.floor((now - la) / 60000)) : null;
  let opened = la || 0;
  let approx = true;
  if (fsEntry && fsEntry.f > 0) { const fm = fsEntry.f * 60000; opened = la ? Math.min(fm, la) : fm; approx = !fsEntry.x; } // fsEntry.f is in minutes
  const life = opened ? Math.max(0, Math.floor((now - opened) / 60000)) : null;
  return packD(idle, life, approx);
}

/** tab.lastAccessed for firstseen.js (kept here so the lint rule holds) */
export function lastAccessedOf(tab) { return tab && tab.lastAccessed > 0 ? tab.lastAccessed : 0; }

// ---------- counters ----------
const emptyDay = (k) => ({ k, s: 0, g: 0, r: 0, o: 0, a: 0, m: 0, x: 0, ram: 0, pk: 0, ls: 0 });
const evKey = (t) => 'e:' + String(t).padStart(13, '0') + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

async function ramPer() {
  try { const m = await db.getMeta(); return (m.ramCal && m.ramCal.v) || RAM_DEFAULT_MB; } catch { return RAM_DEFAULT_MB; }
}

/** 8 buckets for the idle / lifetime histograms: <1h, <6h, <1d, <3d, <7d, <30d, <90d, more (minutes in) */
export function histBucket(min) {
  const cuts = [60, 360, 1440, 4320, 10080, 43200, 129600];
  for (let i = 0; i < cuts.length; i++) if (min < cuts[i]) return i;
  return 7;
}

/** hosts + idle / lifetime minutes of a batch of stashed items (for the weekly top sites and the histograms) */
export function stashStats(items) {
  const hosts = []; const idle = []; const life = [];
  for (const it of items) {
    const h = hostOf(it.url);
    if (h) hosts.push(h);
    const u = unpackD(it.d);
    if (u) { if (u.idle != null) idle.push(u.idle); if (u.life != null) life.push(u.life); }
  }
  return { hosts, idle, life };
}

/**
 * Record one activity. kind: 'stash' | 'restore' | 'clean' | 'suspend' | 'discard'
 * f = { n: tabs, sessions?, opened?, gid?, hosts?: [host], idle?: [min], life?: [min], ram?: bool }
 */
export async function bump(kind, f = {}) {
  if (!(await ensure())) return;
  try {
    const t = nowOf();
    const n = Math.max(0, f.n | 0);
    const per = f.ram ? await ramPer() : 0;
    const dk = 'd:' + dayKey(t);
    const wk = 'w:' + weekKey(t);
    await db.actTx(async (st) => {
      const day = (await idbGet(st, dk)) || emptyDay(dk);
      if (kind === 'stash') { day.s += n; day.g += f.sessions || 1; } else if (kind === 'restore') { day.r += n; day.o += f.opened || 0; } else if (kind === 'suspend') day.a += n; else if (kind === 'discard') day.m += n; else if (kind === 'clean') day.x += n;
      if (f.ram) day.ram += Math.round(n * per);
      if (kind === 'stash' || kind === 'restore') { const h = day.h || (day.h = new Array(24).fill(0)); h[new Date(t).getHours()] += 1; }
      if (f.idle) { const a = day.hi || (day.hi = new Array(8).fill(0)); for (const m of f.idle) a[histBucket(m)]++; }
      if (f.life) { const a = day.hl || (day.hl = new Array(8).fill(0)); for (const m of f.life) a[histBucket(m)]++; }
      st.put(day);
      if (kind === 'stash' && f.hosts && f.hosts.length) {
        const wr = (await idbGet(st, wk)) || { k: wk, hosts: {} };
        for (const h of f.hosts) wr.hosts[h] = (wr.hosts[h] || 0) + 1;
        const ents = Object.entries(wr.hosts);
        if (ents.length > HOSTS_PER_WEEK) { ents.sort((a, b) => b[1] - a[1]); wr.hosts = Object.fromEntries(ents.slice(0, HOSTS_PER_WEEK)); }
        st.put(wr);
      }
      st.put({ k: evKey(t), t, type: kind, n, gid: f.gid || null });
      const keys = await idbAll(st, IDBKeyRange.bound('e:', 'e:\uffff'), true);
      if (keys.length > EVENTS_MAX) { keys.sort(); for (const k of keys.slice(0, keys.length - EVENTS_MAX)) st.delete(k); }
    });
    scheduleChanged();
  } catch { /* stats are best effort */ }
}

/** peak open tabs / list size, called from the snapshot alarm (counts only) */
let peakDay = 0; let peakSeen = 0;
export async function tick(openTabs, listSize) {
  if (!(await ensure())) return;
  try {
    const dk = 'd:' + dayKey(nowOf());
    if (peakDay === dk && openTabs <= peakSeen) return; // nothing new today: no write
    if (peakDay !== dk) { peakDay = dk; peakSeen = 0; }
    peakSeen = Math.max(peakSeen, openTabs);
    await db.actTx(async (st) => {
      const day = (await idbGet(st, dk)) || emptyDay(dk);
      day.pk = Math.max(day.pk || 0, openTabs | 0);
      if (listSize != null) day.ls = listSize;
      st.put(day);
    });
  } catch { /* ignore */ }
}

let changedTimer = 0;
function scheduleChanged() {
  if (changedTimer) return;
  changedTimer = setTimeout(() => { changedTimer = 0; post({ type: 'activity:changed' }); }, 1000);
}

/** Retention: day rows older than retentionDays go; the `h` array only lives H_KEEP_DAYS. Called from the daily maintenance. */
export async function prune(now = nowOf()) {
  if (!(await ensure())) return { removed: 0 };
  try {
    return await db.actTx(async (st) => {
      let removed = 0;
      const hCut = 'd:' + dayKey(now - H_KEEP_DAYS * 86400000);
      const rows = await idbAll(st, IDBKeyRange.bound('d:', 'd:\uffff'));
      const cut = A.retentionDays > 0 ? 'd:' + dayKey(now - A.retentionDays * 86400000) : null;
      for (const r of rows) {
        if (cut && r.k < cut) { st.delete(r.k); removed++; } else if (r.h && r.k < hCut) { delete r.h; st.put(r); }
      }
      if (cut) st.delete(IDBKeyRange.bound('w:', 'w:' + weekKey(now - A.retentionDays * 86400000), false, true));
      return { removed };
    });
  } catch { return { removed: 0 }; }
}

// ---------- RAM calibration ----------
/** After a sweep / stash freed n >= 3 tabs: compare available memory now and 5 s later; EWMA(0.2) into meta.ramCal, clamped 20..600 MB per tab. */
export async function calibrate(n, availBefore) {
  if (!(await ensure()) || !A.calibrate || n < 3 || !(availBefore > 0)) return;
  setTimeout(async () => {
    try {
      if (!A.on || purging) return; // switched off (or purged) during the 5 s wait: record nothing
      const info = await chrome.system.memory.getInfo();
      const delta = (info.availableCapacity - availBefore) / 1048576;
      const per = Math.min(600, Math.max(20, delta / n));
      await db.metaQuiet(async (m) => { const prev = m.ramCal && m.ramCal.v; m.ramCal = { v: Math.round(prev ? prev * 0.8 + per * 0.2 : per), n: ((m.ramCal && m.ramCal.n) || 0) + 1 }; });
    } catch { /* ignore */ }
  }, 5000);
}
export async function availNow() {
  try { return (await chrome.system.memory.getInfo()).availableCapacity; } catch { return 0; }
}
export async function ramReset() { await db.metaQuiet(async (m) => { delete m.ramCal; }); }
export async function ramInfo() { const m = await db.getMeta(); return { mb: (m.ramCal && m.ramCal.v) || RAM_DEFAULT_MB, calibrated: !!m.ramCal, samples: (m.ramCal && m.ramCal.n) || 0 }; }

// ---------- stats / export / purge ----------
export async function stats() {
  const c = await db.actCounts();
  let fsN = 0;
  try { const r = await chrome.storage.session.get('fs'); fsN = Object.keys(r.fs || {}).length; } catch { /* ignore */ }
  return { ...c, trackingNow: fsN, on: A.on };
}

export async function exportAll() {
  const rows = await db.actDumpAll();
  return { app: 'clean-my-ram', kind: 'activity-stats', exportedAt: nowOf(), days: rows.filter((r) => r.k.startsWith('d:')), weeks: rows.filter((r) => r.k.startsWith('w:')), events: rows.filter((r) => r.k.startsWith('e:')) };
}

let purging = false;
export function isPurging() { return purging; }

/** Strip `f` (first-seen) from every crash-recovery snapshot (they are gzip blobs). */
async function purgeSnapshots() {
  const list = await db.snapList();
  for (const m of list) {
    const rec = await db.snapGet(m.id);
    if (!rec || !rec.gz) continue;
    const body = await gunzipJson(rec.gz);
    const tabs = body && body.tabs;
    if (!Array.isArray(tabs) || !tabs.some((t) => t && t.f !== undefined)) continue;
    for (const t of tabs) if (t) delete t.f;
    rec.gz = await gzipJson(body);
    await db.snapPut(rec);
  }
}

/** Runs (or resumes) the purge job. `ex` serialises each step with the other writers. */
export async function purge(ex = (fn) => fn()) {
  if (purging) return { running: true };
  purging = true;
  try {
    try { await chrome.storage.session.remove(['fs', 'actbuf']); } catch { /* ignore */ }
    await db.actPurgeBegin();
    const total = Math.max(1, await db.totalItemRecords());
    for (let guard = 0; guard < 100000; guard++) {
      const r = await ex(() => db.actPurgeStep(2000));
      post({ type: 'act:purgeProgress', done: r.done, total, phase: r.phase });
      if (r.finished) break;
    }
    await purgeSnapshots();
    await db.actPurgeEnd();
    try { await chrome.storage.session.remove(['fs', 'actbuf']); } catch { /* ignore */ }
    post({ type: 'act:purgeProgress', done: total, total, phase: 'done' });
    post({ type: 'activity:changed' });
    return { ok: true };
  } finally { purging = false; }
}

/** SW start: continue an interrupted purge */
export async function resumePurge(ex) {
  try { const m = await db.getMeta(); if (m.purgeJob) return purge(ex); } catch { /* ignore */ }
  return null;
}
