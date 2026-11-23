// PURE functions (no chrome.*). Safe to import from the service worker, the page and node tests.

export function id() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/** Sort key of an item title for the flat view's byTk index (lower-cased, bounded; the url when the title is empty). */
export function titleKey(title, url) {
  return String(title || url || '').toLowerCase().slice(0, 64);
}

const DROP_URLS = new Set([
  '',
  'about:blank',
  'chrome://newtab/',
  'chrome://newtab',
  'chrome://new-tab-page/',
  'chrome://new-tab-page',
]);

/** "save" = http/https/file/ftp, "drop" = empty/new-tab (closed unsaved), "keep" = everything else. */
export function classifyUrl(url) {
  const u = String(url == null ? '' : url).trim();
  if (DROP_URLS.has(u.toLowerCase())) return 'drop';
  if (/^(https?|file|ftp):/i.test(u)) return 'save';
  return 'keep';
}

const INTERNAL_SCHEME = /^(chrome|chrome-extension|about|devtools|view-source|edge|chrome-untrusted):/i;

/** Internal/browser page categories used by the `internalPages` setting; null for ordinary pages. */
export function internalCategory(url) {
  const u = String(url == null ? '' : url).trim();
  const l = u.toLowerCase();
  if (DROP_URLS.has(l)) return 'newtab';
  if (!INTERNAL_SCHEME.test(u)) return null;
  if (/^chrome-extension:/i.test(u)) return 'extpages';
  if (/^chrome:\/\/downloads/i.test(u)) return 'downloads';
  if (/^chrome:\/\/extensions/i.test(u)) return 'extensions';
  if (/^chrome:\/\/settings/i.test(u)) return 'settings';
  if (/^chrome:\/\/history/i.test(u)) return 'history';
  return 'other';
}

/** Safe to hand to chrome.tabs.create when restoring (web pages and the internal schemes above). */
export function isRestorableUrl(url) {
  const u = String(url == null ? '' : url).trim();
  return classifyUrl(u) === 'save' || (INTERNAL_SCHEME.test(u) && !DROP_URLS.has(u.toLowerCase()));
}

