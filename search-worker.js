// Search worker (SharedWorker, module; falls back to a dedicated Worker). Owns the in-memory fuzzy-search index.
//
//  * reads the main database `cmr` (read-only transactions) and keeps the index in sync by replaying the `ixlog` change
//    log that the service worker writes inside every item transaction (woken by the 'cmr' BroadcastChannel);
//  * persists a snapshot of the compacted index in its own database `cmr-search`, so a restart loads in ~100 ms and only
//    replays the log tail; a missing/old/inconsistent snapshot triggers a background rebuild;
//  * while the index is not ready (or when every query token is too common) it answers with a bounded cursor scan.
//
// Protocol (per MessagePort). page -> worker: {type:'search', id, q, limit} | {type:'more', id, limit} | {type:'cancel', id}
// | {type:'rebuild'} | {type:'check'} | {type:'status'}.  worker -> page: {type:'status', ...} | {type:'rows', id, phase, rows}
// | {type:'end', id, ...} | {type:'error', id, message} | {type:'ackLog', upto}.

import * as db from './lib/db.js';
import * as bus from './lib/bus.js';
import * as lockrt from './lib/lockrt.js';
import * as snapcodec from './lib/lock/snapcodec.js';
import { SearchIndex, TOP_K } from './lib/searchIndex.js';
import { parseQuery, foldFast, highlight, hasFuzzy, NORM_VERSION } from './lib/searchNorm.js';
import { SEARCH_DB, SEARCH_CAP } from './lib/constants.js';

const ASCII = /^[\x00-\x7f]*$/;
const BATCH = 50;
const SCAN_BATCH = 2000;
const IDLE_SNAPSHOT_MS = 5 * 60 * 1000;

const ports = new Set();
let ix = null; // the live SearchIndex (null while building / loading)
let state = 'init'; // init | loading | building | ready | error
let progress = 0;
let errorMsg = '';
let appliedLogId = 0;
let changesSinceSnap = 0;
let tailing = false;
let tailAgain = false;
let snapTimer = null;
let groupsById = new Map(); // gid -> group record (live copy for titles / tab-group names / liveness)
let buildToken = 0;
let lastCheckAt = 0;
let loadedFromSnap = false; // the index came from the persisted snapshot (sealed when the lock is on)
let lockOn = false; // password lock enabled: keys come by message from an unlocked page, nothing readable is ever persisted

const yieldNow = () => new Promise((resolve) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); resolve(); };
  c.port2.postMessage(0);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendAll(msg) { for (const p of ports) { try { p.postMessage(msg); } catch { /* port gone */ } } }
function statusMsg() {
  const fromSnap = loadedFromSnap;
  const st = ix ? ix.stats() : null;
  return { type: 'status', state, progress, error: errorMsg, docs: st ? st.alive : 0, terms: st ? st.terms : 0, approxMB: st ? st.approxMB : 0, logId: appliedLogId, fromSnap, lockOn };
}
function broadcastStatus() { sendAll(statusMsg()); }

