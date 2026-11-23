// Runtime glue of the password lock (spec docs/spec-password-lock.md). Used by the service worker, the list page, the popup and
// (with injected keys) the search worker. The pure crypto lives in lib/lock/*; this module owns:
//   - the cached `meta.lock` row and the unlocked key set (non-extractable CryptoKeys, imported from chrome.storage.session `cmrKey`)
//   - the DECODERS that db.js calls on every read path (legacy plaintext rows pass through unchanged, forever)
// With the lock OFF nothing here is installed (db.setCodec(null)), so every read path costs one null check.
import * as db from './db.js';
import { LockSession, SESSION_KEY } from './lock/keys.js';
import { makeBatchResolver } from './lock/inbox.js';
import * as rec from './lock/rec.js';
import { LockedError } from './lock/rec.js';
import { b64enc, b64dec } from './lock/bytes.js';

export { LockedError, SESSION_KEY };

let session = null; // LockSession over chrome.storage.session (SW, pages); null in workers
let lockMeta = null; // meta.lock row of IDB (Uint8Array fields) or null = lock never enabled
let injected = null; // keys handed in by postMessage (search worker)
let keys = null;
let reader = null;
let readerFor = null;
let lang = 'th';
const listeners = new Set();

const sessionAdapter = () => ({
  get: async (k) => (await chrome.storage.session.get(k))[k],
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
  remove: (k) => chrome.storage.session.remove(k),
});

/** Call once per context. `useSession:false` for workers that receive keys with setKeys(). */
export async function init({ useSession = true, language } = {}) {
  if (language) lang = language;
  if (useSession && !session && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) session = new LockSession(sessionAdapter());
  return refresh();
}

export function setLang(l) { lang = l === 'en' ? 'en' : 'th'; if (reader) reader.lang = lang; }
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function install() {
  if (lockMeta) db.setCodec(codec); else db.setCodec(null);
}

/** Reload meta.lock and the key state. Returns the status object. Any doubt => locked. */
export async function refresh() {
  try { lockMeta = await db.getLockRow(); } catch { lockMeta = null; }
  install();
  await ensureKeys();
  const st = status();
  for (const fn of listeners) { try { fn(st); } catch { /* ignore */ } }
  return st;
}

export async function ensureKeys() {
  if (!lockMeta) { keys = null; reader = null; return null; }
  if (injected) keys = injected;
  else if (session) keys = await session.ensure(lockMeta);
  else keys = null;
  if (!keys) { reader = null; readerFor = null; return null; }
  if (readerFor !== keys) {
    reader = keys.reader(makeBatchResolver(keys.sk, (kid) => db.getEkey(kid)), lang);
    readerFor = keys;
  }
  return keys;
}

/** Search worker: keys arrive by message ({dk, xk, hk, sk}); they are CryptoKeys (structured-clone safe). null = locked. */
export function setKeys(k) {
  injected = k ? { ...k, reader: undefined, writer: undefined, xWriter: undefined } : null;
  if (injected) {
    const i = injected;
    i.reader = (batch, lg) => ({ dk: i.dk, xk: i.xk, hk: i.hk, batch, lang: lg });
  }
  keys = null; reader = null; readerFor = null;
}
export function setMetaRow(row) { lockMeta = row || null; install(); }
export const metaRow = () => lockMeta;
export const session_ = () => session;

export const enabled = () => !!lockMeta;
/** locked = lock is on and there is no usable key. Fail-safe: unknown => locked. */
export const isLocked = () => !!lockMeta && !keys;
export const getKeys = () => keys;
export const getReader = () => reader;
export const state = () => (lockMeta ? lockMeta.state || 'on' : 'off');
export const status = () => ({ enabled: !!lockMeta, state: state(), locked: isLocked() });

/** DK writer for records written while unlocked, null while locked (callers then use the inbox). */
export function writer() { return keys ? keys.writer() : null; }
export function xWriter() { return keys ? keys.xWriter() : null; }
export const publicKey = () => (lockMeta ? lockMeta.pub : null);