/** URL identity for duplicate detection: ignores the #fragment and (optionally) utm_* tracking params. */
export function normalizeUrl(url, ignoreUtm = false) {
  const u = String(url == null ? '' : url).trim();
  let o;
  try { o = new URL(u); } catch { return u; }
  o.hash = '';
  if (ignoreUtm) {
    for (const k of [...o.searchParams.keys()]) if (/^utm_/i.test(k)) o.searchParams.delete(k);
  }
  return o.href;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Exact or subdomain match against a list of host entries. */
export function hostMatches(host, list) {
  const h = String(host || '').toLowerCase();
  if (!h || !Array.isArray(list)) return false;
  for (const raw of list) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e) continue;
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

function cleanTitle(t) {
  return String(t == null ? '' : t).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Returns {groups:[{items:[{url,title}]}], skipped}. */
export function parseOneTab(text) {
  const lines = String(text == null ? '' : text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const groups = [];
  let cur = [];
  let skipped = 0;
  const flush = () => {
    if (cur.length) groups.push({ items: cur });
    cur = [];
  };
  for (const raw of lines) {
    if (raw.trim() === '') {
      flush();
      continue;
    }
    const idx = raw.indexOf(' | ');
    let url, title;
    if (idx >= 0) {
      url = raw.slice(0, idx).trim();
      title = raw.slice(idx + 3).trim();
    } else {
      url = raw.trim();
      title = '';
    }
    if (classifyUrl(url) !== 'save') {
      skipped++;
      continue;
    }
    cur.push({ url, title: title || url });
  }
  flush();
  return { groups, skipped };
}

/** groups: [{items:[{url,title}]}] -> OneTab text. */
export function toOneTab(groups) {
  return (groups || [])
    .filter((g) => g && g.items && g.items.length)
    .map((g) => g.items.map((it) => `${it.url} | ${cleanTitle(it.title) || it.url}`).join('\n'))
    .join('\n\n');
}

/** Validates the app's JSON export. Returns {ok, groups, skipped}; groups are normalised. */
export function validateImportJson(obj) {
  const bad = { ok: false, groups: [], skipped: 0 };
  if (!obj || typeof obj !== 'object' || obj.app !== 'clean-my-ram') return bad;
  if (typeof obj.schema !== 'number' || !Array.isArray(obj.groups)) return bad;
  const groups = [];
  let skipped = 0;
  for (const g of obj.groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.items)) {
      skipped++;
      continue;
    }
    const items = [];
    for (const it of g.items) {
      if (!it || typeof it.url !== 'string' || classifyUrl(it.url) !== 'save') {
        skipped++;
        continue;
      }
      const o = {
        url: it.url.trim(),
        title: typeof it.title === 'string' && it.title ? it.title : it.url.trim(),
        ts: typeof it.ts === 'number' && isFinite(it.ts) ? it.ts : 0,
      };
      if (tgOf(it) >= 0) o.tg = it.tg; // optional (tab groups)
      if (svOf(it) >= 0) o.sv = it.sv; // optional (split view pair index)
      items.push(o);
    }
    if (!items.length) continue;
    groups.push({
      title: typeof g.title === 'string' ? g.title : '',
      starred: g.starred === true,
      locked: g.locked === true,
      tabGroups: cleanTabGroups(g.tabGroups),
      ...cleanLook(g),
      items,
    });
  }
  return { ok: true, groups, skipped };
}

/** groups: stored group objects (any order). Returns the export JSON object. */
export function buildExportJson(groups, now) {
  return {
    app: 'clean-my-ram',
    schema: 1,
    exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
    groups: (groups || []).map((g) => ({
      title: g.title || '',
      createdAt: g.createdAt,
      starred: !!g.starred,
      locked: !!g.locked,
      ...cleanLook(g),
      ...(cleanTabGroups(g.tabGroups).length ? { tabGroups: cleanTabGroups(g.tabGroups) } : {}),
      items: g.items.map((it) => ({ url: it.url, title: it.title, ts: it.ts, ...(tgOf(it) >= 0 ? { tg: it.tg } : {}), ...(svOf(it) >= 0 ? { sv: it.sv } : {}) })),
    })),
  };
}

/** Starred groups first, then the rest, each keeping the given (groupOrder) order. */
export function sortDisplay(groups) {
  return groups.filter((g) => g.starred).concat(groups.filter((g) => !g.starred));
}

const p2 = (n) => String(n).padStart(2, '0');

/** dd/mm/yyyy HH:mm (local time) */
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** YYYYMMDD-HHmm (local time), for file names */
export function fmtStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

// ---------- search text ----------
/** Lowercased "title\nurl", capped at 512 chars. Stored on every item as `t`. */
export function searchText(title, url) {
  return (String(title == null ? '' : title) + '\n' + String(url == null ? '' : url)).toLowerCase().slice(0, 512);
}

// ---------- NDJSON (export format v2, also the vault format) ----------
export function ndjsonHeader(now) {
  return JSON.stringify({
    type: 'header', format: 'cmr', version: 2, exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
  });
}

export function ndjsonGroup(g, withTime = false) {
  const tgs = cleanTabGroups(g.tabGroups);
  return JSON.stringify({
    ...(withTime && g.tm ? { tm: g.tm } : {}),
    ...(withTime && g.rc ? { rc: g.rc } : {}),
    ...(tgs.length ? { tabGroups: tgs } : {}),
    type: 'group',
    id: g.id,
    title: g.title || '',
    createdAt: g.createdAt,
    starred: !!g.starred,
    locked: !!g.locked,
    ...cleanLook(g),
    source: g.source || 'import',
    ord: g.ord,
    windowCount: g.windowCount > 1 ? g.windowCount : 1,
    deletedAt: g.deletedAt == null ? null : g.deletedAt,
  });
}

export function ndjsonItem(gid, it, withTime = false) {
  const o = { type: 'item', g: gid, url: it.url, title: it.title, ts: it.ts };
  if (withTime && it.d != null) o.d = it.d; // opt-in only (the 'include time data' box); sync and the default export never carry it
  if (it.w > 0) { o.w = it.w; if (it.ws) o.ws = true; }
  if (tgOf(it) >= 0) o.tg = it.tg;
  if (svOf(it) >= 0) o.sv = it.sv;
  return JSON.stringify(o);
}

/** Returns the parsed object, or null for blank / invalid lines. */
export function parseNdjsonLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** One OneTab text line. */
export function oneTabLine(it) {
  return `${it.url} | ${cleanTitle(it.title) || it.url}`;
}

/** Async generator of lines from a ReadableStream of strings. */
export async function* readLines(stream) {
  const reader = stream.getReader();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let start = 0;
      let i;
      while ((i = buf.indexOf('\n', start)) >= 0) {
        yield buf.slice(start, i).replace(/\r$/, '');
        start = i + 1;
      }
      buf = buf.slice(start);
    }
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

// ---------- Chrome tab groups ----------
export const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const MAX_TAB_GROUPS = 20000;

/** Set look: colour label 1..8 (a hue token index) and one emoji / short symbol. Returns only the valid fields ({} when none). */
export function cleanLook(o) {
  const out = {};
  const c = o && Number(o.color);
  if (Number.isInteger(c) && c >= 1 && c <= 8) out.color = c;
  const e = o && typeof o.emoji === 'string' ? o.emoji.trim() : '';
  if (e && e.length <= 12 && !/[<>&"'\s]/.test(e)) out.emoji = e;
  return out;
}

/** Sanitises a stored tab-group list [{i,title,color,collapsed,windowIdx}] (unknown shapes -> dropped). */
export function cleanTabGroups(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || typeof x !== 'object' || !Number.isInteger(x.i) || x.i < 0 || x.i >= 65536 || seen.has(x.i)) continue;
    seen.add(x.i);
    out.push({
      i: x.i,
      title: typeof x.title === 'string' ? x.title.slice(0, 200) : '',
      color: TAB_GROUP_COLORS.includes(x.color) ? x.color : 'grey',
      collapsed: x.collapsed === true,
      windowIdx: Number.isInteger(x.windowIdx) && x.windowIdx > 0 && x.windowIdx < 1000 ? x.windowIdx : 1,
    });
    if (out.length >= MAX_TAB_GROUPS) break;
  }
  return out;
}

/** A valid split-view pair index (item field `sv`) or -1 (same rule as splitview.js svIndex; kept here so formats.js stays dependency-free). */
export function svOf(it) {
  return it && Number.isInteger(it.sv) && it.sv >= 0 && it.sv < 65536 ? it.sv : -1;
}

/** A valid tab-group index (item field `tg`) or -1. */
export function tgOf(it) {
  return it && Number.isInteger(it.tg) && it.tg >= 0 && it.tg < 65536 ? it.tg : -1;
}

/** Normalises a candidate item. Returns null if it must not be saved. */
export function normItem(it, now) {
  if (!it || typeof it.url !== 'string') return null;
  const url = it.url.trim();
  if (url.length > 65536 || !isRestorableUrl(url)) return null;
  const title = (typeof it.title === 'string' && it.title ? it.title : url).slice(0, 1024);
  const ts = typeof it.ts === 'number' && isFinite(it.ts) && it.ts > 0 ? it.ts : now || Date.now();
  const out = { url, title, ts };
  if (typeof it.w === 'number' && it.w > 0 && it.w < 1000) { out.w = it.w; if (it.ws === true) out.ws = true; }
  if (tgOf(it) >= 0) out.tg = it.tg;
  if (svOf(it) >= 0) out.sv = it.sv; // split view pair index (window-local; a pair = two neighbouring items with the same sv)
  return out;
}
