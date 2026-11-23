// Labels for the time tokens of the list page (item rows, tab-set header chips, hover cards). Pure functions: the page passes its
// string table (STR), the language ('th' | 'en') and the calendar choice. Item `d` / group `tm` come from lib/activity.js.

import { unpackD, fmtDur, fmtAgo, fmtAbs, calendarName } from './time.js';

const MIN = 60000;

/** minutes since the item was last used (null when unknown). Exact: ts - idle. */
export function lastUsedMs(rec) {
  const u = unpackD(rec.d);
  return u && u.idle != null ? (rec.ts || 0) - u.idle * MIN : null;
}

/**
 * Right-aligned token of an item row. Returns { text, t, k, light, tip } or null (mode 'none').
 * t = reference time (ms) for the ticker, k = 'u' (duration since t). light = fallback to the age in the list.
 */
export function itemToken(rec, now, mode, lang, S) {
  if (mode === 'none') return null;
  const lu = lastUsedMs(rec);
  if (mode === 'full') {
    const u = unpackD(rec.d);
    const parts = [];
    if (lu != null) parts.push(S.tmUsed(fmtDur((now - lu) / MIN, lang)));
    else parts.push(S.tmSaved(fmtDur((now - (rec.ts || now)) / MIN, lang)));
    if (u && u.life != null) { const opened = (rec.ts || 0) - u.life * MIN; parts.push(S.tmOpenFor((u.approx ? '~' : '') + fmtDur((now - opened) / MIN, lang, true))); }
    return { text: parts.join(' · '), t: lu != null ? lu : (rec.ts || now), k: 'f', light: lu == null, ref2: u && u.life != null ? (rec.ts || 0) - u.life * MIN : 0, ap: u ? u.approx : false };
  }
  if (lu != null) return { text: fmtDur((now - lu) / MIN, lang), t: lu, k: 'u', light: false };
  return { text: fmtDur((now - (rec.ts || now)) / MIN, lang), t: rec.ts || now, k: 'u', light: true };
}

/** relabel a ticker element from its data-* (used by the minute ticker: no layout change, textContent only when it differs) */
export function relabel(el, now, lang, S) {
  const t = Number(el.dataset.t);
  if (!t) return null;
  const k = el.dataset.k;
  if (k === 'u') return fmtDur((now - t) / MIN, lang);
  if (k === 'a') return fmtAgo(now - t, lang);
  if (k === 'f') {
    const parts = [el.dataset.l === '1' ? S.tmSaved(fmtDur((now - t) / MIN, lang)) : S.tmUsed(fmtDur((now - t) / MIN, lang))];
    const o = Number(el.dataset.o);
    if (o) parts.push(S.tmOpenFor((el.dataset.p === '1' ? '~' : '') + fmtDur((now - o) / MIN, lang, true)));
    return parts.join(' · ');
  }
  return null;
}

/** Extra chips of a tab-set header (full mode: last used; pinned/locked with restores: opened N times). */
export function groupChips(g, now, mode, lang, S) {
  const out = [];
  if (mode === 'full' && g.tm && g.tm.luMax) out.push({ k: 'a', t: g.tm.luMax * MIN, text: S.chipLastUsed(fmtDur((now - g.tm.luMax * MIN) / MIN, lang)) });
  if ((g.locked || g.pinned) && (g.rc || 0) >= 1) out.push({ k: '', t: 0, text: S.chipOpened(g.rc) });
  return out;
}

const row = (label, abs, rel, approx, S) => ({ label, value: (approx ? '~' : '') + abs + (rel ? ' (' + rel + ')' : ''), tip: approx ? S.tmApproxTip : '' });

/** Hover card of one item: [{label, value, tip}] */
export function itemCard(rec, g, now, lang, cal, S) {
  const c = calendarName(cal);
  const rows = [];
  const ts = rec.ts || 0;
  rows.push(row(S.hcSaved, fmtAbs(ts, lang, c), fmtAgo(now - ts, lang), false, S));
  const u = unpackD(rec.d);
  if (u && u.idle != null) { const lu = ts - u.idle * MIN; rows.push(row(S.hcLastUsed, fmtAbs(lu, lang, c), fmtAgo(now - lu, lang), false, S)); }
  if (u && u.life != null) { const op = ts - u.life * MIN; rows.push(row(S.hcOpened, fmtAbs(op, lang, c), fmtAgo(now - op, lang), u.approx, S)); }
  if (u && u.idle != null) rows.push({ label: S.hcIdle, value: fmtDur(u.idle, lang, true), tip: '' });
  if (g && g.createdAt) rows.push({ label: S.hcInList, value: fmtDur((now - ts) / MIN, lang, true), tip: '' });
  return rows;
}

/** Hover card of a tab set */
export function groupCard(g, now, lang, cal, S) {
  const c = calendarName(cal);
  const rows = [row(S.hcCreated, fmtAbs(g.createdAt, lang, c), fmtAgo(now - g.createdAt, lang), false, S)];
  const tm = g.tm;
  if (tm && tm.n) {
    if (tm.ctMin && tm.luMax) rows.push({ label: S.hcRange, value: fmtAbs(tm.ctMin * MIN, lang, c, true) + ' – ' + fmtAbs(tm.luMax * MIN, lang, c, true), tip: tm.ax ? S.tmApproxTip : '' });
    if (tm.idleMed) rows.push({ label: S.hcMedIdle, value: fmtDur(tm.idleMed, lang, true), tip: '' });
    if (tm.lifeMed) rows.push({ label: S.hcMedLife, value: (tm.ax ? '~' : '') + fmtDur(tm.lifeMed, lang, true), tip: tm.ax ? S.tmApproxTip : '' });
  }
  if (g.rc) rows.push({ label: S.hcRestored, value: S.hcTimes(g.rc), tip: '' });
  if (g.lastRestoredAt) rows.push(row(S.hcLastRestored, fmtAbs(g.lastRestoredAt, lang, c), fmtAgo(now - g.lastRestoredAt, lang), false, S));
  return rows;
}
