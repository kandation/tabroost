// Sync engine: pairing, push (outbox -> encrypted chunks -> bookmark nodes), pull (remote
// devices' heads/chunks -> merge), compaction, self-healing, kill switch.
//
// Everything environmental is injected so the same code runs in Node tests and in the
// service worker:
//   deps = {
//     deviceId, store (merge store, see merge.js), transport (transport-*.js),
//     state  : {get(k), set(k,v), setMany(obj), del(keys)}   persistent kv (survives SW restarts)
//     keys   : {get(), set(dek), del()}                      persistent CryptoKey storage
//     clock  : {now()}, timers: {set(fn,ms)->h, clear(h), sleep(ms)->Promise, yield()->Promise},
//     rng?   : () => [0,1) (tests only), minIter?, iter?, partSize?, budgetBytes?, maxNodes?,
//     canApply?: () => boolean   (false while a drain/restore runs at low RAM),
//     onStatus?: (status) => void, hooks?: {afterOp?(n)}  (tests: crash injection)
//   }
// No chrome.* is used here; no setInterval (the host schedules `check()` via chrome.alarms).
import { Hlc, isFuture, fieldKey } from './hlc.js';
import {
  createVault, unlockVault, changePassphrase as cpass, rotateKey as rkey, MIN_ITER, DEFAULT_ITER,
  WrongPassphraseError,
} from './crypto.js';
import {
  splitParts, reassemble, parseNodeUrl, headUrl, chunkUrl, deviceMarkerUrl, vaultUrl,
  DEFAULT_PART_SIZE, MIN_PART_SIZE, MAX_PART_SIZE,
} from './codec.js';
import {
  splitOps, compactLog, sealTailChunk, sealBaseChunk, sealHead, openHead, openObject, isAddOp, minAck,
  TOMBSTONE_KEEP_MS, tombstoneAge,
} from './oplog.js';
import { applyOp } from './merge.js';
import { hash16, strHash8, randomId } from './bytes.js';

export const LIMITS = {
  maxNodes: 1500,
  budgetBytes: 4 * 1024 * 1024,
  writesPerMin: 20,
  burst: 40,
  perDay: 2000,
  pushDebounceMs: 5000,
  pushMaxWaitMs: 60000,
  pullDebounceMs: 1500,
  pullMaxWaitMs: 10000,
  retryMs: 60000,
  ackIntervalMs: 10 * 60 * 1000,
  heartbeatMs: 24 * 3600 * 1000,
  rootRecreateMs: 10 * 60 * 1000,
  staleDeviceMs: 30 * 24 * 3600 * 1000,
  incompleteWarnMs: 24 * 3600 * 1000,
  minTailBytes: 16 * 1024,
  maxTailChunks: 50,
  applySlice: 500,
};

export function createMemoryKv() {
  const m = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    async get(k) { return clone(m.get(k)); },
    async set(k, v) { m.set(k, clone(v)); },
    async setMany(o) { for (const k of Object.keys(o)) m.set(k, clone(o[k])); },
    async del(keys) { for (const k of [].concat(keys)) m.delete(k); },
    _raw: m,
  };
}

class Bucket {
  constructor(clock, { cap, perMin, dayCap }) {
    this.clock = clock; this.cap = cap; this.perMin = perMin; this.dayCap = dayCap;
    this.tokens = cap; this.last = clock.now(); this.day = Math.floor(this.last / 86400000); this.dayCount = 0;
  }
  refill() {
    const now = this.clock.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 60000) * this.perMin);
    this.last = now;
    const d = Math.floor(now / 86400000);
    if (d !== this.day) { this.day = d; this.dayCount = 0; }
  }
  canTake(n) { this.refill(); return this.tokens >= n && this.dayCount + n <= this.dayCap; }
  take(n) { this.refill(); this.tokens -= n; this.dayCount += n; }
  waitMs(n) {
    this.refill();
    if (this.dayCount + n > this.dayCap) return (86400000 * (this.day + 1)) - this.clock.now();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.perMin) * 60000);
  }
}

const newOwn = () => ({
  gen: 0, headCtr: 0, ownSeq: 0, baseChunks: null, baseSeq: 0, lastChunkNo: 0, lastHash: '',
  nodes: {}, chunkMeta: {}, devFolderId: null, headDirty: false, ackPending: false, usedBytes: 0,
  lastHeadAt: 0, partSize: 0, missing: [],
});

const PERSISTED = ['cursor', 'outbox', 'own', 'ownLog', 'session', 'quarantine', 'known', 'hlc', 'config'];

