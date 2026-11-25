// Backup file ("Export all as a file", .cmr.ndjson) format 3. PURE (no chrome.*, no DOM): the page builds and reads it, node tests check it.
//
// One JSON object per line, UTF-8. Older files (version 2: header + group + item lines only; version 1 JSON; OneTab text) still import.
//   {"type":"header","format":"cmr","version":3,"exportedAt":...,"scope":"full"}
//   {"type":"settings","v":<SETTINGS_VERSION>,"values":{...every setting}}                  all of lib/constants.js DEFAULTS, sanitised again on import
//   {"type":"prefs","view":{...},"print":{...},"emoji":[...],"exp":{...},"isort":{...}}      saved list view + page preferences
//   {"type":"category","id","name","color","ord","createdAt"}                                one per category
//   {"type":"group",...}  {"type":"item",...}                                                tab sets (live, archived and deleted ones) and their tabs
//   {"type":"trash","g","deletedAt","delReason","items":[{url,title,ts,...}]}                recoverable single tabs of the trash
//   {"type":"end","counts":{...}}                                                            a file without it was cut short (a warning, nothing is dropped)
//
// What a file never holds: the password lock (keys, wrappers, policy; locked data has its own encrypted .tabroost archive), the sync
// configuration (passphrase, folder, device id, scope), granted permissions, per-tab overrides, caches (search index, favicons),
// crash-recovery snapshots, and the usage statistics unless the "include time data" box is ticked (the d / tm / rc fields only).
// Everything read from a file is untrusted: sizes are capped, strings are cut, unknown fields and line types are ignored, nothing is run.
import { DEFAULTS, SETTINGS_VERSION } from './constants.js';
import { cleanView, cleanPrint, cleanEmojiRecent } from './sync/prefs.js';
import { normItem, cleanLook, TAB_GROUP_COLORS } from './formats.js';

export const BACKUP_VERSION = 3;
export const MAX_LINE = 4 * 1024 * 1024; // a longer line is skipped, not parsed
export const MAX_CATEGORIES = 500;
export const MAX_TRASH_ROW_ITEMS = 20000;
export const TRASH_LINE_ITEMS = 2000; // export splits a bigger trash row into several lines
export const MAX_EXP = 5000;
export const MAX_ISORT = 2000;
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const line = (o) => JSON.stringify(o);

export function backupHeader(now) {
  return line({ type: 'header', format: 'cmr', version: BACKUP_VERSION, exportedAt: new Date(now == null ? Date.now() : now).toISOString(), scope: 'full' });
}
/** values = the settings object (getSettings()). Only keys that exist in DEFAULTS are written. */
export function settingsLine(values) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (values && values[k] !== undefined) out[k] = values[k];
  return line({ type: 'settings', v: SETTINGS_VERSION, values: out });
}
/** p = {view, print, emoji, exp, isort} (any may be missing). */
export function prefsLine(p) {
  p = p || {};
  return line({ type: 'prefs', view: cleanView(p.view), print: cleanPrint(p.print), emoji: cleanEmojiRecent(p.emoji), exp: cleanExp(p.exp), isort: cleanIsort(p.isort) });
}
export function categoryLine(c) {
  return line({ type: 'category', id: c.id, name: c.name || '', color: c.color || 'blue', ord: typeof c.ord === 'number' ? c.ord : 0, createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0 });
}
/** One trash row (decoded) -> 1+ lines. */
export function trashLines(row) {
  const items = (row.items || []).map((it) => ({ url: it.url, title: it.title, ts: it.ts, ...(it.w > 0 ? { w: it.w, ...(it.ws ? { ws: true } : {}) } : {}), ...(Number.isInteger(it.tg) && it.tg >= 0 ? { tg: it.tg } : {}), ...(Number.isInteger(it.sv) && it.sv >= 0 ? { sv: it.sv } : {}) }));
  const out = [];
  for (let i = 0; i < items.length || (!i && !items.length); i += TRASH_LINE_ITEMS) {
    out.push(line({ type: 'trash', g: row.g, deletedAt: row.deletedAt, delReason: row.delReason === 'opened' ? 'opened' : 'deleted', items: items.slice(i, i + TRASH_LINE_ITEMS) }));
    if (!items.length) break;
  }
  return out;
}
export const endLine = (counts) => line({ type: 'end', counts });

