// Text folding, tokenising and query parsing for the fuzzy search. PURE (no chrome.*, no IndexedDB): shared by the
// search worker, the page and the Node tests. Bump NORM_VERSION whenever folding/tokenising changes: the worker then
// rebuilds the index.

export const NORM_VERSION = 1;

const ASCII = /^[\x00-\x7f]*$/;
const STRIP = /[̀-ͯ็-์​-‍﻿]/g; // latin diacritics, thai tone marks/thanthakhat, zero-widths
const THAI_DIGITS = /[๐-๙]/g;
const SARA_AM = /ํา/g;

const thaiDigit = (c) => String.fromCharCode(c.charCodeAt(0) - 0x0e50 + 48);

/** Fold without an offset map (hot path: indexing and matching). */
export function foldFast(str) {
  let s = String(str == null ? '' : str);
  if (ASCII.test(s)) return s.toLowerCase();
  s = s.normalize('NFKC').toLowerCase().normalize('NFD').replace(STRIP, '');
  return s.replace(SARA_AM, 'ำ').replace(THAI_DIGITS, thaiDigit);
}

/** Fold with `map`: Int32Array, folded UTF-16 index -> original UTF-16 index (for highlighting). */
export function fold(str) {
  const src = String(str == null ? '' : str);
  if (ASCII.test(src)) return { s: src.toLowerCase(), map: null };
  let out = '';
  const map = [];
  for (let i = 0; i < src.length;) {
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    let n;
    if (cp < 128) n = ch.toLowerCase();
    else if (cp === 0x0e33) n = ch;
    else {
      n = ch.normalize('NFKC').toLowerCase().normalize('NFD').replace(STRIP, '');
      n = n.replace(SARA_AM, 'ำ').replace(THAI_DIGITS, thaiDigit);
    }
    for (let k = 0; k < n.length; k++) map.push(i);
    out += n;
    i += len;
  }
  return { s: out, map: Int32Array.from(map) };
}

// ---------- tokenising ----------
let segmenter = null;
function seg() {
  if (!segmenter) segmenter = new Intl.Segmenter('th', { granularity: 'word' });
  return segmenter;
}
const RUN = /[\p{L}\p{N}\p{M}]+/gu;
const PLAIN = /^[a-z0-9]+$/;
const MAX_TERM = 40;

/** tokens of an already folded string: [{term, start, end}] (start/end in folded UTF-16 units). */
export function tokenize(f, out = []) {
  RUN.lastIndex = 0;
  let m;
  while ((m = RUN.exec(f)) !== null) {
    const run = m[0];
    const base = m.index;
    if (PLAIN.test(run)) {
      out.push({ term: run.length > MAX_TERM ? run.slice(0, MAX_TERM) : run, start: base, end: base + run.length });
      continue;
    }
    let prev = null; // last token pushed from this run (to merge 1-code-point segments)
    for (const sg of seg().segment(run)) {
      if (!sg.isWordLike) continue;
      const start = base + sg.index;
      const end = start + sg.segment.length;
      const oneCp = [...sg.segment].length === 1;
      if (oneCp && prev && prev.end === start) {
        prev.end = end;
        prev.term = (prev.term + sg.segment).slice(0, MAX_TERM);
        continue;
      }
      prev = { term: sg.segment.length > MAX_TERM ? sg.segment.slice(0, MAX_TERM) : sg.segment, start, end };
      out.push(prev);
    }
  }
  return out;
}

const HEXLIKE = /^[0-9a-f]+$/;
function idLike(t) {
  if (t.length >= 16 && HEXLIKE.test(t)) return true;
  if (t.length < 20) return false;
  let d = 0;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c >= 48 && c <= 57) d++; }
  return d / t.length >= 0.3;
}
const THAI_RUN = /[ก-๛]+/g;
export const GRAM = '';
const DROP_URL = new Set(['http', 'https', 'www']);

/**
 * Terms of a document: Map<term, fieldMask> (1 = title, 2 = url). Title/tags first (<= 48 terms), URL (<= 24).
 * Tab-group names (`tg`) are folded into the title field.
 */
export function docTerms(title, url, tagText) {
  const out = new Map();
  let tt = foldFast(String(title || '').slice(0, 300));
  if (tagText) tt += ' ' + foldFast(tagText);
  let n = 0;
  for (const tk of tokenize(tt)) {
    if (n >= 48) break;
    if (!out.has(tk.term)) n++;
    out.set(tk.term, (out.get(tk.term) || 0) | 1);
  }
  // Thai has no spaces: also index trigrams of every Thai run (marker ) so any substring of >= 3 letters is found
  let gn = 0;
  for (const m of tt.matchAll(THAI_RUN)) {
    const run = m[0];
    for (let i = 0; i + 3 <= run.length && gn < 64; i++) {
      const g = '' + run.substr(i, 3);
      if (!out.has(g)) gn++;
      out.set(g, 1);
    }
  }
  let u = foldFast(String(url || '').slice(0, 300)).replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/, '');
  n = 0;
  for (const tk of tokenize(u)) {
    if (n >= 24) break;
    if (DROP_URL.has(tk.term) || idLike(tk.term)) continue;
    if (!out.has(tk.term) || !(out.get(tk.term) & 2)) n++;
    out.set(tk.term, (out.get(tk.term) || 0) | 2);
  }
  return out;
}

// ---------- query ----------
const PHRASE_SPLIT = /"([^"]*)"|(\S+)/g;

