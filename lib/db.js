// IndexedDB layer. Shared by the service worker (the ONLY writer), the stash page (read-only) and tests.
// Rules: every logical write is ONE transaction (strict durability); `rev` is bumped in that same transaction;
// the commit point is tx.oncomplete. Write functions throw unless setWriter(true) was called (sw.js does).
//
// Stores:
//   meta   {k:'main', schema, rev, lastStash, migration, job, drain, vaultDirty, lastDrainResult, ...}
//   groups {id, createdAt, title, phase:'writing'|'draining'|'committed', starred, locked, source, count, nextSeq, ord, deletedAt,
//           windowCount, tabGroups?: [{i, title, color, collapsed, windowIdx}]}   (tabGroups is optional: additive, no schema bump)
//   items  key [g, seq] -> {g, seq, url, title, ts, t, w?, ws?, tg?, sv?}   (tg = index into the group's tabGroups; sv = split view pair index)
//   trash  autoIncrement tid -> {kind:'items', g, items:[records], n, deletedAt, delReason?: 'deleted'|'opened' (missing = 'deleted')}
//          groups also carry delReason (a group emptied by opening stays as a deletedAt shell with delReason 'opened')
//   drain  key tabId -> {tabId, job, gid, seq, url, windowId, lastAccessed, discardedAtStart, state, reason, attempts, prio}

import { tmFromItems, tmMerge } from './time.js';
import { PURGE_CHUNK, DB_NAME, DB_VERSION, MAX_TITLE, IXLOG_CAP } from './constants.js';
import { id as newId, searchText, cleanTabGroups, tgOf, svOf, titleKey, cleanLook } from './formats.js';
import { siteOfUrl } from './site.js';
import { swStr } from './swstr.js';
import { post } from './bus.js';
import { planAutoTrim } from './snapfmt.js';

let writer = false;
export function setWriter(v) { writer = !!v; }

// Password lock (lib/lockrt.js installs the decoders; null = lock never enabled: every read path below costs one null check).
let codec = null;
export function setCodec(c) { codec = c || null; }
export const getCodec = () => codec;

let dbName = DB_NAME;
/** TEST/dev: a second database in the same profile (a second 'device'). Must be called before the first open. */
export function setDbName(n) { dbName = String(n || DB_NAME); dbp = null; }

let syncOn = false;
/** Sync enabled: local writes also mark their groups in meta.syncDirty (same transaction). */
export function setSyncOn(v) { syncOn = !!v; }

let onWriteHook = null;
/** Called (in the writing context) after every committed write with the touched group ids. */
export function setOnWrite(fn) { onWriteHook = fn; }

// ---------- connection ----------
let dbp = null;
let failInject = false;
/** Test hook: makes openDB() throw. */
export function debugFail(v) {
  failInject = !!v;
  if (v) dbp = null;
}

function openRaw() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, DB_VERSION);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const old = ev.oldVersion || 0;
      if (old < 1) {
        db.createObjectStore('meta', { keyPath: 'k' });
        const groups = db.createObjectStore('groups', { keyPath: 'id' });
        groups.createIndex('by_ord', 'ord');
        groups.createIndex('by_deleted', 'deletedAt');
        db.createObjectStore('items', { keyPath: ['g', 'seq'] });
        db.createObjectStore('trash', { keyPath: 'tid', autoIncrement: true });
        const drain = db.createObjectStore('drain', { keyPath: 'tabId' });
        drain.createIndex('by_job', 'job');
        drain.createIndex('by_jsp', ['job', 'state', 'prio']);
      }
      if (old < 2) db.createObjectStore('ixlog', { keyPath: 'id', autoIncrement: true }); // additive: items/groups untouched
      if (old < 3) {
        // additive: flat categories (stable ids, sync-friendly) and the per-site membership of groups (site facet / group-by site)
        db.createObjectStore('categories', { keyPath: 'id' });
        const si = db.createObjectStore('siteIdx', { keyPath: ['site', 'g'] });
        si.createIndex('byG', 'g');
      }
      if (old < 4) db.createObjectStore('snapshots', { keyPath: 'id' }); // additive: crash-recovery tab snapshots
      if (old < 6) {
        // additive + SPARSE: records without the key path (old items without `site` / `tk`) are simply not in the index until backfilled
        const it = r.transaction.objectStore('items');
        it.createIndex('byT', 'ts');
        it.createIndex('bySite', ['site', 'g']);
        it.createIndex('byTk', 'tk');
      }
      if (old < 7) db.createObjectStore('activity', { keyPath: 'k' }); // additive: local usage stats (d:/w:/e: rows), see lib/activity.js
      if (old < 8) {
        // additive, empty while the password lock is off (see lib/lockrt.js): inbox batch keys, groups holding unsealed rows, token -> host rows
        db.createObjectStore('ekeys', { keyPath: 'kid' });
        db.createObjectStore('inbox', { keyPath: 'g' });
        db.createObjectStore('sites', { keyPath: 'site' });
      }
      if (old < 5) {
        // additive: cross-device sync. sy = per-entity merge metadata, syiid = stable item id -> (g,seq), sykv = engine state + key
        db.createObjectStore('sy', { keyPath: 'k' });
        const si = db.createObjectStore('syiid', { keyPath: 'iid' });
        si.createIndex('byG', 'g');
        db.createObjectStore('sykv', { keyPath: 'k' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('indexedDB.open failed'));
    r.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

export async function openDB() {
  if (failInject) throw new Error('db-fail-injected');
  if (dbp) return dbp;
  const attempt = async () => {
    const db = await openRaw();
    db.onversionchange = () => { db.close(); dbp = null; post({ type: 'reload' }); };
    db.onclose = () => { dbp = null; };
    return db;
  };
  dbp = attempt().catch(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return attempt();
  });
  try {
    return await dbp;
  } catch (e) {
    dbp = null;
    throw e;
  }
}

export async function dbHealth() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction('meta', 'readonly');
      const r = t.objectStore('meta').get('main');
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.name) || String(e) };
  }
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const defMeta = () => ({
  k: 'main',
  schema: 2,
  rev: 0,
  lastStash: null,
  migration: {},
  job: null,
  drain: null,
  vaultDirty: [],
  syncDirty: [], // groups changed locally and not scanned for sync yet
  syncPurged: [], // groups purged locally on purpose (sync sends the purge)
  vaultPurged: [], // gids deleted ON PURPOSE whose vault copy is not removed yet (so they never count as 'lost')
  lastDrainResult: null,
  vaultMissing: 0,
});

let purgedPending = true; // unknown until the first write: true => the first hook run checks
export const hasPurged = () => purgedPending;

function tombstone(meta, gid) {
  const a = meta.vaultPurged || [];
  if (!a.includes(gid)) a.push(gid);
  meta.vaultPurged = a;
  if (syncOn) { const b = meta.syncPurged || []; if (!b.includes(gid)) b.push(gid); meta.syncPurged = b; }
}

function needWriter() {
  if (!writer) throw new Error('db: write attempted outside the service worker');
}

function storesOf(t, names) {
  const o = {};
  for (const n of names) o[n] = t.objectStore(n);
  o.ix = { add: [], del: [], delG: [] }; // search-index change collector (written to 'ixlog' by write())
  return o;
}

/** site key of a stored row: its `site` (a blind token when the lock is on); an unsealed inbox row has none yet (null = not counted) */
const siteOfRec = (r) => r.site || (r.e === undefined ? siteOfUrl(r.url) : null);

/** [[g, from, to]] ranges from a list of seqs (sorted, consecutive seqs merged) */
function seqRanges(gid, seqs) {
  const a = Array.from(new Set(seqs)).sort((x, y) => x - y);
  const out = [];
  for (const s of a) {
    const last = out[out.length - 1];
    if (last && s === last[2] + 1) last[2] = s; else out.push([gid, s, s]);
  }
  return out;
}

const groupRange = (gid, afterSeq = 0, exclusive = false) => IDBKeyRange.bound([gid, afterSeq], [gid, Infinity], exclusive, false);

// ---------- per-site aggregates (siteIdx) ----------
// siteIdx rows {site, g, n} say how many items of group g live on a site. They are maintained in the SAME transaction as
// every item write; group.agg = {top:[[site,n]x5], nSites, nTg} is derived from them (never by scanning items).
async function siteApply(s, g, deltas) {
  if (!s.siteIdx) return;
  for (const [site, d] of deltas) {
    if (!d || !site) continue; // no site (a row of the lock inbox has no token yet: the seal job counts it)
    const key = [site, g.id];
    const row = await req(s.siteIdx.get(key));
    const n = (row ? row.n : 0) + d;
    if (n <= 0) { if (row) s.siteIdx.delete(key); } else s.siteIdx.put({ site, g: g.id, n });
  }
  if (s.L) { g.aggDirty = true; return; } // lock on: the top-sites summary lives in the encrypted group payload; the SW rebuilds it (lockctl.aggStep)
  const rows = await req(s.siteIdx.index('byG').getAll(g.id));
  rows.sort((a, b) => b.n - a.n);
  // rows read before the puts above are committed in-transaction: IndexedDB reads see this transaction's writes
  g.agg = { top: rows.slice(0, 5).map((r) => [r.site, r.n]), nSites: rows.length, nTg: (g.tabGroups && g.tabGroups.length) || 0 };
}

