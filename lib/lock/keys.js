// Key hierarchy, meta.lock record, unlock/lock, session handling (spec §2, §4).
//
//   password --PBKDF2--> KEK_pw --wraps--> MK (32 random bytes) <--wrapped by-- KEK_rec <--HKDF-- recovery key
//   MK --HKDF--> DK (data), HK (blind tokens), XK (search snapshot + favicons), PKEY (wraps the ECDH private key)
//   ECDH P-256 keypair: PK (public, stored plaintext, used to encrypt while locked), SK (private, wrapped by PKEY)
//
// All derived CryptoKeys are imported NON-extractable. The only secret that ever leaves this module for storage is
// MK, and only into the injected session adapter (chrome.storage.session: memory-only). Nothing key-related is
// written to IDB / storage.local / localStorage.
import { utf8, b64enc, b64dec, randomBytes, wipe, subtle, bytesEqual, toHex } from './bytes.js';
import {
  PBKDF2_ITER, deriveKekPw, newSalt, hkdfBase, hkdfAesKey, hkdfHmacKey,
  generateRecoveryKey, parseRecoveryKey, recoveryKek,
} from './kdf.js';

export class WrongPasswordError extends Error { constructor() { super('wrong password'); this.name = 'WrongPasswordError'; } }
export class WrongRecoveryKeyError extends Error { constructor() { super('wrong recovery key'); this.name = 'WrongRecoveryKeyError'; } }
/** Typo / wrong length: detected by the checksum BEFORE any unwrap, so it must not count as a brute-force failure. */
export class RecoveryFormatError extends Error {
  constructor(reason) { super('bad recovery key format: ' + reason); this.name = 'RecoveryFormatError'; this.reason = reason; this.countsAsFailure = false; }
}
export class NoRecoveryKeyError extends Error { constructor() { super('no recovery key set'); this.name = 'NoRecoveryKeyError'; } }
/** Second unlock methods (slots): a wrong backup password / wrong passkey secret counts as a failure like a wrong password. */
export class WrongBackupPasswordError extends Error { constructor() { super('wrong backup password'); this.name = 'WrongBackupPasswordError'; } }
export class WrongSlotError extends Error { constructor() { super('wrong slot secret'); this.name = 'WrongSlotError'; } }
export class NoSlotError extends Error { constructor() { super('no such unlock slot'); this.name = 'NoSlotError'; } }
/** code: 'exists' (one backup password only) | 'same' (equals the main password) | 'max' | 'badInput' */
export class SlotError extends Error { constructor(code) { super('slot: ' + code); this.name = 'SlotError'; this.code = code; } }
/** meta.lock.pub was replaced: an attacker could make locked stashes encrypt to their key. Alert the user. */
export class PubTamperedError extends Error { constructor() { super('public key MAC mismatch'); this.name = 'PubTamperedError'; } }
export class LockMetaError extends Error { constructor(m) { super('lock metadata invalid: ' + m); this.name = 'LockMetaError'; } }

const AAD_MK_PW = utf8('cmr|mk|pw');
const AAD_MK_REC = utf8('cmr|mk|rec');
const AAD_PRIV = utf8('cmr|priv');
const AAD_CHECK = utf8('cmr|check');

async function aesWrap(key, plain, aad) {
  const iv = randomBytes(12);
  return { iv, ct: new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain)) };
}
const aesUnwrap = async (key, w, aad) =>
  new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: w.iv, additionalData: aad }, key, w.ct));

/** Derive DK/HK/XK/PKEY from MK, then verify meta (check value, pubMac) and import SK. Throws on any inconsistency. */
async function deriveKeys(mk, meta) {
  const base = await hkdfBase(mk);
  const [dk, hk, xk, pkey] = await Promise.all([
    hkdfAesKey(base, 'cmr-dk-v1'),
    hkdfHmacKey(base, 'cmr-hk-v1'),
    hkdfAesKey(base, 'cmr-xk-v1'),
    hkdfAesKey(base, 'cmr-priv-v1'),
  ]);
  // The check value proves MK is the right one for this meta (and that DK derivation matches).
  try {
    const ok = await aesUnwrap(dk, meta.check, AAD_CHECK);
    if (ok.length !== 2 || ok[0] !== 0x6f || ok[1] !== 0x6b) throw new Error('check');
  } catch { throw new LockMetaError('check value'); }
  // pubMac binds `pub` to the key hierarchy: replacing pub in IDB is detected at the next unlock.
  const macOk = await subtle().verify('HMAC', hk, meta.pubMac, meta.pub);
  if (!macOk) throw new PubTamperedError();
  let sk;
  try {
    const pkcs8 = await aesUnwrap(pkey, meta.priv, AAD_PRIV);
    sk = await subtle().importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    wipe(pkcs8);
  } catch { throw new LockMetaError('private key wrapper'); }
  return makeKeys({ dk, hk, xk, sk, pub: meta.pub });
}

