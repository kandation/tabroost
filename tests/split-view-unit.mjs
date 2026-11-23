// Unit tests (Node, no browser) for the pure split view logic: pair indexes, restore units, the sweep guard, and the `sv` field round trip
// through the formats (item normalisation, NDJSON vault line, JSON export / import). The real-browser side is tests/split-view-test.mjs.
//   node tests/split-view-unit.mjs
import { svIndex, pairIndexes, isPair, pairUnits, splitGuard, splitIdOf } from '../lib/splitview.js';
import { normItem, ndjsonItem, parseNdjsonLine, buildExportJson, validateImportJson, svOf } from '../lib/formats.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ---- splitIdOf / svIndex ----
eq([splitIdOf({ splitViewId: 5 }), splitIdOf({ splitViewId: -1 }), splitIdOf({}), splitIdOf(null), splitIdOf({ splitViewId: 0 })], [5, -1, -1, -1, 0], 'splitIdOf');
eq([svIndex({ sv: 0 }), svIndex({ sv: 3 }), svIndex({ sv: -1 }), svIndex({ sv: 1.5 }), svIndex({ sv: '2' }), svIndex({}), svIndex({ sv: 70000 })], [0, 3, -1, -1, -1, -1, -1], 'svIndex');
ok(svOf({ sv: 2 }) === 2 && svOf({ sv: 'x' }) === -1, 'formats.svOf');

// ---- pairIndexes: only keys that occur exactly twice, on neighbours ----
eq(pairIndexes([null, 7, 7, null]), [-1, 0, 0, -1], 'one pair');
eq(pairIndexes([7, 7, 9, 9]), [0, 0, 1, 1], 'two pairs');
eq(pairIndexes([7, null, 7]), [-1, -1, -1], 'not neighbours');
eq(pairIndexes([7, 7, 7]), [-1, -1, -1], 'three panes of one id are never a pair');
eq(pairIndexes([7]), [-1], 'single pane');
eq(pairIndexes([]), [], 'empty');
eq(pairIndexes([0, 0]), [0, 0], 'split id 0 is valid');
eq(pairIndexes(['1:5', '1:5', '2:5', '2:5']), [0, 0, 1, 1], 'window scoped keys');
eq(pairIndexes(['1:5', '2:5']), [-1, -1], 'same raw id in different windows is NOT a pair');

// ---- isPair / pairUnits ----
const it = (o) => ({ g: 'G', w: 1, ...o });
const a = it({ seq: 1, sv: 0 }); const b = it({ seq: 2, sv: 0 }); const c = it({ seq: 3 }); const d = it({ seq: 4, sv: 1, tg: 2 }); const e = it({ seq: 5, sv: 1, tg: 2 });
ok(isPair(a, b), 'pair a,b');
ok(!isPair(b, c) && !isPair(c, d) && !isPair(a, c), 'no pair with a plain item');
ok(isPair(d, e), 'pair inside a tab group');
ok(!isPair(it({ sv: 1, tg: 1 }), it({ sv: 1, tg: 2 })), 'different tab groups are not a pair');
ok(!isPair(it({ sv: 1, w: 1 }), it({ sv: 1, w: 2 })), 'different windows are not a pair');
ok(!isPair(it({ sv: 1, g: 'A' }), it({ sv: 1, g: 'B' })), 'different stash groups are not a pair');
ok(isPair({ g: 'G', sv: 1 }, { g: 'G', sv: 1, w: 1 }), 'missing w means window 1');
eq(pairUnits([a, b, c, d, e]), [[0, 1], [2], [3, 4]], 'units');
eq(pairUnits([a, b, c], false), [[0], [1], [2]], 'split off => plain units');
eq(pairUnits([a, c, b]), [[0], [1], [2]], 'orphans stay plain');
eq(pairUnits([a]), [[0]], 'single orphan with sv stays plain');

