// Record encode/decode for encryption at rest (spec §2 "Record format", §1/§5 field split).
//
// Encrypted record = plaintext metadata fields + `k` + `e`.
//   k : 0 = master data key (DK; XK for favicons), n>0 = inbox batch key (ekeys row kid n)
//   e : Uint8Array [0x01 version][12B random IV][AES-GCM ciphertext+tag]
//   payload = UTF-8 JSON padded with spaces to a multiple of 32 bytes (hides exact title/URL length)
//   AAD = "cmr|1|" + logicalId + "|" + k
//
// Why the AAD matters: it binds each ciphertext to ONE logical record and ONE key id. Swapping the `e` of two rows,
// or rewriting `k`, makes GCM authentication fail, so tampering shows up as a damaged item instead of wrong data.
// Rollback to an older valid ciphertext of the SAME record is not detectable (documented limitation, spec §1).
//
// Records without `k` are legacy plaintext and are accepted forever by every decoder.
import { utf8, fromUtf8, concat, b64enc, b64dec, b64uEnc, subtle } from './bytes.js';
import { CORRUPT_SENTINEL } from './strings.js';

export const VERSION = 1;
export const SLICE = 256; // Promise.all fan-out limit for batched crypto

export class LockedError extends Error {
  constructor(msg = 'locked') { super(msg); this.name = 'LockedError'; }
}
/** A record failed authentication / is malformed. Decoders convert this into a sentinel; strict callers see it. */
export class CorruptRecordError extends Error {
  constructor(reason, id) { super(`corrupt record (${reason})${id ? ' ' + id : ''}`); this.name = 'CorruptRecordError'; this.reason = reason; this.id = id; }
}

// ---------- field schema (single source of truth; the integrator must audit these against db.js) ----------
// Items use a WHITELIST for plaintext: any field not listed (url, title, notes, future fields...) is encrypted.
// Safe default: a new sensitive field can never leak by accident.
export const PLAIN_ITEM = new Set(['g', 'seq', 'ts', 'del', 'tg', 'w', 'iid']);
export const DROP_ITEM = new Set(['t', 'tk']); // search text / title sort key: live only in the worker's memory
export const ENC_GROUP = new Set(['title', 'note', 'agg', 'tgLayout', 'tabGroups', 'color', 'emoji']); // set look (colour label + emoji) is encrypted with the lock on; tabGroups carries tab-group titles in db.js
export const ENC_CATEGORY = new Set(['name']);
export const PLAIN_SNAPSHOT = new Set(['id', 'ts', 'nTabs', 'nWin', 'kind', 'tabCount', 'windowCount', 'degraded']); // header (counts + kind) stays readable while locked (banner, retention)
export const ENC_JOB = new Set(['payload']);

// ---------- low level ----------
const AAD = (id, k) => utf8('cmr|' + VERSION + '|' + id + '|' + k);

function pad32(bytes) {
  const n = (bytes.length + 31) & ~31;
  if (n === bytes.length) return bytes;
  const out = new Uint8Array(n);
  out.set(bytes);
  out.fill(0x20, bytes.length); // spaces: harmless trailing whitespace for JSON.parse
  return out;
}

/** Encrypt raw bytes. Fresh random 96-bit IV every call (never a counter). */
export async function sealBytes(key, k, id, plain) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD(id, k) }, key, plain));
  const e = new Uint8Array(13 + ct.length);
  e[0] = VERSION; e.set(iv, 1); e.set(ct, 13);
  return e;
}
export async function openBytes(key, k, id, e) {
  if (!(e instanceof Uint8Array) || e.length < 13 + 16 || e[0] !== VERSION) throw new CorruptRecordError('format', id);
  try {
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: e.subarray(1, 13), additionalData: AAD(id, k) }, key, e.subarray(13)));
  } catch { throw new CorruptRecordError('auth', id); }
}
export const sealJson = (key, k, id, obj) => sealBytes(key, k, id, pad32(utf8(JSON.stringify(obj))));
export async function openJson(key, k, id, e) {
  const bytes = await openBytes(key, k, id, e);
  try { return JSON.parse(fromUtf8(bytes)); } catch { throw new CorruptRecordError('json', id); }
}

