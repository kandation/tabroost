// Vault key management and AES-GCM helpers (WebCrypto only).
// passphrase --PBKDF2-SHA256--> KEK --wrapKey--> random DEK (AES-GCM-256).
// The DEK is only ever held as a NON-extractable CryptoKey (structured-cloneable,
// so it can be stored in IndexedDB); the passphrase is never stored.
import { utf8, b64uEnc, b64uDec, concat, randomBytes, randomId } from './bytes.js';

export const DEFAULT_ITER = 600000;
export const MIN_ITER = 310000;

export class WrongPassphraseError extends Error {
  constructor() { super('wrong passphrase'); this.name = 'WrongPassphraseError'; }
}
export class CryptoFormatError extends Error {
  constructor(msg) { super(msg); this.name = 'CryptoFormatError'; }
}

const subtle = () => globalThis.crypto.subtle;

async function deriveKEK(passphrase, salt, iter) {
  const base = await subtle().importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

function checkIter(iter, minIter) {
  if (!Number.isInteger(iter) || iter < minIter) throw new CryptoFormatError('kdf iterations too low: ' + iter);
}

async function wrap(dekExtractable, passphrase, iter, rng) {
  const salt = randomBytes(16, rng);
  const iv = randomBytes(12, rng);
  const kek = await deriveKEK(passphrase, salt, iter);
  const wrapped = new Uint8Array(await subtle().wrapKey('raw', dekExtractable, kek, { name: 'AES-GCM', iv }));
  return { kdf: { alg: 'PBKDF2-SHA256', iter, salt: b64uEnc(salt) }, wrappedDEK: b64uEnc(wrapped), iv: b64uEnc(iv) };
}

async function unwrap(marker, passphrase, minIter, extractable) {
  const { kdf } = marker;
  if (!kdf || kdf.alg !== 'PBKDF2-SHA256') throw new CryptoFormatError('unknown kdf');
  checkIter(kdf.iter, minIter);
  const kek = await deriveKEK(passphrase, b64uDec(kdf.salt), kdf.iter);
  try {
    return await subtle().unwrapKey(
      'raw', b64uDec(marker.wrappedDEK), kek, { name: 'AES-GCM', iv: b64uDec(marker.iv) },
      { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

async function newDek() {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Create a brand-new vault. Returns {marker, dek} (dek is non-extractable). */
export async function createVault(passphrase, opts = {}) {
  const iter = opts.iter ?? DEFAULT_ITER;
  const minIter = opts.minIter ?? MIN_ITER;
  checkIter(iter, minIter);
  const rng = opts.rng;
  const dek = await newDek();
  const w = await wrap(dek, passphrase, iter, rng);
  const marker = {
    v: 1,
    vaultId: randomId(rng, 8),
    rootNonce: randomId(rng, 8),
    epoch: 1,
    closed: false,
    ...w,
  };
  return { marker, dek: await unwrap(marker, passphrase, minIter, !!opts.extractable) };
}

/** Unlock an existing vault marker. Throws WrongPassphraseError. */
export async function unlockVault(marker, passphrase, opts = {}) {
  return unwrap(marker, passphrase, opts.minIter ?? MIN_ITER, !!opts.extractable); // extractable only when the caller seals the key under the password lock (lib/syncseal.js)
}

/** Re-wrap the SAME DEK under a new passphrase (new salt + iv). Returns the new marker. */
export async function changePassphrase(marker, oldPass, newPass, opts = {}) {
  const minIter = opts.minIter ?? MIN_ITER;
  const iter = opts.iter ?? marker.kdf.iter;
  checkIter(iter, minIter);
  const dek = await unwrap(marker, oldPass, minIter, true); // extractable only in memory here
  const w = await wrap(dek, newPass, iter, opts.rng);
  return { ...marker, ...w };
}

/** Rotate the DEK (epoch + 1). Returns {marker, dek}; every device must re-pair. */
export async function rotateKey(marker, passphrase, opts = {}) {
  const minIter = opts.minIter ?? MIN_ITER;
  // verify the passphrase against the current marker first
  await unwrap(marker, passphrase, minIter, false);
  const dek = await newDek();
  const w = await wrap(dek, passphrase, opts.iter ?? marker.kdf.iter, opts.rng);
  const next = { ...marker, ...w, epoch: marker.epoch + 1 };
  return { marker: next, dek: await unwrap(next, passphrase, minIter, !!opts.extractable) };
}

/** AAD string binding ciphertext to its slot (vault, epoch, device, kind, generation, chunk). */
export function aad(vaultId, epoch, deviceId, kind, gen, chunkNo) {
  return 'cmr1|' + vaultId + '|' + epoch + '|' + deviceId + '|' + kind + '|' + gen + '|' + chunkNo;
}

/** Returns iv(12) || ciphertext+tag. */
export async function encrypt(dek, aadStr, bytes, rng) {
  const iv = randomBytes(12, rng);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aadStr) }, dek, bytes));
  return concat(iv, ct);
}

export async function decrypt(dek, aadStr, data) {
  if (data.length < 12 + 16) throw new CryptoFormatError('ciphertext too short');
  const iv = data.subarray(0, 12);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aadStr) }, dek, data.subarray(12)));
  } catch {
    throw new CryptoFormatError('decrypt failed (tampered, moved or wrong key)');
  }
}