// ---------- token <-> host ----------
let hostOfToken = null; // Map token -> host (rows of the `sites` store, decrypted once per unlock)
let hostMapFor = null;
async function loadHosts() {
  const rows = await db.readRaw(['sites'], (s) => db.req(s.sites.getAll()));
  const rd = reader;
  const m = new Map();
  for (const r of rows) {
    try {
      const d = await rec.decodeSiteRow(r, rd);
      if (!d.corrupt) m.set(r.site, d.site);
    } catch { /* locked or damaged: skipped */ }
  }
  hostOfToken = m; hostMapFor = keys;
  return m;
}
export async function hostMap(force = false) {
  if (!keys) return new Map();
  if (force || !hostOfToken || hostMapFor !== keys) await loadHosts();
  return hostOfToken;
}
/** Host name -> the value stored in item.site / siteIdx.site (the token while the lock is on; the host itself otherwise). */
export async function siteKey(host) {
  if (!lockMeta || !keys || rec.isToken(host)) return host;
  return rec.siteToken(keys.hk, host);
}

// ---------- decoders (installed into db.js) ----------
const hasEnc = (rows) => { for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (r && r.e !== undefined) return true; } return false; };
const need = (rd) => { if (!rd) throw new LockedError('locked'); return rd; };

async function items(rows, rd = reader) {
  if (!rows.length || !hasEnc(rows)) return rows;
  need(rd);
  return rec.mapSlices(rows, (r) => rec.decodeItem(r, rd));
}
async function item(r, rd = reader) { if (!r || r.e === undefined) return r; return rec.decodeItem(r, need(rd)); }

const stubGroup = (r) => { const { k, e, ...p } = r; return { ...p, title: '', note: undefined, lockedStub: true }; };
async function group(r, rd = reader) {
  if (!r || r.e === undefined) return r;
  if (!rd) return stubGroup(r); // locked: counts / ts / flags stay readable, titles do not
  return rec.decodeGroup(r, rd);
}
async function groups(rows, rd = reader) {
  if (!rows.length || !hasEnc(rows)) return rows;
  if (!rd) return rows.map((r) => (r.e === undefined ? r : stubGroup(r)));
  return rec.mapSlices(rows, (r) => rec.decodeGroup(r, rd));
}
async function cats(rows) {
  if (!rows.length || !hasEnc(rows)) return rows;
  if (!reader) return rows.map((r) => (r.e === undefined ? r : { ...r, name: '', k: undefined, e: undefined }));
  return rec.mapSlices(rows, (r) => rec.decodeCategory(r, reader));
}
async function trashRows(rows, rd = reader) {
  const enc = rows.some((r) => r.items && hasEnc(r.items));
  if (!enc) return rows;
  need(rd);
  return rec.mapSlices(rows, (r) => rec.decodeTrashRow(r, rd));
}
async function siteRows(rows) { // siteIdx rows -> {site: host, token, g, n}
  if (!rows.length || !rec.isToken(rows[0].site) && !rows.some((r) => rec.isToken(r.site))) return rows;
  let m = await hostMap();
  let miss = false;
  const out = rows.map((r) => {
    if (!rec.isToken(r.site)) return r;
    const h = m.get(r.site);
    if (h === undefined) miss = true;
    return { ...r, token: r.site, site: h === undefined ? r.site : h };
  });
  if (miss && keys) { m = await hostMap(true); return rows.map((r) => (rec.isToken(r.site) ? { ...r, token: r.site, site: m.has(r.site) ? m.get(r.site) : r.site } : r)); }
  return out;
}
async function snapMeta(r) { // header only: tab list stays encrypted until snapGet
  if (!r || r.e === undefined) return r;
  const { k, e, ...p } = r;
  return { ...p, tabCount: p.tabCount != null ? p.tabCount : p.nTabs, windowCount: p.windowCount != null ? p.windowCount : p.nWin, bytes: e ? e.byteLength : 0, enc: true };
}
async function snap(r) {
  if (!r || r.e === undefined) return r;
  if (!reader) throw new LockedError('locked');
  const d = await rec.decodeSnapshot(r, reader);
  if (typeof d.gz === 'string') d.gz = b64dec(d.gz); // stored as base64 inside the ciphertext
  return d;
}

export const codec = { items, item, group, groups, cats, trashRows, siteRows, snapMeta, snap, hostMap, siteKey, isLocked, enabled };

export { b64enc };

