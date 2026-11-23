// node tests/query-test.mjs : sort / group-by / filter logic of lib/query.js and the registrable-domain helper
import assert from 'node:assert/strict';
import * as Q from '../lib/query.js';
import { siteOfUrl, siteOfHost } from '../lib/site.js';

const DAY = 86400000;
const now = new Date(2026, 10, 25, 14, 30).getTime(); // Wed 25 Nov 2026 14:30 (local)
const mk = (id, over = {}) => ({ id, createdAt: now - 3600000, mtime: now, count: 10, title: '', starred: false, pinned: false, archived: false, ...over });
const ctxAt = () => ({ ...Q.makeCtx([]), now, sod: new Date(2026, 10, 25).getTime(), year: 2026, month: 10 });

// ---- site ----
assert.equal(siteOfUrl('https://www.github.com/a/b'), 'github.com');
assert.equal(siteOfUrl('https://news.bbc.co.uk/x'), 'bbc.co.uk');
assert.equal(siteOfUrl('https://foo.github.io/x'), 'foo.github.io');
assert.equal(siteOfUrl('https://a.b.example.com/'), 'example.com');
assert.equal(siteOfUrl('http://192.168.1.2:8080/x'), '192.168.1.2');
assert.equal(siteOfUrl('http://localhost:3000/'), 'localhost');
assert.equal(siteOfUrl('chrome://settings/'), '(ภายใน)');
assert.equal(siteOfHost('www.example.co.th'), 'example.co.th');

// ---- sort: pinned first, untitled last for title sort, starred-first toggle ----
const gs = [mk('a', { title: 'beta', createdAt: now - 5 }), mk('b', { title: '', createdAt: now - 4 }), mk('c', { title: 'alpha', createdAt: now - 3, starred: true }), mk('d', { title: 'zeta', createdAt: now - 2, pinned: true })];
assert.deepEqual(Q.sortGroups(gs, { sort: 'title' }).map((g) => g.id), ['d', 'c', 'a', 'b']); // pinned, then alpha, beta, untitled
assert.deepEqual(Q.sortGroups(gs, { sort: 'created' }).map((g) => g.id), ['d', 'c', 'b', 'a']);
assert.deepEqual(Q.sortGroups(gs, { sort: 'createdAsc' }).map((g) => g.id), ['d', 'a', 'b', 'c']);
assert.deepEqual(Q.sortGroups(gs, { sort: 'count', starredFirst: true }).map((g) => g.id)[1], 'c'); // starred right after pinned

// ---- calendar buckets ----
const cal = [mk('t', { createdAt: now }), mk('y', { createdAt: now - DAY }), mk('w', { createdAt: now - 4 * DAY }), mk('m', { createdAt: new Date(2026, 10, 2).getTime() }), mk('o', { createdAt: new Date(2026, 8, 10).getTime() })];
const p1 = Q.partition(cal, { sort: 'created', groupBy: 'calendar' }, ctxAt());
assert.deepEqual(p1.groups.map((g) => g.id), ['t', 'y', 'w', 'm', 'o']);
assert.deepEqual(p1.labels.filter(Boolean).slice(0, 3), [Q.L.today, Q.L.yesterday, Q.L.week]);
assert.equal(p1.labels.filter(Boolean).length, 5);

