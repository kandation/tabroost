#!/usr/bin/env node
// Pre-publish audit for a PUBLIC repository. Read-only: it only reports, it never edits.
//   node tools/audit-repo.mjs            (exit code 1 when any HIGH finding exists)
//   node tools/audit-repo.mjs --all      (also scan files ignored by .gitignore; default: respects a simple subset)
// Scans the working tree (skips dist/, node_modules/, .git/). Run it again right before `git add`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.resolve(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['dist', 'node_modules', '.git']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '.svg', '.xml', '.toml', '.cfg', '.ini', '.ndjson', '.csv', '.ps1', '.sh', '.bat', '.cmd', '.env', '']);
const BIG = 5 * 1024 * 1024;
const MAX_TEXT = 3 * 1024 * 1024;

// Built from pieces so this file does not flag itself.
const DEV_EMAIL = ['akkhaporn', '2559', '@', 'gmail', '.com'].join('');
const OK_EMAIL = /(@example\.(com|org)|noreply@|@users\.noreply\.github\.com|you@|name@|user@|email@|support@example)/i;

const findings = []; // {sev, kind, file, line, text}
const add = (sev, kind, file, line, text) => findings.push({ sev, kind, file: path.relative(ROOT, file).split(path.sep).join('/'), line, text: String(text || '').slice(0, 140) });

const RULES = [
  { sev: 'HIGH', kind: 'developer email', re: new RegExp(DEV_EMAIL.replace(/\./g, '\\.'), 'i') },
  { sev: 'HIGH', kind: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { sev: 'HIGH', kind: 'token/key pattern', re: /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,}|sk-ant-[A-Za-z0-9_-]{20,})\b/ },
  { sev: 'HIGH', kind: 'secret assignment', re: /\b(api[_-]?key|secret|passwd|password|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i },
  { sev: 'HIGH', kind: 'Windows user path', re: /\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|<|\{|YOU|you\b|name\b|USERNAME|%)[^\\/\s'"`<>]+/i },
  { sev: 'HIGH', kind: 'unix home path', re: /(^|[\s'"(=])\/(Users|home)\/(?!you\b|name\b|user\b|runner\b|<)[a-z0-9._-]+\//i },
  { sev: 'MED', kind: 'local project path', re: /\b[A-Za-z]:[\\/]+projects[\\/]/i },
  { sev: 'MED', kind: 'scratchpad / temp path', re: /(scratchpad[\\/]|AppData[\\/]+Local[\\/]+Temp|[\\/]claude[\\/][0-9a-f]{8,})/i },
  { sev: 'MED', kind: 'profile dir reference', re: /\b(prof-[a-z0-9]{3,}|cmr-(prof|test|tmp|chrome)[a-z0-9_-]*)\b/i },
  { sev: 'MED', kind: 'other email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, extra: (m) => !OK_EMAIL.test(m[0]) && !/\.(png|jpg|svg|webp|js|css)$/i.test(m[0]) && !/^@/.test(m[0]) },
  { sev: 'LOW', kind: 'TODO/FIXME/XXX', re: /\b(TODO|FIXME|XXX|HACK)\b/ },
];

const BAD_DIR = [/^prof-/i, /^cmr-(prof|test|tmp|chrome|profile)/i, /^scratch/i, /^\.claude$/i, /^graphify-out$/i, /^\.vscode$/i, /^\.idea$/i, /^coverage$/i, /^profile/i, /^user-data/i, /^chrome-profile/i];
const BAD_FILE = [/\.log$/i, /\.(pem|key|p12|pfx|crt)$/i, /^\.env(\..*)?$/i, /^claude\.md$/i, /^\.claude/i, /\.(sqlite|sqlite3|db|ldb)$/i, /^thumbs\.db$/i, /^\.ds_store$/i, /\.zip$/i, /\.crx$/i, /\.pem$/i, /^npm-debug/i, /\.heapsnapshot$/i, /\.cpuprofile$/i];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (BAD_DIR.some((r) => r.test(e.name))) add('HIGH', 'directory that should not be committed', full, 0, e.name + '/ (add to .gitignore or delete)');
      yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}

let nFiles = 0;
for (const file of walk(ROOT)) {
  nFiles++;
  const name = path.basename(file);
  const st = fs.statSync(file);
  if (st.size > BIG) add('HIGH', 'large file > 5 MB', file, 0, `${(st.size / 1048576).toFixed(1)} MB`);
  if (BAD_FILE.some((r) => r.test(name))) add('HIGH', 'file type that should not be committed', file, 0, name);
  if (file === SELF) continue;
  if (!TEXT_EXT.has(path.extname(name).toLowerCase()) || st.size > MAX_TEXT) continue;
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (txt.includes('\u0000')) continue;
  const lines = txt.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 4000) return; // minified / data blob
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m && (!r.extra || r.extra(m))) add(r.sev, r.kind, file, i + 1, line.trim());
    }
  });
}

