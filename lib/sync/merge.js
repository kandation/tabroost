// Field-level last-writer-wins merge, written against an abstract async store so it
// can later be bound to IndexedDB without changes.
//
// store interface (all async):
//   getMeta(t, id)            -> {fh:{field:"hlc|dev"}, purged:boolean} | undefined
//   setMeta(t, id, meta)
//   hasEntity(t, id)          -> boolean
//   createEntity(t, id, fields, opts?)   // t = 'g' | 'i'. For items fields.g = gid; the store
//                                        // assigns the local seq. opts.placeholder = true for
//                                        // groups created only because an item referenced them.
//   updateEntity(t, id, fields)          // a placeholder group stops being one when createdAt arrives
//   purgeEntity(t, id)                   // group: deletes ONLY the group record. Its items are kept (hidden by the app
//                                        // because their group is gone) so that a concurrent move-out of the group
//                                        // still converges; the app may GC them later. item: deletes the item.
//
// op = {h, t:'g'|'i'|'c'|'s', id, f:{field:value}, x?:1}   (g tab set, i tab, c category, s preferences: see lib/sync/prefs.js)
// 'c' and 's' use the same store calls; hasEntity('s') is always true (one entity, no creation), purgeEntity('s') is a no-op.
import { fieldKey } from './hlc.js';

export const SYNCED_GROUP_FIELDS = ['title', 'starred', 'locked', 'ord', 'del', 'createdAt', 'windowCount', 'tabGroups', 'pinned', 'archived', 'pending', 'note', 'color', 'emoji', 'cat'];
export const SYNCED_CATEGORY_FIELDS = ['name', 'color', 'ord', 'createdAt'];
export const SYNCED_ITEM_FIELDS = ['g', 'url', 'title', 'ts', 't', 'w', 'ws', 'tg', 'sv'];

/** An item pointing at an unknown, not-purged group gets a placeholder group (filled in when the group's own ops arrive). */
async function ensureGroup(store, t, wins) {
  if (t !== 'i' || wins.g === undefined || wins.g === null) return;
  if (await store.hasEntity('g', wins.g)) return;
  const gm = await store.getMeta('g', wins.g);
  if (gm && gm.purged) return;
  await store.createEntity('g', wins.g, {}, { placeholder: true });
}

/** @returns {Promise<'applied'|'skipped'|'purged'>} */
export async function applyOp(store, op, dev) {
  const { t, id } = op;
  let meta = (await store.getMeta(t, id)) || { fh: {}, purged: false };
  if (meta.purged) return 'skipped';
  if (t === 's' && (op.x || id !== 'prefs')) return 'skipped'; // the preferences entity is never purged and there is only one of it
  if (op.x) {
    meta = { fh: {}, purged: true };
    await store.purgeEntity(t, id);
    await store.setMeta(t, id, meta);
    return 'purged';
  }
  let f = op.f || {};
  if (t === 's') { // a peer could send anything: only well-formed preference field names are kept (bounded count)
    const ok = {};
    let n = 0;
    for (const k of Object.keys(f)) if (/^[sp]:[A-Za-z0-9]{1,40}$/.test(k) && n++ < 200) ok[k] = f[k];
    f = ok;
  }
  const key = fieldKey(op.h, dev);
  const wins = {};
  let any = false;
  for (const k of Object.keys(f)) {
    const cur = meta.fh[k];
    if (cur === undefined || key > cur) { wins[k] = f[k]; meta.fh[k] = key; any = true; }
  }
  const exists = await store.hasEntity(t, id);
  if (!exists) {
    await ensureGroup(store, t, wins);
    await store.createEntity(t, id, wins);
    await store.setMeta(t, id, meta);
    return 'applied';
  }
  if (!any) return 'skipped';
  await ensureGroup(store, t, wins);
  await store.updateEntity(t, id, wins);
  await store.setMeta(t, id, meta);
  return 'applied';
}

/** Apply many ops from one device. Returns counts. */
export async function applyOps(store, ops, dev) {
  const c = { applied: 0, skipped: 0, purged: 0 };
  for (const op of ops) c[await applyOp(store, op, dev)]++;
  return c;
}
