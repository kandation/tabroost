// Small byte helpers for lib/lock. Pure, no chrome.*; works in Node 22, pages, workers and the SW.
// Re-exports the already-tested helpers of lib/sync/bytes.js (read-only reuse).
export { utf8, fromUtf8, concat, b64uEnc, b64uDec } from '../sync/bytes.js';

/** Standard base64 (with padding). Used where a string is required (vault in storage.local, session key). */
export function b64enc(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64dec(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; // no early exit: keeps comparisons uniform
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Overwrite a buffer holding secret material once it is no longer needed (best effort in JS). */
export function wipe(b) { if (b && b.fill) b.fill(0); }

export const subtle = () => globalThis.crypto.subtle;