async function siteDropGroup(s, gid) {
  if (!s.siteIdx) return;
  await new Promise((resolve, reject) => {
    const r = s.siteIdx.index('byG').openKeyCursor(IDBKeyRange.only(gid));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve(); return; }
      s.siteIdx.delete(c.primaryKey);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

// ---------- generic transactions ----------
/** Read-only helper. */
async function ro(names, fn) {
  const db = await openDB();
  const t = db.transaction(names, 'readonly');
  return fn(storesOf(t, names));
}

/**
 * Write helper. `fn(stores, meta)` may mutate `meta` (it is put back with rev+1) and returns the result.
 * `changed` = group ids touched ('all' allowed); they are added to meta.vaultDirty in the same transaction.
 * opts.quiet: no rev bump, no bus event, no dirty marking (drain bookkeeping).
 */
/**
 * Lock mode only: keeps a transaction alive while a non-IndexedDB promise (WebCrypto) settles, by chaining cheap requests.
 * The result is delivered from inside a request callback, so the caller's next IDB call is legal again.
 */
function holdFor(store) {
  return (p) => new Promise((resolve, reject) => {
    let done = false; let failed = false; let val;
    Promise.resolve(p).then((v) => { done = true; val = v; }, (e) => { done = true; failed = true; val = e; });
    const ping = () => {
      if (done) { if (failed) reject(val); else resolve(val); return; }
      const r = store.count(IDBKeyRange.only(' hold'));
      r.onsuccess = ping; r.onerror = ping;
    };
    ping();
  });
}

async function write(names, fn, changed, opts = {}) {
  needWriter();
  if (codec && codec.prep) await codec.prep();
  const db = await openDB();
  const all = Array.from(new Set([...names, 'meta', 'ixlog', ...(codec ? ['ekeys', 'inbox', 'sites'] : [])]));
  const t = db.transaction(all, 'readwrite', { durability: 'strict' });
  const st = storesOf(t, all);
  st.L = codec && codec.tx ? codec.tx(holdFor(st.meta), st) : null;
  const finished = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    t.onerror = () => { /* surfaced through onabort */ };
  });
  finished.catch(() => {});
  let meta;
  let out;
  let logId = null;
  try {
    meta = (await req(st.meta.get('main'))) || defMeta();
    // identity of this database: the search snapshot is tied to it (a reset database gets a new id => index rebuild)
    if (!meta.dbId) meta.dbId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    out = await fn(st, meta);
    if (st.L && st.L.usesInbox()) await st.L.finish();
    const ix = st.ix;
    if (ix.add.length || ix.del.length || ix.delG.length) {
      // one change-log record per transaction: the search worker replays it (see search-worker.js)
      logId = await req(st.ixlog.add({ ts: Date.now(), add: ix.add, del: ix.del, delG: ix.delG }));
      if ((await req(st.ixlog.count())) > IXLOG_CAP) {
        const cut = logId - Math.floor(IXLOG_CAP * 0.8);
        st.ixlog.delete(IDBKeyRange.upperBound(cut));
        meta.ixlogLost = Math.max(meta.ixlogLost || 0, cut);
      }
    }
    if (!opts.quiet) {
      meta.rev = (meta.rev || 0) + 1;
      if (Array.isArray(changed) && changed.length) {
        const s = new Set(meta.vaultDirty || []);
        for (const g of changed) s.add(g);
        meta.vaultDirty = Array.from(s);
        if (syncOn && !opts.noSync) { // local change: remember it for the sync scanner IN THE SAME TRANSACTION
          const d = new Set(meta.syncDirty || []);
          for (const g of changed) d.add(g);
          meta.syncDirty = Array.from(d);
        }
      }
    }
    purgedPending = !!(meta.vaultPurged && meta.vaultPurged.length);
    st.meta.put(meta);
  } catch (e) {
    try { t.abort(); } catch { /* already finishing */ }
    await finished.catch(() => {});
    throw e;
  }
  await finished;
  if (!opts.quiet) {
    post({ type: 'changed', rev: meta.rev, groups: changed || 'all', ix: logId });
    if (onWriteHook) { try { onWriteHook(changed); } catch { /* ignore */ } }
  }
  return out;
}

// ---------- reads ----------
export async function getMeta() {
  const rec = await ro(['meta'], (s) => req(s.meta.get('main')));
  return { ...defMeta(), ...(rec || {}) };
}

function sortGroups(list) {
  return list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || a.ord - b.ord);
}

export async function listGroups({ deleted = false } = {}) {
  let all = await ro(['groups'], (s) => req(s.groups.getAll()));
  if (codec) all = await codec.groups(all);
  return sortGroups(all.filter((g) => (deleted ? g.deletedAt != null : g.deletedAt == null)));
}

export async function getGroup(gid) {
  const g = (await ro(['groups'], (s) => req(s.groups.get(gid)))) || null;
  return codec && g ? codec.group(g) : g;
}

export async function getItemsPage(gid, afterSeq = 0, limit = 200) {
  const rows = await ro(['items'], (s) => req(s.items.getAll(groupRange(gid, afterSeq, true), limit)));
  return codec ? codec.items(rows) : rows;
}

/** Positional page of a group's items (position = order by seq). Used by the virtual list. */
export async function getItemsByPos(gid, pos, limit) {
  const rows = await getItemsByPosRaw(gid, pos, limit);
  return codec ? codec.items(rows) : rows;
}
async function getItemsByPosRaw(gid, pos, limit) {
  if (pos <= 0) return ro(['items'], (s) => req(s.items.getAll(groupRange(gid), limit))); // fast path: first page
  return ro(['items'], (s) => new Promise((resolve, reject) => {
    const out = [];
    const r = s.items.openCursor(groupRange(gid));
    let skipped = pos <= 0;
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve(out); return; }
      if (!skipped) { skipped = true; c.advance(pos); return; }
      out.push(c.value);
      if (out.length >= limit) { resolve(out); return; }
      c.continue();
    };
    r.onerror = () => reject(r.error);
  }));
}

/**
 * Layout runs of a group that has tab groups: consecutive items with the same (valid) tab-group index form one
 * segment. Returns [{tg (-1 = ungrouped), n, ws, w}] and the number of items scanned. Reads in batches.
 */
export async function scanTgRuns(gid, validTg, { batch = 2000, split = false } = {}) {
  const segs = [];
  let total = 0;
  let after = 0;
  for (;;) {
    const page = await getItemsPage(gid, after, batch);
    if (!page.length) break;
    for (const it of page) {
      const t = validTg.has(it.tg) ? it.tg : -1;
      const last = segs[segs.length - 1];
      if (last && last.tg === t && !(it.ws && (t >= 0 || split))) last.n++; // split: a window start always opens a new segment (it gets a window label row)
      else segs.push({ tg: t, n: 1, ws: !!it.ws, w: it.w || 0, wh: split && !!it.ws });
      total++;
    }
    after = page[page.length - 1].seq;
    if (page.length < batch) break;
  }
  return { segs, total };
}

export async function getItem(gid, seq) {
  const r = (await ro(['items'], (s) => req(s.items.get([gid, seq])))) || null;
  return codec && r ? codec.item(r) : r;
}

export async function countItems(gid) {
  return ro(['items'], (s) => req(s.items.count(groupRange(gid))));
}

export async function totalItemRecords() {
  return ro(['items'], (s) => req(s.items.count()));
}

/** Walks live groups by `ord` and their items in batches. onGroup(g) then onItems(g, items) (awaited). */
export async function iterateExport(onGroup, onItems, { batch = 1000, includeDeleted = false } = {}) {
  let groups = (codec ? await codec.groups(await ro(['groups'], (s) => req(s.groups.getAll()))) : await ro(['groups'], (s) => req(s.groups.getAll())))
    .filter((g) => (includeDeleted || g.deletedAt == null) && g.phase !== 'writing')
    .sort((a, b) => a.ord - b.ord);
  for (const g of groups) {
    await onGroup(g);
    let after = 0;
    for (;;) {
      const page = await getItemsPage(g.id, after, batch);
      if (!page.length) break;
      await onItems(g, page);
      after = page[page.length - 1].seq;
      if (page.length < batch) break;
    }
  }
  groups = null;
}

export async function listTrash() {
  const [groups, items0] = await Promise.all([
    listGroups({ deleted: true }),
    ro(['trash'], (s) => req(s.trash.getAll())),
  ]);
  const items = codec ? await codec.trashRows(items0) : items0;
  return { groups, items: items.sort((a, b) => b.deletedAt - a.deletedAt) };
}

// ---------- group writes ----------
export async function createGroup(info = {}) {
  const gid = info.id || newId();
  return write(['groups'], async (s) => {
    let ord = info.ord;
    if (ord == null) {
      const first = await req(s.groups.index('by_ord').openCursor());
      ord = first ? first.value.ord - 1 : 0;
    }
    const g = {
      id: gid,
      createdAt: info.createdAt || Date.now(),
      title: String(info.title || '').slice(0, 500),
      phase: 'writing',
      starred: !!info.starred,
      locked: !!info.locked,
      source: info.source || 'click',
      count: 0,
      nextSeq: 1,
      windowCount: info.windowCount > 1 ? info.windowCount : 1,
      mtime: Date.now(),
      ord,
      deletedAt: info.deletedAt == null ? null : info.deletedAt,
    };
    const tgs = cleanTabGroups(info.tabGroups);
    if (tgs.length) g.tabGroups = tgs;
    Object.assign(g, cleanLook(info));
    s.groups.put(s.L ? await s.L.encGroup(g) : g);
    return g;
  }, [gid]);
}

/** Appends items (seq = nextSeq++). Returns {from, to}. One transaction per call. */
export async function appendItems(gid, items) {
  if (codec && codec.tx) return appendItemsLock(gid, items);
  return write(['groups', 'items', 'siteIdx'], async (s) => {
    const g = await req(s.groups.get(gid));
    if (!g) throw new Error('notfound');
    const from = g.nextSeq;
    const deltas = new Map();
    for (const it of items) {
      const title = String(it.title == null ? it.url : it.title).slice(0, MAX_TITLE);
      const site = siteOfUrl(it.url);
      deltas.set(site, (deltas.get(site) || 0) + 1);
      const rec = { g: gid, seq: g.nextSeq++, url: it.url, title, ts: it.ts || Date.now(), t: searchText(title, it.url), site, tk: titleKey(title, it.url) };
      if (it.w > 0) { rec.w = it.w; if (it.ws) rec.ws = true; } // window index inside a multi-window group
      if (tgOf(it) >= 0) rec.tg = it.tg; // Chrome tab group (index into g.tabGroups)
      if (svOf(it) >= 0) rec.sv = it.sv; // split view: two neighbouring items with the same sv (and w) were side by side
      if (typeof it.d === 'number' && it.d) rec.d = it.d; // packed idle/lifetime (only present when activity tracking is on)
      s.items.put(rec);
    }
    g.count += items.length;
    if (items.some((x) => x.d)) { const tm = tmFromItems(items); if (tm) g.tm = tmMerge(g.tm, tm); }
    await siteApply(s, g, deltas);
    g.mtime = Date.now();
    s.groups.put(g);
    if (items.length) s.ix.add.push([gid, from, g.nextSeq - 1]);
    return { from, to: g.nextSeq - 1 };
  }, [gid]);
}

/**
 * appendItems with the password lock on. All crypto runs BEFORE the transaction (the batch is encrypted for the current seq
 * range); inside it we only check that nobody moved nextSeq meanwhile (single writer, so a retry is rare) and write
 * ekeys row + items + inbox row + counters in ONE transaction. Locked: public key only (inbox); unlocked: DK + tokens.
 * Returns {from, to, journal} (journal = {g, seqFrom, seqTo, count, digest, kid} for the read-back verify).
 */
