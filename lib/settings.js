// Settings live in chrome.storage.local['settings'] (tiny). Only the service worker writes them.

import { DEFAULTS, KEYS, SETTINGS_VERSION } from './constants.js';
import { post } from './bus.js';
import { hostMatches } from './formats.js';
import * as lockrt from './lockrt.js';
import { sealJson, openJson } from './lock/rec.js';
import { b64enc, b64dec, b64uEnc, utf8, concat } from './lock/bytes.js';

const ENUMS = {
  language: ['auto', 'th', 'en'], density: ['comfortable', 'compact'], urlDisplay: ['none', 'domain', 'short', 'full'],
  hoverActions: ['hover', 'always'], defaultExpand: ['all', 'newest', 'none'], copyFormat: ['urlTitle', 'titleUrl', 'url', 'markdown', 'rich'],
  singleRestore: ['switch', 'stay'], groupRestore: ['auto', 'new', 'current'], titleClick: ['edit', 'restore'],
  timeDisplay: ['none', 'compact', 'full'], dateCalendar: ['auto', 'be', 'ce'], accent: ['blue', 'teal', 'green', 'orange', 'pink', 'violet'],
};

/**
 * The old per-category object ({newtab, downloads, ...: 'keep'|'save'|'close'}) becomes ONE value. 'keep' (leave untouched) is gone and maps
 * to 'save'; the result is 'close' only when most of the non-new-tab categories were set to 'close'.
 */
export function normalizeInternal(v) {
  if (v === 'save' || v === 'close') return v;
  if (v && typeof v === 'object') {
    const vals = Object.entries(v).filter(([k]) => k !== 'newtab').map(([, x]) => x);
    const closes = vals.filter((x) => x === 'close').length;
    return vals.length && closes > vals.length / 2 ? 'close' : 'save';
  }
  return 'save';
}

// ---------- password lock: excludeSites / whitelist / autoRulesText are stored encrypted (settings.sec) ----------
// While locked, stashing and auto-suspend still honour site rules through a MATCH SET: SHA-256(publicSalt + host), 12 bytes, for the
// host and every parent domain (spec §5). Common hosts can be dictionary-guessed from these hashes; pattern rules do not apply while locked.
const SECRET_KEYS = ['excludeSites', 'whitelist', 'autoRulesText'];
const SEC_ID = 'set:secrets';
async function suffixHashes(salt, host) {
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i < labels.length; i++) out.push(b64uEnc(new Uint8Array(await crypto.subtle.digest('SHA-256', concat(salt, utf8(labels.slice(i).join('.'))))).subarray(0, 12)));
  return out;
}
async function hashEntries(list) {
  const salt = lockrt.publicKey();
  const out = [];
  for (const e of list || []) { const h = String(e || '').trim().toLowerCase(); if (h) out.push((await suffixHashes(salt, h))[0]); }
  return out;
}
async function readSecrets(st) {
  if (!st.sec) return null;
  const keys = lockrt.getKeys();
  if (!keys) return null;
  try { return await openJson(keys.dk, st.sec.k || 0, SEC_ID, b64dec(st.sec.e)); } catch { return null; }
}
async function sealSecrets(obj) {
  const keys = lockrt.getKeys();
  return { k: 0, e: b64enc(await sealJson(keys.dk, 0, SEC_ID, obj)) };
}
/** Locked: which of the open tabs' hosts match the stored hashes (done once per getSettings: the callers are synchronous). */
async function primeLocked(out, st) {
  const ex = new Set(); const wl = new Set();
  out.excludeSites = []; out.autoRulesText = ''; out.autoRulesOn = false; // pattern rules need the key
  try {
    const tabs = await chrome.tabs.query({});
    const salt = lockrt.publicKey();
    const hosts = new Set();
    for (const t of tabs) { try { hosts.add(new URL(t.pendingUrl || t.url || '').hostname.toLowerCase()); } catch { /* not a url */ } }
    for (const h of hosts) {
      if (!h) continue;
      const hs = await suffixHashes(salt, h);
      if (hs.some((x) => (st.exH || []).includes(x))) ex.add(h);
      if (hs.some((x) => (st.wlH || []).includes(x))) wl.add(h);
    }
  } catch { /* no tabs API: nothing matches */ }
  out.exSet = ex; out.wlSet = wl;
}
export const isExcluded = (s, host) => hostMatches(host, s.excludeSites) || !!(s.exSet && s.exSet.has(String(host || '').toLowerCase()));
export const isWhitelisted = (s, host) => hostMatches(host, s.whitelist) || !!(s.wlSet && s.wlSet.has(String(host || '').toLowerCase()));

/** Turn the lock on / off: move the three rule lists in / out of the encrypted blob (needs the key). */
export async function lockSecrets(on) {
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  const st = { ...(r[KEYS.SETTINGS] || {}) };
  if (on) {
    if (!lockrt.getKeys()) return false;
    const cur = (await readSecrets(st)) || {};
    const sec = {};
    for (const k of SECRET_KEYS) sec[k] = k in cur ? cur[k] : (k in st ? st[k] : DEFAULTS[k]);
    st.sec = await sealSecrets(sec);
    st.exH = await hashEntries(sec.excludeSites); st.wlH = await hashEntries(sec.whitelist);
    for (const k of SECRET_KEYS) delete st[k];
  } else {
    const cur = await readSecrets(st);
    if (st.sec && !cur) return false;
    if (cur) Object.assign(st, cur);
    delete st.sec; delete st.exH; delete st.wlH;
  }
  await chrome.storage.local.set({ [KEYS.SETTINGS]: st });
  post({ type: 'settings' });
  return true;
}

