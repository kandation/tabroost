// Sync together with the password lock (lib/syncseal.js): the engine's state on a device is sealed under the lock key, a LOCKED
// device does nothing destructive, unlocking resumes, a key that does not match is rejected without overwriting anything.
import { test, assert, eq, throws } from './t.mjs';
import { setupDevices, quiesce, round, Device } from './harness.mjs';
import { createMemoryKv } from '../../lib/sync/engine.js';
import { createSealedKv, createSealedKeyStore, sealAll, unsealAll, isSealed, packV, readV, LockedError } from '../../lib/syncseal.js';
import { setupLock } from '../../lib/lock/keys.js';
import { WrongPassphraseError } from '../../lib/sync/crypto.js';

const PW = 'correct horse battery';
const MARK = 'MARK-TITLE-XYZ';

/** a lock the test can lock / unlock / remove, over real keys of lib/lock */
async function mkLock(tag = 'x') {
  const f = await setupLock({ password: 'lock password ' + tag, withRecovery: false, iter: 2000 });
  let on = true;
  let open = true;
  const lock = {
    enabled: () => on, locked: () => on && !open,
    writer: () => (on && open ? f.keys.writer() : null), reader: () => (on && open ? f.keys.reader() : null),
    lock() { open = false; }, unlock() { open = true; }, remove() { on = false; },
  };
  return lock;
}

/** Device whose engine state goes through a sealed kv + sealed key store (what lib/synccontrol.js builds) */
function sealDevice(tree, id, { clock, rng, allOps, lock, extractable = true }) {
  const d = new Device(tree, id, { clock, rng, allOps, canApply: () => !lock.locked(), dekExtractable: extractable });
  d.lock = lock;
  d.rawKv = createMemoryKv();
  d.kv = createSealedKv(d.rawKv, lock);
  d.keys = createSealedKeyStore(d.rawKv, lock);
  d.build();
  return d;
}
async function pairLocked({ extractable = true } = {}) {
  const s = await setupDevices(2);
  const lockA = await mkLock('a');
  const lockB = await mkLock('b');
  const A = sealDevice(s.tree, 'deva', { clock: s.clock, rng: s.rng, allOps: s.allOps, lock: lockA, extractable });
  const B = sealDevice(s.tree, 'devb', { clock: s.clock, rng: s.rng, allOps: s.allOps, lock: lockB, extractable });
  await A.engine.enable(PW, { deviceName: 'A' });
  return { ...s, devs: [A, B], A, B };
}
const same = (A, B) => eq(A.store.dump(), B.store.dump());

// every byte / string of the raw (stored) values, to look for plain text
function rawText(kv) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (v instanceof Uint8Array) { out.push(Buffer.from(v).toString('latin1')); return; }
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'object' && typeof v.type === 'string' && v.algorithm) { out.push('<CryptoKey>'); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) { out.push(k); walk(v[k]); }
  };
  for (const [k, v] of kv._raw) { out.push(k); walk(v); }
  return out.join('\n');
}
const snapshot = (kv) => JSON.stringify([...kv._raw.entries()].map(([k, v]) => [k, rawText({ _raw: new Map([[k, v]]) })]));

test('lock+sync: round trip between two devices with sealed local state; nothing readable at rest', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: MARK });
  await A.addItem('i1', 'g1', { title: MARK + ' page', url: 'https://secret.example.com/path' });
  await A.engine.push();
  B.view.deliver();
  await B.engine.join(PW, { deviceName: 'B' });
  same(A, B);
  assert(B.store.items.get('i1').title === MARK + ' page', 'B received the item');
  await B.setGroup('g1', { title: MARK + '!' });
  await B.addItem('i2', 'g1', { title: 'from B' });
  await quiesce(devs, clock);
  same(A, B);
  assert(A.store.groups.get('g1').title === MARK + '!' && A.store.items.has('i2'));
  for (const d of [A, B]) {
    const txt = rawText(d.rawKv);
    assert(!txt.includes('MARK') && !txt.includes('secret.example') && !txt.includes('from B'), d.id + ': plain text in the stored sync state');
    assert(isSealed(d.rawKv._raw.get('outbox')) && isSealed(d.rawKv._raw.get('own')), d.id + ': state is sealed');
    assert(!d.rawKv._raw.has('dek') && isSealed(d.rawKv._raw.get('dekraw')), d.id + ': the sync key is only stored sealed');
  }
});

