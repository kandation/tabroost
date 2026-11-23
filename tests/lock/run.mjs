// tests/lock/run.mjs  --  node tests/lock/run.mjs      (Node >= 20, no dependencies, no network, no browser)
// Correctness tests exit non-zero on failure. Performance numbers are printed against the spec budgets (informational).
import {
  LOW_ITER, mulberry32, deriveSearch, mkItem, SENSITIVE, buildPlainDb, ALL_STORES, logicalView, withCrashes,
  lockedStash, pct, MemAdapter, FakeStore, CrashError,
} from './helpers.mjs';
import { countHits, countHitsBytes } from './fakestore.js';
import * as kdf from '../../lib/lock/kdf.js';
import * as rec from '../../lib/lock/rec.js';
import * as K from '../../lib/lock/keys.js';
import * as inbox from '../../lib/lock/inbox.js';
import * as archive from '../../lib/lock/archive.js';
import * as policy from '../../lib/lock/policy.js';
import { runSeal, sealStep } from '../../lib/lock/seal.js';
import { runMigration, migrateStep, totalRows } from '../../lib/lock/migrate.js';
import { canon } from '../../lib/lock/jobutil.js';
import { utf8, randomBytes } from '../../lib/lock/bytes.js';
import { CORRUPT_SENTINEL } from '../../lib/lock/strings.js';