async function appendItemsLock(gid, items) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await codec.prep();
    const g0 = await ro(['groups'], (s) => req(s.groups.get(gid)));
    if (!g0) throw new Error('notfound');
    const from = g0.nextSeq;
    const maxKid = await ro(['ekeys'], (s) => new Promise((resolve, reject) => { const r = s.ekeys.openKeyCursor(null, 'prev'); r.onsuccess = () => resolve(r.result ? r.result.key : 0); r.onerror = () => reject(r.error); }));
    const kid = codec.nextKid(maxKid);
    const plain = items.map((it, i) => {
      const title = String(it.title == null ? it.url : it.title).slice(0, MAX_TITLE);
      const rec = { g: gid, seq: from + i, url: it.url, title, ts: it.ts || Date.now(), site: siteOfUrl(it.url) };
      if (it.w > 0) { rec.w = it.w; if (it.ws) rec.ws = true; }
      if (tgOf(it) >= 0) rec.tg = it.tg;
      if (svOf(it) >= 0) rec.sv = it.sv;
      if (typeof it.d === 'number' && it.d) rec.d = it.d;
      return rec;
    });
    if (!plain.length) return { from, to: from - 1 };
    const enc = await codec.encodeItemsBatch(plain, kid);
    const sites = await codec.prepSites(new Set(plain.map((r) => r.site)));
    const res = await write(['groups', 'items', 'siteIdx'], async (s) => {
      const g = await req(s.groups.get(gid));
      if (!g || g.nextSeq !== from) return { retry: true };
      if (enc.ekey) {
        if ((await req(s.ekeys.getKey(enc.kid))) !== undefined) return { retry: true };
        s.ekeys.put(enc.ekey);
        const cur = await req(s.inbox.get(gid));
        s.inbox.put({ g: gid, kids: [...new Set([...(cur ? cur.kids : []), enc.kid])].sort((a, b) => a - b) });
      }
      for (const r of sites.rows) s.sites.put(r);
      const deltas = new Map();
      for (let i = 0; i < enc.records.length; i++) {
        s.items.put(enc.records[i]);
        const tok = sites.tokens.get(plain[i].site);
        if (tok) deltas.set(tok, (deltas.get(tok) || 0) + 1);
      }
      g.nextSeq = from + plain.length;
      g.count += plain.length;
      if (items.some((x) => x.d)) { const tm = tmFromItems(items); if (tm) g.tm = tmMerge(g.tm, tm); }
      await siteApply(s, g, deltas);
      g.mtime = Date.now();
      s.groups.put(g);
      s.ix.add.push([gid, from, g.nextSeq - 1]);
      return { from, to: g.nextSeq - 1, journal: enc.journal };
    }, [gid]);
    if (!res.retry) return res;
  }
  throw new Error('appendItems: concurrent writers');
}

/** Read-only check: stored counter, real record count and (optionally) first/last urls. */
export async function verifyGroup(gid, expected, { firstUrl, lastUrl, journals } = {}) {
  return ro(['groups', 'items'], async (s) => {
    const g = await req(s.groups.get(gid));
    if (!g || g.count !== expected) return false;
    const c = await req(s.items.count(groupRange(gid)));
    if (c !== expected) return false;
    if (codec && journals && journals.length) { // lock on: the rows are ciphertext; compare count + digest of what was written (read back from disk)
      for (const j of journals) {
        const rows = await req(s.items.getAll(IDBKeyRange.bound([gid, j.seqFrom], [gid, j.seqTo])));
        const v = await codec.verify(rows, j.count, j.digest);
        if (!v.ok) return false;
      }
      return true;
    }
    if (expected > 0 && (firstUrl || lastUrl) && !codec) {
      const rows = await req(s.items.getAll(groupRange(gid), 1));
      const lastRows = await new Promise((resolve, reject) => {
        const r = s.items.openCursor(groupRange(gid), 'prev');
        r.onsuccess = () => resolve(r.result ? r.result.value : null);
        r.onerror = () => reject(r.error);
      });
      if (firstUrl && (!rows[0] || rows[0].url !== firstUrl)) return false;
      if (lastUrl && (!lastRows || lastRows.url !== lastUrl)) return false;
    }
    return true;
  });
}

export async function setPhase(gid, phase) {
  return write(['groups'], async (s) => {
    const g = await req(s.groups.get(gid));
    if (!g) return false;
    g.phase = phase;
    s.groups.put(g);
    return true;
  }, [gid]);
}

export async function updateGroup(gid, patch) {
  return write(['groups'], async (s) => {
    let g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    const dec = !!(s.L && (typeof patch.title === 'string' || typeof patch.note === 'string' || 'color' in patch || 'emoji' in patch)); // title / note / look live in the encrypted payload
    if (dec) g = await s.L.group(g);
    if (typeof patch.title === 'string') g.title = patch.title.trim().slice(0, 500);
    if (typeof patch.starred === 'boolean') g.starred = patch.starred;
    if (typeof patch.locked === 'boolean') g.locked = patch.locked;
    if (typeof patch.ord === 'number' && isFinite(patch.ord)) g.ord = patch.ord;
    for (const f of ['pinned', 'pending', 'archived', 'sync']) if (typeof patch[f] === 'boolean') g[f] = patch[f];
    if (typeof patch.note === 'string') g.note = patch.note.slice(0, 2000);
    if ('color' in patch) { const l = cleanLook({ color: patch.color }); if (l.color) g.color = l.color; else delete g.color; }
    if ('emoji' in patch) { const l = cleanLook({ emoji: patch.emoji }); if (l.emoji) g.emoji = l.emoji; else delete g.emoji; }
    if ('cat' in patch) g.cat = patch.cat == null ? null : String(patch.cat);
    if (typeof patch.lastRestoredAt === 'number') g.lastRestoredAt = patch.lastRestoredAt;
    if (patch.rcInc === true) g.rc = (g.rc || 0) + 1; // restore counter (only sent when usage stats are on)
    g.mtime = Date.now();
    s.groups.put(dec ? await s.L.encGroup(g) : g);
    return {};
  }, [gid]);
}

/**
 * Re-shapes one session in place without touching its tabs: `merge` puts every window into one (drops the per-item window
 * number and start flag), `ungroup` dissolves Chrome tab groups ('all' or one tab-group index). Returns {changed, undo}
 * where undo = { gid, windowCount, tabGroups, rows:[[seq, w, ws, tg]] } holds what was there before (see undoReshape).
 */
export async function reshapeGroup(gid, { merge = false, ungroup = null } = {}) {
  return write(['groups', 'items'], async (s) => {
    let g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    if (g.locked) return { error: 'locked' };
    if (s.L) g = await s.L.group(g);
    const tgs = Array.isArray(g.tabGroups) ? g.tabGroups : [];
    const drop = ungroup === 'all' ? new Set(tgs.map((x) => x.i)) : Number.isInteger(ungroup) ? new Set([ungroup]) : new Set();
    const undo = { gid, windowCount: g.windowCount || 1, tabGroups: tgs.map((x) => ({ ...x })), rows: [] };
    let changed = 0;
    const range = [];
    await new Promise((resolve, reject) => {
      const r = s.items.openCursor(groupRange(gid));
      r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; } range.push(c.value); c.continue(); };
      r.onerror = () => reject(r.error);
    });
    for (const raw of range) {
      const wasEnc = !!s.L && raw.e !== undefined;
      const rec = wasEnc ? await s.L.item(raw) : raw;
      if (rec.corrupt) continue;
      const hasW = rec.w !== undefined || rec.ws !== undefined;
      const hasTg = typeof rec.tg === 'number' && drop.has(rec.tg);
      if (!((merge && hasW) || hasTg)) continue;
      undo.rows.push([rec.seq, rec.w === undefined ? null : rec.w, rec.ws ? 1 : 0, typeof rec.tg === 'number' ? rec.tg : null]);
      if (merge) { delete rec.w; delete rec.ws; }
      if (hasTg) delete rec.tg;
      s.items.put(wasEnc ? await s.L.encItem(rec) : rec);
      s.ix.del.push([gid, rec.seq, rec.seq]);
      s.ix.add.push([gid, rec.seq, rec.seq]);
      changed++;
    }
    if (merge) g.windowCount = 1;
    if (drop.size) { const keep = tgs.filter((x) => !drop.has(x.i)); if (keep.length) g.tabGroups = keep; else delete g.tabGroups; }
    if (merge && Array.isArray(g.tabGroups)) g.tabGroups = g.tabGroups.map((x) => ({ ...x, windowIdx: 1 }));
    g.mtime = Date.now();
    s.groups.put(s.L ? await s.L.encGroup(g) : g);
    return { changed, undo };
  }, [gid]);
}

/** Puts back what reshapeGroup() changed (the `undo` it returned). */
export async function undoReshape(undo) {
  if (!undo || typeof undo.gid !== 'string') return { error: 'badundo' };
  return write(['groups', 'items'], async (s) => {
    let g = await req(s.groups.get(undo.gid));
    if (!g) return { error: 'notfound' };
    if (s.L) g = await s.L.group(g);
    for (const [seq, w, ws, tg] of undo.rows) {
      const raw = await req(s.items.get([undo.gid, seq]));
      if (!raw) continue;
      const wasEnc = !!s.L && raw.e !== undefined;
      const rec = wasEnc ? await s.L.item(raw) : raw;
      if (rec.corrupt) continue;
      if (w !== null) rec.w = w;
      if (ws) rec.ws = true;
      if (tg !== null) rec.tg = tg;
      s.items.put(wasEnc ? await s.L.encItem(rec) : rec);
      s.ix.del.push([undo.gid, seq, seq]);
      s.ix.add.push([undo.gid, seq, seq]);
    }
    g.windowCount = undo.windowCount > 1 ? undo.windowCount : 1;
    if (undo.tabGroups.length) g.tabGroups = undo.tabGroups; else delete g.tabGroups;
    g.mtime = Date.now();
    s.groups.put(s.L ? await s.L.encGroup(g) : g);
    return {};
  }, [undo.gid]);
}

/**
 * Removes items by seq (restore removal). count is decremented in the same transaction.
 * A group that becomes empty is deleted when it is committed, unlocked.
 */