test('lock+sync: a restart while unlocked resumes from the sealed state (key re-imported, no passphrase)', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: 'T' }); await A.addItem('i1', 'g1');
  await A.engine.push();
  B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' });
  const on = await B.restart();
  assert(on === true, 'resume found the sealed key');
  await A.addItem('i2', 'g1');
  await quiesce(devs, clock);
  same(A, B);
  assert(B.store.items.has('i2'));
});

test('lock+sync: locked device pulls nothing and writes nothing; the remote change is applied after unlock', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: 'T' }); await A.addItem('i1', 'g1');
  await A.engine.push();
  B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' });
  await quiesce(devs, clock);
  const before = snapshot(B.rawKv);
  const storeBefore = B.store.dump();
  B.lock.lock(); // locked
  await A.addItem('i2', 'g1', { title: 'while B is locked' });
  await A.engine.push();
  B.view.deliver();
  await B.engine.pullLoop(); // canApply() is false: deferred
  assert(B.store.dump() === storeBefore, 'nothing applied while locked');
  assert(snapshot(B.rawKv) === before, 'the stored sync state was not touched while locked');
  // writes of sync state are refused (never plain, never half)
  await throws(() => B.kv.set('hlc', 'x'), LockedError.name);
  await throws(() => B.kv.get('outbox'), LockedError.name, 'a sealed value never reads as "nothing stored" while locked');
  await throws(() => B.keys.get(), LockedError.name);
  assert(snapshot(B.rawKv) === before, 'refused writes left the state intact');
  // unlock: it carries on by itself
  B.lock.unlock();
  await clock.advance(600000);
  await quiesce(devs, clock);
  assert(B.store.items.has('i2') && B.store.items.get('i2').title === 'while B is locked', 'resumed after unlock');
  same(A, B);
});

test('lock+sync: local edits made while locked are sent after the unlock (nothing lost)', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: 'T' });
  await A.engine.push();
  B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' });
  await quiesce(devs, clock);
  B.lock.lock();
  // the local database still changes while locked (a stash through the inbox); the engine sees it only after the unlock
  await B.store.createEntity('i', 'iLocked', { g: 'g1', url: 'https://example.com/locked', title: 'stashed locked', ts: clock.now() });
  B.lock.unlock();
  await B.engine.recordLocal([B.engine.stamp('i', 'iLocked', { g: 'g1', url: 'https://example.com/locked', title: 'stashed locked', ts: clock.now() })]);
  await quiesce(devs, clock);
  assert(A.store.items.has('iLocked'), 'A got the item stashed while B was locked');
});

test('lock+sync: wrong passphrase / wrong key is rejected and overwrites nothing', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: 'T' }); await A.addItem('i1', 'g1');
  await A.engine.push();
  // a third device with the wrong sync passphrase
  const lockC = await mkLock('c');
  const C = sealDevice(A.tree, 'devc', { clock, rng: A.rng, allOps: A.allOps, lock: lockC });
  C.view.deliver();
  await throws(() => C.engine.join('not the passphrase', { deviceName: 'C' }), WrongPassphraseError.name);
  assert(!C.rawKv._raw.has('dekraw') && !C.rawKv._raw.has('dek'), 'no key was stored for the rejected pairing');
  assert(C.store.groups.size === 0, 'nothing was applied');
  // a profile opened with a lock key that does not match the sealed state (copied profile / other lock)
  B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' });
  await quiesce(devs, clock);
  const before = snapshot(B.rawKv);
  const other = await mkLock('other');
  const kvOther = createSealedKv(B.rawKv, other);
  await throws(() => kvOther.get('own'), /./, 'wrong key never reads as empty');
  await throws(() => createSealedKeyStore(B.rawKv, other).get(), /./);
  B.kv = kvOther; B.keys = createSealedKeyStore(B.rawKv, other);
  B.build();
  await throws(() => B.engine.resume(), /./, 'resume with the wrong key throws');
  assert(snapshot(B.rawKv) === before, 'the sealed state was not overwritten by the failed open');
});

test('lock+sync: remote written with another vault key is not applied (remote rejected, local untouched)', async () => {
  const { clock, devs, A, B } = await pairLocked();
  await A.addGroup('g1', { title: 'T' }); await A.addItem('i1', 'g1');
  await A.engine.push();
  B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' });
  await quiesce(devs, clock);
  const storeBefore = B.store.dump();
  // B now holds a DIFFERENT DEK than the one A writes with (as after a rotation B has not followed)
  const { createVault } = await import('../../lib/sync/crypto.js');
  const fake = await createVault('another', { iter: 1000, minIter: 1 });
  B.engine._S.dek = fake.dek;
  await A.addItem('i9', 'g1', { title: 'new' });
  await A.engine.push();
  B.view.deliver();
  await B.engine.pullLoop();
  assert(B.store.dump() === storeBefore, 'chunks that do not decrypt are quarantined, nothing is applied');
  assert(!B.store.items.has('i9'));
});

