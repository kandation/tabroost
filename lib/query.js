// Pure organisation logic for the list page: sort, group-by (sections) and filters over the small in-memory group summaries.
// Nothing here touches items: site shares come from group.agg (built in the same transaction as every write) and the per-site
// membership map (siteIdx). The page calls apply() once per data/view change; it is O(G log G) for G groups (3,000 -> a few ms).

export const SORTS = ['created', 'createdAsc', 'mtime', 'lastRestored', 'lastUsed', 'openedOld', 'restoredMost', 'title', 'count', 'sites', 'manual'];
export const GROUPBYS = ['calendar', 'slot', 'site', 'tabgroup', 'count', 'category', 'idle', 'saved', 'none'];
export const SLOT_MODES = ['wdHour', 'hour', 'weekday', 'dom', 'partOfDay'];
export const ITEM_SORTS = ['stash', 'title', 'site', 'visited', 'lastUsed', 'opened', 'idleMost', 'lifeMost'];
export const STALE_DAYS = 30;
export const STALE_OFF_DAYS = 90; // without usage stats the stale view falls back to the age in the list

export const DEFAULT_VIEW = {
  sort: 'created', starredFirst: false, groupBy: 'calendar', slotMode: 'wdHour', itemSort: 'stash', density: 'comfortable',
  flat: false, flatSort: 'stash', flatDir: 'desc', sortRev: false, itemDir: 'asc',
};

const collator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });
const WD = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/** UI strings used by the grouping labels (the page overrides them for English). */
export const L = {
  today: 'วันนี้', yesterday: 'เมื่อวาน', week: 'สัปดาห์นี้', month: 'เดือนนี้', multi: 'หลายเว็บไซต์', noTg: 'ไม่มีกลุ่มแท็บ', untitledTg: '(ไม่มีชื่อ)',
  noCat: 'ไม่มีหมวดหมู่', now: 'ตอนนี้', locale: 'th-TH', pinned: 'ปักหมุด',
  everyWd: (w) => `ทุกวัน${w}`, everyWdHour: (w, h) => `ทุกวัน${w} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`,
  everyHour: (h) => `ทุกวัน ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`, everyDom: (d) => `ทุกวันที่ ${d}`,
  parts: ['เช้า (05–11)', 'บ่าย (12–16)', 'เย็น (17–20)', 'กลางคืน (21–04)'], weekdays: WD,
  ageBuckets: ['น้อยกว่า 1 วัน', '1–7 วัน', '7–30 วัน', '30–90 วัน', 'มากกว่า 90 วัน', 'ไม่ทราบ'],
  countRanges: ['1 แท็บ', '2–5 แท็บ', '6–20 แท็บ', '21–100 แท็บ', '101–500 แท็บ', 'มากกว่า 500 แท็บ'],
};

const rangeIndex = (n) => (n <= 1 ? 0 : n <= 5 ? 1 : n <= 20 ? 2 : n <= 100 ? 3 : n <= 500 ? 4 : 5);
const monthLabels = new Map();

const AGE_CUTS = [1, 7, 30, 90];
const ageBucketOf = (ageMs) => { const d = ageMs / DAYMS; for (let i = 0; i < AGE_CUTS.length; i++) if (d < AGE_CUTS[i]) return i; return AGE_CUTS.length; };
export function dayStart(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

import { unpackD } from './time.js';
/** numeric sort key of an item for the time sorts (0 = unknown, sorts last in 'newest first') */
export function itemTimeKey(r, key) {
  const u = unpackD(r.d);
  if (!u) return 0;
  if (key === 'lastUsed') return u.idle != null ? (r.ts || 0) - u.idle * 60000 : 0;
  if (key === 'opened') return u.life != null ? (r.ts || 0) - u.life * 60000 : 0;
  if (key === 'idleMost') return u.idle || 0;
  return u.life || 0;
}

// ---------- sort ----------
function cmpFor(sort) {
  switch (sort) {
    case 'createdAsc': return (a, b) => a.createdAt - b.createdAt;
    case 'mtime': return (a, b) => (b.mtime || b.createdAt) - (a.mtime || a.createdAt);
    case 'lastRestored': return (a, b) => (b.lastRestoredAt || 0) - (a.lastRestoredAt || 0) || b.createdAt - a.createdAt;
    case 'lastUsed': return (a, b) => ((b.tm && b.tm.luMax) || 0) - ((a.tm && a.tm.luMax) || 0) || b.createdAt - a.createdAt;
    case 'openedOld': return (a, b) => (a.tm && a.tm.ctMin ? a.tm.ctMin : Infinity) - (b.tm && b.tm.ctMin ? b.tm.ctMin : Infinity) || b.createdAt - a.createdAt;
    case 'restoredMost': return (a, b) => (b.rc || 0) - (a.rc || 0) || b.createdAt - a.createdAt;
    case 'title': return (a, b) => {
      const x = (a.title || '').trim();
      const y = (b.title || '').trim();
      if (!x !== !y) return x ? -1 : 1; // untitled sessions sort last
      return collator.compare(x, y) || b.createdAt - a.createdAt;
    };
    case 'count': return (a, b) => b.count - a.count || b.createdAt - a.createdAt;
    case 'sites': return (a, b) => ((b.agg && b.agg.nSites) || 0) - ((a.agg && a.agg.nSites) || 0) || b.createdAt - a.createdAt;
    case 'manual': return (a, b) => (a.ord || 0) - (b.ord || 0);
    default: return (a, b) => b.createdAt - a.createdAt;
  }
}

export function sortGroups(groups, view) {
  const base = cmpFor(view.sort);
  const cmp = view.sortRev ? (a, b) => base(b, a) : base; // one click flips the direction of the current key
  const sf = !!view.starredFirst;
  return groups.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (sf ? (b.starred ? 1 : 0) - (a.starred ? 1 : 0) : 0) || cmp(a, b));
}

