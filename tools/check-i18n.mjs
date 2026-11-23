// i18n audit (pure node, no Chrome). Run: node tools/check-i18n.mjs
//  (a) every Thai key table has an English twin with the same keys, nesting and function arity;
//      every data-s / data-sa / data-sp / data-st key used by an HTML page exists in both languages;
//      _locales/th and _locales/en define the same message keys.
//  (b) Thai characters (U+0E00-U+0E7F) in shipped JS/HTML/CSS that are NOT inside a registered Thai table
//      are listed as file:line. Comments are ignored. A line (or the comment line right before it) that carries
//      "i18n-allow: reason" is skipped on purpose. Exit 1 when anything is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THAI = /[฀-๿]/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'knowledge', 'store-assets', 'site', 'docs', 'bench', 'dev', 'fullpage-screenshot', 'tests', 'tools', '_locales', '.github', 'icons']);
// Files whose Thai is the point (Thai word segmentation / normalisation rules).
const FILE_ALLOW = new Map([
  ['lib/searchNorm.js', 'Thai text normalisation and segmentation rules'],
]);

// Thai tables: [label, [file, declaration name], [file, English declaration name]].
const PAIRS = [
  ['stash page', ['stash.js', 'STR'], ['lib/i18n.js', 'EN']],
  ['popup', ['popup.js', 'STR'], ['lib/popstr.js', 'POP_EN']],
  ['lock', ['lib/lockstr.js', 'LOCK_TH'], ['lib/i18n.js', 'LOCK_EN']],
  ['about', ['lib/aboutstr.js', 'TH'], ['lib/aboutstr.js', 'EN']],
  ['policy', ['lib/aboutstr.js', 'POLICY_TH'], ['lib/aboutstr.js', 'POLICY_EN']],
  ['selection', ['lib/selstr.js', 'TH'], ['lib/selstr.js', 'EN']],
  ['sync', ['lib/syncui.js', 'T_TH'], ['lib/syncui.js', 'T_EN']],
  ['dashboard', ['lib/dashstr.js', 'TH'], ['lib/dashstr.js', 'EN']],
  ['filter', ['lib/filterstr.js', 'TH'], ['lib/filterstr.js', 'EN']],
  ['permissions', ['lib/permsui.js', 'TH'], ['lib/permsui.js', 'EN']],
  ['group labels', ['lib/query.js', 'L'], ['lib/i18n.js', 'EN_L']],
  ['time units', ['lib/time.js', 'TH_U'], ['lib/time.js', 'EN_U']],
  ['service worker', ['lib/constants.js', 'STR_SW'], ['lib/swstr.js', 'STR_SW_EN']],
];
const INLINE_BOTH = [['lib/lock/strings.js', 'STR']]; // { key: { th, en } }
const OTHER_TABLE_RANGES = [['lib/aboutstr.js', 'POLICY_NOTE'], ['lib/query.js', 'WD'], ['lib/aboutinfo.js', 'NOTICES'], ['lib/aboutinfo.js', 'INFO']];
const TABLE_RANGES = [...PAIRS.map((p) => p[1]), ...PAIRS.map((p) => p[2]), ...INLINE_BOTH, ...OTHER_TABLE_RANGES];

const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const problems = [];
const add = (loc, msg) => problems.push(`${loc}  ${msg}`);