// ---------- reading (untrusted) ----------
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Settings values from a file: only known keys; the caller sends them through lib/settings.js sanitizeSettingsPatch (the same rules as the settings page). */
export function readSettings(o) {
  const out = {};
  const vals = o && typeof o === 'object' && o.values && typeof o.values === 'object' && !Array.isArray(o.values) ? o.values : null;
  if (!vals) return out;
  for (const k of Object.keys(DEFAULTS)) if (Object.prototype.hasOwnProperty.call(vals, k)) out[k] = vals[k];
  return out;
}
export function cleanExp(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) { if (n >= MAX_EXP) break; if (ID_RE.test(k)) { out[k] = 0; n++; } }
  return out;
}
/** Per-set item sorting {setId: [key, dir]} (page localStorage 'cmr.isort'). */
export function cleanIsort(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= MAX_ISORT) break;
    const x = v[k];
    if (!ID_RE.test(k) || !Array.isArray(x) || x.length !== 2) continue;
    if (typeof x[0] !== 'string' || !/^[A-Za-z]{1,16}$/.test(x[0]) || (x[1] !== 'asc' && x[1] !== 'desc')) continue;
    out[k] = [x[0], x[1]];
    n++;
  }
  return out;
}
export function readPrefs(o) {
  o = o && typeof o === 'object' ? o : {};
  return { view: cleanView(o.view), print: cleanPrint(o.print), emoji: cleanEmojiRecent(o.emoji), exp: cleanExp(o.exp), isort: cleanIsort(o.isort) };
}
/** A category line -> {id,name,color,ord,createdAt} or null. */
export function readCategory(o) {
  if (!o || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  const name = str(o.name, 80).trim();
  return { id: o.id, name: name || '', color: TAB_GROUP_COLORS.includes(o.color) ? o.color : 'blue', ord: num(o.ord) ?? 0, createdAt: num(o.createdAt) ?? 0 };
}
/**
 * A group line -> the meta the importer sends (always a complete, sanitised object). `cats` = id -> id map of the categories of this file
 * (the importer maps them to local ones); a category the file does not describe is dropped (the set simply has no category).
 */
export function readGroup(o, cats) {
  const m = {
    title: str(o.title, 500), starred: o.starred === true, locked: o.locked === true,
    pinned: o.pinned === true, pending: o.pending === true, archived: o.archived === true,
    ...cleanLook(o),
  };
  if (typeof o.id === 'string' && ID_RE.test(o.id)) m.id = o.id;
  const ca = num(o.createdAt); if (ca !== undefined && ca > 0) m.createdAt = ca;
  const ord = num(o.ord); if (ord !== undefined) m.ord = ord;
  const wc = num(o.windowCount); if (wc !== undefined && wc > 1 && wc < 1000) m.windowCount = Math.floor(wc);
  const del = num(o.deletedAt); if (del !== undefined && del > 0) { m.deletedAt = del; if (o.delReason === 'opened') m.delReason = 'opened'; }
  const note = str(o.note, 2000); if (note) m.note = note;
  if (typeof o.cat === 'string' && cats && cats.has(o.cat)) m.cat = o.cat;
  if (Array.isArray(o.tabGroups)) m.tabGroups = o.tabGroups; // cleaned again by the database layer (cleanTabGroups)
  return m;
}
/** A trash line -> {g, deletedAt, delReason, items} or null. Items go through normItem (url rules, caps). */
export function readTrash(o, now) {
  if (!o || !Array.isArray(o.items)) return null;
  const items = [];
  for (const it of o.items) { const n = normItem(it, now); if (n) items.push(n); if (items.length >= MAX_TRASH_ROW_ITEMS) break; }
  if (!items.length) return null;
  const at = num(o.deletedAt);
  return { g: typeof o.g === 'string' && ID_RE.test(o.g) ? o.g : null, deletedAt: at !== undefined && at > 0 ? at : (now || Date.now()), delReason: o.delReason === 'opened' ? 'opened' : 'deleted', items };
}
