// Loopback harness: simulated devices sharing one in-memory bookmark tree.
import { MemoryBookmarks } from '../../lib/sync/transport-memory.js';
import { createEngine, createMemoryKv } from '../../lib/sync/engine.js';
import { applyOp } from '../../lib/sync/merge.js';
import { fieldKey } from '../../lib/sync/hlc.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FakeClock {
  constructor(start = Date.UTC(2026, 10, 23, 12, 0, 0)) { this.t = start; this.timers = []; this.nextId = 1; this.skew = 0; }
  now = () => this.t + this.skew;
  setTimeoutFn = (fn, ms) => { const h = { id: this.nextId++, at: this.t + ms, fn }; this.timers.push(h); return h; };
  clearTimeoutFn = (h) => { this.timers = this.timers.filter((x) => x !== h); };
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const nx = this.timers[0];
      if (!nx || nx.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, nx.at);
      try { await nx.fn(); } catch { /* ignore */ }
    }
    this.t = end;
  }
}

export function makeTimers(clock) {
  return {
    set: (fn, ms) => clock.setTimeoutFn(fn, ms),
    clear: (h) => clock.clearTimeoutFn(h),
    sleep: (ms) => new Promise((res) => { clock.setTimeoutFn(res, ms); }),
    yield: () => Promise.resolve(),
  };
}

const GFIELDS = ['title', 'starred', 'locked', 'ord', 'del', 'createdAt', 'windowCount', 'tabGroups'];
const IFIELDS = ['g', 'url', 'title', 'ts', 't', 'w', 'tg'];

/** In-memory implementation of the merge store interface (what an IndexedDB binding would do). */
export class MemStore {
  constructor() { this.groups = new Map(); this.items = new Map(); this.meta = new Map(); this.nextSeq = 1; }
  async getMeta(t, id) { const m = this.meta.get(t + id); return m ? structuredClone(m) : undefined; }
  async setMeta(t, id, m) { this.meta.set(t + id, structuredClone(m)); }
  async hasEntity(t, id) { return (t === 'g' ? this.groups : this.items).has(id); }
  async createEntity(t, id, fields, opts = {}) {
    if (t === 'g') this.groups.set(id, { ...structuredClone(fields), ph: !!opts.placeholder });
    else this.items.set(id, { ...structuredClone(fields), seq: this.nextSeq++ });
  }
  async updateEntity(t, id, fields) {
    const e = (t === 'g' ? this.groups : this.items).get(id);
    Object.assign(e, structuredClone(fields));
    if (t === 'g' && fields.createdAt !== undefined) e.ph = false;
  }
  async purgeEntity(t, id) {
    if (t === 'g') this.groups.delete(id); else this.items.delete(id);
  }
  dump() {
    const g = [...this.groups.entries()].map(([id, e]) => ({ id, ph: e.ph || undefined, ...Object.fromEntries(GFIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) }));
    const purgedG = new Set([...this.meta.entries()].filter(([k, m]) => k[0] === 'g' && m.purged).map(([k]) => k.slice(1)));
    const i = [...this.items.entries()].filter(([, e]) => !purgedG.has(e.g)).map(([id, e]) => ({ id, ...Object.fromEntries(IFIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) }));
    g.sort((a, b) => (a.id < b.id ? -1 : 1)); i.sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify({ g, i });
  }
  purgedIds() { return [...this.meta.entries()].filter(([, m]) => m.purged).map(([k]) => k).sort(); }
}