/** 'legacy' (no k: plaintext, accepted forever) | 'enc' | 'bad' (k present but nonsense / e missing). */
export function classify(rec, binary = true) {
  if (!rec || typeof rec !== 'object' || rec.k === undefined) return 'legacy';
  if (!Number.isInteger(rec.k) || rec.k < 0) return 'bad';
  const okE = binary ? rec.e instanceof Uint8Array : typeof rec.e === 'string';
  return okE ? 'enc' : 'bad';
}
export const isEncrypted = (rec) => classify(rec) === 'enc' || classify(rec, false) === 'enc';

// ---------- writers / readers ----------
// writer = { k, key, hk? }        k=0 -> DK (unlocked), k>0 -> inbox batch key. `hk` only when unlocked (tokens).
// reader = { dk, xk, hk?, batch?(kid)->CryptoKey|null, lang? }   what a page/worker/SW holds after unlock.
function readKey(reader, slot, k, id) {
  if (k === 0) {
    const key = reader && reader[slot];
    if (!key) throw new LockedError('key not available: ' + slot);
    return key;
  }
  return null; // batch key resolved async by caller
}
async function resolveKey(reader, slot, k, id) {
  const key = readKey(reader, slot, k, id);
  if (key) return key;
  const bk = reader && reader.batch ? await reader.batch(k) : null;
  if (!bk) throw new CorruptRecordError('no-key', id); // ekeys row lost -> unrecoverable
  return bk;
}

// ---------- blind tokens ----------
// Deterministic (needed for index lookups / dedup) but keyed: without HK an attacker cannot confirm a guessed host.
// Leaks only equality ("these items share a site"), never the hostname.
const tokenCache = new WeakMap(); // hk -> Map(host -> token); one HMAC per unique host per session
async function hmac(hk, msg) { return new Uint8Array(await subtle().sign('HMAC', hk, utf8(msg))); }

export async function siteToken(hk, host) {
  let m = tokenCache.get(hk);
  if (!m) tokenCache.set(hk, (m = new Map()));
  let t = m.get(host);
  if (t === undefined) {
    t = '~' + b64uEnc(await hmac(hk, 's|' + host)).slice(0, 22);
    if (m.size > 50000) m.clear();
    m.set(host, t);
  }
  return t;
}
export async function uhToken(hk, normUrl) {
  return '~' + b64uEnc((await hmac(hk, 'u|' + normUrl)).subarray(0, 16));
}
export const isToken = (s) => typeof s === 'string' && s.charCodeAt(0) === 126; // '~'
/** Default URL normalisation for the uh token. The integrator should inject the same function db.js uses for dedup. */
export const defaultNormUrl = (u) => { const i = u.indexOf('#'); return i < 0 ? u : u.slice(0, i); };

// ---------- generic split/encode/decode ----------
function splitBy(rec, pred) { // pred(field)=true -> secret
  const plain = {}, secret = {};
  for (const f of Object.keys(rec)) (pred(f) ? secret : plain)[f] = rec[f];
  return { plain, secret };
}
function corruptView(plain, sentinelFields, lang) {
  const o = { ...plain, corrupt: true };
  for (const [f, v] of Object.entries(sentinelFields)) o[f] = v === '$S' ? CORRUPT_SENTINEL : v;
  return o;
}

async function encodeGeneric(rec, writer, id, pred) {
  const { plain, secret } = splitBy(rec, pred);
  plain.e = await sealJson(writer.key, writer.k, id, secret);
  plain.k = writer.k;
  return plain;
}
async function decodeGeneric(rec, reader, { slot = 'dk', idOf, sentinel, strict }) {
  const cls = classify(rec);
  if (cls === 'legacy') return rec;
  const id = idOf(rec);
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, slot, rec.k, id);
    const secret = await openJson(key, rec.k, id, rec.e);
    const { k, e, ...plain } = rec;
    return { ...plain, ...secret };
  } catch (err) {
    if (!(err instanceof CorruptRecordError) || strict) throw err; // LockedError always propagates
    const { k, e, ...plain } = rec;
    return corruptView(plain, sentinel, reader && reader.lang);
  }
}

