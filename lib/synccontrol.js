// Cross-device sync controller: wires the pure core (lib/sync/*) to this extension's IndexedDB + chrome.bookmarks.
// Password lock: with the lock ON the engine's local state is sealed under the lock's key (lib/syncseal.js). While the app is LOCKED
// this controller stands completely still (no engine, no timers, no reads or writes of sync state): nothing is pushed or pulled,
// nothing can fail to decrypt and overwrite good data; local changes made meanwhile stay marked in meta.syncDirty and are
// scanned after the unlock (onLockChange). A remote that was written with a different key is rejected by the engine as before.
// Runs in the service worker (and, for tests, in a second extension page with its own database name = a second "device").
//
//   const sync = createSyncController({ bookmarks: chrome.bookmarks, canApply, alarms })
//   installBookmarkListeners(chrome.bookmarks, (raw) => sync.raw(raw))   // SW top level, synchronously (events are queued until init)
//   await sync.init()                                                    // on every SW start
//   await sync.handle({type:'sync/enable', ...})
import * as db from './db.js';
import { createEngine } from './sync/engine.js';
import { createBookmarksTransport } from './sync/transport-bookmarks.js';
import { createKv, createMergeStore, createScanner, DEFAULT_SCOPE } from './syncstore.js';
import { createSealedKv, createSealedKeyStore, sealAll, unsealAll, packV, readV, LockedError } from './syncseal.js';
import { lockAdapter } from './synclockrt.js';

const MB = 1024 * 1024;
export const BUDGETS_MB = [4, 8];

