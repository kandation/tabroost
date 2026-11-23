import assert from 'node:assert/strict';
import {
  id, classifyUrl, hostMatches, parseOneTab, toOneTab, validateImportJson,
  buildExportJson, sortDisplay, fmtDate, fmtStamp, hostOf,
  searchText, ndjsonHeader, ndjsonGroup, ndjsonItem, parseNdjsonLine, oneTabLine, readLines, normItem,
  internalCategory, isRestorableUrl, normalizeUrl, cleanTabGroups, tgOf, TAB_GROUP_COLORS,
} from '../lib/formats.js';

// id
assert.match(id(), /^[0-9a-z]+$/);
assert.notEqual(id(), id());

// classifyUrl table
const table = [
  ['http://a.com', 'save'], ['https://a.com/x?y=1', 'save'], ['file:///C:/a.txt', 'save'], ['ftp://x.org/f', 'save'],
  ['', 'drop'], [undefined, 'drop'], ['about:blank', 'drop'], ['chrome://newtab/', 'drop'], ['chrome://new-tab-page/', 'drop'],
  ['chrome://settings', 'keep'], ['about:config', 'keep'], ['devtools://devtools/x', 'keep'],
  ['chrome-extension://abc/stash.html', 'keep'], ['data:text/html,hi', 'keep'], ['blob:https://a.com/1', 'keep'],
  ['javascript:alert(1)', 'keep'], ['view-source:https://a.com', 'keep'],
];
for (const [u, want] of table) assert.equal(classifyUrl(u), want, String(u));

// hostMatches
assert.equal(hostMatches('zoom.us', ['zoom.us']), true);
assert.equal(hostMatches('us04web.zoom.us', ['zoom.us']), true);
assert.equal(hostMatches('notzoom.us', ['zoom.us']), false);
assert.equal(hostMatches('ZOOM.us', [' Zoom.US ']), true);
assert.equal(hostMatches('a.com', []), false);
assert.equal(hostMatches('', ['a.com']), false);
assert.equal(hostOf('https://Foo.Example.com/x'), 'foo.example.com');

// parseOneTab: basic, blank-line groups, title containing " | ", CRLF, invalid lines
const txt = 'https://a.com | Title A\r\nhttps://b.com | B | with pipe | inside\r\n\r\nnot a url | junk\r\nhttps://c.com\r\nchrome://settings | S\r\n\r\n\r\nhttp://d.com | D\r\n';
const p = parseOneTab(txt);
assert.equal(p.groups.length, 3);
assert.deepEqual(p.groups[0].items, [
  { url: 'https://a.com', title: 'Title A' },
  { url: 'https://b.com', title: 'B | with pipe | inside' },
]);
assert.deepEqual(p.groups[1].items, [{ url: 'https://c.com', title: 'https://c.com' }]);
assert.deepEqual(p.groups[2].items, [{ url: 'http://d.com', title: 'D' }]);
assert.equal(p.skipped, 2);

// round trip
const groups = [
  { items: [{ url: 'https://a.com', title: 'A | B' }, { url: 'https://x.org/p', title: 'X' }] },
  { items: [{ url: 'file:///C:/t.txt', title: 'file:///C:/t.txt' }] },
];
const text = toOneTab(groups);
assert.equal(text, 'https://a.com | A | B\nhttps://x.org/p | X\n\nfile:///C:/t.txt | file:///C:/t.txt');
assert.deepEqual(parseOneTab(text).groups, groups);
assert.equal(parseOneTab(text).skipped, 0);
assert.equal(parseOneTab('').groups.length, 0);
assert.equal(toOneTab([]), '');
// trailing " | " keeps url clean
assert.deepEqual(parseOneTab('https://a.com | ').groups[0].items[0], { url: 'https://a.com', title: 'https://a.com' });

// validateImportJson
const exp = buildExportJson([
  { title: 'T', createdAt: 5, starred: true, locked: false, items: [{ url: 'https://a.com', title: 'A', ts: 1 }] },
], 0);
assert.equal(exp.app, 'clean-my-ram');
const v = validateImportJson(JSON.parse(JSON.stringify(exp)));
assert.equal(v.ok, true);
assert.equal(v.groups.length, 1);
assert.equal(v.groups[0].starred, true);
assert.equal(validateImportJson({ app: 'other', schema: 1, groups: [] }).ok, false);
assert.equal(validateImportJson({ app: 'clean-my-ram', schema: 1 }).ok, false);
assert.equal(validateImportJson(null).ok, false);
assert.equal(validateImportJson('x').ok, false);
const v2 = validateImportJson({ app: 'clean-my-ram', schema: 1, groups: [{ items: [{ url: 'javascript:1' }, { url: 'https://ok.com' }] }, 5] });
assert.equal(v2.ok, true);
assert.equal(v2.skipped, 2);
assert.equal(v2.groups[0].items.length, 1);

// sortDisplay keeps order inside each part
assert.deepEqual(sortDisplay([{ id: 1 }, { id: 2, starred: true }, { id: 3 }, { id: 4, starred: true }]).map((g) => g.id), [2, 4, 1, 3]);

