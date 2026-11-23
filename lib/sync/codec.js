// Payload codec: JSON -> deflate-raw -> pad -> (encrypt elsewhere) -> base64url parts
// packed into synthetic bookmark URLs: https://cmr.invalid/<kind>#<fields>.<payload>
import { utf8, fromUtf8, b64uEnc, b64uDec } from './bytes.js';

export { b64uEnc, b64uDec };

export const NODE_HOST = 'https://cmr.invalid/';
export const NODE_TITLE = 'Tabroost sync data - do not edit';
export const DEFAULT_PART_SIZE = 6 * 1024; // base64url chars per node URL
export const MAX_PART_SIZE = 32 * 1024;
export const MIN_PART_SIZE = 2 * 1024;
export const MAX_PLAINTEXT = 256 * 1024;
export const PAD_TO = 256;
export const MAX_OPS_PER_CHUNK = 2000;

async function runStream(input, makeTransform, limit) {
  const t = makeTransform();
  const w = t.writable.getWriter();
  w.write(input).catch(() => {});
  w.close().catch(() => {});
  const reader = t.readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (limit && total > limit) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('payload too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** object -> [4B length][deflate-raw(json)][zero padding to a multiple of 256]. */
export async function pack(obj) {
  const json = utf8(JSON.stringify(obj));
  if (json.length > MAX_PLAINTEXT) throw new Error('plaintext exceeds ' + MAX_PLAINTEXT);
  const z = await runStream(json, () => new CompressionStream('deflate-raw'));
  const len = 4 + z.length;
  const padded = Math.ceil(len / PAD_TO) * PAD_TO;
  const out = new Uint8Array(padded);
  new DataView(out.buffer).setUint32(0, z.length);
  out.set(z, 4);
  return out;
}

export async function unpack(bytes) {
  if (bytes.length < 4) throw new Error('short payload');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (n > bytes.length - 4) throw new Error('bad payload length');
  const json = await runStream(bytes.subarray(4, 4 + n), () => new DecompressionStream('deflate-raw'), MAX_PLAINTEXT);
  return JSON.parse(fromUtf8(json));
}

/** Split bytes into base64url strings of at most `partSize` chars. */
export function splitParts(bytes, partSize = DEFAULT_PART_SIZE) {
  const s = b64uEnc(bytes);
  const out = [];
  for (let i = 0; i < s.length; i += partSize) out.push(s.slice(i, i + partSize));
  if (!out.length) out.push('');
  return out;
}

/** partsByIndex: Map<number,string> (1-based); returns bytes or null if incomplete. */
export function reassemble(partsByIndex, total) {
  let s = '';
  for (let i = 1; i <= total; i++) {
    const p = partsByIndex.get(i);
    if (p === undefined) return null;
    s += p;
  }
  return b64uDec(s);
}

// ---- URL packing ----------------------------------------------------------
export const headUrl = (part, parts, b64) => `${NODE_HOST}h#1.${part}.${parts}.${b64}`;
export const chunkUrl = (gen, chunkNo, part, parts, b64) => `${NODE_HOST}c#1.${gen}.${chunkNo}.${part}.${parts}.${b64}`;
export const deviceMarkerUrl = (deviceId) => `${NODE_HOST}d#${deviceId}`;
export const vaultUrl = (marker) => `${NODE_HOST}v#1.${b64uEnc(utf8(JSON.stringify(marker)))}`;

/**
 * Parse a bookmark URL into a typed descriptor, or null if it is not ours / malformed.
 *  {kind:'v', marker} | {kind:'d', deviceId} | {kind:'h', part, parts, b64}
 *  | {kind:'c', gen, chunkNo, part, parts, b64}
 */
export function parseNodeUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(NODE_HOST)) return null;
  const rest = url.slice(NODE_HOST.length);
  const hash = rest.indexOf('#');
  if (hash < 1) return null;
  const kind = rest.slice(0, hash);
  const f = rest.slice(hash + 1).split('.');
  const num = (x) => (/^\d+$/.test(x) ? Number(x) : NaN);
  try {
    if (kind === 'd') return f.length === 1 && f[0] ? { kind, deviceId: f[0] } : null;
    if (kind === 'v') {
      if (f.length !== 2 || f[0] !== '1') return null;
      return { kind, marker: JSON.parse(fromUtf8(b64uDec(f[1]))) };
    }
    if (kind === 'h') {
      if (f.length !== 4 || f[0] !== '1') return null;
      const part = num(f[1]), parts = num(f[2]);
      if (!(part >= 1 && parts >= part)) return null;
      return { kind, part, parts, b64: f[3] };
    }
    if (kind === 'c') {
      if (f.length !== 6 || f[0] !== '1') return null;
      const gen = num(f[1]), chunkNo = num(f[2]), part = num(f[3]), parts = num(f[4]);
      if (!(gen >= 0 && chunkNo >= 1 && part >= 1 && parts >= part)) return null;
      return { kind, gen, chunkNo, part, parts, b64: f[5] };
    }
  } catch { return null; }
  return null;
}