// ---------- items ----------
export const itemId = (r) => `item:${r.g}:${r.seq}`;

/** Plain item -> stored record. Tokens are written only when writer.hk exists (unlocked); inbox rows get them at seal. */
export async function encodeItem(rec, writer, opts = {}) {
  if (!(typeof rec.g === 'string' ? rec.g.length > 0 : Number.isFinite(rec.g)) || !Number.isFinite(rec.seq)) throw new TypeError('item needs a group id (string or number) and a numeric seq');
  const plain = {}, secret = {};
  for (const f of Object.keys(rec)) {
    if (DROP_ITEM.has(f)) continue;
    (PLAIN_ITEM.has(f) ? plain : secret)[f] = rec[f];
  }
  // tokens (HMAC) and payload encryption are independent: run them concurrently
  const jobs = [sealJson(writer.key, writer.k, itemId(rec), secret)];
  if (writer.hk) {
    if (typeof rec.site === 'string' && rec.site) jobs.push(siteToken(writer.hk, rec.site).then((t) => { plain.site = t; }));
    if (typeof rec.url === 'string') jobs.push(uhToken(writer.hk, (opts.normUrl || defaultNormUrl)(rec.url)).then((t) => { plain.uh = t; }));
  }
  plain.e = (await Promise.all(jobs))[0];
  plain.k = writer.k;
  return plain;
}
/** Stored record -> plain item shape (url/title/site/uh restored from payload). Never throws on corruption. */
export async function decodeItem(rec, reader, opts = {}) {
  const cls = classify(rec);
  if (cls === 'legacy') return rec;
  const id = itemId(rec);
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, 'dk', rec.k, id);
    const secret = await openJson(key, rec.k, id, rec.e);
    const { k, e, site, uh, ...plain } = rec; // plaintext site/uh are tokens: the payload carries the originals
    return { ...plain, ...secret };
  } catch (err) {
    if (!(err instanceof CorruptRecordError) || opts.strict) throw err;
    const { k, e, site, uh, ...plain } = rec;
    return corruptView(plain, { title: '$S', url: '', site: '' });
  }
}

// ---------- trash (rows embed items; items keep their own ciphertext so moving needs no re-encryption) ----------
export async function encodeTrashRow(row, writer, opts) {
  const items = await mapSlices(row.items || [], (it) => (isEncrypted(it) ? it : encodeItem(it, writer, opts)));
  return { ...row, items };
}
export async function decodeTrashRow(row, reader, opts) {
  const items = await mapSlices(row.items || [], (it) => decodeItem(it, reader, opts));
  return { ...row, items };
}
export const trashRowEncrypted = (row) => (row.items || []).every((it) => classify(it) !== 'legacy');

// ---------- groups / categories / snapshots / jobs ----------
export const groupId = (r) => `group:${r.id}`;
export const encodeGroup = (rec, writer) => encodeGeneric(rec, writer, groupId(rec), (f) => ENC_GROUP.has(f));
export const decodeGroup = (rec, reader, opts = {}) => decodeGeneric(rec, reader,
  { idOf: groupId, sentinel: { title: '$S' }, strict: opts.strict });

export const catId = (r) => `cat:${r.id}`;
export const encodeCategory = (rec, writer) => encodeGeneric(rec, writer, catId(rec), (f) => ENC_CATEGORY.has(f));
export const decodeCategory = (rec, reader, opts = {}) => decodeGeneric(rec, reader,
  { idOf: catId, sentinel: { name: '$S' }, strict: opts.strict });

