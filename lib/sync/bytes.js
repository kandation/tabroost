// Small byte helpers shared by the sync modules (pure, no chrome.*).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

export function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) REV[B64.charCodeAt(i)] = i;

/** base64url without padding. */
export function b64uEnc(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (i < n) {
    const rem = n - i;
    const v = (bytes[i] << 16) | ((rem > 1 ? bytes[i + 1] : 0) << 8);
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    if (rem > 1) out += B64[(v >> 6) & 63];
  }
  return out;
}

export function b64uDec(str) {
  const n = str.length;
  if (n % 4 === 1) throw new Error('bad base64url length');
  const outLen = Math.floor((n * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    const a = REV[str.charCodeAt(i)], b = REV[str.charCodeAt(i + 1)], c = REV[str.charCodeAt(i + 2)], d = REV[str.charCodeAt(i + 3)];
    if ((a | b | c | d) < 0) throw new Error('bad base64url char');
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (v >> 16) & 255; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
  }
  const rem = n - i;
  if (rem === 2) {
    const a = REV[str.charCodeAt(i)], b = REV[str.charCodeAt(i + 1)];
    if ((a | b) < 0) throw new Error('bad base64url char');
    out[o++] = ((a << 18) | (b << 12)) >> 16 & 255;
  } else if (rem === 3) {
    const a = REV[str.charCodeAt(i)], b = REV[str.charCodeAt(i + 1)], c = REV[str.charCodeAt(i + 2)];
    if ((a | b | c) < 0) throw new Error('bad base64url char');
    const v = (a << 18) | (b << 12) | (c << 6);
    out[o++] = (v >> 16) & 255; out[o++] = (v >> 8) & 255;
  }
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** First 16 bytes of SHA-256, hex (32 chars): the chunk hash used for the chain. */
export async function hash16(bytes) {
  return toHex((await sha256(bytes)).subarray(0, 16));
}

/** Short hash of a string (first 8 bytes hex) used to detect edited nodes. */
export async function strHash8(s) {
  return toHex((await sha256(utf8(s))).subarray(0, 8));
}

export function randomBytes(n, rng) {
  const out = new Uint8Array(n);
  if (rng) { for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256); return out; }
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomId(rng, bytes = 8) {
  return toHex(randomBytes(bytes, rng));
}
