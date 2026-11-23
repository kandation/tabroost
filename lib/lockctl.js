// Password lock controller (service worker only). Implements the message protocol of spec §7 on top of lib/lock/* and
// lib/lockrt.js. PBKDF2 and the failure counter run ONLY here; the password arrives in a message, is never stored and the
// variables holding it are dropped right after use. Feature flag: nothing runs until `lock.enable` created meta.lock.
import * as db from './db.js';
import * as lockrt from './lockrt.js';
import { post } from './bus.js';
import { runExclusive } from './queue.js';
import { ALARMS, SEARCH_DB } from './constants.js';
import {
  setupLock, unlockWithPassword, unlockWithRecovery, completeRecoveryUnlock, changePassword as changePw, newRecoveryKey,
  withoutRecovery, WrongPasswordError, WrongRecoveryKeyError, RecoveryFormatError, NoRecoveryKeyError, PubTamperedError, LockMetaError, readSession,
  unlockWithBackupPassword, unlockWithSlot, unlockWithAnyPassword, addPasswordSlot, addPrfSlot, removeSlot, publicSlots,
  WrongBackupPasswordError, WrongSlotError, NoSlotError, SlotError,
} from './lock/keys.js';
import { b64dec, wipe } from './lock/bytes.js';
import { passwordStrength } from './lock/kdf.js';
import * as policy from './lock/policy.js';
import { runMigration, cancelMigration as cancelMig, totalRows } from './lock/migrate.js';
import { runSeal } from './lock/seal.js';
import * as rec from './lock/rec.js';
import { idbStore } from './lockdb.js';
import { titleKey, searchText } from './formats.js';
import { lockSecrets } from './settings.js';
import { setSalt } from './drainkey.js';

const LS = { FAIL: 'lockFail', POLICY: 'lockPolicy', JOB: 'lockJob' };
export const DEFAULT_POLICY = { idleMin: policy.DEFAULT_IDLE_MIN, onScreenLock: true, onPageClose: false };
// i18n-allow: the word the user types to confirm an erase; the Thai and the English screen each ask for their own word (lockstr.js / i18n.js eraseWord)
const ERASE_WORDS = ['ลบทั้งหมด', 'ERASE'];
let hooks = { onLock: () => {}, onUnlock: () => {}, extras: null };
/** sw.js binds: onLock (rebuild menus, pause sync), onUnlock (resume), extras = adapters for data outside cmr (settings, favicons, vault) */
export function bind(h) { hooks = { ...hooks, ...h }; }

const local = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: (k) => chrome.storage.local.remove(k),
};
const session = () => lockrt.session_();

let lastError = '';
let job = null; // {kind:'migrate'|'revert'|'seal', done, total, store?} (memory; the cursors on disk are the truth)
let cancelRequested = false;
let running = false;
let again = false;

// ---------- state ----------
export async function getPolicy() { return { ...DEFAULT_POLICY, ...((await local.get(LS.POLICY)) || {}) }; }
async function getFail() { return policy.normalizeFail((await local.get(LS.FAIL)) || policy.initialFailState(), Date.now()); }
const putFail = (s) => local.set(LS.FAIL, s);

/** drain journal: a per-install salt while the lock is on (see lib/drainkey.js), none when it is off */
async function refreshDrainSalt() {
  if (!lockrt.enabled()) { setSalt(null); return; }
  let s = await local.get('drainSalt');
  if (!s) { s = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''); await local.set('drainSalt', s); }
  setSalt(s);
}

export async function init() {
  const st = await lockrt.init({ useSession: true });
  await refreshDrainSalt();
  if (st.enabled) await afterWake();
  return st;
}

async function afterWake() {
  if (!lockrt.isLocked()) { ensureAlarm(); runJobs(); }
}