// =====================================================================================================================
// WRITE SIDE (service worker only). db.js calls these; crypto always runs BEFORE a transaction, or inside one through
// the keep-alive `hold` (see db.js write()): an IndexedDB transaction auto-commits when it has no pending request.
// =====================================================================================================================
import { normalizeUrl } from './formats.js';
import * as inboxLib from './lock/inbox.js';

export const normUrl = (u) => normalizeUrl(u);

/** Hosts -> tokens (and the encrypted `sites` rows of hosts never seen before). Unlocked only. */
export async function prepSites(hosts) {
  const out = { tokens: new Map(), rows: [] };
  if (!keys) return out;
  const known = await hostMap();
  const w = keys.writer();
  for (const h of hosts) {
    if (!h) continue;
    const t = await rec.siteToken(keys.hk, h);
    out.tokens.set(h, t);
    if (!known.has(t)) {
      out.rows.push(await rec.encodeSiteRow({ site: h, n: 0 }, w));
      known.set(t, h);
    }
  }
  return out;
}

/** Plain items (g, seq assigned) -> stored rows. Unlocked: DK + tokens. Locked: inbox key for `kid` (public key only). */
export async function encodeItemsBatch(items, kid) {
  if (keys) {
    const w = keys.writer();
    const records = await rec.encryptItems(items, w, { normUrl });
    const seqs = records.map((r) => r.seq);
    const journal = { g: records[0].g, seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs), count: records.length, digest: await inboxLib.digestOf(records), kid: 0 };
    return { records, ekey: null, kid: 0, journal };
  }
  if (!lockMeta) throw new LockedError('lock is off');
  const r = await inboxLib.encryptBatchWhileLocked({ pub: lockMeta.pub, kid, items, opts: { normUrl } });
  return { records: r.records, ekey: r.ekey, kid, journal: r.journal };
}

/** Group payload (title, note, agg, tabGroups) -> stored row. Unlocked: DK. Locked: inbox key `kid` (returns the ekeys row). */
export async function encodeGroupRow(g, kid) {
  if (keys) return { row: await rec.encodeGroup(g, keys.writer()), ekey: null, kid: 0 };
  if (!lockMeta) throw new LockedError('lock is off');
  const bk = await inboxLib.createBatchKey(lockMeta.pub, kid);
  return { row: await rec.encodeGroup(g, bk.writer), ekey: bk.row, kid };
}

/** Next free ekeys id from a reader of the highest existing kid. */
export const nextKid = (maxKid) => (Number.isInteger(maxKid) && maxKid >= 0 ? maxKid + 1 : 1);

/**
 * Per-transaction helper used inside db.js write() fns (lock on). `hold(p)` keeps the IDB transaction alive while p settles;
 * `st` = the transaction's stores. One inbox batch key per transaction, allocated lazily (locked mode only).
 */
