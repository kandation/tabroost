// Preferences as ONE synced entity (kind 's', id 'prefs'). Pure: no chrome.*, no IndexedDB, so node tests run it.
//
// Fields of the entity (each is its own last-writer-wins register, so two devices changing different settings never overwrite each other):
//   s:<settingKey>   one setting from lib/constants.js DEFAULTS, except the device-specific ones listed in SETTINGS_SYNC_EXCLUDE
//   p:view           the saved list view (sort / group / flat view), chrome.storage.local 'view'
//   p:print          print dialog options                        (page localStorage 'cmr.printOpts', mirrored by lib/prefs.js)
//   p:emoji          recently used emoji of the set look dialog  (page localStorage 'cmr.emojiRecent', mirrored by lib/prefs.js)
//
// NEVER synced (device-specific or secret): see SETTINGS_SYNC_EXCLUDE, the sync configuration itself (passphrase, scope, budget, device
// name), the password lock (policy, keys, wrappers), granted browser permissions, per-tab overrides (tab ids are meaningless elsewhere),
// the per-set expand / item-sort state (localStorage 'cmr.exp', 'cmr.isort': per-device view state), banner dismissals, favicon mode.
//
// "Sync settings too" (cfg.syncSettings): OFF = nothing is sent and incoming values are ignored (their versions are still noted, so
// turning it ON replays the other devices' log, see engine.replay). ON again = the current local values are published as the newest.
import { DEFAULTS } from '../constants.js';

export const PREFS_ID = 'prefs';
export const PREFS_KIND = 's';

/** Settings that only make sense on one computer (or are opt-ins that must stay a per-computer choice). Not synced, whatever the toggle. */
export const SETTINGS_SYNC_EXCLUDE = {
  lowMemThresholdMin: 'measured against this computer\'s memory', lowMemRatio: 'measured against this computer\'s memory',
  restoreChunk: 'depends on this computer\'s speed', restoreMode: 'depends on this computer\'s speed',
  favMode: 'how this browser stores icons',
  shortcutsOn: 'keyboard shortcuts are per device', kbSearch: 'keyboard shortcuts are per device', kbPalette: 'keyboard shortcuts are per device',
  kbUndo: 'keyboard shortcuts are per device', kbRename: 'keyboard shortcuts are per device', kbSelect: 'keyboard shortcuts are per device', kbDelete: 'keyboard shortcuts are per device',
  autoSnapshot: 'crash recovery of this browser', snapshotMinutes: 'crash recovery of this browser',
  activityTracking: 'usage statistics stay a per-device opt-in', preciseOpenTime: 'usage statistics stay a per-device opt-in', retentionDays: 'usage statistics stay a per-device opt-in', ramCalibrate: 'measured on this computer',
};

export const isSyncableSetting = (k) => Object.prototype.hasOwnProperty.call(DEFAULTS, k) && !Object.prototype.hasOwnProperty.call(SETTINGS_SYNC_EXCLUDE, k);
export const SYNCABLE_SETTING_KEYS = Object.keys(DEFAULTS).filter(isSyncableSetting);