// ---------- snapshot store ----------
function openSnapDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(SEARCH_DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('snap'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function snapGet() {
  const d = await openSnapDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction('snap', 'readonly').objectStore('snap').get('main');
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } finally { d.close(); }
}
async function snapPut(value) {
  const d = await openSnapDb();
  try {
    await new Promise((resolve, reject) => {
      const t = d.transaction('snap', 'readwrite');
      if (value) t.objectStore('snap').put(value, 'main'); else t.objectStore('snap').delete('main');
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { d.close(); }
}

async function saveSnapshot() {
  if (!ix || state !== 'ready') return;
  if (lockOn && !(lockrt.getKeys() && lockrt.getKeys().xk)) return; // locked: nothing readable is ever persisted
  if (ix.hasDelta()) await ix.compact(yieldNow);
  const s = ix.serialize();
  const logId = appliedLogId;
  const meta = (await db.getMeta()) || {};
  if (lockOn) { // password lock on: the term list is text from titles / links, so the snapshot is sealed with XK in <= 4 MB chunks
    const sealed = await snapcodec.seal(lockrt.getKeys().xk, { meta: s.meta, buffers: s.buffers });
    await snapPut({ enc: true, chunks: sealed.chunks, meta: { NORM_VERSION, logId, built: true, at: Date.now(), dbId: meta.dbId || null } });
  } else await snapPut({ meta: { ...s.meta, NORM_VERSION, logId, built: true, at: Date.now(), dbId: meta.dbId || null }, buffers: s.buffers });
  changesSinceSnap = 0;
  const first = ports.values().next().value;
  if (first) first.postMessage({ type: 'ackLog', upto: logId });
}

function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(async () => {
    if (changesSinceSnap >= 1000 || (ix && ix.needsCompaction())) { try { await saveSnapshot(); } catch { /* retried later */ } }
  }, IDLE_SNAPSHOT_MS);
}

// ---------- groups ----------
async function reloadGroups() {
  const list = await db.ixAllGroups();
  groupsById = new Map(list.map((g) => [g.id, g]));
  if (ix) ix.setGroups(list);
  return list;
}
const tagText = (rec) => {
  if (rec.tg == null) return '';
  const g = groupsById.get(rec.g);
  const t = g && g.tabGroups && g.tabGroups.find((x) => x.i === rec.tg);
  return t && t.title ? t.title : '';
};

// ---------- build / load ----------
async function fullBuild() {
  const token = ++buildToken;
  ix = null;
  state = 'building';
  progress = 0;
  broadcastStatus();
  const startLog = await db.ixMaxId();
  const groups = await reloadGroups();
  const total = Math.max(1, await db.ixItemCount());
  const nx = new SearchIndex();
  nx.setGroups(groups);
  let lastKey = null;
  let done = 0;
  for (;;) {
    if (token !== buildToken) return; // superseded
    const recs = await db.ixScanItems(lastKey, SCAN_BATCH);
    if (!recs.length) break;
    for (const r of recs) nx.addDoc(r.g, r.seq, r.ts, r.title, r.url, tagText(r));
    done += recs.length;
    const last = recs[recs.length - 1];
    lastKey = [last.g, last.seq];
    if (nx.needsCompaction()) await nx.compact(yieldNow);
    const p = Math.min(99, Math.round((done / total) * 100));
    if (p !== progress) { progress = p; broadcastStatus(); }
    await yieldNow();
    if (recs.length < SCAN_BATCH) break;
  }
  if (token !== buildToken) return;
  await nx.compact(yieldNow);
  ix = nx;
  appliedLogId = startLog;
  state = 'ready';
  progress = 100;
  await tailLog(true); // replay what happened during the build (upserts)
  await reloadGroups();
  broadcastStatus();
  try { await saveSnapshot(); } catch { /* snapshot is an optimisation */ }
}

async function boot() {
  state = 'loading';
  broadcastStatus();
  try {
    await db.openDB();
    const lk = await lockrt.init({ useSession: false });
    lockOn = lk.enabled;
    if (lockOn && !lockrt.getKeys()) { ix = null; state = 'locked'; broadcastStatus(); return; } // waits for {type:'keys'}
    const meta = await db.getMeta();
    // lock on: a sealed snapshot is used when it opens (below); anything else is thrown away and the index is rebuilt in memory
    let snap = await snapGet();
    if (snap && lockOn) {
      if (snap.enc && lockrt.getKeys()) { try { const o = await snapcodec.open(lockrt.getKeys().xk, snap.chunks); snap = { meta: { ...snap.meta, ...o.meta }, buffers: o.buffers }; } catch { snap = null; } } else snap = null;
      if (!snap) { try { await snapPut(null); } catch { /* none */ } }
    } else if (snap && snap.enc) snap = null; // sealed snapshot left from while the lock was on: rebuild readable
    let usable = false;
    if (snap && snap.meta && snap.meta.built && snap.meta.NORM_VERSION === NORM_VERSION && snap.meta.logId >= (meta.ixlogLost || 0)
      && (!snap.meta.dbId || !meta.dbId || snap.meta.dbId === meta.dbId)) {
      try {
        ix = SearchIndex.deserialize(snap);
        appliedLogId = snap.meta.logId;
        usable = true;
        loadedFromSnap = true;
      } catch { ix = null; }
    }
    if (usable) {
      await reloadGroups();
      state = 'ready';
      await tailLog(true);
      broadcastStatus();
      if (!(await countMatches())) { await fullBuild(); return; }
    } else await fullBuild();
  } catch (e) {
    state = 'error';
    errorMsg = (e && (e.name || e.message)) || String(e);
    ix = null;
    broadcastStatus();
  }
}

async function countMatches() {
  if (!ix) return false;
  const n = await db.ixItemCount();
  const diff = Math.abs(n - ix.aliveCount);
  return diff <= Math.max(2, n * 0.005);
}

async function integrityCheck() {
  lastCheckAt = Date.now();
  if (state !== 'ready' || !ix) return;
  await tailLog(true);
  if (!(await countMatches())) await fullBuild();
}

// ---------- change log ----------
async function tailLog(force) {
  if (tailing) { tailAgain = true; return; }
  if (!ix || (state !== 'ready' && !force)) return;
  tailing = true;
  try {
    do {
      tailAgain = false;
      await reloadGroups();
      for (;;) {
        const entries = await db.ixReadLog(appliedLogId, 300);
        if (!entries.length) break;
        const dels = [];
        const adds = [];
        const delG = [];
        for (const e of entries) {
          for (const r of e.add || []) { adds.push(r); dels.push(r); } // upsert: tombstone any live copy first
          for (const r of e.del || []) dels.push(r);
          for (const g of e.delG || []) delG.push(g);
        }
        for (const g of delG) ix.removeGroup(g);
        ix.removeRanges(dels);
        // fetch the added ranges (records deleted later simply come back missing)
        for (let i = 0; i < adds.length; i += 20) {
          const recs = await db.ixItemsRanges(adds.slice(i, i + 20));
          for (const r of recs) ix.addDoc(r.g, r.seq, r.ts, r.title, r.url, tagText(r));
          if (recs.length > 500) await yieldNow();
        }
        appliedLogId = entries[entries.length - 1].id;
        changesSinceSnap += adds.length + dels.length;
        if (ix.needsCompaction()) { await ix.compact(yieldNow); changesSinceSnap = Math.max(changesSinceSnap, 1000); }
      }
    } while (tailAgain);
    if (state === 'ready') scheduleSnapshot();
  } finally { tailing = false; }
}

let tailTimer = null;
bus.on((m) => {
  if (!m || m.type !== 'changed') return;
  if (m.ix == null && m.groups !== 'all' && !m.groups) return;
  clearTimeout(tailTimer);
  tailTimer = setTimeout(() => { if (ix && state === 'ready') tailLog().catch(() => {}); }, 150);
});

// ---------- verification & rows ----------
const hostOf = (u) => { try { return foldFast(new URL(u).hostname).replace(/^www\./, ''); } catch { return ''; } };

function verifyRow(rec, res, parsed) {
  if (!res.needsVerify) return true;
  const ft = foldFast(rec.title + '\n' + rec.url);
  for (const p of parsed.phrases) if (!ft.includes(p)) return false;
  for (const v of res.verify || []) if (!ft.includes(v)) return false;
  for (const u of res.unselective || []) if (!ft.includes(u)) return false;
  if (parsed.site && !hostOf(rec.url).endsWith(parsed.site)) return false;
  return true;
}

function toRow(rec, needles, fuzzy) {
  return {
    g: rec.g, seq: rec.seq, url: rec.url, title: rec.title, ts: rec.ts, w: rec.w, ws: rec.ws, tg: rec.tg, sv: rec.sv, fuzzy: !!fuzzy,
    hl: { title: highlight(rec.title, needles), url: highlight(rec.url, needles) },
  };
}

function allowedGroupsFor(parsed) {
  if (!parsed.group || !ix) return null;
  const set = new Set();
  for (const [gid, g] of groupsById) {
    if (g.deletedAt == null && foldFast(g.title || '').includes(parsed.group)) {
      const o = ix.gOrdOf.get(gid);
      if (o !== undefined) set.add(o);
    }
  }
  return set;
}

// ---------- requests ----------
const reqs = new Map(); // port -> current request

function newReq(port, id, q, limit) {
  const prev = reqs.get(port);
  if (prev) prev.canceled = true;
  const r = {
    port, id, q, limit: limit || 200, canceled: false, parsed: parseQuery(q), t0: performance.now(), phase: 'exact', list: null, cursor: 0,
    emitted: 0, exactKeys: null, exactCount: 0, fuzzyCount: 0, mode: 'index', scanKey: null, scanned: 0, running: false, done: false,
  };
  reqs.set(port, r);
  return r;
}

const live = (r) => !r.canceled && reqs.get(r.port) === r;

async function runRequest(r) {
  if (r.running || r.done) return;
  r.running = true;
  try {
    if (!r.parsed.tokens.length && !r.parsed.phrases.length) { finish(r, false); return; }
    if (r.mode === 'index' && (!ix || state !== 'ready')) r.mode = 'scan';
    if (r.mode === 'index') await runIndex(r);
    if (r.mode === 'scan') await runScan(r);
  } catch (e) {
    if (live(r)) r.port.postMessage({ type: 'error', id: r.id, message: String((e && e.message) || e) });
    r.done = true;
  } finally { r.running = false; }
}

function finish(r, hasMore) {
  if (!live(r)) return;
  r.done = !hasMore;
  r.port.postMessage({
    type: 'end', id: r.id, exactCount: r.exactCount, fuzzyCount: r.fuzzyCount, hasMore, ms: Math.round(performance.now() - r.t0), mode: r.mode,
    total: r.list ? r.list.total : r.exactCount, state,
  });
}

/** emits rows from r.list until r.limit rows were sent in this call; returns true when the list is exhausted */
async function emitList(r, fuzzy) {
  const L = r.list;
  const target = r.emitted + r.limit;
  while (r.cursor < L.n && r.emitted < target) {
    if (!live(r)) return false;
    const end = Math.min(L.n, r.cursor + BATCH);
    const keys = [];
    for (let i = r.cursor; i < end; i++) keys.push([r.ixRef.gKeys[L.g[i]], L.seq[i]]);
    r.cursor = end;
    const recs = await db.ixGetItems(keys);
    if (!live(r)) return false;
    const rows = [];
    for (const rec of recs) {
      if (!rec) continue;
      if (!verifyRow(rec, L, r.parsed)) continue;
      const g = groupsById.get(rec.g);
      if (g && g.deletedAt != null) continue;
      rows.push(toRow(rec, L.needles, fuzzy));
      if (!fuzzy) r.exactKeys.add(rec.g + ':' + rec.seq);
    }
    if (rows.length) {
      r.emitted += rows.length;
      if (fuzzy) r.fuzzyCount += rows.length; else r.exactCount += rows.length;
      r.port.postMessage({ type: 'rows', id: r.id, phase: fuzzy ? 'fuzzy' : 'exact', rows });
    }
  }
  return r.cursor >= L.n;
}

async function runIndex(r) {
  const parsed = r.parsed;
  if (r.phase === 'exact') {
    if (!r.list) {
      const res = ix.search(parsed, { phase: 'exact', allowedGroups: allowedGroupsFor(parsed) });
      if (res.fallback) { r.mode = 'scan'; return; }
      r.list = res;
      r.ixRef = ix; // candidate lists hold group ordinals of THIS index instance
      r.exactKeys = new Set(); // filled with the emitted rows by emitList (skip set for the fuzzy phase)
      r.cursor = 0;
    }
    const exhausted = await emitList(r, false);
    if (!live(r)) return;
    if (!exhausted) { finish(r, true); return; }
    // exact results exhausted
    if (r.list.total >= TOP_K || !hasFuzzy(parsed)) { finish(r, false); return; }
    r.phase = 'fuzzy';
    r.list = null;
    r.cursor = 0;
    // let a newer keystroke cancel us before the (costlier) fuzzy pass; with no exact hit at all there is nothing to wait for
    await sleep(r.exactCount === 0 ? 0 : 60);
    if (!live(r)) return;
  }
  if (r.phase === 'fuzzy') {
    if (!r.list) {
      // exact-phase keys are in (gOrd:seq) form for the index-level skip set
      if (r.ixRef !== ix) { finish(r, false); return; } // index was swapped meanwhile: the exact results stand
      const skip = new Set();
      for (const k of r.exactKeys) {
        const i = k.lastIndexOf(':');
        const o = ix.gOrdOf.get(k.slice(0, i));
        if (o !== undefined) skip.add(o + ':' + Number(k.slice(i + 1)));
      }
      const res = ix.search(parsed, { phase: 'fuzzy', allowedGroups: allowedGroupsFor(parsed), skip });
      if (res.fallback || !res.n) { finish(r, false); return; }
      r.list = res;
      r.cursor = 0;
    }
    const exhausted = await emitList(r, true);
    if (!live(r)) return;
    finish(r, !exhausted);
  }
}

// bounded cursor scan (index not ready / everything too common)
async function runScan(r) {
  const parsed = r.parsed;
  const terms = parsed.tokens.map((t) => t.term);
  const target = r.emitted + r.limit;
  const liveG = new Set();
  for (const [gid, g] of groupsById) if (g.deletedAt == null) liveG.add(gid);
  if (!groupsById.size) for (const g of await db.ixAllGroups()) { groupsById.set(g.id, g); if (g.deletedAt == null) liveG.add(g.id); }
  const groupFilter = parsed.group ? new Set([...groupsById].filter(([, g]) => foldFast(g.title || '').includes(parsed.group)).map(([id]) => id)) : null;
  for (;;) {
    if (!live(r)) return;
    const recs = await db.ixScanItems(r.scanKey, SCAN_BATCH);
    if (!recs.length) { finish(r, false); return; }
    const rows = [];
    for (const rec of recs) {
      if (!liveG.has(rec.g)) continue;
      if (groupFilter && !groupFilter.has(rec.g)) continue;
      const ft = ASCII.test(rec.t) ? rec.t : foldFast(rec.t);
      let ok = true;
      for (const t of terms) if (!ft.includes(t)) { ok = false; break; }
      if (!ok) continue;
      for (const p of parsed.phrases) if (!ft.includes(p)) { ok = false; break; }
      if (!ok) continue;
      for (const e of parsed.excludes) if (ft.includes(e)) { ok = false; break; }
      if (!ok) continue;
      if (parsed.site && !hostOf(rec.url).endsWith(parsed.site)) continue;
      rows.push(toRow(rec, terms, false));
      if (r.emitted + rows.length >= Math.min(target, SEARCH_CAP * 10)) break;
    }
    const last = recs[recs.length - 1];
    r.scanKey = [last.g, last.seq];
    if (rows.length) {
      r.emitted += rows.length;
      r.exactCount += rows.length;
      r.port.postMessage({ type: 'rows', id: r.id, phase: 'fallback', rows });
    }
    if (r.emitted >= target) { finish(r, true); return; }
    if (recs.length < SCAN_BATCH) { finish(r, false); return; }
    await yieldNow();
  }
}

// ---------- ports ----------
function onPortMessage(port, m) {
  if (!m) return;
  switch (m.type) {
    case 'search': {
      const r = newReq(port, m.id, String(m.q || ''), m.limit);
      runRequest(r);
      break;
    }
    case 'more': {
      const r = reqs.get(port);
      if (r && r.id === m.id && !r.running) { r.limit = m.limit || r.limit; r.done = false; runRequest(r); }
      break;
    }
    case 'cancel': {
      const r = reqs.get(port);
      if (r && r.id === m.id) r.canceled = true;
      break;
    }
    case 'rebuild':
      snapPut(null).catch(() => {}).then(() => fullBuild()).catch((e) => { state = 'error'; errorMsg = String((e && e.message) || e); broadcastStatus(); });
      break;
    case 'check':
      integrityCheck().catch(() => {});
      break;
    case 'status':
      port.postMessage(statusMsg());
      break;
    case 'keys': // from an unlocked page: non-extractable CryptoKeys {dk, xk, hk, sk}
      if (m.keys && m.keys.dk && (state === 'locked' || state === 'init' || state === 'error')) { lockrt.setKeys(m.keys); boot().catch(() => {}); }
      else if (m.keys && m.keys.dk && !lockOn) { lockrt.setKeys(m.keys); snapPut(null).catch(() => {}).then(() => boot()).catch(() => {}); } // the lock was turned on while this worker ran: drop the readable snapshot, rebuild with keys
      break;
    case 'lock': // the lock closed: drop every decrypted byte and the worker itself
      buildToken++; ix = null; groupsById = new Map(); reqs.clear(); lockrt.setKeys(null); state = 'locked'; broadcastStatus();
      setTimeout(() => { try { self.close(); } catch { /* ignore */ } }, 50);
      break;
    default: break;
  }
}

function attach(port) {
  ports.add(port);
  port.onmessage = (e) => onPortMessage(port, e.data);
  if (port.start) port.start();
  port.postMessage(statusMsg());
}

if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = (e) => attach(e.ports[0]);
} else {
  attach(self);
}

boot().then(() => { if (Date.now() - lastCheckAt > 24 * 3600 * 1000) setTimeout(() => integrityCheck().catch(() => {}), 60000); });