export function createSyncController({
  bookmarks, ensure = async () => {}, canApply = () => true, onStatus = () => {}, scheduleAlarm = () => {}, iter, minIter, partSize, deviceLabel = '', clock = { now: () => Date.now() },
  lock = lockAdapter, flag = null,
}) {
  // `bookmarks` is the chrome.bookmarks object OR a function returning it / undefined (the permission is optional and may come and go).
  const bm = () => (typeof bookmarks === 'function' ? bookmarks() : bookmarks) || null;
  const NO_API = new Proxy({}, { get: () => () => Promise.reject(new Error('no-permission')) });
  let hadBm = null;
  const rawKv = createKv();
  const kv = createSealedKv(rawKv, lock); // lock off: a pass-through
  const keys = createSealedKeyStore(rawKv, lock);
  const isLocked = () => lock.enabled() && lock.locked();
  let lockedIdle = false; // the app is locked: this controller does nothing
  let holding = false; // the lock is being removed / sync data re-sealed: no engine activity
  const flagStore = flag || {
    get: async () => { try { return !!(await chrome.storage.local.get('syncFlag')).syncFlag; } catch { return false; } },
    set: async (v) => { try { await chrome.storage.local.set({ syncFlag: !!v }); } catch { /* ignore */ } },
  };
  // the only plain fact about sync kept while locked: "sync is on", so that stashes made while locked still mark their groups for the scan
  const setOn = (v) => { db.setSyncOn(!!v); flagStore.set(!!v); };
  const store = createMergeStore();
  let engine = null;
  let scanner = null;
  let transport = null;
  let cfg = { scope: { ...DEFAULT_SCOPE }, budgetMB: 4 };
  let deviceId = null;
  let inited = null;
  let scanning = false;
  let again = false;
  let lastStatus = null;
  const pendingRaw = [];

  const timers = {
    set: (fn, ms) => { if (ms >= 30000) scheduleAlarm(ms); return setTimeout(fn, ms); },
    clear: (h) => clearTimeout(h),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    yield: () => new Promise((r) => setTimeout(r, 0)),
  };

  function publish(st) {
    lastStatus = { ...st, enabled: !!(engine && engine._P().config.enabled), scope: cfg.scope, budgetMB: cfg.budgetMB, rejoin: !!cfg.rejoin, deviceId, deviceName: engine ? engine._P().config.deviceName : '' };
    if (lastStatus.enabled && !bm()) { lastStatus.state = 'needsPermission'; lastStatus.needsPermission = true; } // paused cleanly; local data untouched
    try { onStatus(lastStatus); } catch { /* ignore */ }
  }

  function build() {
    if (engine) engine.shutdown();
    transport = createBookmarksTransport(bm() || NO_API, {
      cache: { get: () => kv.get('tracked'), set: (v) => kv.set('tracked', v) },
    });
    engine = createEngine({
      deviceId, store, transport, state: kv, keys, clock, timers, iter, minIter, partSize, dekExtractable: true,
      budgetBytes: cfg.budgetMB * MB, canApply: () => !isLocked() && !holding && canApply(), onStatus: publish,
    });
    scanner = createScanner({ engine, getScope: () => cfg.scope });
    while (pendingRaw.length) { try { transport.handleRaw(pendingRaw.shift()); } catch { /* ignore */ } }
  }

  /** Raw chrome.bookmarks event (listener installed at the SW top level). */
  function raw(ev) {
    if (transport) { try { transport.handleRaw(ev); } catch { /* ignore */ } } else if (pendingRaw.length < 200) pendingRaw.push(ev);
  }

  /** Locked: forget the engine (its timers stop), keep only the one plain flag, tell the UI. */
  async function enterLocked() {
    lockedIdle = true;
    if (engine) { try { engine.shutdown(); } catch { /* ignore */ } }
    engine = null; scanner = null; transport = null;
    let on = false;
    try { on = await flagStore.get(); } catch { on = false; }
    db.setSyncOn(on);
    lastStatus = { state: 'locked', enabled: on, lockedPaused: true, scope: cfg.scope, budgetMB: cfg.budgetMB };
    try { onStatus(lastStatus); } catch { /* ignore */ }
  }

  async function init() {
    if (inited) return inited;
    if (isLocked()) { await enterLocked(); inited = Promise.resolve(false); return inited; }
    lockedIdle = false;
    inited = (async () => {
      hadBm = !!bm();
      deviceId = await kv.get('deviceId');
      if (!deviceId) { deviceId = 'd' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); await kv.set('deviceId', deviceId); }
      const c = await kv.get('cfg');
      if (c) cfg = { ...cfg, ...c, scope: { ...DEFAULT_SCOPE, ...(c.scope || {}) } };
      build();
      let on = false;
      if (!hadBm) { try { await engine.load(); } catch { /* nothing saved yet */ } } else { try { on = await engine.resume(); } catch { on = false; } }
      const st = engine.status();
      setOn(!!engine._P().config.enabled);
      publish(st);
      if (on) { await flushLocal(); try { await engine.check(); } catch { /* the hourly alarm retries */ } }
      return true;
    })().catch(async (e) => {
      if (e instanceof LockedError || isLocked()) { await enterLocked(); return false; } // locked while starting: stand still
      throw e;
    });
    return inited;
  }

  /** The password lock was locked or unlocked (or removed): stand still / start again from the saved state. */
  async function onLockChange() {
    if (isLocked()) { inited = null; await enterLocked(); inited = Promise.resolve(false); return { locked: true }; }
    holding = false; lockedIdle = false; inited = null;
    await init();
    return { locked: false };
  }

  /** Local changes -> ops. Cheap when nothing is dirty. */
  async function flushLocal() {
    if (lockedIdle || holding || isLocked() || !engine || !bm() || !engine._P().config.enabled || engine._P().config.paused) return { skipped: true };
    if (scanning) { again = true; return { busy: true }; }
    scanning = true;
    let total = { groups: 0, ops: 0 };
    try {
      do {
        again = false;
        const r = await scanner.run({ shouldStop: () => !canApply() || isLocked() || holding });
        total = { groups: total.groups + r.groups, ops: total.ops + r.ops };
      } while (again);
    } finally { scanning = false; }
    return total;
  }

  async function saveCfg() { await kv.set('cfg', cfg); publish(engine.status()); }

  async function afterEnable() {
    setOn(true);
    if (cfg.rejoin) { delete cfg.rejoin; await kv.set('cfg', cfg); }
    await db.syncMarkAllDirty();
    return flushLocal();
  }

  /** The bookmarks permission was granted or removed: rebuild the engine (reattach / pause) without touching saved data. */
  async function permChanged() {
    await init();
    if (lockedIdle || isLocked()) return false;
    const now = !!bm();
    if (hadBm === now) return false;
    inited = null;
    await init();
    return true;
  }

  const NO_PERM_OK = new Set(['sync/getStatus', 'sync/disableLocal']);

  async function handle(msg) {
    await init();
    if (lockedIdle || holding || isLocked()) return { ok: false, error: 'locked' };
    try { await ensure(); } catch { /* ignore */ }
    await permChanged();
    if (!bm() && !NO_PERM_OK.has(msg.type)) return { ok: false, error: 'no-permission' };
    switch (msg.type) {
      case 'sync/getStatus': return { ok: true, status: { ...engine.status(), enabled: engine._P().config.enabled, rejoin: !!cfg.rejoin, scope: cfg.scope, budgetMB: cfg.budgetMB, deviceId, deviceName: engine._P().config.deviceName, ...(!bm() && engine._P().config.enabled ? { state: 'needsPermission', needsPermission: true } : {}) } };
      case 'sync/enable': {
        if (msg.scope) cfg.scope = { ...DEFAULT_SCOPE, ...msg.scope };
        if (BUDGETS_MB.includes(msg.budgetMB)) { cfg.budgetMB = msg.budgetMB; build(); }
        await kv.set('cfg', cfg);
        await engine.enable(String(msg.passphrase || ''), { deviceName: msg.deviceName || deviceLabel });
        const r = await afterEnable();
        publish(engine.status());
        return { ok: true, published: r };
      }
      case 'sync/join': {
        if (msg.scope) cfg.scope = { ...DEFAULT_SCOPE, ...msg.scope };
        await kv.set('cfg', cfg);
        await engine.join(String(msg.passphrase || ''), { deviceName: msg.deviceName || deviceLabel });
        const r = await afterEnable();
        publish(engine.status());
        return { ok: true, published: r };
      }
      case 'sync/pause': await engine.pause(); return { ok: true };
      case 'sync/resume': await engine.resumeSync(); await flushLocal(); return { ok: true };
      case 'sync/now': await flushLocal(); await engine.syncNow(); return { ok: true, status: engine.status() };
      case 'sync/setScope': {
        cfg.scope = { ...DEFAULT_SCOPE, ...(msg.scope || {}) };
        await saveCfg();
        await db.syncMarkAllDirty();
        await flushLocal();
        return { ok: true };
      }
      case 'sync/setBudget': {
        if (!BUDGETS_MB.includes(msg.budgetMB)) return { ok: false, error: 'bad-budget' };
        cfg.budgetMB = msg.budgetMB;
        await kv.set('cfg', cfg);
        const was = engine._P().config.enabled;
        build();
        if (was) await engine.resume();
        publish(engine.status());
        return { ok: true };
      }
      case 'sync/renameDevice': {
        engine._P().config.deviceName = String(msg.name || '').slice(0, 60);
        await kv.set('config', engine._P().config);
        publish(engine.status());
        return { ok: true };
      }
      case 'sync/changePassphrase': await engine.changePassphrase(String(msg.oldPass || ''), String(msg.newPass || '')); return { ok: true };
      case 'sync/rotateKey': await engine.rotateKey(String(msg.passphrase || '')); return { ok: true };
      case 'sync/unlock': await engine.unlockAfterRotation(String(msg.passphrase || '')); return { ok: true };
      case 'sync/disableLocal': await engine.disableLocal(); setOn(false); publish(engine.status()); return { ok: true };
      case 'sync/wipeRemote': {
        await engine.wipeRemote({ waitMs: msg.waitMs == null ? 60000 : msg.waitMs }); // marks the vault closed, waits for peers, removes the remote tree, wipes local sync state
        setOn(false);
        publish(engine.status());
        return { ok: true };
      }
      case 'sync/removeDevice': await engine.removeDevice(String(msg.id || ''), { force: !!msg.force }); return { ok: true };
      default: return { ok: false, error: 'unknown-sync-message' };
    }
  }

  /** chrome.alarms: hourly consistency check / retry. */
  async function tick() {
    await init();
    if (lockedIdle || holding || isLocked() || !engine || !bm() || !engine._P().config.enabled) return;
    await flushLocal();
    await engine.check();
  }

  // ---- the lock was turned on / is being turned off while sync data exists ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function quiesce() { holding = true; for (let i = 0; i < 400 && scanning; i++) await sleep(50); if (engine) { try { engine.shutdown(); } catch { /* ignore */ } } engine = null; scanner = null; transport = null; inited = null; }
  async function eachSyRow(fn) { // chunked pass over the `sy` rows; fn(row) returns the replacement row or null
    let after = null;
    for (;;) {
      const rows = await db.readRaw(['sy'], (s) => db.req(s.sy.getAll(after == null ? null : IDBKeyRange.lowerBound(after, true), 400)));
      if (!rows.length) break;
      after = rows[rows.length - 1].k;
      const out = [];
      for (const r of rows) { const n = await fn(r); if (n) out.push(n); }
      if (out.length) await db.writeRemote(['sy'], async (s) => { for (const r of out) s.sy.put(r); }, null, true);
      if (rows.length < 400) break;
    }
  }
  /** Migration to the lock finished: seal what the engine kept in plain (state, DEK, synced values). Idempotent. */
  async function sealAtRest() {
    await quiesce();
    let r = { sealed: 0, droppedDek: false };
    try {
      r = await sealAll(rawKv, lock);
      await eachSyRow(async (row) => {
        if (row.v === undefined || row.ve) return null;
        const { v, ...rest } = row;
        return { ...rest, ve: (await packV(lock, row.k, v)).ve };
      });
      if (r.droppedDek) { // a key made before the lock cannot be wrapped: this device pairs again with the sync passphrase (nothing is lost)
        deviceId = deviceId || (await kv.get('deviceId'));
        build();
        try { await engine.load(); await engine.disableLocal(); } catch { /* ignore */ }
        engine.shutdown(); engine = null; scanner = null; transport = null;
        setOn(false);
        cfg.rejoin = true;
        await kv.set('cfg', cfg);
      }
    } finally { holding = false; inited = null; }
    await init();
    return r;
  }
  /** Lock is being removed: everything the engine kept goes back to plain BEFORE the key disappears. The engine stays stopped until onLockChange. */
  async function unsealAtRest() {
    await quiesce();
    await unsealAll(rawKv, lock);
    await eachSyRow(async (row) => {
      if (!row.ve) return null;
      const { ve, ...rest } = row;
      return { ...rest, v: await readV(lock, row.k, row) };
    });
    return { ok: true };
  }

  return { init, raw, handle, permChanged, flushLocal, tick, onLockChange, sealAtRest, unsealAtRest, status: () => lastStatus, _engine: () => engine, _scanner: () => scanner, _cfg: () => cfg };
}
