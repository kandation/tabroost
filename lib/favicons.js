// Favicon cache for the list page.
//
// Problem it solves: the old code asked Chrome for /_favicon/?pageUrl=<full url> per ROW. 100k stashed links on 2,000
// hosts meant ~100k distinct IPC requests + PNG decodes, re-issued every time a pooled row was recycled while scrolling.
//
// Design:
//  - ONE icon per host (not per URL). Icons are blob object URLs in a small in-memory LRU, so every row of a host shares
//    the same decoded bitmap, and persisted (tiny blobs) in its own cache database `cmr-fav` (hits 30 d, misses 7 d).
//  - Only hosts that are currently visible are fetched; hosts that scroll out are dropped from the queue / aborted.
//  - At most 6 loads in flight (hard max 8), paused while the user is flinging the list, resumed shortly after it settles.
//  - Chrome answers an unknown page with its default globe: we detect that image (size+hash of a bogus lookup) and
//    treat it as a miss, trying the host's root page once before giving up. Misses show a coloured letter avatar.
//  - Under memory pressure (or when the user turns icons off) no request is made at all.

const FAV_DB = 'cmr-fav';
const MAX_MEM = 500;
const MAX_INFLIGHT = 6;
const TTL_HIT = 30 * 86400000;
const TTL_MISS = 7 * 86400000;
const MAX_PERSIST = 5000;
const MAX_BLOB = 8192;

const hashBytes = (b) => { let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619); } return h >>> 0; };