export async function status() {
  await lockrt.ensureKeys();
  const meta = lockrt.metaRow();
  const fail = await getFail();
  const base = lockrt.status();
  const out = { enabled: base.enabled, state: base.state, locked: base.locked, failN: fail.n, failUntil: fail.until, hasRecovery: !!(meta && meta.rec), slots: publicSlots(meta), policy: await getPolicy(), job: null, inboxGroups: 0, now: Date.now(), error: lastError };
  if (meta) {
    out.inboxGroups = await db.readRaw(['inbox'], (s) => db.req(s.inbox.count()));
    if (job) out.job = { kind: job.kind, done: job.done, total: job.total };
    else {
      const store = idbStore();
      const mode = meta.state === 'reverting' ? 'revert' : meta.state === 'migrating' ? 'migrate' : null;
      if (mode) {
        const cur = await store.getCursor(mode === 'revert' ? 'encRevert' : 'encMigrate');
        const lj = await local.get(LS.JOB);
        out.job = { kind: mode, done: cur ? cur.done : 0, total: (lj && lj.kind === mode ? lj.total : 0), paused: true };
      }
    }
  }
  return out;
}

async function broadcast() { post({ type: 'lock.state', ...(await status()) }); }
const progress = (p) => post({ type: p.kind === 'seal' ? 'seal.progress' : 'lock.progress', kind: p.kind, done: p.done, total: p.total, state: lockrt.state() });

// ---------- alarm / auto lock ----------
function ensureAlarm() { chrome.alarms.create(ALARMS.LOCK, { periodInMinutes: 1, delayInMinutes: 1 }).catch(() => {}); }
function dropAlarm() { chrome.alarms.clear(ALARMS.LOCK).catch(() => {}); }

export async function onAlarm() {
  if (!lockrt.enabled()) { dropAlarm(); return; }
  const s = await readSession(session().adapter);
  const p = await getPolicy();
  const d = policy.decideLock({ unlocked: !!s, now: Date.now(), lastTouch: s ? s.lastTouch : 0, idleMin: p.idleMin });
  if (d.lock) await lockNow(d.reason);
}
export async function onOsLock() {
  if (!lockrt.enabled() || lockrt.isLocked()) return;
  const p = await getPolicy();
  const d = policy.decideLock({ unlocked: true, now: Date.now(), lastTouch: Date.now(), idleMin: null, osLocked: true, onScreenLock: p.onScreenLock });
  if (d.lock) await lockNow(d.reason);
}
/** called after a tab was closed; `stillOpen` = number of list pages left */
export async function onPageClosed(stillOpen) {
  if (!lockrt.enabled() || lockrt.isLocked() || stillOpen > 0) return;
  const p = await getPolicy();
  const d = policy.decideLock({ unlocked: true, now: Date.now(), lastTouch: Date.now(), idleMin: null, pageClosed: true, onPageClose: p.onPageClose });
  if (d.lock) await lockNow(d.reason);
}
export async function touch() {
  if (!lockrt.enabled() || lockrt.isLocked()) return { locked: lockrt.isLocked() };
  await session().touch();
  return {};
}

// ---------- enable ----------
export async function enable({ password, withRecovery = true } = {}) {
  if (lockrt.enabled()) return { error: 'already' };
  const pw = String(password || '');
  if (!passwordStrength(pw).ok) return { error: 'tooShort' };
  const r = await setupLock({ password: pw, withRecovery: withRecovery !== false });
  await runExclusive(async () => {
    await db.writeRemote([], async (s) => { s.meta.put(r.meta); }, null, true);
    await session().unlocked(r.keys, r.mk);
    await lockrt.refresh();
    await local.set(LS.FAIL, policy.initialFailState());
  });
  ensureAlarm();
  await broadcast();
  runJobs();
  await refreshDrainSalt();
  return { recoveryKey: r.recoveryKey || null };
}

