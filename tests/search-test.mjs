// Property + recall tests for lib/searchNorm.js and lib/searchIndex.js. Run: node tests/search-test.mjs
import { SearchIndex, osa, TOP_K } from '../lib/searchIndex.js';
import { parseQuery, docTerms, foldFast, tokenize, highlight, fold } from '../lib/searchNorm.js';
import { makeCorpus, rng } from './corpus.mjs';

let failed = 0;
const ok = (c, msg) => { if (!c) { failed++; console.log('FAIL:', msg); } };
const section = (s) => console.log('\n== ' + s);

const N = Number(process.env.N || 10000);
const docs = [];
{
  let i = 0;
  for (const d of makeCorpus(N, 7)) { docs.push({ g: 'g' + (i % 40), seq: Math.floor(i / 40) + 1, ...d }); i++; }
}
for (const d of docs) d.terms = docTerms(d.title, d.url);

function build(list) {
  const ix = new SearchIndex();
  ix.setGroups([...new Set(list.map((d) => d.g))].map((id) => ({ id, deletedAt: null })));
  for (const d of list) ix.addDoc(d.g, d.seq, d.ts, d.title, d.url);
  return ix;
}
const ix = build(docs);
await ix.compact();
const keyOf = (g, s) => g + ':' + s;
const resKeys = (ixx, r) => { const out = []; for (let i = 0; i < r.n; i++) out.push(keyOf(ixx.gKeys[r.g[i]], r.seq[i])); return out; };
const skipOf = (r) => { const s = new Set(); for (let j = 0; j < r.n; j++) s.add(r.g[j] + ':' + r.seq[j]); return s; };

// ---------- 0. norm ----------
section('norm');
ok(foldFast('Café ÜBER') === 'cafe uber', 'latin fold');
ok(foldFast('น้ำ ก๊วย') === 'นำ กวย', 'thai tone marks dropped: ' + foldFast('น้ำ ก๊วย'));
ok(foldFast('๑๒๓') === '123', 'thai digits');
ok(fold('Café').s === 'cafe' && highlight('Café Au', ['cafe'])[0].join() === '0,4', 'highlight offsets');
ok(tokenize(foldFast('github.com/foo-bar')).map((t) => t.term).join() === 'github,com,foo,bar', 'tokenize latin');
{
  const t = tokenize(foldFast('ค้นหาแท็บที่เก็บไว้')).map((x) => x.term);
  ok(t.length >= 3, 'thai segmentation: ' + t.join('|'));
}
ok(osa('github', 'gethub', 1, false) === 1, 'osa substitution');
ok(osa('github', 'gitub', 1, false) === 1, 'osa deletion');
ok(osa('github', 'gihtub', 1, false) === 1, 'osa transposition');
ok(osa('github', 'gethab', 1, false) === 2, 'osa bound');
ok(osa('gith', 'github', 1, true) === 0, 'osa prefix');

// ---------- 1. exact tier equals brute force ----------
section('exact tier == brute force (index EQ/PRE/SUB)');
{
  const r = rng(5);
  let tested = 0;
  let skipped = 0;
  let mism = 0;
  const samples = [];
  for (let i = 0; i < 600; i++) {
    const d = docs[Math.floor(r() * docs.length)];
    const terms = [...d.terms.keys()].filter((t) => /^[a-z0-9]+$/.test(t) && t.length >= 3);
    if (!terms.length) continue;
    const term = terms[Math.floor(r() * terms.length)];
    const len = 3 + Math.floor(r() * (term.length - 2));
    const start = Math.floor(r() * (term.length - len + 1));
    samples.push(term.slice(start, start + len));
  }
  for (const q of samples) {
    const res = ix.search(parseQuery(q + ' '), { phase: 'exact' });
    if (res.fallback) { skipped++; continue; }
    const want = new Set();
    for (const d of docs) for (const t of d.terms.keys()) if (t.includes(q)) { want.add(keyOf(d.g, d.seq)); break; }
    if (want.size > TOP_K) { skipped++; continue; }
    const got = new Set(resKeys(ix, res));
    tested++;
    if (got.size !== want.size || [...want].some((k) => !got.has(k))) { mism++; if (mism < 4) console.log('  mismatch for', q, want.size, got.size); }
  }
  ok(mism === 0, `exact tier mismatches: ${mism}`);
  console.log(`  queries tested ${tested}, skipped (unselective/cap) ${skipped}, mismatches ${mism}`);
}

