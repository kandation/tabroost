// encMigrate (plaintext -> ciphertext) and encRevert (ciphertext -> plaintext) as pure, resumable steppers
// (spec §4). Written against the store adapter of jobutil.js.
//
// Properties (all covered by tests/lock/run.mjs):
//  * idempotent: records already in the target format are skipped, so any chunk can safely run twice;
//  * resumable: the cursor {si, after, ...} is written in the same tx as its chunk; a crash loses at most that chunk;
//  * mixed formats are always readable (decoders accept legacy forever), so the UI works mid-migration;
//  * compare-and-swap per row: a record changed by a concurrent writer between the chunk read and the write tx is
//    NOT overwritten with stale data; it is re-read and re-transformed (bounded retries);
//  * revert restores plaintext t/tk/site/uh through env.deriveSearch, and rows that fail authentication are left
//    untouched (counted in `failed`), never dropped.
import {
  classify, trashRowEncrypted, isToken,
  encodeItem, decodeItem, encodeTrashRow, decodeTrashRow, encodeGroup, decodeGroup,
  encodeCategory, decodeCategory, encodeSnapshot, decodeSnapshot, encodeVault, decodeVault,
  encodeSetting, decodeSetting, encodeSiteRow, decodeSiteRow, encodeFavicon, decodeFavicon,
  tokenizeSiteIdx, mapSlices,
} from './rec.js';
import { MAX_CHUNK, deepEqual } from './jobutil.js';

/** Store order from the spec, except sites BEFORE siteIdx (so token->host stays resolvable at every cut point): items, trash, groups, categories, sites, siteIdx, snapshots, vault, settings, favicons, search. */
export const FORWARD_ORDER = ['items', 'trash', 'groups', 'categories', 'sites', 'siteIdx', 'snapshots', 'vault', 'settings', 'favicons', 'search'];
// Revert: siteIdx must go before sites (token -> host needs the encrypted sites rows). The encrypted search snapshot is
// simply dropped by the forward plan; after revert the plaintext index is rebuilt by the worker (no plan needed).
export const REVERT_ORDER = ['items', 'trash', 'groups', 'categories', 'siteIdx', 'sites', 'snapshots', 'vault', 'settings', 'favicons'];

const put = (store, value) => ({ put: { store, value } });
const del = (store, key) => ({ del: { store, key } });
const isLegacy = (r) => classify(r) === 'legacy';
const isEnc = (r) => classify(r) === 'enc';
const isEncVault = (r) => classify(r, false) === 'enc';
const withSearch = (env, it) => (env.deriveSearch ? { ...it, ...env.deriveSearch(it) } : it);

/**
 * env = { keys (unlocked: writer(), xWriter(), reader()), deriveSearch?(item)->{t,tk}, normUrl?,
 *         isSensitiveSetting?(name) }
 * Each plan: { store, pending(row)->bool, transform(row, env, store)->Promise<ops[]> }.
 */