// ---------- unlock ----------
let unlockChain = Promise.resolve();
export function unlock(args) {
  const run = unlockChain.then(() => doUnlock(args), () => doUnlock(args));
  unlockChain = run.catch(() => {});
  return run;
}
async function doUnlock({ password, recoveryKey, newPassword, backupPassword, slot } = {}) {
  const meta = lockrt.metaRow() || (await db.getLockRow());
  if (!meta) return { error: 'off' };
  const now = Date.now();
  const f = await getFail();
  const can = policy.canAttempt(f, now);
  if (!can.allowed) return { error: 'wait', waitMs: can.waitMs, failUntil: f.until };
  let res;
  let metaNext = null;
  try {
    if (recoveryKey != null && String(recoveryKey).trim() !== '') {
      if (!passwordStrength(newPassword).ok) return { error: 'needNewPassword' };
      res = await unlockWithRecovery(meta, String(recoveryKey));
      metaNext = await completeRecoveryUnlock(meta, res.mk, String(newPassword));
    } else if (backupPassword != null && String(backupPassword) !== '') {
      res = await unlockWithBackupPassword(meta, String(backupPassword)); // second unlock method: same lockout, same session
    } else if (slot && typeof slot === 'object' && slot.id) {
      let prf = null;
      try { prf = b64dec(String(slot.prf || '')); } catch { prf = null; }
      try { res = await unlockWithSlot(meta, String(slot.id), prf); } finally { wipe(prf); }
    } else {
      res = await unlockWithPassword(meta, String(password || ''));
    }
  } catch (e) {
    if (e instanceof RecoveryFormatError) return { error: 'badFormat' };
    if (e instanceof NoRecoveryKeyError) return { error: 'noRecovery' };
    if (e instanceof NoSlotError) return { error: 'noSlot' };
    if (e instanceof PubTamperedError) return { error: 'tampered' };
    if (e instanceof LockMetaError) return { error: 'damaged' };
    if (e instanceof WrongPasswordError || e instanceof WrongRecoveryKeyError || e instanceof WrongBackupPasswordError || e instanceof WrongSlotError) {
      const nf = policy.onFailure(f, Date.now());
      await putFail(nf);
      await broadcast();
      return { error: 'wrong', failN: nf.n, failUntil: nf.until, waitMs: Math.max(0, nf.until - Date.now()) };
    }
    return { error: 'failed' };
  }
  await runExclusive(async () => {
    if (metaNext) await db.writeRemote([], async (s) => { s.meta.put(metaNext); }, null, true);
    await session().unlocked(res.keys, res.mk);
    await lockrt.refresh();
  });
  await putFail(policy.onSuccess());
  ensureAlarm();
  try { hooks.onUnlock(); } catch { /* ignore */ }
  await broadcast();
  runJobs();
  return { ok: true };
}

// ---------- lock ----------
export async function lockNow(reason) {
  if (!lockrt.enabled()) return { error: 'off' };
  await session().lock();
  await lockrt.refresh();
  dropAlarm();
  try { hooks.onLock(reason); } catch { /* ignore */ }
  await broadcast();
  return { locked: true, reason: reason || 'manual' };
}