// ---------- 2. thai substring recall ----------
section('thai substring recall vs fold(t).includes(q)');
{
  const r = rng(11);
  const th = docs.filter((d) => /[฀-๿]/.test(d.title));
  let want = 0;
  let got = 0;
  for (let i = 0; i < 300; i++) {
    const d = th[Math.floor(r() * th.length)];
    const f = foldFast(d.title);
    const s = Math.floor(r() * Math.max(1, f.length - 4));
    const q = f.slice(s, s + 3 + Math.floor(r() * 3)).trim();
    if (q.length < 3 || /\s/.test(q)) continue;
    const res = ix.search(parseQuery(q), { phase: 'exact' });
    if (res.fallback) continue;
    const truth = new Set();
    for (const x of docs) if (foldFast(x.title + '\n' + x.url).includes(q)) truth.add(keyOf(x.g, x.seq));
    if (!truth.size || truth.size > TOP_K) continue;
    const have = new Set(resKeys(ix, res));
    want += truth.size;
    for (const k of truth) if (have.has(k)) got++;
  }
  const rec = want ? got / want : 1;
  console.log(`  recall ${(rec * 100).toFixed(1)}% (${got}/${want})`);
  ok(rec >= 0.9, `thai substring recall ${rec}`); // substrings that span a word boundary cannot be found through terms
}

// ---------- 3/4. fuzzy recall / precision ----------
section('fuzzy recall / precision');
function perturb(r, w) {
  const kind = Math.floor(r() * 4);
  const i = 1 + Math.floor(r() * (w.length - 2));
  const abc = 'abcdefghijklmnopqrstuvwxyz';
  if (kind === 0) return w.slice(0, i) + abc[Math.floor(r() * 26)] + w.slice(i + 1);
  if (kind === 1) return w.slice(0, i) + abc[Math.floor(r() * 26)] + w.slice(i);
  if (kind === 2) return w.slice(0, i) + w.slice(i + 1);
  return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
}
{
  const r = rng(21);
  let wantTot = 0;
  let gotTot = 0;
  let precBad = 0;
  let precTot = 0;
  let nq = 0;
  for (let i = 0; i < 400; i++) {
    const d = docs[Math.floor(r() * docs.length)];
    const terms = [...d.terms.keys()].filter((t) => /^[a-z]+$/.test(t) && t.length >= 5);
    if (!terms.length) continue;
    const q = perturb(r, terms[Math.floor(r() * terms.length)]);
    const p = parseQuery(q + ' ');
    const tok = p.tokens[0];
    if (!tok || tok.k === 0) continue;
    const k = tok.k;
    const exact = ix.search(p, { phase: 'exact' });
    if (exact.fallback) continue;
    const fz = ix.search(p, { phase: 'fuzzy', skip: skipOf(exact) });
    if (fz.fallback) continue;
    const have = new Set(resKeys(ix, exact).concat(resKeys(ix, fz)));
    const truthTypo = new Set();
    const truthAny = new Set();
    for (const x of docs) {
      let m = false;
      for (const t of x.terms.keys()) {
        if (t.includes(q) || osa(q, t, k, false) <= k) { m = true; break; }
      }
      let any = m;
      if (!any) {
        for (const t of x.terms.keys()) {
          if (t.charCodeAt(0) !== q.charCodeAt(0) || t.length > 2 * q.length) continue;
          let j = 0;
          for (let c = 0; c < t.length && j < q.length; c++) if (t[c] === q[j]) j++;
          if (j === q.length) { any = true; break; }
        }
      }
      if (m) truthTypo.add(keyOf(x.g, x.seq));
      if (any) truthAny.add(keyOf(x.g, x.seq));
    }
    if (truthTypo.size > TOP_K) continue;
    nq++;
    wantTot += truthTypo.size;
    for (const k2 of truthTypo) if (have.has(k2)) gotTot++;
    for (const k2 of resKeys(ix, fz)) { precTot++; if (!truthAny.has(k2)) precBad++; }
  }
  const rec = wantTot ? gotTot / wantTot : 1;
  console.log(`  perturbed single-token queries ${nq}: recall ${(rec * 100).toFixed(2)}% (${gotTot}/${wantTot}), fuzzy rows ${precTot}, precision violations ${precBad}`);
  ok(rec >= 0.95, `fuzzy recall ${rec}`);
  ok(precBad === 0, `fuzzy precision violations ${precBad}`);
}