// ---- time slots: weekday + hour; cyclic order starts at the slot containing now ----
const slotG = [mk('s1', { createdAt: new Date(2026, 10, 25, 14, 5).getTime() }), mk('s2', { createdAt: new Date(2026, 10, 18, 14, 59).getTime() }), mk('s3', { createdAt: new Date(2026, 10, 23, 12, 0).getTime() })];
const p2 = Q.partition(slotG, { sort: 'created', groupBy: 'slot', slotMode: 'wdHour' }, ctxAt());
assert.equal(p2.groups[0].id !== undefined, true);
assert.ok(p2.labels[0].startsWith(Q.L.now), 'first slot is the one containing now');
const sameSlot = p2.groups.filter((g) => g.id === 's1' || g.id === 's2');
assert.equal(sameSlot.length, 2);
assert.equal(p2.labels.filter(Boolean).length, 2); // s1 and s2 share "every Wednesday 14:00"; s3 is a different slot
assert.equal(Q.partition(slotG, { sort: 'created', groupBy: 'slot', slotMode: 'hour' }, ctxAt()).labels.filter(Boolean).length, 2);
assert.equal(Q.partition(slotG, { sort: 'created', groupBy: 'slot', slotMode: 'partOfDay' }, ctxAt()).labels.filter(Boolean).length, 1);

// ---- by website (>= 50 % share) / tab group / count ranges / category / none ----
const siteG = [mk('x1', { count: 10, agg: { top: [['github.com', 8]], nSites: 2 } }), mk('x2', { count: 10, agg: { top: [['youtube.com', 3]], nSites: 6 } }), mk('x3', { count: 4, agg: { top: [['github.com', 4]], nSites: 1 } })];
const p3 = Q.partition(siteG, { sort: 'created', groupBy: 'site' }, ctxAt());
assert.equal(p3.labels.filter(Boolean).length, 2);
assert.ok(p3.labels[0] === 'github.com');
const tgG = [mk('g1', { tabGroups: [{ title: 'Work', color: 'blue' }] }), mk('g2', {}), mk('g3', { tabGroups: [{ title: '', color: 'red' }] })];
const p4 = Q.partition(tgG, { sort: 'created', groupBy: 'tabgroup' }, ctxAt());
assert.equal(p4.labels.filter(Boolean).length, 3);
assert.equal(p4.groups[p4.groups.length - 1].id, 'g2'); // "no tab group" last
const cnt = [mk('c1', { count: 1 }), mk('c2', { count: 4 }), mk('c3', { count: 30 }), mk('c4', { count: 900 })];
assert.equal(Q.partition(cnt, { sort: 'created', groupBy: 'count' }, ctxAt()).labels.filter(Boolean).length, 4);
const catCtx = Q.makeCtx([{ id: 'k1', name: 'Work', color: 'blue', ord: 0 }, { id: 'k2', name: 'Later', color: 'red', ord: 1 }]);
const p5 = Q.partition([mk('q1', { cat: 'k2' }), mk('q2', { cat: 'k1' }), mk('q3', {})], { sort: 'created', groupBy: 'category' }, catCtx);
assert.deepEqual(p5.labels.filter(Boolean), ['Work', 'Later', Q.L.noCat]);
assert.deepEqual(Q.partition(cnt, { sort: 'created', groupBy: 'none' }, ctxAt()).labels, [null, null, null, null]);

// ---- filters + facet counts ----
const siteMap = new Map([['github.com', new Map([['f1', 5], ['f2', 1]])], ['youtube.com', new Map([['f2', 7]])]]);
const fg = [mk('f1', { cat: 'k1', starred: true, title: 'x', tabGroups: [{ title: 'Work', color: 'blue' }] }), mk('f2', { cat: '', createdAt: now - 40 * DAY }), mk('f3', { archived: true })];
const nav = { kind: 'all' };
const ctx = { ...ctxAt(), siteMap };
const f = Q.emptyFilters();
assert.equal(Q.filterGroups(fg, nav, f, ctx).length, 2); // archived hidden in "all"
assert.equal(Q.filterGroups(fg, { kind: 'archived' }, f, ctx).length, 1);
f.sites = ['youtube.com'];
assert.deepEqual(Q.filterGroups(fg, nav, f, ctx).map((g) => g.id), ['f2']);
f.sites = [];
f.flags.starred = true;
assert.deepEqual(Q.filterGroups(fg, nav, f, ctx).map((g) => g.id), ['f1']);
f.flags.starred = false;
f.dateFrom = now - 7 * DAY;
assert.deepEqual(Q.filterGroups(fg, nav, f, ctx).map((g) => g.id), ['f1']);
f.dateFrom = null;
f.tgs = ['Work'];
assert.deepEqual(Q.filterGroups(fg, nav, f, ctx).map((g) => g.id), ['f1']);
f.tgs = [];
const fc = Q.facetCounts(fg, nav, Q.emptyFilters(), ctx);
assert.deepEqual(fc.sites.map((x) => x[0]), ['youtube.com', 'github.com']);
assert.equal(fc.sites[0][1], 7);
assert.equal(fc.tgs[0][0], 'Work');
assert.equal(Q.filtersActive(Q.emptyFilters()), false);
f.cats = ['k1'];
assert.equal(Q.filtersActive(f), true);
assert.deepEqual(Q.sortItems([{ seq: 2, title: 'b', url: 'u', ts: 1 }, { seq: 1, title: 'a', url: 'v', ts: 2 }], 'title').map((x) => x.seq), [1, 2]);