export async function getSettings() {
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  const st = r[KEYS.SETTINGS] || {};
  const out = { ...DEFAULTS, ...legacyFill(st), ...st, internalPages: normalizeInternal(st.internalPages) };
  if (st.sec !== undefined || lockrt.enabled()) {
    await lockrt.ensureKeys();
    delete out.sec; delete out.exH; delete out.wlH;
    const sec = await readSecrets(st);
    if (sec) Object.assign(out, sec); else if (lockrt.isLocked()) await primeLocked(out, st);
  }
  return out;
}

/** Old single keys (restoreRemoves, trashDays) seed the new split keys until the v4 migration has rewritten them. */
function legacyFill(st) {
  const o = {};
  if (typeof st.restoreRemoves === 'boolean') {
    if (st.restoreRemovesGroup === undefined) o.restoreRemovesGroup = st.restoreRemoves;
    if (st.restoreRemovesItem === undefined) o.restoreRemovesItem = st.restoreRemoves;
  }
  if (typeof st.trashDays === 'number' && st.trashDaysDeleted === undefined) o.trashDaysDeleted = st.trashDays;
  return o;
}

export function sanitizeSettingsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    const d = DEFAULTS[k];
    if (k === 'internalPages') {
      if (v === 'save' || v === 'close') out[k] = v;
    } else if (k === 'snapshotMinutes') {
      if ([1, 3, 5, 10].includes(Number(v))) out[k] = Number(v);
    } else if (k === 'mediaGraceMin') {
      if ([5, 15, 30, 60, 120].includes(Number(v))) out[k] = Number(v);
    } else if (k === 'mediaEndedMin') {
      if ([0, 5, 15, 30].includes(Number(v))) out[k] = Number(v);
    } else if (k === 'closeDuplicates') {
      if (['off', 'onStash', 'auto'].includes(v)) out[k] = v;
    } else if (k === 'retentionDays') {
      if ([0, 90, 180, 400, 730].includes(Number(v))) out[k] = Number(v);
    } else if (typeof d === 'boolean') out[k] = !!v;
    else if (typeof d === 'number') {
      const n = Number(v);
      if (isFinite(n) && n >= 0) out[k] = n;
    } else if (Array.isArray(d)) {
      if (Array.isArray(v)) {
        out[k] = [...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
      }
    } else if (k === 'theme') {
      if (['auto', 'light', 'dark', 'time'].includes(v)) out[k] = v; // 'time' = light by day, dark at night
    } else if (k === 'stashGrouping') {
      if (['window', 'session'].includes(v)) out[k] = v;
    } else if (k === 'iconScope') {
      if (['window', 'all'].includes(v)) out[k] = v;
    } else if (k === 'restoreMode') {
      if (['auto', 'sequential', 'fast', 'loadAll'].includes(v)) out[k] = v;
    } else if (ENUMS[k]) {
      if (ENUMS[k].includes(v)) out[k] = v;
    } else if (k === 'iconClickAction') {
      if (['stash', 'popup'].includes(v)) out[k] = v;
    } else out[k] = String(v);
  }
  return out;
}

export async function saveSettings(patch) {
  const clean = sanitizeSettingsPatch(patch);
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  const prev = r[KEYS.SETTINGS] || {};
  const next = { ...prev, ...clean };
  if (lockrt.enabled() || prev.sec !== undefined) {
    const hit = SECRET_KEYS.filter((k) => k in clean);
    if (hit.length) {
      await lockrt.ensureKeys();
      if (!lockrt.getKeys()) return { error: 'locked' };
      const sec = { ...((await readSecrets(prev)) || {}) };
      for (const k of hit) sec[k] = clean[k];
      next.sec = await sealSecrets(sec);
      next.exH = await hashEntries(sec.excludeSites); next.wlH = await hashEntries(sec.whitelist);
      for (const k of SECRET_KEYS) delete next[k];
    }
  }
  await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  post({ type: 'settings' });
  return {};
}

export async function ensureInstallSettings() {
  const r = await chrome.storage.local.get(KEYS.SETTINGS);
  const st = r[KEYS.SETTINGS];
  if (!st) {
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...DEFAULTS, settingsVersion: SETTINGS_VERSION } });
    return;
  }
  const ver = st.settingsVersion || 0;
  if (ver < SETTINGS_VERSION) {
    const next = { ...st, settingsVersion: SETTINGS_VERSION };
    // v2 (once): the new defaults for iconScope and stashGrouping
    if (ver < 2) { next.iconScope = DEFAULTS.iconScope; next.stashGrouping = DEFAULTS.stashGrouping; }
    // v3 (once): the per-category internal-pages object becomes ONE choice ('keep' -> 'save', see normalizeInternal)
    next.internalPages = normalizeInternal(st.internalPages);
    // v4 (once): restoreRemoves -> restoreRemovesGroup + restoreRemovesItem, trashDays -> trashDaysDeleted
    Object.assign(next, legacyFill(st));
    await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
  }
}

export async function toggleWhitelist(host) {
  const s = await getSettings();
  const h = String(host || '').toLowerCase();
  if (!h) return { error: 'nohost' };
  if (lockrt.isLocked()) return { error: 'locked' };
  const list = s.whitelist.includes(h) ? s.whitelist.filter((x) => x !== h) : s.whitelist.concat(h);
  await saveSettings({ whitelist: list });
  return { whitelisted: list.includes(h) };
}
