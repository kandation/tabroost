// Cross-device sync while the password lock is on: what the sync engine keeps ON THIS DEVICE is sealed with the lock's data key.
//
//  - the engine's persistent state (outbox, own log, known devices, cursors, config ...) holds titles and links of pending changes:
//    it goes through a SEALED kv (AES-GCM under DK, the same blob format as the rest of the lock, AAD = "sy:<key>")
//  - the sync data key (DEK) cannot be re-derived without the sync passphrase, so while the lock is on it is kept as raw bytes
//    INSIDE a sealed blob (key `dekraw`); with the lock off it stays a CryptoKey in the key store, exactly as before
//  - the per-entity "last synced values" (`sy.v`) are sealed the same way (`sy.ve`)
//  - a sealed value that cannot be opened (locked, wrong key, damaged) THROWS: it is never returned as "nothing stored", so the
//    engine can never mistake a failed decrypt for an empty state and overwrite good data
//  - with the lock on and no key (locked) every write throws LockedError and nothing is written
// Pure module (WebCrypto only; the lock is injected), tested in Node (tests/sync, tests/lock).
import { encodeBlob, decodeBlob, LockedError } from './lock/rec.js';
import { b64enc, b64dec } from './lock/bytes.js';

export { LockedError };

/** lock = { enabled(): bool, locked(): bool, writer(): writer|null, reader(): reader|null } (see lib/synclockrt.js) */
export const NO_LOCK = { enabled: () => false, locked: () => false, writer: () => null, reader: () => null };

export const isSealed = (v) => !!v && typeof v === 'object' && !(v instanceof Uint8Array) && v.__sy === 1 && v.e !== undefined;

export async function seal(lock, id, obj) {
  const w = lock.writer();
  if (!w) throw new LockedError('locked');
  const b = await encodeBlob('sy:' + id, obj, w);
  return { __sy: 1, k: b.k, e: b.e };
}
export async function open(lock, id, v) {
  if (!isSealed(v)) return v;
  const rd = lock.reader();
  if (!rd) throw new LockedError('locked');
  return decodeBlob('sy:' + id, { k: v.k, e: v.e }, rd); // wrong key / damaged: throws (never "undefined")
}

/** kv with the engine's interface (get / set / setMany / del) over `inner`. Lock off: a pass-through. */
export function createSealedKv(inner, lock = NO_LOCK) {
  const on = () => lock.enabled();
  return {
    async get(k) { const v = await inner.get(k); return isSealed(v) ? open(lock, k, v) : v; },
    async set(k, v) { await inner.set(k, on() ? await seal(lock, k, v) : v); },
    async setMany(o) {
      const out = {};
      for (const k of Object.keys(o)) out[k] = on() ? await seal(lock, k, o[k]) : o[k];
      await inner.setMany(out);
    },
    async del(keys) { await inner.del(keys); },
  };
}

const subtle = () => globalThis.crypto.subtle;
const importDek = (raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * Key store of the engine (get / set / del of the DEK). `inner` is the RAW kv (not the sealed one).
 * Lock on: the DEK is exported once, sealed as `dekraw` and the CryptoKey row is removed. A DEK that cannot be exported
 * (created before the lock, non-extractable) is not stored: the next start asks for the sync passphrase again (no data is lost).
 */
export function createSealedKeyStore(inner, lock = NO_LOCK) {
  const skv = createSealedKv(inner, lock);
  return {
    async get() {
      if (!lock.enabled()) return inner.get('dek');
      const r = await skv.get('dekraw'); // locked: throws
      if (r && r.raw) return importDek(b64dec(r.raw));
      return inner.get('dek'); // legacy CryptoKey row, converted by sealAll()
    },
    async set(dek) {
      if (!lock.enabled()) { await inner.set('dek', dek); await inner.del('dekraw'); return; }
      let raw = null;
      try { raw = new Uint8Array(await subtle().exportKey('raw', dek)); } catch { raw = null; }
      if (!raw) { await inner.del(['dek', 'dekraw']); return; }
      await skv.set('dekraw', { raw: b64enc(raw) });
      await inner.del('dek');
    },
    async del() { await inner.del(['dek', 'dekraw']); },
  };
}

// ---------- values of sy rows ({k, fh, purged, v}) ----------
/** fields to merge into a sy row for the last-synced values `v`: {v} (lock off) or {ve} (sealed) */
export async function packV(lock, k, v) { return lock.enabled() ? { ve: await seal(lock, 'v:' + k, v), v: undefined } : { v, ve: undefined }; }
export async function readV(lock, k, row) { if (!row) return undefined; return row.ve ? open(lock, 'v:' + k, row.ve) : row.v; }

// ---------- lock turned on / off while sync data exists ----------
const KNOWN_KEYS = ['cursor', 'outbox', 'own', 'ownLog', 'session', 'quarantine', 'known', 'hlc', 'config', 'deviceId', 'cfg', 'tracked'];

/** Seals every plain value of the kv (idempotent). `inner.keys()` when the store can list its keys. Returns {sealed, droppedDek}. */
export async function sealAll(inner, lock) {
  if (!lock.enabled() || !lock.writer()) throw new LockedError('locked');
  const keys = inner.keys ? await inner.keys() : KNOWN_KEYS;
  let sealed = 0;
  for (const k of keys) {
    if (k === 'dek' || k === 'dekraw') continue;
    const v = await inner.get(k);
    if (v === undefined || isSealed(v)) continue;
    await inner.set(k, await seal(lock, k, v));
    sealed++;
  }
  let droppedDek = false;
  const dek = await inner.get('dek');
  if (dek) {
    await createSealedKeyStore(inner, lock).set(dek);
    droppedDek = !(await inner.get('dekraw'));
  }
  return { sealed, droppedDek };
}

/** Inverse (before the lock is removed): sealed values back to plain, `dekraw` back to a CryptoKey. */
export async function unsealAll(inner, lock) {
  if (!lock.enabled() || !lock.reader()) throw new LockedError('locked');
  const keys = inner.keys ? await inner.keys() : KNOWN_KEYS;
  let n = 0;
  for (const k of keys) {
    if (k === 'dek' || k === 'dekraw') continue;
    const v = await inner.get(k);
    if (!isSealed(v)) continue;
    await inner.set(k, await open(lock, k, v));
    n++;
  }
  const raw = await inner.get('dekraw');
  if (isSealed(raw)) {
    const o = await open(lock, 'dekraw', raw);
    await inner.set('dek', await importDek(b64dec(o.raw)));
    await inner.del('dekraw');
  }
  return { unsealed: n };
}