export function createFavicons({ onReady, mode = 'img' } = {}) {
  if (mode === 'atlas' && typeof OffscreenCanvas !== 'undefined' && typeof document !== 'undefined') return createAtlasFavicons({ onReady });
  const mem = new Map(); // host -> {url|null (miss), ts}
  const queue = new Map(); // host -> sample url (visible, waiting)
  const inflight = new Map(); // host -> AbortController
  const want = new Set(); // hosts visible right now
  const pendingDb = new Set();
  let enabled = true;
  let paused = false;
  let degraded = false;
  let dbp = null;
  let defaultSig = null; // {len, hash} of Chrome's default globe
  let defaultSigP = null;
  let putCount = 0;
  const st = { started: 0, aborted: 0, memHits: 0, dbHits: 0, misses: 0, errors: 0, maxInflight: 0 };

  const openDb = () => {
    if (lockrt.enabled()) return Promise.resolve(null); // password lock on: icons are NOT stored (the host names would be); they are fetched again each time
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const r = indexedDB.open(FAV_DB, 2);
          r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('icons')) { const s = d.createObjectStore('icons', { keyPath: 'host' }); s.createIndex('byTs', 'ts'); } if (!d.objectStoreNames.contains('atlas')) d.createObjectStore('atlas', { keyPath: 'id' }); };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbp;
  };

  const favUrl = (u) => chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(u) + '&size=16');

  async function getDefaultSig() {
    if (defaultSig) return defaultSig;
    if (!defaultSigP) {
      defaultSigP = (async () => {
        try {
          const r = await fetch(favUrl('http://cmr-default-probe.invalid/'));
          const b = new Uint8Array(await r.arrayBuffer());
          defaultSig = { len: b.length, hash: hashBytes(b) };
        } catch { defaultSig = { len: -1, hash: 0 }; }
        return defaultSig;
      })();
    }
    return defaultSigP;
  }

  function remember(host, url) {
    const old = mem.get(host);
    if (old && old.url) URL.revokeObjectURL(old.url);
    mem.delete(host);
    mem.set(host, { url, ts: Date.now() });
    if (mem.size > MAX_MEM) {
      const k = mem.keys().next().value;
      const e = mem.get(k);
      if (e && e.url) URL.revokeObjectURL(e.url);
      mem.delete(k);
    }
  }

  async function dbGet(host) {
    const db = await openDb();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const r = db.transaction('icons', 'readonly').objectStore('icons').get(host);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  async function dbPut(rec) {
    const db = await openDb();
    if (!db) return;
    try {
      const t = db.transaction('icons', 'readwrite');
      t.objectStore('icons').put(rec);
      if (++putCount % 200 === 0) trim(db);
    } catch { /* ignore */ }
  }

  function trim(db) {
    try {
      const t = db.transaction('icons', 'readwrite');
      const s = t.objectStore('icons');
      const c = s.count();
      c.onsuccess = () => {
        let extra = c.result - MAX_PERSIST;
        if (extra <= 0) return;
        const cur = s.index('byTs').openCursor();
        cur.onsuccess = () => {
          const x = cur.result;
          if (!x || extra-- <= 0) return;
          x.delete();
          x.continue();
        };
      };
    } catch { /* ignore */ }
  }

  async function fetchIcon(url, signal) {
    const r = await fetch(favUrl(url), { signal });
    const buf = new Uint8Array(await r.arrayBuffer());
    const sig = await getDefaultSig();
    if (buf.length === sig.len && hashBytes(buf) === sig.hash) return null; // Chrome's default globe
    if (buf.length < 8) return null;
    return new Blob([buf], { type: r.headers.get('content-type') || 'image/png' });
  }

  async function load(host, sample) {
    if (inflight.has(host)) return;
    const ctl = new AbortController();
    inflight.set(host, ctl);
    st.maxInflight = Math.max(st.maxInflight, inflight.size);
    st.started++;
    try {
      // 1) persisted cache
      const rec = await dbGet(host);
      const now = Date.now();
      if (rec && now - rec.ts < (rec.miss ? TTL_MISS : TTL_HIT)) {
        if (rec.miss || !rec.blob) { remember(host, null); st.misses++; } else { remember(host, URL.createObjectURL(rec.blob)); st.dbHits++; }
        if (onReady) onReady(host);
        return;
      }
      if (ctl.signal.aborted) { st.aborted++; return; }
      // 2) ask Chrome (the sample url, then the host's root page once)
      let blob = await fetchIcon(sample, ctl.signal);
      if (!blob && !ctl.signal.aborted) {
        let root = '';
        try { root = new URL(sample).origin + '/'; } catch { /* ignore */ }
        if (root && root !== sample) blob = await fetchIcon(root, ctl.signal);
      }
      if (ctl.signal.aborted) { st.aborted++; return; }
      if (blob && blob.size <= MAX_BLOB * 4) {
        remember(host, URL.createObjectURL(blob));
        if (blob.size <= MAX_BLOB) dbPut({ host, blob, miss: 0, ts: now });
      } else {
        remember(host, null);
        st.misses++;
        dbPut({ host, blob: null, miss: 1, ts: now });
      }
      if (onReady) onReady(host);
    } catch (e) {
      if (ctl.signal.aborted) st.aborted++; else st.errors++;
    } finally {
      inflight.delete(host);
      pump();
    }
  }

  function pump() {
    if (!enabled || paused || degraded) return;
    while (inflight.size < MAX_INFLIGHT && queue.size) {
      const [host, sample] = queue.entries().next().value;
      queue.delete(host);
      if (!want.has(host)) continue; // scrolled away while waiting
      load(host, sample);
    }
  }

  return {
    /** blob url for the host, or null (not loaded / miss). Queues a load when unknown. */
    iconFor(host, sampleUrl) {
      if (!enabled || degraded || !host) return null;
      const e = mem.get(host);
      if (e) {
        st.memHits++;
        mem.delete(host); mem.set(host, e); // LRU touch
        return e.url;
      }
      want.add(host);
      if (!queue.has(host) && !inflight.has(host)) { queue.set(host, sampleUrl); pump(); }
      return null;
    },
    /** is the answer final (hit or miss) -> the row can stop showing a placeholder state */
    known(host) { return mem.has(host); },
    /** called once per rendered frame with the hosts currently on screen */
    setVisible(hosts) {
      want.clear();
      for (const h of hosts) want.add(h);
      for (const h of queue.keys()) if (!want.has(h)) queue.delete(h);
      for (const [h, ctl] of inflight) if (!want.has(h)) { ctl.abort(); }
    },
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) { queue.clear(); for (const c of inflight.values()) c.abort(); }
      else pump();
    },
    setPaused(v) { paused = !!v; if (!paused) pump(); },
    setDegraded(v) {
      degraded = !!v;
      if (degraded) { queue.clear(); for (const c of inflight.values()) c.abort(); for (const [h, e] of [...mem]) { if (mem.size <= 100) break; if (e.url) URL.revokeObjectURL(e.url); mem.delete(h); } } else pump();
    },
    isDegraded: () => degraded,
    atlas: false,
    stats: () => ({ ...st, inflight: inflight.size, queued: queue.size, hosts: mem.size, paused, degraded }),
    async clear() {
      for (const e of mem.values()) if (e.url) URL.revokeObjectURL(e.url);
      mem.clear();
      const db = await openDb();
      if (db) { try { db.transaction('icons', 'readwrite').objectStore('icons').clear(); } catch { /* ignore */ } }
    },
  };
}