// ---------- change password / recovery key ----------
export async function changePassword({ old, new: nw } = {}) {
  const meta = lockrt.metaRow();
  if (!meta) return { error: 'off' };
  if (!passwordStrength(nw).ok) return { error: 'tooShort' };
  const f = await getFail();
  const can = policy.canAttempt(f, Date.now());
  if (!can.allowed) return { error: 'wait', waitMs: can.waitMs, failUntil: f.until };
  try {
    const r = await changePw(meta, String(old || ''), String(nw)); // old = main or backup password; the slots are kept
    await runExclusive(() => db.writeRemote([], async (s) => { s.meta.put(r.meta); }, null, true));
    await lockrt.refresh();
    await putFail(policy.onSuccess());
    return { ok: true };
  } catch (e) {
    if (e instanceof WrongPasswordError) { const nf = policy.onFailure(f, Date.now()); await putFail(nf); return { error: 'wrong', failN: nf.n, failUntil: nf.until }; }
    return { error: 'failed' };
  }
}
export async function newRecovery({ password } = {}) {
  const meta = lockrt.metaRow();
  if (!meta) return { error: 'off' };
  const f = await getFail();
  const can = policy.canAttempt(f, Date.now());
  if (!can.allowed) return { error: 'wait', waitMs: can.waitMs, failUntil: f.until };
  try {
    const r = await newRecoveryKey(meta, String(password || ''));
    await runExclusive(() => db.writeRemote([], async (s) => { s.meta.put(r.meta); }, null, true));
    await lockrt.refresh();
    await putFail(policy.onSuccess());
    return { recoveryKey: r.recoveryKey };
  } catch (e) {
    if (e instanceof WrongPasswordError) { const nf = policy.onFailure(f, Date.now()); await putFail(nf); return { error: 'wrong', failN: nf.n, failUntil: nf.until }; }
    return { error: 'failed' };
  }
}
export async function removeRecovery({ password } = {}) {
  const meta = lockrt.metaRow();
  if (!meta) return { error: 'off' };
  try { await unlockWithAnyPassword(meta, String(password || '')); } catch { return { error: 'wrong' }; }
  await runExclusive(() => db.writeRemote([], async (s) => { s.meta.put(withoutRecovery(meta)); }, null, true));
  await lockrt.refresh();
  return { ok: true };
}

// ---------- extra unlock methods (slots): backup password, passkey ----------
/** Every slot change needs the list to be unlocked AND the current password (main or backup); lockout applies to that check. */
async function withAuth(password, fn) {
  const meta = lockrt.metaRow();
  if (!meta) return { error: 'off' };
  if (lockrt.isLocked()) return { error: 'locked' };
  if (meta.state === 'reverting') return { error: 'busy' };
  const f = await getFail();
  const can = policy.canAttempt(f, Date.now());
  if (!can.allowed) return { error: 'wait', waitMs: can.waitMs, failUntil: f.until };
  let r;
  try { r = await unlockWithAnyPassword(meta, String(password || '')); } catch (e) {
    if (e instanceof WrongPasswordError) { const nf = policy.onFailure(f, Date.now()); await putFail(nf); return { error: 'wrong', failN: nf.n, failUntil: nf.until }; }
    return { error: 'failed' };
  }
  await putFail(policy.onSuccess());
  try {
    const next = await fn(meta, r);
    if (next && next.error) return next;
    await runExclusive(() => db.writeRemote([], async (s) => { s.meta.put(next); }, null, true));
    await lockrt.refresh();
    return { ok: true, slots: publicSlots(next) };
  } catch (e) {
    if (e instanceof SlotError) return { error: e.code };
    if (e instanceof NoSlotError) return { error: 'noSlot' };
    return { error: 'failed' };
  } finally { wipe(r.mk); }
}
export async function slotAddPassword({ password, backup } = {}) {
  if (!passwordStrength(String(backup || '')).ok) return { error: 'tooShort' };
  return withAuth(password, (meta, r) => addPasswordSlot(meta, r.mk, String(backup)));
}
export async function slotAddPrf({ password, name, cid, psalt, prf } = {}) {
  let c; let s; let p;
  try { c = b64dec(String(cid || '')); s = b64dec(String(psalt || '')); p = b64dec(String(prf || '')); } catch { return { error: 'badInput' }; }
  try { return await withAuth(password, (meta, r) => addPrfSlot(meta, r.mk, { cid: c, psalt: s, prf: p, name: String(name || '') })); } finally { wipe(p); }
}
export async function slotRemove({ password, id } = {}) {
  return withAuth(password, (meta) => removeSlot(meta, String(id || '')));
}