export async function removeItems(gid, seqs) {
  return write(['groups', 'items', 'siteIdx'], async (s, meta) => {
    const g = await req(s.groups.get(gid));
    if (!g || g.locked) return { removed: 0 };
    let n = 0;
    const gone = [];
    const deltas = new Map();
    for (const seq of seqs) {
      const key = [gid, seq];
      const rec = await req(s.items.get(key));
      if (rec !== undefined) {
        s.items.delete(key);
        gone.push(seq);
        const site = siteOfRec(rec);
        deltas.set(site, (deltas.get(site) || 0) - 1);
        n++;
      }
    }
    for (const r of seqRanges(gid, gone)) s.ix.del.push(r);
    g.count = Math.max(0, g.count - n);
    g.mtime = Date.now();
    let deleted = false;
    if (g.count === 0 && g.phase === 'committed') {
      s.groups.delete(gid);
      if (s.inbox) s.inbox.delete(gid);
      deleted = true;
      tombstone(meta, gid);
      if (meta.lastStash && meta.lastStash.groupId === gid) meta.lastStash = null;
    } else {
      await siteApply(s, g, deltas);
      s.groups.put(g);
    }
    if (deleted) await siteDropGroup(s, gid);
    return { removed: n, deleted };
  }, [gid]);
}

/**
 * Moves items to the trash store (one transaction, <= PURGE_CHUNK seqs). Returns {tid, n}.
 * reason 'deleted' (the user removed them; undo toast) | 'opened' (opening them removed them: bulk path, see removeOpened()).
 * A committed group that ends up with no items in the 'opened' case stays as a SHELL (deletedAt + delReason 'opened', count 0): its
 * trash records list the restored items, so it can be re-created in place (same seq numbers = same order).
 */
export async function trashItems(gid, seqs, { reason = 'deleted' } = {}) {
  return write(['groups', 'items', 'trash', 'siteIdx'], async (s, meta) => {
    const g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    if (g.locked) return { error: 'locked' };
    if (s.L && (await req(s.inbox.get(gid)))) return { error: 'busy' }; // unsealed rows of the lock inbox: the seal job must finish first
    const recs = [];
    for (const seq of seqs) {
      const r = await req(s.items.get([gid, seq]));
      if (r) recs.push(r);
    }
    if (!recs.length) return { error: 'notfound' };
    const now = Date.now();
    const tid = await req(s.trash.add({ kind: 'items', g: gid, items: recs, n: recs.length, deletedAt: now, delReason: reason }));
    const deltas = new Map();
    for (const r of recs) {
      s.items.delete([gid, r.seq]);
      const site = siteOfRec(r);
      deltas.set(site, (deltas.get(site) || 0) - 1);
    }
    for (const r of seqRanges(gid, recs.map((x) => x.seq))) s.ix.del.push(r);
    g.count = Math.max(0, g.count - recs.length);
    g.mtime = now;
    await siteApply(s, g, deltas);
    let shell = false;
    if (reason === 'opened' && g.count === 0 && g.phase === 'committed' && g.deletedAt == null) {
      g.deletedAt = now; g.delReason = 'opened'; shell = true;
      if (meta.lastStash && meta.lastStash.groupId === gid) meta.lastStash = null;
    }
    s.groups.put(g);
    return { tid, n: recs.length, shell };
  }, [gid]);
}

/**
 * Moves items from one set to another in ONE transaction (counts, per-site aggregates, search log, sync/vault dirty marks all follow).
 *   dst: {gid} an existing set, or {create:{title, starred, pinned, pending, archived, cat}} a new set made from the items.
 *   opts.keepSeqs: [seq] (aligned with `seqs`): undo puts the items back under their ORIGINAL seq numbers.
 *   opts.recreate: info to re-create the target set (dst.gid) when undo finds it gone (a set emptied by a move is deleted).
 * Tab-group info is carried over (a matching title+colour group in the target is reused); split view pairs (`sv`) keep their pairing
 * when BOTH halves move (fresh pair id in the target), a lone half loses its sv. Window labels (w/ws) are dropped.
 * Returns {n, dst, created, map:[[oldSeq,newSeq]], srcInfo, srcGone} or {error}.
 */
export async function moveItems(srcGid, seqs, dst, opts = {}) {
  return write(['groups', 'items', 'siteIdx'], async (s, meta) => {
    const L = s.L; // password lock on: groups / items are decoded here and re-encrypted on the way out (the rows change g/seq, which the ciphertext is bound to)
    const gGet = async (id) => { const r = await req(s.groups.get(id)); return L && r ? L.group(r) : r; };
    const gPut = async (g) => { s.groups.put(L ? await L.encGroup(g) : g); };
    const src = await gGet(srcGid);
    if (!src) return { error: 'notfound' };
    if (src.locked && !opts.keepSeqs) return { error: 'locked' };
    if (L && ((await req(s.inbox.get(srcGid))) || (dst && dst.gid && (await req(s.inbox.get(dst.gid)))))) return { error: 'busy' };
    let recs = [];
    const seen = new Set();
    for (const seq of seqs) {
      if (seen.has(seq)) continue;
      seen.add(seq);
      const r = await req(s.items.get([srcGid, seq]));
      if (r) recs.push(r);
    }
    if (!recs.length) return { error: 'notfound' };
    if (L) recs = await L.items(recs);
    let created = false;
    let d = dst && dst.gid ? await gGet(dst.gid) : null;
    if (d && d.id === srcGid) return { error: 'same' };
    if (d && d.locked && !opts.keepSeqs) return { error: 'locked' };
    if (!d) {
      const first = await req(s.groups.index('by_ord').openCursor());
      const c = (dst && (dst.create || opts.recreate)) || null;
      if (!c) return { error: 'notfound' };
      d = { id: (dst && dst.gid) || newId(), createdAt: c.createdAt || Date.now(), title: String(c.title || '').slice(0, 500), phase: 'committed', starred: !!c.starred, locked: false, source: dst && dst.gid ? 'undo-restore' : 'move', count: 0, nextSeq: 1, windowCount: 1, mtime: Date.now(), ord: c.ord != null ? c.ord : (first ? first.value.ord - 1 : 0), deletedAt: null };
      for (const k of ['pinned', 'pending', 'archived']) if (c[k]) d[k] = true;
      if (c.cat != null) d.cat = String(c.cat);
      if (c.tabGroups && opts.recreate) d.tabGroups = c.tabGroups;
      created = true;
    }
    const srcInfo = { id: src.id, title: src.title, createdAt: src.createdAt, starred: !!src.starred, pinned: !!src.pinned, pending: !!src.pending, archived: !!src.archived, cat: src.cat == null ? null : src.cat, ord: src.ord, tabGroups: src.tabGroups || null };
    // tab groups
    const dtg = cleanTabGroups(d.tabGroups);
    const stg = src.tabGroups || [];
    const tgMap = new Map();
    for (const r of recs) {
      const t = tgOf(r);
      if (t < 0 || tgMap.has(t)) continue;
      const def = stg.find((x) => x.i === t);
      if (!def) { tgMap.set(t, -1); continue; }
      let hit = dtg.find((x) => x.title === def.title && x.color === def.color);
      if (!hit) {
        let ni = 0; for (const x of dtg) if (x.i >= ni) ni = x.i + 1;
        if (opts.keepSeqs) ni = def.i; // undo: same index as before
        if (ni >= 65536 || dtg.some((x) => x.i === ni)) { tgMap.set(t, -1); continue; }
        hit = { ...def, i: ni }; delete hit.windowIdx; dtg.push(hit);
      }
      tgMap.set(t, hit.i);
    }
    if (dtg.length) d.tabGroups = dtg;
    // split view pairs: keep the pairing only when both halves move
    const svCount = new Map();
    for (const r of recs) { const v = svOf(r); if (v >= 0) svCount.set(v, (svCount.get(v) || 0) + 1); }
    const svMap = new Map();
    let svNext = 0;
    if ([...svCount.values()].some((c) => c >= 2)) {
      const cur = L ? null : s.items.openCursor(groupRange(d.id));
      if (L) svNext = 1000 + Math.floor(Math.random() * 50000); // sv lives inside the ciphertext: a random free-ish pair id instead of max+1
      if (cur) await new Promise((res, rej) => { cur.onsuccess = () => { const c = cur.result; if (!c) { res(); return; } const v = svOf(c.value); if (v >= svNext) svNext = v + 1; c.continue(); }; cur.onerror = () => rej(cur.error); });
    }
    const deltas = new Map();
    const sdel = new Map();
    const map = [];
    const newSeqs = [];
    for (const r of recs) {
      const keep = opts.keepSeqs ? opts.keepSeqs[seqs.indexOf(r.seq)] : 0;
      const seq = keep > 0 ? keep : d.nextSeq;
      if (seq >= d.nextSeq) d.nextSeq = seq + 1;
      const o = { g: d.id, seq, url: r.url, title: r.title, ts: r.ts, site: (L ? siteOfUrl(r.url) : r.site) || siteOfUrl(r.url) };
      if (!L) { o.t = r.t; o.tk = r.tk; }
      const t = tgOf(r);
      if (t >= 0 && tgMap.get(t) >= 0) o.tg = tgMap.get(t);
      const v = svOf(r);
      if (v >= 0 && svCount.get(v) >= 2) { if (!svMap.has(v)) svMap.set(v, svNext++); o.sv = svMap.get(v); }
      if (typeof r.d === 'number' && r.d) o.d = r.d;
      if (L && typeof r.w === 'number') { /* window labels are dropped on a move (see above) */ }
      s.items.put(L ? await L.encItem(o) : o);
      s.items.delete([srcGid, r.seq]);
      map.push([r.seq, seq]);
      newSeqs.push(seq);
      const sk = L ? await L.siteKey(o.site) : o.site;
      deltas.set(sk, (deltas.get(sk) || 0) + 1);
      sdel.set(sk, (sdel.get(sk) || 0) - 1);
    }
    for (const r of seqRanges(srcGid, recs.map((x) => x.seq))) s.ix.del.push(r);
    for (const r of seqRanges(d.id, newSeqs)) s.ix.add.push(r);
    d.count += recs.length;
    if (recs.some((x) => x.d)) { const tm = tmFromItems(recs); if (tm) d.tm = tmMerge(d.tm, tm); }
    d.mtime = Date.now();
    await siteApply(s, d, deltas);
    await gPut(d);
    src.count = Math.max(0, src.count - recs.length);
    src.mtime = Date.now();
    let srcGone = false;
    if (src.count === 0 && src.phase === 'committed') {
      s.groups.delete(srcGid);
      if (s.inbox) s.inbox.delete(srcGid);
      srcGone = true;
      tombstone(meta, srcGid);
      if (meta.lastStash && meta.lastStash.groupId === srcGid) meta.lastStash = null;
      await siteDropGroup(s, srcGid);
    } else { await siteApply(s, src, sdel); await gPut(src); }
    return { n: recs.length, dst: d.id, created, map, srcInfo, srcGone };
  }, [srcGid, (dst && dst.gid) || '']);
}