// ---------- tiny JS scanner: finds the extent of `const NAME = {...}` / `[...]` and masks comments ----------
function scanJs(text) {
  const n = text.length; const mask = new Uint8Array(n); const close = new Map();
  const stack = [];
  let i = 0; let lastSig = '';
  const regexOk = () => lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig);
  function scanTemplate(start) {
    let j = start;
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '`') return j + 1;
      if (text[j] === '$' && text[j + 1] === '{') {
        let depth = 1; j += 2;
        while (j < n && depth) {
          const ch = text[j];
          if (ch === '`') { j = scanTemplate(j + 1); continue; }
          if (ch === '\'' || ch === '"') { let k = j + 1; while (k < n && text[k] !== ch && text[k] !== '\n') { if (text[k] === '\\') k++; k++; } j = k + 1; continue; }
          if (ch === '{') depth++; else if (ch === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  }
  while (i < n) {
    const c = text[i]; const d = text[i + 1];
    if (c === '/' && d === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; mask.fill(1, i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; mask.fill(1, i, end); i = end; continue; }
    if (c === '\'' || c === '"') { let j = i + 1; while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; } i = j + 1; lastSig = 'x'; continue; }
    if (c === '`') { i = scanTemplate(i + 1); lastSig = 'x'; continue; }
    if (c === '/' && regexOk()) {
      let j = i + 1; let cls = false;
      while (j < n && text[j] !== '\n') { if (text[j] === '\\') j++; else if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; else if (text[j] === '/' && !cls) break; j++; }
      if (text[j] === '/') { i = j + 1; while (/[a-z]/i.test(text[i] || '')) i++; lastSig = 'x'; continue; }
    }
    if (c === '{' || c === '[' || c === '(') stack.push(i);
    if (c === '}' || c === ']' || c === ')') { const o = stack.pop(); if (o !== undefined) close.set(o, i); }
    if (!/\s/.test(c)) lastSig = /[A-Za-z0-9_$)\]]/.test(c) ? 'x' : c;
    i++;
  }
  return { mask, close };
}