// ---------- filters ----------
export const FLAG_KEYS = ['starred', 'locked', 'pending', 'pinned', 'archived', 'named', 'saved7', 'unused30', 'open7'];
export const emptyFilters = () => ({ sites: [], cats: [], tgs: [], dateFrom: null, dateTo: null, dateBasis: 'saved', flags: {} });

// ---------- date ranges (local calendar days; every day boundary is built with the Date constructor so DST never shifts it) ----------
/** Local midnight of the day containing ts. */
/** Local midnight n calendar days after (or before) the day containing ts. */
export const addDays = (ts, n) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
/** Range for a preset id: {from, to} with `to` EXCLUSIVE (midnight after the last day); null = no limit. */
export function presetRange(id, now = Date.now()) {
  const sod = dayStart(now);
  switch (id) {
    case 'today': return { from: sod, to: null };
    case '7d': return { from: addDays(sod, -6), to: null };
    case '30d': return { from: addDays(sod, -29), to: null };
    case '90d': return { from: addDays(sod, -89), to: null };
    case 'year': return { from: new Date(new Date(now).getFullYear(), 0, 1).getTime(), to: null };
    default: return { from: null, to: null };
  }
}
/** Which preset (if any) a {from,to} pair equals; 'custom' when it is some other range; 'all' when empty. */
export function presetOf(f, now = Date.now()) {
  if (!f.dateFrom && !f.dateTo) return 'all';
  for (const id of ['today', '7d', '30d', '90d', 'year']) { const r = presetRange(id, now); if (r.from === f.dateFrom && !f.dateTo) return id; }
  return 'custom';
}
/** A custom range from two inclusive local days (y,m,d triples, month 0-based). `to` becomes the exclusive midnight after. Returns null if from > to. */
export function rangeFromDays(a, b) {
  const from = a ? new Date(a[0], a[1], a[2]).getTime() : null;
  const to = b ? new Date(b[0], b[1], b[2] + 1).getTime() : null;
  if (from != null && to != null && from >= to) return null;
  return { from, to };
}
/** The timestamp a group is compared against: 'saved' = when it was stored, 'active' = last time a tab was used (null if unknown). */
export const groupDateOf = (g, basis) => (basis === 'active' ? (g.tm && g.tm.luMax ? g.tm.luMax * 60000 : null) : g.createdAt);
export const filtersActive = (f) => !!(f.sites.length || f.cats.length || f.tgs.length || f.dateFrom || f.dateTo || Object.values(f.flags).some(Boolean));

const tgKey = (t) => (t.title || '').trim() || `#${t.color || 'grey'}`;
export function groupTgKeys(g) { return (g.tabGroups || []).map(tgKey); }