/** Opening removed these entries: soft-delete them as type 'opened' in batches of <= PURGE_CHUNK per transaction. */
export async function removeOpened(gid, seqs) {
  let removed = 0; let shell = false;
  for (let i = 0; i < seqs.length; i += PURGE_CHUNK) {
    const r = await trashItems(gid, seqs.slice(i, i + PURGE_CHUNK), { reason: 'opened' });
    if (r && r.n) removed += r.n;
    if (r && r.shell) shell = true;
  }
  return { removed, deleted: shell };
}

export async function undoTrash(tid) {
  return write(['groups', 'items', 'trash', 'siteIdx'], async (s) => {
    const rec = await req(s.trash.get(tid));
    if (!rec) return { error: 'notfound' };
    let g = await req(s.groups.get(rec.g));
    if (!g) {
      const first = await req(s.groups.index('by_ord').openCursor());
      g = {
        id: rec.g, createdAt: Date.now(), title: '', phase: 'committed', starred: false, locked: false,
        source: 'undo-restore', count: 0, nextSeq: 1, ord: first ? first.value.ord - 1 : 0, deletedAt: null,
      };
    }
    if (g.deletedAt != null && g.delReason === 'opened') { g.deletedAt = null; delete g.delReason; } // recovering a tab revives its emptied session
    let added = 0;
    const deltas = new Map();
    for (const r of rec.items) {
      if ((await req(s.items.getKey([g.id, r.seq]))) === undefined) {
        added++;
        const site = siteOfRec(r);
        deltas.set(site, (deltas.get(site) || 0) + 1);
      }
      s.items.put(r.e !== undefined || (r.site && r.tk != null) ? r : { ...r, site: r.site || siteOfUrl(r.url), tk: r.tk != null ? r.tk : titleKey(r.title, r.url) });
      if (r.seq >= g.nextSeq) g.nextSeq = r.seq + 1;
    }
    g.count += added;
    g.mtime = Date.now();
    await siteApply(s, g, deltas);
    s.groups.put(g);
    for (const r of seqRanges(g.id, rec.items.map((x) => x.seq))) s.ix.add.push(r);
    s.trash.delete(tid);
    return { groupId: g.id };
  }, null);
}

export async function softDeleteGroup(gid) {
  return write(['groups'], async (s, meta) => {
    const g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    if (g.locked) return { error: 'locked' };
    if (g.phase !== 'committed') return { error: 'busy' };
    g.deletedAt = Date.now();
    g.delReason = 'deleted';
    s.groups.put(g);
    if (meta.lastStash && meta.lastStash.groupId === gid) meta.lastStash = null;
    return { groupId: gid };
  }, [gid]);
}

export async function undeleteGroup(gid) {
  return write(['groups'], async (s) => {
    const g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    g.deletedAt = null;
    delete g.delReason;
    s.groups.put(g);
    return { groupId: gid };
  }, [gid]);
}

/** Deletes a group and all its items (one range delete). Refuses groups that are still being written/drained. */
export async function purgeGroup(gid, { force = false } = {}) {
  return write(['groups', 'items', 'siteIdx'], async (s, meta) => {
    const g = await req(s.groups.get(gid));
    if (g && !force && g.phase !== 'committed') return { error: 'busy' };
    s.items.delete(groupRange(gid));
    await siteDropGroup(s, gid);
    s.groups.delete(gid);
    if (s.inbox) s.inbox.delete(gid);
    if (g) tombstone(meta, gid);
    s.ix.delG.push(gid);
    if (meta.lastStash && meta.lastStash.groupId === gid) meta.lastStash = null;
    return {};
  }, [gid]);
}

const DAY = 86400000;
export const reasonOf = (x) => (x && x.delReason === 'opened' ? 'opened' : 'deleted');

/**
 * ONE bounded step of the trash purge (<= PURGE_CHUNK items removed per transaction; trash records are one key each).
 * opts: {now, days:{deleted, opened} (0 = never), only: 'deleted'|'opened'|null, all: purge everything of that type now,
 *        sel: {gids:[], tids:[]} purge exactly these}. Returns {done, groups, items, records}. Call again until done (resumable: the
 * state is the data itself; a half-purged group keeps `purging` and carries on). Purged groups are tombstoned for vault + sync.
 */
export async function purgeStep(opts = {}) {
  const now = opts.now || Date.now();
  const days = opts.days || {};
  const selG = opts.sel ? new Set(opts.sel.gids || []) : null;
  const selT = opts.sel ? new Set(opts.sel.tids || []) : null;
  const cutOf = (reason) => {
    if (opts.only && opts.only !== reason) return -Infinity;
    if (opts.all) return Infinity;
    const d = Number(days[reason]);
    return d > 0 ? now - d * DAY : -Infinity;
  };
  const touched = [];
  return write(['groups', 'items', 'trash', 'siteIdx'], async (s, meta) => {
    let budget = PURGE_CHUNK;
    const out = { done: false, groups: 0, items: 0, records: 0 };
    const gone = new Set();
    let more = false;
    // 1. groups (user-deleted sessions and emptied-by-opening shells)
    const groups = await req(s.groups.getAll());
    for (const g of groups) {
      if (g.deletedAt == null || g.phase !== 'committed') continue;
      const r = reasonOf(g);
      const hit = selG ? selG.has(g.id) : g.deletedAt < cutOf(r);
      if (!hit) continue;
      if (budget <= 0) { more = true; break; }
      const keys = await req(s.items.getAllKeys(groupRange(g.id), budget));
      if (keys.length) {
        s.items.delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
        budget -= keys.length;
        out.items += keys.length;
      }
      if (budget <= 0) {
        // budget used up exactly: items may remain -> keep the group (marked) and carry on in the next step
        const left = await req(s.items.count(groupRange(g.id)));
        if (left > 0) {
          if (!g.purging) { await siteDropGroup(s, g.id); g.purging = true; }
          g.count = left;
          s.groups.put(g);
          touched.push(g.id);
          more = true;
          break;
        }
      }
      await siteDropGroup(s, g.id);
      s.groups.delete(g.id);
      if (s.inbox) s.inbox.delete(g.id);
      tombstone(meta, g.id);
      s.ix.delG.push(g.id);
      if (meta.lastStash && meta.lastStash.groupId === g.id) meta.lastStash = null;
      touched.push(g.id);
      gone.add(g.id + '|' + r);
      out.groups++;
    }
    // 2. trash records (item-level): expired, selected, or belonging to a group purged above
    await new Promise((resolve, reject) => {
      const c = s.trash.openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) { resolve(); return; }
        const v = cur.value;
        const r = reasonOf(v);
        const hit = selT ? (selT.has(v.tid) || gone.has(v.g + '|' + r)) : (v.deletedAt < cutOf(r) || gone.has(v.g + '|' + r));
        if (hit) {
          s.trash.delete(cur.primaryKey);
          out.records++;
          out.items += (v.n || (v.items ? v.items.length : 0));
          if (!touched.includes(v.g)) touched.push(v.g);
        }
        cur.continue();
      };
      c.onerror = () => reject(c.error);
    });
    out.done = !more;
    if (out.done) {
      const lp = { ...(meta.lastPurge || {}) };
      for (const r of ['deleted', 'opened']) if (!opts.only || opts.only === r) lp[r] = now;
      meta.lastPurge = lp;
    }
    return out;
  }, touched);
}

/** Runs purgeStep until done. `each(fn)` lets the caller wrap every step (the SW passes runExclusive). */
export async function purgeAll(opts = {}, each = (fn) => fn()) {
  const tot = { groups: 0, items: 0, records: 0 };
  for (let i = 0; i < 5000; i++) {
    const r = await each(() => purgeStep(opts));
    tot.groups += r.groups; tot.items += r.items; tot.records += r.records;
    if (r.done) break;
  }
  return tot;
}

/** Back-compat wrapper (old callers): purge everything of both types older than `maxAgeDays`. */
export async function purgeExpired(maxAgeDays = 30, now = Date.now()) {
  return purgeAll({ now, days: { deleted: maxAgeDays, opened: maxAgeDays } });
}

/** DEV test helper: pretends deleted sessions / trashed items were deleted `days` days earlier (optionally only one type). */
export async function debugBackdateTrash(days, only = null) {
  return write(['groups', 'trash'], async (s) => {
    const gs = await req(s.groups.getAll());
    for (const g of gs) if (g.deletedAt != null && (!only || reasonOf(g) === only)) { g.deletedAt -= days * DAY; s.groups.put(g); }
    const ts = await req(s.trash.getAll());
    for (const t of ts) if (!only || reasonOf(t) === only) { t.deletedAt -= days * DAY; s.trash.put(t); }
  }, 'all');
}

export async function emptyTrashAll() {
  return purgeAll({ all: true });
}

/** "Clear this type now". */
export async function emptyTrashType(reason) {
  return purgeAll({ all: true, only: reason === 'opened' ? 'opened' : 'deleted' });
}

/**
 * Recovers trash into the list. gids = user-deleted sessions / emptied shells (undeleted AFTER their records are back), tids = trash records.
 * Items return under their ORIGINAL seq (same order); counts, site index and search log are updated in the same transactions
 * (<= PURGE_CHUNK items each). Returns {recovered, groups}.
 */
export async function recoverTrash({ gids = [], tids = [] } = {}) {
  const all = await ro(['trash'], (s) => req(s.trash.getAll()));
  const gset = new Set(gids);
  const tset = new Set(tids);
  const want = all.filter((r) => tset.has(r.tid) || (gset.has(r.g) && reasonOf(r) === 'opened')).sort((a, b) => a.tid - b.tid);
  let recovered = 0;
  const touchedList = [];
  let batch = []; let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const list = batch; batch = []; size = 0;
    const r = await write(['groups', 'items', 'trash', 'siteIdx'], async (s) => {
      let n = 0;
      for (const rec of list) {
        if (!(await req(s.trash.getKey(rec.tid)))) continue;
        let g = await req(s.groups.get(rec.g));
        if (!g) {
          const first = await req(s.groups.index('by_ord').openCursor());
          g = { id: rec.g, createdAt: Date.now(), title: '', phase: 'committed', starred: false, locked: false, source: 'undo-restore', count: 0, nextSeq: 1, ord: first ? first.value.ord - 1 : 0, deletedAt: null };
        }
        if (g.deletedAt != null && g.delReason === 'opened' && !gset.has(g.id)) { g.deletedAt = null; delete g.delReason; }
        const deltas = new Map();
        let added = 0;
        for (const it of rec.items) {
          if ((await req(s.items.getKey([g.id, it.seq]))) === undefined) {
            added++;
            const site = siteOfRec(it);
            deltas.set(site, (deltas.get(site) || 0) + 1);
          }
          s.items.put(it.e !== undefined || (it.site && it.tk != null) ? it : { ...it, site: it.site || siteOfUrl(it.url), tk: it.tk != null ? it.tk : titleKey(it.title, it.url) });
          if (it.seq >= g.nextSeq) g.nextSeq = it.seq + 1;
        }
        g.count += added;
        g.mtime = Date.now();
        await siteApply(s, g, deltas);
        s.groups.put(g);
        for (const rg of seqRanges(g.id, rec.items.map((x) => x.seq))) s.ix.add.push(rg);
        s.trash.delete(rec.tid);
        if (!touchedList.includes(g.id)) touchedList.push(g.id);
        n += added;
      }
      return { n };
    }, touchedList);
    recovered += r.n;
  };
  for (const rec of want) {
    const n = rec.n || (rec.items ? rec.items.length : 0);
    if (size && size + n > PURGE_CHUNK) await flush();
    batch.push(rec); size += n;
  }
  await flush();
  let groups = 0;
  for (const gid of gset) {
    const r = await undeleteGroup(gid);
    if (!r.error) groups++;
  }
  return { recovered, groups };
}

