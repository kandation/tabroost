// Time helpers shared by the service worker and the pages: packed duration codes, relative / absolute / duration formatters.
// Pure functions, no chrome.* calls, so they can be unit-tested in Node.

const WEEK_MIN = 10080; // 7 days
const CODE_MAX = 32767;

export const dur = {
  /** minutes -> 15-bit code. 0 = unknown. Exact to the minute under 7 days, to the hour above (clamped at ~2.6 years). */
  enc(min) {
    min = Math.floor(Number(min));
    if (!isFinite(min) || min < 0) return 0;
    if (min < WEEK_MIN) return 1 + min;
    return Math.min(CODE_MAX, WEEK_MIN + 1 + (Math.floor(min / 60) - 168));
  },
  /** code -> minutes (0 = unknown). Codes above the week range decode to whole hours. */
  dec(code) {
    code = code | 0;
    if (code <= 0) return 0;
    if (code <= WEEK_MIN) return code - 1;
    return (code - WEEK_MIN - 1 + 168) * 60;
  },
  /** true when the code hit the ceiling ("> 2 years") */
  clamped(code) { return (code | 0) >= CODE_MAX; },
};

/** idle + lifetime (minutes, 0/undefined = unknown) -> one integer, negative when the opened time is approximate. undefined when nothing is known. */
export function packD(idleMin, lifeMin, approx) {
  const i = idleMin == null ? 0 : dur.enc(idleMin);
  const l = lifeMin == null ? 0 : dur.enc(lifeMin);
  const d = i + l * 32768;
  if (!d) return undefined;
  return approx ? -d : d;
}

/** packed integer -> { idle, life, approx } in minutes; idle/life are null when unknown */
export function unpackD(d) {
  if (typeof d !== 'number' || !d) return null;
  const approx = d < 0;
  const v = Math.abs(d);
  const ic = v % 32768;
  const lc = Math.floor(v / 32768);
  return { idle: ic ? dur.dec(ic) : null, life: lc ? dur.dec(lc) : null, approx, idleMax: dur.clamped(ic), lifeMax: dur.clamped(lc) };
}

const TH_U = { m: 'นาที', h: 'ชม.', d: 'วัน', w: 'สัปดาห์', mo: 'เดือน', y: 'ปี', now: 'เมื่อสักครู่' };
const EN_U = { m: 'm', h: 'h', d: 'd', w: 'w', mo: 'mo', y: 'y', now: 'just now' };

function units(lang) { return lang === 'en' ? EN_U : TH_U; }
function join(n, u, lang) { return lang === 'en' ? n + u : n + ' ' + u; }

/** minutes -> a short duration: "5 min", "3 h", "2 days", "3 weeks", "4 months", "1 year 2 months" (full). The words come from TH_U / EN_U. */
export function fmtDur(min, lang, full) {
  const U = units(lang);
  min = Math.max(0, Math.floor(min));
  if (min < 60) return join(min, U.m, lang);
  const h = Math.floor(min / 60);
  if (h < 24) return join(h, U.h, lang);
  const d = Math.floor(h / 24);
  if (d < 7) return join(d, U.d, lang);
  if (d < 30) return join(Math.floor(d / 7), U.w, lang);
  if (d < 365) return join(Math.floor(d / 30), U.mo, lang);
  const y = Math.floor(d / 365);
  const rest = Math.floor((d - y * 365) / 30);
  if (full && rest > 0) return join(y, U.y, lang) + ' ' + join(rest, U.mo, lang);
  return join(y, U.y, lang);
}

const rtfCache = {};
function rtf(lang) {
  const loc = lang === 'en' ? 'en' : 'th';
  return rtfCache[loc] || (rtfCache[loc] = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }));
}

/** milliseconds ago (positive = past) -> "3 days ago" or the "just now" word, in the language given */
export function fmtAgo(ms, lang) {
  const s = ms / 1000;
  if (s < 45 && s > -45) return units(lang).now;
  const f = rtf(lang);
  const m = Math.round(s / 60);
  const sign = s < 0 ? 1 : -1;
  const a = Math.abs(m);
  if (a < 60) return f.format(sign * a, 'minute');
  const h = Math.round(a / 60);
  if (h < 24) return f.format(sign * h, 'hour');
  const d = Math.round(h / 24);
  if (d < 7) return f.format(sign * d, 'day');
  if (d < 30) return f.format(sign * Math.round(d / 7), 'week');
  if (d < 365) return f.format(sign * Math.round(d / 30), 'month');
  return f.format(sign * Math.round(d / 365), 'year');
}

