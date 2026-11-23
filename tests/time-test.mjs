// Unit tests for the time fields (spec section 12): packed duration codes, the packed item integer `d`, formatters (Thai / English, Buddhist era),
// first-seen restart rematch with duplicate URLs, session aggregate merge, and the per-item byte cost measured with v8.serialize.
//   node tests/time-test.mjs
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { dur, packD, unpackD, fmtDur, fmtAgo, fmtAbs, localeFor, calendarName, ageBucket, dayKey, weekKey, tmFromItems, tmMerge } from '../lib/time.js';
import { rematch, urlHash } from '../lib/firstseen.js';

let n = 0;
const t = (name, fn) => { try { fn(); n++; } catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; } };

t('dur: exact round trip up to 7 days', () => {
  for (let m = 0; m < 10080; m++) assert.equal(dur.dec(dur.enc(m)), m);
});
t('dur: <= 60 min error after 7 days, up to the clamp', () => {
  for (let m = 10080; m < 1371240; m += 7) // 1371240 min = the clamp (~2.6 years)
    { const e = m - dur.dec(dur.enc(m)); assert.ok(e >= 0 && e <= 60, 'm=' + m + ' e=' + e); }
});
t('dur: unknown / negative / NaN -> 0, clamp at 32767', () => {
  assert.equal(dur.enc(NaN), 0); assert.equal(dur.enc(-5), 0); assert.equal(dur.enc(undefined), 0); assert.equal(dur.dec(0), 0);
  assert.equal(dur.enc(1e9), 32767); assert.ok(dur.clamped(dur.enc(1e9))); assert.ok(!dur.clamped(dur.enc(1000)));
  assert.ok(dur.dec(32767) / 60 / 24 / 365 > 2.4); // about 2.6 years
  for (let m = 0; m < 2000000; m += 997) assert.ok(dur.enc(m) <= 32767 && dur.enc(m) >= 1);
});
t('packD / unpackD: sign, unknown, clamp, 31 bits', () => {
  assert.equal(packD(undefined, undefined, false), undefined);
  assert.equal(packD(null, null, true), undefined);
  const a = packD(30, 120, false); const b = packD(30, 120, true);
  assert.equal(b, -a); assert.ok(a > 0);
  const u = unpackD(a); assert.equal(u.idle, 30); assert.equal(u.life, 120); assert.equal(u.approx, false);
  assert.equal(unpackD(b).approx, true);
  assert.equal(unpackD(packD(0, 5, false)).idle, 0); // known zero (code 1), not unknown
  assert.equal(unpackD(packD(undefined, 90, false)).idle, null);
  assert.equal(unpackD(packD(90, undefined, false)).life, null);
  const c = unpackD(packD(1e9, 1e9, false)); assert.ok(c.idleMax && c.lifeMax);
  assert.ok(Math.abs(packD(1e9, 1e9, true)) < 2 ** 31, 'fits a 31-bit varint');
  assert.equal(unpackD(0), null); assert.equal(unpackD('x'), null); assert.equal(unpackD(undefined), null);
});
t('v8.serialize: item `d` extra bytes (key 3 + tag 1 + zigzag varint)', () => {
  const base = { g: 'g1', seq: 123456, url: 'https://example.com/some/path?q=1', title: 'A page title', ts: 1760000000000, fav: 'example.com' };
  const sz = (o) => v8.serialize(o).length;
  const extra = (d) => sz({ ...base, d }) - sz(base);
  // lifetime under ~2.8 days (any idle): the zigzag varint fits 4 bytes -> 8 bytes total, as budgeted
  for (const d of [packD(5, 7, false), packD(2000, 3000, true), packD(1e9, 4000, true), packD(0, 1, false), packD(1e9, undefined, true)]) assert.ok(extra(d) <= 8, 'extra ' + extra(d) + ' for d=' + d);
  // longer lifetimes need a 5-byte varint: 9 bytes worst case (the spec's 8 assumed 28 bits; two 15-bit codes + sign need 31)
  for (const d of [packD(2000, 90000, true), packD(1e9, 1e9, true), packD(1e9, 1e9, false)]) assert.ok(extra(d) <= 9, 'extra ' + extra(d) + ' for d=' + d);
});
t('formatters: durations Thai / English', () => {
  assert.equal(fmtDur(5, 'th'), '5 นาที'); assert.equal(fmtDur(180, 'th'), '3 ชม.'); assert.equal(fmtDur(2 * 1440, 'th'), '2 วัน');
  assert.equal(fmtDur(21 * 1440, 'th'), '3 สัปดาห์'); assert.equal(fmtDur(120 * 1440, 'th'), '4 เดือน'); assert.equal(fmtDur(365 * 1440, 'th'), '1 ปี');
  assert.equal(fmtDur(400 * 1440, 'th', true), '1 ปี 1 เดือน');
  assert.equal(fmtDur(5, 'en'), '5m'); assert.equal(fmtDur(180, 'en'), '3h'); assert.equal(fmtDur(2 * 1440, 'en'), '2d'); assert.equal(fmtDur(21 * 1440, 'en'), '3w'); assert.equal(fmtDur(120 * 1440, 'en'), '4mo'); assert.equal(fmtDur(800 * 1440, 'en'), '2y');
  assert.equal(fmtDur(-3, 'en'), '0m');
});
t('formatters: relative times', () => {
  assert.equal(fmtAgo(10000, 'th'), 'เมื่อสักครู่'); assert.equal(fmtAgo(10000, 'en'), 'just now');
  assert.match(fmtAgo(3 * 86400000, 'th'), /3 วัน/); assert.match(fmtAgo(3 * 86400000, 'en'), /3 days ago/);
  assert.match(fmtAgo(2 * 3600000, 'en'), /2 hours ago/); assert.match(fmtAgo(40 * 86400000, 'en'), /month/);
});
t('formatters: absolute dates and the Buddhist-era switch', () => {
  const ts = Date.UTC(2026, 5, 15, 5, 30);
  assert.equal(localeFor('th', 'auto'), 'th-TH'); assert.equal(localeFor('en', 'auto'), 'en-US');
  assert.equal(localeFor('th', 'gregory'), 'th-TH-u-ca-gregory'); assert.equal(localeFor('en', 'buddhist'), 'en-US-u-ca-buddhist');
  assert.equal(calendarName('be'), 'buddhist'); assert.equal(calendarName('ce'), 'gregory'); assert.equal(calendarName('auto'), 'auto');
  assert.match(fmtAbs(ts, 'th', 'auto', true), /2569/); // Thai UI: พ.ศ.
  assert.match(fmtAbs(ts, 'th', 'gregory', true), /2026/);
  assert.match(fmtAbs(ts, 'en', 'auto', true), /2026/);
  assert.match(fmtAbs(ts, 'en', 'buddhist', true), /2569/);
  assert.match(fmtAbs(ts, 'th', 'auto', false), /\d{1,2}[:.]\d{2}/);
});
t('age buckets and date keys', () => {
  assert.equal(ageBucket(-1), -1); assert.equal(ageBucket(null), -1); assert.equal(ageBucket(3600000), 0); assert.equal(ageBucket(2 * 86400000), 1); assert.equal(ageBucket(20 * 86400000), 2); assert.equal(ageBucket(60 * 86400000), 3); assert.equal(ageBucket(400 * 86400000), 4);
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), 20260105);
  assert.equal(weekKey(new Date(2026, 0, 1).getTime()), '2026-W01'); assert.equal(weekKey(new Date(2025, 11, 29).getTime()), '2026-W01'); assert.equal(weekKey(new Date(2021, 0, 3).getTime()), '2020-W53');
});
t('first-seen rematch with duplicate URLs', () => {
  const A = urlHash('https://a.test/'); const B = urlHash('https://b.test/');
  const prev = [{ u: A, f: 300 }, { u: A, f: 100 }, { u: A, f: 200 }, { u: B, f: 50 }];
  const cur = [{ id: 1, u: A, la: 999 }, { id: 2, u: A, la: 999 }, { id: 3, u: B, la: 40 }, { id: 4, u: A, la: 999 }, { id: 5, u: A, la: 400 }, { id: 6, u: urlHash('https://new.test/'), la: 700 }];
  const r = rematch(prev, cur, 1000);
  assert.deepEqual([r[1].f, r[2].f, r[4].f], [100, 200, 300]); // oldest unused first, each consumed once
  assert.equal(r[5].f, 400); // 4th duplicate has no entry left: min(now, lastAccessed)
  assert.equal(r[3].f, 50);
  assert.equal(r[6].f, 700); assert.equal(rematch([], [{ id: 9, u: 1, la: 0 }], 1000)[9].f, 1000); assert.equal(rematch([{ u: 1, f: 0 }, null], [{ id: 9, u: 1, la: 5 }], 1000)[9].f, 5);
});
t('tmFromItems / tmMerge', () => {
  const now = Date.UTC(2026, 5, 1);
  const items = [{ ts: now, d: packD(10, 100, true) }, { ts: now, d: packD(60, 500, false) }, { ts: now, d: packD(600, undefined, false) }, { ts: now }];
  const a = tmFromItems(items);
  assert.equal(a.n, 3); assert.equal(a.ax, 1);
  const tmin = Math.floor(now / 60000);
  assert.equal(a.luMax, tmin - 10); assert.equal(a.luMin, tmin - 600); assert.equal(a.ctMin, tmin - 500);
  assert.equal(tmFromItems([{ ts: now }, {}]), null);
  const b = tmFromItems([{ ts: now + 3600000, d: packD(5, 50, false) }]);
  const m = tmMerge(a, b);
  assert.equal(m.n, 4); assert.equal(m.ax, 1); assert.equal(m.luMax, Math.floor((now + 3600000) / 60000) - 5); assert.equal(m.luMin, a.luMin); assert.equal(m.ctMin, a.ctMin);
  assert.equal(tmMerge(null, b), b); assert.equal(tmMerge(a, null), a);
  assert.ok(m.lq.length === 3 && m.lq[0] <= m.lq[2]);
});
console.log(process.exitCode ? 'time-test FAILED' : `time-test: ${n} groups OK`);