export function buildPlans(mode, env) {
  const w = env.keys.writer(), xw = env.keys.xWriter(), rd = env.keys.reader();
  const sensitive = env.isSensitiveSetting || (() => true);
  const opts = { normUrl: env.normUrl };
  const fwd = {
    items: { pending: isLegacy, transform: async (r) => [put('items', await encodeItem(r, w, opts))] },
    trash: { pending: (r) => !trashRowEncrypted(r), transform: async (r) => [put('trash', await encodeTrashRow(r, w, opts))] },
    groups: { pending: isLegacy, transform: async (r) => [put('groups', await encodeGroup(r, w))] },
    categories: { pending: isLegacy, transform: async (r) => [put('categories', await encodeCategory(r, w))] },
    siteIdx: { // rekey: write the token row, delete the host row, same tx
      pending: (r) => !isToken(r.site),
      transform: async (r) => [del('siteIdx', [r.site, r.g]), put('siteIdx', await tokenizeSiteIdx(r, w.hk))],
    },
    sites: {
      pending: (r) => isLegacy(r) && !isToken(r.site),
      transform: async (r) => [del('sites', r.site), put('sites', await encodeSiteRow(r, w))],
    },
    snapshots: { pending: isLegacy, transform: async (r) => [put('snapshots', await encodeSnapshot(r, w))] },
    vault: { pending: (r) => !isEncVault(r) && classify(r, false) === 'legacy', transform: async (r) => [put('vault', await encodeVault(r.id, r.data, w))] },
    settings: { pending: (r) => isLegacy(r) && sensitive(r.name), transform: async (r) => [put('settings', await encodeSetting(r.name, r.value, w))] },
    favicons: {
      pending: (r) => isLegacy(r) && !isToken(r.site),
      transform: async (r) => [del('favicons', r.site), put('favicons', await encodeFavicon(r, xw))],
    },
    search: { pending: () => true, transform: async (r, e, s, key) => [del('search', key)] }, // dropped, rebuilt encrypted by the worker
  };
  const rev = {
    items: { pending: isEnc, transform: async (r) => { const d = await decodeItem(r, rd); return d.corrupt ? [] : [put('items', withSearch(env, d))]; } },
    trash: {
      pending: (r) => (r.items || []).some((i) => classify(i) === 'enc'),
      transform: async (r) => {
        const d = await decodeTrashRow(r, rd);
        if (d.items.some((i) => i.corrupt)) return [];
        return [put('trash', { ...d, items: d.items.map((i) => withSearch(env, i)) })];
      },
    },
    groups: { pending: isEnc, transform: async (r) => { const d = await decodeGroup(r, rd); return d.corrupt ? [] : [put('groups', d)]; } },
    categories: { pending: isEnc, transform: async (r) => { const d = await decodeCategory(r, rd); return d.corrupt ? [] : [put('categories', d)]; } },
    siteIdx: {
      pending: (r) => isToken(r.site),
      transform: async (r, e, store) => {
        const srow = await store.get('sites', r.site);
        if (!srow) return []; // host unknown (sites row lost): keep the token row, nothing is dropped
        const s = await decodeSiteRow(srow, rd);
        return s.corrupt ? [] : [del('siteIdx', [r.site, r.g]), put('siteIdx', { ...r, site: s.site })];
      },
    },
    sites: {
      pending: isEnc,
      transform: async (r) => {
        const d = await decodeSiteRow(r, rd);
        if (d.corrupt) return [];
        const { token, ...plain } = d;
        return [del('sites', r.site), put('sites', plain)];
      },
    },
    snapshots: { pending: isEnc, transform: async (r) => { const d = await decodeSnapshot(r, rd); return d.corrupt ? [] : [put('snapshots', d)]; } },
    vault: { pending: isEncVault, transform: async (r) => { const d = await decodeVault(r, rd); return d.corrupt ? [] : [put('vault', { id: d.id, data: d.data })]; } },
    settings: { pending: isEnc, transform: async (r) => { const d = await decodeSetting(r, rd); return d.corrupt ? [] : [put('settings', d)]; } },
    favicons: {
      pending: isEnc,
      transform: async (r) => {
        const d = await decodeFavicon(r, rd);
        if (d.corrupt) return [];
        const { token, ...plain } = d;
        return [del('favicons', r.site), put('favicons', plain)];
      },
    },
  };
  const table = mode === 'revert' ? rev : fwd;
  return (mode === 'revert' ? REVERT_ORDER : FORWARD_ORDER).map((s) => ({ name: s, store: s, ...table[s] }));
}

const jobName = (mode) => (mode === 'revert' ? 'encRevert' : 'encMigrate');

/** Progress total for the UI ("120,000/300,000"): number of rows in the stores this job walks. */
export async function totalRows(store, mode) {
  let n = 0;
  for (const s of mode === 'revert' ? REVERT_ORDER : FORWARD_ORDER) n += await store.count(s);
  return n;
}

