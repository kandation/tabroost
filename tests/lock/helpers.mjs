// Test data builders and harness helpers for tests/lock/run.mjs
import { FakeStore, CrashError } from './fakestore.js';
import { encryptBatchWhileLocked } from '../../lib/lock/inbox.js';
import {
  decodeItem, decodeGroup, decodeCategory, decodeTrashRow, decodeSnapshot, decodeVault, decodeSetting,
  decodeSiteRow, decodeFavicon,
} from '../../lib/lock/rec.js';
import { canon } from '../../lib/lock/jobutil.js';

export const LOW_ITER = 2000;

// deterministic PRNG so crash points are reproducible
export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const deriveSearch = (it) => ({ t: (it.title + ' ' + it.url).toLowerCase(), tk: it.title.toLowerCase().slice(0, 32) });

export function mkItem(g, seq, i = seq, tag = '') {
  const host = `site${i % 40}${tag}.example.com`;
  const o = {
    g, seq, url: `https://${host}/a/${i}?x=${i}`, title: `Page title number ${i} ${'x'.repeat(i % 20)}`,
    ts: 1700000000000 + i * 1000, site: host,
  };
  if (i % 7 === 0) o.tg = 3;
  if (i % 11 === 0) o.w = 2;
  if (i % 5 === 0) o.iid = 'iid' + i;
  if (i % 13 === 0) o.del = 1;
  return { ...o, ...deriveSearch(o) };
}

export const SENSITIVE = new Set(['excludeSites', 'whitelist', 'autoRules']);

/** Fill a FakeStore with plaintext data for every record type. Returns the item count. */
export function buildPlainDb(store, { nItems = 600, nGroups = 3 } = {}) {
  const seqs = {};
  for (let g = 1; g <= nGroups; g++) {
    seqs[g] = 0;
    store._put('groups', {
      id: g, createdAt: 1700000000000 + g, title: `Group ${g} private`, note: `note ${g}`, phase: 'committed', starred: g === 1,
      count: 0, nextSeq: 1, ord: g, agg: { top: [['site1.example.com', 3]], nSites: 1, nTg: 1 }, tabGroups: [{ title: 'TG ' + g, color: 'blue' }],
    });
  }
  for (let i = 1; i <= nItems; i++) {
    const g = 1 + (i % nGroups);
    store._put('items', mkItem(g, ++seqs[g], i));
  }
  for (let c = 1; c <= 3; c++) store._put('categories', { id: c, name: 'Category ' + c, color: 'red', ord: c });
  for (let t = 1; t <= 12; t++) store._put('trash', { kind: 'items', g: 1, items: [mkItem(1, 900 + t, 900 + t), mkItem(1, 950 + t, 950 + t)], n: 2, deletedAt: 1700000100000 + t, delReason: 'deleted' });
  for (let h = 0; h < 40; h++) {
    store._put('sites', { site: `site${h}.example.com`, n: 5 + h, first: 1700000000000 + h });
    for (let g = 1; g <= nGroups; g++) store._put('siteIdx', { site: `site${h}.example.com`, g, n: 1 + h % 3 });
    store._put('favicons', { site: `site${h}.example.com`, icon: 'data:image/png;base64,AAAA' + h, ts: 1700000000000 + h });
  }
  for (let s = 1; s <= 4; s++) store._put('snapshots', { id: 's' + s, ts: 1700000200000 + s, nTabs: 2, nWin: 1, tabs: [{ url: `https://snap${s}.example.com/x`, title: 'Snap tab ' + s }, { url: 'https://other.example.org/', title: 'Other ' + s }] });
  for (let v = 1; v <= nGroups; v++) store._put('vault', { id: 'g' + v, data: { g: v, items: Array.from({ length: 30 }, (_, k) => ({ url: `https://v${v}.example.com/${k}`, title: 'Vault item ' + k })) } });
  store._put('settings', { name: 'excludeSites', value: ['bank.example.com', 'mail.example.com'] });
  store._put('settings', { name: 'autoRules', value: [{ match: 'news.example.com', cat: 2 }] });
  store._put('settings', { name: 'theme', value: 'dark' });
  for (let s = 1; s <= 20; s++) store._put('search', { id: s, blob: 'x'.repeat(100) });
  return nItems;
}

export const ALL_STORES = ['items', 'trash', 'groups', 'categories', 'siteIdx', 'sites', 'snapshots', 'vault', 'settings', 'favicons'];

/** Decode every row of every store through the tolerant decoders (works for plaintext, ciphertext and mixed). */
export async function logicalView(store, reader) {
  const strip = ({ t, tk, ...r }) => r;
  const out = {};
  out.items = (await Promise.all(store.allValues('items').map((r) => decodeItem(r, reader)))).map(strip);
  out.trash = (await Promise.all(store.allValues('trash').map((r) => decodeTrashRow(r, reader)))).map((r) => ({ ...r, items: r.items.map(strip) }));
  out.groups = await Promise.all(store.allValues('groups').map((r) => decodeGroup(r, reader)));
  out.categories = await Promise.all(store.allValues('categories').map((r) => decodeCategory(r, reader)));
  const sites = await Promise.all(store.allValues('sites').map((r) => decodeSiteRow(r, reader)));
  out.sites = sites.map(({ token, ...r }) => r).sort((a, b) => (a.site < b.site ? -1 : 1));
  out.siteIdxCount = store.size('siteIdx');
  out.snapshots = await Promise.all(store.allValues('snapshots').map((r) => decodeSnapshot(r, reader)));
  out.vault = await Promise.all(store.allValues('vault').map((r) => decodeVault(r, reader)));
  out.settings = await Promise.all(store.allValues('settings').map((r) => decodeSetting(r, reader)));
  const fav = await Promise.all(store.allValues('favicons').map((r) => decodeFavicon(r, reader)));
  out.favicons = fav.map(({ token, ...r }) => r).sort((a, b) => (a.site < b.site ? -1 : 1));
  return canon(out);
}

/** Run `fn` repeatedly, injecting crashes at random tx-operation counts, until it completes. Returns {result, crashes}. */
export async function withCrashes(store, rng, fn, { maxOps = 400, pCrash = 0.8, pAfter = 0.2 } = {}) {
  let crashes = 0;
  for (let attempt = 0; attempt < 2000; attempt++) {
    store.crashIn = rng() < pCrash ? Math.floor(rng() * maxOps) : null;
    store.crashAfterCommit = rng() < pAfter;
    try { const result = await fn(); store.crashIn = null; store.crashAfterCommit = false; return { result, crashes }; } catch (e) {
      if (!(e instanceof CrashError)) throw e;
      crashes++;
    }
  }
  store.crashIn = null; store.crashAfterCommit = false;
  return { result: await fn(), crashes };
}

/** Simulate db.js writing a locked stash batch: ekeys row + item rows + inbox row in ONE tx. */
export async function lockedStash(store, pub, kid, items) {
  const b = await encryptBatchWhileLocked({ pub, kid, items });
  const g = items[0].g;
  await store.tx(async (tx) => {
    await tx.put('ekeys', b.ekey);
    for (const r of b.records) await tx.put('items', r);
    const cur = await tx.get('inbox', g);
    await tx.put('inbox', { g, kids: [...new Set([...(cur ? cur.kids : []), kid])] });
  });
  return b;
}

export const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export class MemAdapter {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k); }
  async set(k, v) { this.m.set(k, structuredClone(v)); }
  async remove(k) { this.m.delete(k); }
}
export { FakeStore, CrashError };
