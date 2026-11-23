// In-memory word index for the fuzzy search. PURE (no chrome.*, no IndexedDB): used by search-worker.js and by the Node
// tests/benchmarks.
//
// Layout
//   docs     dense uint32 doc ids (append only): docG (group ordinal), docSeq, docTs, alive (tombstones)
//   base     immutable compacted segment: sorted dictionary as ONE string (terms joined by "\0") + offsets, CSR posting
//            lists (varint of (docId delta)*4 + fieldMask), per-term df, bigram signature, char mask, length buckets
//   delta    terms/postings added since the last compaction (Map term -> {tid, list}); merged into the base by
//            compact() without re-reading any document text
//
// Matching kinds (best first): EQ(3) whole term, PRE(2) prefix, SUB(1) infix, FZ(0) typo-tolerant / subsequence.

import { docTerms, GRAM } from './searchNorm.js';

const EQ = 3;
const PRE = 2;
const SUB = 1;
const FZ = 0;
export const TOP_K = 5000;
const FUZZY_TERM_CAP = 64;
const UNSELECTIVE = 0.3;
const NONE = 0xffffffff;

// ---------- small helpers ----------
function termSig(t) {
  let s = 0;
  const n = t.length;
  if (n === 1) return 1 << (t.charCodeAt(0) & 31);
  for (let i = 0; i + 1 < n; i++) s |= 1 << ((t.charCodeAt(i) * 31 + t.charCodeAt(i + 1)) & 31);
  return s >>> 0;
}
function charMask(t) {
  let m = 0;
  for (let i = 0; i < t.length; i++) m |= 1 << (t.charCodeAt(i) & 31);
  return m >>> 0;
}
function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function isSubseq(q, t) {
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) if (t.charCodeAt(i) === q.charCodeAt(j)) j++;
  return j === q.length;
}

let rowA = new Int32Array(64);
let rowB = new Int32Array(64);
let rowC = new Int32Array(64);
/**
 * Optimal-string-alignment distance (insert/delete/substitute/adjacent transposition) between q and t, bounded by k.
 * prefix=true: distance between q and the best PREFIX of t. Returns k+1 when greater than k.
 */
