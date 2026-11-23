// KDFs: password KEK (PBKDF2), recovery key (Crockford Base32 + checksum), HKDF helpers, strength meter.
import { utf8, concat, randomBytes, subtle } from './bytes.js';

export const PBKDF2_ITER = 600000; // production value (spec §2); parameters are stored so they can be raised later
export const MIN_ITER = 1000;      // floor accepted here so tests can run fast; production callers always pass 600k

/** KEK_pw = PBKDF2-SHA256(password NFKC, salt, iter) -> AES-GCM-256, non-extractable (can only wrap/unwrap MK). */
export async function deriveKekPw(password, salt, iter = PBKDF2_ITER) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  if (!(iter >= MIN_ITER)) throw new RangeError('iteration count too low');
  const base = await subtle().importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export const newSalt = () => randomBytes(16);

// ---- HKDF helpers (all derived keys are imported NON-extractable) ----
export const hkdfBase = (bytes) => subtle().importKey('raw', bytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
export const hkdfAesKey = (base, info, salt = new Uint8Array(0), usages = ['encrypt', 'decrypt']) =>
  subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, base,
    { name: 'AES-GCM', length: 256 }, false, usages);
export const hkdfHmacKey = (base, info, salt = new Uint8Array(0)) =>
  subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);

// ---- Recovery key ----
// 32 random bytes + first 3 bytes of SHA-256(bytes) = 35 bytes = 280 bits = exactly 56 base32 chars.
// The checksum catches typos BEFORE we try to unwrap (so a typo never counts as a brute-force failure).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 32; i++) DEC[ALPHABET.charCodeAt(i)] = i;

export function base32Encode(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const out = []; let bits = 0, acc = 0;
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    const v = c < 128 ? DEC[c] : -1;
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}

async function checksum3(bytes32) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes32)).subarray(0, 3);
}

/** Fresh recovery secret. Returns {bytes, text}; `text` is shown to the user exactly once. */
export async function generateRecoveryKey(bytes = randomBytes(32)) {
  return { bytes, text: await formatRecoveryKey(bytes) };
}
export async function formatRecoveryKey(bytes32) {
  const s = base32Encode(concat(bytes32, await checksum3(bytes32))); // 56 chars
  return s.match(/.{7}/g).join('-'); // 8 groups of 7
}

/**
 * Parse user input (any case, spaces/hyphens ignored, O->0, I/L->1 per Crockford).
 * -> {ok:true, bytes} | {ok:false, reason:'length'|'chars'|'checksum'}
 */
export async function parseRecoveryKey(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 56) return { ok: false, reason: 'length' };
  const raw = base32Decode(s);
  if (!raw || raw.length !== 35) return { ok: false, reason: 'chars' };
  const bytes = raw.slice(0, 32);
  const sum = await checksum3(bytes);
  if (sum[0] !== raw[32] || sum[1] !== raw[33] || sum[2] !== raw[34]) return { ok: false, reason: 'checksum' };
  return { ok: true, bytes };
}

/** KEK_rec = HKDF(recoveryBytes32, "cmr-rec-v1"). No PBKDF2 needed: the input is 256 bits of entropy. */
export async function recoveryKek(bytes32) {
  return hkdfAesKey(await hkdfBase(bytes32), 'cmr-rec-v1');
}

// ---- Password strength (spec §4) ----
// Minimum 8. weak: 8-9 chars or a single character class. fair: >=10 with 2+ classes (12+ is the recommended
// point). strong: >=16 with 2+ classes. The spec leaves 10-11 undefined; we class them "fair" ("weak below 10").
export function passwordStrength(pw) {
  const p = String(pw || '');
  const len = [...p].length; // code points, so Thai/emoji count once
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  let level;
  if (len < 8) level = 'tooShort';
  else if (len < 10 || classes < 2) level = 'weak';
  else if (len >= 16) level = 'strong';
  else level = 'fair';
  return { level, ok: len >= 8, length: len, classes };
}