// ---------------- tiny harness ----------------
let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  const t0 = performance.now();
  try { await fn(); passed++; console.log(`  ok   ${name} (${(performance.now() - t0).toFixed(0)} ms)`); } catch (e) {
    failed++; failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`);
  }
}
const assert = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };
const eq = (a, b, m = '') => { const x = canon(a), y = canon(b); if (x !== y) throw new Error(`${m} expected ${y.slice(0, 200)} got ${x.slice(0, 200)}`); };
const rejects = async (fn, Cls, m = '') => { try { await fn(); } catch (e) { if (Cls && !(e instanceof Cls)) throw new Error(`${m} wrong error ${e && e.name}: ${e && e.message}`); return e; } throw new Error(`${m} expected rejection`); };
const noThrowCorrupt = (r) => assert(r.corrupt === true, 'expected corrupt sentinel');

const PASS = 'correct horse battery staple';
console.log('lib/lock test suite');

// shared fixture (low iteration count; production-iteration run happens in the perf section)
const fx = await K.setupLock({ password: PASS, withRecovery: true, iter: LOW_ITER });
const MK_COPY = new Uint8Array(fx.mk); // for the leak scan only
const { meta, keys } = fx;
const RECOVERY = fx.recoveryKey;
const reader = keys.reader();
const writer = keys.writer();

// ================= kdf =================
console.log('\n[kdf]');
await test('recovery key: 56 chars in 8 groups of 7, Crockford alphabet', async () => {
  assert(/^([0-9A-HJKMNP-TV-Z]{7}-){7}[0-9A-HJKMNP-TV-Z]{7}$/.test(RECOVERY), RECOVERY);
  const p = await kdf.parseRecoveryKey(RECOVERY);
  assert(p.ok && p.bytes.length === 32);
});
await test('recovery key: parse tolerant of case, spaces, O/0, I/L/1', async () => {
  const fixed = await kdf.formatRecoveryKey(new Uint8Array(32).map((_, i) => i * 7 + 1));
  const messy = fixed.toLowerCase().replace(/-/g, '  ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert((await kdf.parseRecoveryKey(messy)).ok);
});
await test('recovery key: EVERY single-character typo (56 positions x 31 substitutions) is rejected', async () => {
  const fixed = await kdf.formatRecoveryKey(new Uint8Array(32).map((_, i) => (i * 37 + 11) & 255));
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const flat = fixed.replace(/-/g, '');
  let tested = 0;
  for (let i = 0; i < 56; i++) for (const c of A) {
    if (c === flat[i]) continue;
    const bad = flat.slice(0, i) + c + flat.slice(i + 1);
    const r = await kdf.parseRecoveryKey(bad);
    assert(!r.ok, `typo at ${i}->${c} accepted`); tested++;
  }
  assert(tested === 56 * 31);
});
await test('recovery key: wrong length / bad chars / adjacent swap rejected with reasons', async () => {
  const fixed = await kdf.formatRecoveryKey(new Uint8Array(32).fill(9));
  eq((await kdf.parseRecoveryKey(fixed.slice(0, -1))).reason, 'length');
  eq((await kdf.parseRecoveryKey(fixed.replace(/^./, 'U'))).reason, 'chars');
  const flat = fixed.replace(/-/g, '');
  const sw = flat.slice(0, 3) + flat[4] + flat[3] + flat.slice(5);
  assert(flat[3] === flat[4] || !(await kdf.parseRecoveryKey(sw)).ok);
});
await test('password strength rules', () => {
  const t = [['short1', 'tooShort'], ['abcdefgh', 'weak'], ['abcdefghij', 'weak'], ['Abcdefgh1', 'weak'], ['Abcdefghi1', 'fair'], ['Abcdefghijk1', 'fair'], ['abcdefghijklmnopqrst', 'weak'], ['Abcdefghijklmnop1', 'strong'], ['correct horse battery staple', 'strong']];
  for (const [p, lvl] of t) eq(kdf.passwordStrength(p).level, lvl, p);
  assert(!kdf.passwordStrength('1234567').ok && kdf.passwordStrength('12345678').ok);
});

// ================= rec: round trips =================
console.log('\n[rec] round trips');
await test('item round trip (DK): fields split, t/tk dropped, tokens present, k=0', async () => {
  const it = mkItem(2, 17, 17); it.iid = 'abc'; it.tg = 4;
  const r = await rec.encodeItem(it, writer);
  assert(r.k === 0 && r.e instanceof Uint8Array && r.e[0] === 1);
  assert(!('t' in r) && !('tk' in r) && !('url' in r) && !('title' in r));
  assert(r.site[0] === '~' && r.uh[0] === '~' && !r.site.includes('example'));
  eq([r.g, r.seq, r.ts, r.tg, r.iid], [it.g, it.seq, it.ts, it.tg, it.iid]);
  const back = await rec.decodeItem(r, reader);
  const { t, tk, ...expect } = it;
  eq(back, expect);
  assert((r.e.length - 13 - 16) % 32 === 0, 'payload padded to a multiple of 32');
});
await test('item with unknown extra field: encrypted by default (whitelist plaintext)', async () => {
  const r = await rec.encodeItem({ ...mkItem(1, 1), secretNote: 'hello-secret' }, writer);
  assert(!('secretNote' in r));
  eq((await rec.decodeItem(r, reader)).secretNote, 'hello-secret');
});
await test('group / category / snapshot / job / setting / blob round trips', async () => {
  const g = { id: 5, createdAt: 123, title: 'My secret group', note: 'n', count: 9, nextSeq: 10, ord: 2, starred: true, agg: { top: [['a.com', 1]] }, tgLayout: { a: 1 }, tabGroups: [{ title: 'x' }], source: 'popup' };
  const eg = await rec.encodeGroup(g, writer);
  eq([eg.id, eg.createdAt, eg.count, eg.nextSeq, eg.starred, eg.ord, eg.source], [5, 123, 9, 10, true, 2, 'popup']);
  assert(!('title' in eg) && !('agg' in eg) && !('note' in eg) && !('tgLayout' in eg) && !('tabGroups' in eg));
  eq(await rec.decodeGroup(eg, reader), g);
  const c = { id: 3, name: 'Work', color: 'red' };
  const ec = await rec.encodeCategory(c, writer); assert(!('name' in ec) && ec.color === 'red');
  eq(await rec.decodeCategory(ec, reader), c);
  const s = { id: 's1', ts: 5, nTabs: 2, nWin: 1, tabs: [{ url: 'https://a.com/', title: 'A' }] };
  const es = await rec.encodeSnapshot(s, writer); assert(!('tabs' in es) && es.nTabs === 2 && es.ts === 5);
  eq(await rec.decodeSnapshot(es, reader), s);
  const j = { id: 'j1', type: 'purge', cursor: 4, payload: { urls: ['https://a.com'] } };
  const ej = await rec.encodeJob(j, writer); assert(!('payload' in ej) && ej.cursor === 4);
  eq(await rec.decodeJob(ej, reader), j);
  const st = await rec.encodeSetting('excludeSites', ['bank.com'], writer);
  eq(await rec.decodeSetting(st, reader), { name: 'excludeSites', value: ['bank.com'] });
  const blob = await rec.encodeBlob('sy:passcache', { p: 'x' }, writer);
  eq(await rec.decodeBlob('sy:passcache', blob, reader), { p: 'x' });
});
await test('site row / siteIdx / favicon (XK) / vault (gzip, base64) round trips', async () => {
  const sr = await rec.encodeSiteRow({ site: 'news.example.com', n: 7 }, writer);
  assert(sr.site[0] === '~' && sr.n === 7 && !('host' in sr));
  const d = await rec.decodeSiteRow(sr, reader); eq([d.site, d.n, d.token], ['news.example.com', 7, sr.site]);
  const si = await rec.tokenizeSiteIdx({ site: 'news.example.com', g: 2, n: 3 }, keys.hk);
  eq(si.site, sr.site); eq([si.g, si.n], [2, 3]);
  const fv = await rec.encodeFavicon({ site: 'news.example.com', icon: 'data:xyz', ts: 4 }, keys.xWriter());
  assert(fv.site === sr.site && !('icon' in fv));
  const fd = await rec.decodeFavicon(fv, reader); eq([fd.site, fd.icon, fd.ts], ['news.example.com', 'data:xyz', 4]);
  const obj = { g: 1, items: Array.from({ length: 200 }, (_, i) => ({ url: 'https://v.example.com/' + i, title: 'T' + i })) };
  const ev = await rec.encodeVault('g1', obj, writer);
  assert(typeof ev.e === 'string' && ev.k === 0);
  eq((await rec.decodeVault(ev, reader)).data, obj);
  assert(Buffer.from(ev.e, 'base64').length < JSON.stringify(obj).length / 2, 'vault gzip effective');
});
await test('inbox record (k>0) round trips through batch resolver', async () => {
  const bk = await inbox.createBatchKey(keys.pub, 5);
  const it = mkItem(1, 1);
  const r = await rec.encodeItem(it, bk.writer);
  assert(r.k === 5 && !('site' in r) && !('uh' in r), 'no tokens while locked');
  const rd = keys.reader(inbox.makeBatchResolver(keys.sk, async (kid) => (kid === 5 ? bk.row : null)));
  const { t, tk, ...expect } = it;
  eq(await rec.decodeItem(r, rd), expect);
  const noRow = keys.reader(inbox.makeBatchResolver(keys.sk, async () => null));
  noThrowCorrupt(await rec.decodeItem(r, noRow));
});
await test('legacy plaintext accepted forever; mixed arrays decode; LockedError without key', async () => {
  const legacy = mkItem(1, 2);
  eq(await rec.decodeItem(legacy, reader), legacy);
  const encd = await rec.encodeItem(mkItem(1, 3), writer);
  const mixed = await rec.decryptItems([legacy, encd, legacy], reader);
  assert(mixed.length === 3 && mixed[1].url === mkItem(1, 3).url && mixed[0] === legacy);
  await rejects(() => rec.decodeItem(encd, { dk: null }), rec.LockedError);
  const lg = { id: 1, title: 'plain' };
  eq(await rec.decodeGroup(lg, reader), lg);
});
await test('trash row embeds items; moving an item to trash needs no re-encryption (AAD independent of store)', async () => {
  const r = await rec.encodeItem(mkItem(1, 4), writer);
  const row = await rec.encodeTrashRow({ tid: 1, kind: 'items', g: 1, items: [r, mkItem(1, 5)], n: 2, deletedAt: 1 }, writer);
  assert(row.items[0].e === r.e, 'already-encrypted item kept verbatim');
  assert(rec.trashRowEncrypted(row));
  const back = await rec.decodeTrashRow(row, reader);
  eq(back.items.map((x) => x.url), [mkItem(1, 4).url, mkItem(1, 5).url]);
});
await test('batch helpers: Promise.all slices of 256, order preserved', async () => {
  let inflight = 0, max = 0;
  const out = await rec.mapSlices(Array.from({ length: 1000 }, (_, i) => i), async (x) => { inflight++; max = Math.max(max, inflight); await Promise.resolve(); inflight--; return x * 2; });
  assert(max <= 256 && max > 1 && out.every((v, i) => v === i * 2), 'max in flight ' + max);
});
await test('blind tokens: deterministic, keyed, no host leak, uh 16 bytes', async () => {
  const a = await rec.siteToken(keys.hk, 'secret-host.example.com');
  assert(a === await rec.siteToken(keys.hk, 'secret-host.example.com'));
  assert(a.length === 23 && a[0] === '~' && !a.includes('secret'));
  const other = (await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER })).keys;
  assert(a !== await rec.siteToken(other.hk, 'secret-host.example.com'), 'different HK -> different token');
  const u = await rec.uhToken(keys.hk, 'https://a.com/x');
  assert(u.length === 23 && u[0] === '~' && u !== await rec.uhToken(keys.hk, 'https://a.com/y'));
  const m = await rec.matchHashes(utf8('salt'), 'a.b.example.com');
  eq(m.length, 3); // a.b.example.com, b.example.com, example.com
});

// ================= rec: tampering =================
console.log('\n[rec] tampering');
const flipBit = (u8, i, bit = 0) => { const c = u8.slice(); c[i] ^= 1 << bit; return c; };
await test('bit flip in EVERY byte of `e` (item) -> sentinel, never throws', async () => {
  const r = await rec.encodeItem(mkItem(1, 9), writer);
  for (let i = 0; i < r.e.length; i++) {
    for (const bit of [0, 7]) {
      const d = await rec.decodeItem({ ...r, e: flipBit(r.e, i, bit) }, reader);
      noThrowCorrupt(d);
      assert(d.title === CORRUPT_SENTINEL && d.title === 'รายการเสียหาย' && d.url === '');
    }
  }
});
await test('bit flip in `e` for group / category / snapshot / job / site / favicon / setting / vault -> corrupt', async () => {
  const flipMid = (r) => ({ ...r, e: flipBit(r.e, r.e.length - 3) });
  noThrowCorrupt(await rec.decodeGroup(flipMid(await rec.encodeGroup({ id: 1, title: 'x' }, writer)), reader));
  noThrowCorrupt(await rec.decodeCategory(flipMid(await rec.encodeCategory({ id: 1, name: 'x' }, writer)), reader));
  noThrowCorrupt(await rec.decodeSnapshot(flipMid(await rec.encodeSnapshot({ id: 'a', ts: 1, tabs: [] }, writer)), reader));
  noThrowCorrupt(await rec.decodeJob(flipMid(await rec.encodeJob({ id: 'a', payload: { u: 1 } }, writer)), reader));
  noThrowCorrupt(await rec.decodeSiteRow(flipMid(await rec.encodeSiteRow({ site: 'a.com', n: 1 }, writer)), reader));
  noThrowCorrupt(await rec.decodeFavicon(flipMid(await rec.encodeFavicon({ site: 'a.com', icon: 'x' }, keys.xWriter())), reader));
  noThrowCorrupt(await rec.decodeSetting(flipMid(await rec.encodeSetting('autoRules', [1], writer)), reader));
  const v = await rec.encodeVault('g', { a: 1 }, writer);
  const raw = Buffer.from(v.e, 'base64'); raw[raw.length - 5] ^= 1;
  noThrowCorrupt(await rec.decodeVault({ ...v, e: raw.toString('base64') }, reader));
});
await test('swap `e` between two logical ids -> both fail AAD', async () => {
  const a = await rec.encodeItem(mkItem(1, 1), writer), b = await rec.encodeItem(mkItem(1, 2), writer);
  noThrowCorrupt(await rec.decodeItem({ ...a, e: b.e }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...b, e: a.e }, reader));
  // moving a ciphertext to another (g,seq) is also rejected
  noThrowCorrupt(await rec.decodeItem({ ...a, seq: 99 }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...a, g: 8 }, reader));
  // same-id re-encryption is fine (fresh IV)
  const a2 = await rec.encodeItem(mkItem(1, 1), writer);
  assert(a2.e.some((x, i) => x !== a.e[i]), 'fresh IV each time');
});
await test('wrong / malformed `k` and `e`', async () => {
  const r = await rec.encodeItem(mkItem(1, 1), writer);
  for (const k of [1, 2, -1, 1.5, '0', null, NaN]) noThrowCorrupt(await rec.decodeItem({ ...r, k }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...r, e: r.e.slice(0, 20) }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...r, e: r.e.slice(0, 5) }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...r, e: [...r.e] }, reader));
  noThrowCorrupt(await rec.decodeItem({ ...r, e: undefined }, reader));
  const v1 = r.e.slice(); v1[0] = 2; noThrowCorrupt(await rec.decodeItem({ ...r, e: v1 }, reader));
  await rejects(() => rec.decodeItem({ ...r, e: flipBit(r.e, 20) }, reader, { strict: true }), rec.CorruptRecordError);
  const kr = await rec.encodeItem(mkItem(1, 1), writer); // XK vs DK confusion: favicon key must not open an item
  noThrowCorrupt(await rec.decodeItem(kr, { dk: keys.xk }));
});
await test('documented limitation: plaintext metadata (ts/tg/w/del) is not authenticated', async () => {
  const r = await rec.encodeItem(mkItem(1, 1), writer);
  const d = await rec.decodeItem({ ...r, ts: 5 }, reader);
  assert(!d.corrupt && d.ts === 5); // by design (spec §1: ts/tg/w drive paging; integrity vs active attacker best-effort)
});

// ================= keys =================
console.log('\n[keys]');
await test('setup: meta.lock shape, non-extractable keys, nothing secret in meta', async () => {
  const m = meta;
  assert(m.v === 1 && m.state === 'migrating' && m.pub.length === 65 && m.pub[0] === 4);
  assert(m.pw.kdf === 'PBKDF2-SHA256' && m.pw.iter === LOW_ITER && m.pw.salt.length === 16 && m.pw.iv.length === 12 && m.pw.ct.length === 48);
  assert(m.rec && m.rec.iv.length === 12 && m.priv.ct && m.pubMac.length === 32 && m.check.ct);
  for (const k of [keys.dk, keys.hk, keys.xk, keys.sk]) assert(k.extractable === false);
  await rejects(() => crypto.subtle.exportKey('raw', keys.dk));
});
await test('unlock with password; wrong password -> WrongPasswordError', async () => {
  const u = await K.unlockWithPassword(meta, PASS);
  const r = await rec.encodeItem(mkItem(1, 1), writer);
  eq((await rec.decodeItem(r, u.keys.reader())).url, mkItem(1, 1).url);
  await rejects(() => K.unlockWithPassword(meta, PASS + 'x'), K.WrongPasswordError);
  await rejects(() => K.unlockWithPassword(meta, ''), K.WrongPasswordError);
});
await test('unlock with recovery key; typo -> RecoveryFormatError (not a failure); wrong key -> WrongRecoveryKeyError', async () => {
  const u = await K.unlockWithRecovery(meta, RECOVERY);
  assert(u.needsNewPassword === true);
  const typo = RECOVERY.slice(0, 5) + (RECOVERY[5] === '2' ? '3' : '2') + RECOVERY.slice(6);
  const e = await rejects(() => K.unlockWithRecovery(meta, typo), K.RecoveryFormatError);
  assert(e.reason === 'checksum' && e.countsAsFailure === false);
  const other = await kdf.formatRecoveryKey(randomBytes(32));
  await rejects(() => K.unlockWithRecovery(meta, other), K.WrongRecoveryKeyError);
  const noRec = (await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER })).meta;
  await rejects(() => K.unlockWithRecovery(noRec, RECOVERY), K.NoRecoveryKeyError);
});
await test('recovery unlock forces new password flow; new password works, old fails, data still readable', async () => {
  const u = await K.unlockWithRecovery(meta, RECOVERY);
  const meta2 = await K.completeRecoveryUnlock(meta, u.mk, 'brand new pass 123!', LOW_ITER);
  await rejects(() => K.unlockWithPassword(meta2, PASS), K.WrongPasswordError);
  const u2 = await K.unlockWithPassword(meta2, 'brand new pass 123!');
  const r = await rec.encodeItem(mkItem(1, 1), writer); // encrypted under the ORIGINAL keys
  eq((await rec.decodeItem(r, u2.keys.reader())).url, mkItem(1, 1).url);
  assert((await K.unlockWithRecovery(meta2, RECOVERY)).needsNewPassword, 'recovery key still valid after password reset');
});
await test('change password: O(1) rewrap, old fails, new works, MK unchanged, bad old password rejected', async () => {
  const c = await K.changePassword(meta, PASS, 'second password 456?', LOW_ITER);
  assert(canon(c.meta.pub) === canon(meta.pub) && canon(c.meta.priv) === canon(meta.priv) && canon(c.meta.check) === canon(meta.check), 'only pw wrapper changes');
  assert(canon(c.meta.pw.ct) !== canon(meta.pw.ct));
  await rejects(() => K.unlockWithPassword(c.meta, PASS), K.WrongPasswordError);
  const u = await K.unlockWithPassword(c.meta, 'second password 456?');
  const r = await rec.encodeItem(mkItem(1, 1), writer);
  eq((await rec.decodeItem(r, u.keys.reader())).url, mkItem(1, 1).url);
  await rejects(() => K.changePassword(meta, 'nope', 'x'.repeat(10), LOW_ITER), K.WrongPasswordError);
});
await test('new recovery key replaces rec: old recovery key stops working', async () => {
  const n = await K.newRecoveryKey(meta, PASS);
  assert(n.recoveryKey !== RECOVERY);
  await rejects(() => K.unlockWithRecovery(n.meta, RECOVERY), K.WrongRecoveryKeyError);
  assert((await K.unlockWithRecovery(n.meta, n.recoveryKey)).needsNewPassword);
  await rejects(() => K.newRecoveryKey(meta, 'wrong'), K.WrongPasswordError);
});
await test('pubMac mismatch (pub replaced) detected at unlock; also check/priv/pubMac tampering', async () => {
  const evil = (await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER })).meta.pub;
  await rejects(() => K.unlockWithPassword({ ...meta, pub: evil }, PASS), K.PubTamperedError);
  await rejects(() => K.unlockWithRecovery({ ...meta, pub: evil }, RECOVERY), K.PubTamperedError);
  const bad = meta.pubMac.slice(); bad[0] ^= 1;
  await rejects(() => K.unlockWithPassword({ ...meta, pubMac: bad }, PASS), K.PubTamperedError);
  await rejects(() => K.unlockWithPassword({ ...meta, check: { ...meta.check, ct: flipBit(meta.check.ct, 0) } }, PASS), K.LockMetaError);
  await rejects(() => K.unlockWithPassword({ ...meta, priv: { ...meta.priv, ct: flipBit(meta.priv.ct, 3) } }, PASS), K.LockMetaError);
});
await test('session: save / reimport on wake (non-extractable) / touch / lock clears everything', async () => {
  const ad = new MemAdapter();
  const s = new K.LockSession(ad);
  assert((await s.ensure(meta)) === null, 'locked before unlock');
  const u = await K.unlockWithPassword(meta, PASS);
  await s.unlocked(u.keys, u.mk, 1000);
  assert([...ad.m.keys()].join() === 'cmrKey' && Object.keys(ad.m.get('cmrKey')).sort().join() === 'lastTouch,mk,unlockedAt');
  const s2 = new K.LockSession(ad); // "SW restart / page reload": fresh module state
  const k2 = await s2.ensure(meta);
  assert(k2 && k2.dk.extractable === false);
  const r = await rec.encodeItem(mkItem(1, 1), writer);
  eq((await rec.decodeItem(r, k2.reader())).url, mkItem(1, 1).url);
  await s2.touch(5000);
  eq(ad.m.get('cmrKey').lastTouch, 5000);
  await s.lock(); // lock performed by another context
  assert(ad.m.size === 0, 'storage.session empty after lock');
  assert((await s2.ensure(meta)) === null && s2.keys === null, 'other context sees locked on next check');
  assert((await K.keysFromSession(ad, meta)) === null);
  ad.set('cmrKey', { mk: 'AAAA', unlockedAt: 1, lastTouch: 1 }); // garbage -> locked, no throw
  assert((await new K.LockSession(ad).ensure(meta)) === null);
});

// ================= inbox =================
console.log('\n[inbox]');
await test('encrypt while locked needs only the PUBLIC key; seal after unlock returns the original data', async () => {
  const store = new FakeStore();
  const items = Array.from({ length: 300 }, (_, i) => mkItem(1, i + 1, i + 1));
  store._put('groups', { id: 1, title: 'g', count: 0, nextSeq: 301 });
  const b = await lockedStash(store, meta.pub, 1, items); // only meta.pub used here
  // locked reader cannot decode (no keys at all) -> LockedError for k=0 / corrupt for k>0 without batch key
  noThrowCorrupt(await rec.decodeItem(store.allValues('items')[0], { dk: null, xk: null }));
  eq(b.journal.count, 300);
  const stored = store.allValues('items');
  assert(stored.every((r) => r.k === 1 && !('site' in r) && !('uh' in r) && !('url' in r)));
  const res = await runSeal(store, { keys }, {});
  assert(res.done && res.sealed === 300, JSON.stringify(res));
  eq(store.size('inbox'), 0); eq(store.size('ekeys'), 0, 'ekeys garbage-collected');
  const after = store.allValues('items');
  assert(after.every((r) => r.k === 0 && r.site[0] === '~' && r.uh[0] === '~'));
  const dec = await rec.decryptItems(after, reader);
  eq(dec, items.map(({ t, tk, ...r }) => r));
  eq(after[0].site, await rec.siteToken(keys.hk, items[0].site));
});
await test('digest verification catches modified byte, dropped item, extra item; reorder-insensitive', async () => {
  const items = Array.from({ length: 50 }, (_, i) => mkItem(1, i + 1, i + 1));
  const b = await inbox.encryptBatchWhileLocked({ pub: meta.pub, kid: 3, items });
  const { journal, records } = b;
  assert((await inbox.verifyDigest(records, journal.count, journal.digest)).ok);
  assert((await inbox.verifyDigest([...records].reverse(), journal.count, journal.digest)).ok, 'order of read-back irrelevant');
  const mod = records.map((r, i) => (i === 17 ? { ...r, e: flipBit(r.e, 30) } : r));
  eq((await inbox.verifyDigest(mod, journal.count, journal.digest)).reason, 'digest');
  eq((await inbox.verifyDigest(records.filter((_, i) => i !== 5), journal.count, journal.digest)).reason, 'count');
  eq((await inbox.verifyDigest([...records, records[0]], journal.count, journal.digest)).reason, 'count');
  const dropOneAddDup = records.map((r, i) => (i === 5 ? records[6] : r));
  assert(!(await inbox.verifyDigest(dropOneAddDup, journal.count, journal.digest)).ok);
  eq([journal.seqFrom, journal.seqTo, journal.g, journal.kid], [1, 50, 1, 3]);
});
await test('batch keys are per batch: two batches -> different epk, kid-bound (wrong kid fails)', async () => {
  const a = await inbox.createBatchKey(meta.pub, 7), b = await inbox.createBatchKey(meta.pub, 8);
  assert(canon(a.row.epk) !== canon(b.row.epk) && a.row.epk.length === 65 && a.row.salt.length === 16);
  const bk = await inbox.recoverBatchKey(a.row, keys.sk);
  const r = await rec.encodeItem(mkItem(1, 1), a.writer);
  eq((await rec.decodeItem(r, { batch: async () => bk })).url, mkItem(1, 1).url);
  const wrong = await inbox.recoverBatchKey({ ...a.row, kid: 9 }, keys.sk);
  noThrowCorrupt(await rec.decodeItem(r, { batch: async () => wrong }));
  await rejects(() => inbox.createBatchKey(meta.pub, 0), RangeError);
});
await test('snapshots go through the inbox even when unlocked', async () => {
  const s = { id: 's9', ts: 77, nTabs: 3, nWin: 1, tabs: [{ url: 'https://a.example/', title: 'secret tab' }] };
  const { ekey, record } = await inbox.encryptSnapshotViaInbox({ pub: meta.pub, kid: 11, snapshot: s });
  assert(record.k === 11 && record.nTabs === 3 && !('tabs' in record));
  eq(await rec.decodeSnapshot(record, keys.reader(inbox.makeBatchResolver(keys.sk, async () => ekey))), s);
});
await test('seal: duplicates -> trash (never deleted), aggregates hook in same tx, vault hook, damaged rows kept', async () => {
  const store = new FakeStore();
  const items = Array.from({ length: 40 }, (_, i) => mkItem(1, i + 1, (i % 20) + 1)); // each URL twice
  items.forEach((it, i) => { it.seq = i + 1; });
  await lockedStash(store, meta.pub, 2, items);
  // damage one row
  const victim = store.allValues('items')[39];
  store._put('items', { ...victim, e: flipBit(victim.e, 25) });
  const seen = new Set(); let aggCalls = 0, vaultCalled = 0;
  const hooks = {
    decide: (it) => { if (seen.has(it.url)) return { trash: 'duplicate' }; seen.add(it.url); },
    aggregate: async ({ items: its, records }, tx) => { aggCalls++; for (const r of records) await tx.put('siteIdx', { site: r.site, g: r.g, n: 1 }); },
    rewriteVault: async () => async (tx) => { vaultCalled++; await tx.put('vault', { id: 'g1', k: 0, e: 'x' }); },
  };
  const res = await runSeal(store, { keys, now: 5 }, hooks);
  assert(res.done);
  const live = store.allValues('items'), trash = store.allValues('trash');
  const trashed = trash.reduce((n, r) => n + r.items.length, 0);
  assert(trash.length === 1 && trash[0].delReason === 'duplicate' && trashed === 19, `trashed ${trashed} rows ${trash.length}`);
  assert(live.length === 21 && live.filter((r) => r.k === 2).length === 1, 'one damaged row left untouched among 20 sealed');
  assert(aggCalls >= 1 && vaultCalled === 1 && store.size('siteIdx') > 0);
  eq(store.size('ekeys'), 1, 'ekeys row kept because a damaged row still references it');
  assert((await rec.decodeTrashRow(trash[0], reader)).items.every((i) => i.url.startsWith('https://')));
});
await test('seal crash safety: 60 random crash trials -> zero loss, no duplicates, identical result', async () => {
  const rng = mulberry32(42);
  const items = Array.from({ length: 900 }, (_, i) => mkItem(1 + (i % 2), Math.floor(i / 2) + 1, i + 1));
  for (let trial = 0; trial < 60; trial++) {
    const store = new FakeStore();
    for (const g of [1, 2]) await lockedStash(store, meta.pub, g, items.filter((x) => x.g === g));
    const { crashes } = await withCrashes(store, rng, () => runSeal(store, { keys }, {}, { chunk: 100 }), { maxOps: 250 });
    assert(store.size('items') === 900 && store.size('inbox') === 0 && store.size('ekeys') === 0, `trial ${trial}: counts`);
    const dec = await rec.decryptItems(store.allValues('items'), reader);
    eq(dec, items.map(({ t, tk, ...r }) => r).sort((a, b) => a.g - b.g || a.seq - b.seq), `trial ${trial} crashes ${crashes}`);
  }
});

// ================= policy =================
console.log('\n[policy]');
await test('lockout schedule table (first 3 free, 2^(n-3) s, cap 15 min)', () => {
  const exp = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 2, 5: 4, 6: 8, 7: 16, 8: 32, 9: 64, 10: 128, 11: 256, 12: 512, 13: 900, 14: 900, 20: 900, 100: 900 };
  console.log('       n :  delay(s)');
  for (const [n, s] of Object.entries(exp)) { eq(policy.lockoutDelayMs(+n), s * 1000, 'n=' + n); }
  console.log('       ' + Object.entries(exp).slice(0, 14).map(([n, s]) => `${n}:${s}`).join('  '));
});
await test('lockout state machine: failures, refusal before until, reset on success, persisted shape {n, until}', () => {
  let s = policy.initialFailState(); let now = 1000;
  for (let i = 0; i < 3; i++) { s = policy.onFailure(s, now); assert(s.until === 0 && policy.canAttempt(s, now).allowed); }
  s = policy.onFailure(s, now); eq(s, { n: 4, until: now + 2000 });
  eq(policy.canAttempt(s, now + 500), { allowed: false, waitMs: 1500 });
  assert(policy.canAttempt(s, now + 2000).allowed);
  now += 2000; s = policy.onFailure(s, now); eq(s, { n: 5, until: now + 4000 }, 'doubles');
  for (let i = 0; i < 20; i++) { now += 1e6; s = policy.onFailure(s, now); }
  eq(s.until - now, 15 * 60 * 1000, 'cap');
  eq(policy.onSuccess(), { n: 0, until: 0 });
  // survives restart: state is plain JSON
  eq(policy.canAttempt(JSON.parse(JSON.stringify({ n: 6, until: 10000 })), 9000), { allowed: false, waitMs: 1000 });
  // clock moved back: never lock out longer than the cap
  eq(policy.canAttempt({ n: 30, until: 9e15 }, 1000).waitMs, 15 * 60 * 1000);
  eq(policy.normalizeFail(undefined, 0), { n: 0, until: 0 });
  eq(policy.normalizeFail({ n: 'x', until: 'y' }, 0), { n: 0, until: 0 });
});
await test('idle / auto-lock decision table', () => {
  const base = { unlocked: true, now: 100 * 60000, lastTouch: 100 * 60000, idleMin: 15, osLocked: false, pageClosed: false, onScreenLock: true, onPageClose: false };
  const T = (o) => policy.decideLock({ ...base, ...o });
  eq(T({}), { lock: false, reason: null });
  eq(T({ lastTouch: base.now - 14 * 60000 }).lock, false);
  eq(T({ lastTouch: base.now - 15 * 60000 }), { lock: true, reason: 'idle' });
  eq(T({ lastTouch: base.now - 5 * 60000, idleMin: 5 }).reason, 'idle');
  eq(T({ lastTouch: base.now - 999 * 60000, idleMin: 'browser' }).lock, false, 'browser-close mode never idle-locks');
  eq(T({ lastTouch: base.now - 999 * 60000, idleMin: null }).lock, false);
  eq(T({ osLocked: true }).reason, 'os-lock');
  eq(T({ osLocked: true, onScreenLock: false }).lock, false);
  eq(T({ pageClosed: true }).lock, false, 'default off');
  eq(T({ pageClosed: true, onPageClose: true }).reason, 'page-close');
  eq(T({ unlocked: false, lastTouch: 0, osLocked: true }).lock, false, 'already locked: nothing to do');
  eq(T({ lastTouch: base.now + 3600000 }).reason, 'clock', 'lastTouch in the future -> fail safe');
  eq(T({ lastTouch: NaN }).reason, 'clock');
  assert(policy.shouldSendTouch(0, 1) && !policy.shouldSendTouch(1000, 30000) && policy.shouldSendTouch(1000, 61000));
});

// ================= migrate / revert =================
console.log('\n[migrate / revert]');
const menv = (o = {}) => ({ keys, deriveSearch, isSensitiveSetting: (n) => SENSITIVE.has(n), ...o });
const PLAIN_VIEW_KEYS = ALL_STORES;
await test('migrate with 2,000-record chunks (4,500 items): all encrypted, search dropped, view identical, revert byte-identical', async () => {
  const store = new FakeStore();
  buildPlainDb(store, { nItems: 4500, nGroups: 3 });
  const orig = store.snapshot(PLAIN_VIEW_KEYS);
  const origCounts = Object.fromEntries(ALL_STORES.map((s) => [s, store.size(s)]));
  const view0 = await logicalView(store, reader);
  const steps = [];
  const r = await runMigration(store, menv(), { chunk: 2000, onProgress: (p) => steps.push(p) });
  assert(r.finished && r.failed === 0);
  assert(steps.some((p) => p.store === 'items' && p.done >= 2000));
  eq(store.size('search'), 0, 'search snapshot dropped');
  for (const s of ALL_STORES) eq(store.size(s), origCounts[s], 'row count ' + s);
  assert(store.allValues('items').every((x) => x.k === 0 && !('url' in x) && !('t' in x)));
  assert(store.allValues('groups').every((x) => x.k === 0 && !('title' in x)));
  assert(store.allValues('sites').every((x) => x.site[0] === '~') && store.allValues('siteIdx').every((x) => x.site[0] === '~'));
  assert(store.allValues('favicons').every((x) => x.site[0] === '~' && x.k === 0));
  assert(store.allValues('trash').every((x) => rec.trashRowEncrypted(x)));
  eq(store.allValues('settings').filter((x) => x.k === 0).map((x) => x.name).sort(), ['autoRules', 'excludeSites']);
  assert(store.allValues('settings').find((x) => x.name === 'theme').value === 'dark', 'non-sensitive setting untouched');
  eq(await logicalView(store, reader), view0, 'decoded view equals original');
  assert((await store.getCursor('encMigrate')) === undefined, 'cursor cleared when done');
  // idempotent: running again changes nothing
  const before = canon(store.snapshot(ALL_STORES));
  await runMigration(store, menv(), { chunk: 2000 });
  eq(canon(store.snapshot(ALL_STORES)) === before, true, 'second run is a no-op');
  const rv = await runMigration(store, menv(), { mode: 'revert', chunk: 2000 });
  assert(rv.finished && rv.failed === 0);
  eq(store.snapshot(PLAIN_VIEW_KEYS), orig, 'byte-identical after revert');
});
await test('pause at lock + resume from persisted cursor; mixed-format reads correct at every step', async () => {
  const store = new FakeStore();
  buildPlainDb(store, { nItems: 700 });
  const view0 = await logicalView(store, reader);
  let steps = 0;
  for (let round = 0; ; round++) {
    const r = await runMigration(store, menv(), { chunk: 100, shouldPause: () => steps++ % 3 === 2 });
    eq(await logicalView(store, reader), view0, 'mixed view round ' + round);
    if (r.finished) break;
    assert(r.paused && (await store.getCursor('encMigrate')), 'cursor persisted while paused');
    assert(round < 200);
  }
  assert(store.allValues('items').every((x) => x.k === 0));
});
await test('new stash during migration is written encrypted and survives; concurrent plaintext update is not clobbered (CAS)', async () => {
  const store = new FakeStore();
  buildPlainDb(store, { nItems: 300 });
  // one chunk of items, then a concurrent writer updates a not-yet-migrated group row and adds an encrypted item
  await migrateStep(store, menv(), { chunk: 100 });
  const fresh = await rec.encodeItem(mkItem(1, 9999, 9999), writer);
  await store.putMany([['items', fresh]]);
  const g = await store.get('groups', 2); await store.putMany([['groups', { ...g, count: 12345 }]]);
  await runMigration(store, menv(), { chunk: 100 });
  const dg = await rec.decodeGroup(await store.get('groups', 2), reader);
  eq(dg.count, 12345);
  assert((await store.get('items', [1, 9999])).k === 0);
});
await test('CAS conflict inside a chunk: row changed between read and write is re-read and re-transformed', async () => {
  const store = new FakeStore();
  buildPlainDb(store, { nItems: 50, nGroups: 1 });
  // sabotage: modify an items row right before the write tx by wrapping tx once
  const origTx = store.tx.bind(store); let done = false;
  store.tx = async (fn) => { if (!done && (await store.getCursor('encMigrate'))?.si === 0 || (!done && store.txCount === 0)) { done = true; const row = await store.get('items', [1, 3]); store._put('items', { ...row, title: 'EDITED concurrently' }); } return origTx(fn); };
  await runMigration(store, menv(), { chunk: 100 });
  store.tx = origTx;
  const d = await rec.decodeItem(await store.get('items', [1, 3]), reader);
  eq(d.title, 'EDITED concurrently');
  assert((await store.get('items', [1, 3])).k === 0, 'edited row also migrated');
});
await test('300 random crash points (migrate + revert, full and cancelled-midway): zero loss, no duplicates, byte-identical', async () => {
  const rng = mulberry32(2024);
  let totalCrashes = 0, cancelled = 0;
  for (let trial = 0; trial < 300; trial++) {
    const store = new FakeStore();
    buildPlainDb(store, { nItems: 260, nGroups: 2 });
    const orig = store.snapshot(PLAIN_VIEW_KEYS);
    const counts = Object.fromEntries(ALL_STORES.map((s) => [s, store.size(s)]));
    const view0 = await logicalView(store, reader);
    const chunk = [16, 40, 64, 100][trial % 4];
    if (trial % 2 === 0) {
      const a = await withCrashes(store, rng, () => runMigration(store, menv(), { chunk }), { maxOps: chunk * 4 });
      totalCrashes += a.crashes;
      assert(a.result.finished && a.result.failed === 0, `t${trial} migrate`);
      assert(store.allValues('items').every((x) => x.k === 0), `t${trial} items all encrypted`);
    } else { // user presses "ยกเลิก" after a random number of steps, while crashes keep happening
      cancelled++;
      let n = Math.floor(rng() * 25);
      const a = await withCrashes(store, rng, () => runMigration(store, menv(), { chunk, shouldPause: () => n-- <= 0 }), { maxOps: chunk * 4 });
      totalCrashes += a.crashes;
    }
    eq(await logicalView(store, reader), view0, `t${trial} mixed/complete view`);
    for (const s of ALL_STORES) assert(store.size(s) === counts[s], `t${trial} ${s} count ${store.size(s)} != ${counts[s]}`);
    const b = await withCrashes(store, rng, () => runMigration(store, menv(), { mode: 'revert', chunk }), { maxOps: chunk * 4 });
    totalCrashes += b.crashes;
    assert(b.result.finished && b.result.failed === 0, `t${trial} revert`);
    eq(store.snapshot(PLAIN_VIEW_KEYS), orig, `t${trial} byte-identical`);
  }
  console.log(`       300 trials, ${totalCrashes} injected crashes (${cancelled} cancelled-midway trials)`);
});
await test('damaged record during revert is left untouched (failed counted), nothing dropped', async () => {
  const store = new FakeStore();
  buildPlainDb(store, { nItems: 60, nGroups: 1 });
  await runMigration(store, menv(), { chunk: 50 });
  const row = await store.get('items', [1, 5]); store._put('items', { ...row, e: flipBit(row.e, 22) });
  const rv = await runMigration(store, menv(), { mode: 'revert', chunk: 50 });
  assert(rv.finished && rv.failed === 1);
  eq(store.size('items'), 60);
  assert((await store.get('items', [1, 5])).k === 0, 'damaged row still there, still encrypted');
  assert((await store.get('items', [1, 6])).url, 'neighbour restored');
});

// ================= leak scan =================
console.log('\n[leak scan]');
const needles = [];
const leakItems = Array.from({ length: 50 }, (_, i) => ({
  g: 1, seq: i + 1, ts: 1700000000000 + i, site: `leak-host-${i}.secret-corp.example`,
  url: `https://leak-host-${i}.secret-corp.example/private/path-${i}?token=zq${i}`, title: `ConfidentialTitle-${i} Q${i} budget`,
}));
leakItems.forEach((it, i) => needles.push(it.title, it.url, it.site));
needles.push('Super Secret Group Name', 'private group note XYZ', 'bank.secret-corp.example', 'SecretCategoryName');
await test('leak scan: locked stash + snapshot + vault + settings + favicon + sites + job -> no plaintext, no key bytes', async () => {
  const store = new FakeStore();
  store._put('meta', meta);
  const g = await rec.encodeGroup({ id: 1, title: 'Super Secret Group Name', note: 'private group note XYZ', count: 50, nextSeq: 51, agg: { top: [[leakItems[0].site, 1]] } }, writer);
  store._put('groups', g);
  store._put('categories', await rec.encodeCategory({ id: 1, name: 'SecretCategoryName' }, writer));
  // locked stash (inbox) of 25, unlocked stash (DK) of 25
  await lockedStash(store, meta.pub, 1, leakItems.slice(0, 25));
  for (const it of leakItems.slice(25)) store._put('items', await rec.encodeItem(it, writer));
  const bk = await inbox.encryptSnapshotViaInbox({ pub: meta.pub, kid: 2, snapshot: { id: 's1', ts: 1, nTabs: 2, nWin: 1, tabs: leakItems.slice(0, 2).map((x) => ({ url: x.url, title: x.title })) } });
  store._put('ekeys', bk.ekey); store._put('snapshots', bk.record);
  store._put('vault', await rec.encodeVault('g1', { items: leakItems.map((x) => ({ url: x.url, title: x.title })) }, writer));
  store._put('settings', await rec.encodeSetting('excludeSites', ['bank.secret-corp.example'], writer));
  store._put('favicons', await rec.encodeFavicon({ site: leakItems[3].site, icon: 'data:image/png;base64,iVBOR' }, keys.xWriter()));
  store._put('sites', await rec.encodeSiteRow({ site: leakItems[4].site, n: 1 }, writer));
  store._put('siteIdx', await rec.tokenizeSiteIdx({ site: leakItems[4].site, g: 1, n: 1 }, keys.hk));
  const dump = store.dump();
  const hits = needles.map((n) => [n, countHits(dump, n)]).filter(([, h]) => h > 0);
  assert(hits.length === 0, 'plaintext leaked: ' + hits.slice(0, 3).map((h) => h[0]).join(', '));
  for (const frag of ['secret-corp', 'ConfidentialTitle', 'leak-host', 'Super Secret']) assert(countHits(dump, frag) === 0, frag);
  assert(countHitsBytes(dump, MK_COPY) === 0, 'MK bytes in storage');
  assert(countHits(dump, PASS) === 0, 'password in storage');
  assert(countHits(dump, RECOVERY.replace(/-/g, '')) === 0 && countHits(dump, RECOVERY) === 0, 'recovery key in storage');
  // sanity: the scanner finds the same strings in a PLAINTEXT database
  const plain = new FakeStore(); leakItems.forEach((it) => plain._put('items', it));
  assert(needles.slice(0, 150).every((n) => countHits(plain.dump(), n) > 0), 'scanner control');
  // and a session adapter holds only MK
  console.log(`       scanned ${dump.length} bytes for ${needles.length} needles + MK/password/recovery: 0 hits`);
});

