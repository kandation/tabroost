// Op log helpers: chunk building/sealing, chunk splitting, base compaction, acks/GC.
//
// Own log entries are {seq, op}. A device publishes
//   base chunks (generation `gen`, numbered 1..B)  -> plaintext {k:'b', gen, n, baseSeq, ops}
//   tail chunks (numbered B+1..)                   -> plaintext {k:'t', seqFrom, seqTo, prevHash, ops}
// Tail chunks form a hash chain: prevHash = hash16(ciphertext of the previous chunk, the last
// base chunk for the first tail chunk, '' if there is no base).
import { pack, unpack, MAX_OPS_PER_CHUNK, MAX_PLAINTEXT } from './codec.js';
import { encrypt, decrypt, aad } from './crypto.js';
import { hash16 } from './bytes.js';
import { parseHlc } from './hlc.js';

export const TOMBSTONE_KEEP_MS = 90 * 24 * 3600 * 1000;

export const isAddOp = (op) => op.t === 'i' && !op.x && op.f && op.f.url !== undefined;

/** Split ops into chunks that respect the op-count and plaintext-size limits. */
export function splitOps(ops, maxOps = MAX_OPS_PER_CHUNK, maxBytes = Math.floor(MAX_PLAINTEXT * 0.8)) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const op of ops) {
    const sz = JSON.stringify(op).length + 1;
    if (cur.length && (cur.length >= maxOps || bytes + sz > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(op);
    bytes += sz;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Compact an own log. For each (entity, field) keep only the newest write of this device,
 * drop fields superseded by a newer value known locally (isSuperseded(t,id,field,h) -> bool),
 * keep purge tombstones until `tombstoneOk(entry)` says they may go.
 * Returns entries (original seq kept) grouped into one op per (entity, hlc).
 */
export async function compactLog(entries, { isSuperseded, tombstoneOk } = {}) {
  const purged = new Map(); // `${t}:${id}` -> entry
  const newest = new Map(); // `${t}:${id}:${field}` -> {entry, h, v}
  for (const e of entries) {
    const { op } = e;
    if (op.x) { purged.set(op.t + ':' + op.id, e); continue; }
    for (const k of Object.keys(op.f || {})) {
      const key = op.t + ':' + op.id + ':' + k;
      const prev = newest.get(key);
      if (!prev || op.h > prev.op.h || (op.h === prev.op.h && e.seq > prev.seq)) newest.set(key, { seq: e.seq, op, k });
    }
  }
  const groups = new Map(); // `${t}:${id}:${h}` -> {seq,op}
  for (const [key, w] of newest) {
    const [t, id] = [w.op.t, w.op.id];
    if (purged.has(t + ':' + id)) continue; // tombstone supersedes everything
    if (isSuperseded && (await isSuperseded(t, id, w.k, w.op.h))) continue;
    const gk = t + ':' + id + ':' + w.op.h;
    let g = groups.get(gk);
    if (!g) { g = { seq: w.seq, op: { h: w.op.h, t, id, f: {} } }; groups.set(gk, g); }
    g.op.f[w.k] = w.op.f[w.k];
    if (w.seq > g.seq) g.seq = w.seq;
  }
  const out = [...groups.values()];
  for (const e of purged.values()) {
    if (!tombstoneOk || !tombstoneOk(e)) out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq || (a.op.h < b.op.h ? -1 : 1));
  return out;
}

export function tombstoneAge(op, nowMs) {
  return nowMs - parseHlc(op.h).wall;
}

/** Seal any JSON object into ciphertext bytes bound to its slot. */
export async function sealObject(ctx, kind, gen, chunkNo, obj, rng) {
  const bytes = await pack(obj);
  return encrypt(ctx.dek, aad(ctx.vaultId, ctx.epoch, ctx.deviceId, kind, gen, chunkNo), bytes, rng);
}

export async function openObject(ctx, deviceId, kind, gen, chunkNo, ct) {
  const plain = await decrypt(ctx.dek, aad(ctx.vaultId, ctx.epoch, deviceId, kind, gen, chunkNo), ct);
  return unpack(plain);
}

export async function sealTailChunk(ctx, chunkNo, gen, seqFrom, ops, prevHash, rng) {
  const obj = { k: 't', seqFrom, seqTo: seqFrom + ops.length - 1, prevHash, ops };
  const ct = await sealObject(ctx, 'c', gen, chunkNo, obj, rng);
  return { ct, hash: await hash16(ct), obj };
}

export async function sealBaseChunk(ctx, chunkNo, gen, n, baseSeq, ops, rng) {
  const obj = { k: 'b', gen, n, baseSeq, ops };
  const ct = await sealObject(ctx, 'c', gen, chunkNo, obj, rng);
  return { ct, hash: await hash16(ct), obj };
}

/** Head object -> ciphertext (kind 'h', gen 0, chunk 0). */
export function sealHead(ctx, head, rng) {
  return sealObject(ctx, 'h', 0, 0, head, rng);
}
export function openHead(ctx, deviceId, ct) {
  return openObject(ctx, deviceId, 'h', 0, 0, ct);
}

/** Min ack over the active devices (devices seen within `activeMs`), or Infinity if none. */
export function minAck(known, selfId, nowMs, activeMs = 30 * 24 * 3600 * 1000) {
  let m = Infinity;
  for (const [dev, info] of Object.entries(known || {})) {
    if (dev === selfId) continue;
    if (nowMs - (info.lastSeen || 0) > activeMs) continue;
    const a = info.acks ? info.acks[selfId] || 0 : 0;
    if (a < m) m = a;
  }
  return m;
}