/** Group-level predicate (everything except the site facet, which needs the membership map). */
export function passesFacets(g, f, skip) {
  if (skip !== 'cats' && f.cats.length && !f.cats.includes(g.cat || '')) return false;
  if (skip !== 'tgs' && f.tgs.length) { const ks = groupTgKeys(g); if (!f.tgs.some((k) => ks.includes(k))) return false; }
  if (f.dateFrom || f.dateTo) {
    const ts = groupDateOf(g, f.dateBasis);
    if (ts == null) return false;
    if (f.dateFrom && ts < f.dateFrom) return false;
    if (f.dateTo && ts >= f.dateTo) return false;
  }
  const fl = f.flags;
  if (fl.starred && !g.starred) return false;
  if (fl.locked && !g.locked) return false;
  if (fl.pending && !g.pending) return false;
  if (fl.archived && !g.archived) return false;
  if (fl.pinned && !g.pinned) return false;
  if (fl.named && !(g.title && g.title.trim())) return false;
  if (fl.saved7 && !(g.createdAt < Date.now() - 7 * DAYMS)) return false;
  if (fl.unused30 && !(g.tm && g.tm.luMax && g.tm.luMin < Date.now() / 60000 - 30 * 1440)) return false;
  if (fl.open7 && !(g.tm && g.tm.ctMin && g.tm.ctMin < Date.now() / 60000 - 7 * 1440)) return false;
  return true;
}

/** nav: {kind:'all'|'pinned'|'starred'|'pending'|'cat'|'uncat'|'archived', cat} */
export function passesNav(g, nav) {
  switch (nav.kind) {
    case 'archived': return !!g.archived;
    case 'stale': return !g.archived && isStaleGroup(g);
    case 'pinned': return !g.archived && !!g.pinned;
    case 'starred': return !g.archived && !!g.starred;
    case 'pending': return !g.archived && !!g.pending;
    case 'cat': return !g.archived && g.cat === nav.cat;
    case 'uncat': return !g.archived && !g.cat;
    default: return !g.archived;
  }
}

const DAYMS = 86400000;
/** a tab set with at least one tab unused for STALE_DAYS (with usage stats) or, without stats, saved more than STALE_OFF_DAYS ago */
export function isStaleGroup(g, now = Date.now()) {
  if (g.tm && g.tm.luMin) return g.tm.luMin < now / 60000 - STALE_DAYS * 1440;
  return g.createdAt < now - STALE_OFF_DAYS * DAYMS;
}
/** share (0..1) of a tab set's tabs last used before `cutMin` (minutes since epoch), interpolated through min / quartiles / max */
export function staleFraction(tm, cutMin) {
  const pts = [[tm.luMin, 0], [tm.lq[0], 0.25], [tm.lq[1], 0.5], [tm.lq[2], 0.75], [tm.luMax, 1]];
  if (cutMin <= pts[0][0]) return 0;
  if (cutMin >= pts[4][0]) return 1;
  for (let i = 1; i < pts.length; i++) {
    if (cutMin <= pts[i][0]) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; return x1 === x0 ? y1 : y0 + ((cutMin - x0) / (x1 - x0)) * (y1 - y0); }
  }
  return 1;
}
/** estimated number of stale tabs over the tab sets (exact for fully stale sets, interpolated for partial ones) */
export function staleEstimate(groups, now = Date.now()) {
  let n = 0; let approx = false;
  for (const g of groups) {
    if (g.archived || g.deletedAt != null) continue;
    if (g.tm && g.tm.luMin) { const f = staleFraction(g.tm, now / 60000 - STALE_DAYS * 1440); n += f * g.count; if (f > 0 && f < 1) approx = true; } else if (g.createdAt < now - STALE_OFF_DAYS * DAYMS) n += g.count;
  }
  return { n: Math.round(n), approx };
}

/** ctx.siteMap: Map(site -> Map(gid -> n)). Returns the groups that pass nav + facets (+ the site facet). */
export function filterGroups(groups, nav, f, ctx) {
  let siteAllowed = null;
  if (f.sites.length && ctx.siteMap) {
    siteAllowed = new Set();
    for (const s of f.sites) { const m = ctx.siteMap.get(s); if (m) for (const gid of m.keys()) siteAllowed.add(gid); }
  }
  return groups.filter((g) => passesNav(g, nav) && passesFacets(g, f) && (!siteAllowed || siteAllowed.has(g.id)));
}