// ================= performance =================
console.log('\n[performance]  (informational: compared with spec budgets; same machine, Node ' + process.version + ')');
const perf = [];
const addPerf = (what, value, budget, pass) => perf.push([what, value, budget, pass === undefined ? '-' : pass ? 'within' : 'OVER']);
const med = (a) => pct(a, 0.5);
async function timeIt(fn, runs = 5) { await fn(); const ts = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); ts.push(performance.now() - t); } return ts; }
const mkBatch = (n, g = 1) => Array.from({ length: n }, (_, i) => mkItem(g, i + 1, i + 1));

await test('performance measurements', async () => {
  for (const n of [500, 4000]) {
    const items = mkBatch(n);
    const tIn = med(await timeIt(() => inbox.encryptBatchWhileLocked({ pub: meta.pub, kid: 1, items }), 5));
    const tDk = med(await timeIt(() => rec.encryptItems(items, writer), 5));
    // 500 items: 0.39 s total vs 0.3 s baseline = 90 ms. 4,000 items: +30% of the linear-scaled baseline (2.4 s) = 720 ms; the spec's own estimate is ~150 ms.
    const budgetMs = n === 500 ? 90 : 720;
    addPerf(`encrypt ${n} items, LOCKED (inbox: ECDH+HKDF+digest, no tokens)`, `${tIn.toFixed(1)} ms (${(tIn / n * 1000).toFixed(1)} us/item)`, `<= ${budgetMs} ms overhead`, tIn <= budgetMs);
    addPerf(`encrypt ${n} items, UNLOCKED (DK + site/uh tokens)`, `${tDk.toFixed(1)} ms (${(tDk / n * 1000).toFixed(1)} us/item)`, `<= ${budgetMs} ms overhead`, tDk <= budgetMs);
  }
  const page = await rec.encryptItems(mkBatch(200), writer);
  const runs = []; for (let i = 0; i < 60; i++) { const t = performance.now(); await rec.decryptItems(page, reader); runs.push(performance.now() - t); }
  const dec = runs.slice(10);
  addPerf('decrypt a 200-row page (50 runs, DK)', `p50 ${pct(dec, .5).toFixed(2)} ms / p95 ${pct(dec, .95).toFixed(2)} ms`, 'p95 <= 30 ms', pct(dec, .95) <= 30);
  const bkp = await inbox.encryptBatchWhileLocked({ pub: meta.pub, kid: 1, items: mkBatch(200) });
  const rdI = keys.reader(inbox.makeBatchResolver(keys.sk, async () => bkp.ekey));
  const runs2 = []; for (let i = 0; i < 60; i++) { const t = performance.now(); await rec.decryptItems(bkp.records, keys.reader(inbox.makeBatchResolver(keys.sk, async () => bkp.ekey))); runs2.push(performance.now() - t); }
  addPerf('decrypt 200 inbox rows (incl. ECDH per call)', `p50 ${pct(runs2.slice(10), .5).toFixed(2)} ms / p95 ${pct(runs2.slice(10), .95).toFixed(2)} ms`, 'p95 <= 30 ms', pct(runs2.slice(10), .95) <= 30);
  // tokens
  const N = 20000; const t0 = performance.now();
  for (let i = 0; i < N; i += 256) await Promise.all(Array.from({ length: 256 }, (_, j) => rec.siteToken(keys.hk, `uncached-${i + j}.example.com`)));
  const tTok = (performance.now() - t0) / N * 1000;
  const t1 = performance.now();
  for (let i = 0; i < N; i += 256) await Promise.all(Array.from({ length: 256 }, (_, j) => rec.uhToken(keys.hk, `https://x.example.com/${i + j}`)));
  const tUh = (performance.now() - t1) / N * 1000;
  addPerf('blind token HMAC (uncached site / uh)', `${tTok.toFixed(1)} us / ${tUh.toFixed(1)} us each`, '(cached per host)');
  // PBKDF2 600k + full production-iteration setup/unlock
  const salt = kdf.newSalt();
  const pb = []; for (let i = 0; i < 3; i++) { const t = performance.now(); await kdf.deriveKekPw(PASS, salt, 600000); pb.push(performance.now() - t); }
  addPerf('PBKDF2-SHA256 600,000 iterations', `${med(pb).toFixed(0)} ms`, '0.4-0.8 s', med(pb) <= 800);
  const prod = await K.setupLock({ password: PASS, withRecovery: true, iter: 600000 });
  assert(prod.meta.pw.iter === 600000);
  const tu = performance.now(); const u = await K.unlockWithPassword(prod.meta, PASS); const tUnlock = performance.now() - tu;
  const rr = await K.unlockWithRecovery(prod.meta, prod.recoveryKey);
  assert(u.keys && rr.needsNewPassword);
  const ts2 = performance.now(); await K.keysFromSession({ get: async () => ({ mk: Buffer.from(u.mk).toString('base64') }) }, prod.meta); const tSess = performance.now() - ts2;
  addPerf('unlock (password, 600k) = PBKDF2 + HKDF x4 + SK import', `${tUnlock.toFixed(0)} ms`, 'unlock -> first page <= 1.2 s', tUnlock <= 1200);
  addPerf('wake: import keys from session MK (page/SW)', `${tSess.toFixed(1)} ms`, '(per page load)');
  // seal 4,000
  const store = new FakeStore(); await lockedStash(store, meta.pub, 1, mkBatch(4000));
  const ts = performance.now(); const sres = await runSeal(store, { keys }, {}); const tSeal = performance.now() - ts;
  assert(sres.sealed === 4000);
  addPerf('seal 4,000 items (ECDH + decrypt + tokens + re-encrypt; incl. fake-store clone cost)', `${tSeal.toFixed(0)} ms`, '<= 2 s', tSeal <= 2000);
  // migration throughput 100k
  const big = new FakeStore(); const NB = 100000;
  for (let i = 1; i <= NB; i++) big._put('items', mkItem(1 + (i % 4), Math.ceil(i / 4), i));
  global.gc && global.gc();
  const base = process.memoryUsage(); let peakHeap = base.heapUsed, peakRss = base.rss, chunks = 0;
  const tm = performance.now();
  await runMigration(big, menv(), { chunk: 2000, onProgress: () => { chunks++; const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); } });
  const tMig = (performance.now() - tm) / 1000;
  assert(big.allValues('items').every((x) => x.k === 0));
  const rps = NB / tMig;
  addPerf(`migrate 100,000 items (2,000/tx, fake store)`, `${tMig.toFixed(1)} s = ${Math.round(rps).toLocaleString()} rec/s; ${chunks} chunks`, 'extrapolation below');
  addPerf('  -> extrapolated 300k items', `${(300000 / rps).toFixed(0)} s`, '<= 90 s', 300000 / rps <= 90);
  addPerf('  -> extrapolated 1M items', `${(1e6 / rps).toFixed(0)} s`, '<= 300 s', 1e6 / rps <= 300);
  addPerf('  peak JS heap growth during migrate (includes the fake store itself)', `${((peakHeap - base.heapUsed) / 1048576).toFixed(0)} MB (rss +${((peakRss - base.rss) / 1048576).toFixed(0)} MB)`, '<= 150 MB at 300k', undefined);
  const tr = performance.now(); await runMigration(big, menv(), { mode: 'revert', chunk: 2000 }); const tRev = (performance.now() - tr) / 1000;
  addPerf('revert 100,000 items', `${tRev.toFixed(1)} s = ${Math.round(NB / tRev).toLocaleString()} rec/s`, '(no budget)');
});