// dates
const d = new Date(2024, 0, 5, 7, 3).getTime();
assert.equal(fmtDate(d), '05/01/2024 07:03');
assert.equal(fmtStamp(d), '20240105-0703');


// ---- NDJSON (export v2 / vault) ----
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
assert.equal(searchText('Hello', 'HTTPS://A.com/X'), 'hello' + NL + 'https://a.com/x');
assert.equal(searchText('x'.repeat(600), 'u').length, 512);
const hdr = parseNdjsonLine(ndjsonHeader(0));
assert.deepEqual([hdr.type, hdr.format, hdr.version], ['header', 'cmr', 2]);
const gl = parseNdjsonLine(ndjsonGroup({ id: 'g1', title: 'T | x', createdAt: 5, starred: true, ord: -3 }));
assert.deepEqual([gl.type, gl.id, gl.title, gl.starred, gl.locked, gl.ord, gl.deletedAt], ['group', 'g1', 'T | x', true, false, -3, null]);
const il = parseNdjsonLine(ndjsonItem('g1', { url: 'https://a.com', title: 'multi' + NL + 'line "quoted"', ts: 9 }));
assert.deepEqual([il.type, il.g, il.url, il.title, il.ts], ['item', 'g1', 'https://a.com', 'multi' + NL + 'line "quoted"', 9]);
assert.equal(parseNdjsonLine(''), null);
assert.equal(parseNdjsonLine('not json'), null);
assert.equal(parseNdjsonLine('[1,2]'), null);
assert.equal(ndjsonItem('g', { url: 'https://a', title: 'a' + NL + 'b' }).includes(NL), false); // one object per line
assert.equal(oneTabLine({ url: 'https://a.com', title: 'A' + CR + NL + 'B' }), 'https://a.com | A B');
assert.equal(oneTabLine({ url: 'https://a.com', title: '' }), 'https://a.com | https://a.com');

// normItem
assert.deepEqual(normItem({ url: ' https://a.com ', title: 't', ts: 5 }, 1), { url: 'https://a.com', title: 't', ts: 5 });
assert.equal(normItem({ url: 'javascript:alert(1)' }), null);
assert.equal(normItem({ url: 'data:text/html,hi' }), null);
assert.equal(normItem({ url: 'https://a.com/' + 'x'.repeat(70000) }), null);
assert.equal(normItem({ url: 'https://a.com', title: 'y'.repeat(2000) }, 1).title.length, 1024);
assert.equal(normItem(null), null);

// readLines over a chunked stream (CRLF, split across chunks, no trailing newline)
function streamOf(chunks) {
  return new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
}
const got = [];
for await (const l of readLines(streamOf(['a' + CR + NL + 'b', 'b' + NL + NL + 'c', 'c' + NL + 'last']))) got.push(l);
assert.deepEqual(got, ['a', 'bb', '', 'cc', 'last']);
const got2 = [];
for await (const l of readLines(streamOf([]))) got2.push(l);
assert.deepEqual(got2, []);

// NDJSON round trip through the real stream helpers
const lines = [ndjsonHeader(1), ndjsonGroup({ id: 'a', title: 'A' }), ndjsonItem('a', { url: 'https://x.com/1', title: 'one', ts: 1 }), ndjsonItem('a', { url: 'https://x.com/2', title: 'two', ts: 2 })];
const parsed = [];
for await (const l of readLines(streamOf([lines.join(NL) + NL]))) { const o = parseNdjsonLine(l); if (o) parsed.push(o); }
assert.deepEqual(parsed.map((o) => o.type), ['header', 'group', 'item', 'item']);