function makeKeys({ dk, hk, xk, sk, pub }) {
  return {
    dk, hk, xk, sk, pub,
    /** writer for DK-encrypted records (items, groups, categories, settings, jobs, vault). */
    writer: () => ({ k: 0, key: dk, hk }),
    /** writer for XK-encrypted records (favicons). */
    xWriter: () => ({ k: 0, key: xk, hk }),
    /** reader for decoding; `batch(kid)` resolves inbox keys (see inbox.makeBatchResolver). */
    reader: (batch, lang) => ({ dk, xk, hk, batch, lang }),
  };
}

async function wrapAll(mk, { password, iter, recBytes }) {
  const salt = newSalt();
  const kek = await deriveKekPw(password, salt, iter);
  const pw = { kdf: 'PBKDF2-SHA256', iter, salt, ...(await aesWrap(kek, mk, AAD_MK_PW)) };
  const rec = recBytes ? await aesWrap(await recoveryKek(recBytes), mk, AAD_MK_REC) : null;
  return { pw, rec };
}

/**
 * First-time setup (runs in the SW). Returns { meta, mk, keys, recoveryKey }.
 * The caller persists `meta` (meta store, key 'lock'), then saveSession(store, mk) and wipes `mk`.
 * `recoveryKey` (text) must be shown to the user once and then dropped.
 */
export async function setupLock({ password, withRecovery = true, iter = PBKDF2_ITER, state = 'migrating' }) {
  const mk = randomBytes(32);
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey)); // 65 bytes, uncompressed
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  const base = await hkdfBase(mk);
  const [dk, hk, pkey] = await Promise.all([
    hkdfAesKey(base, 'cmr-dk-v1'), hkdfHmacKey(base, 'cmr-hk-v1'), hkdfAesKey(base, 'cmr-priv-v1')]);
  const priv = await aesWrap(pkey, pkcs8, AAD_PRIV);
  wipe(pkcs8);
  const pubMac = new Uint8Array(await subtle().sign('HMAC', hk, pub));
  const check = await aesWrap(dk, utf8('ok'), AAD_CHECK);
  const recovery = withRecovery ? await generateRecoveryKey() : null;
  const { pw, rec } = await wrapAll(mk, { password, iter, recBytes: recovery && recovery.bytes });
  const meta = { k: 'lock', v: 1, state, pub, pw, rec, priv, pubMac, check };
  const keys = await deriveKeys(mk, meta); // same path as unlock: proves the record round-trips
  if (recovery) wipe(recovery.bytes);
  return { meta, mk, keys, recoveryKey: recovery ? recovery.text : null };
}

/** Unlock with the password. Throws WrongPasswordError (counts as a failure) or PubTamperedError/LockMetaError. */
export async function unlockWithPassword(meta, password) {
  if (!meta || !meta.pw) throw new LockMetaError('missing pw wrapper');
  const kek = await deriveKekPw(password, meta.pw.salt, meta.pw.iter);
  let mk;
  try { mk = await aesUnwrap(kek, meta.pw, AAD_MK_PW); } catch { throw new WrongPasswordError(); }
  const keys = await deriveKeys(mk, meta);
  return { keys, mk };
}

/**
 * Unlock with the recovery key text. The caller MUST then force a new password via completeRecoveryUnlock
 * (needsNewPassword === true): a lost password is replaced, otherwise the user would be locked out again.
 */
export async function unlockWithRecovery(meta, recoveryText) {
  if (!meta || !meta.rec) throw new NoRecoveryKeyError();
  const parsed = await parseRecoveryKey(recoveryText);
  if (!parsed.ok) throw new RecoveryFormatError(parsed.reason);
  let mk;
  try { mk = await aesUnwrap(await recoveryKek(parsed.bytes), meta.rec, AAD_MK_REC); } catch { throw new WrongRecoveryKeyError(); }
  wipe(parsed.bytes);
  const keys = await deriveKeys(mk, meta);
  return { keys, mk, needsNewPassword: true };
}

/** Replace the password wrapper (O(1), no data re-encryption). Used by change-password and after recovery unlock. */
export async function rewrapPassword(meta, mk, newPassword, iter = PBKDF2_ITER) {
  const { pw } = await wrapAll(mk, { password: newPassword, iter, recBytes: null });
  return { ...meta, pw };
}
export const completeRecoveryUnlock = rewrapPassword;