const cache = new Map();
function info(f) { if (!cache.has(f)) { const t = rd(f); cache.set(f, { text: t, ...scanJs(t) }); } return cache.get(f); }
function declRange(f, name) {
  if (!fs.existsSync(path.join(ROOT, f))) return null;
  const { text, close } = info(f);
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*([\\[{])`);
  const m = re.exec(text); if (!m) return null;
  const open = m.index + m[0].length - 1; const end = close.get(open);
  return end == null ? null : { open, end };
}
function evalTable(f, name) {
  const r = declRange(f, name); if (!r) return null;
  const src = info(f).text.slice(r.open, r.end + 1);
  try { const wd = name !== 'WD' && declRange(f, 'WD') ? evalTable(f, 'WD') : [];
    return new Function('th', 'WD', `return (${src});`)((n) => Number(n).toLocaleString('th-TH'), wd); } catch (e) { add(f, `cannot evaluate table ${name}: ${e.message}`); return null; }
}

// ---------- (a) parity ----------
const EN_THAI_OK = new Set(['langs.th']); // the language picker shows each language in its own script
function compare(a, b, where, loc) {
  if (a && typeof a === 'object' && !Array.isArray(a)) for (const k of Object.keys(a)) if (!/^[ -~]+$/.test(k)) add(loc, `${where}: key "${k}" is not ASCII`);
  if (typeof a === 'function' || typeof b === 'function') {
    if (typeof a !== typeof b) add(loc, `${where}: Thai is ${typeof a}, English is ${typeof b}`);
    else if (a.length !== b.length) add(loc, `${where}: function arity differs (th ${a.length}, en ${b.length})`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) add(loc, `${where}: array vs non-array`);
    else if (a.length !== b.length) add(loc, `${where}: array length differs (th ${a.length}, en ${b.length})`);
    return;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') { add(loc, `${where}: English is not an object`); return; }
    for (const k of Object.keys(a)) { if (!(k in b)) add(loc, `${where}.${k}: missing in English`); else compare(a[k], b[k], `${where}.${k}`, loc); }
    for (const k of Object.keys(b)) if (!(k in a)) add(loc, `${where}.${k}: English key with no Thai twin`);
    return;
  }
  if (typeof a !== typeof b) add(loc, `${where}: type differs (th ${typeof a}, en ${typeof b})`);
  else if (typeof a === 'string') {
    const ph = (s) => (s.match(/\{[A-Za-z0-9_]+\}|%[sd]|\$\{[^}]+\}/g) || []).sort().join(',');
    if (ph(a) !== ph(b)) add(loc, `${where}: placeholders differ (th ${ph(a)}, en ${ph(b)})`);
    if (a !== '' && b === '') add(loc, `${where}: English is empty`);
    if (THAI.test(b) && !EN_THAI_OK.has(where.split('.').slice(1).join('.'))) add(loc, `${where}: English text contains Thai`);
  }
}

for (const [label, [tf, tn], [ef, en]] of PAIRS) {
  const th = evalTable(tf, tn); const e = evalTable(ef, en);
  if (!th) { add(tf, `[${label}] Thai table ${tn} not found`); continue; }
  if (!e) { add(ef, `[${label}] English table ${en} not found`); continue; }
  compare(th, e, label, `${ef} (${en})`);
}
for (const [f, name] of INLINE_BOTH) {
  const t = evalTable(f, name); if (!t) { add(f, `table ${name} not found`); continue; }
  for (const [k, v] of Object.entries(t)) { if (!v || !v.th || !v.en) add(f, `${name}.${k}: needs both th and en`); else if (THAI.test(v.en)) add(f, `${name}.${k}: English text contains Thai`); }
}
// about info: inline { th, en } pairs, every Thai line needs an English twin
{
  const f = 'lib/aboutinfo.js'; const { text, mask } = info(f); const lines = text.split(/\r?\n/);
  const objs = []; // collect `th:`/`en:` property counts per source
  const thN = (text.match(/\bth:\s*['"`]/g) || []).length; const enN = (text.match(/\ben:\s*['"`]/g) || []).length;
  if (thN !== enN) add(f, `${thN} th: strings but ${enN} en: strings`);
  void objs; void lines; void mask;
}
// data-s* keys in HTML
const HTML_TABLES = { 'stash.html': ['stash.js', 'STR', 'lib/i18n.js', 'EN'], 'popup.html': ['popup.js', 'STR', 'lib/popstr.js', 'POP_EN'] };
for (const [h, [tf, tn, ef, en]] of Object.entries(HTML_TABLES)) {
  const th = evalTable(tf, tn); const e = evalTable(ef, en); if (!th || !e) continue;
  rd(h).split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/data-(?:s|sa|sp|st)="([A-Za-z0-9_.]+)"/g)) {
      const k = m[1];
      if (!(k in th)) add(`${h}:${i + 1}`, `data key "${k}" missing from the Thai table`);
      else if (!(k in e)) add(`${h}:${i + 1}`, `data key "${k}" missing from the English table`);
    }
  });
}
// _locales + manifest
{
  const a = JSON.parse(rd('_locales/th/messages.json')); const b = JSON.parse(rd('_locales/en/messages.json'));
  for (const k of Object.keys(a)) if (!(k in b)) add('_locales/en/messages.json', `message "${k}" missing`);
  for (const k of Object.keys(b)) if (!(k in a)) add('_locales/th/messages.json', `message "${k}" missing`);
  for (const [k, v] of Object.entries(b)) if (THAI.test(v.message) || THAI.test(v.description || '')) add('_locales/en/messages.json', `message "${k}" contains Thai`);
  const man = JSON.parse(rd('manifest.json'));
  for (const u of JSON.stringify(man).match(/__MSG_([A-Za-z0-9_]+)__/g) || []) { const k = u.slice(6, -2); if (!(k in b) || !(k in a)) add('manifest.json', `uses ${u} which is not in both catalogues`); }
  if (THAI.test(JSON.stringify(man))) add('manifest.json', 'Thai text in the manifest (use __MSG_ keys)');
  if (man.default_locale !== 'en') add('manifest.json', 'default_locale should be en');
}