// ---------- policy ----------
export async function setPolicy(p = {}) {
  const cur = await getPolicy();
  const next = { ...cur };
  if (policy.IDLE_CHOICES.includes(p.idleMin)) next.idleMin = p.idleMin;
  if (typeof p.onScreenLock === 'boolean') next.onScreenLock = p.onScreenLock;
  if (typeof p.onPageClose === 'boolean') next.onPageClose = p.onPageClose;
  await local.set(LS.POLICY, next);
  return { policy: next };
}

// ---------- disable / cancel / erase ----------
export async function disable({ password } = {}) {
  const meta = lockrt.metaRow();
  if (!meta) return { error: 'off' };
  if (lockrt.isLocked()) return { error: 'locked' };
  const f = await getFail();
  const can = policy.canAttempt(f, Date.now());
  if (!can.allowed) return { error: 'wait', waitMs: can.waitMs, failUntil: f.until };
  try { await unlockWithAnyPassword(meta, String(password || '')); } catch (e) {
    if (e instanceof WrongPasswordError) { const nf = policy.onFailure(f, Date.now()); await putFail(nf); return { error: 'wrong', failN: nf.n, failUntil: nf.until }; }
    return { error: 'failed' };
  }
  await putFail(policy.onSuccess());
  await setState('reverting');
  const store = idbStore({ exclusive: runExclusive });
  await cancelMig(store);
  await broadcast();
  runJobs();
  return { ok: true };
}
export async function cancelMigration() {
  const meta = lockrt.metaRow();
  if (!meta || meta.state !== 'migrating') return { error: 'notrunning' };
  cancelRequested = true;
  await setState('reverting');
  await cancelMig(idbStore({ exclusive: runExclusive }));
  await broadcast();
  runJobs();
  return { ok: true };
}
async function setState(state) {
  const meta = lockrt.metaRow();
  const next = { ...meta, state };
  await runExclusive(() => db.writeRemote([], async (s) => { s.meta.put(next); }, null, true));
  await lockrt.refresh();
}