// ---- debug-only message handlers must be gated by installType === 'development' -------------------------------------
const debugReport = [];
for (const file of walk(ROOT)) {
  if (!/\.(js|mjs)$/.test(file) || file === SELF) continue;
  const rp = path.relative(ROOT, file).split(path.sep).join('/');
  if (/^(tests|dev|bench|tools|fullpage-screenshot|store-assets|docs)\//.test(rp)) continue; // not shipped
  const txt = fs.readFileSync(file, 'utf8');
  const hasDebug = /['"`]debug:[a-zA-Z_]+['"`]/.test(txt);
  if (!hasDebug) continue;
  const gated = /installType\s*===?\s*['"]development['"]/.test(txt) || /\bisDev\s*\(/.test(txt);
  const lines = txt.split(/\r?\n/);
  const first = lines.findIndex((l) => /['"`]debug:[a-zA-Z_]+['"`]/.test(l)) + 1;
  debugReport.push({ file: rp, line: first, gated, devFn: /function\s+isDev|isDev\s*=/.test(txt) && /installType/.test(txt) });
  if (!gated) add('HIGH', 'debug handler without installType gate', file, first, 'debug: message found but no installType === development check in this file');
}

// ---- internal docs that may leak the private workflow ----------------------------------------------------------------
const internalDocs = [];
const docsDir = path.join(ROOT, 'docs');
if (fs.existsSync(docsDir)) for (const f of fs.readdirSync(docsDir)) if (/^spec-.*\.md$/i.test(f)) internalDocs.push('docs/' + f);

// ---- .gitignore sanity -------------------------------------------------------------------------------------------------
const gi = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : null;
if (gi === null) add('HIGH', '.gitignore missing', path.join(ROOT, '.gitignore'), 0, 'create .gitignore before the first commit');
else for (const need of ['node_modules', 'dist', '*.log']) if (!gi.includes(need)) add('MED', '.gitignore lacks entry', path.join(ROOT, '.gitignore'), 0, need);
if (!fs.existsSync(path.join(ROOT, 'LICENSE'))) add('MED', 'LICENSE file missing', path.join(ROOT, 'LICENSE'), 0, 'public repo should have a LICENSE');

// ---- report --------------------------------------------------------------------------------------------------------------
const order = { HIGH: 0, MED: 1, LOW: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
const counts = { HIGH: 0, MED: 0, LOW: 0 };
for (const f of findings) counts[f.sev]++;
console.log(`Scanned ${nFiles} files under ${ROOT}\n`);
let lastKind = '';
for (const f of findings) {
  const head = `[${f.sev}] ${f.kind}`;
  if (head !== lastKind) { console.log('\n' + head); lastKind = head; }
  console.log(`  ${f.file}${f.line ? ':' + f.line : ''}  ${f.text}`);
}
console.log('\nDebug-only message handlers (shipped code):');
if (!debugReport.length) console.log('  none found');
for (const d of debugReport) console.log(`  ${d.gated ? 'gated  ' : 'NOT GATED'} ${d.file}:${d.line}${d.devFn ? '  (isDev() uses installType)' : ''}`);
if (internalDocs.length) {
  console.log('\nInternal spec docs found (review them for personal paths/notes; consider moving to a folder listed in .gitignore, or docs/internal after review):');
  for (const d of internalDocs) console.log('  ' + d);
}
console.log(`\nSummary: HIGH ${counts.HIGH}, MED ${counts.MED}, LOW ${counts.LOW}. ${counts.HIGH ? 'Do NOT publish yet.' : 'No HIGH findings; still review MED items by hand.'}`);
process.exit(counts.HIGH ? 1 : 0);