// ordering guard: the language must be applied before the first render that reads STR (a banner once showed Thai in the English UI)
{
  const { text } = info('stash.js');
  const body = (name) => { const i = text.indexOf(`function ${name}(`); return i < 0 ? '' : text.slice(i, text.indexOf('\n}\n', i)); };
  const before = (name, a, b) => { const s = body(name); const ia = s.indexOf(a); const ib = s.indexOf(b); if (ia < 0 || (ib >= 0 && ia > ib)) add('stash.js', `${name}() must call ${a} before ${b}`); };
  before('loadData', 'applyLang(', 'recompute(');
  before('init', 'applyLang(', 'applyStrings(');
}

// ---------- (b) hard-coded Thai outside the tables ----------
function* walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(rel); } else if (/\.(js|mjs|html|css)$/.test(e.name)) yield rel;
  }
}
const lineStarts = (t) => { const s = [0]; for (let i = 0; i < t.length; i++) if (t[i] === '\n') s.push(i + 1); return s; };
let scanned = 0; let thaiFiles = 0;
for (const f of walk('')) {
  if (FILE_ALLOW.has(f)) continue;
  const isJs = /\.(js|mjs)$/.test(f); const isHtml = f.endsWith('.html'); const isCss = f.endsWith('.css');
  const text = rd(f); scanned++;
  if (THAI.test(text)) thaiFiles++;
  else if (!/th-TH/.test(text)) continue;
  const lines = text.split(/\r?\n/); const starts = lineStarts(text);
  let mask = null; const tableSpans = [];
  if (isJs) {
    mask = info(f).mask;
    for (const [tf, tn] of TABLE_RANGES) if (tf === f) { const r = declRange(f, tn); if (r) tableSpans.push([r.open, r.end]); }
  }
  const comments = [];
  if (isHtml) for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) comments.push([m.index, m.index + m[0].length]);
  if (isCss) for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) comments.push([m.index, m.index + m[0].length]);
  if (isJs) {
    // Thai-formatted dates/numbers outside the Thai tables: 'th-TH' must be chosen by the language, never hard-coded
    for (let li = 0; li < lines.length; li++) {
      const m = /['"`]th-TH['"`]/.exec(lines[li]); if (!m) continue;
      const pos = starts[li] + m.index;
      if (mask[pos] || tableSpans.some(([a, b]) => pos >= a && pos <= b)) continue;
      if (/i18n-allow:/.test(lines[li]) || (li > 0 && /i18n-allow:/.test(lines[li - 1])) || /en-US/.test(lines[li])) continue;
      add(`${f}:${li + 1}`, "hard-coded 'th-TH' locale (pick it from the language): " + lines[li].trim().slice(0, 110));
    }
  }
  for (let li = 0; li < lines.length; li++) {
    if (!THAI.test(lines[li])) continue;
    if (/i18n-allow:/.test(lines[li]) || (li > 0 && /i18n-allow:/.test(lines[li - 1]))) continue;
    let hit = false; let inComment = false;
    for (let k = 0; k < lines[li].length; k++) {
      if (!THAI.test(lines[li][k])) continue;
      const pos = starts[li] + k;
      if ((mask && mask[pos]) || comments.some(([a, b]) => pos >= a && pos < b)) { inComment = true; continue; }
      if (tableSpans.some(([a, b]) => pos >= a && pos <= b)) continue;
      hit = true; break;
    }
    if (inComment && !hit) add(`${f}:${li + 1}`, 'Thai in a code comment (write comments in English): ' + lines[li].trim().slice(0, 110));
    if (hit) add(`${f}:${li + 1}`, 'hard-coded Thai: ' + lines[li].trim().slice(0, 110));
  }
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\ncheck-i18n: ${problems.length} problem(s) in ${scanned} files scanned (${thaiFiles} contain Thai).`);
  process.exit(1);
}
console.log(`check-i18n: OK (${scanned} files scanned, ${PAIRS.length + INLINE_BOTH.length} Thai/English table pairs matched, ${thaiFiles} files contain Thai only inside tables).`);