// ---------- 5. target-in-top-50 for perturbed multi-word queries ----------
section('target found (1-3 words, one typo each)');
{
  const r = rng(33);
  const by = { 1: { n: 0, found: 0, top50: 0 }, 2: { n: 0, found: 0, top50: 0 }, 3: { n: 0, found: 0, top50: 0 } };
  for (let i = 0; i < 600; i++) {
    const d = docs[Math.floor(r() * docs.length)];
    const words = foldFast(d.title).split(/\s+/).filter((w) => /^[a-z]{5,}$/.test(w));
    if (words.length < 1) continue;
    const take = Math.min(words.length, 1 + Math.floor(r() * 3));
    const qs = words.slice(0, take).map((w) => (r() < 0.8 ? perturb(r, w) : w));
    const p = parseQuery(qs.join(' ') + ' ');
    const res = ix.search(p, { phase: 'exact' });
    if (res.fallback) continue;
    const fz = ix.search(p, { phase: 'fuzzy', skip: skipOf(res) });
    const order = resKeys(ix, res).concat(fz.fallback ? [] : resKeys(ix, fz));
    const k = keyOf(d.g, d.seq);
    const row = by[take];
    row.n++;
    const at = order.indexOf(k);
    if (at >= 0) row.found++;
    if (at >= 0 && at < 50) row.top50++;
  }
  for (const w of [1, 2, 3]) console.log(`  ${w} word(s): n=${by[w].n} found ${((by[w].found / by[w].n) * 100).toFixed(1)}%  top-50 ${((by[w].top50 / by[w].n) * 100).toFixed(1)}%`);
  ok(by[1].found / by[1].n >= 0.95 && by[2].found / by[2].n >= 0.95 && by[3].found / by[3].n >= 0.95, 'found rate');
  ok(by[2].top50 / by[2].n >= 0.9 && by[3].top50 / by[3].n >= 0.9, 'top-50 hit rate for 2+ words');
  const rr = rng(77);
  let tot = 0;
  for (let i = 0; i < 200; i++) {
    const q = Array.from({ length: 8 }, () => 'qxzjkvwy'[Math.floor(rr() * 8)]).join('');
    const p = parseQuery(q);
    const e = ix.search(p, { phase: 'exact' });
    const f = ix.search(p, { phase: 'fuzzy' });
    tot += (e.total || 0) + (f.total || 0);
  }
  console.log(`  mean rows for 200 nonsense queries: ${(tot / 200).toFixed(2)}`);
  ok(tot / 200 < 5, 'nonsense queries return few rows');
}