/** "Forgot the password and have no recovery key": erase everything this extension stored. Open tabs are untouched. */
export async function resetErase({ confirm } = {}) {
  if (!ERASE_WORDS.includes(confirm)) return { error: 'confirm' };
  cancelRequested = true;
  await runExclusive(async () => {
    await session().lock();
    await db.deleteDatabase();
    for (const n of [SEARCH_DB, 'cmr-fav']) {
      await new Promise((resolve) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    }
    const all = await chrome.storage.local.get(null);
    const doomed = Object.keys(all).filter((k) => k === 'drainSalt' || k === 'syncFlag' || k === 'vault:index' || k.startsWith('vault:') || k === LS.FAIL || k === LS.JOB || k === LS.POLICY || k === 'snapBanner' || k === 'dupLog');
    if (doomed.length) await chrome.storage.local.remove(doomed);
    if (all.settings) {
      const s = { ...all.settings }; delete s.excludeSites; delete s.whitelist; delete s.autoRulesText; delete s.autoRulesOn;
      await chrome.storage.local.set({ settings: s });
    }
    await chrome.storage.local.remove('lockSettings');
    job = null;
  });
  await lockrt.refresh();
  dropAlarm();
  try { hooks.onUnlock(); } catch { /* ignore */ } // sync restarts from the (now empty) database
  post({ type: 'reload' });
  await broadcast();
  return { ok: true };
}

// ---------- jobs: migrate / revert / seal ----------
const deriveSearch = (it) => ({ t: searchText(it.title, it.url), tk: titleKey(it.title, it.url) });

function envNow() {
  const keys = lockrt.getKeys();
  return { keys, normUrl: lockrt.normUrl, deriveSearch, isSensitiveSetting: (n) => ['excludeSites', 'whitelist', 'autoRules', 'autoRulesText'].includes(n) };
}

export function runJobs() {
  if (running) { again = true; return; }
  running = true;
  (async () => {
    try {
      do {
        again = false;
        if (!lockrt.enabled() || lockrt.isLocked()) break;
        const st = lockrt.state();
        if (st === 'migrating') await migrateJob();
        else if (st === 'reverting') { await sealJob(); await revertJob(); }
        else await sealJob();
        if (lockrt.isLocked() === false && lockrt.enabled()) { await aggAll(); try { if (hooks.onSealed) hooks.onSealed(); } catch { /* ignore */ } }
      } while (again);
    } catch (e) { lastError = String((e && (e.stack || e.message)) || e).slice(0, 400); /* paused; resumed by the next unlock / wake */ } finally {
      running = false; job = null;
      broadcast().catch(() => {});
    }
  })();
}

async function migrateJob() {
  const store = idbStore({ exclusive: runExclusive, extra: hooks.extras ? hooks.extras() : {} });
  const lj = await local.get(LS.JOB);
  const cur = await store.getCursor('encMigrate');
  if (!cur || !lj || lj.kind !== 'migrate') {
    // first run: encrypted host rows for every site in siteIdx, then count the work for the progress line
    await populateSites();
    await local.set(LS.JOB, { kind: 'migrate', total: await totalRows(store, 'migrate') });
  }
  const total = ((await local.get(LS.JOB)) || {}).total || 0;
  job = { kind: 'migrate', done: cur ? cur.done : 0, total };
  let last = 0;
  const r = await runMigration(store, envNow(), {
    shouldPause: () => lockrt.isLocked() || cancelRequested || lockrt.state() !== 'migrating',
    onProgress: (p) => { job.done = p.done; const now = Date.now(); if (now - last > 400) { last = now; progress(job); } },
  });
  if (r.paused) { cancelRequested = false; return; }
  await finishExtras('migrate', store);
  await setState('on');
  await rewriteCopies();
  await local.remove(LS.JOB);
  await markAllAggDirty();
  progress({ ...job, done: job.total });
}

async function revertJob() {
  const store = idbStore({ exclusive: runExclusive, extra: hooks.extras ? hooks.extras() : {} });
  const lj = await local.get(LS.JOB);
  const cur = await store.getCursor('encRevert');
  if (!cur || !lj || lj.kind !== 'revert') await local.set(LS.JOB, { kind: 'revert', total: await totalRows(store, 'revert') });
  const total = ((await local.get(LS.JOB)) || {}).total || 0;
  job = { kind: 'revert', done: cur ? cur.done : 0, total };
  let last = 0;
  for (let round = 0; round < 5; round++) {
    const r = await runMigration(store, envNow(), {
      mode: 'revert',
      shouldPause: () => lockrt.isLocked(),
      onProgress: (p) => { job.done = p.done; const now = Date.now(); if (now - last > 400) { last = now; progress(job); } },
    });
    if (r.paused) return;
    if (!(await anyEncrypted(store))) break; // a stash that landed during the revert is converted by the next round
  }
  await finishExtras('revert', store);
  // all plaintext again: drop the lock record, the batch keys, the token rows, the session key
  await runExclusive(async () => {
    await db.writeRemote(['ekeys', 'inbox', 'sites'], async (s) => { s.meta.delete('lock'); s.ekeys.clear(); s.inbox.clear(); s.sites.clear(); s.meta.delete('cur:encRevert'); s.meta.delete('cur:encMigrate'); }, null, true);
    await session().lock();
  });
  await local.remove([LS.JOB, LS.FAIL]);
  dropAlarm();
  await lockrt.refresh();
  await rewriteCopies();
  await refreshDrainSalt();
  hooks.onUnlock && hooks.onUnlock();
  post({ type: 'reload' });
}

/** the vault copies (storage.local) are rewritten in the new format by the normal vault alarm */
async function rewriteCopies() {
  try { await db.vaultMarkAllDirty(); await chrome.alarms.create(ALARMS.VAULT_SOON, { delayInMinutes: 0.1 }); } catch { /* the 30-minute vault alarm does it */ }
}

async function anyEncrypted(store) {
  for (const n of ['items', 'groups', 'categories']) {
    const rows = await store.scan(n, { limit: 2000 });
    if (rows.some((r) => r.value.e !== undefined)) return true;
  }
  return false;
}

async function populateSites() {
  const keys = lockrt.getKeys();
  if (!keys) return;
  const rows = await db.readRaw(['siteIdx'], (s) => db.req(s.siteIdx.getAll()));
  const hosts = new Set();
  for (const r of rows) if (!rec.isToken(r.site)) hosts.add(r.site);
  const prep = await lockrt.prepSites(hosts);
  for (let i = 0; i < prep.rows.length; i += 2000) {
    const part = prep.rows.slice(i, i + 2000);
    await runExclusive(() => db.writeRemote(['sites'], async (s) => { for (const x of part) s.sites.put(x); }, null, true));
  }
}

/** the favicon cache (cmr-fav) holds host names: emptied when the lock goes on (stores nothing while it is on) */
async function clearFavDb() {
  await new Promise((resolve) => {
    try {
      const r = indexedDB.open('cmr-fav', 2);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('icons')) d.createObjectStore('icons', { keyPath: 'host' }); if (!d.objectStoreNames.contains('atlas')) d.createObjectStore('atlas', { keyPath: 'id' }); };
      r.onsuccess = () => {
        const d = r.result;
        try { const t = d.transaction(['icons', 'atlas'], 'readwrite'); t.objectStore('icons').clear(); t.objectStore('atlas').clear(); t.oncomplete = t.onerror = t.onabort = () => { d.close(); resolve(); }; } catch { d.close(); resolve(); }
      };
      r.onerror = r.onblocked = () => resolve();
    } catch { resolve(); }
  });
}

