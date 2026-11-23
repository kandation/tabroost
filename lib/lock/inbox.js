// Inbox: encrypting while LOCKED (spec §2). Only the PUBLIC key is needed.
//
// Per batch: ephemeral ECDH keypair e; Z = ECDH(e.priv, PK); BK = HKDF(Z, salt, "cmr-inbox-v1|"+kid) -> AES-GCM.
// The ekeys row {kid, epk, salt, ts} is written in the SAME transaction as the batch rows. e.priv is never exported
// and is dropped as soon as BK is derived: after a SW kill the rows stay recoverable from epk + SK (after unlock),
// and the next attempt simply uses a fresh batch key.
import { utf8, concat, b64enc, bytesEqual, randomBytes, subtle } from './bytes.js';
import { hkdfBase, hkdfAesKey } from './kdf.js';
import { encodeItem, decodeItem, encodeSnapshot, mapSlices } from './rec.js';

const INFO = (kid) => 'cmr-inbox-v1|' + kid;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };

async function bkFrom(privKey, pubKey, salt, kid) {
  const z = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256));
  const base = await hkdfBase(z);
  z.fill(0);
  return hkdfAesKey(base, INFO(kid), salt);
}

/** New batch key for `kid` (kid >= 1; kid 0 means DK). Returns { kid, key (BK), row (ekeys row) , writer }. */
export async function createBatchKey(pubRaw, kid, now = Date.now()) {
  if (!Number.isInteger(kid) || kid < 1) throw new RangeError('inbox kid must be an integer >= 1');
  const pk = await subtle().importKey('raw', pubRaw, P256, false, []);
  const e = await subtle().generateKey(P256, true, ['deriveBits']);
  const epk = new Uint8Array(await subtle().exportKey('raw', e.publicKey));
  const salt = randomBytes(16);
  const key = await bkFrom(e.privateKey, pk, salt, kid);
  return { kid, key, row: { kid, epk, salt, ts: now }, writer: { k: kid, key } }; // no hk: tokens are added at seal
}

/** Recover BK from an ekeys row with the private key SK (only possible after unlock). */
export async function recoverBatchKey(row, sk) {
  const epk = await subtle().importKey('raw', row.epk, P256, false, []);
  const z = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: epk }, sk, 256));
  const base = await hkdfBase(z);
  z.fill(0);
  return hkdfAesKey(base, INFO(row.kid), row.salt);
}

/**
 * reader.batch resolver: kid -> BK (cached). `lookup(kid)` fetches the ekeys row (IDB get in the integrator).
 * Returns null when the row is missing (record then decodes as damaged).
 */
export function makeBatchResolver(sk, lookup) {
  const cache = new Map(); // kid -> Promise<CryptoKey|null>; caching the PROMISE means 200 parallel decodes do ONE ECDH
  return (kid) => {
    let p = cache.get(kid);
    if (!p) {
      p = (async () => { const row = await lookup(kid); return row ? recoverBatchKey(row, sk) : null; })();
      cache.set(kid, p);
    }
    return p;
  };
}

// ---------- digest (verify while locked) ----------
/** SHA-256 over all `e` bytes in seq order. Computed BEFORE the write, recomputed from the read-back rows. */
export async function digestOf(records) {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  return b64enc(new Uint8Array(await subtle().digest('SHA-256', concat(...sorted.map((r) => r.e)))));
}
/** Read-back check: count AND digest must match, otherwise the tabs must stay open. */
export async function verifyDigest(records, count, digest) {
  if (!Array.isArray(records) || records.length !== count) return { ok: false, reason: 'count' };
  if (records.some((r) => !(r.e instanceof Uint8Array))) return { ok: false, reason: 'format' };
  return (await digestOf(records)) === digest ? { ok: true } : { ok: false, reason: 'digest' };
}

/**
 * Encrypt a batch of plain items with only the public key.
 * items: [{g, seq, url, title, ts, ...}] with seq already assigned.
 * -> { ekey (row to put in `ekeys`), records (rows for `items`), journal {g, seqFrom, seqTo, count, digest, kid} }
 * The caller writes ekey + records in ONE transaction, then read-backs and verifyDigest()s before closing tabs.
 */
export async function encryptBatchWhileLocked({ pub, kid, items, now = Date.now(), opts }) {
  if (!items.length) throw new RangeError('empty batch');
  const bk = await createBatchKey(pub, kid, now);
  const records = await mapSlices(items, (it) => encodeItem(it, bk.writer, opts));
  const seqs = records.map((r) => r.seq);
  const journal = {
    g: records[0].g, seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs), count: records.length,
    digest: await digestOf(records), kid,
  };
  return { ekey: bk.row, records, journal };
}

/** Snapshots always use the inbox path, even when unlocked (one code path). */
export async function encryptSnapshotViaInbox({ pub, kid, snapshot, now = Date.now() }) {
  const bk = await createBatchKey(pub, kid, now);
  return { ekey: bk.row, record: await encodeSnapshot(snapshot, bk.writer) };
}

/** Decrypt inbox rows (k > 0) with SK. Used by the seal job; damaged rows come back with corrupt:true. */
export async function decryptInboxRows(records, sk, lookup) {
  const reader = { dk: null, xk: null, batch: makeBatchResolver(sk, lookup) };
  return mapSlices(records, (r) => decodeItem(r, reader));
}

export { bytesEqual, utf8 };