// gzip of NDJSON survives a compress/decompress cycle (vault + gz export)
const gz = await new Response(new Blob([lines.join(NL)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
const back = await new Response(gz.stream().pipeThrough(new DecompressionStream('gzip'))).text();
assert.equal(back, lines.join(NL));

// ---- multi-window items ----
const wi = parseNdjsonLine(ndjsonItem('g', { url: 'https://a.com', title: 't', ts: 1, w: 2, ws: true }));
assert.deepEqual([wi.w, wi.ws], [2, true]);
assert.equal('w' in parseNdjsonLine(ndjsonItem('g', { url: 'https://a.com', title: 't', ts: 1 })), false);
assert.equal(parseNdjsonLine(ndjsonGroup({ id: 'g', windowCount: 3 })).windowCount, 3);
assert.deepEqual(normItem({ url: 'https://a.com', w: 3, ws: true }, 1).w, 3);
assert.equal('w' in normItem({ url: 'https://a.com', w: -1 }, 1), false);

// ---- internal pages ----
const cats = [
  ['chrome://downloads/', 'downloads'], ['chrome://extensions/?id=x', 'extensions'], ['chrome://settings/privacy', 'settings'],
  ['chrome://history', 'history'], ['chrome://flags', 'other'], ['about:config', 'other'], ['devtools://devtools/x', 'other'],
  ['chrome-extension://abc/x.html', 'extpages'], ['chrome://newtab/', 'newtab'], ['about:blank', 'newtab'], ['', 'newtab'],
  ['https://a.com', null], ['data:text/html,x', null], ['javascript:1', null], ['file:///C:/a.txt', null],
];
for (const [u, want] of cats) assert.equal(internalCategory(u), want, u);
assert.equal(isRestorableUrl('https://a.com'), true);
assert.equal(isRestorableUrl('chrome://flags'), true);
assert.equal(isRestorableUrl('chrome://newtab/'), false);
assert.equal(isRestorableUrl('javascript:alert(1)'), false);
assert.equal(isRestorableUrl('data:text/html,hi'), false);
assert.equal(normItem({ url: 'chrome://settings/' }, 1).url, 'chrome://settings/'); // saved internal pages survive import/vault

// ---- duplicate normalisation ----
assert.equal(normalizeUrl('https://a.com/p?x=1#frag'), 'https://a.com/p?x=1');
assert.equal(normalizeUrl('https://a.com/p?utm_source=a&x=1'), 'https://a.com/p?utm_source=a&x=1');
assert.equal(normalizeUrl('https://a.com/p?utm_source=a&x=1&UTM_medium=b', true), 'https://a.com/p?x=1');
assert.equal(normalizeUrl('https://a.com/p?utm_source=a', true), 'https://a.com/p');
assert.notEqual(normalizeUrl('https://a.com/p?x=1'), normalizeUrl('https://a.com/p?x=2'));
assert.equal(normalizeUrl('not a url'), 'not a url');

// ---- Chrome tab groups (optional fields) ----
const tgs = [{ i: 0, title: 'Work', color: 'blue', collapsed: true, windowIdx: 2 }, { i: 1, title: '', color: 'neon', collapsed: false }];
const ctg = cleanTabGroups(tgs);
assert.deepEqual(ctg[0], { i: 0, title: 'Work', color: 'blue', collapsed: true, windowIdx: 2 });
assert.deepEqual(ctg[1], { i: 1, title: '', color: 'grey', collapsed: false, windowIdx: 1 }); // unknown color -> grey
assert.deepEqual(cleanTabGroups(undefined), []);
assert.deepEqual(cleanTabGroups([null, { i: -1 }, { i: 'x' }, { i: 2 }, { i: 2 }]).map((x) => x.i), [2]);
assert.ok(TAB_GROUP_COLORS.includes('orange'));
assert.equal(tgOf({ tg: 3 }), 3);
assert.equal(tgOf({ tg: -1 }), -1);
assert.equal(tgOf({}), -1);
assert.equal(tgOf({ tg: 1.5 }), -1);
// ndjson: optional on both lines, absent -> no fields (old exports stay byte-compatible)
const tgl = parseNdjsonLine(ndjsonGroup({ id: 'g', tabGroups: tgs }));
assert.equal(tgl.tabGroups.length, 2);
assert.equal('tabGroups' in parseNdjsonLine(ndjsonGroup({ id: 'g' })), false);
assert.equal(parseNdjsonLine(ndjsonItem('g', { url: 'https://a.com', title: 't', ts: 1, tg: 0 })).tg, 0);
assert.equal('tg' in parseNdjsonLine(ndjsonItem('g', { url: 'https://a.com', title: 't', ts: 1 })), false);
assert.equal(normItem({ url: 'https://a.com', tg: 4 }, 1).tg, 4);
assert.equal('tg' in normItem({ url: 'https://a.com', tg: -2 }, 1), false);
assert.equal('tg' in normItem({ url: 'https://a.com' }, 1), false);
// old (v2 header, no tab groups) group + item lines still parse and normalise
assert.equal(parseNdjsonLine('{"type":"group","id":"x","title":"","createdAt":1,"windowCount":1}').type, 'group');
assert.deepEqual(normItem(parseNdjsonLine('{"type":"item","g":"x","url":"https://a.com","title":"A","ts":5}'), 1), { url: 'https://a.com', title: 'A', ts: 5 });
// OneTab export flattens (no tab-group information)
assert.equal(oneTabLine({ url: 'https://a.com', title: 'A', tg: 0 }), 'https://a.com | A');
// JSON v1 round trip keeps tg + tabGroups, and old files without them validate unchanged
const expTg = buildExportJson([{ title: 'T', createdAt: 5, tabGroups: tgs, items: [{ url: 'https://a.com', title: 'A', ts: 1, tg: 0 }, { url: 'https://b.com', title: 'B', ts: 2 }] }], 1);
const vTg = validateImportJson(JSON.parse(JSON.stringify(expTg)));
assert.equal(vTg.groups[0].tabGroups.length, 2);
assert.equal(vTg.groups[0].items[0].tg, 0);
assert.equal('tg' in vTg.groups[0].items[1], false);
assert.deepEqual(validateImportJson({ app: 'clean-my-ram', schema: 1, groups: [{ items: [{ url: 'https://a.com' }] }] }).groups[0].tabGroups, []);

console.log('test-formats: all assertions passed');