async function applyOps(tx, ops) {
  for (const o of ops) {
    if (o.put) await tx.put(o.put.store, o.put.value);
    else await tx.del(o.del.store, o.del.key);
  }
}

/**
 * One chunk. Returns { finished, mode, store, done, failed, retried }. Call repeatedly (or use runMigration).
 * `cas:false` disables the compare-and-swap (only for single-writer maintenance runs).
 */
export async function migrateStep(store, env, { mode = 'migrate', chunk = MAX_CHUNK, cas = true } = {}) {
  chunk = Math.min(chunk, MAX_CHUNK);
  const job = jobName(mode);
  const plans = buildPlans(mode, env);
  const cur = (await store.getCursor(job)) || { si: 0, after: null, done: 0, failed: 0 };
  if (cur.si >= plans.length) return { finished: true, mode, done: cur.done, failed: cur.failed };
  const plan = plans[cur.si];
  const rows = await store.scan(plan.store, { after: cur.after, limit: chunk });

  if (!rows.length) { // store exhausted: advance to the next one in its own tx (cursor only)
    const next = { si: cur.si + 1, after: null, done: cur.done, failed: cur.failed };
    await store.tx(async (tx) => { await tx.setCursor(job, next); });
    return { finished: next.si >= plans.length, mode, store: plan.store, done: next.done, failed: next.failed };
  }

  // --- crypto phase (no tx open) ---
  const todo = rows.filter((r) => plan.pending(r.value));
  const opsList = await mapSlices(todo, (r) => plan.transform(r.value, env, store, r.key));
  let failed = 0;
  const jobs = [];
  todo.forEach((r, i) => { if (opsList[i].length) jobs.push({ row: r, ops: opsList[i] }); else failed++; });

  // --- write phase: chunk + cursor in ONE tx ---
  const conflicts = [];
  const last = rows[rows.length - 1].key;
  const next = { si: cur.si, after: last, done: cur.done + jobs.length, failed: cur.failed + failed };
  await store.tx(async (tx) => {
    for (const j of jobs) {
      if (cas) {
        const now = await tx.get(plan.store, j.row.key);
        if (!deepEqual(now, j.row.value)) { conflicts.push(j.row); next.done--; continue; }
      }
      await applyOps(tx, j.ops);
    }
    await tx.setCursor(job, next);
  });

  // Rows changed under us: redo them one by one from fresh state (bounded; a stable row converges at once).
  let retried = 0;
  for (const row of conflicts) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = await store.get(plan.store, row.key);
      if (fresh === undefined || !plan.pending(fresh)) break; // deleted, or already in target format
      const ops = await plan.transform(fresh, env, store, row.key);
      let ok = true;
      await store.tx(async (tx) => {
        if (!deepEqual(await tx.get(plan.store, row.key), fresh)) { ok = false; return; }
        await applyOps(tx, ops);
        const c = (await store.getCursor(job)) || next;
        await tx.setCursor(job, { ...c, done: c.done + 1 });
      });
      if (ok) { retried++; break; }
    }
  }
  return { finished: false, mode, store: plan.store, done: next.done + retried, failed: next.failed, retried };
}

/** Run until finished (or shouldPause() -> {paused:true}; the cursor is persisted so unlock resumes it). */
export async function runMigration(store, env, { mode = 'migrate', chunk, shouldPause, onProgress, cas } = {}) {
  let steps = 0;
  for (;;) {
    if (shouldPause && shouldPause()) return { paused: true, steps };
    const r = await migrateStep(store, env, { mode, chunk, cas });
    steps++;
    if (onProgress) onProgress(r);
    if (r.finished) {
      await store.tx(async (tx) => { await tx.setCursor(jobName(mode), null); }); // job complete: clear cursor
      return { finished: true, steps, done: r.done, failed: r.failed };
    }
  }
}

/** Cancel a running migration: clears the forward cursor; the integrator then runs mode 'revert'. */
export async function cancelMigration(store) {
  await store.tx(async (tx) => { await tx.setCursor('encMigrate', null); });
}
