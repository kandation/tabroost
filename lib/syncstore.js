// IndexedDB binding of the sync core (lib/sync/*): the merge store, the persistent kv / key store of the engine and the
// LOCAL CHANGE SCANNER that turns "group X changed" (meta.syncDirty, written in the same transaction as the change)
// into sync ops (engine.stamp + engine.recordLocal).
//
//  - stable ids: a group's id is its `id`; an item gets a random `iid` lazily (first scan) kept on the item record and in the
//    syiid index (iid -> [g, seq]); sy rows hold the merge metadata {fh, purged} and `v` = the last synced field values.
//  - remote changes are applied with db.writeRemote(): they never mark groups dirty, so they never re-enter the outbox.
//  - the scan is idempotent (diff against `v`): a crash between recording and bookkeeping just repeats harmless LWW ops.
//  - password lock ON: groups / items are written through the lock's encoders (`s.L`, see lib/lockrt.js), the `v` copies are sealed
//    (`sy.ve`, lib/syncseal.js), a row that cannot be decoded is NEVER written back or sent (sentinel rows are skipped).
//    Everything here only runs while the lock is open; the controller (lib/synccontrol.js) stands still while it is locked.
import * as db from './db.js';
import { lockAdapter } from './synclockrt.js';
import { packV, readV, LockedError } from './syncseal.js';
import { TAB_GROUP_COLORS, cleanLook } from './formats.js';

const { req, groupRange } = db;
const LOCK = lockAdapter;
const needKeys = (s) => { if (s.L && s.L.locked) throw new LockedError('locked'); };
const gGet = async (s, id) => { const r = await req(s.groups.get(id)); return s.L && r ? s.L.group(r) : r; };
const gPut = async (s, g) => { s.groups.put(s.L ? await s.L.encGroup(g) : g); };

// ---------- engine persistent state + key ----------
export function createKv() {
  return {
    async get(k) { const r = await db.readRaw(['sykv'], (s) => req(s.sykv.get(k))); return r ? r.v : undefined; },
    async set(k, v) { await db.writeRemote(['sykv'], async (s) => { s.sykv.put({ k, v }); }, null, true); },
    async setMany(o) { await db.writeRemote(['sykv'], async (s) => { for (const k of Object.keys(o)) s.sykv.put({ k, v: o[k] }); }, null, true); },
    async del(keys) { await db.writeRemote(['sykv'], async (s) => { for (const k of [].concat(keys)) s.sykv.delete(k); }, null, true); },
    async keys() { return db.readRaw(['sykv'], (s) => req(s.sykv.getAllKeys())); },
  };
}
/** The DEK is a NON-extractable CryptoKey: structured-cloned straight into IndexedDB (never serialised, never in chrome.storage). */
export function createKeyStore(kv) {
  return { get: () => kv.get('dek'), set: (k) => kv.set('dek', k), del: () => kv.del('dek') };
}