/** Trash records by tid (read-only; used to reopen their urls). */
export async function trashRecords(tids) {
  const set = new Set(tids);
  const all = await ro(['trash'], (s) => req(s.trash.getAll()));
  const hit = all.filter((r) => set.has(r.tid));
  return codec ? codec.trashRows(hit) : hit;
}

/** Legacy migration helper: puts items into the trash store with fresh seqs from the group's counter. */
export async function importTrashItems(gid, items, deletedAt) {
  return write(['groups', 'trash'], async (s) => {
    const g = await req(s.groups.get(gid));
    if (!g) return { error: 'notfound' };
    const recs = items.map((it) => {
      const title = String(it.title == null ? it.url : it.title).slice(0, MAX_TITLE);
      return { g: gid, seq: g.nextSeq++, url: it.url, title, ts: it.ts || Date.now(), t: searchText(title, it.url) };
    });
    s.groups.put(g);
    await req(s.trash.add({ kind: 'items', g: gid, items: recs, deletedAt: deletedAt || Date.now() }));
    return {};
  }, null);
}

// ---------- search-index support (read-only helpers used by search-worker.js; ixlogTrim is a SW write) ----------
export async function ixReadLog(afterId, limit = 200) {
  return ro(['ixlog'], (s) => req(s.ixlog.getAll(IDBKeyRange.lowerBound(afterId, true), limit)));
}

export async function ixMaxId() {
  return ro(['ixlog'], (s) => new Promise((resolve, reject) => {
    const r = s.ixlog.openCursor(null, 'prev');
    r.onsuccess = () => resolve(r.result ? r.result.key : 0);
    r.onerror = () => reject(r.error);
  }));
}

/** full item records for [[g, from, to]] ranges (inclusive), in key order */
export async function ixItemsRanges(ranges) {
  const rows = await ro(['items'], async (s) => {
    const out = [];
    for (const [g, from, to] of ranges) out.push(...(await req(s.items.getAll(IDBKeyRange.bound([g, from], [g, to])))));
    return out;
  });
  return codec ? codec.items(rows) : rows;
}

/** items after lastKey (null = from the start): one getAll batch for the index build */
export async function ixScanItems(lastKey, n) {
  const rows = await ro(['items'], (s) => req(s.items.getAll(lastKey ? IDBKeyRange.lowerBound(lastKey, true) : null, n)));
  return codec ? codec.items(rows) : rows;
}

/** item records for explicit keys [[g, seq]] (missing ones come back undefined) */
export async function ixGetItems(keys) {
  const rows = await ro(['items'], (s) => Promise.all(keys.map(([g, seq]) => req(s.items.get([g, seq])))));
  if (!codec) return rows;
  const got = await codec.items(rows.filter(Boolean));
  let i = 0;
  return rows.map((r) => (r ? got[i++] : r));
}

export async function ixAllGroups() {
  const rows = await ro(['groups'], (s) => req(s.groups.getAll()));
  return codec ? codec.groups(rows) : rows;
}

export async function ixItemCount() {
  return ro(['items'], (s) => req(s.items.count()));
}

/** drops change-log entries <= upto (the worker has a snapshot that includes them) */
export async function ixlogTrim(upto) {
  return write(['ixlog'], async (s) => { s.ixlog.delete(IDBKeyRange.upperBound(upto)); }, null, { quiet: true });
}

// ---------- categories (flat; ids are stable so they can be synced later) ----------
export async function listCategories() {
  let all = await ro(['categories'], (s) => req(s.categories.getAll()));
  if (codec) all = await codec.cats(all);
  return all.sort((a, b) => (a.ord || 0) - (b.ord || 0) || a.createdAt - b.createdAt);
}

const CAT_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export async function saveCategory(cat) {
  // default name in the language in use at the time (looked up BEFORE the transaction opens: awaiting inside it would end it)
  const defaultName = typeof cat.name === 'string' && cat.name.trim() ? '' : (await swStr()).newCategory;
  return write(['categories'], async (s) => {
    const now = Date.now();
    let rec = cat.id ? await req(s.categories.get(cat.id)) : null;
    if (rec && s.L) rec = await s.L.cat(rec);
    if (!rec) {
      const all = await req(s.categories.getAll());
      rec = { id: cat.id || newId(), name: '', color: 'blue', ord: all.length ? Math.max(...all.map((c) => c.ord || 0)) + 1 : 0, createdAt: now };
    }
    if (typeof cat.name === 'string') rec.name = cat.name.trim().slice(0, 80);
    if (CAT_COLORS.includes(cat.color)) rec.color = cat.color;
    if (typeof cat.ord === 'number' && isFinite(cat.ord)) rec.ord = cat.ord;
    if (!rec.name) rec.name = defaultName || 'New category';
    rec.mtime = now;
    s.categories.put(s.L ? await s.L.encCategory(rec) : rec);
    return rec;
  }, null);
}

export async function deleteCategory(id) {
  return write(['categories', 'groups'], async (s) => {
    s.categories.delete(id);
    const groups = await req(s.groups.getAll());
    const moved = [];
    for (const g of groups) if (g.cat === id) { g.cat = null; g.mtime = Date.now(); s.groups.put(g); moved.push(g.id); }
    return { moved };
  }, 'all');
}

export async function setGroupsCategory(gids, cat) {
  return write(['groups'], async (s) => {
    let n = 0;
    for (const gid of gids) {
      const g = await req(s.groups.get(gid));
      if (!g) continue;
      g.cat = cat == null ? null : String(cat);
      g.mtime = Date.now();
      s.groups.put(g);
      n++;
    }
    return { n };
  }, gids);
}

export async function reorderCategories(ids) {
  return write(['categories'], async (s) => {
    let i = 0;
    for (const id of ids) {
      const c = await req(s.categories.get(id));
      if (c) { c.ord = i++; c.mtime = Date.now(); s.categories.put(c); }
    }
    return {};
  }, null);
}

// ---------- per-site index reads / backfill ----------
export async function listSiteIdx() {
  const rows = await ro(['siteIdx'], (s) => req(s.siteIdx.getAll()));
  return codec ? codec.siteRows(rows) : rows;
}

let bfCache = null; // ids of the groups still to do (computed once per run, not once per step)
let bfTotal = 0;
const BF_PAGE = 5000;

/** One group: pages of 5000 items, ONE readwrite transaction per page (read + the `site` fixes), then siteIdx + agg. */
async function backfillGroup(gid) {
  const hist = new Map();
  let after = 0;
  for (;;) {
    const last = await write(['items'], async (s) => {
      const page = await req(s.items.getAll(groupRange(gid, after, true), BF_PAGE));
      for (const it of page) {
        let site = it.site;
        if (!site || it.tk == null) { site = site || siteOfUrl(it.url); it.site = site; it.tk = titleKey(it.title, it.url); s.items.put(it); }
        hist.set(site, (hist.get(site) || 0) + 1);
      }
      return page.length === BF_PAGE ? page[page.length - 1].seq : -1;
    }, null, { quiet: true });
    if (last < 0) break;
    after = last;
  }
  await write(['groups', 'siteIdx'], async (s) => {
    const cur = await req(s.groups.get(gid));
    if (!cur) return;
    await siteDropGroup(s, gid);
    const rows = [...hist].map(([site, n]) => ({ site, g: gid, n })).sort((x, y) => y.n - x.n);
    for (const r of rows) s.siteIdx.put(r);
    cur.agg = { top: rows.slice(0, 5).map((r) => [r.site, r.n]), nSites: rows.length, nTg: (cur.tabGroups && cur.tabGroups.length) || 0 };
    s.groups.put(cur);
  }, null, { quiet: true });
}

/**
 * Backfills `site` on old items and builds siteIdx + group.agg for pending groups (groups without `agg`), as many as fit in budgetMs.
 * Resumable by construction (a processed group has agg). Quiet: no rev bump, no search-index log (item text is unchanged).
 * Returns {done, remaining, total}.
 */
export async function backfillStep({ budgetMs = 150 } = {}) {
  if (codec) return { done: true, remaining: 0, total: 0 }; // lock on: tokens + summaries are built by the seal / migration jobs
  const t0 = performance.now();
  if (!bfCache || !bfCache.length) {
    const groups = await ro(['groups'], (s) => req(s.groups.getAll()));
    bfTotal = groups.length;
    bfCache = groups.filter((g) => !g.agg && g.phase !== 'writing').map((g) => g.id);
  }
  while (bfCache.length && performance.now() - t0 < budgetMs) await backfillGroup(bfCache.shift());
  return { done: !bfCache.length, remaining: bfCache.length, total: bfTotal };
}

// ---------- crash-recovery snapshots ----------
export async function snapPut(rec) {
  if (codec && codec.encodeSnapshotRow) { // password lock on: encrypted to the public key (works while locked); the header counts stay plain
    for (let attempt = 0; attempt < 5; attempt++) {
      await codec.prep();
      const maxKid = await ro(['ekeys'], (s) => new Promise((resolve, reject) => { const r = s.ekeys.openKeyCursor(null, 'prev'); r.onsuccess = () => resolve(r.result ? r.result.key : 0); r.onerror = () => reject(r.error); }));
      const kid = codec.nextKid(maxKid);
      const enc = await codec.encodeSnapshotRow(rec, kid);
      const ok = await write(['snapshots'], async (s) => {
        if ((await req(s.ekeys.getKey(kid))) !== undefined) return false;
        s.ekeys.put(enc.ekey);
        s.snapshots.put(enc.row);
        return true;
      }, null, { quiet: true });
      if (ok) return;
    }
    throw new Error('snapPut: key id conflict');
  }
  return write(['snapshots'], async (s) => { s.snapshots.put(rec); }, null, { quiet: true });
}

