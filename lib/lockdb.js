// IndexedDB binding of the store-adapter contract of lib/lock/jobutil.js (service worker only).
// Every write goes through db.writeRemote(): ONE quiet transaction (no rev bump, no search-index log: the logical content does
// not change when a row is re-encrypted), serialised with the normal writers through `exclusive` (runExclusive).
// Inside tx.* only IndexedDB requests are awaited (the contract's rule: never await crypto inside a transaction).
import * as db from './db.js';

const req = db.req;
export const CMR_STORES = ['items', 'trash', 'groups', 'categories', 'siteIdx', 'sites', 'snapshots', 'ekeys', 'inbox'];
const IS = new Set(CMR_STORES);

function rangeOf(after, upTo) {
  if (after != null && upTo != null) return IDBKeyRange.bound(after, upTo, true, false);
  if (after != null) return IDBKeyRange.lowerBound(after, true);
  if (upTo != null) return IDBKeyRange.upperBound(upTo);
  return null;
}

function scanOn(store, { after, upTo, limit = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const r = store.openCursor(rangeOf(after, upTo));
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= limit) { resolve(out); return; }
      out.push({ key: c.primaryKey, value: c.value });
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}

/**
 * `extra` = {storeName: {scan, get, count, tx?}} adapters for data that lives outside `cmr` (settings, favicons, vault...).
 * Stores that are neither in cmr nor in `extra` read as empty (their plans are no-ops).
 */
export function idbStore({ exclusive = (fn) => fn(), extra = {} } = {}) {
  return {
    async scan(name, o = {}) {
      if (IS.has(name)) return db.readRaw([name], (s) => scanOn(s[name], o));
      return extra[name] ? extra[name].scan(o) : [];
    },
    async get(name, key) {
      if (IS.has(name)) return db.readRaw([name], (s) => req(s[name].get(key)));
      return extra[name] ? extra[name].get(key) : undefined;
    },
    async count(name) {
      if (IS.has(name)) return db.readRaw([name], (s) => req(s[name].count()));
      return extra[name] ? extra[name].count() : 0;
    },
    async getCursor(job) {
      const r = await db.readRaw(['meta'], (s) => req(s.meta.get('cur:' + job)));
      return r ? r.v : undefined;
    },
    tx(fn) {
      return exclusive(() => db.writeRemote(CMR_STORES, async (s) => {
        const t = {
          get: (name, key) => (IS.has(name) ? req(s[name].get(key)) : Promise.resolve(undefined)),
          scan: (name, o) => (IS.has(name) ? scanOn(s[name], o) : Promise.resolve([])),
          async put(name, v) { if (IS.has(name)) s[name].put(v); else if (extra[name] && extra[name].put) extra[name].put(v); },
          async del(name, key) { if (IS.has(name)) s[name].delete(key); else if (extra[name] && extra[name].del) extra[name].del(key); },
          async setCursor(job, obj) { if (obj == null) s.meta.delete('cur:' + job); else s.meta.put({ k: 'cur:' + job, v: obj }); },
        };
        await fn(t);
      }, null, true));
    },
  };
}