// Snapshot: header {id, ts, nTabs, nWin} plaintext; the tab list is encrypted. Callers use an inbox writer (spec §2).
export const snapId = (r) => `snap:${r.id}`;
export const encodeSnapshot = (rec, writer) => encodeGeneric(rec, writer, snapId(rec), (f) => !PLAIN_SNAPSHOT.has(f));
export const decodeSnapshot = (rec, reader, opts = {}) => decodeGeneric(rec, reader,
  { idOf: snapId, sentinel: {}, strict: opts.strict });

export const jobId = (r) => `job:${r.id}`;
export const encodeJob = (rec, writer) => encodeGeneric(rec, writer, jobId(rec), (f) => ENC_JOB.has(f));
export const decodeJob = (rec, reader, opts = {}) => decodeGeneric(rec, reader,
  { idOf: jobId, sentinel: { payload: null }, strict: opts.strict });

// ---------- sites (rows keyed by blind token; `e` carries {host} so the UI can show names) ----------
/** plain row {site: host, n, ...} -> {site: token, n, ..., k, e}. Needs hk (unlocked). */
export async function encodeSiteRow(row, writer) {
  if (!writer.hk) throw new LockedError('site rows need HK');
  const token = isToken(row.site) ? row.site : await siteToken(writer.hk, row.site);
  const { site, ...rest } = row;
  return { ...rest, site: token, e: await sealJson(writer.key, writer.k, 'site:' + token, { host: site }), k: writer.k };
}
export async function decodeSiteRow(row, reader, opts = {}) {
  const cls = classify(row);
  if (cls === 'legacy') return row;
  const id = 'site:' + row.site;
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, 'dk', row.k, id);
    const { host } = await openJson(key, row.k, id, row.e);
    const { k, e, ...rest } = row;
    return { ...rest, token: row.site, site: host };
  } catch (err) {
    if (!(err instanceof CorruptRecordError) || opts.strict) throw err;
    const { k, e, ...rest } = row;
    return { ...rest, token: row.site, site: CORRUPT_SENTINEL, corrupt: true };
  }
}
/** siteIdx rows are keyed by (site,g): only the site part is rekeyed to the token; counts stay plaintext. */
export async function tokenizeSiteIdx(row, hk) {
  return isToken(row.site) ? row : { ...row, site: await siteToken(hk, row.site) };
}

// ---------- favicons (XK; keyed by host token; no favicon fetching while locked) ----------
export async function encodeFavicon(row, writer) {
  if (!writer.hk) throw new LockedError('favicon rows need HK');
  const token = isToken(row.site) ? row.site : await siteToken(writer.hk, row.site);
  // host is kept inside the payload: tokens are one-way, so revert needs it to restore the plaintext key
  const { site, ...rest } = row;
  return { site: token, e: await sealJson(writer.key, writer.k, 'fav:' + token, { ...rest, host: site }), k: writer.k };
}
export async function decodeFavicon(row, reader, opts = {}) {
  const cls = classify(row);
  if (cls === 'legacy') return row;
  const id = 'fav:' + row.site;
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, 'xk', row.k, id);
    const { host, ...rest } = await openJson(key, row.k, id, row.e);
    return { ...rest, site: host, token: row.site };
  } catch (err) {
    if (!(err instanceof CorruptRecordError) || opts.strict) throw err;
    return { site: row.site, token: row.site, corrupt: true };
  }
}