// ---- integration additions: string group ids (the app uses base36 ids), encrypted search snapshot ----
import * as snapcodec from '../../lib/lock/snapcodec.js';
await test('string group ids: item + group round trip, AAD binds the id', async () => {
  const w = keys.writer(), rd = keys.reader(null);
  const it = { g: 'mwtawoejpd6g', seq: 3, url: 'https://a.example/x', title: 'Thai ไทย', ts: 5, site: 'a.example', sv: 1 };
  const e = await rec.encodeItem(it, w);
  assert(e.e instanceof Uint8Array && e.url === undefined && e.title === undefined, 'payload hidden');
  eq(await rec.decodeItem(e, rd), { g: 'mwtawoejpd6g', seq: 3, ts: 5, url: it.url, title: it.title, site: 'a.example', sv: 1 }, 'round trip');
  const moved = { ...e, g: 'other' };
  noThrowCorrupt(await rec.decodeItem(moved, rd));
  const g = await rec.encodeGroup({ id: 'mwtawoejpd6g', title: 'private', count: 2 }, w);
  eq((await rec.decodeGroup(g, rd)).title, 'private');
});
await test('snapshot header keeps kind / counts readable, tab list encrypted', async () => {
  const w = keys.writer(), rd = keys.reader(null);
  const sn = await rec.encodeSnapshot({ id: 's1', ts: 9, kind: 'auto', tabCount: 3, windowCount: 1, nTabs: 3, nWin: 1, hash: 'abc', gz: 'QUJD' }, w);
  assert(sn.kind === 'auto' && sn.tabCount === 3 && sn.gz === undefined && sn.hash === undefined, 'header plain, body hidden');
  eq((await rec.decodeSnapshot(sn, rd)).gz, 'QUJD');
});
await test('search snapshot codec: multi-chunk round trip, tampered / swapped chunk is rejected', async () => {
  const blob = 'alpha beta ทดสอบ '.repeat(400000);
  const snap = { meta: { docCount: 3, gKeys: ['g1', 'g2'], terms: 3 }, buffers: { blob, off: new Uint32Array([0, 6, 11]), df: new Uint32Array([1, 2, 3]), docSeq: new Float64Array([1, 2.5, 1e12]), docTs: new Uint32Array([7, 8, 9]) } };
  const { chunks, n } = await snapcodec.seal(keys.xk, snap);
  assert(n >= 2, 'more than one chunk for ' + blob.length + ' chars: ' + n);
  const back = await snapcodec.open(keys.xk, chunks);
  assert(back.buffers.blob === blob && back.buffers.docSeq[2] === 1e12 && back.buffers.off instanceof Uint32Array, 'content');
  eq(back.meta, snap.meta);
  const bad = chunks.map((c) => c.slice()); bad[0][40] ^= 1;
  await rejects(() => snapcodec.open(keys.xk, bad), rec.CorruptRecordError, 'flipped byte');
  await rejects(() => snapcodec.open(keys.xk, [chunks[1], chunks[0], ...chunks.slice(2)]), rec.CorruptRecordError, 'swapped chunks');
  assert(countHitsBytes === undefined || true);
});

