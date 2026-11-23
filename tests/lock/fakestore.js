// In-memory fake of the IndexedDB store adapter (see lib/lock/jobutil.js) used by tests and benchmarks.
// Simulates: ordered primary keys, structured-clone isolation, atomic transactions (all-or-nothing), autoIncrement,
// persisted job cursors, and crash injection (throw inside a tx = nothing applied; throw right after commit = applied
// but the caller never learns about it).
import { cmpKey } from '../../lib/lock/jobutil.js';

export class CrashError extends Error { constructor(m = 'injected crash') { super(m); this.name = 'CrashError'; } }

const KEYPATHS = {
  meta: (r) => r.k,
  items: (r) => [r.g, r.seq],
  trash: (r) => r.tid,
  groups: (r) => r.id,
  categories: (r) => r.id,
  siteIdx: (r) => [r.site, r.g],
  sites: (r) => r.site,
  snapshots: (r) => r.id,
  vault: (r) => r.id,
  settings: (r) => r.name,
  favicons: (r) => r.site,
  search: (r) => r.id,
  inbox: (r) => r.g,
  ekeys: (r) => r.kid,
};
const AUTOINC = { trash: 'tid' };

export class FakeStore {
  constructor() {
    this.stores = new Map(); // name -> { map: Map(keystr -> {key,value}), keys: sorted key[] }
    for (const n of Object.keys(KEYPATHS)) this.stores.set(n, { map: new Map(), keys: [], next: 1 });
    this.cursors = new Map();
    this.crashIn = null;       // number of tx operations until a crash (inside the tx -> rolled back)
    this.crashAfterCommit = false; // crash right after the next commit
    this.txCount = 0;
  }
  _s(name) { const s = this.stores.get(name); if (!s) throw new Error('no store ' + name); return s; }
  static ks(key) { return JSON.stringify(key); }
  _idx(s, key) { // lower bound
    let lo = 0, hi = s.keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmpKey(s.keys[m], key) < 0) lo = m + 1; else hi = m; }
    return lo;
  }
  _put(name, value) {
    const s = this._s(name);
    value = structuredClone(value);
    const ap = AUTOINC[name];
    if (ap && value[ap] === undefined) value[ap] = s.next;
    if (ap && value[ap] >= s.next) s.next = value[ap] + 1;
    const key = KEYPATHS[name](value);
    const ks = FakeStore.ks(key);
    if (!s.map.has(ks)) s.keys.splice(this._idx(s, key), 0, key);
    s.map.set(ks, { key, value });
    return key;
  }
  _del(name, key) {
    const s = this._s(name), ks = FakeStore.ks(key);
    if (!s.map.has(ks)) return;
    s.map.delete(ks);
    s.keys.splice(this._idx(s, key), 1);
  }
  _scan(name, { after, upTo, limit = 2000 } = {}) {
    const s = this._s(name);
    let i = after === undefined || after === null ? 0 : this._idx(s, after);
    if (after !== undefined && after !== null && i < s.keys.length && cmpKey(s.keys[i], after) === 0) i++;
    const out = [];
    for (; i < s.keys.length && out.length < limit; i++) {
      const key = s.keys[i];
      if (upTo !== undefined && cmpKey(key, upTo) > 0) break;
      out.push({ key: structuredClone(key), value: structuredClone(s.map.get(FakeStore.ks(key)).value) });
    }
    return out;
  }

  // ---- direct (non-adapter) helpers for tests / the stash simulation ----
  /** Atomic multi-put used to simulate a db.js write (ekeys + items in one tx). */
  async putMany(ops) { return this.tx(async (tx) => { for (const [n, v] of ops) await tx.put(n, v); }); }
  all(name) { return this._scan(name, { limit: Infinity }); }
  allValues(name) { return this.all(name).map((r) => r.value); }
  size(name) { return this._s(name).keys.length; }

  // ---- adapter ----
  async scan(name, opts) { return this._scan(name, opts); }
  async get(name, key) { const r = this._s(name).map.get(FakeStore.ks(key)); return r ? structuredClone(r.value) : undefined; }
  async count(name) { return this._s(name).keys.length; }
  async getCursor(job) { const c = this.cursors.get(job); return c === undefined ? undefined : structuredClone(c); }

  async tx(fn) {
    this.txCount++;
    const staged = [];
    const tick = () => {
      if (this.crashIn !== null && --this.crashIn < 0) { this.crashIn = null; throw new CrashError('crash inside tx'); }
    };
    const tx = {
      get: async (n, k) => this.get(n, k),
      scan: async (n, o) => this._scan(n, o),
      put: async (n, v) => { tick(); staged.push(['put', n, v]); },
      del: async (n, k) => { tick(); staged.push(['del', n, k]); },
      setCursor: async (j, c) => { tick(); staged.push(['cur', j, c]); },
    };
    await fn(tx); // a throw here discards `staged`: all-or-nothing
    for (const [op, a, b] of staged) {
      if (op === 'put') this._put(a, b);
      else if (op === 'del') this._del(a, b);
      else if (b === null) this.cursors.delete(a);
      else this.cursors.set(a, structuredClone(b));
    }
    if (this.crashAfterCommit) { this.crashAfterCommit = false; throw new CrashError('crash after commit'); }
  }

  /** Every stored byte as one buffer: JSON of structure + raw binary of every Uint8Array (for leak scans). */
  dump() {
    const parts = [], te = new TextEncoder();
    const walk = (v) => {
      if (v instanceof Uint8Array) { parts.push(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { parts.push(te.encode(k)); walk(x); } return; }
      parts.push(te.encode(String(v)));
    };
    for (const [n, s] of this.stores) for (const { key, value } of s.map.values()) { walk(key); walk(value); }
    for (const [j, c] of this.cursors) { parts.push(te.encode(j)); walk(c); }
    let len = 0; for (const p of parts) len += p.length + 1;
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 0x0a; }
    return out;
  }
  /** Canonical snapshot of every store for equality comparisons. */
  snapshot(names) {
    const out = {};
    for (const n of names || [...this.stores.keys()]) out[n] = this.all(n).map((r) => r.value);
    return out;
  }
}

/** Search a buffer for a needle in UTF-8 and UTF-16LE. Returns number of hits. */
export function countHits(hay, needle) {
  const variants = [new TextEncoder().encode(needle)];
  const u16 = new Uint8Array(needle.length * 2);
  for (let i = 0; i < needle.length; i++) { u16[i * 2] = needle.charCodeAt(i) & 255; u16[i * 2 + 1] = needle.charCodeAt(i) >> 8; }
  variants.push(u16);
  let hits = 0;
  for (const n of variants) {
    outer: for (let i = 0; i + n.length <= hay.length; i++) {
      if (hay[i] !== n[0]) continue;
      for (let j = 1; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
      hits++;
    }
  }
  return hits;
}
export function countHitsBytes(hay, needleBytes) {
  let hits = 0;
  outer: for (let i = 0; i + needleBytes.length <= hay.length; i++) {
    if (hay[i] !== needleBytes[0]) continue;
    for (let j = 1; j < needleBytes.length; j++) if (hay[i + j] !== needleBytes[j]) continue outer;
    hits++;
  }
  return hits;
}
