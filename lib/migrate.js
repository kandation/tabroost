// One-time, idempotent migration of the v1 data (chrome.storage.local g:* / trash / bak:* / meta) into IndexedDB.
// Old keys are removed ONLY after every migrated group verified and a full vault sync completed.

import { KEYS, APPEND_CHUNK } from './constants.js';
import { classifyUrl } from './formats.js';
import * as db from './db.js';
import * as vault from './vault.js';

const isLegacyKey = (k) =>
  k === KEYS.LEGACY_META || k === KEYS.LEGACY_TRASH || k.startsWith(KEYS.LEGACY_GROUP_PREFIX) || k.startsWith(KEYS.LEGACY_BACKUP_PREFIX);

function cleanItems(items) {
  return (items || [])
    .filter((it) => it && typeof it.url === 'string' && classifyUrl(it.url) === 'save')
    .map((it) => ({ url: it.url, title: it.title || it.url, ts: it.ts || Date.now() }));
}

async function putGroup(lg, ord, deletedAt) {
  await db.purgeGroup(lg.id, { force: true });
  await db.createGroup({
    id: lg.id, createdAt: lg.createdAt, title: lg.title, starred: lg.starred, locked: lg.locked,
    source: lg.source || 'import', ord, deletedAt: deletedAt == null ? null : deletedAt,
  });
  const items = cleanItems(lg.items);
  for (let i = 0; i < items.length; i += APPEND_CHUNK) await db.appendItems(lg.id, items.slice(i, i + APPEND_CHUNK));
  await db.setPhase(lg.id, 'committed');
  return items.length;
}

/** Returns {status:'none'|'done'|'error', ...}. Never throws. */
export async function migrate({ step = (fn) => fn() } = {}) {
  try {
    const meta0 = await db.getMeta();
    if (meta0.migration && meta0.migration.legacyRemoved) return { status: 'done', already: true };
    const all = await chrome.storage.local.get(null);
    const gkeys = Object.keys(all).filter((k) => k.startsWith(KEYS.LEGACY_GROUP_PREFIX) && all[k]);
    const legacyMeta = all[KEYS.LEGACY_META] || {};
    const order = Array.isArray(legacyMeta.groupOrder) ? legacyMeta.groupOrder : [];
    const trash = Array.isArray(all[KEYS.LEGACY_TRASH]) ? all[KEYS.LEGACY_TRASH] : [];

    // the legacy 'meta' key is only legacy data if it has the v1 shape
    const removeKeys = Object.keys(all).filter((k) => isLegacyKey(k) && (k !== KEYS.LEGACY_META || Array.isArray(legacyMeta.groupOrder)));

    if (!gkeys.length && !trash.length) {
      await db.setMeta({ migration: { verifiedAt: Date.now(), legacyRemoved: true } });
      if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
      return { status: 'none' };
    }

    // groups in groupOrder order (index = ord, newest first), then orphan g:* keys
    const ids = [];
    const seen = new Set();
    for (const gid of order) if (all[KEYS.LEGACY_GROUP_PREFIX + gid] && !seen.has(gid)) { ids.push(gid); seen.add(gid); }
    for (const k of gkeys) { const gid = k.slice(2); if (!seen.has(gid)) { ids.push(gid); seen.add(gid); } }

    const expected = new Map(); // gid -> item count
    let ord = 0;
    for (const gid of ids) {
      const lg = all[KEYS.LEGACY_GROUP_PREFIX + gid];
      const want = cleanItems(lg.items).length;
      const have = await db.getGroup(gid);
      if (have && have.phase === 'committed' && have.count === want && (await db.countItems(gid)) === want) {
        expected.set(gid, want);
      } else {
        await step(() => putGroup({ ...lg, id: gid }, ord, null));
        expected.set(gid, want);
      }
      ord++;
    }

    // legacy trash: group snapshots -> soft-deleted groups; partial snapshots of a live group -> item trash
    for (const e of trash) {
      const snap = e && e.groupSnapshot;
      if (!snap || !snap.id) continue;
      const live = ids.includes(snap.id) && order.includes(snap.id);
      if (live) {
        const items = cleanItems(snap.items);
        if (items.length) await step(() => db.importTrashItems(snap.id, items, e.deletedAt));
      } else {
        let gid = snap.id;
        if (await db.getGroup(gid)) gid = gid + '-t';
        const want = cleanItems(snap.items).length;
        await step(() => putGroup({ ...snap, id: gid }, ord++, e.deletedAt || Date.now()));
        expected.set(gid, want);
      }
    }

    // verify everything
    for (const [gid, n] of expected) {
      if (!(await db.verifyGroup(gid, n))) throw new Error('verify failed for group ' + gid);
    }
    await db.setMeta({ migration: { verifiedAt: Date.now(), legacyRemoved: false }, lastStash: null });

    // the vault copy is the second backup: complete it before the old keys go away
    await vault.syncDirty({ step, all: true });

    await chrome.storage.local.remove(removeKeys);
    await db.setMeta({ migration: { verifiedAt: Date.now(), legacyRemoved: true } });
    return { status: 'done', groups: expected.size };
  } catch (e) {
    const msg = String((e && e.message) || e);
    try { await db.setMeta({ migration: { error: msg, at: Date.now() } }); } catch { /* ignore */ }
    return { status: 'error', error: msg };
  }
}