/** Metadata of every snapshot (the gzip body is NOT returned). */
export async function snapList() {
  const all = await ro(['snapshots'], (s) => req(s.snapshots.getAll()));
  const heads = codec ? await Promise.all(all.map((r) => codec.snapMeta(r))) : all;
  return heads.map(({ gz, ...m }) => ({ ...m, bytes: m.enc ? m.bytes : (gz ? gz.byteLength : 0) })).sort((a, b) => b.ts - a.ts);
}

export async function snapGet(id) {
  const r = (await ro(['snapshots'], (s) => req(s.snapshots.get(id)))) || null;
  return codec && r ? codec.snap(r) : r;
}

export async function snapDelete(id) {
  await write(['snapshots'], async (s) => { s.snapshots.delete(id); }, null, { quiet: true });
  if (codec) await gcEkeysOnce();
}

/** Lock on: batch keys nothing refers to any more (no inbox row, no group / snapshot with that k) are deleted. */
async function gcEkeysOnce() {
  await write(['ekeys', 'inbox', 'groups', 'snapshots'], async (s) => {
    const used = new Set();
    for (const r of await req(s.inbox.getAll())) for (const k of r.kids || []) used.add(k);
    for (const r of await req(s.groups.getAll())) if (r.k > 0) used.add(r.k);
    for (const r of await req(s.snapshots.getAll())) if (r.k > 0) used.add(r.k);
    for (const r of await req(s.ekeys.getAll())) if (!used.has(r.kid) && !r.keep) s.ekeys.delete(r.kid);
  }, null, { quiet: true });
}

/** Tiered retention for auto snapshots (see snapfmt.planAutoTrim); the newest pre-close one and the newest `keepManual` manual ones. */
export async function snapTrim(_keepAuto, keepManual, now = Date.now()) {
  const list = await snapList();
  const drop = planAutoTrim(list.filter((m) => (m.kind || 'auto') === 'auto'), now);
  const lim = { 'pre-close': 1, manual: keepManual };
  const seen = { 'pre-close': 0, manual: 0 };
  for (const m of list) if (m.kind in lim && ++seen[m.kind] > lim[m.kind]) drop.push(m.id);
  if (drop.length) await write(['snapshots'], async (s) => { for (const id of drop) s.snapshots.delete(id); }, null, { quiet: true });
  if (drop.length && codec) await gcEkeysOnce();
}

/**
 * Resumable background fill of `tk` (+ `site`) on items written before DB v6 so the sparse byTk / bySite indexes cover them.
 * Quiet writes (no rev bump, no log). meta.tkDone short-circuits every later start. Returns {done, scanned}.
 */
let tkAfter = null;
export async function backfillTkStep({ budgetMs = 120, page = 2000 } = {}) {
  if (codec) return { done: true, scanned: 0 };
  const m = await getMeta();
  if (m.tkDone) return { done: true, scanned: 0 };
  const t0 = performance.now();
  let scanned = 0;
  while (performance.now() - t0 < budgetMs) {
    const r = await write(['items'], async (s) => {
      const recs = await req(s.items.getAll(tkAfter ? IDBKeyRange.lowerBound(tkAfter, true) : null, page));
      for (const it of recs) if (it.tk == null || !it.site) { if (!it.site) it.site = siteOfUrl(it.url); it.tk = titleKey(it.title, it.url); s.items.put(it); }
      return recs.length ? { last: [recs[recs.length - 1].g, recs[recs.length - 1].seq], n: recs.length } : null;
    }, null, { quiet: true });
    if (!r) { await metaQuiet((mm) => { mm.tkDone = true; }); tkAfter = null; return { done: true, scanned }; }
    tkAfter = r.last;
    scanned += r.n;
  }
  return { done: false, scanned };
}

// ---------- meta ----------
export async function setMeta(patch) {
  return write([], async (_s, meta) => { Object.assign(meta, patch); }, null);
}

/** Meta bookkeeping without rev bump / bus event / vault dirtying (job + drain counters). */
export async function metaQuiet(fn) {
  return write([], async (_s, meta) => fn(meta), null, { quiet: true });
}

export async function clearVaultDirty(gids, atRev) {
  return write([], async (_s, meta) => {
    if (meta.rev !== atRev) return false; // something changed meanwhile: stay dirty
    const drop = new Set(gids);
    meta.vaultDirty = (meta.vaultDirty || []).filter((g) => !drop.has(g));
    return true;
  }, null, { quiet: true });
}

/** The vault copy of these purged groups is gone: forget the tombstones. */
export async function clearVaultPurged(gids) {
  return write([], async (_s, meta) => {
    const drop = new Set(gids);
    meta.vaultPurged = (meta.vaultPurged || []).filter((g) => !drop.has(g));
    return true;
  }, null, { quiet: true });
}

// ---------- drain ----------
export async function drainAllTabIds() {
  return new Set(await ro(['drain'], (s) => req(s.drain.getAllKeys())));
}

/** Plain put of drain records (inert until meta.drain references the job). */
export async function createDrain(records) {
  needWriter();
  const db = await openDB();
  const t = db.transaction(['drain'], 'readwrite', { durability: 'strict' });
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
  const st = t.objectStore('drain');
  for (const r of records) st.put(r);
  await done;
}

/** Atomically: every group's phase -> draining, meta.drain (or queue entry), lastStash. job.gids = all groups of the job. */
export async function beginDrain(job, windowId, session) {
  const gids = job.gids || [job.gid];
  return write(['groups'], async (s, meta) => {
    for (const gid of gids) {
      const g = await req(s.groups.get(gid));
      if (!g) throw new Error('notfound');
      g.phase = 'draining';
      s.groups.put(g);
    }
    meta.lastStash = { groupId: gids[0], groupIds: gids, windowId, at: Date.now() };
    const entry = {
      job: job.job, gid: gids[0], gids, total: job.total, closed: 0, skipped: 0, discarded: 0, level: 'healthy',
      paused: false, cancelled: false, dropRemaining: false, needsConfirm: false,
      startedAt: Date.now(), browserSession: session, lastProgressAt: Date.now(), windowId,
    };
    if (meta.drain) {
      meta.drain.queue = (meta.drain.queue || []).concat({ ...entry });
    } else {
      meta.drain = { ...entry, queue: [] };
    }
    return { active: !meta.drain.queue.some((q) => q.job === job.job) };
  }, gids);
}

/** drainBatch(job, state, n): records in priority order. */
export async function drainBatch(job, state, n) {
  const range = IDBKeyRange.bound([job, state, -Infinity], [job, state, Infinity]);
  return ro(['drain'], (s) => req(s.drain.index('by_jsp').getAll(range, n)));
}

export async function drainRecords(job, state) {
  const range = IDBKeyRange.bound([job, state, -Infinity], [job, state, Infinity]);
  return ro(['drain'], (s) => req(s.drain.index('by_jsp').getAll(range)));
}

export async function drainCount(job, state) {
  const range = IDBKeyRange.bound([job, state, -Infinity], [job, state, Infinity]);
  return ro(['drain'], (s) => req(s.drain.index('by_jsp').count(range)));
}

export async function drainAllForJob(job) {
  return ro(['drain'], (s) => req(s.drain.index('by_job').getAll(job)));
}

/** put/del drain records and patch meta.drain in ONE quiet transaction. */
export async function drainApply({ put = [], del = [], patch } = {}) {
  return write(['drain'], async (s, meta) => {
    for (const k of del) s.drain.delete(k);
    for (const r of put) s.drain.put(r);
    if (patch && meta.drain) patch(meta.drain, meta);
  }, null, { quiet: true });
}

/** Removes a job's records, commits its group, shifts the queue. Returns {closed, skipped, skippedList}. */
export async function finishDrain(job) {
  const m0 = await getMeta();
  const touched = m0.drain && m0.drain.job === job ? (m0.drain.gids || [m0.drain.gid]) : null;
  return write(['groups', 'drain'], async (s, meta) => {
    const keys = await req(s.drain.index('by_job').getAllKeys(job));
    const recs = await req(s.drain.index('by_job').getAll(job));
    const skippedList = recs.filter((r) => r.state === 'skipped').slice(0, 200).map((r) => ({ url: r.url, reason: r.reason }));
    for (const k of keys) s.drain.delete(k);
    const d = meta.drain;
    const gids = d && d.job === job ? (d.gids || [d.gid]) : (recs[0] ? [recs[0].gid] : []);
    for (const gid of gids) {
      const g = await req(s.groups.get(gid));
      if (g && g.phase === 'draining') { g.phase = 'committed'; s.groups.put(g); }
    }
    const gid = gids[0];
    const res = { closed: d ? d.closed : 0, skipped: d ? d.skipped : 0, skippedList, gid };
    if (d && d.job === job) {
      const q = d.queue || [];
      if (q.length) {
        const next = q[0];
        meta.drain = { ...next, queue: q.slice(1), startedAt: Date.now(), lastProgressAt: Date.now() };
      } else meta.drain = null;
    }
    meta.lastDrainResult = { ...res, at: Date.now() };
    return res;
  }, touched);
}

// ---------- integrity & recovery ----------
/** Group counters vs real record counts. Returns the number of groups corrected. */
export async function integrityCheck() {
  const groups = await ro(['groups'], (s) => req(s.groups.getAll()));
  let fixed = 0;
  for (const g of groups) {
    const c = await countItems(g.id);
    if (c !== g.count) {
      fixed++;
      await write(['groups'], async (s) => {
        const cur = await req(s.groups.get(g.id));
        if (cur) { cur.count = c; s.groups.put(cur); }
      }, [g.id]);
    }
  }
  return fixed;
}

/**
 * Startup recovery: partial 'writing' groups are purged (no tab was ever closed for them); orphan drain records
 * are removed; a 'draining' group with no live job becomes committed.
 */