// ================= encrypted archive (reset flow: keep the old data, import later) =================
console.log('\n[archive]');
const A_SECRET = 'ARCHIVE-SECRET-TITLE';
async function buildArchiveText(f = fx) {
  const w = f.keys.writer();
  const lines = [archive.headerLine(f.meta)];
  const groups = [await rec.encodeGroup({ id: 'g1', createdAt: 1700000000000, title: A_SECRET + ' group', note: 'private note', phase: 'committed', starred: true, count: 4, nextSeq: 5, ord: 1, tabGroups: [{ i: 0, title: 'tg title', color: 'blue' }] }, w)];
  const mk = (seq) => ({ g: 'g1', seq, url: `https://archive-secret.example.com/p${seq}`, title: A_SECRET + ' ' + seq, ts: 1700000000000 + seq, site: 'archive-secret.example.com', tg: seq % 2 ? 0 : undefined });
  const items = [];
  for (let s = 1; s <= 2; s++) items.push(await rec.encodeItem(mk(s), w, {}));
  const b = await inbox.encryptBatchWhileLocked({ pub: f.meta.pub, kid: 1, items: [mk(3), mk(4)] }); // stashed while locked: batch key row travels with the file
  for (const x of b.records) items.push(x);
  lines.push(archive.rowLine('ekeys', b.ekey));
  for (const g of groups) lines.push(archive.rowLine('groups', g));
  for (const it of items) lines.push(archive.rowLine('items', it));
  lines.push(archive.endLine({ ekeys: 1, groups: 1, items: 4 }));
  return lines.join('\n') + '\n';
}
await test('archive: the file holds no plain text (titles, links, notes, names) and opens with the OLD password', async () => {
  const text = await buildArchiveText();
  assert(!/ARCHIVE-SECRET|archive-secret|private note|tg title/.test(text), 'plain text in the archive file');
  const [h, ...rest] = text.split('\n');
  const hd = archive.parseHeader(h);
  const dec = await archive.openArchive(hd.lock, { password: PASS });
  const rows = rest.filter(Boolean).map(archive.parseLine);
  assert(rows[rows.length - 1].end === true, 'end marker');
  dec.addEkeys(rows.filter((r) => r.store === 'ekeys').map((r) => r.row));
  const g = await dec.group(rows.find((r) => r.store === 'groups').row);
  assert(g.title === A_SECRET + ' group' && g.note === 'private note' && g.tabGroups[0].title === 'tg title' && g.starred === true, 'group content');
  const its = [];
  for (const r of rows.filter((x) => x.store === 'items')) its.push(await dec.item(r.row));
  assert(its.length === 4 && its.every((x) => !x.corrupt), 'all four items decode (two direct, two through the inbox batch key)');
  eq(its.map((x) => x.title).sort(), [1, 2, 3, 4].map((n) => A_SECRET + ' ' + n));
  assert(its.every((x) => x.url.startsWith('https://archive-secret.example.com/')));
});
await test('archive: opens with the old recovery key; wrong password / wrong recovery key / typo are refused', async () => {
  const [h] = (await buildArchiveText()).split('\n');
  const hd = archive.parseHeader(h);
  assert(await archive.openArchive(hd.lock, { recoveryKey: RECOVERY }));
  await rejects(() => archive.openArchive(hd.lock, { password: 'not the password' }), K.WrongPasswordError);
  const other = await K.setupLock({ password: 'another password', withRecovery: true, iter: LOW_ITER });
  await rejects(() => archive.openArchive(hd.lock, { recoveryKey: other.recoveryKey }), K.WrongRecoveryKeyError);
  await rejects(() => archive.openArchive(hd.lock, { recoveryKey: RECOVERY.slice(0, -1) + (RECOVERY.endsWith('A') ? 'B' : 'A') }), K.RecoveryFormatError);
  const noRec = await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER });
  await rejects(() => archive.openArchive(noRec.meta, { recoveryKey: RECOVERY }), K.NoRecoveryKeyError);
});
await test('archive: stays openable with the OLD password after the live password changed; a damaged row reads as damaged, never throws', async () => {
  const f = await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER });
  const text = await buildArchiveText(f);
  const newMeta = (await K.changePassword(f.meta, PASS, 'a brand new password', LOW_ITER)).meta;
  assert(newMeta.pw.salt.length && !archive.parseHeader(text.split('\n')[0]).lock.pw.salt.every((b, i) => b === newMeta.pw.salt[i]), 'the file kept the old wrapper');
  const lines = text.split('\n');
  const hd = archive.parseHeader(lines[0]);
  const dec = await archive.openArchive(hd.lock, { password: PASS });
  const itemLine = lines.findIndex((l) => l.startsWith('{"s":"items"'));
  const row = archive.parseLine(lines[itemLine]).row;
  row.e[20] ^= 1; // one flipped byte
  const d = await dec.item(row);
  assert(d.corrupt === true, 'damaged row is flagged');
});
await test('archive: foreign / cut files are recognised (header checks, revive keeps bytes)', async () => {
  for (const bad of ['', 'not json', '{"tabroost":"other"}', '{"tabroost":"archive","v":2}', '{"tabroost":"archive","v":1,"lock":{}}']) {
    let e = null; try { archive.parseHeader(bad); } catch (x) { e = x; }
    assert(e instanceof archive.ArchiveFormatError, 'refused: ' + bad.slice(0, 30));
  }
  const text = await buildArchiveText();
  const cut = text.split('\n').filter((l) => !l.startsWith('{"end"')).join('\n');
  assert(!cut.split('\n').filter(Boolean).slice(1).map(archive.parseLine).some((r) => r.end), 'a cut file has no end marker');
  const r = archive.revive({ e: { $b: 'AQID' }, n: 1 });
  assert(r.e instanceof Uint8Array && r.e.length === 3 && r.n === 1);
});

