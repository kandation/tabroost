// Flat "all tabs" view: every item of every (allowed) session as ONE ordered list, read page by page.
//
// Four data paths, chosen once per list (createFlat):
//   stash    sessions in the page's order (createdAt asc/desc), items in seq order. Positions come from prefix sums of the
//            session counts -> exact total, O(log G) seek, pages read with db.getItemsByPos (no index needed).
//   mat      small result sets (site filter, or <= MAT_MAX items): the matching items are read once, sorted in memory.
//   walk     title / site / visited over the whole library: the sparse indexes byTk / bySite / byT of the `items` store.
//            Items of excluded sessions (archived, filtered out, trashed, still writing) are skipped through an in-memory gid set
//            with a per-transaction scan budget (SCAN_BUDGET records). Far positions are resolved through checkpoints
//            (the index key of every 1,000th passing item) that an idle openKeyCursor walk fills in the background; without them
//            the first jump falls back to cursor.advance(n) (exact when no session is excluded) or to a bounded key walk.
// Pure ordering logic is exported for tests (cmpFor / sortRecs); IndexedDB access goes through db.readRaw.

import * as db from './db.js';

export const PAGE = 50;
export const SCAN_BUDGET = 5000; // raw index records examined per read transaction
export const CP_EVERY = 1000; // checkpoint spacing (positions)
export const MAT_MAX = 40000; // sets up to this size are materialised and sorted in memory
export const MAT_CAP = 150000; // hard cap of a materialised site-filter result
export const FLAT_SORTS = ['stash', 'title', 'site', 'visited'];
const INDEX = { title: 'byTk', site: 'bySite', visited: 'byT' };

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** In-memory comparator that mirrors the index order of each sort (key, then primary key [g, seq]). */
export function cmpFor(sort, group) {
  const tie = (a, b) => cmpStr(a.g, b.g) || a.seq - b.seq;
  switch (sort) {
    case 'title': return (a, b) => cmpStr(a.tk || '', b.tk || '') || tie(a, b);
    case 'site': return (a, b) => cmpStr(a.site || '', b.site || '') || tie(a, b);
    case 'visited': return (a, b) => (a.ts || 0) - (b.ts || 0) || tie(a, b);
    default: return (a, b) => (group.get(a.g) || 0) - (group.get(b.g) || 0) || tie(a, b);
  }
}

