// Seal job (spec §3): after unlock, turn inbox-encrypted rows (k>0, no tokens) into DK-encrypted rows (k:0) with
// blind tokens, update aggregates, apply autoRules/duplicate policy (duplicates go to TRASH, never deleted),
// then drop the inbox row and garbage-collect ekeys rows nothing references.
//
// Pure stepper written against the store adapter in jobutil.js. One call = one chunk (<= 2000 rows) = one write tx
// that also persists the cursor {g, after}. Crash-safe: re-running a chunk is idempotent (rows with k:0 are skipped,
// a compare-and-swap on `e` skips rows changed/deleted between read and write).
import { decodeItem, encodeItem, mapSlices, classify } from './rec.js';
import { makeBatchResolver } from './inbox.js';
import { MAX_CHUNK, deepEqual } from './jobutil.js';

const JOB = 'seal';
const sameE = (a, b) => a && b && deepEqual(a.e, b.e) && a.k === b.k;

/**
 * hooks (all optional):
 *   decide(item) -> undefined | { item?: modifiedPlainItem } | { trash: 'duplicate'|reason }   (autoRules + duplicate policy)
 *   aggregate({items, records}, tx)  update siteIdx / sites / group.agg inside the chunk tx (only IDB requests)
 *   rewriteVault(g, env) -> async (tx) => void | null   prepare (crypto) the vault rewrite; applied in the group's final tx
 *   kidReferenced(kid) -> bool   true if something else (snapshots) still uses that ekeys row
 *   onProgress(p)
 * env = { keys, now?, normUrl? }   keys = unlocked key set (needs dk, hk, sk)
 */
export async function sealStep(store, env, hooks = {}, { chunk = MAX_CHUNK } = {}) {
  if (!env.keys || !env.keys.sk) throw new Error('seal needs the unlocked private key');
  chunk = Math.min(chunk, MAX_CHUNK);
  let cur = await store.getCursor(JOB);
  if (!cur) {
    const first = (await store.scan('inbox', { limit: 1 }))[0];
    if (!first) return { done: true };
    cur = { g: first.value.g, after: 0, sealed: 0, trashed: 0, failed: 0, failedKids: [] };
  }
  const { g } = cur;
  const rows = await store.scan('items', { after: [g, cur.after], upTo: [g, Number.MAX_SAFE_INTEGER], limit: chunk });
  const resolver = makeBatchResolver(env.keys.sk, (kid) => store.get('ekeys', kid));
  const reader = env.keys.reader(resolver);
  const writer = env.keys.writer();
  const opts = { normUrl: env.normUrl };

  // --- crypto phase (no tx open) ---
  const pending = rows.filter((r) => classify(r.value) === 'enc' && r.value.k > 0);
  const decoded = await mapSlices(pending, (r) => decodeItem(r.value, reader));
  const keep = [], trash = [], failedKids = new Set(cur.failedKids);
  let failed = 0;
  decoded.forEach((item, i) => {
    const row = pending[i];
    if (item.corrupt) { failed++; failedKids.add(row.value.k); return; } // leave untouched; keep its ekeys row
    const d = hooks.decide ? hooks.decide(item) : undefined;
    (d && d.trash ? trash : keep).push({ row, item: (d && d.item) || item, reason: d && d.trash });
  });
  const keepEnc = await mapSlices(keep, (x) => encodeItem(x.item, writer, opts));
  const trashEnc = await mapSlices(trash, (x) => encodeItem(x.item, writer, opts));
  const lastSeq = rows.length ? rows[rows.length - 1].key[1] : cur.after;
  const atEnd = rows.length < chunk;
  const vaultCommit = atEnd && hooks.rewriteVault ? await hooks.rewriteVault(g, env) : null;

  // --- write phase: ONE tx with chunk + cursor ---
  let sealed = 0, trashed = 0;
  await store.tx(async (tx) => {
    const written = [], writtenRecs = [];
    for (let i = 0; i < keep.length; i++) {
      const now = await tx.get('items', keep[i].row.key);
      if (!sameE(now, keep[i].row.value)) continue; // changed/deleted meanwhile: do not resurrect
      await tx.put('items', keepEnc[i]);
      written.push(keep[i].item); writtenRecs.push(keepEnc[i]); sealed++;
    }
    const byReason = new Map();
    for (let i = 0; i < trash.length; i++) {
      const now = await tx.get('items', trash[i].row.key);
      if (!sameE(now, trash[i].row.value)) continue;
      await tx.del('items', trash[i].row.key);
      const r = trash[i].reason;
      if (!byReason.has(r)) byReason.set(r, []);
      byReason.get(r).push(trashEnc[i]); trashed++;
    }
    for (const [reason, items] of byReason) {
      // trash row of items (never deleted): same shape as db.js trash rows, items keep their own k:0 ciphertext
      await tx.put('trash', { kind: 'items', g, items, n: items.length, deletedAt: env.now || Date.now(), delReason: reason });
    }
    if (hooks.aggregate && (written.length || trashed)) await hooks.aggregate({ items: written, records: writtenRecs }, tx);

    let next = { g, after: lastSeq, sealed: cur.sealed + sealed, trashed: cur.trashed + trashed, failed: cur.failed + failed, failedKids: [...failedKids] };
    if (atEnd) {
      // Group finished only if nothing new landed after our last row (checked inside the tx).
      const more = await tx.scan('items', { after: [g, lastSeq], upTo: [g, Number.MAX_SAFE_INTEGER], limit: 1 });
      if (!more.length) {
        if (vaultCommit) await vaultCommit(tx);
        await tx.del('inbox', g);
        for (const kid of failedKids) { // damaged rows need their ekeys row kept for later forensic recovery
          const ek = await tx.get('ekeys', kid);
          if (ek && !ek.keep) await tx.put('ekeys', { ...ek, keep: true });
        }
        next = null;
      }
    }
    await tx.setCursor(JOB, next);
  });

  const out = { done: false, g, sealed: cur.sealed + sealed, trashed: cur.trashed + trashed, failed: cur.failed + failed, groupDone: atEnd };
  if (atEnd) await gcEkeys(store, hooks);
  if (hooks.onProgress) hooks.onProgress(out);
  return out;
}

/** Delete ekeys rows that no remaining inbox row lists, that nothing else references, and that hold no damaged rows. */
export async function gcEkeys(store, hooks = {}) {
  const inbox = await store.scan('inbox', { limit: MAX_CHUNK });
  const used = new Set();
  for (const r of inbox) for (const kid of r.value.kids || []) used.add(kid);
  const eks = await store.scan('ekeys', { limit: MAX_CHUNK });
  const doomed = [];
  for (const r of eks) {
    const kid = r.value.kid;
    if (r.value.keep || used.has(kid)) continue;
    if (hooks.kidReferenced && (await hooks.kidReferenced(kid))) continue;
    doomed.push(r.key);
  }
  if (doomed.length) await store.tx(async (tx) => { for (const k of doomed) await tx.del('ekeys', k); });
  return doomed.length;
}

/** Run to completion (or until shouldStop). Returns totals. */
export async function runSeal(store, env, hooks = {}, opts = {}) {
  let last = { sealed: 0, trashed: 0, failed: 0 }, steps = 0;
  for (;;) {
    if (opts.shouldStop && opts.shouldStop()) return { ...last, paused: true, steps };
    const r = await sealStep(store, env, hooks, opts);
    steps++;
    if (r.done) return { ...last, done: true, steps };
    if (r.groupDone) last = { sealed: last.sealed + r.sealed, trashed: last.trashed + r.trashed, failed: last.failed + r.failed };
  }
}