/** settings / favicons / vault live outside `cmr`: hooks.extras() supplies their adapters; finishing steps are in sw.js (lockextras) */
async function finishExtras(kind) {
  if (kind === 'migrate') { await clearFavDb(); try { await chrome.storage.local.remove(['dupLog']); } catch { /* ignore */ } }
  try { await lockSecrets(kind === 'migrate'); } catch { /* the lists stay where they are; retried at the next unlock */ }
  if (hooks.extrasDone) await hooks.extrasDone(kind);
}

async function markAllAggDirty() {
  await runExclusive(() => db.writeRemote(['groups'], async (s) => {
    const gs = await db.req(s.groups.getAll());
    for (const g of gs) { if (!g.aggDirty) { g.aggDirty = true; s.groups.put(g); } }
  }, null, true));
}

// ---------- seal: inbox rows -> DK rows with tokens ----------
async function ensureSitesFor(rows) {
  const keys = lockrt.getKeys();
  const pend = rows.map((r) => r.value).filter((v) => v.e !== undefined && v.k > 0);
  if (!keys || !pend.length) return;
  const dec = await lockrt.codec.items(pend);
  const hosts = new Set(dec.filter((d) => !d.corrupt && d.site).map((d) => d.site));
  const prep = await lockrt.prepSites(hosts);
  if (prep.rows.length) await runExclusive(() => db.writeRemote(['sites'], async (s) => { for (const x of prep.rows) s.sites.put(x); }, null, true));
}