/**
 * Query -> {tokens, phrases, excludes, site, group, raw}
 *   tokens   [{term, open, kinds, k, len}]  (AND-ed; the last unquoted token is "open" unless the raw query ends in space)
 *   phrases  [foldedString]                 (verified as substring of folded title+"\n"+url)
 *   excludes [term]                         (-word)
 *   site     folded host suffix | null,  group  folded group-name needle | null
 * kinds: allowed match kinds by token length (code points): 1 EQ,PRE; 2-3 +SUB; fuzzy k only from length 4.
 */
export function parseQuery(raw) {
  const q = { tokens: [], exactTokens: null, phrases: [], implicit: [], excludes: [], site: null, group: null, raw: String(raw || '') };
  const endsSpace = /\s$/.test(q.raw);
  const clauses = [];
  let m;
  PHRASE_SPLIT.lastIndex = 0;
  while ((m = PHRASE_SPLIT.exec(q.raw)) !== null) clauses.push(m[1] != null ? { phrase: m[1] } : { word: m[2] });
  let cid = 0;
  const thaiWhole = new Map();
  const addTokens = (folded, { open, phrase, urlOnly }) => {
    const toks = tokenize(folded);
    toks.forEach((tk, i) => {
      if (q.tokens.length >= 8) return;
      const isLast = i === toks.length - 1;
      const t = mkToken(tk.term, open && isLast, phrase);
      t.urlOnly = !!urlOnly;
      t.cid = cid;
      q.tokens.push(t);
    });
  };
  clauses.forEach((c, ci) => {
    cid = ci + 1;
    const lastClause = ci === clauses.length - 1;
    if (c.phrase != null) {
      const f = foldFast(c.phrase).trim();
      if (!f) return;
      q.phrases.push(f);
      addTokens(f, { open: false, phrase: true });
      return;
    }
    let w = c.word;
    if (w.length > 1 && w[0] === '-') {
      const f = foldFast(w.slice(1));
      for (const tk of tokenize(f)) q.excludes.push(tk.term);
      return;
    }
    const sm = /^(site|g):(.+)$/i.exec(w);
    if (sm) {
      const f = foldFast(sm[2]).trim();
      if (!f) return;
      if (sm[1].toLowerCase() === 'site') {
        q.site = f.replace(/^www\./, '');
        addTokens(q.site, { open: false, phrase: true, urlOnly: true });
      } else q.group = f;
      return;
    }
    const f = foldFast(w);
    const toks = tokenize(f);
    // separators inside a latin word ("hub.co") make an implicit phrase
    if (toks.length > 1 && /^[a-z0-9]/.test(f) && /[^\p{L}\p{N}\p{M}]/u.test(f) && !/[^\x00-\x7f]/.test(f)) q.phrases.push(f);
    // a Thai clause that segments into several words is a contiguous string: verified as a substring in the exact phase
    if (toks.length > 1 && /[ก-๛]/.test(f) && !/\s/.test(f)) { q.implicit.push(f); thaiWhole.set(cid, f); }
    addTokens(f, { open: lastClause && !endsSpace, phrase: false });
  });
  q.tokens = q.tokens.slice(0, 8);
  // exact phase: a contiguous Thai clause is ONE token (trigram route + substring verify); the fuzzy phase keeps the words
  if (thaiWhole.size) {
    const out = [];
    const done = new Set();
    for (const t of q.tokens) {
      if (!thaiWhole.has(t.cid)) { out.push(t); continue; }
      if (done.has(t.cid)) continue;
      done.add(t.cid);
      const w = mkToken(thaiWhole.get(t.cid), false, false);
      w.k = 0;
      w.subseq = false;
      w.cid = t.cid;
      out.push(w);
    }
    q.exactTokens = out;
  } else q.exactTokens = q.tokens;
  return q;
}

function mkToken(term, open, phrase) {
  const len = [...term].length;
  const t = { term, open: !!open && !phrase, len, sub: len >= 2, k: 0, subseq: false, urlOnly: false, thai: len >= 3 && /[ก-๛]/.test(term) };
  if (!phrase) {
    if (len >= 8) t.k = 2;
    else if (len >= 4) t.k = 1;
    t.subseq = len >= 4;
  }
  return t;
}

/** Fuzzy phase needed at all? (some token is long enough). */
export function hasFuzzy(q) {
  return q.tokens.some((t) => t.k > 0);
}

// ---------- highlighting ----------
/** Ranges [start, end) in ORIGINAL utf-16 offsets of the folded needles inside `original`. At most 8, merged. */
export function highlight(original, needles) {
  if (!original || !needles.length) return [];
  const { s, map } = fold(original);
  const spans = [];
  for (const nd of needles) {
    if (!nd) continue;
    let from = 0;
    for (let guard = 0; guard < 16; guard++) {
      const i = s.indexOf(nd, from);
      if (i < 0) break;
      spans.push([i, i + nd.length]);
      from = i + nd.length;
    }
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [a, b] of spans) {
    let oa;
    let ob;
    if (map) {
      oa = map[a];
      const lastOrig = map[b - 1];
      const cp = original.codePointAt(lastOrig);
      ob = lastOrig + (cp > 0xffff ? 2 : 1);
    } else { oa = a; ob = b; }
    const last = out[out.length - 1];
    if (last && oa <= last[1]) last[1] = Math.max(last[1], ob);
    else out.push([oa, ob]);
  }
  return out.slice(0, 8);
}