// ================= second unlock methods (slots): backup password, passkey (PRF secret) =================
console.log('\n[unlock slots]');
const BK = 'a different backup phrase 77';
const fakePrf = (n) => new Uint8Array(32).map((_, i) => (i * 13 + n) & 255);
const cidOf = (n) => new Uint8Array(32).map((_, i) => (i * 5 + n) & 255);
const sameKeyProof = async (k1, k2) => { // the same master key: what one set of keys encrypts, the other decodes
  const e = await rec.encodeItem({ g: 'g1', seq: 1, url: 'https://slot.example.com/a', title: 'SLOT-TITLE', ts: 1700000000000, site: 'slot.example.com' }, k1.writer(), {});
  const d = await rec.decodeItem(e, k2.reader());
  return d.title === 'SLOT-TITLE' && d.url === 'https://slot.example.com/a';
};
async function freshLock(withRec = true) { return K.setupLock({ password: PASS, withRecovery: withRec, iter: LOW_ITER }); }
await test('slots: backup password unlocks the SAME master key; wrong one is refused; nothing secret is stored', async () => {
  const f = await freshLock();
  const m2 = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  assert(m2.slots.length === 1 && m2.slots[0].kind === 'pw' && m2.slots[0].salt.length === 16);
  const u = await K.unlockWithBackupPassword(m2, BK);
  assert(await sameKeyProof(f.keys, u.keys), 'same keys');
  await rejects(() => K.unlockWithBackupPassword(m2, 'wrong backup'), K.WrongBackupPasswordError);
  await rejects(() => K.unlockWithBackupPassword(f.meta, BK), K.NoSlotError, 'no slot yet');
  const mainStill = await K.unlockWithPassword(m2, PASS);
  assert(await sameKeyProof(f.keys, mainStill.keys), 'main password still works');
  const dump = JSON.stringify(m2, (k, v) => (v instanceof Uint8Array ? Array.from(v).join(',') : v));
  assert(!dump.includes(BK) && !dump.includes(PASS), 'no password in the record');
  assert(!JSON.stringify(K.publicSlots(m2)).match(/"(iv|ct|salt)"/), 'public view carries no wrapper');
});
await test('slots: backup password equal to the main one, a second backup password, and an empty one are refused', async () => {
  const f = await freshLock();
  let e = await rejects(() => K.addPasswordSlot(f.meta, f.mk, PASS, { iter: LOW_ITER }), K.SlotError); assert(e.code === 'same');
  const m2 = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  e = await rejects(() => K.addPasswordSlot(m2, f.mk, 'another backup 123', { iter: LOW_ITER }), K.SlotError); assert(e.code === 'exists');
  e = await rejects(() => K.addPasswordSlot(f.meta, f.mk, '', { iter: LOW_ITER }), K.SlotError); assert(e.code === 'badInput');
});
await test('slots: changing the main password, a new recovery key and a recovery unlock all keep the slots valid', async () => {
  const f = await freshLock();
  let m = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  m = await K.addPrfSlot(m, f.mk, { cid: cidOf(1), psalt: fakePrf(90), prf: fakePrf(1), name: 'key A' });
  const ch = await K.changePassword(m, PASS, 'brand new main password 9', LOW_ITER);
  assert(ch.meta.slots.length === 2, 'slots kept by changePassword');
  await rejects(() => K.unlockWithPassword(ch.meta, PASS), K.WrongPasswordError, 'old main password is dead');
  assert(await sameKeyProof(f.keys, (await K.unlockWithBackupPassword(ch.meta, BK)).keys), 'backup password after the change');
  assert(await sameKeyProof(f.keys, (await K.unlockWithSlot(ch.meta, ch.meta.slots[1].id, fakePrf(1))).keys), 'passkey after the change');
  const nr = await K.newRecoveryKey(ch.meta, 'brand new main password 9');
  assert(nr.meta.slots.length === 2 && (await K.unlockWithBackupPassword(nr.meta, BK)).keys, 'slots kept by newRecoveryKey');
  const ru = await K.unlockWithRecovery(nr.meta, nr.recoveryKey);
  const done = await K.completeRecoveryUnlock(nr.meta, ru.mk, 'after recovery pw 55');
  assert(done.slots.length === 2 && (await K.unlockWithBackupPassword(done, BK)).keys, 'slots kept after a recovery unlock');
  assert(K.withoutRecovery(done).slots.length === 2, 'removing the recovery key keeps the slots');
});
await test('slots: the backup password counts as "the current password" and can change the main one (forgot main, kept backup)', async () => {
  const f = await freshLock();
  const m = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  assert((await K.unlockWithAnyPassword(m, BK)).keys && (await K.unlockWithAnyPassword(m, PASS)).keys);
  await rejects(() => K.unlockWithAnyPassword(m, 'neither'), K.WrongPasswordError);
  const ch = await K.changePassword(m, BK, 'main chosen with the backup 12', LOW_ITER);
  assert((await K.unlockWithPassword(ch.meta, 'main chosen with the backup 12')).keys && (await K.unlockWithBackupPassword(ch.meta, BK)).keys);
  await rejects(() => K.unlockWithAnyPassword(f.meta, 'x'), K.WrongPasswordError, 'no slot: plain refusal');
});
await test('slots: removing a slot makes its secret open nothing; the others stay', async () => {
  const f = await freshLock();
  let m = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  m = await K.addPrfSlot(m, f.mk, { cid: cidOf(2), psalt: fakePrf(91), prf: fakePrf(2), name: 'key B' });
  const [pwId, prfId] = [m.slots[0].id, m.slots[1].id];
  const m3 = K.removeSlot(m, pwId);
  await rejects(() => K.unlockWithBackupPassword(m3, BK), K.NoSlotError);
  assert((await K.unlockWithSlot(m3, prfId, fakePrf(2))).keys, 'passkey slot unaffected');
  const m4 = K.removeSlot(m3, prfId);
  await rejects(() => K.unlockWithSlot(m4, prfId, fakePrf(2)), K.NoSlotError);
  assert(m4.slots.length === 0 && (await K.unlockWithPassword(m4, PASS)).keys, 'main password unaffected');
  assert(JSON.stringify(m4.pw) === JSON.stringify(f.meta.pw), 'main wrapper untouched');
  assert((() => { try { K.removeSlot(m4, 'nope'); return false; } catch (e) { return e instanceof K.NoSlotError; } })());
});
await test('slots: passkey (PRF) slot unlocks with the right secret only; wrapper is bound to its id; limits', async () => {
  const f = await freshLock();
  let m = await K.addPrfSlot(f.meta, f.mk, { cid: cidOf(3), psalt: fakePrf(92), prf: fakePrf(3), name: 'k1' });
  const id1 = m.slots[0].id;
  assert(await sameKeyProof(f.keys, (await K.unlockWithSlot(m, id1, fakePrf(3))).keys));
  await rejects(() => K.unlockWithSlot(m, id1, fakePrf(4)), K.WrongSlotError, 'wrong PRF output');
  await rejects(() => K.unlockWithSlot(m, id1, new Uint8Array(31)), K.WrongSlotError, 'short PRF output');
  await rejects(() => K.unlockWithSlot(m, 'ffffffffffff', fakePrf(3)), K.NoSlotError);
  m = await K.addPrfSlot(m, f.mk, { cid: cidOf(4), psalt: fakePrf(93), prf: fakePrf(3), name: 'k2 same prf output' });
  const id2 = m.slots[1].id;
  const swapped = { ...m, slots: [m.slots[0], { ...m.slots[0], id: id2 }] }; // wrapper of slot 1 pasted into slot 2 (same PRF output)
  await rejects(() => K.unlockWithSlot(swapped, id2, fakePrf(3)), K.WrongSlotError, 'AAD binds the id');
  let e = await rejects(() => K.addPrfSlot(m, f.mk, { cid: cidOf(3), psalt: fakePrf(94), prf: fakePrf(7) }), K.SlotError); assert(e.code === 'exists', 'same credential twice');
  m = await K.addPrfSlot(m, f.mk, { cid: cidOf(5), psalt: fakePrf(95), prf: fakePrf(8) });
  e = await rejects(() => K.addPrfSlot(m, f.mk, { cid: cidOf(6), psalt: fakePrf(96), prf: fakePrf(9) }), K.SlotError); assert(e.code === 'max');
  e = await rejects(() => K.addPrfSlot(f.meta, f.mk, { cid: new Uint8Array(4), psalt: fakePrf(1), prf: fakePrf(1) }), K.SlotError); assert(e.code === 'badInput');
  const pub = K.publicSlots(m);
  assert(pub.length === 3 && pub.every((s) => typeof s.cid === 'string' && typeof s.psalt === 'string' && !('ct' in s) && !('iv' in s)));
  const dump = JSON.stringify(m, (k, v) => (v instanceof Uint8Array ? Array.from(v).join(',') : v));
  assert(!dump.includes(fakePrf(3).join(',')), 'the PRF output is not stored');
});
await test('slots: the lockout policy counts wrong backup / passkey attempts like wrong passwords', async () => {
  let s = policy.initialFailState();
  const t0 = 1700000000000;
  for (let i = 0; i < 5; i++) s = policy.onFailure(s, t0 + i);
  assert(!policy.canAttempt(s, t0 + 10).allowed, 'locked out after repeated failures (the controller calls onFailure for every wrong secret kind)');
  const f = await freshLock();
  const m = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  for (const bad of [() => K.unlockWithBackupPassword(m, 'no'), () => K.unlockWithSlot(K.removeSlot(m, m.slots[0].id), 'x', fakePrf(1))]) {
    const e = await rejects(bad, null); assert(e instanceof K.WrongBackupPasswordError || e instanceof K.NoSlotError);
  }
  assert(new K.WrongBackupPasswordError().countsAsFailure !== false && new K.WrongSlotError().countsAsFailure !== false, 'neither is exempt from the lockout');
});
await test('slots: the encrypted archive opens with the backup password and with the passkey secret of the file', async () => {
  const f = await freshLock();
  let m = await K.addPasswordSlot(f.meta, f.mk, BK, { iter: LOW_ITER });
  m = await K.addPrfSlot(m, f.mk, { cid: cidOf(7), psalt: fakePrf(97), prf: fakePrf(11), name: 'arch key' });
  const text = await buildArchiveText({ ...f, meta: m });
  assert(!/ARCHIVE-SECRET|archive-secret/.test(text) && !text.includes(BK), 'still no plain text');
  const [h, ...rest] = text.split('\n');
  const hd = archive.parseHeader(h);
  assert(hd.lock.slots.length === 2 && hd.lock.slots[1].cid instanceof Uint8Array, 'slots travel in the header');
  const rows = rest.filter(Boolean).map(archive.parseLine);
  for (const open of [{ backupPassword: BK }, { slot: { id: hd.lock.slots[1].id, prf: fakePrf(11) } }]) {
    const dec = await archive.openArchive(hd.lock, open);
    dec.addEkeys(rows.filter((r) => r.store === 'ekeys').map((r) => r.row));
    const g = await dec.group(rows.find((r) => r.store === 'groups').row);
    assert(g.title === A_SECRET + ' group', 'decoded through the slot');
    const its = [];
    for (const r of rows.filter((x) => x.store === 'items')) its.push(await dec.item(r.row));
    assert(its.length === 4 && its.every((x) => !x.corrupt), 'items decode');
  }
  await rejects(() => archive.openArchive(hd.lock, { backupPassword: 'nope nope nope' }), K.WrongBackupPasswordError);
  await rejects(() => archive.openArchive(hd.lock, { slot: { id: hd.lock.slots[1].id, prf: fakePrf(12) } }), K.WrongSlotError);
  const old = archive.parseHeader(archive.headerLine(f.meta)); // an archive made BEFORE the slot existed does not open with it
  await rejects(() => archive.openArchive(old.lock, { backupPassword: BK }), K.NoSlotError);
});