/** Change password: verifies the old one, then rewraps MK under the new KEK. Old password stops working. */
export async function changePassword(meta, oldPassword, newPassword, iter = meta.pw.iter) {
  const { mk, keys } = await unlockWithAnyPassword(meta, oldPassword);
  const next = await rewrapPassword(meta, mk, newPassword, iter);
  return { meta: next, mk, keys };
}

/** Replace the recovery key (requires the password). The old recovery key stops working. */
export async function newRecoveryKey(meta, password) {
  const { mk, keys } = await unlockWithAnyPassword(meta, password);
  const rec = await generateRecoveryKey();
  const wrapped = await aesWrap(await recoveryKek(rec.bytes), mk, AAD_MK_REC);
  wipe(rec.bytes);
  return { meta: { ...meta, rec: wrapped }, recoveryKey: rec.text, mk, keys };
}
export const withoutRecovery = (meta) => ({ ...meta, rec: null });

// ---------- extra unlock slots (meta.slots): more wrappers of the SAME master key ----------
//   { id, kind:'pw',  name, ts, kdf, iter, salt, iv, ct }          KEK = PBKDF2(backup password)         ("backup password")
//   { id, kind:'prf', name, ts, cid, psalt, iv, ct }               KEK = HKDF(WebAuthn PRF output)       (passkey / security key)
// MK itself never changes, so slots survive a change of the main password, a new recovery key and a recovery unlock (those only
// replace pw / rec and spread the rest of meta). Removing a slot deletes its wrapper: the secret then opens nothing.
// The wrapper's AAD binds kind + id, so a wrapper cannot be moved to another slot. Nothing secret is stored: the backup password
// and the PRF output exist only in the call.
export const MAX_PRF_SLOTS = 3;
const AAD_SLOT = (kind, id) => utf8(`cmr|mk|slot|${kind}|${id}`);
export const slotsOf = (meta) => (Array.isArray(meta && meta.slots) ? meta.slots : []);
const newSlotId = () => toHex(randomBytes(6));
const prfKek = async (prf, id) => hkdfAesKey(await hkdfBase(prf), 'cmr-prf-slot-v1|' + id);

/** Safe to show to pages and to put in lock.status: ids, names and the public WebAuthn parameters, never a wrapper. */
export const publicSlots = (meta) => slotsOf(meta).map((s) => ({
  id: s.id, kind: s.kind, name: s.name || '', ts: s.ts || 0,
  ...(s.kind === 'prf' ? { cid: b64enc(s.cid), psalt: b64enc(s.psalt) } : {}),
}));

/** Add THE backup password (one at most). Throws SlotError('exists'|'same'). The caller has already checked the current unlock. */
export async function addPasswordSlot(meta, mk, backupPassword, { name = '', iter = PBKDF2_ITER } = {}) {
  if (slotsOf(meta).some((s) => s.kind === 'pw')) throw new SlotError('exists');
  if (typeof backupPassword !== 'string' || !backupPassword) throw new SlotError('badInput');
  let same = false;
  try { await unlockWithPassword(meta, backupPassword); same = true; } catch (e) { if (!(e instanceof WrongPasswordError)) throw e; }
  if (same) throw new SlotError('same');
  const id = newSlotId();
  const salt = newSalt();
  const kek = await deriveKekPw(backupPassword, salt, iter);
  const slot = { id, kind: 'pw', name, ts: Date.now(), kdf: 'PBKDF2-SHA256', iter, salt, ...(await aesWrap(kek, mk, AAD_SLOT('pw', id))) };
  return { ...meta, slots: [...slotsOf(meta), slot] };
}

/** Add a passkey / security key slot. prf = the 32-byte PRF output for psalt from credential cid. */
export async function addPrfSlot(meta, mk, { cid, psalt, prf, name = '' }) {
  if (!(cid instanceof Uint8Array) || cid.length < 16 || cid.length > 1023 || !(psalt instanceof Uint8Array) || psalt.length !== 32 || !(prf instanceof Uint8Array) || prf.length !== 32) throw new SlotError('badInput');
  if (slotsOf(meta).filter((s) => s.kind === 'prf').length >= MAX_PRF_SLOTS) throw new SlotError('max');
  if (slotsOf(meta).some((s) => s.kind === 'prf' && bytesEqual(s.cid, cid))) throw new SlotError('exists');
  const id = newSlotId();
  const slot = { id, kind: 'prf', name: String(name || '').slice(0, 60), ts: Date.now(), cid, psalt, ...(await aesWrap(await prfKek(prf, id), mk, AAD_SLOT('prf', id))) };
  return { ...meta, slots: [...slotsOf(meta), slot] };
}