/** Facet counts with every OTHER facet applied. Returns {sites:[[site,n]], tgs:[[key,n]], cats:Map}. */
export function facetCounts(groups, nav, f, ctx) {
  const base = groups.filter((g) => passesNav(g, nav));
  const out = { sites: [], tgs: [], cats: new Map(), flags: {} };
  let siteSet = null;
  if (f.sites.length && ctx.siteMap) { siteSet = new Set(); for (const s of f.sites) { const m = ctx.siteMap.get(s); if (m) for (const gid of m.keys()) siteSet.add(gid); } }
  if (ctx.siteMap) {
    const allowed = new Set(base.filter((g) => passesFacets(g, f)).map((g) => g.id));
    const rows = [];
    for (const [site, m] of ctx.siteMap) { let n = 0; for (const [gid, c] of m) if (allowed.has(gid)) n += c; if (n) rows.push([site, n]); }
    rows.sort((a, b) => b[1] - a[1]);
    out.sites = rows.slice(0, 200);
  }
  const tg = new Map();
  for (const g of base.filter((x) => passesFacets(x, f, 'tgs'))) for (const k of new Set(groupTgKeys(g))) tg.set(k, (tg.get(k) || 0) + 1);
  // status chips: how many sessions each one would leave (all other facets applied) so empty ones can be dimmed
  const fbase = base.filter((x) => passesFacets(x, { ...f, flags: {} }) && (!siteSet || siteSet.has(x.id)));
  for (const k of FLAG_KEYS) out.flags[k] = fbase.filter((x) => passesFacets(x, { ...emptyFilters(), flags: { [k]: true } })).length;
  out.tgs = [...tg].sort((a, b) => b[1] - a[1]).slice(0, 60);
  for (const g of base.filter((x) => passesFacets(x, f, 'cats'))) out.cats.set(g.cat || '', (out.cats.get(g.cat || '') || 0) + 1);
  return out;
}

// ---------- group-by ----------
function calendarKey(g, ctx) {
  const ts = g.createdAt;
  if (ts >= ctx.sod) return { k: 'a0', ord: 1e15, label: L.today };
  if (ts >= ctx.sod - 86400000) return { k: 'a1', ord: 1e15 - 1, label: L.yesterday };
  if (ts >= ctx.sod - 6 * 86400000) return { k: 'a2', ord: 1e15 - 2, label: L.week };
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (y === ctx.year && m === ctx.month) return { k: 'a3', ord: 1e15 - 3, label: L.month };
  const key = y * 12 + m;
  let label = monthLabels.get(key + L.locale);
  if (!label) { label = d.toLocaleDateString(L.locale, { month: 'long', year: 'numeric' }); monthLabels.set(key + L.locale, label); }
  return { k: 'm' + key, ord: key, label };
}

function slotKey(g, mode, ctx) {
  const d = new Date(g.createdAt);
  const wd = d.getDay();
  const h = d.getHours();
  let k;
  let label;
  switch (mode) {
    case 'hour': k = h; label = L.everyHour(h); break;
    case 'weekday': k = wd; label = L.everyWd(L.weekdays[wd]); break;
    case 'dom': k = d.getDate(); label = L.everyDom(d.getDate()); break;
    case 'partOfDay': { const p = h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 21 ? 2 : 3; k = p; label = L.parts[p]; break; }
    default: k = wd * 24 + h; label = L.everyWdHour(L.weekdays[wd], h);
  }
  // order: cyclic, starting at the slot that contains "now"
  const n = new Date(ctx.now);
  const nowK = mode === 'hour' ? n.getHours() : mode === 'weekday' ? n.getDay() : mode === 'dom' ? n.getDate() : mode === 'partOfDay' ? (n.getHours() >= 5 && n.getHours() < 12 ? 0 : n.getHours() >= 12 && n.getHours() < 17 ? 1 : n.getHours() >= 17 && n.getHours() < 21 ? 2 : 3) : n.getDay() * 24 + n.getHours();
  const span = mode === 'hour' ? 24 : mode === 'weekday' ? 7 : mode === 'dom' ? 31 : mode === 'partOfDay' ? 4 : 168;
  const ord = ((k - nowK + span) % span);
  return { k: 's' + k, ord: -ord, label: ord === 0 ? `${L.now} · ${label}` : label };
}

function siteKey(g) {
  const top = g.agg && g.agg.top && g.agg.top[0];
  if (top && g.count > 0 && top[1] / g.count >= 0.5) return { k: 'w:' + top[0], label: top[0], site: top[0] };
  return { k: 'w:*', label: L.multi, site: '' };
}

/**
 * Tab-group mode: a session with several Chrome tab groups appears once in each matching section, showing only its
 * matching runs. `runs` = [{tg (-1 = none), n}] in item order (positional ranges), or null when unknown (then the whole
 * session stays in its first section). Returns [{kk, view}] where view is a copy of g with vk (unique key), vsel
 * (indexes into runs) and vcount (tabs shown).
 */
export function splitByTabGroup(g, runs) {
  if (!runs || !runs.length) return null;
  const defs = new Map((g.tabGroups || []).map((t) => [t.i, t]));
  const by = new Map();
  runs.forEach((r, si) => {
    const t = r.tg >= 0 ? defs.get(r.tg) : null;
    const kk = t ? { k: 't:' + tgKey(t), label: t.title && t.title.trim() ? t.title : `${L.untitledTg} · ${t.color}`, ord: 0 } : { k: 't:*', label: L.noTg, ord: 1e9 };
    let e = by.get(kk.k);
    if (!e) { e = { kk, sel: [], n: 0 }; by.set(kk.k, e); }
    e.sel.push(si);
    e.n += r.n;
  });
  const out = [];
  for (const [k, e] of by) out.push({ kk: e.kk, view: { ...g, vk: g.id + '@' + k, vsel: e.sel, vcount: e.n } });
  return out;
}