/** calendar: 'auto' (Thai UI: Buddhist era, English UI: Gregorian) | 'buddhist' | 'gregory' */
export function localeFor(lang, calendar) {
  const base = lang === 'en' ? 'en-US' : 'th-TH';
  if (calendar === 'buddhist' || calendar === 'gregory') return base + '-u-ca-' + calendar;
  return base;
}

const dtfCache = {};
export function fmtAbs(ts, lang, calendar, dateOnly) {
  const loc = localeFor(lang, calendar);
  const key = loc + (dateOnly ? 'd' : 'dt');
  const f = dtfCache[key] || (dtfCache[key] = new Intl.DateTimeFormat(loc, dateOnly ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }));
  return f.format(new Date(ts));
}

/** the setting value ('auto' | 'be' | 'ce') -> Intl calendar name */
export function calendarName(setting) { return setting === 'be' ? 'buddhist' : setting === 'ce' ? 'gregory' : 'auto'; }

/** Buckets for group-by "not used for" / "saved for": index into labels. -1 = unknown. */
export const AGE_BUCKET_DAYS = [1, 7, 30, 90];
export function ageBucket(ageMs) {
  if (ageMs == null || !isFinite(ageMs) || ageMs < 0) return -1;
  const d = ageMs / 86400000;
  for (let i = 0; i < AGE_BUCKET_DAYS.length; i++) if (d < AGE_BUCKET_DAYS[i]) return i;
  return AGE_BUCKET_DAYS.length;
}

/** ms until the next whole minute (+ a little slack) for the page-side ticker */
export function msToNextMinute(now) { return 60000 - (now % 60000) + 50; }

/** local date key YYYYMMDD / ISO-ish week key YYYY-Www */
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
export function weekKey(ts) {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return y + '-W' + String(w).padStart(2, '0');
}

// ---- per-session aggregate (g.tm) from packed item data ----
function quant(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : 0; }

/** items: [{ts, d}] -> tm {luMin, luMax, lq:[p25,p50,p75], ctMin, idleMed, lifeMed, n, ax} (minutes since epoch / minutes), or null when no item has data */
export function tmFromItems(items) {
  const lu = []; const idles = []; const lifes = []; let ctMin = Infinity; let n = 0; let ax = 0;
  for (const it of items) {
    const u = unpackD(it.d);
    if (!u) continue;
    n++;
    if (u.approx) ax++;
    const tmin = Math.floor((it.ts || 0) / 60000);
    if (u.idle != null) { lu.push(tmin - u.idle); idles.push(u.idle); }
    if (u.life != null) { lifes.push(u.life); ctMin = Math.min(ctMin, tmin - u.life); }
  }
  if (!n) return null;
  lu.sort((a, b) => a - b); idles.sort((a, b) => a - b); lifes.sort((a, b) => a - b);
  return {
    luMin: lu.length ? lu[0] : 0, luMax: lu.length ? lu[lu.length - 1] : 0, lq: [quant(lu, 0.25), quant(lu, 0.5), quant(lu, 0.75)],
    ctMin: ctMin === Infinity ? 0 : ctMin, idleMed: quant(idles, 0.5), lifeMed: quant(lifes, 0.5), n, ax,
  };
}

/** merge two tm records (a group that got more items): min/max exact, quartiles / medians n-weighted */
export function tmMerge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const n = a.n + b.n;
  const w = (x, y) => Math.round((x * a.n + y * b.n) / n);
  const pick = (x, y, f) => (!x ? y : !y ? x : f(x, y));
  return {
    luMin: pick(a.luMin, b.luMin, Math.min), luMax: Math.max(a.luMax, b.luMax), lq: a.lq.map((v, i) => w(v, b.lq[i])),
    ctMin: pick(a.ctMin, b.ctMin, Math.min), idleMed: w(a.idleMed, b.idleMed), lifeMed: w(a.lifeMed, b.lifeMed), n, ax: a.ax + b.ax,
  };
}