// ---------- vault entry (storage.local: gzip, then encrypt, stored as base64 string) ----------
async function gz(bytes, kind) {
  const S = kind === 'gzip' ? CompressionStream : DecompressionStream;
  const stream = new Blob([bytes]).stream().pipeThrough(new S('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export const vaultLogicalId = (id) => `vault:${id}`;
/** obj = the vault copy of one group (any JSON). Compress first: ciphertext does not compress. */
export async function encodeVault(id, obj, writer) {
  const z = await gz(utf8(JSON.stringify(obj)), 'gzip');
  const body = new Uint8Array(4 + z.length);
  new DataView(body.buffer).setUint32(0, z.length); // length prefix so zero padding can be stripped
  body.set(z, 4);
  const n = (body.length + 31) & ~31;
  const padded = new Uint8Array(n); padded.set(body);
  const e = await sealBytes(writer.key, writer.k, vaultLogicalId(id), padded);
  return { id, k: writer.k, e: b64enc(e) };
}
export async function decodeVault(row, reader, opts = {}) {
  const cls = classify(row, false);
  if (cls === 'legacy') return row; // legacy shape: caller handles its own plaintext vault format
  const id = vaultLogicalId(row.id);
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, 'dk', row.k, id);
    const body = await openBytes(key, row.k, id, b64dec(row.e));
    const len = new DataView(body.buffer, body.byteOffset).getUint32(0);
    if (len > body.length - 4) throw new CorruptRecordError('format', id);
    return { id: row.id, data: JSON.parse(fromUtf8(await gz(body.subarray(4, 4 + len), 'gunzip'))) };
  } catch (err) {
    if (err instanceof LockedError) throw err;
    if (opts.strict) throw err instanceof CorruptRecordError ? err : new CorruptRecordError('format', id);
    return { id: row.id, corrupt: true, data: null };
  }
}

// ---------- sensitive settings (excludeSites / whitelist / autoRules) ----------
export async function encodeSetting(name, value, writer) {
  return { name, k: writer.k, e: await sealJson(writer.key, writer.k, 'set:' + name, { v: value }) };
}
export async function decodeSetting(row, reader, opts = {}) {
  const cls = classify(row);
  if (cls === 'legacy') return row;
  const id = 'set:' + row.name;
  try {
    if (cls === 'bad') throw new CorruptRecordError('format', id);
    const key = await resolveKey(reader, 'dk', row.k, id);
    return { name: row.name, value: (await openJson(key, row.k, id, row.e)).v };
  } catch (err) {
    if (!(err instanceof CorruptRecordError) || opts.strict) throw err;
    return { name: row.name, value: undefined, corrupt: true };
  }
}
/**
 * Stash-time match set for excludeSites while locked (spec §5): SHA-256(publicSalt + host) truncated to 12 bytes,
 * for the host and each parent domain. Dictionary-guessable for common hosts (documented in the spec).
 */
export async function matchHashes(publicSalt, host) {
  const labels = String(host).toLowerCase().split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const h = new Uint8Array(await subtle().digest('SHA-256', concat(publicSalt, utf8(labels.slice(i).join('.')))));
    out.push(b64uEnc(h.subarray(0, 12)));
  }
  return out;
}

// ---------- job payloads / generic secret blob (sync caches, sync passphrase cache) ----------
export async function encodeBlob(logicalId, obj, writer) {
  return { k: writer.k, e: await sealJson(writer.key, writer.k, logicalId, obj) };
}
export async function decodeBlob(logicalId, rec, reader, slot = 'dk') {
  const key = await resolveKey(reader, slot, rec.k, logicalId);
  return openJson(key, rec.k, logicalId, rec.e);
}

// ---------- batching ----------
/** map with at most `size` concurrent crypto calls (Promise.all in slices; keeps the event loop responsive). */
export async function mapSlices(arr, fn, size = SLICE) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i += size) {
    const end = Math.min(i + size, arr.length);
    const part = await Promise.all(arr.slice(i, end).map((x, j) => fn(x, i + j)));
    for (let j = 0; j < part.length; j++) out[i + j] = part[j];
  }
  return out;
}
export const encryptItems = (recs, writer, opts) => mapSlices(recs, (r) => encodeItem(r, writer, opts));
export const decryptItems = (recs, reader, opts) => mapSlices(recs, (r) => decodeItem(r, reader, opts));
export const encryptMany = (fn, recs, writer, ...rest) => mapSlices(recs, (r) => fn(r, writer, ...rest));
export const decryptMany = (fn, recs, reader, ...rest) => mapSlices(recs, (r) => fn(r, reader, ...rest));