/** Letter + colour of the placeholder avatar (12 hues). */
export function avatarOf(host) {
  const h = String(host || '?').replace(/^www\./, '');
  let x = 0;
  for (let i = 0; i < h.length; i++) x = (x * 31 + h.charCodeAt(i)) >>> 0;
  return { ch: (h[0] || '?').toUpperCase(), hue: x % 12 };
}

// ======================= sprite-atlas variant =======================
// Same job as above, different storage: every host's icon is drawn ONCE into a shared canvas "atlas" (cells of 16 css px x DPR,
// 32 columns, up to 32 rows = 1,024 hosts per atlas, at most 4 atlases). The canvas is exported as ONE PNG blob URL that lives in a
// CSS custom property (--fa0..--fa3); a row shows its host's icon with background-position only: no <img> per row, no
// object URL per host, nothing to revoke when a pooled row is recycled. The atlas PNGs + the host->cell index are persisted in
// `cmr-fav` (store `atlas`), so a cold start paints icons with ZERO _favicon requests.
// Only the _favicon API is ever fetched (never arbitrary icon urls). Hits live 30 d, misses 7 d; when all 4096 cells are used
// the least-recently-shown host that is not on screen gives its cell up.
const COLS = 32;
const ROWS_MAX = 32;
const PER_ATLAS = COLS * ROWS_MAX;
const ATLAS_MAX = 4;
const MISS_MAX = 20000;
const EXPORT_N = 16; // new icons that trigger an export at once; fewer are flushed after EXPORT_IDLE ms of quiet
const EXPORT_IDLE = 1500;

