// Node benchmark for the in-memory search index. Run: node --expose-gc bench/search-bench.mjs [items=300000]
import { SearchIndex } from '../lib/searchIndex.js';
import { parseQuery, foldFast } from '../lib/searchNorm.js';
import { makeCorpus, rng } from '../tests/corpus.mjs';

const N = Number(process.argv[2] || 300000);
const mb = (x) => Math.round(x / 1048576);
const ix = new SearchIndex();
const groups = Math.max(1, Math.floor(N / 100));
ix.setGroups(Array.from({ length: groups }, (_, i) => ({ id: 'g' + i, deletedAt: null })));
const samples = [];
const t0 = performance.now();
let i = 0;
const CH = 80000;
for (const d of makeCorpus(N, 3)) {
  ix.addDoc('g' + (i % groups), Math.floor(i / groups) + 1, d.ts, d.title, d.url);
  if (i % 500 === 0 && samples.length < 4000) samples.push(d);
  i++;
  if (i % CH === 0) await ix.compact();
}
await ix.compact();
const buildMs = performance.now() - t0;
globalThis.gc && globalThis.gc();
const mem = process.memoryUsage();
console.log(`items ${N}: build+compact ${(buildMs / 1000).toFixed(1)} s (${((buildMs / N) * 1000).toFixed(1)} us/doc)`);
console.log(`stats ${JSON.stringify(ix.stats())}  heapUsed ${mb(mem.heapUsed)} MB  rss ${mb(mem.rss)} MB`);
const snap = ix.serialize();
let bytes = snap.buffers.blob.length * 2;
for (const k of ['off', 'df', 'postOff', 'post', 'docG', 'docSeq', 'docTs']) bytes += snap.buffers[k].byteLength;
console.log(`snapshot ~${mb(bytes)} MB`);
let t = performance.now();
const re = SearchIndex.deserialize(snap);
console.log(`deserialize ${(performance.now() - t).toFixed(0)} ms`);

function perturb(r, w) {
  const i2 = 1 + Math.floor(r() * (w.length - 2));
  const k = Math.floor(r() * 4);
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  if (k === 0) return w.slice(0, i2) + abc[Math.floor(r() * 26)] + w.slice(i2 + 1);
  if (k === 1) return w.slice(0, i2) + abc[Math.floor(r() * 26)] + w.slice(i2);
  if (k === 2) return w.slice(0, i2) + w.slice(i2 + 1);
  return w.slice(0, i2) + w[i2 + 1] + w[i2] + w.slice(i2 + 2);
}
const r = rng(9);
const words = [];
for (const d of samples) for (const w of foldFast(d.title).split(/\s+/)) if (/^[a-z]{5,}$/.test(w)) words.push(w);
const thai = [];
for (const d of samples) { const f = foldFast(d.title); if (/[ก-๛]{6}/.test(f)) { const m = f.match(/[ก-๛]{6,}/); if (m) thai.push(m[0]); } }
const pick = (a) => a[Math.floor(r() * a.length)];
const classes = {
  common: () => 'github',
  rare: () => pick(words),
  nonexistent: () => 'zqxjkv' + Math.floor(r() * 99),
  short2: () => pick(words).slice(0, 2),
  typo: () => perturb(r, pick(words)),
  thai: () => pick(thai).slice(0, 5),
  phrase: () => '"' + pick(words) + ' ' + pick(words) + '"',
  exclusion: () => pick(words) + ' -github',
  site: () => 'site:github.com ' + pick(words),
  twoWords: () => pick(words) + ' ' + pick(words),
};
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log('\nquery class      exact p50/p95 ms    fuzzy p50/p95 ms   (index part only; fallback = scan needed)');
for (const [name, gen] of Object.entries(classes)) {
  const ex = [];
  const fz = [];
  let fb = 0;
  for (let n = 0; n < 60; n++) {
    const p = parseQuery(gen() + ' ');
    let a = performance.now();
    const res = ix.search(p, { phase: 'exact' });
    ex.push(performance.now() - a);
    if (res.fallback) { fb++; continue; }
    const skip = new Set();
    for (let j = 0; j < res.n; j++) skip.add(res.g[j] + ':' + res.seq[j]);
    a = performance.now();
    ix.search(p, { phase: 'fuzzy', skip });
    fz.push(performance.now() - a);
  }
  console.log(`${name.padEnd(14)} ${pct(ex, 0.5).toFixed(1).padStart(7)} / ${pct(ex, 0.95).toFixed(1).padEnd(7)} ${fz.length ? pct(fz, 0.5).toFixed(1).padStart(8) + ' / ' + pct(fz, 0.95).toFixed(1).padEnd(7) : '       -'}  fallback ${fb}/60`);
}
// writes: add 1000 docs into the live index (delta) and compaction cost
t = performance.now();
for (let k = 0; k < 1000; k++) ix.addDoc('g0', 100000 + k, Date.now(), 'Fresh ' + k + ' title words', 'https://example.test/fresh/' + k);
console.log(`\nadd 1000 docs to delta: ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
await ix.compact();
console.log(`compact (1000 new docs on ${N}): ${(performance.now() - t).toFixed(0)} ms`);