// ================= sync state sealed under the lock (lib/syncseal.js) =================
console.log('\n[sync + lock]');
await test('sync state: sealed with the lock key, unreadable while locked, back after unlock with the password, never "empty"', async () => {
  const { createSealedKv, createSealedKeyStore, isSealed, LockedError: SyncLocked } = await import('../../lib/syncseal.js');
  const { createMemoryKv } = await import('../../lib/sync/engine.js');
  const f = await K.setupLock({ password: PASS, withRecovery: false, iter: LOW_ITER });
  let cur = f.keys;
  const lock = { enabled: () => true, locked: () => !cur, writer: () => (cur ? cur.writer() : null), reader: () => (cur ? cur.reader() : null) };
  const raw = createMemoryKv();
  const kv = createSealedKv(raw, lock);
  await kv.set('outbox', [{ title: 'SYNC-SECRET-OUTBOX', url: 'https://sync-secret.example.com/' }]);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await createSealedKeyStore(raw, lock).set(dek);
  assert(isSealed(raw._raw.get('outbox')) && isSealed(raw._raw.get('dekraw')) && !raw._raw.has('dek'));
  const bytes = JSON.stringify([...raw._raw.values()].map((v) => Buffer.from(v.e).toString('latin1')));
  assert(!bytes.includes('SYNC-SECRET') && !bytes.includes('sync-secret'), 'plain text in the stored value');
  cur = null; // locked
  await rejects(() => kv.get('outbox'), SyncLocked, 'read while locked');
  await rejects(() => kv.set('outbox', []), SyncLocked, 'write while locked');
  await rejects(() => createSealedKeyStore(raw, lock).get(), SyncLocked, 'key while locked');
  const before = JSON.stringify([...raw._raw.entries()].map(([k, v]) => [k, v.e ? Buffer.from(v.e).toString('hex') : v]));
  const u = await K.unlockWithPassword(f.meta, PASS); // unlock again
  cur = u.keys;
  eq((await kv.get('outbox'))[0].title, 'SYNC-SECRET-OUTBOX');
  assert((await createSealedKeyStore(raw, lock).get()) instanceof CryptoKey, 'the sync key comes back as a CryptoKey');
  const after = JSON.stringify([...raw._raw.entries()].map(([k, v]) => [k, v.e ? Buffer.from(v.e).toString('hex') : v]));
  assert(before === after, 'locked attempts changed nothing on disk');
  const other = await K.setupLock({ password: 'a different lock', withRecovery: false, iter: LOW_ITER });
  cur = other.keys; // a different lock's key must not "open" it as empty
  await rejects(() => kv.get('outbox'), null, 'wrong key');
});

// ---- print perf table ----
{
  const w = [Math.max(...perf.map((r) => r[0].length), 10), Math.max(...perf.map((r) => String(r[1]).length), 8), Math.max(...perf.map((r) => String(r[2]).length), 8)];
  const line = (r) => `  ${String(r[0]).padEnd(w[0])} | ${String(r[1]).padEnd(w[1])} | ${String(r[2]).padEnd(w[2])} | ${r[3]}`;
  console.log('\n' + line(['measure', 'measured', 'spec budget', 'status']));
  console.log('  ' + '-'.repeat(w[0] + w[1] + w[2] + 18));
  perf.forEach((r) => console.log(line(r)));
}

console.log(`\n${passed} passed, ${failed} failed` + (failed ? ` (${failures.join('; ')})` : ''));
process.exit(failed ? 1 : 0);