// ---------- field mapping ----------
export function groupFields(g) {
  return {
    title: g.title || '', starred: !!g.starred, locked: !!g.locked, ord: g.ord, del: g.deletedAt == null ? null : g.deletedAt,
    createdAt: g.createdAt, windowCount: g.windowCount > 1 ? g.windowCount : 1, tabGroups: g.tabGroups && g.tabGroups.length ? g.tabGroups : null,
    // protocol 2: the rest of what the user sets on a tab set
    pinned: !!g.pinned, archived: !!g.archived, pending: !!g.pending, note: typeof g.note === 'string' ? g.note : '',
    color: g.color || null, emoji: g.emoji || null, cat: g.cat || null,
  };
}
/** What "never set" means for the fields added in protocol 2: a default is not a change (a freshly upgraded device must not overwrite what other devices already set). */
export const GROUP_DEFAULTS = { pinned: false, archived: false, pending: false, note: '', color: null, emoji: null, cat: null };
export const CAT_FIELDS = ['name', 'color', 'ord', 'createdAt'];
export const catFields = (c) => ({ name: c.name || '', color: c.color || 'blue', ord: typeof c.ord === 'number' ? c.ord : 0, createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0 });
function itemFields(rec, gid) {
  const f = { g: gid, url: rec.url, title: rec.title, ts: rec.ts };
  if (rec.w > 0) { f.w = rec.w; if (rec.ws) f.ws = true; }
  if (rec.tg !== undefined && rec.tg >= 0) f.tg = rec.tg;
  if (rec.sv !== undefined && rec.sv >= 0) f.sv = rec.sv;
  return f;
}
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// ---------- merge store ----------
/** opts.prefs: () => the preferences sync (lib/sync/prefs.js createPrefsSync), looked up on use because it needs the engine, which needs this store. */
export function createMergeStore(o = {}) {
  const key = (t, id) => t + id;
  const putV = async (s, t, id, v) => {
    const k = key(t, id);
    const r = (await req(s.sy.get(k))) || { k, fh: {}, purged: false };
    if (s.L) { needKeys(s); r.ve = { __sy: 1, ...(await s.L.encBlob('sy:v:' + k, v)) }; delete r.v; } else { r.v = v; delete r.ve; }
    s.sy.put(r);
  };
  const applyGroupFields = (g, f) => {
    if (f.title !== undefined) g.title = String(f.title || '').slice(0, 500);
    if (f.starred !== undefined) g.starred = !!f.starred;
    if (f.locked !== undefined) g.locked = !!f.locked;
    if (f.ord !== undefined && typeof f.ord === 'number') g.ord = f.ord;
    if (f.del !== undefined) g.deletedAt = f.del == null ? null : f.del;
    if (f.createdAt !== undefined && typeof f.createdAt === 'number') { g.createdAt = f.createdAt; delete g.ph; }
    if (f.windowCount !== undefined) g.windowCount = f.windowCount > 1 ? f.windowCount : 1;
    if (f.tabGroups !== undefined) { const t = db.cleanTabGroups(f.tabGroups || []); if (t.length) g.tabGroups = t; else delete g.tabGroups; }
    if (f.pinned !== undefined) g.pinned = !!f.pinned;
    if (f.archived !== undefined) g.archived = !!f.archived;
    if (f.pending !== undefined) g.pending = !!f.pending;
    if (f.note !== undefined) { const n = typeof f.note === 'string' ? f.note.slice(0, 2000) : ''; if (n) g.note = n; else delete g.note; }
    if (f.color !== undefined) { const l = cleanLook({ color: f.color }); if (l.color) g.color = l.color; else delete g.color; }
    if (f.emoji !== undefined) { const l = cleanLook({ emoji: f.emoji }); if (l.emoji) g.emoji = l.emoji; else delete g.emoji; }
    if (f.cat !== undefined) g.cat = f.cat == null || f.cat === '' ? null : String(f.cat).slice(0, 64);
    g.mtime = Date.now();
  };
  const applyCatFields = (c, f) => {
    if (typeof f.name === 'string') c.name = f.name.trim().slice(0, 80) || c.name || 'New category';
    if (TAB_GROUP_COLORS.includes(f.color)) c.color = f.color;
    if (typeof f.ord === 'number' && isFinite(f.ord)) c.ord = f.ord;
    if (typeof f.createdAt === 'number' && isFinite(f.createdAt)) c.createdAt = f.createdAt;
    c.mtime = Date.now();
  };
  return {
    async getMeta(t, id) {
      const r = await db.readRaw(['sy'], (s) => req(s.sy.get(key(t, id))));
      return r ? { fh: r.fh || {}, purged: !!r.purged } : undefined;
    },
    async setMeta(t, id, m) {
      await db.writeRemote(['sy'], async (s) => {
        const k = key(t, id);
        const r = (await req(s.sy.get(k))) || { k };
        s.sy.put({ ...r, k, fh: m.fh, purged: !!m.purged });
      }, null, true);
    },
    async hasEntity(t, id) {
      if (t === 's') return true; // one entity that always exists (nothing to create)
      if (t === 'c') return !!(await db.readRaw(['categories'], (s) => req(s.categories.getKey(id))));
      if (t === 'g') return !!(await db.readRaw(['groups'], (s) => req(s.groups.getKey(id))));
      return !!(await db.readRaw(['syiid'], (s) => req(s.syiid.getKey(id))));
    },
    async createEntity(t, id, f, opts = {}) {
      if (t === 's') { const p = o.prefs && o.prefs(); if (p) await p.apply(f); return; }
      if (t === 'c') {
        await db.writeRemote(['categories', 'sy'], async (s) => {
          needKeys(s);
          if (await req(s.categories.getKey(id))) return;
          const c = { id, name: '', color: 'blue', ord: 0, createdAt: Date.now() };
          applyCatFields(c, f);
          if (!c.name) c.name = 'New category';
          s.categories.put(s.L ? await s.L.encCategory(c) : c);
          await putV(s, 'c', id, catFields(c));
        }, null);
        return;
      }
      if (t === 'g') {
        await db.writeRemote(['groups', 'sy'], async (s) => {
          needKeys(s);
          if (await req(s.groups.getKey(id))) return;
          const g = {
            id, createdAt: 0, title: '', phase: 'committed', starred: false, locked: false, source: 'sync', count: 0, nextSeq: 1,
            windowCount: 1, mtime: Date.now(), ord: 0, deletedAt: null,
          };
          if (opts.placeholder) g.ph = true;
          applyGroupFields(g, f);
          await gPut(s, g);
          await putV(s, 'g', id, groupFields(g));
        }, [id]);
        return;
      }
      if (!f.g) return;
      await db.writeRemote(['groups', 'items', 'siteIdx', 'sy', 'syiid'], async (s) => {
        needKeys(s);
        const g = await gGet(s, f.g);
        if (!g || g.corrupt) return; // group purged: nothing to attach to (a damaged group is left alone)
        if (await req(s.syiid.getKey(id))) return;
        const title = String(f.title == null ? f.url : f.title).slice(0, 2000);
        const site = db.siteOfUrl(f.url);
        const rec = { g: f.g, seq: g.nextSeq++, url: f.url, title, ts: f.ts || Date.now(), site, iid: id };
        if (!s.L) { rec.t = db.searchText(title, f.url); rec.tk = db.titleKey(title, f.url); }
        if (f.w > 0) rec.w = f.w;
        if (typeof f.tg === 'number' && f.tg >= 0) rec.tg = f.tg;
        if (typeof f.sv === 'number' && f.sv >= 0) rec.sv = f.sv;
        if (f.ws === true && rec.w > 0) rec.ws = true;
        s.items.put(s.L ? await s.L.encItem(rec) : rec);
        s.syiid.put({ iid: id, g: f.g, seq: rec.seq });
        g.count += 1;
        await db.siteApply(s, g, new Map([[s.L ? await s.L.siteKey(site) : site, 1]]));
        g.mtime = Date.now();
        await gPut(s, g);
        s.ix.add.push([f.g, rec.seq, rec.seq]);
        await putV(s, 'i', id, itemFields(rec, f.g));
      }, [f.g]);
    },
    async updateEntity(t, id, f) {
      if (t === 's') { const p = o.prefs && o.prefs(); if (p) await p.apply(f); return; }
      if (t === 'c') {
        await db.writeRemote(['categories', 'sy'], async (s) => {
          needKeys(s);
          let c = await req(s.categories.get(id));
          if (!c) return;
          if (s.L) c = await s.L.cat(c);
          if (!c || c.corrupt) return; // never write a sentinel over a row that could not be decoded
          applyCatFields(c, f);
          s.categories.put(s.L ? await s.L.encCategory(c) : c);
          await putV(s, 'c', id, catFields(c));
        }, null);
        return;
      }
      if (t === 'g') {
        await db.writeRemote(['groups', 'sy'], async (s) => {
          needKeys(s);
          const g = await gGet(s, id);
          if (!g || g.corrupt) return; // never write a sentinel over a row that could not be decoded
          applyGroupFields(g, f);
          await gPut(s, g);
          await putV(s, 'g', id, groupFields(g));
        }, [id]);
        return;
      }
      await db.writeRemote(['groups', 'items', 'sy', 'syiid'], async (s, meta) => {
        const ref = await req(s.syiid.get(id));
        if (!ref) return;
        const raw = await req(s.items.get([ref.g, ref.seq]));
        if (!raw) return;
        const wasEnc = !!s.L && raw.e !== undefined;
        if (s.L) needKeys(s);
        const rec = wasEnc ? await s.L.item(raw) : raw;
        if (rec.corrupt) return; // never write a sentinel over a row that could not be decoded
        vd(meta, ref.g);
        if (f.title !== undefined) { rec.title = String(f.title == null ? rec.url : f.title).slice(0, 2000); if (!wasEnc) { rec.t = db.searchText(rec.title, rec.url); rec.tk = db.titleKey(rec.title, rec.url); } }
        if (f.ts !== undefined) rec.ts = f.ts;
        if (f.w !== undefined) { if (f.w > 0) rec.w = f.w; else delete rec.w; }
        if (f.tg !== undefined) { if (typeof f.tg === 'number' && f.tg >= 0) rec.tg = f.tg; else delete rec.tg; }
        if (f.sv !== undefined) { if (typeof f.sv === 'number' && f.sv >= 0) rec.sv = f.sv; else delete rec.sv; }
        if (f.ws !== undefined) { if (f.ws === true && rec.w > 0) rec.ws = true; else delete rec.ws; }
        s.items.put(wasEnc ? await s.L.encItem(rec) : rec);
        s.ix.del.push([ref.g, ref.seq, ref.seq]);
        s.ix.add.push([ref.g, ref.seq, ref.seq]);
        await putV(s, 'i', id, itemFields(rec, ref.g));
      }, null);
    },
    async purgeEntity(t, id) {
      if (t === 's') return;
      if (t === 'c') {
        // like db.deleteCategory: the category goes, its tab sets become "no category" (they are re-written, so they are dirty for the vault copy)
        await db.writeRemote(['categories', 'groups'], async (s) => {
          s.categories.delete(id);
          const moved = [];
          for (const g of await req(s.groups.getAll())) if (g.cat === id) { g.cat = null; g.mtime = Date.now(); s.groups.put(g); moved.push(g.id); }
          return moved;
        }, 'all');
        return;
      }
      if (t === 'g') {
        await db.writeRemote(['groups', 'items', 'siteIdx', 'syiid'], async (s) => {
          if (!(await req(s.groups.getKey(id)))) return;
          s.items.delete(groupRange(id));
          await db.siteDropGroup(s, id);
          await new Promise((resolve, reject) => {
            const r = s.syiid.index('byG').openKeyCursor(IDBKeyRange.only(id));
            r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; } s.syiid.delete(c.primaryKey); c.continue(); };
            r.onerror = () => reject(r.error);
          });
          s.groups.delete(id);
          s.ix.delG.push(id);
        }, [id]);
        return;
      }
      await db.writeRemote(['groups', 'items', 'siteIdx', 'syiid'], async (s, meta) => {
        const ref = await req(s.syiid.get(id));
        if (!ref) return;
        vd(meta, ref.g);
        const rec = await req(s.items.get([ref.g, ref.seq]));
        s.syiid.delete(id);
        if (!rec) return;
        s.items.delete([ref.g, ref.seq]);
        if (s.L) needKeys(s);
        const g = await gGet(s, ref.g);
        if (g && !g.corrupt) {
          g.count = Math.max(0, g.count - 1);
          await db.siteApply(s, g, new Map([[rec.site || (rec.url ? db.siteOfUrl(rec.url) : ''), -1]]));
          g.mtime = Date.now();
          await gPut(s, g);
        }
        s.ix.del.push([ref.g, ref.seq, ref.seq]);
      }, null);
    },
  };
}
// the group of a remotely changed item is only known after reading: mark it dirty for the vault from inside the transaction
function vd(meta, gid) { const a = meta.vaultDirty || []; if (!a.includes(gid)) a.push(gid); meta.vaultDirty = a; }