// ---------- values kept outside `settings` ----------
const VIEW_SORT = ['created', 'createdAsc', 'mtime', 'lastRestored', 'title', 'count', 'sites', 'manual'];
const VIEW_GROUP = ['calendar', 'slot', 'site', 'tabgroup', 'count', 'category', 'none'];
const VIEW_SLOT = ['wdHour', 'hour', 'weekday', 'dom', 'partOfDay'];
const ITEM_SORT = ['stash', 'title', 'site', 'visited'];
/** The saved list view (same rules the service worker applies to 'saveView'). Always returns a complete, valid object. */
export function cleanView(v) {
  v = v && typeof v === 'object' ? v : {};
  return {
    sort: VIEW_SORT.includes(v.sort) ? v.sort : 'created',
    starredFirst: !!v.starredFirst,
    groupBy: VIEW_GROUP.includes(v.groupBy) ? v.groupBy : 'calendar',
    slotMode: VIEW_SLOT.includes(v.slotMode) ? v.slotMode : 'wdHour',
    itemSort: ITEM_SORT.includes(v.itemSort) ? v.itemSort : 'stash',
    itemDir: v.itemDir === 'desc' ? 'desc' : 'asc',
    sortRev: !!v.sortRev,
    flat: !!v.flat,
    flatSort: ITEM_SORT.includes(v.flatSort) ? v.flatSort : 'stash',
    flatDir: v.flatDir === 'asc' ? 'asc' : 'desc',
  };
}
/** Print dialog options: booleans only, known keys only. */
export function cleanPrint(v) {
  const out = { urls: true, split: true, qr: false };
  if (v && typeof v === 'object') for (const k of Object.keys(out)) if (typeof v[k] === 'boolean') out[k] = v[k];
  return out;
}
export const EMOJI_RECENT_MAX = 24;
/** Recent emoji: short strings without markup characters, at most 24. */
export function cleanEmojiRecent(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const e = x.trim();
    if (!e || e.length > 12 || /[<>&"'\s]/.test(e) || out.includes(e)) continue;
    out.push(e);
    if (out.length >= EMOJI_RECENT_MAX) break;
  }
  return out;
}

// ---------- fields ----------
const EXTRA = { 'p:view': cleanView, 'p:print': cleanPrint, 'p:emoji': cleanEmojiRecent };
export const isPrefField = (f) => (f.startsWith('s:') ? isSyncableSetting(f.slice(2)) : Object.prototype.hasOwnProperty.call(EXTRA, f));

/** Default of a field: what "never touched" means (a default is not a change, so a fresh device never overwrites the others). */
export function fieldDefault(f) {
  if (f.startsWith('s:')) return DEFAULTS[f.slice(2)];
  if (f === 'p:view') return cleanView({});
  if (f === 'p:print') return cleanPrint({});
  return [];
}
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/**
 * Local state -> field map. `local` = { settings, view?, print?, emoji? } (settings = the merged object getSettings() returns).
 * Values of fields that are absent locally are the defaults.
 */
export function collectFields(local) {
  const out = {};
  const st = (local && local.settings) || {};
  for (const k of SYNCABLE_SETTING_KEYS) out['s:' + k] = st[k] !== undefined ? st[k] : DEFAULTS[k];
  out['p:view'] = cleanView(local && local.view);
  out['p:print'] = cleanPrint(local && local.print);
  out['p:emoji'] = cleanEmojiRecent(local && local.emoji);
  return out;
}

/** Fields that changed since `prev` (the last synced map). With no `prev` (never synced) only values that differ from the default are sent. */
export function diffFields(prev, cur) {
  const d = {};
  for (const k of Object.keys(cur)) {
    if (prev) { if (!same(prev[k] !== undefined ? prev[k] : fieldDefault(k), cur[k])) d[k] = cur[k]; } else if (!same(fieldDefault(k), cur[k])) d[k] = cur[k];
  }
  return d;
}

/**
 * Remote fields -> a local patch {settings, view, print, emoji}. Unknown / excluded fields are dropped (a peer can send anything: only
 * the names above are ever applied) and every value goes through the same sanitiser as local input. `sanitizeSettings` = lib/settings.js.
 */
export function toLocalPatch(fields, sanitizeSettings) {
  const settings = {};
  const out = {};
  for (const [f, v] of Object.entries(fields || {})) {
    if (typeof f !== 'string' || !isPrefField(f)) continue;
    if (f.startsWith('s:')) settings[f.slice(2)] = v;
    else if (f === 'p:view') out.view = cleanView(v);
    else if (f === 'p:print') out.print = cleanPrint(v);
    else if (f === 'p:emoji') out.emoji = cleanEmojiRecent(v);
  }
  if (Object.keys(settings).length) {
    const clean = sanitizeSettings ? sanitizeSettings(settings) : settings;
    for (const k of Object.keys(clean)) if (!isSyncableSetting(k)) delete clean[k];
    if (Object.keys(clean).length) out.settings = clean;
  }
  return out;
}

/**
 * The preferences sync glue.
 *   io.read()  -> {settings, view, print, emoji}                    current local values
 *   io.write(patch)                                                 applies a toLocalPatch() result locally (sanitised; applies side effects)
 *   getV() / setV(map)                                              last synced field map (the baseline of the next diff)
 *   isOn()                                                          cfg.syncSettings
 *   resetMeta()                                                     forgets the field versions and the baseline of the entity
 * `engine` = lib/sync/engine.js (stamp / recordLocal / replay).
 */
export function createPrefsSync({ engine, io, getV, setV, isOn, resetMeta, sanitizeSettings }) {
  /** Local change -> op. No-op while the toggle is off. @returns {Promise<number>} ops recorded */
  async function scan() {
    if (!isOn()) return 0;
    const cur = collectFields(await io.read());
    const prev = await getV();
    const diff = diffFields(prev || null, cur);
    const n = Object.keys(diff).length;
    if (n) await engine.recordLocal([engine.stamp(PREFS_KIND, PREFS_ID, diff)]);
    if (n || !prev) await setV(cur);
    return n ? 1 : 0;
  }
  /** Remote winning fields -> local. Called by the merge store; ignored while the toggle is off. The baseline follows the applied values, so nothing echoes back. */
  async function apply(fields) {
    if (!isOn()) return false;
    const patch = toLocalPatch(fields, sanitizeSettings);
    if (!Object.keys(patch).length) return false;
    await io.write(patch);
    const after = collectFields(await io.read());
    const base = (await getV()) || {};
    const next = { ...base };
    for (const f of Object.keys(fields || {})) if (isPrefField(f)) next[f] = after[f];
    await setV(next);
    return true;
  }
  /** Toggle turned ON: this device's current values become the newest, then the other devices' log is read again so their values fill the rest. */
  async function enable() {
    await resetMeta();
    await scan();
    await engine.replay();
  }
  return { scan, apply, enable };
}