// ---------- 6. operators ----------
section('operators');
{
  const g = ix.search(parseQuery('github'), { phase: 'exact' });
  const gx = ix.search(parseQuery('github -youtube'), { phase: 'exact' });
  const yt = new Set(resKeys(ix, ix.search(parseQuery('youtube'), { phase: 'exact' })));
  ok(gx.n <= g.n && resKeys(ix, gx).every((k) => !yt.has(k)), 'exclusion');
  const s = ix.search(parseQuery('site:github.com'), { phase: 'exact' });
  ok(s.fallback || s.n > 0, 'site: finds docs');
}

// ---------- 7. write operations == rebuild ----------
section('add/remove/group delete/compact == rebuild');
{
  const r = rng(101);
  const live = new Map();
  const a = new SearchIndex();
  a.setGroups([...new Set(docs.map((d) => d.g))].map((id) => ({ id, deletedAt: null })));
  for (const d of docs.slice(0, 4000)) { a.addDoc(d.g, d.seq, d.ts, d.title, d.url); live.set(keyOf(d.g, d.seq), d); }
  await a.compact();
  for (let step = 0; step < 40; step++) {
    const op = r();
    if (op < 0.4) {
      const d = docs[4000 + Math.floor(r() * 4000)];
      if (!live.has(keyOf(d.g, d.seq))) { a.addDoc(d.g, d.seq, d.ts, d.title, d.url); live.set(keyOf(d.g, d.seq), d); }
    } else if (op < 0.75) {
      const keys = [...live.keys()];
      const k = keys[Math.floor(r() * keys.length)];
      const d = live.get(k);
      a.removeRanges([[d.g, d.seq, d.seq]]);
      live.delete(k);
    } else if (op < 0.85) {
      const g = 'g' + Math.floor(r() * 40);
      a.removeGroup(g);
      for (const [k, d] of [...live]) if (d.g === g) live.delete(k);
    } else if (op < 0.95) await a.compact();
    else {
      const d = docs[Math.floor(r() * 4000)];
      const k = keyOf(d.g, d.seq);
      if (!live.has(k)) { a.addDoc(d.g, d.seq, d.ts, d.title, d.url); live.set(k, d); }
    }
  }
  const b = build([...live.values()]);
  await b.compact();
  let diff = 0;
  for (const q of ['github', 'youtube', 'recipe', 'ค้นหา', 'google docs', 'gethub', 'news -stock']) {
    const ra = a.search(parseQuery(q), { phase: 'exact' });
    const rb = b.search(parseQuery(q), { phase: 'exact' });
    if (ra.fallback || rb.fallback) continue;
    const sa = new Set(resKeys(a, ra));
    const sb = new Set(resKeys(b, rb));
    if (sa.size !== sb.size || [...sa].some((x) => !sb.has(x))) { diff++; console.log('  diff for', q, sa.size, sb.size); }
  }
  ok(diff === 0, 'incremental index equals rebuilt index');
  const c = SearchIndex.deserialize(b.serialize());
  c.setGroups([...new Set([...live.values()].map((d) => d.g))].map((id) => ({ id, deletedAt: null })));
  const rb = b.search(parseQuery('github'), { phase: 'exact' });
  const rc = c.search(parseQuery('github'), { phase: 'exact' });
  ok(!rb.fallback && !rc.fallback && rb.n === rc.n, 'snapshot round trip');
  console.log('  ok (live docs ' + live.size + ')');
}

// ---------- 8. edge cases ----------
section('edge cases');
{
  ix.search(parseQuery('a'), { phase: 'exact' });
  ix.search(parseQuery('\u{1F600}'), { phase: 'exact' });
  ok(parseQuery('').tokens.length === 0, 'empty query');
  ok(parseQuery('"exact phrase" -x site:a.b g:grp').phrases.length === 1, 'phrase parsed');
  const hl = highlight('GitHub - Café', ['github', 'cafe']);
  ok(hl.length === 2, 'highlight ranges ' + JSON.stringify(hl));
}

console.log(failed ? `\n${failed} FAILED` : '\nsearch-test: all passed');
process.exit(failed ? 1 : 0);
