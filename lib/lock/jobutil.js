// Shared helpers for the resumable job steppers (seal.js, migrate.js).
//
// STORE ADAPTER INTERFACE (the integrator binds this to IndexedDB `cmr`; tests use tests/lock/fakestore.js):
//   store.scan(name, {after, upTo, limit}) -> Promise<[{key, value}]>   rows in primary-key order, key > after
//        (exclusive; null/undefined = from start), key <= upTo (inclusive, optional), at most `limit` (<= 2000)
//   store.get(name, key)      -> Promise<value|undefined>
//   store.count(name)         -> Promise<number>
//   store.getCursor(job)      -> Promise<object|undefined>        persisted job cursor (JSON-able)
//   store.tx(async (tx) => {...}) -> Promise<void>   ONE atomic readwrite transaction (all-or-nothing):
//        tx.get(name,key), tx.scan(name,opts)  (reads; IDB requests only: never await crypto inside tx.*)
//        tx.put(name,value)  (key from the store's keyPath; autoIncrement stores assign it if missing)
//        tx.del(name,key), tx.setCursor(job, obj|null)
// RULE: do all crypto BEFORE opening tx; inside tx only IDB requests (IDB transactions auto-commit otherwise).
// The cursor is written in the SAME tx as the chunk, so a crash re-runs at most one chunk (idempotent).

export const MAX_CHUNK = 2000;

/** Total order on IDB-like keys: numbers < strings < arrays (arrays compared element-wise). */
export function cmpKey(a, b) {
  const ta = Array.isArray(a) ? 2 : typeof a === 'string' ? 1 : 0;
  const tb = Array.isArray(b) ? 2 : typeof b === 'string' ? 1 : 0;
  if (ta !== tb) return ta - tb;
  if (ta === 2) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { const c = cmpKey(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep equality incl. Uint8Array; used for compare-and-swap between the chunk read and its write tx. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Stable stringify (sorted keys, Uint8Array as hex) for byte-identical comparisons in tests. */
export function canon(v) {
  if (v instanceof Uint8Array) return '#' + Array.from(v, (x) => x.toString(16).padStart(2, '0')).join('');
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