// ---- group by tab group: one session shows up in EACH matching section with only its own runs ----
{
  const tgs = [{ i: 0, title: 'Work', color: 'blue' }, { i: 1, title: 'Fun', color: 'red' }];
  const A = mk('A', { count: 10, tabGroups: tgs }); // runs: Work 3, none 2, Fun 4, Work 1
  const B = mk('B', { count: 4, tabGroups: [tgs[1]] }); // all Fun
  const C = mk('C', { count: 5 }); // no tab groups
  const runsA = [{ tg: 0, n: 3 }, { tg: -1, n: 2 }, { tg: 1, n: 4 }, { tg: 0, n: 1 }];
  const runsB = [{ tg: 1, n: 4 }];
  const c2 = { ...ctxAt(), tgRuns: (g) => (g.id === 'A' ? runsA : g.id === 'B' ? runsB : null) };
  const pt = Q.partition([A, B, C], { sort: 'created', groupBy: 'tabgroup' }, c2);
  const labels = pt.labels.filter(Boolean);
  assert.deepEqual(labels.slice().sort(), ['Fun', 'Work', Q.L.noTg].sort());
  const viewsOf = (label) => { let on = false; const out = []; pt.groups.forEach((g, i) => { if (pt.labels[i]) on = pt.labels[i] === label; if (on) out.push(g); }); return out; };
  const work = viewsOf('Work');
  assert.equal(work.length, 1);
  assert.deepEqual([work[0].id, work[0].vsel, work[0].vcount], ['A', [0, 3], 4]);
  assert.deepEqual(viewsOf('Fun').map((g) => [g.id, g.vcount]).sort(), [['A', 4], ['B', 4]]);
  const none = viewsOf(Q.L.noTg);
  assert.deepEqual(none.map((g) => [g.id, g.vcount != null ? g.vcount : g.count]).sort(), [['A', 2], ['C', 5]]);
  const total = pt.groups.reduce((a, g) => a + (g.vcount != null ? g.vcount : g.count), 0);
  assert.equal(total, 10 + 4 + 5, 'every tab is shown exactly once');
  assert.equal(new Set(pt.groups.map((g) => g.vk || g.id)).size, pt.groups.length, 'row keys are unique');
  // runs unknown -> whole session once, in its first tab group (old behaviour)
  const p0 = Q.partition([A], { sort: 'created', groupBy: 'tabgroup' }, { ...ctxAt(), tgRuns: () => null });
  assert.equal(p0.groups.length, 1);
  assert.equal(p0.groups[0].vsel, undefined);
}