/**
 * Orders the (already filtered) groups into sections. Returns {groups:[ordered], labels:[string|null per index]} where a
 * non-null label starts a new section header row. A group appears once (tab-group mode uses its first tab group).
 */
export function partition(groups, view, ctx) {
  const sorted = sortGroups(groups, view);
  const mode = view.groupBy;
  if (mode === 'none' || !sorted.length) return { groups: sorted, labels: sorted.map(() => null) };
  const sections = new Map(); // key -> {label, ord, groups}
  const add = (kk, g) => {
    let s = sections.get(kk.k);
    if (!s) { s = { label: kk.label, ord: kk.ord, groups: [], total: 0 }; sections.set(kk.k, s); }
    s.groups.push(g);
    s.total += g.count;
  };
  const pinned = [];
  for (const g of sorted) {
    if (g.pinned && mode !== 'category') { pinned.push(g); continue; } // pinned sessions stay on top in one section
    let kk;
    switch (mode) {
      case 'slot': kk = slotKey(g, view.slotMode, ctx); break;
      case 'site': kk = siteKey(g); kk.ord = 0; break;
      case 'tabgroup': { const t = g.tabGroups && g.tabGroups[0]; kk = t ? { k: 't:' + tgKey(t), label: t.title && t.title.trim() ? t.title : `${L.untitledTg} · ${t.color}`, ord: 0 } : { k: 't:*', label: L.noTg, ord: 1e9 }; break; }
      case 'idle': case 'saved': {
        const refMs = mode === 'idle' ? (g.tm && g.tm.luMax ? g.tm.luMax * 60000 : null) : g.createdAt;
        const bi = refMs == null ? 5 : ageBucketOf(ctx.now - refMs);
        kk = { k: 'a' + bi, label: L.ageBuckets[bi], ord: bi === 5 ? -1e9 : -bi };
        break;
      }
      case 'count': { const i = rangeIndex(g.count); kk = { k: 'c' + i, label: L.countRanges[i], ord: -i }; break; }
      case 'category': { const c = g.cat && ctx.catMap ? ctx.catMap.get(g.cat) : null; kk = c ? { k: 'k:' + c.id, label: c.name, ord: -(c.ord || 0) } : { k: 'k:*', label: L.noCat, ord: -1e9 }; break; }
      default: kk = calendarKey(g, ctx);
    }
    if (mode === 'tabgroup' && ctx.tgRuns && g.tabGroups && g.tabGroups.length) {
      const split = splitByTabGroup(g, ctx.tgRuns(g));
      if (split) { for (const sp of split) add(sp.kk, sp.view); continue; }
    }
    add(kk, g);
  }
  let secs = [...sections.values()];
  if (mode === 'site') secs.sort((a, b) => b.total - a.total || collator.compare(a.label, b.label));
  else if (mode === 'tabgroup') secs.sort((a, b) => a.ord - b.ord || collator.compare(a.label, b.label));
  else secs.sort((a, b) => b.ord - a.ord);
  if (pinned.length) secs.unshift({ label: L.pinned, groups: pinned });
  const out = [];
  const labels = [];
  for (const s of secs) {
    s.groups.forEach((g, i) => { out.push(g); labels.push(i === 0 ? s.label : null); });
  }
  return { groups: out, labels };
}

export function makeCtx(catList) {
  const t = new Date();
  return {
    now: t.getTime(), sod: new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(), year: t.getFullYear(), month: t.getMonth(),
    catMap: new Map((catList || []).map((c) => [c.id, c])), siteMap: null,
  };
}

/** Sort items of one group (only used for non-default item sorts, small groups). */
export function sortItems(items, itemSort) {
  const a = items.slice();
  if (itemSort === 'title') a.sort((x, y) => collator.compare(x.title || x.url, y.title || y.url));
  else if (itemSort === 'site') a.sort((x, y) => collator.compare(x.site || '', y.site || '') || x.seq - y.seq);
  else if (itemSort === 'visited') a.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  else if (itemSort === 'lastUsed' || itemSort === 'opened' || itemSort === 'idleMost' || itemSort === 'lifeMost') a.sort((x, y) => itemTimeKey(y, itemSort) - itemTimeKey(x, itemSort));
  return a;
}