export class Device {
  constructor(tree, id, opts = {}) {
    this.id = id;
    this.tree = tree;
    this.clock = opts.clock;
    this.skew = 0;
    this.rng = opts.rng || mulberry32(1);
    this.view = tree.view(id);
    this.store = new MemStore();
    this.kv = createMemoryKv();
    this._key = null;
    this.keys = { get: async () => this._key, set: async (k) => { this._key = k; }, del: async () => { this._key = null; } };
    this.timers = makeTimers(this.clock);
    this.opts = opts;
    this.allOps = opts.allOps || null;
    this.engine = null;
    this.restarts = 0;
    this.build();
  }
  now() { return this.clock.now() + this.skew; }
  build(extra = {}) {
    if (this.engine) this.engine.shutdown();
    this.engine = createEngine({
      deviceId: this.id, store: this.store, transport: this.view, state: this.kv, keys: this.keys,
      clock: { now: () => this.now() }, timers: this.timers, rng: this.rng, iter: 1000, minIter: 1,
      partSize: this.opts.partSize, limits: this.opts.limits, budgetBytes: this.opts.budgetBytes, maxNodes: this.opts.maxNodes,
      hooks: extra.hooks || this.opts.hooks, canApply: this.opts.canApply, dekExtractable: this.opts.dekExtractable,
    });
    return this.engine;
  }
  /** Simulate a service-worker restart: drop the engine object, keep persisted state. */
  async restart(extra) {
    this.restarts++;
    this.build(extra);
    return this.engine.resume();
  }
  // ---- local mutations (apply to the app's own DB, then record for sync) ----
  async _rec(ops) {
    if (this.allOps) for (const op of ops) this.allOps.push({ dev: this.id, op });
    await this.engine.recordLocal(ops);
  }
  async addGroup(gid, f = {}) {
    const fields = { createdAt: this.now(), title: '', ord: -this.now(), ...f };
    await this.store.createEntity('g', gid, fields);
    await this._rec([this.engine.stamp('g', gid, fields)]);
  }
  async setGroup(gid, f) {
    await this.store.updateEntity('g', gid, f);
    await this._rec([this.engine.stamp('g', gid, f)]);
  }
  async addItem(iid, gid, f = {}) {
    const fields = { g: gid, url: 'https://example.com/' + iid, title: 'Title ' + iid, ts: this.now(), t: ('title ' + iid + '\nhttps://example.com/' + iid), ...f };
    await this.store.createEntity('i', iid, fields);
    await this._rec([this.engine.stamp('i', iid, fields)]);
  }
  async setItem(iid, f) {
    await this.store.updateEntity('i', iid, f);
    await this._rec([this.engine.stamp('i', iid, f)]);
  }
  async purge(t, id) {
    await this.store.purgeEntity(t, id);
    await this._rec([this.engine.stamp(t, id, null, true)]);
  }
}

export async function setupDevices(n, { seed = 1, passphrase = 'correct horse battery', opts = {} } = {}) {
  const clock = new FakeClock();
  const rng = mulberry32(seed);
  const tree = new MemoryBookmarks({ now: clock.now, rng });
  const allOps = [];
  const devs = [];
  for (let i = 0; i < n; i++) devs.push(new Device(tree, 'dev' + String.fromCharCode(97 + i), { clock, rng, allOps, ...opts }));
  return { clock, rng, tree, devs, allOps, passphrase };
}

/** One full exchange round: push, deliver, pull for each device. */
export async function round(devs, { clock, deliver = {}, advance = 120000, check = false } = {}) {
  for (const d of devs) { try { await d.engine.push(); } catch { /* surfaced in status */ } }
  for (const d of devs) d.view.deliver(deliver);
  for (const d of devs) { await d.engine.pullLoop(); if (check) await d.engine.check(); }
  if (clock && advance) await clock.advance(advance);
}

export async function quiesce(devs, clock, { maxRounds = 60, check = true, ignoreOutbox = false } = {}) {
  for (let r = 0; r < maxRounds; r++) {
    await round(devs, { clock, check });
    const idle = devs.every((d) => d.view.pending() === 0 && (ignoreOutbox || d.engine._P().outbox.length === 0) && d.engine._S.dirty.size === 0 && !d.engine._P().own.headDirty);
    if (idle) {
      // one more full pass so dirty flags from the last events are consumed
      await round(devs, { clock, check });
      if (devs.every((d) => d.view.pending() === 0 && d.engine._S.dirty.size === 0)) return r + 1;
    }
  }
  throw new Error('did not quiesce');
}

/** Replay every op ever made into a fresh store (oracle for the converged state). */
export async function oracle(allOps) {
  const s = new MemStore();
  const sorted = [...allOps].sort((a, b) => (a.op.h < b.op.h ? -1 : a.op.h > b.op.h ? 1 : 0));
  for (const { dev, op } of sorted) await applyOp(s, op, dev);
  return s;
}

export { fieldKey };