export async function recoverPending() {
  const meta = await getMeta();
  const jobs = new Set();
  if (meta.drain) {
    jobs.add(meta.drain.job);
    for (const q of meta.drain.queue || []) jobs.add(q.job);
  }
  const groups = await ro(['groups'], (s) => req(s.groups.getAll()));
  for (const g of groups) {
    if (g.phase === 'writing') await purgeGroup(g.id, { force: true });
  }
  const live = new Set();
  if (meta.drain) {
    for (const x of [meta.drain, ...(meta.drain.queue || [])]) for (const gid of x.gids || [x.gid]) live.add(gid);
  }
  for (const g of groups) {
    if (g.phase === 'draining' && !live.has(g.id)) await setPhase(g.id, 'committed');
  }
  const orphanKeys = await ro(['drain'], async (s) => {
    const recs = await req(s.drain.getAll());
    return recs.filter((r) => !jobs.has(r.job)).map((r) => r.tabId);
  });
  if (orphanKeys.length) await drainApply({ del: orphanKeys });
}

export async function deleteDatabase() {
  if (dbp) { try { (await dbp).close(); } catch { /* ignore */ } dbp = null; }
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

// ---------- cross-device sync support (see lib/syncstore.js) ----------
export { req, groupRange, siteApply, siteDropGroup };
/** Remote-apply write: like a local write but never marks groups sync-dirty (no echo into the outbox). */
export function writeRemote(names, fn, changed, quiet = false) { return write(names, fn, changed, quiet ? { quiet: true, noSync: true } : { noSync: true }); }
export function readRaw(names, fn) { return ro(names, fn); }

// ---------- password lock plumbing (lib/lockrt.js, lib/lockctl.js) ----------
/** meta.lock row or null. Never passed through the record decoders (its `k` is the string 'lock'). */
export async function getLockRow() { return (await ro(['meta'], (s) => req(s.meta.get('lock')))) || null; }
/** ekeys row for an inbox batch key id (undefined when gone: the record then decodes as damaged). */
export async function getEkey(kid) { return ro(['ekeys'], (s) => req(s.ekeys.get(kid))); }
/** Decoders for rows read through readRaw (flat view). Identity while the lock is off. */
export const decodeItems = (rows) => (codec ? codec.items(rows) : rows);
export function newGroupId() { return newId(); }
export { searchText, siteOfUrl, tgOf, cleanTabGroups, titleKey };
export async function syncDirtyTake() {
  const m = await getMeta();
  return { dirty: (m.syncDirty || []).slice(), purged: (m.syncPurged || []).slice(), rev: m.rev };
}
/** Drops scanned groups; only when nothing else changed meanwhile (else they simply get scanned again: the scan is idempotent). */
export async function syncDirtyDone(gids, purged, atRev) {
  return write([], async (_s, meta) => {
    const pg = new Set(purged);
    meta.syncPurged = (meta.syncPurged || []).filter((g) => !pg.has(g)); // purge ops are idempotent: always dropped
    if (meta.rev !== atRev) return false;
    const d = new Set(gids);
    meta.syncDirty = (meta.syncDirty || []).filter((g) => !d.has(g));
    return true;
  }, null, { quiet: true });
}
/** The vault copies must be rewritten (password lock turned on / off): every group becomes dirty again (same transaction as nothing else; quiet). */
export async function vaultMarkAllDirty() {
  return write(['groups'], async (s, meta) => {
    const ids = await req(s.groups.getAllKeys());
    meta.vaultDirty = Array.from(new Set([...(meta.vaultDirty || []), ...ids]));
  }, null, { quiet: true });
}
export async function syncMarkAllDirty() {
  return write(['groups'], async (s, meta) => {
    const ids = await req(s.groups.getAllKeys());
    meta.syncDirty = Array.from(new Set([...(meta.syncDirty || []), ...ids]));
  }, null);
}

// ---------- per-site index: consistency check (+ dev helpers) ----------
/**
 * Compares siteIdx / group.agg with the items. Cheap mode (default) checks per group: sum(siteIdx.n) === group.count === count(items).
 * deep = true also recounts every item's site. Soft-deleted groups keep their rows (they are real items): reported separately,
 * which is why "sum(siteIdx) - live items" differs by the items of trashed sessions.
 */
export async function siteIdxCheck({ deep = false } = {}) {
  const groups = await ro(['groups'], (s) => req(s.groups.getAll()));
  const idx = await ro(['siteIdx'], (s) => req(s.siteIdx.getAll()));
  const byG = new Map();
  for (const r of idx) { let m = byG.get(r.g); if (!m) byG.set(r.g, m = new Map()); m.set(r.site, r.n); }
  const bad = [];
  let sumLive = 0; let sumDeleted = 0; let liveItems = 0; let deletedItems = 0; let pending = 0;
  for (const g of groups) {
    if (g.purging) continue; // half-purged (resumable purge): its index rows are already gone
    if (!g.agg) { pending++; continue; }
    const m = byG.get(g.id) || new Map();
    let n = 0; for (const v of m.values()) n += v;
    const real = await ro(['items'], (s) => req(s.items.count(groupRange(g.id))));
    if (g.deletedAt == null) { sumLive += n; liveItems += real; } else { sumDeleted += n; deletedItems += real; }
    if (n !== real || g.count !== real) bad.push({ g: g.id, idx: n, count: g.count, items: real });
    else if (deep) {
      const hist = new Map();
      let after = 0;
      for (;;) {
        const page = await getItemsPage(g.id, after, 5000);
        if (!page.length) break;
        for (const it of page) { const st = it.site || siteOfUrl(it.url); hist.set(st, (hist.get(st) || 0) + 1); }
        after = page[page.length - 1].seq;
        if (page.length < 5000) break;
      }
      for (const [st, c] of hist) if (m.get(st) !== c) { bad.push({ g: g.id, site: st, idx: m.get(st) || 0, items: c }); break; }
      for (const st of m.keys()) if (!hist.has(st)) { bad.push({ g: g.id, site: st, idx: m.get(st), items: 0 }); break; }
    }
  }
  const orphanGroups = [...byG.keys()].filter((id) => !groups.some((g) => g.id === id));
  return { ok: !bad.length && !orphanGroups.length, groups: groups.length, pending, bad: bad.slice(0, 20), badCount: bad.length, orphanGroups: orphanGroups.slice(0, 20), sumLive, liveItems, sumDeleted, deletedItems };
}

/** DEV: forgets the per-site index (site on items, agg, siteIdx) so the backfill can be timed. */
export async function debugStripSite() {
  const groups = await ro(['groups'], (s) => req(s.groups.getAll()));
  await write(['siteIdx'], async (s) => { s.siteIdx.clear(); }, null, { quiet: true });
  let n = 0;
  for (const g of groups) {
    let after = 0;
    for (;;) {
      const page = await getItemsPage(g.id, after, 5000);
      if (!page.length) break;
      await write(['items'], async (s) => { for (const it of page) { delete it.site; delete it.tk; s.items.put(it); } }, null, { quiet: true });
      n += page.length;
      after = page[page.length - 1].seq;
      if (page.length < 5000) break;
    }
    await write(['groups'], async (s) => { const cur = await req(s.groups.get(g.id)); if (cur) { delete cur.agg; s.groups.put(cur); } }, null, { quiet: true });
  }
  return { items: n, groups: groups.length };
}

// ---------- activity (local-only usage stats; every write goes through lib/activity.js, which checks A.on) ----------
/** One readwrite transaction on the activity store. fn(store) may be async. No rev bump, no events. */
export async function actTx(fn) {
  return write(['activity'], async (s) => fn(s.activity), null, { quiet: true });
}
export async function actRowsFrom(lo, hi) {
  return ro(['activity'], (s) => req(s.activity.getAll(IDBKeyRange.bound(lo, hi))));
}
export async function actCounts() {
  return ro(['activity', 'groups'], async (s) => {
    const rng = (p) => IDBKeyRange.bound(p, p + '\uffff');
    const [days, weeks, events] = await Promise.all([req(s.activity.count(rng('d:'))), req(s.activity.count(rng('w:'))), req(s.activity.count(rng('e:')))]);
    const gs = await req(s.groups.getAll());
    let tracked = 0;
    for (const g of gs) if (g.tm && g.deletedAt == null) tracked += g.tm.n || 0;
    return { days, weeks, events, tracked, sessions: gs.length };
  });
}
/** Test/audit: every row of the activity store */
export async function actDumpAll() { return ro(['activity'], (s) => req(s.activity.getAll())); }

/**
 * Resumable purge of all usage data. State lives in meta.purgeJob = {phase, cursor, done}. One bounded step per call;
 * returns {finished, phase, done}. Phases: act -> groups -> items -> trash -> snap (snapshots are handled by lib/activity.js).
 */
export async function actPurgeStep(limit = 2000) {
  return write(['activity', 'groups', 'items', 'trash'], async (s, meta) => {
    const job = meta.purgeJob || { phase: 'act', cursor: null, done: 0 };
    if (job.phase === 'act') {
      s.activity.clear();
      job.phase = 'groups';
    } else if (job.phase === 'groups') {
      const gs = await req(s.groups.getAll());
      for (const g of gs) if ('tm' in g || 'rc' in g) { delete g.tm; delete g.rc; s.groups.put(g); }
      job.phase = 'items';
    } else if (job.phase === 'items' || job.phase === 'trash') {
      const store = job.phase === 'items' ? s.items : s.trash;
      const lim = job.phase === 'items' ? limit : 200;
      const rng = job.cursor != null ? IDBKeyRange.lowerBound(job.cursor, true) : undefined;
      let n = 0;
      let last = null;
      await new Promise((resolve, reject) => {
        const r = store.openCursor(rng);
        r.onsuccess = () => {
          const c = r.result;
          if (!c || n >= lim) { resolve(); return; }
          n++;
          last = c.primaryKey;
          const v = c.value;
          if (job.phase === 'items') { if (v.d !== undefined) { delete v.d; c.update(v); } } else if (Array.isArray(v.items) && v.items.some((x) => x && x.d !== undefined)) { for (const x of v.items) if (x) delete x.d; c.update(v); }
          c.continue();
        };
        r.onerror = () => reject(r.error);
      });
      if (job.phase === 'items') job.done += n;
      if (n < lim) { job.phase = job.phase === 'items' ? 'trash' : 'snap'; job.cursor = null; } else job.cursor = last;
    }
    const finished = job.phase === 'snap';
    meta.purgeJob = job; // stays until actPurgeEnd(): the snapshot pass (lib/activity.js) must also survive a worker kill
    if (finished) delete meta.ramCal;
    return { finished, phase: job.phase, done: job.done };
  }, null, { quiet: true });
}
/** the whole purge (including the snapshot pass) is done */
export async function actPurgeEnd() { return metaQuiet(async (meta) => { meta.purgeJob = null; delete meta.ramCal; }); }
export async function actPurgeBegin() {
  return metaQuiet(async (meta) => { if (!meta.purgeJob) meta.purgeJob = { phase: 'act', cursor: null, done: 0 }; });
}