export function removeSlot(meta, id) {
  const slots = slotsOf(meta);
  if (!slots.some((s) => s.id === id)) throw new NoSlotError();
  return { ...meta, slots: slots.filter((s) => s.id !== id) };
}

/** Unlock with the backup password (counts as a failure when wrong). */
export async function unlockWithBackupPassword(meta, password) {
  const list = slotsOf(meta).filter((s) => s.kind === 'pw');
  if (!list.length) throw new NoSlotError();
  for (const s of list) {
    let mk = null;
    try { mk = await aesUnwrap(await deriveKekPw(String(password || ''), s.salt, s.iter), s, AAD_SLOT('pw', s.id)); } catch { continue; }
    const keys = await deriveKeys(mk, meta);
    return { keys, mk, slotId: s.id };
  }
  throw new WrongBackupPasswordError();
}

/** Unlock with a passkey slot: prf is the PRF output the page got from the authenticator. */
export async function unlockWithSlot(meta, id, prf) {
  const s = slotsOf(meta).find((x) => x.id === id && x.kind === 'prf');
  if (!s) throw new NoSlotError();
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new WrongSlotError();
  let mk;
  try { mk = await aesUnwrap(await prfKek(prf, s.id), s, AAD_SLOT('prf', s.id)); } catch { throw new WrongSlotError(); }
  const keys = await deriveKeys(mk, meta);
  return { keys, mk, slotId: s.id };
}

/** For actions that ask "the current password": the main password or, when that is forgotten, the backup password. */
export async function unlockWithAnyPassword(meta, password) {
  try { return await unlockWithPassword(meta, password); } catch (e) {
    if (!(e instanceof WrongPasswordError) || !slotsOf(meta).some((s) => s.kind === 'pw')) throw e;
    try { return await unlockWithBackupPassword(meta, password); } catch (e2) { if (e2 instanceof WrongBackupPasswordError) throw new WrongPasswordError(); throw e2; }
  }
}

// ---------- session (unlocked key lives in chrome.storage.session; adapter injected) ----------
// adapter = { get(key) -> value|undefined, set(key, value), remove(key) }   (all async)
// chrome.storage.session binding: get: async (k) => (await chrome.storage.session.get(k))[k]
export const SESSION_KEY = 'cmrKey';

export async function saveSession(adapter, mk, now = Date.now()) {
  await adapter.set(SESSION_KEY, { mk: b64enc(mk), unlockedAt: now, lastTouch: now });
}
export const readSession = async (adapter) => (await adapter.get(SESSION_KEY)) || null;
export async function touchSession(adapter, now = Date.now()) {
  const s = await readSession(adapter);
  if (!s) return false;
  await adapter.set(SESSION_KEY, { ...s, lastTouch: now });
  return true;
}
export const clearSession = (adapter) => adapter.remove(SESSION_KEY);

/** Import non-extractable keys from the stored MK (done on every SW/page wake). null = locked. */
export async function keysFromSession(adapter, meta) {
  const s = await readSession(adapter);
  if (!s || typeof s.mk !== 'string') return null;
  const mk = b64dec(s.mk);
  try { return await deriveKeys(mk, meta); } finally { wipe(mk); }
}

/**
 * Per-context cache (SW, page, worker): holds the imported keys in a module variable between calls.
 * `ensure(meta)` re-checks the shared session so a lock performed elsewhere takes effect at once.
 * Any doubt (missing/invalid session, failed derive) is treated as locked.
 */
export class LockSession {
  constructor(adapter) { this.adapter = adapter; this._keys = null; this._stamp = null; }
  get keys() { return this._keys; }
  async ensure(meta) {
    const s = await readSession(this.adapter);
    if (!s) { this._keys = null; this._stamp = null; return null; }
    if (this._keys && this._stamp === s.unlockedAt) return this._keys;
    try { this._keys = await keysFromSession(this.adapter, meta); this._stamp = s.unlockedAt; } catch { this._keys = null; this._stamp = null; }
    return this._keys;
  }
  /** After an unlock or setup: persist MK to the session store and cache the keys. Wipes `mk`. */
  async unlocked(keys, mk, now = Date.now()) {
    await saveSession(this.adapter, mk, now);
    wipe(mk);
    this._keys = keys; this._stamp = now;
  }
  touch(now = Date.now()) { return touchSession(this.adapter, now); }
  /** Lock: remove cmrKey and drop cached keys (callers then broadcast lock.state, rebuild menus, pause sync). */
  async lock() { this._keys = null; this._stamp = null; await clearSession(this.adapter); }
}

export { bytesEqual };