// ---- date range filter: day boundaries, presets, 'last active' basis, flag facet counts ----
{
  // every local day boundary is a true local midnight (also across daylight-saving changes, whatever TZ the test runs in)
  for (let d = 0; d < 366; d++) { const t = Q.addDays(new Date(2026, 0, 1).getTime(), d); const x = new Date(t); assert.equal(x.getHours() + x.getMinutes(), 0, 'midnight on day ' + d); }
  const P = (id) => Q.presetRange(id, now);
  assert.equal(P('today').from, new Date(2026, 10, 25).getTime());
  assert.equal(P('7d').from, new Date(2026, 10, 19).getTime(), '7 days = today + the 6 days before');
  assert.equal(P('30d').from, new Date(2026, 9, 27).getTime());
  assert.equal(P('90d').from, new Date(2026, 7, 28).getTime());
  assert.equal(P('year').from, new Date(2026, 0, 1).getTime());
  assert.deepEqual(P('all'), { from: null, to: null });
  assert.equal(Q.presetOf({ dateFrom: P('7d').from, dateTo: null }, now), '7d');
  assert.equal(Q.presetOf({ dateFrom: null, dateTo: null }, now), 'all');
  assert.equal(Q.presetOf({ dateFrom: 5, dateTo: 9 }, now), 'custom');
  // custom range = inclusive days; the last day runs to its last millisecond
  const r = Q.rangeFromDays([2026, 10, 12], [2026, 10, 23]);
  assert.equal(r.from, new Date(2026, 10, 12).getTime());
  assert.equal(r.to, new Date(2026, 10, 24).getTime());
  assert.equal(Q.rangeFromDays([2026, 10, 23], [2026, 10, 12]), null, 'from after to is rejected');
  assert.ok(Q.rangeFromDays([2026, 10, 12], [2026, 10, 12]), 'a single day is valid');
  const inRange = (ts, f) => Q.passesFacets(mk('x', { createdAt: ts }), { ...Q.emptyFilters(), ...f });
  const f1 = { dateFrom: r.from, dateTo: r.to };
  assert.equal(inRange(r.from, f1), true, 'first ms of first day in');
  assert.equal(inRange(r.from - 1, f1), false, 'last ms of the day before out');
  assert.equal(inRange(r.to - 1, f1), true, '23:59:59.999 of last day in');
  assert.equal(inRange(r.to, f1), false, 'midnight after out');
  assert.equal(inRange(0, { dateFrom: null, dateTo: null }), true, 'no range = everything');
  assert.equal(inRange(new Date(2026, 10, 25, 0, 0, 0).getTime(), { dateFrom: P('today').from }), true, 'today preset includes 00:00');
  assert.equal(inRange(new Date(2026, 10, 24, 23, 59, 59, 999).getTime(), { dateFrom: P('today').from }), false, 'today preset excludes yesterday 23:59');
  // 'last active' basis uses tm.luMax (minutes) and drops sessions without activity data
  const act = mk('act', { createdAt: 1, tm: { luMax: Math.floor(now / 60000) - 60, luMin: 1, ctMin: 1 } });
  const noAct = mk('noact', { createdAt: now });
  const fa = { ...Q.emptyFilters(), dateFrom: P('today').from, dateBasis: 'active' };
  assert.equal(Q.passesFacets(act, fa), true);
  assert.equal(Q.passesFacets(noAct, fa), false, 'no activity data -> not in an activity range');
  assert.equal(Q.passesFacets(act, { ...fa, dateBasis: 'saved' }), false, 'saved basis looks at createdAt');
  // facet counts follow the date range live
  const gx = [mk('n', { createdAt: now - 1000 }), mk('o', { createdAt: now - 40 * DAY, starred: true }), mk('p', { createdAt: now - 2000, starred: true })];
  const fc = Q.facetCounts(gx, { kind: 'all' }, { ...Q.emptyFilters(), dateFrom: P('7d').from }, Q.makeCtx([]));
  assert.equal(fc.flags.starred, 1, 'starred count respects the date range');
  assert.equal(fc.flags.locked, 0);
  assert.equal(Q.facetCounts(gx, { kind: 'all' }, Q.emptyFilters(), Q.makeCtx([])).flags.starred, 2);
}

console.log('query-test: all passed');