export function sortRecs(recs, sort, dir, order) {
  const c = cmpFor(sort, order);
  if (sort === 'stash') { // newest first = sessions newest first, but the tabs of a session stay in their own order
    const sg = (a, b) => ((order.get(a.g) || 0) - (order.get(b.g) || 0)) * (dir === 'desc' ? -1 : 1) || cmpStr(a.g, b.g) * (dir === 'desc' ? -1 : 1) || a.seq - b.seq;
    recs.sort(sg);
    return recs;
  }
  recs.sort(dir === 'desc' ? (a, b) => c(b, a) : c);
  return recs;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const groupRange = (gid) => IDBKeyRange.bound([gid, 0], [gid, Infinity]);

/**
 * opts: {sort, dir, groups (summaries that pass nav + facets), sites (site facet, may be empty), siteMap (Map site -> Map gid -> n)}
 * Returns an object {mode, total, page(pg) -> Promise<rec[]>, init(), stop(), onTotal, stats}.
 */
export function createFlat({ sort: sort0 = 'stash', dir = 'desc', groups = [], sites = [], siteMap = null, excluded = -1 }) {
  // password lock on: title / site order need sort keys that are not stored (they would be readable); those two fall back to the saved order
  const lockOn = !!db.getCodec();
  const sort = lockOn && (sort0 === 'title' || sort0 === 'site') ? 'stash' : sort0;
  const allowed = new Set(groups.map((g) => g.id));
  const created = new Map(groups.map((g) => [g.id, g.createdAt || 0]));
  const stats = { mode: '', reads: 0, scanned: 0, cpDone: false, cpCount: 0, exact: null };
  let stopped = false;
  const F = { sort, dir, stats, onTotal: null, total: 0, mode: '', allowed };

  // ----- total from summaries (exact) -----
  let sum = 0;
  if (sites.length && siteMap) {
    for (const s of sites) { const m = siteMap.get(s); if (m) for (const [gid, n] of m) if (allowed.has(gid)) sum += n; }
  } else for (const g of groups) sum += g.count || 0;
  F.total = sum;

  // ===== stash order =====
  if (sort === 'stash' && !sites.length) {
    F.mode = stats.mode = 'stash';
    const og = groups.filter((g) => g.count > 0).sort((a, b) => (dir === 'desc' ? (b.createdAt - a.createdAt) : (a.createdAt - b.createdAt)) || (a.id < b.id ? -1 : 1));
    const cum = new Float64Array(og.length + 1);
    for (let i = 0; i < og.length; i++) cum[i + 1] = cum[i] + og[i].count;
    F.total = cum[og.length];
    F.page = async (pg) => {
      let pos = pg * PAGE;
      const out = [];
      let lo = 0;
      let hi = og.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= pos) lo = mid; else hi = mid - 1; }
      for (let gi = lo; gi < og.length && out.length < PAGE; gi++) {
        const off = pos - cum[gi];
        const take = Math.min(PAGE - out.length, og[gi].count - off);
        if (take <= 0) continue;
        const rows = await db.getItemsByPos(og[gi].id, off, take);
        stats.reads++;
        for (const r of rows) out.push(r);
        pos += rows.length || take;
        if (!rows.length) break;
      }
      return out;
    };
    F.init = async () => {};
    F.stop = () => { stopped = true; };
    return F;
  }

  // ===== materialised =====
  const matSet = sites.length || F.total <= (globalThis.__flatMatMax != null ? globalThis.__flatMatMax : MAT_MAX);
  if (matSet) {
    F.mode = stats.mode = 'mat';
    let recs = null;
    let loading = null;
    const load = () => loading || (loading = (async () => {
      const out = [];
      if (sites.length) {
        for (const site of sites) {
          const sk = lockOn ? await db.getCodec().siteKey(site) : site; // the bySite index holds blind tokens while the lock is on
          let got = await db.readRaw(['items'], (s) => req(s.items.index('bySite').getAll(IDBKeyRange.bound([sk, ''], [sk, '￿']), MAT_CAP)));
          if (lockOn) got = await db.decodeItems(got);
          for (const r of got) if (allowed.has(r.g)) out.push(r);
          if (out.length >= MAT_CAP) break;
        }
      } else {
        const lists = await db.readRaw(['items'], (s) => Promise.all(groups.map((g) => req(s.items.getAll(groupRange(g.id))))));
        if (lockOn) for (let i = 0; i < lists.length; i++) lists[i] = await db.decodeItems(lists[i]);
        for (const got of lists) { for (const r of got) out.push(r); if (out.length >= MAT_CAP) break; }
      }
      sortRecs(out, sort, dir, created);
      recs = out;
      if (out.length !== F.total) { F.total = out.length; if (F.onTotal) F.onTotal(F.total); }
      stats.reads++;
      return recs;
    })());
    F.page = async (pg) => (await load()).slice(pg * PAGE, pg * PAGE + PAGE);
    F.init = async () => { await load(); };
    F.stop = () => { stopped = true; };
    return F;
  }

  // ===== walk over a sparse index =====
  F.mode = stats.mode = 'walk';
  const indexName = INDEX[sort];
  const prev = dir === 'desc';
  const cp = new Map(); // asc position (multiple of CP_EVERY) -> {k, pk}
  let exact = false; // no session excluded: raw position == passing position, so cursor.advance(n) is exact
  let walkerDone = false;
  const pass = (pk) => allowed.has(pk[0]);

  /** Advances a KEY cursor from `st` ({k, pk, next} or {k:null,next:0}); stops at a passing entry whose position reaches stopAt,
      after maxScan raw entries, or at the end. Records checkpoints. */
  const walk = (st, stopAt, maxScan) => db.readRaw(['items'], (s) => new Promise((resolve, reject) => {
    const idx = s.items.index(indexName);
    const r = idx.openKeyCursor(st.k == null ? null : IDBKeyRange.lowerBound(st.k));
    let next = st.next;
    let first = st.k != null;
    let scanned = 0;
    let advanced = false;
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) { resolve({ end: true, next }); return; }
      if (first) {
        first = false;
        if (indexedDB.cmp(c.key, st.k) === 0 && indexedDB.cmp(c.primaryKey, st.pk) < 0) { c.continuePrimaryKey(st.k, st.pk); return; }
      }
      if (scanned >= maxScan) { stats.scanned += scanned; resolve({ k: c.key, pk: c.primaryKey, next, end: false, yielded: true }); return; }
      scanned++;
      if (exact && !advanced && next < stopAt && stopAt !== Infinity) { advanced = true; const d = stopAt - next; next = stopAt; c.advance(d); return; }
      const ok = exact || pass(c.primaryKey);
      if (ok && next >= stopAt) { if (next % CP_EVERY === 0) cp.set(next, { k: c.key, pk: c.primaryKey }); stats.scanned += scanned; resolve({ k: c.key, pk: c.primaryKey, next, end: false }); return; }
      if (ok) { if (next % CP_EVERY === 0) cp.set(next, { k: c.key, pk: c.primaryKey }); next++; }
      c.continue();
    };
  }));

  /** state of the passing entry at asc position q (null when q is past the end). */
  const seek = async (q) => {
    let best = Math.floor(q / CP_EVERY) * CP_EVERY;
    while (best > 0 && !cp.has(best)) best -= CP_EVERY;
    let st = best > 0 ? { ...cp.get(best), next: best } : { k: null, next: 0 };
    for (;;) {
      const r = await walk(st, q, SCAN_BUDGET * 12);
      if (r.end) return null;
      if (!r.yielded && r.next >= q) return r;
      st = r;
      await new Promise((res) => setTimeout(res, 0));
    }
  };

  /** Reads up to `want` passing records starting at index entry `st` going forward (asc) or backward. */
  const read = async (st, want) => {
    const out = [];
    let cur = { k: st.k, pk: st.pk };
    for (let round = 0; round < 400 && out.length < want && cur; round++) {
      const res = await db.readRaw(['items'], (s) => new Promise((resolve, reject) => {
        const idx = s.items.index(indexName);
        const range = prev ? IDBKeyRange.upperBound(cur.k) : IDBKeyRange.lowerBound(cur.k);
        const r = idx.openCursor(range, prev ? 'prev' : 'next');
        let first = true;
        let scanned = 0;
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) { resolve({ end: true }); return; }
          if (first) {
            first = false;
            const kc = indexedDB.cmp(c.key, cur.k);
            const pc = indexedDB.cmp(c.primaryKey, cur.pk);
            if (kc === 0 && (prev ? pc > 0 : pc < 0)) { c.continuePrimaryKey(cur.k, cur.pk); return; }
          }
          if (scanned >= SCAN_BUDGET) { stats.scanned += scanned; resolve({ end: false, k: c.key, pk: c.primaryKey, resume: true }); return; }
          scanned++;
          if (pass(c.primaryKey)) { out.push(c.value); if (out.length >= want) { resolve({ end: false, done: true }); return; } }
          c.continue();
        };
      }));
      stats.reads++;
      if (res.end || res.done) break;
      // budget used up: continue from the entry that was NOT examined yet
      cur = { k: res.k, pk: res.pk };
      await new Promise((r2) => setTimeout(r2, 0));
    }
    return out;
  };

  // ----- site sort without a walk: siteIdx rows {site, g, n} give exact prefix sums (order = site, g, seq like the bySite index) -----
  let sx = null; // {ent: [{site, g, n}], cum: Float64Array} when the rows agree with the session counts
  const sxPage = async (pg) => {
    const p = pg * PAGE;
    if (p >= sx.total) return [];
    const { ent, cum } = sx;
    const out = [];
    let q = prev ? sx.total - 1 - p : p; // asc position of the first wanted record
    let lo = 0;
    let hi = ent.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid - 1; }
    for (let e = lo; e >= 0 && e < ent.length && out.length < PAGE; e += prev ? -1 : 1) {
      const skip = prev ? cum[e + 1] - 1 - q : q - cum[e];
      const take = Math.min(PAGE - out.length, ent[e].n - skip);
      if (take <= 0) { q = prev ? cum[e] - 1 : cum[e + 1]; continue; }
      const rows = await db.readRaw(['items'], (s) => new Promise((resolve, reject) => {
        const r = s.items.index('bySite').openCursor(IDBKeyRange.only([ent[e].site, ent[e].g]), prev ? 'prev' : 'next');
        const got = [];
        let skipped = skip <= 0;
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const c = r.result;
          if (!c) { resolve(got); return; }
          if (!skipped) { skipped = true; c.advance(skip); return; }
          got.push(c.value);
          if (got.length >= take) { resolve(got); return; }
          c.continue();
        };
      }));
      stats.reads++;
      for (const r of rows) out.push(r);
      if (rows.length < take) break; // the rows changed under us: the list is rebuilt after every write
      q = prev ? cum[e] - 1 : cum[e + 1];
    }
    return out;
  };

  F.page = async (pg) => {
    if (sx) return sxPage(pg);
    const p = pg * PAGE;
    if (p >= F.total) return [];
    const q = prev ? F.total - 1 - p : p; // asc position of the first wanted record
    const st = await seek(Math.max(0, q));
    if (!st) return [];
    return read(st, PAGE);
  };

  F.init = async () => {
    // exact = no session of the store is excluded (per the summaries): raw position == passing position, so cursor.advance(n) is exact.
    // VERIFIED when the checkpoint walk reaches the end (an index entry count is O(n) in IndexedDB: ~4 s for 300k, so never awaited).
    exact = excluded === 0;
    stats.exact = exact;
    if (sort === 'site' && !globalThis.__flatNoSiteIdx) { // exact + instant when the per-site index agrees with the session counts
      try {
        const rows = await db.listSiteIdx();
        const ent = rows.filter((r) => allowed.has(r.g) && r.n > 0).sort((a, b) => cmpStr(a.site, b.site) || cmpStr(a.g, b.g));
        const cum = new Float64Array(ent.length + 1);
        for (let i = 0; i < ent.length; i++) cum[i + 1] = cum[i] + ent[i].n;
        if (cum[ent.length] === F.total && F.total > 0) { sx = { ent, cum, total: F.total }; F.mode = stats.mode = 'siteidx'; stats.cpDone = true; return; }
      } catch { /* fall back to the walk */ }
    }
    if (globalThis.__flatNoWalker) return; // test knob: measure jumps without checkpoints
    (async () => {
      let st = { k: null, next: 0 };
      for (;;) {
        if (stopped) return;
        const r = await walk(st, exact ? st.next + CP_EVERY : Infinity, 25000);
        stats.cpCount = cp.size;
        stats.walked = r.next;
        if (F.onProgress) F.onProgress(r.end ? 1 : Math.min(0.99, r.next / Math.max(1, F.total)));
        if (r.end) {
          let total = r.next;
          if (exact) { // advance() overshot the end: count the tail without advancing
            total = (await walk(st, Infinity, 100000)).next;
            if (total !== F.total) { exact = false; stats.exact = false; stats.verifyFailed = true; cp.clear(); st = { k: null, next: 0 }; continue; }
          }
          stats.cpDone = true;
          if (total !== F.total) { F.total = total; if (F.onTotal) F.onTotal(F.total); }
          return;
        }
        st = r;
        await new Promise((res) => setTimeout(res, 0));
      }
    })().catch(() => {});
  };
  F.stop = () => { stopped = true; };
  F._debug = () => ({ cp: cp.size, exact });
  if (lockOn) { const p0 = F.page; F.page = async (pg) => db.decodeItems(await p0(pg)); }
  return F;
}