async function sealJob() {
  const store0 = idbStore({ exclusive: runExclusive });
  if (!(await store0.count('inbox')) && !(await store0.getCursor('seal'))) return;
  const store = { ...store0, async scan(name, o) { const rows = await store0.scan(name, o); if (name === 'items' && rows.length) await ensureSitesFor(rows); return rows; } };
  job = { kind: 'seal', done: 0, total: 0 };
  const total = await countInbox();
  job.total = total;
  progress(job);
  const hk = {
    aggregate: async ({ records }, tx) => {
      const per = new Map(); // `${g}|${token}` -> n
      const gs = new Set();
      for (const r of records) {
        gs.add(r.g);
        if (typeof r.site !== 'string') continue;
        const key = r.site + '\u0000' + r.g;
        per.set(key, (per.get(key) || 0) + 1);
      }
      for (const [key, n] of per) {
        const [site, g] = key.split('\u0000');
        const gid = isNaN(Number(g)) ? g : g; // group ids are strings
        const cur = await tx.get('siteIdx', [site, gid]);
        await tx.put('siteIdx', { site, g: gid, n: (cur ? cur.n : 0) + n });
      }
      for (const g of gs) { const row = await tx.get('groups', g); if (row && !row.aggDirty) await tx.put('groups', { ...row, aggDirty: true }); }
    },
    kidReferenced: async (kid) => {
      for (const n of ['groups', 'snapshots']) { const rows = await store0.scan(n, { limit: 2000 }); if (rows.some((r) => r.value.k === kid)) return true; }
      return false;
    },
    onProgress: (p) => { job.done = (p.sealed || 0) + (p.trashed || 0) + (p.failed || 0); progress(job); },
  };
  await runSeal(store, envNow(), hk, { shouldStop: () => lockrt.isLocked() });
  progress({ ...job, done: job.total });
}
async function countInbox() {
  const rows = await idbStore().scan('inbox', { limit: 2000 });
  let n = 0;
  for (const r of rows) n += await db.readRaw(['items'], (s) => db.req(s.items.count(db.groupRange(r.value.g))));
  return n;
}

// ---------- group summaries (top sites chips) live inside the encrypted payload ----------
export async function aggAll() {
  if (lockrt.isLocked() || !lockrt.enabled()) return 0;
  const gs = await db.readRaw(['groups'], (s) => db.req(s.groups.getAll()));
  let n = 0;
  for (const g of gs) {
    if (!g.aggDirty || g.phase === 'writing' || g.purging) continue;
    if (await db.readRaw(['inbox'], (s) => db.req(s.inbox.get(g.id)))) continue; // still holds unsealed rows
    if (await aggOne(g.id)) n++;
  }
  return n;
}
async function aggOne(gid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const g0 = await db.readRaw(['groups'], (s) => db.req(s.groups.get(gid)));
    if (!g0 || !g0.aggDirty) return false;
    const dec = await lockrt.codec.group(g0);
    const idx = await db.readRaw(['siteIdx'], (s) => db.req(s.siteIdx.index('byG').getAll(gid)));
    const hm = await lockrt.hostMap();
    const rows = idx.map((r) => ({ site: rec.isToken(r.site) ? (hm.get(r.site) || r.site) : r.site, n: r.n })).sort((a, b) => b.n - a.n || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)); // ties by host: the same order the plain-text summary had
    dec.agg = { top: rows.slice(0, 5).map((r) => [r.site, r.n]), nSites: rows.length, nTg: (dec.tabGroups && dec.tabGroups.length) || 0 };
    const w = lockrt.writer();
    if (!w) return false;
    const enc = await rec.encodeGroup(dec, w);
    let ok = false;
    await runExclusive(() => db.writeRemote(['groups'], async (s) => {
      const cur = await db.req(s.groups.get(gid));
      if (!cur || cur.mtime !== g0.mtime || !sameBytes(cur.e, g0.e)) return;
      const { aggDirty, ...plain } = cur;
      s.groups.put({ ...plain, k: enc.k, e: enc.e });
      ok = true;
    }, null, true));
    if (ok) return true;
  }
  return false;
}
const sameBytes = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
let aggTimer = null;
export function aggSoon() {
  if (!lockrt.enabled() || aggTimer) return;
  aggTimer = setTimeout(() => { aggTimer = null; runExclusive(() => Promise.resolve()).then(() => aggAll()).catch(() => {}); }, 1500);
}