// ---------- scope ----------
export const DEFAULT_SCOPE = { mode: 'recent', days: 30 };
export function inScope(g, scope, now = Date.now()) {
  if (g.ph || g.phase !== 'committed') return false;
  const sc = scope || DEFAULT_SCOPE;
  if (sc.mode === 'all') return true;
  if (sc.mode === 'flagged') return g.sync === true;
  return !!g.starred || g.sync === true || now - (g.createdAt || 0) <= (sc.days || 30) * 86400000;
}

// ---------- local change scanner ----------
const PAGE = 400;

export function createScanner({ engine, getScope, yieldFn = () => new Promise((r) => setTimeout(r, 0)) }) {
  async function setVs(list) { // [[t,id,v]]
    if (!list.length) return;
    const packed = [];
    for (const [t, id, v] of list) packed.push([t + id, await packV(LOCK, t + id, v)]); // sealed BEFORE the transaction
    await db.writeRemote(['sy'], async (s) => {
      for (const [k, p] of packed) {
        const r = (await req(s.sy.get(k))) || { k, fh: {}, purged: false };
        Object.assign(r, p);
        if (r.v === undefined) delete r.v;
        if (r.ve === undefined) delete r.ve;
        s.sy.put(r);
      }
    }, null, true);
  }
  async function record(ops, vs) {
    for (let i = 0; i < ops.length; i += 200) await engine.recordLocal(ops.slice(i, i + 200));
    await setVs(vs);
  }
  async function syRows(keys) {
    const rows = await db.readRaw(['sy'], async (s) => Promise.all(keys.map((k) => req(s.sy.get(k)))));
    return Promise.all(rows.map(async (r, i) => (r && r.ve ? { ...r, v: await readV(LOCK, keys[i], r) } : r)));
  }

  /** @returns {Promise<{ops:number, deferred?:boolean}>} */
  async function scanGroup(gid) {
    const g = await db.getGroup(gid);
    if (!g) return { ops: 0 };
    if (g.phase === 'writing' || g.phase === 'draining') return { ops: 0, deferred: true };
    if (g.corrupt || g.lockedStub) return { ops: 0, deferred: true }; // could not be decoded: nothing is sent
    if (db.getCodec() && (await db.readRaw(['inbox'], (s) => req(s.inbox.get(gid))))) return { ops: 0, deferred: true }; // rows stashed while locked, not sealed yet
    if (!inScope(g, getScope())) return { ops: 0 };
    let nOps = 0;
    const [gsy] = await syRows(['g' + gid]);
    const cur = groupFields(g);
    const prev = gsy && gsy.v;
    const diff = {};
    for (const k of Object.keys(cur)) {
      const dflt = Object.prototype.hasOwnProperty.call(GROUP_DEFAULTS, k);
      if (!prev) { if (!dflt || !same(GROUP_DEFAULTS[k], cur[k])) diff[k] = cur[k]; } // a new set: protocol-2 fields at their default are not sent
      else if (!same(prev[k] !== undefined || !dflt ? prev[k] : GROUP_DEFAULTS[k], cur[k])) diff[k] = cur[k]; // a baseline from before protocol 2 has no such field: that means the default
    }
    if (Object.keys(diff).length) {
      await record([engine.stamp('g', gid, diff)], [['g', gid, cur]]);
      nOps++;
    }
    // items, page by page (seq order)
    const seen = new Set();
    let after = 0;
    for (;;) {
      const page = await db.getItemsPage(gid, after, PAGE);
      if (!page.length) break;
      after = page[page.length - 1].seq;
      const fresh = page.filter((r) => !r.iid && !r.corrupt);
      if (fresh.length) {
        await db.writeRemote(['items', 'syiid'], async (s) => {
          for (const r of fresh) {
            const live = await req(s.items.get([r.g, r.seq]));
            if (!live) continue;
            r.iid = live.iid || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
            if (!live.iid) { live.iid = r.iid; s.items.put(live); }
            s.syiid.put({ iid: r.iid, g: r.g, seq: r.seq });
          }
        }, null, true);
      }
      const rows = await syRows(page.map((r) => 'i' + r.iid));
      const ops = [];
      const vs = [];
      page.forEach((r, i) => {
        if (!r.iid) return;
        seen.add(r.iid);
        if (r.corrupt) return; // damaged row: neither sent nor treated as removed
        const f = itemFields(r, gid);
        const row = rows[i];
        if (!row || !row.v) { ops.push(engine.stamp('i', r.iid, f)); vs.push(['i', r.iid, f]); return; }
        if (row.purged) return;
        const d = {};
        for (const k of ['title', 'tg', 'w', 'ws', 'sv']) if (!same(row.v[k], f[k])) d[k] = f[k] === undefined ? null : f[k];
        if (Object.keys(d).length) { ops.push(engine.stamp('i', r.iid, d)); vs.push(['i', r.iid, f]); }
      });
      if (ops.length) { await record(ops, vs); nOps += ops.length; }
      if (page.length < PAGE) break;
      await yieldFn();
    }
    // items that disappeared (restored / trashed / deleted): remove ops
    const known = await db.readRaw(['syiid'], (s) => req(s.syiid.index('byG').getAllKeys(gid)));
    const gone = known.filter((iid) => !seen.has(iid));
    if (gone.length) {
      const ops = gone.map((iid) => engine.stamp('i', iid, null, true));
      for (let i = 0; i < ops.length; i += 200) await engine.recordLocal(ops.slice(i, i + 200));
      await db.writeRemote(['syiid'], async (s) => { for (const iid of gone) s.syiid.delete(iid); }, null, true);
      nOps += gone.length;
    }
    return { ops: nOps };
  }

  /** Categories (kind 'c'): new / changed ones as field ops, deleted ones as a purge. Cheap: a handful of rows. @returns {Promise<{ops:number}>} */
  async function scanCategories() {
    const cats = (await db.listCategories()).filter((c) => c && !c.corrupt && c.id);
    const ids = new Set(await db.readRaw(['categories'], (s) => req(s.categories.getAllKeys()))); // raw keys: a damaged row still counts as present
    const knownKeys = await db.readRaw(['sy'], (s) => req(s.sy.getAllKeys(IDBKeyRange.bound('c', 'c' + String.fromCharCode(0xffff)))));
    const rows = await syRows([...new Set([...cats.map((c) => 'c' + c.id), ...knownKeys])]);
    const byKey = new Map(rows.map((r, i) => [r ? r.k : null, r]));
    const ops = [];
    const vs = [];
    for (const c of cats) {
      const f = catFields(c);
      const row = byKey.get('c' + c.id);
      if (row && row.purged) continue;
      if (!row || !row.v) { ops.push(engine.stamp('c', c.id, f)); vs.push(['c', c.id, f]); continue; }
      const d = {};
      for (const k of CAT_FIELDS) if (!same(row.v[k], f[k])) d[k] = f[k];
      if (Object.keys(d).length) { ops.push(engine.stamp('c', c.id, d)); vs.push(['c', c.id, f]); }
    }
    for (const r of rows) { // known before, gone now: deleted here
      if (!r || r.purged || !r.v || !r.k || r.k[0] !== 'c' || ids.has(r.k.slice(1))) continue; // (a row without a synced copy was never a category here)
      ops.push(engine.stamp('c', r.k.slice(1), null, true));
    }
    if (ops.length) await record(ops, vs);
    return { ops: ops.length };
  }

  /** The group was purged on purpose: send the purge, forget the item bookkeeping. */
  async function purgeLocal(gid) {
    const [gsy] = await syRows(['g' + gid]);
    const iids = await db.readRaw(['syiid'], (s) => req(s.syiid.index('byG').getAllKeys(gid)));
    if (gsy && !gsy.purged) await engine.recordLocal([engine.stamp('g', gid, null, true)]);
    if (iids.length) await db.writeRemote(['syiid', 'sy'], async (s) => { for (const iid of iids) { s.syiid.delete(iid); s.sy.delete('i' + iid); } }, null, true);
  }

  /** One round: takes the dirty list, scans it. Returns {groups, ops, deferred}. */
  async function run({ shouldStop = () => false } = {}) {
    const { dirty, purged, rev } = await db.syncDirtyTake();
    if (!dirty.length && !purged.length) return { groups: 0, ops: 0, deferred: 0 };
    let ops = 0;
    let deferred = 0;
    const done = [];
    for (const gid of purged) { if (shouldStop()) break; await purgeLocal(gid); }
    for (const gid of dirty) {
      if (shouldStop()) break;
      const r = await scanGroup(gid);
      ops += r.ops;
      if (r.deferred) deferred++; else done.push(gid);
      await yieldFn();
    }
    await db.syncDirtyDone(done, purged, rev);
    return { groups: done.length, ops, deferred };
  }
  return { scanGroup, purgeLocal, run, scanCategories, syRows, setVs };
}