function txHelper(hold, st) {
  let bk = null;
  // decoding inside a transaction: ekeys rows are fetched with requests of THIS transaction (a second transaction on the same store would wait for us)
  const ekCache = new Map();
  const rdTx = keys ? keys.reader((kid) => ekCache.get(kid) ? recoverFor(kid) : null, lang) : null;
  const bkCache = new Map();
  const recoverFor = (kid) => { let p = bkCache.get(kid); if (!p) { p = inboxLib.recoverBatchKey(ekCache.get(kid), keys.sk); bkCache.set(kid, p); } return p; };
  const getIn = (store, key) => new Promise((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  async function fetchKids(rows) {
    for (const r of rows) {
      const rs = r && r.items ? r.items : [r];
      for (const x of rs) if (x && x.e !== undefined && x.k > 0 && !ekCache.has(x.k)) ekCache.set(x.k, await getIn(st.ekeys, x.k) || null);
    }
  }
  const inboxUse = new Map(); // gid -> Set(kid)
  const locked = !keys;
  const maxKid = () => new Promise((resolve, reject) => {
    const r = st.ekeys.openKeyCursor(null, 'prev');
    r.onsuccess = () => resolve(r.result ? r.result.key : 0);
    r.onerror = () => reject(r.error);
  });
  async function writerNow(gid) {
    if (!locked) return keys.writer();
    if (!lockMeta) throw new LockedError('lock is off');
    if (!bk) {
      const kid = nextKid(await maxKid());
      bk = await hold(inboxLib.createBatchKey(lockMeta.pub, kid));
      st.ekeys.put(bk.row);
    }
    if (gid != null) { let s = inboxUse.get(gid); if (!s) inboxUse.set(gid, s = new Set()); s.add(bk.kid); }
    return bk.writer;
  }
  return {
    locked,
    items: async (rows) => { if (!rows.length || !hasEnc(rows)) return rows; if (locked) throw new LockedError('locked'); await fetchKids(rows); return hold(items(rows, rdTx)); },
    item: async (r) => { if (!r || r.e === undefined) return r; if (locked) throw new LockedError('locked'); await fetchKids([r]); return hold(item(r, rdTx)); },
    group: async (r) => { if (!r || r.e === undefined) return r; if (locked) throw new LockedError('locked'); await fetchKids([r]); return hold(group(r, rdTx)); },
    groups: async (rs) => { if (!rs.length || !hasEnc(rs)) return rs; if (locked) throw new LockedError('locked'); await fetchKids(rs); return hold(groups(rs, rdTx)); },
    cat: async (r) => { if (!r || r.e === undefined) return r; if (locked) throw new LockedError('locked'); await fetchKids([r]); return hold(rec.decodeCategory(r, rdTx)); },
    trashRows: async (rs) => { if (!rs.some((r) => r.items && hasEnc(r.items))) return rs; if (locked) throw new LockedError('locked'); await fetchKids(rs); return hold(trashRows(rs, rdTx)); },
    async encBlob(id, obj) { if (locked) throw new LockedError('locked'); return hold(rec.encodeBlob(id, obj, keys.writer())); }, // sync caches (lib/syncseal.js)
    async decBlob(id, r) { if (locked) throw new LockedError('locked'); return hold(rec.decodeBlob(id, r, rdTx)); },
    async encItem(o, opts) { const w = await writerNow(o.g); return hold(rec.encodeItem(o, w, { normUrl, ...opts })); },
    async encGroup(g) { const w = await writerNow(g.id); return hold(rec.encodeGroup(g, w)); },
    async encCategory(c) { const w = await writerNow(); return hold(rec.encodeCategory(c, w)); },
    async encTrashRow(row) { const w = await writerNow(row.g); return hold(rec.encodeTrashRow(row, w, { normUrl })); },
    /** token for a host (null while locked: tokens are added by the seal job) */
    async siteKey(host) {
      if (locked || !host) return null;
      const t = await hold(rec.siteToken(keys.hk, host));
      const known = hostOfToken || (hostOfToken = new Map());
      if (!known.has(t)) {
        const row = await hold(rec.encodeSiteRow({ site: host, n: 0 }, keys.writer()));
        st.sites.put(row);
        known.set(t, host);
      }
      return t;
    },
    /** call at the end of the transaction: records which inbox groups hold unsealed rows (same transaction) */
    async finish() {
      for (const [g, kids] of inboxUse) {
        const cur = await new Promise((resolve, reject) => { const r = st.inbox.get(g); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const all = new Set([...(cur ? cur.kids : []), ...kids]);
        st.inbox.put({ g, kids: [...all].sort((a, b) => a - b) });
      }
    },
    usesInbox: () => inboxUse.size > 0,
  };
}
/** Snapshots ALWAYS take the inbox path (public key only), unlocked or not: one code path (spec §2). Returns {row, ekey}. */
codec.encodeSnapshotRow = async (snapshot, kid) => {
  if (!lockMeta) throw new LockedError('lock is off');
  const s = { ...snapshot, nTabs: snapshot.tabCount, nWin: snapshot.windowCount };
  if (s.gz instanceof Uint8Array) s.gz = b64enc(s.gz);
  const r = await inboxLib.encryptSnapshotViaInbox({ pub: lockMeta.pub, kid, snapshot: s });
  return { row: r.record, ekey: r.ekey };
};
codec.tx = txHelper;
/** called by db.js write() BEFORE it opens a transaction: fresh key state + the token->host map (their reads need their own transactions) */
codec.prep = async () => { await ensureKeys(); if (keys) await hostMap(); };
codec.prepSites = prepSites;
codec.encodeItemsBatch = encodeItemsBatch;
codec.encodeGroupRow = encodeGroupRow;
codec.nextKid = nextKid;
codec.verify = (rows, count, digest) => inboxLib.verifyDigest(rows, count, digest);