export function createEngine(deps) {
  const { store, transport, state, keys, clock, timers, deviceId } = deps;
  const rng = deps.rng;
  const minIter = deps.minIter ?? MIN_ITER;
  const ex = !!deps.dekExtractable; // true when the key store seals the DEK under the password lock (needs its raw bytes)
  const iter = deps.iter ?? DEFAULT_ITER;
  const lim = { ...LIMITS, ...(deps.limits || {}) };
  if (deps.budgetBytes) lim.budgetBytes = deps.budgetBytes;
  if (deps.maxNodes) lim.maxNodes = deps.maxNodes;
  const bucket = new Bucket(clock, { cap: lim.burst, perMin: lim.writesPerMin, dayCap: lim.perDay });

  // persistent (mirrored in `state`)
  let P = { cursor: {}, outbox: [], own: newOwn(), ownLog: [], session: null, quarantine: [], known: {}, hlc: '', config: { enabled: false, paused: false, deviceName: '' } };
  // volatile
  const S = {
    status: 'off', error: null, progress: null, dek: null, marker: null, rootId: null, markerId: null,
    devFolders: new Map(), devFolderOf: new Map(), dirty: new Set(), discover: false, markerDirty: false,
    pulling: false, pushing: false, importing: false, heal: false, rootGoneSince: null, rootConflict: null,
    timers: {}, firstAt: {}, damaged: {}, failCount: {}, incomplete: {}, lastSync: 0, stopped: false, throttled: false,
    overBudget: false, applied: 0, loaded: false, hlc: null, dead: false,
  };

  const emit = () => { if (deps.onStatus) { try { deps.onStatus(status()); } catch { /* ignore */ } } };
  function setStatus(s, err) { S.status = s; S.error = err || null; emit(); }

  async function save(list = PERSISTED) {
    const o = {};
    for (const k of list) o[k] = P[k];
    P.hlc = S.hlc ? S.hlc.last() : P.hlc;
    if (list.includes('hlc')) o.hlc = P.hlc;
    await state.setMany(o);
  }
  async function load() {
    const o = {};
    for (const k of PERSISTED) { const v = await state.get(k); if (v !== undefined) o[k] = v; }
    P = { ...P, ...o };
    if (!P.own.partSize) P.own.partSize = deps.partSize || DEFAULT_PART_SIZE;
    S.hlc = new Hlc(() => clock.now(), P.hlc || undefined);
    S.loaded = true;
  }

  const ctx = () => ({ dek: S.dek, vaultId: S.marker.vaultId, epoch: S.marker.epoch, deviceId });

  // ---- timers ---------------------------------------------------------------
  function schedule(name, ms, fn, maxWait) {
    const now = clock.now();
    if (S.timers[name]) {
      if (maxWait && now - S.firstAt[name] >= maxWait) return; // let the pending one fire
      timers.clear(S.timers[name]);
    } else S.firstAt[name] = now;
    S.timers[name] = timers.set(() => { S.timers[name] = null; return fn().catch((e) => setStatus('error', String(e && e.message || e))); }, ms);
  }
  const schedulePull = () => schedule('pull', lim.pullDebounceMs, pullLoop, lim.pullMaxWaitMs);
  const schedulePush = () => schedule('push', lim.pushDebounceMs, push, lim.pushMaxWaitMs);
  const retryLater = (name, fn, ms = lim.retryMs) => { if (!S.timers['r:' + name]) S.timers['r:' + name] = timers.set(() => { S.timers['r:' + name] = null; return fn().catch(() => {}); }, ms); };
  /** Stop this instance (timers cancelled; further work is a no-op). Used when a new instance takes over after a restart. */
  function shutdown() { S.dead = true; cancelTimers(); transport.setEventHandler && transport.setEventHandler(null); }
  function cancelTimers() { for (const k of Object.keys(S.timers)) { if (S.timers[k]) timers.clear(S.timers[k]); S.timers[k] = null; } }

  // ---- status ---------------------------------------------------------------
  function usage() {
    let bytes = P.own.usedBytes;
    let nodes = Object.keys(P.own.nodes).length + 2;
    for (const [d, k] of Object.entries(P.known)) { if (d === deviceId) continue; bytes += k.usedBytes || 0; nodes += k.usedNodes || 0; }
    return { bytes, nodes };
  }
  function status() {
    const u = usage();
    let st = S.status;
    if (S.stopped) st = 'stoppedRemotely';
    else if (st === 'idle' && P.config.paused) st = 'paused';
    else if (st === 'idle' && S.overBudget) st = 'overBudget';
    return {
      state: st, lastSync: S.lastSync, pending: P.outbox.length, usedBytes: u.bytes, usedNodes: u.nodes,
      budget: lim.budgetBytes, devices: Object.entries(P.known).map(([id, k]) => ({ id, ...k })),
      error: S.error, progress: S.progress, overBudget: S.overBudget, quarantined: P.quarantine.length,
      throttled: S.throttled, rootConflict: S.rootConflict, damaged: { ...S.damaged }, ownGen: P.own.gen,
    };
  }

  // ---- writing own nodes ------------------------------------------------------
  async function createOwnFolder() {
    const id = await transport.createFolder(S.rootId);
    await transport.createNode(id, deviceMarkerUrl(deviceId));
    transport.track && transport.track(id, 'device', S.rootId);
    P.own.devFolderId = id;
    S.devFolders.set(id, deviceId);
    S.devFolderOf.set(deviceId, id);
    bucket.take(2);
  }

  async function putNode(key, url) {
    const cur = P.own.nodes[key];
    if (cur) {
      try { await transport.updateNode(cur.id, url); P.own.nodes[key] = { id: cur.id, h: await strHash8(url) }; bucket.take(1); return; } catch { /* node vanished: recreate */ }
    }
    const id = await transport.createNode(P.own.devFolderId, url);
    P.own.nodes[key] = { id, h: await strHash8(url) };
    bucket.take(1);
  }

  async function writeHead() {
    const own = P.own;
    own.headCtr++;
    const acks = {};
    for (const [d, c] of Object.entries(P.cursor)) acks[d] = c.seqApplied;
    const head = {
      deviceId, name: P.config.deviceName, headCtr: own.headCtr, gen: own.gen, baseChunks: own.baseChunks, baseSeq: own.baseSeq,
      lastChunkNo: own.lastChunkNo, lastSeq: own.ownSeq, lastHash: own.lastHash, acks, usedBytes: own.usedBytes,
      usedNodes: Object.keys(own.nodes).length + 2, lastSeen: clock.now(), partSize: own.partSize, epoch: S.marker.epoch,
      probeOk: { partSize: !Object.keys(S.incomplete).length }, missing: own.missing || [],
    };
    const ct = await sealHead(ctx(), head, rng);
    const parts = splitParts(ct, own.partSize);
    if (!bucket.canTake(parts.length)) {
      own.headCtr--; own.headDirty = true; S.throttled = true;
      retryLater('head', async () => { await flushHead(); }, Math.max(1000, bucket.waitMs(parts.length)));
      return false;
    }
    for (let i = 0; i < parts.length; i++) await putNode('h:' + (i + 1), headUrl(i + 1, parts.length, parts[i]));
    for (const k of Object.keys(own.nodes)) {
      if (k.startsWith('h:') && Number(k.slice(2)) > parts.length) { try { await transport.removeNode(own.nodes[k].id); } catch { /* ignore */ } delete own.nodes[k]; }
    }
    own.headDirty = false; own.ackPending = false; own.lastHeadAt = clock.now(); S.throttled = false;
    P.known[deviceId] = { name: P.config.deviceName, lastSeen: head.lastSeen, usedBytes: own.usedBytes, usedNodes: head.usedNodes, acks, headCtr: own.headCtr };
    await save(['own', 'known']);
    return true;
  }
  async function flushHead() { if (S.dek && P.own.headDirty) await writeHead(); }

  // ---- budget / compaction ------------------------------------------------------
  function refreshBudget() {
    const u = usage();
    S.overBudget = u.bytes > lim.budgetBytes || u.nodes > lim.maxNodes;
    return S.overBudget;
  }

  async function maybeCompact(force = false) {
    const own = P.own;
    let tailBytes = 0, baseBytes = 0, tailChunks = 0;
    for (const m of Object.values(own.chunkMeta)) { if (m.base) baseBytes += m.bytes; else { tailBytes += m.bytes; tailChunks++; } }
    const need = force || tailChunks > lim.maxTailChunks || (tailBytes > lim.minTailBytes && tailBytes > 0.25 * baseBytes) || refreshBudget();
    if (!force && own.gen > 0 && own.lastRebuildSeq === own.ownSeq && !own.nodesDirty) return; // nothing new since the last rewrite
    if (force && own.gen > 0 && own.lastRebuildSeq === own.ownSeq && refreshBudget()) return; // forced by budget but nothing would shrink
    if (need && (P.ownLog.length || own.lastChunkNo)) await rebuildBase();
  }

  async function rebuildBase() {
    const own = P.own;
    const now = clock.now();
    const mAck = minAck(P.known, deviceId, now, lim.staleDeviceMs);
    const entries = await compactLog(P.ownLog, {
      isSuperseded: async (t, id, field, h) => {
        const m = await store.getMeta(t, id);
        if (!m) return false;
        if (m.purged) return true;
        const cur = m.fh && m.fh[field];
        return !!cur && cur > fieldKey(h, deviceId);
      },
      tombstoneOk: (e) => tombstoneAge(e.op, now) > TOMBSTONE_KEEP_MS && e.seq <= mAck,
    });
    const chunkOps = splitOps(entries.map((e) => e.op));
    const newGen = own.gen + 1;
    const oldNodes = Object.entries(own.nodes).filter(([k]) => k.startsWith('c:'));
    const newNodes = {};
    const newMeta = {};
    let lastHash = '';
    let usedBytes = 0;
    for (let i = 0; i < chunkOps.length; i++) {
      const chunkNo = i + 1;
      const { ct, hash } = await sealBaseChunk(ctx(), chunkNo, newGen, chunkOps.length, own.ownSeq, chunkOps[i], rng);
      const parts = splitParts(ct, own.partSize);
      for (let p = 0; p < parts.length; p++) {
        const url = chunkUrl(newGen, chunkNo, p + 1, parts.length, parts[p]);
        const id = await transport.createNode(own.devFolderId, url);
        newNodes['c:' + newGen + ':' + chunkNo + ':' + (p + 1)] = { id, h: await strHash8(url) };
        bucket.take(1); // bulk rewrite may exceed the per-minute bucket (deviation: not blocked)
      }
      newMeta[chunkNo] = { gen: newGen, seqFrom: 0, seqTo: own.ownSeq, bytes: ct.length, parts: parts.length, base: true };
      usedBytes += ct.length;
      lastHash = hash;
    }
    const headNodes = Object.fromEntries(Object.entries(own.nodes).filter(([k]) => k.startsWith('h:')));
    own.gen = newGen;
    own.baseChunks = chunkOps.length ? [1, chunkOps.length] : null;
    own.baseSeq = own.ownSeq;
    own.lastChunkNo = chunkOps.length;
    own.lastHash = lastHash;
    own.nodes = { ...headNodes, ...newNodes };
    own.chunkMeta = newMeta;
    own.usedBytes = usedBytes;
    own.headDirty = true;
    own.lastRebuildSeq = own.ownSeq;
    P.ownLog = entries;
    await save(['own', 'ownLog']);
    await writeHead();
    for (const [, n] of oldNodes) { try { await transport.removeNode(n.id); } catch { /* ignore */ } }
    refreshBudget();
    emit();
  }

  // ---- push -----------------------------------------------------------------------
  async function push() {
    if (S.dead || !S.dek || P.config.paused || S.stopped || !P.config.enabled) return 'idle';
    if (S.pushing) return 'busy';
    S.pushing = true;
    try {
      const own = P.own;
      if (own.headDirty) await writeHead();
      let guard = 0;
      let compactedOnce = false;
      while (P.outbox.length && guard++ < 10000) {
        refreshBudget();
        let candidates = P.outbox;
        if (S.overBudget) {
          if (!compactedOnce) { compactedOnce = true; await maybeCompact(true); }
          candidates = P.outbox.filter((op) => !isAddOp(op));
        }
        if (!candidates.length) break;
        const take = splitOps(candidates)[0];
        const seqFrom = own.ownSeq + 1;
        const chunkNo = own.lastChunkNo + 1;
        const { ct, hash, obj } = await sealTailChunk(ctx(), chunkNo, own.gen, seqFrom, take, own.lastHash, rng);
        const parts = splitParts(ct, own.partSize);
        if (!bucket.canTake(parts.length + 1)) {
          S.throttled = true; emit();
          retryLater('push', push, Math.max(1000, bucket.waitMs(parts.length + 1)));
          break;
        }
        S.throttled = false;
        setStatus('pushing');
        for (let i = 0; i < parts.length; i++) {
          const url = chunkUrl(own.gen, chunkNo, i + 1, parts.length, parts[i]);
          const id = await transport.createNode(own.devFolderId, url);
          own.nodes['c:' + own.gen + ':' + chunkNo + ':' + (i + 1)] = { id, h: await strHash8(url) };
          bucket.take(1);
        }
        own.ownSeq = obj.seqTo;
        own.lastChunkNo = chunkNo;
        own.lastHash = hash;
        own.chunkMeta[chunkNo] = { gen: own.gen, seqFrom, seqTo: obj.seqTo, bytes: ct.length, parts: parts.length, base: false };
        own.usedBytes += ct.length;
        own.headDirty = true;
        take.forEach((op, i) => P.ownLog.push({ seq: seqFrom + i, op }));
        const set = new Set(take);
        P.outbox = P.outbox.filter((o) => !set.has(o));
        await save(['own', 'ownLog', 'outbox']); // atomic: chunk recorded + ops removed from the outbox
        await writeHead();
      }
      if (!compactedOnce) await maybeCompact(false);
      S.lastSync = clock.now();
      return 'ok';
    } catch (e) {
      setStatus('error', String(e && e.message || e));
      retryLater('push', push);
      throw e;
    } finally {
      S.pushing = false;
      if (S.status === 'pushing') setStatus('idle');
    }
  }

  // ---- local ops -----------------------------------------------------------------
  function stamp(t, id, f, x) {
    const op = { h: S.hlc.tick(), t, id };
    if (x) op.x = 1; else op.f = f;
    return op;
  }
  /** Record locally-made changes (already applied to the app's own DB): updates field versions and queues them. */
  async function recordLocal(ops) {
    for (const op of ops) {
      const m = (await store.getMeta(op.t, op.id)) || { fh: {}, purged: false };
      if (op.x) { m.purged = true; m.fh = {}; } else {
        const key = fieldKey(op.h, deviceId);
        for (const k of Object.keys(op.f || {})) if (!m.fh[k] || key > m.fh[k]) m.fh[k] = key;
      }
      await store.setMeta(op.t, op.id, m);
      P.outbox.push(op);
    }
    await save(['outbox', 'hlc']);
    schedulePush();
  }

  // ---- discovery / events ----------------------------------------------------------
  async function discover() {
    const kids = await transport.listChildren(S.rootId);
    const seenFolders = new Set(kids.filter((k) => !k.url).map((k) => k.id));
    // prune mappings of folders that no longer exist before adding new ones
    for (const [fid, dev] of [...S.devFolders]) {
      if (!seenFolders.has(fid)) {
        S.devFolders.delete(fid);
        if (S.devFolderOf.get(dev) === fid) S.devFolderOf.delete(dev);
        if (fid === P.own.devFolderId) S.heal = true;
      }
    }
    for (const k of kids) {
      if (k.url) continue;
      if (S.devFolders.has(k.id)) continue;
      const inner = await transport.listChildren(k.id);
      let devId = null;
      for (const n of inner) { const p = n.url ? parseNodeUrl(n.url) : null; if (p && p.kind === 'd') { devId = p.deviceId; break; } }
      if (!devId) continue;
      S.devFolders.set(k.id, devId);
      if (!S.devFolderOf.has(devId)) S.devFolderOf.set(devId, k.id);
      transport.track && transport.track(k.id, 'device', S.rootId);
      if (devId !== deviceId) S.dirty.add(devId);
    }
    for (const [fid, dev] of [...S.devFolders]) {
      if (!seenFolders.has(fid)) {
        S.devFolders.delete(fid);
        if (S.devFolderOf.get(dev) === fid) S.devFolderOf.delete(dev);
        if (fid === P.own.devFolderId) S.heal = true;
      }
    }
  }

  function onEvent(ev) {
    if (!S.dek || S.stopped) return;
    if (ev.type === 'importBegan') { S.importing = true; return; }
    if (ev.type === 'importEnded') { S.importing = false; S.discover = true; S.markerDirty = true; for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d); schedulePull(); return; }
    if (S.importing) return;
    const own = P.own;
    if (own.devFolderId && ev.type !== 'remove' && (ev.parentId === own.devFolderId || ev.id === own.devFolderId)) return; // echo
    if (ev.type === 'remove' && ev.id === own.devFolderId) { S.heal = true; schedule('check', 2000, check); return; }
    if (ev.type === 'remove' && ev.id === S.rootId) { S.rootGoneSince = S.rootGoneSince || clock.now(); schedule('check', 2000, check); return; }
    if (ev.id === S.markerId) { S.markerDirty = true; schedulePull(); return; }
    if (ev.type === 'remove' && S.devFolders.has(ev.id)) { S.discover = true; schedulePull(); return; }
    const dev = S.devFolders.get(ev.parentId);
    if (dev) {
      if (dev === deviceId) { if (ev.type === 'remove') { S.heal = true; schedule('check', 2000, check); } return; }
      S.dirty.add(dev); schedulePull(); return;
    }
    if (ev.parentId === S.rootId) { S.discover = true; schedulePull(); }
  }

  // ---- pull --------------------------------------------------------------------------
  async function applyRemote(ops, dev) {
    const now = clock.now();
    for (let i = 0; i < ops.length; i += lim.applySlice) {
      const slice = ops.slice(i, i + lim.applySlice);
      for (const op of slice) {
        if (!op || typeof op.h !== 'string' || (op.t !== 'g' && op.t !== 'i') || typeof op.id !== 'string') continue;
        if (isFuture(op.h, now)) { P.quarantine.push({ dev, op }); continue; }
        await applyOp(store, op, dev);
        S.hlc.observe(op.h);
        S.applied++;
        if (deps.hooks && deps.hooks.afterOp) deps.hooks.afterOp(S.applied);
      }
      if (timers.yield) await timers.yield();
    }
  }

  async function retryQuarantine() {
    if (!P.quarantine.length) return;
    const now = clock.now();
    const keep = [];
    for (const q of P.quarantine) {
      if (isFuture(q.op.h, now)) { keep.push(q); continue; }
      await applyOp(store, q.op, q.dev);
      S.hlc.observe(q.op.h);
    }
    P.quarantine = keep;
    await save(['quarantine', 'hlc']);
  }

  async function checkMarker() {
    S.markerDirty = false;
    const node = await transport.getNode(S.markerId);
    if (!node) { S.rootGoneSince = S.rootGoneSince || clock.now(); return; }
    const p = node.url ? parseNodeUrl(node.url) : null;
    if (!p || p.kind !== 'v' || p.marker.vaultId !== S.marker.vaultId) return;
    const m = p.marker;
    if (m.closed) { S.stopped = true; cancelTimers(); setStatus('stoppedRemotely'); return; }
    if (m.epoch > S.marker.epoch) { S.marker = { ...S.marker }; S.needsPassphrase = true; setStatus('needsPassphrase'); return; }
    if (m.wrappedDEK !== S.marker.wrappedDEK && m.epoch === S.marker.epoch) { S.marker = m; P.session.marker = m; await save(['session']); }
  }

  async function readDevice(devId) {
    const folderId = S.devFolderOf.get(devId);
    if (!folderId) return null;
    const kids = await transport.listChildren(folderId);
    const heads = new Map(); let headTotal = 0;
    const chunks = new Map(); // `${gen}:${chunkNo}` -> {parts:Map,total}
    for (const k of kids) {
      const p = k.url ? parseNodeUrl(k.url) : null;
      if (!p) continue;
      if (p.kind === 'h') { heads.set(p.part, p.b64); headTotal = p.parts; }
      else if (p.kind === 'c') {
        const key = p.gen + ':' + p.chunkNo;
        let c = chunks.get(key);
        if (!c) { c = { parts: new Map(), total: p.parts }; chunks.set(key, c); }
        c.parts.set(p.part, p.b64);
        c.total = p.parts;
      }
    }
    return { heads, headTotal, chunks };
  }

  /** @returns {Promise<'uptodate'|'applied'|'incomplete'|'damaged'|'gated'|'none'>} */
  async function pullDevice(devId) {
    const dd = await readDevice(devId);
    if (!dd) return 'none';
    const headBytes = dd.headTotal ? reassemble(dd.heads, dd.headTotal) : null;
    if (!headBytes) return 'incomplete';
    let head;
    try { head = await openHead(ctx(), devId, headBytes); } catch {
      S.failCount[devId] = (S.failCount[devId] || 0) + 1;
      if (S.failCount[devId] >= 3) S.damaged[devId] = 'head';
      return 'incomplete';
    }
    if (head.deviceId !== devId) { S.damaged[devId] = 'head'; return 'damaged'; }
    if (head.epoch > S.marker.epoch) { S.needsPassphrase = true; setStatus('needsPassphrase'); return 'none'; }
    if (head.epoch < S.marker.epoch) return 'none';
    S.failCount[devId] = 0;
    P.known[devId] = { name: head.name, lastSeen: head.lastSeen, usedBytes: head.usedBytes, usedNodes: head.usedNodes, acks: head.acks, headCtr: head.headCtr, partSize: head.partSize, lastSeq: head.lastSeq };
    // peers report chunks of ours they cannot read completely -> shrink our parts
    if (head.missing && head.missing.some((m) => m.dev === deviceId) && P.own.partSize > MIN_PART_SIZE) {
      P.own.partSize = Math.max(MIN_PART_SIZE, Math.floor(P.own.partSize / 2));
      P.own.missing = [];
      await rebuildBase();
    }
    const cur = P.cursor[devId] || { gen: 0, lastChunkNo: 0, lastHash: '', seqApplied: 0, headCtr: 0 };
    if (head.headCtr <= cur.headCtr) { await save(['known']); return 'uptodate'; }
    if (deps.canApply && !deps.canApply()) return 'gated';

    const openChunk = async (gen, chunkNo) => {
      const c = dd.chunks.get(gen + ':' + chunkNo);
      if (!c) return { missing: true };
      const bytes = reassemble(c.parts, c.total);
      if (!bytes) return { missing: true };
      try { return { obj: await openObject(ctx(), devId, 'c', gen, chunkNo, bytes), hash: await hash16(bytes) }; } catch { return { bad: true }; }
    };

    let c = { ...cur };
    let startNo;
    let lastHash;
    let result = 'applied';
    const regen = head.gen !== c.gen;
    if (regen || c.lastChunkNo === 0) {
      lastHash = '';
      if (head.baseChunks) {
        for (let n = head.baseChunks[0]; n <= head.baseChunks[1]; n++) {
          const r = await openChunk(head.gen, n);
          if (r.missing) { noteIncomplete(devId, n); return 'incomplete'; }
          if (r.bad || r.obj.k !== 'b') { S.damaged[devId] = 'chunk ' + n; return 'damaged'; }
          await applyRemote(r.obj.ops, devId);
          lastHash = r.hash;
          if (S.progress) { S.progress.done++; emit(); }
        }
        c.seqApplied = Math.max(c.seqApplied, head.baseSeq);
        startNo = head.baseChunks[1] + 1;
      } else startNo = 1;
      c.gen = head.gen;
      c.lastChunkNo = startNo - 1;
      c.lastHash = lastHash;
      P.cursor[devId] = { ...c };
      await save(['cursor', 'quarantine', 'hlc', 'known']);
    } else {
      startNo = c.lastChunkNo + 1;
      lastHash = c.lastHash;
    }
    for (let n = startNo; n <= head.lastChunkNo; n++) {
      const r = await openChunk(head.gen, n);
      if (r.missing) { noteIncomplete(devId, n); P.cursor[devId] = { ...c }; await save(['cursor', 'quarantine', 'hlc', 'known']); return 'incomplete'; }
      if (r.bad || r.obj.k !== 't') { S.damaged[devId] = 'chunk ' + n; P.cursor[devId] = { ...c }; await save(['cursor', 'known']); return 'damaged'; }
      const o = r.obj;
      if (o.seqTo <= c.seqApplied) { lastHash = r.hash; c.lastChunkNo = n; c.lastHash = lastHash; continue; } // already applied before a re-base
      if (o.seqFrom !== c.seqApplied + 1 || o.prevHash !== lastHash) { S.damaged[devId] = 'chain break at chunk ' + n; P.cursor[devId] = { ...c }; await save(['cursor', 'known']); return 'damaged'; }
      if (deps.canApply && !deps.canApply()) { P.cursor[devId] = { ...c }; await save(['cursor', 'known']); return 'gated'; }
      await applyRemote(o.ops, devId);
      c.seqApplied = o.seqTo; c.lastChunkNo = n; c.lastHash = r.hash; lastHash = r.hash;
      P.cursor[devId] = { ...c };
      await save(['cursor', 'quarantine', 'hlc', 'known']); // progress per chunk (restart resumes here)
      if (S.progress) { S.progress.done++; emit(); }
    }
    delete S.incomplete[devId];
    delete S.damaged[devId];
    c.headCtr = head.headCtr;
    P.cursor[devId] = { ...c };
    P.own.ackPending = true;
    await save(['cursor', 'quarantine', 'hlc', 'known', 'own']);
    return result;
  }

  function noteIncomplete(devId, chunkNo) {
    const cur = S.incomplete[devId];
    if (!cur || cur.chunkNo !== chunkNo) S.incomplete[devId] = { chunkNo, since: clock.now() };
    else if (clock.now() - cur.since > lim.incompleteWarnMs) {
      const miss = P.own.missing || (P.own.missing = []);
      if (!miss.some((m) => m.dev === devId && m.chunkNo === chunkNo)) { miss.push({ dev: devId, chunkNo }); P.own.headDirty = true; schedulePush(); }
    }
  }

  async function pullLoop() {
    if (S.dead || !S.dek || S.stopped || P.config.paused) return;
    if (S.pulling) return;
    S.pulling = true;
    const prev = S.status;
    try {
      if (deps.canApply && !deps.canApply()) { retryLater('pull', pullLoop); return; }
      setStatus('pulling');
      await retryQuarantine();
      if (S.markerDirty) await checkMarker();
      if (S.stopped || S.needsPassphrase) return;
      if (S.discover) { S.discover = false; await discover(); }
      let again = false;
      for (let guard = 0; S.dirty.size && guard < 1000; guard++) {
        const dev = S.dirty.values().next().value;
        S.dirty.delete(dev);
        let r;
        try { r = await pullDevice(dev); } catch (e) { r = 'incomplete'; if (deps.hooks && deps.hooks.rethrow) throw e; }
        if (r === 'incomplete' || r === 'gated') again = true;
      }
      if (again) retryLater('pull', async () => { for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d); await pullLoop(); });
      S.lastSync = clock.now();
      if (P.own.ackPending && clock.now() - P.own.lastHeadAt >= lim.ackIntervalMs) { P.own.headDirty = true; await writeHead(); }
      if (P.own.headDirty || P.outbox.length) schedulePush();
    } finally {
      S.pulling = false;
      setStatus(S.stopped ? 'stoppedRemotely' : S.needsPassphrase ? 'needsPassphrase' : prev === 'bootstrapping' ? 'bootstrapping' : 'idle');
    }
  }

  async function pullAll() {
    await discover();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    await pullLoop();
  }

  // ---- pairing ----------------------------------------------------------------------
  const pickWinner = (roots) => [...roots].sort((a, b) => (a.dateAdded - b.dateAdded) || (a.marker.rootNonce < b.marker.rootNonce ? -1 : a.marker.rootNonce > b.marker.rootNonce ? 1 : 0) || (a.rootId < b.rootId ? -1 : 1))[0];

  async function finishPairing(marker, dek, rootId, markerId, deviceName) {
    S.marker = marker; S.dek = dek; S.rootId = rootId; S.markerId = markerId;
    S.stopped = false; S.needsPassphrase = false;
    P.session = { rootId, markerId, marker };
    P.config = { enabled: true, paused: false, deviceName: deviceName || P.config.deviceName || deviceId };
    transport.track && (transport.track(rootId, 'root'), transport.track(markerId, 'marker', rootId));
    await keys.set(dek);
    transport.setEventHandler(onEvent);
  }

  async function enable(passphrase, { deviceName } = {}) {
    if (!S.loaded) await load();
    setStatus('pairing');
    const roots = await transport.findRoots();
    if (roots.length) { setStatus('off'); throw new Error('vault-exists'); }
    const { marker, dek } = await createVault(passphrase, { iter, minIter, rng, extractable: ex });
    const { rootId, markerId } = await transport.createRoot(vaultUrl(marker));
    await finishPairing(marker, dek, rootId, markerId, deviceName);
    P.own = newOwn(); P.own.partSize = deps.partSize || DEFAULT_PART_SIZE;
    await createOwnFolder();
    await writeHead();
    await save();
    setStatus('idle');
  }

  async function join(passphrase, { deviceName } = {}) {
    if (!S.loaded) await load();
    setStatus('pairing');
    const roots = await transport.findRoots();
    if (!roots.length) { setStatus('off'); throw new Error('no-vault'); }
    const winner = pickWinner(roots);
    let dek;
    try { dek = await unlockVault(winner.marker, passphrase, { minIter, extractable: ex }); } catch (e) { setStatus('off'); throw e; }
    if (winner.marker.closed) { setStatus('off'); throw new Error('vault-closed'); }
    await finishPairing(winner.marker, dek, winner.rootId, winner.markerId, deviceName);
    P.own = newOwn(); P.own.partSize = deps.partSize || DEFAULT_PART_SIZE;
    P.cursor = {}; P.known = {};
    await createOwnFolder();
    await writeHead();
    await save();
    setStatus('bootstrapping');
    S.progress = { done: 0, total: 0 };
    await discover();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    // estimate total chunks for the progress UI
    for (const d of S.dirty) {
      const dd = await readDevice(d);
      if (dd) S.progress.total += new Set([...dd.chunks.keys()]).size;
    }
    await pullLoop();
    S.progress = null;
    setStatus('idle');
  }

  /** After a service-worker restart: reload persisted state and reattach. */
  async function resume() {
    await load();
    if (!P.config.enabled || !P.session) { setStatus('off'); return false; }
    S.dek = await keys.get();
    if (!S.dek) { S.needsPassphrase = true; setStatus('needsPassphrase'); return false; }
    S.marker = P.session.marker; S.rootId = P.session.rootId; S.markerId = P.session.markerId;
    transport.setEventHandler(onEvent);
    if (transport.rebuildTracked) { try { await transport.rebuildTracked(S.rootId); } catch { /* ignore */ } }
    S.devFolders.clear(); S.devFolderOf.clear();
    if (P.own.devFolderId) { S.devFolders.set(P.own.devFolderId, deviceId); S.devFolderOf.set(deviceId, P.own.devFolderId); }
    setStatus('idle');
    try { await discover(); } catch { /* root may be gone: check() handles it */ }
    if (P.own.headDirty) await flushHead();
    if (P.outbox.length) schedulePush();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    schedulePull();
    return true;
  }

  // ---- consistency check (hourly alarm) + self-healing ------------------------------------
  async function check() {
    if (S.dead || !S.dek || S.stopped || !P.config.enabled) return { skipped: true };
    const report = { healed: false, mergedRoots: 0, orphans: 0, rootRecreated: false };
    const roots = (await transport.findRoots()).filter((r) => r.marker.vaultId === S.marker.vaultId);
    const allRoots = await transport.findRoots();
    // root gone?
    if (!roots.length) {
      if (!S.rootGoneSince) S.rootGoneSince = clock.now();
      if (clock.now() - S.rootGoneSince >= lim.rootRecreateMs && !S.marker.closed) {
        const { rootId, markerId } = await transport.createRoot(vaultUrl(S.marker));
        S.rootId = rootId; S.markerId = markerId; P.session = { rootId, markerId, marker: S.marker };
        transport.track && (transport.track(rootId, 'root'), transport.track(markerId, 'marker', rootId));
        S.devFolders.clear(); S.devFolderOf.clear();
        await createOwnFolder();
        P.own.nodes = {}; P.own.headDirty = true;
        await rebuildBase();
        S.rootGoneSince = null; report.rootRecreated = true;
        await save();
      }
      return report;
    }
    S.rootGoneSince = null;
    // duplicate roots of the same vault -> merge into the winner; also follow the winner if our root vanished
    const wantRoot = pickWinner(roots);
    if (roots.length > 1 || wantRoot.rootId !== S.rootId) {
      const winner = wantRoot;
      for (const r of roots) {
        if (r.rootId === winner.rootId) continue;
        let kids = [];
        try { kids = await transport.listChildren(r.rootId); } catch { /* ignore */ }
        for (const k of kids) if (!k.url) { try { await transport.moveNode(k.id, winner.rootId); } catch { /* ignore */ } }
        try { await transport.removeTree(r.rootId); } catch { /* ignore */ }
        report.mergedRoots++;
      }
      S.rootId = winner.rootId; S.markerId = winner.markerId; P.session = { rootId: winner.rootId, markerId: winner.markerId, marker: S.marker };
      transport.track && (transport.track(winner.rootId, 'root'), transport.track(winner.markerId, 'marker', winner.rootId));
      S.devFolders.clear(); S.devFolderOf.clear();
      if (P.own.devFolderId) { S.devFolders.set(P.own.devFolderId, deviceId); S.devFolderOf.set(deviceId, P.own.devFolderId); }
      await save(['session']);
    }
    // a different vault wins the root election -> need the passphrase to adopt it
    const others = allRoots.filter((r) => r.marker.vaultId !== S.marker.vaultId);
    if (others.length) {
      const w = pickWinner(allRoots);
      if (w.marker.vaultId !== S.marker.vaultId) { S.rootConflict = { winnerRootId: w.rootId, winnerVaultId: w.marker.vaultId }; emit(); }
    } else S.rootConflict = null;
    await checkMarker();
    if (S.stopped) return report;
    // own folder integrity
    const own = P.own;
    let ownKids = null;
    try {
      const fnode = own.devFolderId ? await transport.getNode(own.devFolderId) : null;
      ownKids = fnode ? await transport.listChildren(own.devFolderId) : null;
    } catch { ownKids = null; }
    if (!ownKids) {
      await createOwnFolder();
      own.nodes = {}; own.headDirty = true;
      await rebuildBase();
      report.healed = true;
    } else {
      const byId = new Map(ownKids.map((k) => [k.id, k]));
      let chunkBroken = false, headBroken = false;
      for (const [key, n] of Object.entries(own.nodes)) {
        const live = byId.get(n.id);
        const ok = live && live.url && (await strHash8(live.url)) === n.h;
        if (!ok) { if (key.startsWith('c:')) chunkBroken = true; else headBroken = true; }
      }
      const known = new Set(Object.values(own.nodes).map((n) => n.id));
      for (const k of ownKids) {
        const p = k.url ? parseNodeUrl(k.url) : null;
        if (p && p.kind === 'd') continue;
        if (!known.has(k.id)) { try { await transport.removeNode(k.id); report.orphans++; } catch { /* ignore */ } }
      }
      if (chunkBroken) { own.nodes = Object.fromEntries(Object.entries(own.nodes).filter(([k]) => k.startsWith('h:'))); await rebuildBase(); report.healed = true; }
      else if (headBroken) { own.nodes = Object.fromEntries(Object.entries(own.nodes).filter(([k]) => k.startsWith('c:'))); own.headDirty = true; await writeHead(); report.healed = true; }
    }
    S.heal = false;
    await discover();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    await pullLoop();
    if (clock.now() - P.own.lastHeadAt >= lim.heartbeatMs || (P.own.ackPending && clock.now() - P.own.lastHeadAt >= lim.ackIntervalMs)) { P.own.headDirty = true; await writeHead(); }
    if (P.outbox.length) await push();
    return report;
  }

  // ---- adopt another vault / passphrase / rotation / kill switch -----------------------------
  async function adoptRoot(passphrase) {
    const roots = await transport.findRoots();
    const w = pickWinner(roots);
    if (w.marker.vaultId === S.marker.vaultId) return false;
    const dek = await unlockVault(w.marker, passphrase, { minIter, extractable: ex });
    const entries = P.ownLog;
    const seq = P.own.ownSeq;
    await finishPairing(w.marker, dek, w.rootId, w.markerId, P.config.deviceName);
    P.own = newOwn(); P.own.partSize = deps.partSize || DEFAULT_PART_SIZE; P.own.ownSeq = seq;
    P.ownLog = entries; P.cursor = {}; P.known = {};
    S.devFolders.clear(); S.devFolderOf.clear(); S.rootConflict = null;
    await createOwnFolder();
    await rebuildBase();
    await discover();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    await pullLoop();
    await save();
    return true;
  }

  /** Re-enter the passphrase after another device rotated the key (epoch change). */
  async function unlockAfterRotation(passphrase) {
    const node = await transport.getNode(S.markerId);
    const p = node && node.url ? parseNodeUrl(node.url) : null;
    if (!p || p.kind !== 'v') throw new Error('marker missing');
    const dek = await unlockVault(p.marker, passphrase, { minIter, extractable: ex });
    S.marker = p.marker; S.dek = dek; S.needsPassphrase = false;
    P.session.marker = p.marker; await keys.set(dek);
    P.cursor = {}; P.known = {};
    P.own = { ...newOwn(), ownSeq: P.own.ownSeq, devFolderId: P.own.devFolderId, partSize: P.own.partSize, nodes: Object.fromEntries(Object.entries(P.own.nodes).filter(([k]) => k.startsWith('h:'))) };
    await rebuildBase();
    for (const d of S.devFolderOf.keys()) if (d !== deviceId) S.dirty.add(d);
    setStatus('idle');
    await pullLoop();
    await save();
  }

  async function changePassphrase(oldPass, newPass) {
    const m = await cpass(S.marker, oldPass, newPass, { minIter, iter, rng });
    S.marker = m; P.session.marker = m;
    await transport.updateNode(S.markerId, vaultUrl(m));
    await save(['session']);
  }

  async function rotateKey(passphrase) {
    const { marker, dek } = await rkey(S.marker, passphrase, { minIter, iter, rng, extractable: ex });
    S.marker = marker; S.dek = dek; P.session.marker = marker;
    await keys.set(dek);
    await transport.updateNode(S.markerId, vaultUrl(marker));
    P.cursor = {}; P.known = {};
    P.own = { ...newOwn(), ownSeq: P.own.ownSeq, devFolderId: P.own.devFolderId, partSize: P.own.partSize, nodes: Object.fromEntries(Object.entries(P.own.nodes).filter(([k]) => k.startsWith('h:'))) };
    await rebuildBase();
    await save();
  }

  async function wipeLocal() {
    cancelTimers();
    await state.del(PERSISTED);
    await keys.del();
    P = { cursor: {}, outbox: [], own: newOwn(), ownLog: [], session: null, quarantine: [], known: {}, hlc: '', config: { enabled: false, paused: false, deviceName: '' } };
    S.dek = null; S.marker = null; S.rootId = null; S.markerId = null; S.stopped = false;
    S.devFolders.clear(); S.devFolderOf.clear(); S.dirty.clear();
    setStatus('off');
  }

  /** Kill switch: mark the vault closed, give peers time to notice, remove the remote folder, wipe local sync state. */
  async function wipeRemote({ waitMs = 60000 } = {}) {
    const m = { ...S.marker, closed: true };
    await transport.updateNode(S.markerId, vaultUrl(m));
    if (waitMs) await timers.sleep(waitMs);
    await transport.removeTree(S.rootId);
    await wipeLocal();
  }
  async function disableLocal() { P.config.enabled = false; await save(['config']); cancelTimers(); S.dek = null; await keys.del(); setStatus('off'); }

  async function removeDevice(devId, { force = false } = {}) {
    if (devId === deviceId) throw new Error('cannot remove self');
    const k = P.known[devId];
    if (!force && k && clock.now() - k.lastSeen < lim.staleDeviceMs) throw new Error('device still active');
    const f = S.devFolderOf.get(devId);
    if (f) await transport.removeTree(f);
    S.devFolderOf.delete(devId); S.devFolders.delete(f);
    delete P.known[devId]; delete P.cursor[devId];
    await save(['known', 'cursor']);
  }

  async function pause() { P.config.paused = true; await save(['config']); cancelTimers(); emit(); }
  async function resumeSync() { P.config.paused = false; await save(['config']); emit(); await flushHead(); if (P.outbox.length) await push(); schedulePull(); }
  async function syncNow() { await check(); }

  return {
    load, enable, join, resume, push, pullLoop, pullAll, check, discover, onEvent, stamp, recordLocal,
    changePassphrase, rotateKey, unlockAfterRotation, adoptRoot, wipeRemote, wipeLocal, disableLocal, removeDevice,
    pause, resumeSync, syncNow, shutdown, status, compactNow: () => rebuildBase(),
    // introspection for tests / UI
    _P: () => P, _S: S, _bucket: bucket, WrongPassphraseError, randomId,
  };
}
