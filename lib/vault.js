// The vault: a second copy of every group in chrome.storage.local (a different LevelDB than IndexedDB),
// stored as gzip(NDJSON) base64 per group. Used to detect and repair database loss. No downloads involved.

import { KEYS, APPEND_CHUNK } from './constants.js';
import {
  ndjsonHeader, ndjsonGroup, ndjsonItem, parseNdjsonLine, normItem,
} from './formats.js';
import * as db from './db.js';
import * as lockrt from './lockrt.js';
import { sealBytes, openBytes, LockedError } from './lock/rec.js';
import { b64enc, b64dec } from './lock/bytes.js';

async function gzipBytes(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Password lock on: the vault copy is the same gzip, then sealed with the data key (AAD = vault:<gid>); `k` marks it. Legacy copies have no `k`. */
async function sealVault(gid, gzBytes) {
  const keys = lockrt.getKeys();
  if (!keys) throw new LockedError('locked');
  return b64enc(await sealBytes(keys.dk, 0, 'vault:' + gid, gzBytes));
}

async function gzipToB64(text, gid) {
  const buf = await gzipBytes(text);
  if (lockrt.enabled()) return sealVault(gid, buf);
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function b64ToText(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const stream = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function getIndex() {
  const r = await chrome.storage.local.get(KEYS.VAULT_INDEX);
  return r[KEYS.VAULT_INDEX] || { rev: 0, at: 0, groups: {} };
}

async function snapshotGroup(g) {
  const lines = [ndjsonHeader(Date.now()), ndjsonGroup(g)];
  let after = 0;
  for (;;) {
    const page = await db.getItemsPage(g.id, after, APPEND_CHUNK);
    if (!page.length) break;
    for (const it of page) lines.push(ndjsonItem(g.id, it));
    after = page[page.length - 1].seq;
    if (page.length < APPEND_CHUNK) break;
  }
  return gzipToB64(lines.join('\n'), g.id);
}

/** Re-snapshots one group (or removes its vault copy when the group is gone). */
export async function syncGroup(gid) {
  const g = await db.getGroup(gid);
  const idx = await getIndex();
  if (!g) {
    delete idx.groups[gid];
    idx.at = Date.now();
    await chrome.storage.local.set({ [KEYS.VAULT_INDEX]: idx });
    await chrome.storage.local.remove(KEYS.VAULT_PREFIX + gid);
    return;
  }
  const gz = await snapshotGroup(g);
  const meta = await db.getMeta();
  idx.groups[gid] = { rev: meta.rev, count: g.count, deletedAt: g.deletedAt == null ? null : g.deletedAt };
  idx.rev = meta.rev;
  idx.at = Date.now();
  await chrome.storage.local.set({
    [KEYS.VAULT_PREFIX + gid]: { gid, rev: meta.rev, count: g.count, gz, ...(lockrt.enabled() ? { k: 0 } : {}) },
    [KEYS.VAULT_INDEX]: idx,
  });
}

/**
 * Syncs dirty groups. `step(fn)` wraps each group in the caller's queue slot (runExclusive) so stashes are
 * never blocked for long. Returns the number of groups synced. `shouldStop()` lets a drain pre-empt the sync.
 */
export async function syncDirty({ step = (fn) => fn(), shouldStop = () => false, all = false } = {}) {
  if (lockrt.isLocked()) return 0; // the copy is encrypted: it is refreshed after the next unlock (groups stay dirty)
  let meta = await db.getMeta();
  let list = all ? (await db.listGroups({ deleted: false })).concat(await db.listGroups({ deleted: true })).map((g) => g.id) : meta.vaultDirty.slice();
  let n = 0;
  for (const gid of list) {
    if (shouldStop()) break;
    await step(async () => {
      const m0 = await db.getMeta();
      await syncGroup(gid);
      await db.clearVaultDirty([gid], m0.rev);
      n++;
    });
  }
  return n;
}

/** Removes the vault copy of every group that was purged on purpose (right after the purge, same queue). */
export async function flushPurged({ step = (fn) => fn() } = {}) {
  const list = ((await db.getMeta()).vaultPurged || []).slice();
  let n = 0;
  for (const gid of list) {
    await step(async () => {
      if (!(await db.getGroup(gid))) await syncGroup(gid); // gone from the database => removes the vault copy + index entry
      await db.clearVaultPurged([gid]);
      n++;
    });
  }
  return n;
}


/** Vault groups that the database no longer has (soft-deleted ones only with includeDeleted). */
export async function missingFromDb({ includeDeleted = false } = {}) {
  const idx = await getIndex();
  const have = new Set([...(await db.listGroups({ deleted: false })), ...(await db.listGroups({ deleted: true }))].map((g) => g.id));
  // groups removed on purpose (purge / restore-all / empty trash / retention) whose vault copy is still being removed are NOT lost
  const purged = new Set((await db.getMeta()).vaultPurged || []);
  return Object.keys(idx.groups).filter((gid) => !have.has(gid) && !purged.has(gid) && (includeDeleted || idx.groups[gid].deletedAt == null));
}

export async function vaultInfo() {
  const idx = await getIndex();
  return { groups: Object.keys(idx.groups).length, at: idx.at };
}

/**
 * Rebuilds groups from the vault into the database (writer only). gids=null -> every missing group.
 * Existing partial copies of the same id are purged first. Returns {groups, items}.
 */
export async function rebuild(gids) {
  const idx = await getIndex();
  const targets = gids || (await missingFromDb({ includeDeleted: true }));
  let groups = 0;
  let items = 0;
  for (const gid of targets) {
    const r = await chrome.storage.local.get(KEYS.VAULT_PREFIX + gid);
    const rec = r[KEYS.VAULT_PREFIX + gid];
    if (!rec || !rec.gz) continue;
    let text;
    if (rec.k !== undefined) {
      const keys = lockrt.getKeys();
      if (!keys) throw new LockedError('locked');
      const gzb = await openBytes(keys.dk, rec.k, 'vault:' + gid, b64dec(rec.gz));
      text = await new Response(new Blob([gzb]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = await b64ToText(rec.gz);
    let ginfo = null;
    const batch = [];
    const flush = async () => {
      if (batch.length) { await db.appendItems(gid, batch.splice(0)); }
    };
    await db.purgeGroup(gid, { force: true });
    for (const line of text.split('\n')) {
      const o = parseNdjsonLine(line);
      if (!o) continue;
      if (o.type === 'group' && !ginfo) {
        ginfo = o;
        await db.createGroup({
          id: gid, createdAt: o.createdAt, title: o.title, starred: o.starred, locked: o.locked,
          source: o.source, ord: typeof o.ord === 'number' ? o.ord : undefined, deletedAt: o.deletedAt,
          windowCount: o.windowCount, tabGroups: o.tabGroups, color: o.color, emoji: o.emoji, delReason: o.delReason,
        });
        const patch = {};
        for (const f of ['pinned', 'pending', 'archived']) if (o[f] === true) patch[f] = true;
        if (typeof o.note === 'string' && o.note) patch.note = o.note;
        if (typeof o.cat === 'string' && o.cat) patch.cat = o.cat;
        if (Object.keys(patch).length) await db.updateGroup(gid, patch);
      } else if (o.type === 'item' && ginfo) {
        const it = normItem(o, Date.now());
        if (it) { batch.push(it); items++; if (batch.length >= APPEND_CHUNK) await flush(); }
      }
    }
    if (!ginfo) continue;
    await flush();
    await db.setPhase(gid, 'committed');
    groups++;
  }
  return { groups, items, known: Object.keys(idx.groups).length };
}
