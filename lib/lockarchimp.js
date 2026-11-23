// Service-worker side of the archive IMPORT (file format: lib/lock/archive.js). The page reads the file and sends the header line,
// then batches of row lines; the old password / recovery key is used once to open the file and is never kept. Everything is
// ADDED as new groups through the normal write path (so it is encrypted with the current keys if the lock is on, plain if not);
// nothing existing is changed or removed. Messages: lock.archive.begin / rows / end / abort.
import * as db from './db.js';
import * as lockrt from './lockrt.js';
import { runExclusive } from './queue.js';
import { parseHeader, parseLine, openArchive, ArchiveFormatError } from './lock/archive.js';
import { WrongPasswordError, WrongRecoveryKeyError, WrongBackupPasswordError, WrongSlotError, NoSlotError, RecoveryFormatError, NoRecoveryKeyError, PubTamperedError, LockMetaError } from './lock/keys.js';
import { b64dec } from './lock/bytes.js';

const IDLE_MS = 30 * 60 * 1000;
const CHUNK = 500;
let S = null;

const fresh = () => ({ dec: null, map: new Map(), open: new Set(), cur: null, buf: [], ended: false, last: Date.now(), n: { groups: 0, items: 0, damaged: 0, trash: 0 } });
const alive = () => S && Date.now() - S.last < IDLE_MS;

export async function begin({ header, password, recoveryKey, backupPassword, slot } = {}) {
  S = null;
  if (lockrt.isLocked()) return { error: 'locked' };
  let h;
  try { h = parseHeader(String(header || '')); } catch (e) { return { error: e instanceof ArchiveFormatError ? 'format' : 'failed' }; }
  const s = fresh();
  try {
    let sl = null;
    if (slot && slot.id) { try { sl = { id: String(slot.id), prf: b64dec(String(slot.prf || '')) }; } catch { return { error: 'failed' }; } }
    s.dec = await openArchive(h.lock, { password, recoveryKey, backupPassword, slot: sl });
  } catch (e) {
    if (e instanceof WrongPasswordError || e instanceof WrongRecoveryKeyError || e instanceof WrongBackupPasswordError || e instanceof WrongSlotError) return { error: 'wrong' };
    if (e instanceof NoSlotError) return { error: 'noSlot' };
    if (e instanceof RecoveryFormatError) return { error: 'badFormat' };
    if (e instanceof NoRecoveryKeyError) return { error: 'noRecovery' };
    if (e instanceof PubTamperedError) return { error: 'tampered' };
    if (e instanceof LockMetaError) return { error: 'damaged' };
    return { error: 'failed' };
  }
  S = s;
  return { ok: true, ts: h.ts };
}

async function flush() {
  if (!S.buf.length || S.cur == null) { S.buf = []; return; }
  const gid = S.map.get(S.cur);
  const items = S.buf;
  S.buf = [];
  if (!gid) return;
  for (let i = 0; i < items.length; i += CHUNK) {
    const part = items.slice(i, i + CHUNK);
    await runExclusive(() => db.appendItems(gid, part));
    S.n.items += part.length;
  }
}
async function commit(oldId) {
  const gid = S.map.get(oldId);
  if (gid) { await runExclusive(() => db.setPhase(gid, 'committed')); S.open.delete(oldId); }
}

async function onGroup(row) {
  await flush();
  if (S.cur != null) { await commit(S.cur); S.cur = null; }
  const g = await S.dec.group(row);
  if (g.corrupt) { S.n.damaged++; S.map.set(row.id, null); return; }
  const info = { source: 'import', title: g.title, createdAt: g.createdAt, starred: g.starred, locked: g.locked, windowCount: g.windowCount, tabGroups: g.tabGroups, deletedAt: g.deletedAt, color: g.color, emoji: g.emoji };
  const made = await runExclusive(() => db.createGroup(info));
  const patch = {};
  for (const f of ['pinned', 'pending', 'archived']) if (g[f]) patch[f] = true;
  if (typeof g.note === 'string' && g.note) patch.note = g.note;
  if (Object.keys(patch).length) await runExclusive(() => db.updateGroup(made.id, patch));
  S.map.set(row.id, made.id);
  S.open.add(row.id);
  S.n.groups++;
}

async function onItem(row) {
  if (S.cur !== row.g) {
    await flush();
    if (S.cur != null) await commit(S.cur);
    S.cur = row.g;
  }
  if (!S.map.get(row.g)) { if (!S.map.has(row.g)) S.n.damaged++; return; } // its group is damaged or missing
  const it = await S.dec.item(row);
  if (it.corrupt) { S.n.damaged++; return; }
  const o = { url: it.url, title: it.title, ts: it.ts };
  if (it.w > 0) { o.w = it.w; if (it.ws) o.ws = true; }
  if (typeof it.tg === 'number' && it.tg >= 0) o.tg = it.tg;
  if (typeof it.sv === 'number' && it.sv >= 0) o.sv = it.sv;
  if (typeof it.d === 'number' && it.d) o.d = it.d;
  S.buf.push(o);
}

export async function rows({ lines } = {}) {
  if (!alive()) { S = null; return { error: 'nosession' }; }
  if (lockrt.isLocked()) return { error: 'locked' };
  S.last = Date.now();
  try {
    for (const line of lines || []) {
      if (!line) continue;
      const p = parseLine(line);
      if (p.end) { S.ended = true; continue; }
      if (p.store === 'ekeys') S.dec.addEkeys([p.row]);
      else if (p.store === 'groups') await onGroup(p.row);
      else if (p.store === 'items') await onItem(p.row);
      else if (p.store === 'trash') S.n.trash += p.row.n || 0; // the file keeps the trash; it is not copied into the list
    }
    await flush();
  } catch (e) {
    return { error: 'failed', detail: String(e && e.message || e).slice(0, 120) };
  }
  return { ok: true, groups: S.n.groups, items: S.n.items };
}

export async function end() {
  if (!alive()) { S = null; return { error: 'nosession' }; }
  try {
    await flush();
    if (S.cur != null) await commit(S.cur);
    for (const old of [...S.open]) await commit(old); // groups that had no items
  } catch { return { error: 'failed' }; }
  const out = { ok: true, complete: S.ended, ...S.n };
  S = null;
  return out;
}
export function abort() { S = null; return { ok: true }; }
