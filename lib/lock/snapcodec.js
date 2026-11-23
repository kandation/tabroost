// Encrypted persistence of the search index snapshot (spec §3 "Search snapshot"): the worker's serialize() output (a term blob +
// typed arrays) is packed into one byte stream, cut into <= 4 MB chunks and each chunk is sealed with XK (AAD "snap-chunk:<i>").
// The term list is title/URL text, so it must never be written readable while the lock is on. Pure (WebCrypto only).
import { sealBytes, openBytes, CorruptRecordError } from './rec.js';
import { utf8, fromUtf8, concat } from './bytes.js';

export const CHUNK = 4 * 1024 * 1024;
const CTORS = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array };

/** {meta, buffers:{name: string | TypedArray}} -> Uint8Array [u32 header length][JSON header][raw parts...] */
export function pack(snap) {
  const parts = [];
  const bufs = [];
  for (const [name, v] of Object.entries(snap.buffers)) {
    if (typeof v === 'string') { const b = utf8(v); parts.push({ name, type: 'str', bytes: b.length }); bufs.push(b); }
    else { parts.push({ name, type: v.constructor.name, bytes: v.byteLength }); bufs.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); }
  }
  const header = utf8(JSON.stringify({ meta: snap.meta, parts }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return concat(len, header, ...bufs);
}

export function unpack(bytes) {
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const head = JSON.parse(fromUtf8(bytes.subarray(4, 4 + hl)));
  let off = 4 + hl;
  const buffers = {};
  for (const p of head.parts) {
    const raw = bytes.subarray(off, off + p.bytes);
    off += p.bytes;
    if (p.type === 'str') buffers[p.name] = fromUtf8(raw);
    else {
      const C = CTORS[p.type];
      if (!C) throw new CorruptRecordError('format', 'snapshot part ' + p.type);
      buffers[p.name] = new C(raw.slice().buffer); // copy: typed arrays need an aligned buffer
    }
  }
  return { meta: head.meta, buffers };
}

/** -> {chunks: Uint8Array[], n}. xk = the XK CryptoKey (k = 0). */
export async function seal(xk, snap) {
  const all = pack(snap);
  const chunks = [];
  for (let i = 0, c = 0; i < all.length || c === 0; i += CHUNK, c++) chunks.push(await sealBytes(xk, 0, 'snap-chunk:' + c, all.subarray(i, Math.min(all.length, i + CHUNK))));
  return { chunks, n: chunks.length };
}

/** chunks -> snapshot, or throws CorruptRecordError (a damaged / replaced chunk fails authentication: the caller rebuilds). */
export async function open(xk, chunks) {
  const parts = [];
  for (let c = 0; c < chunks.length; c++) parts.push(await openBytes(xk, 0, 'snap-chunk:' + c, chunks[c]));
  return unpack(concat(...parts));
}