// ---- splitGuard (sweep / auto-stash) ----
const tab = (id, sv, o = {}) => ({ id, windowId: 1, splitViewId: sv, active: false, audible: false, discarded: false, ...o });
{ // fully idle background split: both go
  const all = [tab(1, 9), tab(2, 9), tab(3, -1)];
  const g = splitGuard([all[0], all[1], all[2]], all);
  eq(g.ok.map((t) => t.id), [1, 2, 3], 'idle split + plain: all ok');
  eq([...g.blocked], [], 'nothing blocked');
  eq(g.units.get(1).map((t) => t.id), [1, 2], 'unit of pane 1');
}
{ // partner is the active tab => the other pane is shielded
  const all = [tab(1, 9), tab(2, 9, { active: true })];
  const g = splitGuard([all[0]], all);
  eq(g.ok.map((t) => t.id), [], 'partner active: pane stays awake');
  ok(g.blocked.has(1), 'blocked set');
}
{ // partner audible (not a candidate because audible)
  const all = [tab(1, 9), tab(2, 9, { audible: true })];
  eq(splitGuard([all[0]], all).ok.length, 0, 'partner audible');
}
{ // partner protected (not among the candidates for any reason)
  const all = [tab(1, 9), tab(2, 9)];
  eq(splitGuard([all[0]], all).ok.length, 0, 'partner not a candidate (protected / whitelisted / recent)');
}
{ // partner already discarded (e.g. by the user): the remaining pane is judged alone
  const all = [tab(1, 9), tab(2, 9, { discarded: true })];
  eq(splitGuard([all[0]], all).ok.map((t) => t.id), [1], 'discarded partner does not shield');
}
{ // the same raw id in another window is another split
  const all = [tab(1, 9), tab(2, 9, { windowId: 2, active: true }), tab(3, 9)];
  const g = splitGuard([all[0], all[2]], all);
  eq(g.ok.map((t) => t.id), [1, 3], 'window scoped');
}
{ // a lone pane (partner unknown) is never discarded: doubt keeps tabs
  const all = [tab(1, 9)];
  eq(splitGuard([all[0]], all).ok.length, 0, 'unknown partner');
}
{ // Chrome without splitViewId: nothing changes, no all-tabs data needed
  const all = [{ id: 1, windowId: 1 }, { id: 2, windowId: 1 }];
  eq(splitGuard(all, []).ok.map((t) => t.id), [1, 2], 'no splitViewId => pass-through');
}

// ---- `sv` round trip through the formats ----
const base = { url: 'https://example.com/a', title: 'A', ts: 5 };
eq(normItem({ ...base, sv: 3 }, 1).sv, 3, 'normItem keeps sv');
ok(!('sv' in normItem({ ...base }, 1)), 'normItem: no sv when absent (old data)');
ok(!('sv' in normItem({ ...base, sv: -1 }, 1)) && !('sv' in normItem({ ...base, sv: 'x' }, 1)), 'normItem drops a bad sv');
{
  const line = ndjsonItem('g1', { ...base, sv: 4, tg: 1 });
  const back = parseNdjsonLine(line);
  eq([back.sv, back.tg], [4, 1], 'ndjson line round trip');
  eq(normItem(back, 1).sv, 4, 'ndjson -> normItem');
  ok(!/"sv"/.test(ndjsonItem('g1', base)), 'ndjson: no sv key without a pair');
}
{
  const groups = [{ title: 't', createdAt: 1, items: [{ ...base, sv: 0 }, { ...base, url: 'https://example.com/a', sv: 0 }, { url: 'https://example.com/c', title: 'C', ts: 1 }] }];
  const json = buildExportJson(groups, 1);
  eq(json.groups[0].items.map((x) => x.sv), [0, 0, undefined], 'export JSON carries sv only on pair items');
  const imp = validateImportJson(JSON.parse(JSON.stringify(json)));
  ok(imp.ok, 'import ok');
  eq(imp.groups[0].items.map((x) => x.sv), [0, 0, undefined], 'import JSON keeps sv; same-url panes are both kept');
  // an old export without sv still imports
  const old = { app: 'clean-my-ram', schema: 1, groups: [{ title: '', items: [{ url: 'https://x.test/', title: 'x', ts: 1 }] }] };
  ok(validateImportJson(old).ok, 'old export (no sv) imports');
}

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('split-view-unit: all passed');
