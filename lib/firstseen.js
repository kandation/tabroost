// "Opened at" for tabs WITHOUT any new listener: runs inside the existing snapshot alarm (one tabs.query is already done there).
// Map `fs` lives in chrome.storage.session: { [tabId]: { f: minutes since epoch (first seen), u: 32-bit url hash, x?: 1 exact (precise mode), z?: minutes (frozen since) } }.
// Error is up to one alarm period (+3 min); tabs that already existed at install / restart only get a lower bound, so every value is "approximate" unless x.
// All of it is skipped when activityTracking is off (and `fs` is deleted by the settings handler).

import { A, ensure, lastAccessedOf } from './activity.js';

export const FS_KEY = 'fs';

const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const urlHash = (u) => fnv(String(u || ''));
const minOf = (ms) => Math.floor(ms / 60000);

/**
 * Browser restart (tab ids are new): match the current tabs against the newest snapshot by url hash.
 * prev: [{u, f}] (snapshot tabs), cur: [{id, u, la}] (la = lastAccessed minutes or 0). Duplicate urls: each current tab takes the OLDEST unused f.
 * Returns { [id]: {f, u} }; unmatched tabs get min(now, lastAccessed).
 */
export function rematch(prev, cur, nowMin) {
  const mm = new Map();
  for (const p of prev) { if (!p || !p.f) continue; let a = mm.get(p.u); if (!a) mm.set(p.u, (a = [])); a.push(p.f); }
  for (const a of mm.values()) a.sort((x, y) => x - y);
  const out = {};
  for (const t of cur) {
    const a = mm.get(t.u);
    if (a && a.length) out[t.id] = { f: a.shift(), u: t.u };
    else out[t.id] = { f: Math.min(nowMin, t.la || nowMin), u: t.u };
  }
  return out;
}

async function snapshotPrev(db, gunzip) {
  try {
    const list = await db.snapList();
    const m = list.find((x) => (x.kind || 'auto') === 'auto') || list[0];
    if (!m) return [];
    const rec = await db.snapGet(m.id);
    const body = rec && rec.gz ? await gunzip(rec.gz) : null;
    return ((body && body.tabs) || []).filter((t) => t.f).map((t) => ({ u: urlHash(t.url), f: t.f }));
  } catch { return []; }
}

/** Called from the snapshot alarm with the tabs it already queried. Returns the fs map (or null when tracking is off). */
export async function observe(tabs, now, db, gunzip) {
  if (!(await ensure())) return null;
  const nowMin = minOf(now);
  let m;
  try { m = (await chrome.storage.session.get(FS_KEY))[FS_KEY]; } catch { return null; }
  let changed = false;
  const live = tabs.filter((t) => !t.incognito).map((t) => ({ id: t.id, u: urlHash(t.pendingUrl || t.url), la: minOf(lastAccessedOf(t)) }));
  if (!m) {
    m = rematch(await snapshotPrev(db, gunzip), live, nowMin);
    changed = true;
  } else {
    const seen = new Set();
    for (const t of live) {
      seen.add(String(t.id));
      const e = m[t.id];
      if (!e) { m[t.id] = { f: Math.min(nowMin, t.la || nowMin), u: t.u }; changed = true; } else if (e.u !== t.u) { e.u = t.u; changed = true; }
    }
    for (const k of Object.keys(m)) if (!seen.has(k)) { delete m[k]; changed = true; }
  }
  if (changed) { try { await chrome.storage.session.set({ [FS_KEY]: m }); } catch { /* ignore */ } }
  return m;
}

export async function load() {
  if (!(await ensure())) return null;
  try { return (await chrome.storage.session.get(FS_KEY))[FS_KEY] || {}; } catch { return {}; }
}

/** auto-suspend discarded this tab: remember since when (live only, never stored on items) */
export async function markFrozen(tabId) {
  if (!A.on) return;
  try {
    const m = (await chrome.storage.session.get(FS_KEY))[FS_KEY];
    if (m && m[tabId] && !m[tabId].z) { m[tabId].z = minOf(Date.now()); await chrome.storage.session.set({ [FS_KEY]: m }); }
  } catch { /* ignore */ }
}

/** Popup list: tabs asleep right now with how long (from fs[tabId].z, live only: never stored on items). Empty when activity tracking is OFF. */
export async function sleepingList(max = 6) {
  if (!A.on) return [];
  const tabs = (await chrome.tabs.query({ discarded: true })).filter((t) => !t.incognito);
  const m = (await chrome.storage.session.get(FS_KEY))[FS_KEY] || {};
  return tabs.map((t) => ({ id: t.id, title: String(t.title || t.url || '').slice(0, 200), z: m[t.id] && m[t.id].z ? m[t.id].z * 60000 : 0 })).filter((t) => t.z).sort((a, b) => a.z - b.z).slice(0, max);
}

// ---------- precise mode (preciseOpenTime): exact opening time from tabs.onCreated ----------
// The listener is registered synchronously at the SW top level (MV3 requirement) and removed again after init when the mode is OFF,
// so with the mode OFF tab creation does not run any code of ours. When ON the handler only stores a timestamp in memory;
// a debounced flush (2 s) merges the entries into `fs` as exact ones ({x: 1}). Nothing goes to IndexedDB.
const buf = {};
let flushTimer = 0;
export function noteCreated(tab) {
  if (!A.on || !A.precise || !tab || tab.incognito || tab.id == null) return;
  buf[tab.id] = { t: Date.now(), u: urlHash(tab.pendingUrl || tab.url) };
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = 0; flushCreated().catch(() => {}); }, 2000);
}
export async function flushCreated() {
  const ids = Object.keys(buf);
  if (!ids.length) return;
  const take = {}; for (const k of ids) { take[k] = buf[k]; delete buf[k]; }
  if (!A.on || !A.precise) return;
  try {
    const m = (await chrome.storage.session.get(FS_KEY))[FS_KEY] || {};
    for (const k of ids) m[k] = { f: minOf(take[k].t), u: take[k].u, x: 1 };
    await chrome.storage.session.set({ [FS_KEY]: m });
  } catch { /* ignore */ }
}
/** drop buffered timestamps (tracking switched off) */
export function dropBuffer() { for (const k of Object.keys(buf)) delete buf[k]; }