test('lock turned on later: plain sync state and key are sealed; turned off: restored (sealAll / unsealAll)', async () => {
  const s = await setupDevices(2);
  const lockOff = { enabled: () => false, locked: () => false, writer: () => null, reader: () => null };
  const A = new Device(s.tree, 'deva', { clock: s.clock, rng: s.rng, allOps: s.allOps, dekExtractable: true });
  A.rawKv = createMemoryKv(); A.kv = createSealedKv(A.rawKv, lockOff); A.keys = createSealedKeyStore(A.rawKv, lockOff); A.build();
  await A.engine.enable(PW, { deviceName: 'A' });
  await A.addGroup('g1', { title: MARK }); await A.addItem('i1', 'g1', { title: MARK });
  await A.engine.push();
  assert(rawText(A.rawKv).includes('MARK'), 'before the lock the state is plain (as it always was)');
  assert(A.rawKv._raw.has('dek') && !A.rawKv._raw.has('dekraw'));
  // lock turned on
  const lock = await mkLock('later');
  A.rawKv.keys = async () => [...A.rawKv._raw.keys()];
  const r = await sealAll(A.rawKv, lock);
  assert(r.sealed > 3 && r.droppedDek === false, JSON.stringify(r));
  assert(!rawText(A.rawKv).includes('MARK') && !A.rawKv._raw.has('dek') && isSealed(A.rawKv._raw.get('dekraw')));
  A.kv = createSealedKv(A.rawKv, lock); A.keys = createSealedKeyStore(A.rawKv, lock);
  assert(await A.restart() === true, 'the sealed state starts again');
  assert(A.engine._P().ownLog.length > 0 || A.engine._P().own.ownSeq > 0);
  // lock turned off: everything back to plain BEFORE the key goes
  const u = await unsealAll(A.rawKv, lock);
  assert(u.unsealed > 3);
  assert(rawText(A.rawKv).includes('MARK') && A.rawKv._raw.has('dek') && !A.rawKv._raw.has('dekraw'));
  lock.remove();
  A.kv = createSealedKv(A.rawKv, lock); A.keys = createSealedKeyStore(A.rawKv, lock);
  assert(await A.restart() === true, 'works again without the lock');
});

test('lock turned on with a key made before the lock (non-extractable): not stored, device pairs again; nothing else lost', async () => {
  const s = await setupDevices(2);
  const lockOff = { enabled: () => false, locked: () => false, writer: () => null, reader: () => null };
  const A = new Device(s.tree, 'deva', { clock: s.clock, rng: s.rng, allOps: s.allOps }); // default: non-extractable DEK
  A.rawKv = createMemoryKv(); A.kv = createSealedKv(A.rawKv, lockOff); A.keys = createSealedKeyStore(A.rawKv, lockOff); A.build();
  await A.engine.enable(PW, { deviceName: 'A' });
  A.rawKv.keys = async () => [...A.rawKv._raw.keys()];
  const lock = await mkLock('legacy');
  const r = await sealAll(A.rawKv, lock);
  assert(r.droppedDek === true && !A.rawKv._raw.has('dek') && !A.rawKv._raw.has('dekraw'));
  assert(isSealed(A.rawKv._raw.get('config')), 'the rest of the state was sealed');
});

test('sealed values: sy "last synced" copies are sealed and read back; wrong key throws', async () => {
  const lock = await mkLock('v');
  const p = await packV(lock, 'iabc', { url: 'https://example.com/' + MARK, title: MARK });
  assert(p.ve && p.v === undefined);
  const row = { k: 'iabc', fh: {}, ...p };
  eq(await readV(lock, 'iabc', row), { url: 'https://example.com/' + MARK, title: MARK });
  assert(!Buffer.from(row.ve.e).toString('latin1').includes('MARK'));
  const other = await mkLock('v2');
  await throws(() => readV(other, 'iabc', row), /./, 'another lock key cannot open it');
  await throws(() => readV({ reader: () => null }, 'iabc', row), LockedError.name);
  const plain = await packV({ enabled: () => false }, 'iabc', { a: 1 });
  eq(plain.v, { a: 1 });
});