function createAtlasFavicons({ onReady } = {}) {
  const idx = new Map(); // host -> {c: global cell (-1 = miss), ts, u: last shown}
  const used = new Array(ATLAS_MAX).fill(0); // next never-used cell per atlas
  const free = []; // released cells (global ids)
  const atl = []; // k -> {cp, rows, canvas, ctx, url, blob, dirty}
  const queue = new Map();
  const inflight = new Map();
  const want = new Set();
  let enabled = true;
  let paused = false;
  let degraded = false;
  let ready = false;
  let dbp = null;
  let defaultSig = null;
  let defaultSigP = null;
  let newCount = 0;
  let idxDirty = false;
  let exportT = 0;
  let exporting = false;
  let exportAgain = false;
  let gen = 0;
  const dpr = Math.max(1, Math.min(2, Math.round(globalThis.devicePixelRatio || 1)));
  const st = { started: 0, aborted: 0, memHits: 0, misses: 0, errors: 0, maxInflight: 0, fetches: 0, exports: 0, exportMs: 0, evicted: 0, coldLoadMs: 0 };
  const root = document.documentElement;

  const openDb = () => {
    if (lockrt.enabled()) return Promise.resolve(null); // password lock on: icons are NOT stored (the host names would be); they are fetched again each time
    if (!dbp) {
      dbp = new Promise((resolve) => {
        try {
          const r = indexedDB.open(FAV_DB, 2);
          r.onupgradeneeded = () => {
            const d = r.result;
            if (!d.objectStoreNames.contains('icons')) { const s = d.createObjectStore('icons', { keyPath: 'host' }); s.createIndex('byTs', 'ts'); }
            if (!d.objectStoreNames.contains('atlas')) d.createObjectStore('atlas', { keyPath: 'id' }); // atlas PNGs + the index record
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbp;
  };

  const favUrl = (u) => chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(u) + '&size=' + 16 * dpr);

  async function getDefaultSig() {
    if (defaultSig) return defaultSig;
    if (!defaultSigP) {
      defaultSigP = (async () => {
        try {
          const r = await fetch(favUrl('http://cmr-default-probe.invalid/'));
          const b = new Uint8Array(await r.arrayBuffer());
          defaultSig = { len: b.length, hash: hashBytes(b) };
        } catch { defaultSig = { len: -1, hash: 0 }; }
        return defaultSig;
      })();
    }
    return defaultSigP;
  }

  const setVars = (k) => {
    const a = atl[k];
    if (!a) return;
    root.style.setProperty('--fa' + k, a.url ? 'url(' + a.url + ')' : 'none');
    root.style.setProperty('--fah' + k, a.rows * 16 + 'px');
  };

  async function loadFromDb() {
    const my = gen;
    const t0 = performance.now();
    const db = await openDb();
    if (db) {
      const recs = await new Promise((resolve) => {
        try {
          const r = db.transaction('atlas', 'readonly').objectStore('atlas').getAll();
          r.onsuccess = () => resolve(r.result || []);
          r.onerror = () => resolve([]);
        } catch { resolve([]); }
      });
      if (my !== gen) return;
      const ix = recs.find((x) => x.id === 'idx');
      if (ix && ix.hosts) {
        for (const [h, e] of Object.entries(ix.hosts)) idx.set(h, { c: e[0], ts: e[1], u: e[2] || 0 });
        (ix.used || []).forEach((v, k) => { if (k < ATLAS_MAX) used[k] = v; });
        (ix.free || []).forEach((c) => free.push(c));
      }
      for (const r of recs) {
        if (!/^a\d$/.test(r.id) || !r.blob) continue;
        const k = Number(r.id[1]);
        if (k >= ATLAS_MAX) continue;
        atl[k] = { cp: r.cp || 16, rows: r.rows || 1, canvas: null, ctx: null, url: URL.createObjectURL(r.blob), blob: r.blob, dirty: false };
        setVars(k);
      }
      // an index entry without its atlas image is meaningless
      for (const [h, e] of idx) if (e.c >= 0 && !atl[e.c >> 10]) idx.delete(h);
    }
    st.coldLoadMs = Math.round(performance.now() - t0);
    ready = true;
    if (onReady) onReady(null);
    pump();
  }

  async function ensureCanvas(k) {
    let a = atl[k];
    if (a && a.canvas) return a;
    const cp = a ? a.cp : 16 * dpr;
    const rows = a ? a.rows : 8;
    const cv = new OffscreenCanvas(COLS * cp, rows * cp);
    const ctx = cv.getContext('2d');
    if (a && a.blob) { try { const bmp = await createImageBitmap(a.blob); ctx.drawImage(bmp, 0, 0); bmp.close(); } catch { /* start blank */ } }
    a = atl[k] || (atl[k] = { cp, rows, canvas: null, ctx: null, url: null, blob: null, dirty: false });
    a.canvas = cv; a.ctx = ctx;
    return a;
  }

  async function growTo(k, rowsNeeded) {
    const a = await ensureCanvas(k);
    if (rowsNeeded <= a.rows) return a;
    const rows = Math.min(ROWS_MAX, Math.max(rowsNeeded, a.rows * 2));
    const cv = new OffscreenCanvas(COLS * a.cp, rows * a.cp);
    const ctx = cv.getContext('2d');
    ctx.drawImage(a.canvas, 0, 0);
    a.canvas = cv; a.ctx = ctx; a.rows = rows;
    return a;
  }

  function allocCell() {
    if (free.length) return free.pop();
    for (let k = 0; k < ATLAS_MAX; k++) if (used[k] < PER_ATLAS) return k * PER_ATLAS + used[k]++;
    // everything is taken: the least recently shown host that is not on screen gives its cell up
    let best = null;
    for (const [h, e] of idx) if (e.c >= 0 && !want.has(h) && (!best || e.u < best[1].u)) best = [h, e];
    if (!best) return -1;
    const c = best[1].c;
    idx.delete(best[0]);
    st.evicted++;
    return c;
  }

  async function putIcon(host, blob) {
    const c = allocCell();
    if (c < 0) return false;
    const k = c >> 10;
    const cell = c & (PER_ATLAS - 1);
    const row = Math.floor(cell / COLS);
    const a = await growTo(k, row + 1);
    const bmp = await createImageBitmap(blob);
    const x = (cell % COLS) * a.cp;
    const y = row * a.cp;
    a.ctx.clearRect(x, y, a.cp, a.cp);
    a.ctx.imageSmoothingQuality = 'high';
    a.ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, x, y, a.cp, a.cp);
    bmp.close();
    a.dirty = true;
    idx.set(host, { c, ts: Date.now(), u: Date.now() });
    newCount++; idxDirty = true;
    scheduleExport();
    return true;
  }

  function scheduleExport() {
    clearTimeout(exportT);
    const go = () => { const f = () => doExport(); if (typeof requestIdleCallback === 'function') requestIdleCallback(f, { timeout: 2000 }); else setTimeout(f, 0); };
    if (newCount >= EXPORT_N) go(); else exportT = setTimeout(go, EXPORT_IDLE);
  }

  async function doExport() {
    if (exporting) { exportAgain = true; return; }
    exporting = true;
    const my = gen;
    const t0 = performance.now();
    try {
      const recs = [];
      for (let k = 0; k < ATLAS_MAX; k++) {
        const a = atl[k];
        if (!a || !a.dirty || !a.canvas) continue;
        const blob = await a.canvas.convertToBlob({ type: 'image/png' });
        if (my !== gen) return;
        const url = URL.createObjectURL(blob);
        // preload + decode so swapping the CSS variable never flashes blank
        try { const im = new Image(); im.src = url; await im.decode(); } catch { /* ignore */ }
        const old = a.url;
        a.url = url; a.blob = blob; a.dirty = false;
        setVars(k);
        if (old) setTimeout(() => URL.revokeObjectURL(old), 3000);
        recs.push({ id: 'a' + k, blob, cp: a.cp, rows: a.rows, ts: Date.now() });
      }
      newCount = 0;
      if (recs.length || idxDirty) await persist(recs);
      st.exports++;
      st.exportMs += performance.now() - t0;
      if (onReady) onReady(null);
    } catch { st.errors++; } finally {
      exporting = false;
      if (exportAgain) { exportAgain = false; scheduleExport(); }
    }
  }

  async function persist(recs) {
    const db = await openDb();
    if (!db) return;
    const hosts = {};
    const misses = [];
    for (const [h, e] of idx) { if (e.c >= 0) hosts[h] = [e.c, e.ts, e.u]; else misses.push([h, e]); }
    if (misses.length > MISS_MAX) { misses.sort((x, y) => y[1].ts - x[1].ts); misses.length = MISS_MAX; }
    for (const [h, e] of misses) hosts[h] = [-1, e.ts, 0];
    idxDirty = false;
    await new Promise((resolve) => {
      try {
        const t = db.transaction('atlas', 'readwrite');
        const s = t.objectStore('atlas');
        for (const r of recs) s.put(r);
        s.put({ id: 'idx', hosts, used: used.slice(), free: free.slice(), ts: Date.now() });
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
        t.onabort = () => resolve();
      } catch { resolve(); }
    });
  }

  async function fetchIcon(url, signal) {
    st.fetches++;
    const r = await fetch(favUrl(url), { signal });
    const buf = new Uint8Array(await r.arrayBuffer());
    const sig = await getDefaultSig();
    if (buf.length === sig.len && hashBytes(buf) === sig.hash) return null;
    if (buf.length < 8) return null;
    return new Blob([buf], { type: r.headers.get('content-type') || 'image/png' });
  }

  const fresh = (e) => !!e && Date.now() - e.ts < (e.c < 0 ? TTL_MISS : TTL_HIT);

  async function load(host, sample) {
    if (inflight.has(host)) return;
    const ctl = new AbortController();
    inflight.set(host, ctl);
    st.maxInflight = Math.max(st.maxInflight, inflight.size);
    st.started++;
    try {
      let blob = await fetchIcon(sample, ctl.signal);
      if (!blob && !ctl.signal.aborted) {
        let rt = '';
        try { rt = new URL(sample).origin + '/'; } catch { /* ignore */ }
        if (rt && rt !== sample) blob = await fetchIcon(rt, ctl.signal);
      }
      if (ctl.signal.aborted) { st.aborted++; return; }
      const prev = idx.get(host);
      if (prev && prev.c >= 0) { free.push(prev.c); idx.delete(host); }
      if (blob && blob.size <= MAX_BLOB * 4 && !degraded) {
        if (!(await putIcon(host, blob))) { idx.set(host, { c: -1, ts: Date.now(), u: 0 }); st.misses++; idxDirty = true; }
      } else if (!blob) {
        idx.set(host, { c: -1, ts: Date.now(), u: 0 });
        st.misses++; idxDirty = true;
        scheduleExport();
      }
      if (onReady) onReady(host);
    } catch (e) {
      if (ctl.signal.aborted) st.aborted++; else st.errors++;
    } finally {
      inflight.delete(host);
      pump();
    }
  }

  function pump() {
    if (!ready || !enabled || paused || degraded) return;
    while (inflight.size < MAX_INFLIGHT && queue.size) {
      const [host, sample] = queue.entries().next().value;
      queue.delete(host);
      if (!want.has(host)) continue;
      if (fresh(idx.get(host))) continue;
      load(host, sample);
    }
  }

  function dropAll() {
    gen++;
    clearTimeout(exportT);
    for (let k = 0; k < atl.length; k++) {
      const a = atl[k];
      if (!a) continue;
      if (a.url) URL.revokeObjectURL(a.url);
      root.style.removeProperty('--fa' + k);
      root.style.removeProperty('--fah' + k);
    }
    atl.length = 0; idx.clear(); free.length = 0; used.fill(0);
    ready = false; newCount = 0; idxDirty = false;
  }

  const queueIt = (host, sampleUrl) => {
    want.add(host);
    if (!queue.has(host) && !inflight.has(host)) { queue.set(host, sampleUrl); pump(); }
  };

  openDb().then(loadFromDb);

  return {
    atlas: true,
    iconFor() { return null; },
    /** global cell id of the host's icon, or -1 (unknown / miss / off). Queues a load when unknown or stale. */
    cellFor(host, sampleUrl) {
      if (!enabled || degraded || !host) return -1;
      const e = idx.get(host);
      if (!fresh(e)) queueIt(host, sampleUrl);
      if (e && e.c >= 0 && atl[e.c >> 10] && atl[e.c >> 10].url) { st.memHits++; e.u = Date.now(); return e.c; }
      return -1;
    },
    /** paints the cell onto a .fav/.fs element: --ap (background position) + data-ak (which atlas); the .av child draws the sprite from the --fa<k> variables */
    cellStyle(el, c) {
      const k = c >> 10;
      const cell = c & (PER_ATLAS - 1);
      el.style.setProperty('--ap', '-' + (cell % COLS) * 16 + 'px -' + Math.floor(cell / COLS) * 16 + 'px');
      if (el.dataset.ak !== String(k)) el.dataset.ak = String(k);
    },
    known(host) { return fresh(idx.get(host)); },
    setVisible(hosts) {
      want.clear();
      for (const h of hosts) want.add(h);
      for (const h of queue.keys()) if (!want.has(h)) queue.delete(h);
      for (const [h, ctl] of inflight) if (!want.has(h)) ctl.abort();
    },
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) { queue.clear(); for (const c of inflight.values()) c.abort(); } else pump();
    },
    setPaused(v) { paused = !!v; if (!paused) pump(); },
    setDegraded(v) {
      v = !!v;
      if (v === degraded) return;
      degraded = v;
      if (degraded) { queue.clear(); for (const c of inflight.values()) c.abort(); dropAll(); } else loadFromDb();
    },
    isDegraded: () => degraded,
    stats: () => ({ ...st, inflight: inflight.size, queued: queue.size, hosts: idx.size, cells: [...idx.values()].filter((e) => e.c >= 0).length, atlases: atl.filter(Boolean).length, paused, degraded, ready, dpr }),
    async clear() {
      dropAll();
      const db = await openDb();
      if (db) { try { db.transaction('atlas', 'readwrite').objectStore('atlas').clear(); } catch { /* ignore */ } }
      loadFromDb();
    },
  };
}import * as lockrt from './lockrt.js';