export function osa(q, t, k, prefix) {
  const L = q.length;
  const M = prefix ? Math.min(t.length, L + k) : t.length;
  if (!prefix && Math.abs(L - M) > k) return k + 1;
  if (M + 1 > rowA.length) { rowA = new Int32Array(M + 8); rowB = new Int32Array(M + 8); rowC = new Int32Array(M + 8); }
  let pp = rowC; // row i-2
  let p = rowA; // row i-1
  let c = rowB; // row i
  for (let j = 0; j <= M; j++) p[j] = j;
  let best = prefix ? p[0] : NONE; // dist(q[0..0], t[0..0]) when L === 0
  for (let i = 1; i <= L; i++) {
    c[0] = i;
    let rowMin = i;
    const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= M; j++) {
      const tc = t.charCodeAt(j - 1);
      let v = p[j - 1] + (qc === tc ? 0 : 1);
      const del = p[j] + 1;
      if (del < v) v = del;
      const ins = c[j - 1] + 1;
      if (ins < v) v = ins;
      if (i > 1 && j > 1 && qc === t.charCodeAt(j - 2) && q.charCodeAt(i - 2) === tc) {
        const tr = pp[j - 2] + 1;
        if (tr < v) v = tr;
      }
      c[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return k + 1;
    const tmp = pp; pp = p; p = c; c = tmp;
  }
  // p now holds row L
  if (prefix) {
    best = NONE;
    for (let j = Math.max(0, L - k); j <= M; j++) if (p[j] < best) best = p[j];
  } else best = p[M];
  return best > k ? k + 1 : best;
}

function growTyped(arr, n, Ctor) {
  if (arr.length >= n) return arr;
  let cap = Math.max(1024, arr.length);
  while (cap < n) cap *= 2;
  const out = new Ctor(cap);
  out.set(arr);
  return out;
}

class ByteBuf {
  constructor(cap = 1 << 16) { this.b = new Uint8Array(cap); this.n = 0; }
  push(v) {
    if (this.n + 5 > this.b.length) { const nb = new Uint8Array(this.b.length * 2); nb.set(this.b); this.b = nb; }
    const b = this.b;
    let n = this.n;
    while (v >= 128) { b[n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    b[n++] = v;
    this.n = n;
  }
  done() { return this.b.slice(0, this.n); }
}

/** quickselect: the k-th largest value (1-based) of a Float64Array (destroys it) */
function kthLargest(a, n, k) {
  let lo = 0;
  let hi = n - 1;
  const target = k - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] > pivot) i++;
      while (a[j] < pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (target <= j) hi = j; else if (target >= i) lo = i; else return a[target];
  }
  return a[target];
}

export class SearchIndex {
  constructor() {
    this.docCount = 0;
    this.aliveCount = 0;
    this.docG = new Uint32Array(1024);
    this.docSeq = new Float64Array(1024);
    this.docTs = new Uint32Array(1024);
    this.alive = new Uint8Array(1024);
    this.gKeys = [];
    this.gOrdOf = new Map();
    this.groupAlive = new Uint8Array(64);
    this._emptyBase();
    this._resetDelta();
    this._scratch = null;
    this._bufId = new Uint32Array(4096);
    this._bufMask = new Uint8Array(4096);
  }

  // ---------- groups ----------
  gOrd(g) {
    let o = this.gOrdOf.get(g);
    if (o === undefined) {
      o = this.gKeys.length;
      this.gKeys.push(g);
      this.gOrdOf.set(g, o);
      this.groupAlive = growTyped(this.groupAlive, o + 1, Uint8Array);
      this.groupAlive[o] = 1;
    }
    return o;
  }

  /** list = [{id, deletedAt}] (the whole groups store). Groups not listed are dead. */
  setGroups(list) {
    for (let i = 0; i < this.gKeys.length; i++) this.groupAlive[i] = 0;
    for (const g of list) {
      const o = this.gOrd(g.id);
      this.groupAlive[o] = g.deletedAt == null ? 1 : 0;
    }
  }

  // ---------- base / delta ----------
  _emptyBase() {
    this.base = {
      n: 0, blob: '', off: new Uint32Array(1), df: new Uint32Array(0), sig: new Uint32Array(0), cm: new Uint32Array(0),
      postOff: new Uint32Array(1), post: new Uint8Array(0), lenOrder: new Uint32Array(0), lenStart: new Uint32Array(42),
    };
  }

  _resetDelta() {
    this.dPost = new Map(); // term -> {tid, list:number[]}
    this.dTid = new Map(); // base tid -> entry
    this.dNew = []; // delta terms that are not in the base
    this.deltaPostings = 0;
    this.deadCount = 0;
  }

  _term(i) {
    const b = this.base;
    return b.blob.substring(b.off[i], b.off[i + 1] - 1);
  }

  _lb(x) {
    let lo = 0;
    let hi = this.base.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._term(mid) < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _baseTid(term) {
    const i = this._lb(term);
    return i < this.base.n && this._term(i) === term ? i : -1;
  }

  _finishBase(terms, off, df, postOff, post) {
    const n = terms.length;
    const b = this.base;
    b.n = n;
    b.blob = n ? terms.join('\0') + '\0' : '';
    b.off = off;
    b.df = df;
    b.postOff = postOff;
    b.post = post;
    b.sig = new Uint32Array(n);
    b.cm = new Uint32Array(n);
    const lens = new Uint8Array(n);
    const counts = new Uint32Array(42);
    for (let i = 0; i < n; i++) {
      const t = terms[i];
      b.sig[i] = termSig(t);
      b.cm[i] = charMask(t);
      const l = Math.min(t.length, 40);
      lens[i] = l;
      counts[l + 1]++;
    }
    for (let l = 1; l < 42; l++) counts[l] += counts[l - 1];
    b.lenStart = counts.slice();
    b.lenOrder = new Uint32Array(n);
    const fill = counts.slice();
    for (let i = 0; i < n; i++) b.lenOrder[fill[lens[i]]++] = i;
  }

  // ---------- documents ----------
  _growDocs(n) {
    if (this.docG.length >= n) return;
    this.docG = growTyped(this.docG, n, Uint32Array);
    this.docSeq = growTyped(this.docSeq, n, Float64Array);
    this.docTs = growTyped(this.docTs, n, Uint32Array);
    this.alive = growTyped(this.alive, n, Uint8Array);
  }

  /** Always an upsert is the CALLER's job (removeKeys first when the key may exist). */
  addDoc(g, seq, ts, title, url, tagText) {
    const id = this.docCount++;
    this._growDocs(this.docCount);
    this.docG[id] = this.gOrd(g);
    this.docSeq[id] = seq;
    this.docTs[id] = Math.max(0, Math.min(0xffffffff, Math.floor((ts || 0) / 1000)));
    this.alive[id] = 1;
    this.aliveCount++;
    const terms = docTerms(title, url, tagText);
    for (const [term, mask] of terms) {
      let e = this.dPost.get(term);
      if (!e) {
        const tid = this._baseTid(term);
        e = { tid, list: [] };
        this.dPost.set(term, e);
        if (tid < 0) this.dNew.push(term); else this.dTid.set(tid, e);
      }
      e.list.push(id * 4 + mask);
    }
    this.deltaPostings += terms.size;
    return id;
  }

  /** ranges: [[groupId, fromSeq, toSeq]] (inclusive). One linear pass tombstones every matching doc. */
  removeRanges(ranges) {
    if (!ranges.length) return 0;
    const by = [];
    for (const [g, from, to] of ranges) {
      const o = this.gOrdOf.get(g);
      if (o === undefined) continue;
      (by[o] || (by[o] = [])).push(from, to);
    }
    if (!by.some(Boolean)) return 0;
    const { docG, docSeq, alive } = this;
    let n = 0;
    for (let d = 0; d < this.docCount; d++) {
      if (!alive[d]) continue;
      const r = by[docG[d]];
      if (!r) continue;
      const s = docSeq[d];
      for (let i = 0; i < r.length; i += 2) if (s >= r[i] && s <= r[i + 1]) { alive[d] = 0; n++; break; }
    }
    this.aliveCount -= n;
    this.deadCount += n;
    return n;
  }

  removeGroup(g) {
    const o = this.gOrdOf.get(g);
    if (o === undefined) return 0;
    const { docG, alive } = this;
    let n = 0;
    for (let d = 0; d < this.docCount; d++) if (alive[d] && docG[d] === o) { alive[d] = 0; n++; }
    this.aliveCount -= n;
    this.deadCount += n;
    return n;
  }

  needsCompaction() {
    return this.deltaPostings > 1_000_000 || this.dNew.length > 100_000 || (this.deadCount > 0 && this.deadCount > 0.15 * this.docCount);
  }

  hasDelta() { return this.deltaPostings > 0 || this.deadCount > 0; }

  // ---------- compaction (merges the delta into the base, drops dead docs; no document text needed) ----------
  async compact(yieldFn) {
    const b = this.base;
    const dc = this.docCount;
    const newId = new Uint32Array(dc);
    let live = 0;
    for (let d = 0; d < dc; d++) newId[d] = this.alive[d] ? live++ : NONE;
    const dNew = this.dNew.slice().sort();
    const outTerms = [];
    const post = new ByteBuf(Math.max(1 << 16, b.post.length + this.deltaPostings * 3));
    const off = [0];
    const df = [];
    const postOff = [0];
    let bi = 0;
    let di = 0;
    let sinceYield = 0;
    let t0 = performance.now();
    const tmpId = [];
    const tmpMask = [];
    const emit = (term, baseTid, deltaList) => {
      tmpId.length = 0;
      tmpMask.length = 0;
      if (baseTid >= 0) {
        let p = b.postOff[baseTid];
        const end = b.postOff[baseTid + 1];
        const bytes = b.post;
        let doc = 0;
        while (p < end) {
          let v = 0;
          let mul = 1;
          for (;;) { const x = bytes[p++]; v += (x & 127) * mul; if (x < 128) break; mul *= 128; }
          const mask = v % 4;
          doc += Math.floor(v / 4);
          const nid = newId[doc];
          if (nid !== NONE) { tmpId.push(nid); tmpMask.push(mask); }
        }
      }
      if (deltaList) {
        for (let i = 0; i < deltaList.length; i++) {
          const v = deltaList[i];
          const mask = v % 4;
          const nid = newId[Math.floor(v / 4)];
          if (nid !== NONE) { tmpId.push(nid); tmpMask.push(mask); }
        }
      }
      if (!tmpId.length) return;
      outTerms.push(term);
      off.push(off[off.length - 1] + term.length + 1);
      let prev = 0;
      let last = -1;
      let cnt = 0;
      for (let i = 0; i < tmpId.length; i++) {
        const id = tmpId[i];
        if (id === last) { // same doc twice (term in base and delta for a re-added key is impossible, but stay safe)
          continue;
        }
        post.push((id - prev) * 4 + tmpMask[i]);
        prev = id;
        last = id;
        cnt++;
      }
      df.push(cnt);
      postOff.push(post.n);
    };
    while (bi < b.n || di < dNew.length) {
      let useBase;
      if (bi >= b.n) useBase = false;
      else if (di >= dNew.length) useBase = true;
      else useBase = this._term(bi) < dNew[di];
      if (useBase) {
        const term = this._term(bi);
        const e = this.dTid.get(bi);
        emit(term, bi, e ? e.list : null);
        bi++;
      } else {
        const term = dNew[di++];
        emit(term, -1, this.dPost.get(term).list);
      }
      if (++sinceYield >= 4000) {
        sinceYield = 0;
        if (yieldFn && performance.now() - t0 > 8) { await yieldFn(); t0 = performance.now(); }
      }
    }
    // doc arrays
    const ng = new Uint32Array(Math.max(1024, live));
    const ns = new Float64Array(Math.max(1024, live));
    const nt = new Uint32Array(Math.max(1024, live));
    for (let d = 0; d < dc; d++) {
      const n = newId[d];
      if (n === NONE) continue;
      ng[n] = this.docG[d];
      ns[n] = this.docSeq[d];
      nt[n] = this.docTs[d];
    }
    // atomic swap (no awaits below)
    this.docG = ng;
    this.docSeq = ns;
    this.docTs = nt;
    this.alive = new Uint8Array(Math.max(1024, live)).fill(1, 0, live);
    this.docCount = live;
    this.aliveCount = live;
    this._finishBase(outTerms, Uint32Array.from(off), Uint32Array.from(df), Uint32Array.from(postOff), post.done());
    this._resetDelta();
    this._scratch = null;
    return { terms: outTerms.length, docs: live };
  }

  // ---------- snapshot ----------
  /** Base segment only: call after compact(). */
  serialize() {
    const b = this.base;
    return {
      meta: { docCount: this.docCount, gKeys: this.gKeys.slice(), terms: b.n },
      buffers: {
        blob: b.blob,
        off: b.off, df: b.df, postOff: b.postOff, post: b.post,
        docG: this.docG.slice(0, this.docCount), docSeq: this.docSeq.slice(0, this.docCount), docTs: this.docTs.slice(0, this.docCount),
      },
    };
  }

  static deserialize(snap) {
    const ix = new SearchIndex();
    const { meta, buffers: B } = snap;
    ix.gKeys = meta.gKeys.slice();
    ix.gOrdOf = new Map(ix.gKeys.map((g, i) => [g, i]));
    ix.groupAlive = new Uint8Array(Math.max(64, ix.gKeys.length)).fill(1);
    const n = meta.docCount;
    ix.docCount = n;
    ix.aliveCount = n;
    ix.docG = new Uint32Array(Math.max(1024, n)); ix.docG.set(B.docG);
    ix.docSeq = new Float64Array(Math.max(1024, n)); ix.docSeq.set(B.docSeq);
    ix.docTs = new Uint32Array(Math.max(1024, n)); ix.docTs.set(B.docTs);
    ix.alive = new Uint8Array(Math.max(1024, n)).fill(1, 0, n);
    const terms = meta.terms ? B.blob.slice(0, -1).split('\0') : [];
    ix._finishBase(terms, B.off, B.df, B.postOff, B.post);
    return ix;
  }

  stats() {
    const b = this.base;
    return {
      docs: this.docCount, alive: this.aliveCount, terms: b.n + this.dNew.length, baseTerms: b.n, postBytes: b.post.length,
      deltaPostings: this.deltaPostings, approxMB: Math.round((b.post.length + b.blob.length * 2 + b.n * 28 + this.docCount * 21) / 1048576),
    };
  }

  // ---------- postings ----------
  /** decodes a term's postings (base + delta) into _bufId/_bufMask, returns the count */
  _decode(e) {
    if (e.syn) {
      const sy = e.syn;
      if (sy.length + 8 > this._bufId.length) { this._bufId = new Uint32Array(sy.length * 2 + 8); this._bufMask = new Uint8Array(sy.length * 2 + 8); }
      for (let i = 0; i < sy.length; i++) { this._bufId[i] = sy[i]; this._bufMask[i] = 1; }
      return sy.length;
    }
    let n = 0;
    const b = this.base;
    if (e.tid >= 0) {
      let p = b.postOff[e.tid];
      const end = b.postOff[e.tid + 1];
      const need = b.df[e.tid] + (e.dl ? e.dl.length : 0) + 8;
      if (need > this._bufId.length) { this._bufId = new Uint32Array(need * 2); this._bufMask = new Uint8Array(need * 2); }
      const bytes = b.post;
      const ids = this._bufId;
      const masks = this._bufMask;
      let doc = 0;
      while (p < end) {
        let v = 0;
        let mul = 1;
        for (;;) { const x = bytes[p++]; v += (x & 127) * mul; if (x < 128) break; mul *= 128; }
        doc += Math.floor(v / 4);
        ids[n] = doc;
        masks[n++] = v % 4;
      }
    }
    const dl = e.dl;
    if (dl && dl.length) {
      if (n + dl.length + 8 > this._bufId.length) {
        const ni = new Uint32Array((n + dl.length) * 2); ni.set(this._bufId.subarray(0, n)); this._bufId = ni;
        const nm = new Uint8Array((n + dl.length) * 2); nm.set(this._bufMask.subarray(0, n)); this._bufMask = nm;
      }
      for (let i = 0; i < dl.length; i++) { this._bufId[n] = Math.floor(dl[i] / 4); this._bufMask[n++] = dl[i] % 4; }
    }
    return n;
  }

  // ---------- term matching ----------
  _mk(term, tid, kind, dist) {
    const de = this.dPost.get(term);
    const dl = de ? de.list : null;
    return { term, tid, dl, kind, dist, df: (tid >= 0 ? this.base.df[tid] : 0) + (dl ? dl.length : 0) };
  }

  /** EQ / PRE / SUB terms of one query token: [{term, tid, dl, kind, dist, df}] */
  matchExact(tok) {
    const out = [];
    const q = tok.term;
    const b = this.base;
    if (b.n) {
      const seen = new Set();
      const lo = this._lb(q);
      const hi = this._lb(q + '￿');
      for (let i = lo; i < hi; i++) {
        const t = this._term(i);
        out.push(this._mk(t, i, t === q ? EQ : PRE, 0));
        seen.add(i);
      }
      if (tok.sub) {
        let pos = 0;
        const blob = b.blob;
        for (;;) {
          const at = blob.indexOf(q, pos);
          if (at < 0) break;
          let l = 0;
          let h = b.n - 1;
          while (l < h) { const m = (l + h + 1) >> 1; if (b.off[m] <= at) l = m; else h = m - 1; }
          if (!seen.has(l)) {
            const tt = this._term(l);
            if (tt.charCodeAt(0) !== 1) out.push(this._mk(tt, l, SUB, 0));
            seen.add(l);
          }
          pos = b.off[l + 1];
        }
      }
    }
    for (const t of this.dNew) {
      if (t.charCodeAt(0) === 1) continue;
      if (t === q) out.push(this._mk(t, -1, EQ, 0));
      else if (t.startsWith(q)) out.push(this._mk(t, -1, PRE, 0));
      else if (tok.sub && t.includes(q)) out.push(this._mk(t, -1, SUB, 0));
    }
    if (tok.thai) {
      const syn = this._thaiGrams(q);
      if (syn.length) out.push({ term: GRAM + q, tid: -1, dl: null, syn, kind: SUB, dist: 0, df: syn.length });
    }
    return out;
  }

  /** docs (alive) containing ALL trigrams of the Thai token q: a superset of the docs containing q as a substring */
  _thaiGrams(q) {
    const grams = new Set();
    for (let i = 0; i + 3 <= q.length; i++) grams.add(GRAM + q.substr(i, 3));
    const lists = [];
    for (const gm of grams) {
      const tid = this._baseTid(gm);
      const de = this.dPost.get(gm);
      if (tid < 0 && !de) return [];
      const e = { term: gm, tid, dl: de ? de.list : null };
      const n = this._decode(e);
      const arr = new Uint32Array(n);
      let m = 0;
      for (let i = 0; i < n; i++) if (this.alive[this._bufId[i]]) arr[m++] = this._bufId[i];
      if (!m) return [];
      lists.push(arr.subarray(0, m));
    }
    if (!lists.length) return [];
    lists.sort((a, b) => a.length - b.length);
    let cur = lists[0];
    for (let li = 1; li < lists.length && cur.length; li++) {
      const o = lists[li];
      const out = new Uint32Array(cur.length);
      let n = 0;
      let j = 0;
      for (let i = 0; i < cur.length; i++) {
        const v = cur[i];
        while (j < o.length && o[j] < v) j++;
        if (j < o.length && o[j] === v) out[n++] = v;
      }
      cur = out.subarray(0, n);
    }
    return cur;
  }

  /** Typo-tolerant and subsequence terms (kind FZ), excluding the terms in `exact`. At most FUZZY_TERM_CAP. */
  matchFuzzy(tok, exact) {
    const q = tok.term;
    const k = tok.k;
    const L = q.length;
    if (k === 0 && !(tok.subseq && L >= 4)) return [];
    const b = this.base;
    const have = new Set(exact.map((m) => m.term));
    const found = new Map();
    const sigQ = termSig(q);
    const cmQ = charMask(q);
    const put = (term, tid, dist) => { const o = found.get(term); if (!o || dist < o.dist) found.set(term, { term, tid, dist }); };
    const typo = (term, tid) => {
      const tl = term.length;
      const sg = tid >= 0 ? b.sig[tid] : termSig(term);
      if (popcnt(sigQ & ~sg) > 3 * k) return;
      let d = k + 1;
      if (tl >= L - k && tl <= L + k) d = osa(q, term, k, false);
      if (d > k && tok.open && tl >= L - k && (term.charCodeAt(0) === q.charCodeAt(0) || term.charCodeAt(0) === q.charCodeAt(1))) d = osa(q, term, k, true);
      if (d <= k) put(term, tid, d);
    };
    const subseq = (term, tid) => {
      if (term.length > 2 * L || term.charCodeAt(0) !== q.charCodeAt(0)) return;
      const cm = tid >= 0 ? b.cm[tid] : charMask(term);
      if ((cmQ & ~cm) !== 0) return;
      if (isSubseq(q, term)) put(term, tid, k + 1);
    };
    if (b.n) {
      if (k > 0) {
        const lo = Math.max(1, L - k);
        const hi = Math.min(40, L + k);
        for (let l = lo; l <= hi; l++) {
          for (let p = b.lenStart[l]; p < b.lenStart[l + 1]; p++) {
            const tid = b.lenOrder[p];
            const t = this._term(tid);
            if (t.charCodeAt(0) !== 1 && !have.has(t)) typo(t, tid);
          }
        }
        if (tok.open) {
          for (const c of new Set([q[0], q[1]])) {
            if (!c) continue;
            const a = this._lb(c);
            const z = this._lb(c + '￿');
            for (let tid = a; tid < z; tid++) {
              const tl = b.off[tid + 1] - b.off[tid] - 1;
              if (tl > L + k) { const t = this._term(tid); if (!have.has(t)) typo(t, tid); }
            }
          }
        }
      }
      if (tok.subseq && L >= 4) {
        const a = this._lb(q[0]);
        const z = this._lb(q[0] + '￿');
        for (let tid = a; tid < z; tid++) {
          const tl = b.off[tid + 1] - b.off[tid] - 1;
          if (tl > 2 * L) continue;
          const t = this._term(tid);
          if (!have.has(t)) subseq(t, tid);
        }
      }
    }
    for (const t of this.dNew) {
      if (have.has(t) || t.charCodeAt(0) === 1) continue;
      if (k > 0) typo(t, -1);
      if (tok.subseq && L >= 4) subseq(t, -1);
    }
    const list = [...found.values()];
    for (const f of list) { const m = this._mk(f.term, f.tid, FZ, f.dist); f.dl = m.dl; f.df = m.df; f.kind = FZ; }
    list.sort((x, y) => x.dist - y.dist || y.df - x.df);
    return list.slice(0, FUZZY_TERM_CAP);
  }

  matchTerms(tok, fuzzy) {
    const ex = this.matchExact(tok);
    return fuzzy ? ex.concat(this.matchFuzzy(tok, ex)) : ex;
  }

  _scratchFor() {
    const n = this.docCount;
    if (!this._scratch || this._scratch.hits.length < n) {
      const cap = Math.max(1024, Math.ceil(n * 1.2));
      this._scratch = { hits: new Uint8Array(cap), minR: new Uint8Array(cap), sumR: new Uint16Array(cap), cand: new Uint32Array(Math.min(cap, 1 << 16)) };
    }
    return this._scratch;
  }

  /**
   * Runs the index part of a query.
   *   phase 'exact' : EQ/PRE/SUB terms.  phase 'fuzzy': also typo/subsequence terms; docs listed in `skip` (Set of "gOrd:seq"
   *   keys of the exact phase) are removed by the caller.
   * Returns {fallback:true} when every token is unselective, otherwise
 *   {g: Uint32Array(gOrd), seq: Float64Array, n, total, needles:[folded strings], needsVerify, unselective:[term], fuzzyTerms}
   */
  search(parsed, { phase = 'exact', allowedGroups = null, skip = null } = {}) {
    const fuzzy = phase === 'fuzzy';
    const toks = (!fuzzy && parsed.exactTokens) || parsed.tokens;
    if (!toks.length) return { g: new Uint32Array(0), seq: new Float64Array(0), n: 0, total: 0, needles: [], needsVerify: false, unselective: [] };
    const live = Math.max(1, this.aliveCount);
    const per = toks.map((tok) => {
      const ms = this.matchExact(tok);
      let est = 0;
      for (const m of ms) est += m.df;
      return { tok, ms, est };
    });
    const sel = [];
    const unsel = [];
    const empty = () => ({ g: new Uint32Array(0), seq: new Float64Array(0), n: 0, total: 0, needles: [], needsVerify: false, unselective: [] });
    for (const p of per) {
      if (p.est > UNSELECTIVE * live) { unsel.push(p); continue; }
      if (fuzzy) {
        const fz = this.matchFuzzy(p.tok, p.ms);
        for (const f of fz) p.est += f.df;
        p.ms = p.ms.concat(fz);
      }
      if (!p.ms.length) return empty();
      sel.push(p);
    }
    if (!sel.length && unsel.length) { /* handled below */ }
    if (!sel.length) return { fallback: true };
    sel.sort((a, b) => a.est - b.est);
    const T = sel.length;
    const { hits, minR, sumR } = this._scratchFor();
    let cand = this._scratch.cand;
    let nc = 0;
    const alive = this.alive;
    for (let i = 0; i < T; i++) {
      const { tok, ms } = sel[i];
      ms.sort((a, b) => b.kind - a.kind || a.dist - b.dist);
      const urlOnly = tok.urlOnly;
      for (const e of ms) {
        const n = this._decode(e);
        const ids = this._bufId;
        const masks = this._bufMask;
        const kr = e.kind * 2;
        for (let j = 0; j < n; j++) {
          const d = ids[j];
          if (!alive[d]) continue;
          const mask = masks[j];
          if (urlOnly && !(mask & 2)) continue;
          if (i === 0) {
            if (hits[d] === 0) {
              hits[d] = 1;
              const r = kr + (mask & 1);
              minR[d] = r;
              sumR[d] = r;
              if (nc >= cand.length) { const nb = new Uint32Array(cand.length * 2); nb.set(cand); cand = nb; this._scratch.cand = nb; }
              cand[nc++] = d;
            }
          } else if (hits[d] === i) {
            hits[d] = i + 1;
            const r = kr + (mask & 1);
            if (r < minR[d]) minR[d] = r;
            sumR[d] += r;
          }
        }
      }
    }
    // excludes
    for (const term of parsed.excludes) {
      const ms = this.matchTerms({ term, sub: term.length >= 2, k: 0, subseq: false, open: false }, false);
      for (const e of ms) {
        const n = this._decode(e);
        const ids = this._bufId;
        for (let j = 0; j < n; j++) { const d = ids[j]; if (hits[d] === T) hits[d] = 254; }
      }
    }
    // survivors -> keys
    const { docG, docSeq, docTs, groupAlive } = this;
    const keys = new Float64Array(nc);
    const docs = new Uint32Array(nc);
    let m = 0;
    for (let c = 0; c < nc; c++) {
      const d = cand[c];
      const ok = hits[d] === T;
      hits[d] = 0;
      if (!ok) continue;
      const go = docG[d];
      if (!groupAlive[go]) continue;
      if (allowedGroups && !allowedGroups.has(go)) continue;
      if (skip && skip.has(go + ':' + docSeq[d])) continue;
      keys[m] = (minR[d] * 64 + Math.min(sumR[d], 63)) * 4294967296 + docTs[d];
      docs[m++] = d;
    }
    const total = m;
    // top K by key (descending)
    let order;
    if (m <= TOP_K) {
      order = new Uint32Array(m);
      for (let i = 0; i < m; i++) order[i] = i;
      order.sort((a, b) => keys[b] - keys[a]);
    } else {
      const copy = keys.slice(0, m);
      const thr = kthLargest(copy, m, TOP_K);
      const pick = [];
      for (let i = 0; i < m; i++) if (keys[i] >= thr) pick.push(i);
      pick.sort((a, b) => keys[b] - keys[a]);
      order = Uint32Array.from(pick.slice(0, TOP_K));
    }
    const n = order.length;
    const g = new Uint32Array(n);
    const seq = new Float64Array(n);
    for (let i = 0; i < n; i++) { const d = docs[order[i]]; g[i] = docG[d]; seq[i] = docSeq[d]; }
    const needles = [];
    const fz = [];
    for (const p of per) {
      if (!fuzzy) needles.push(p.tok.term);
      else {
        let any = false;
        for (const mm of p.ms) if (mm.kind === FZ) { fz.push(mm.term); any = true; }
        if (!any) needles.push(p.tok.term);
      }
    }
    return {
      g, seq, n, total, needles: fuzzy ? needles.concat(fz.slice(0, 48)) : needles, fuzzyTerms: fz,
      needsVerify: unsel.length > 0 || parsed.phrases.length > 0 || !!parsed.site || toks.some((t) => t.thai) || (!fuzzy && parsed.implicit.length > 0),
      unselective: unsel.map((p) => p.tok.term),
      verify: toks.filter((t) => t.thai).map((t) => t.term).concat(fuzzy ? [] : parsed.implicit),
    };
  }
}

export { EQ, PRE, SUB, FZ };
