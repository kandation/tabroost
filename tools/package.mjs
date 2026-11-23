#!/usr/bin/env node
// Build the Chrome Web Store upload zip for Tabroost.
//   node tools/package.mjs            -> dist/tabroost-<version>.zip
// Windows only (PowerShell + .NET ZipFile; Compress-Archive 5.1 writes backslash paths). Touches nothing except dist/ and one temp dir (removed at the end).
// Exit code 1 when a hard check fails (missing file, forbidden pattern, file > 10 MB, bad zip).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MAX_FILE = 10 * 1024 * 1024;

// ---- what ships -------------------------------------------------------------------------------------------------
// Root files: only these extensions (manifest.json is the only .json that ships from the root).
const ROOT_EXT = new Set(['.html', '.js', '.css']);
// Folders copied recursively (when present).
const SHIP_DIRS = ['lib', 'icons', '_locales', 'workers', 'locales', 'fonts', 'assets'];
// Never ship, at any depth.
const EXCLUDE_DIRS = new Set(['tests', 'test', 'tools', 'dev', 'docs', 'store-assets', 'fullpage-screenshot', 'node_modules',
  '.git', '.github', '.vscode', '.idea', 'dist', 'bench', 'scratch', 'scratchpad', 'tmp', 'temp', 'graphify-out', '.claude']);
const EXCLUDE_FILE = [/\.map$/i, /\.md$/i, /^package(-lock)?\.json$/i, /^\.git/i, /\.log$/i, /\.zip$/i, /\.bak$/i, /~$/,
  /\.orig$/i, /\.rej$/i, /\.tmp$/i, /^thumbs\.db$/i, /^\.ds_store$/i, /\.test\.[cm]?js$/i, /\.spec\.[cm]?js$/i, /\.bench\.[cm]?js$/i,
  /^(scratch|tmp|temp)[-_.]/i, /\.psd$/i, /\.ai$/i];

// Licence and notice files that ship in the zip root even though *.md files are excluded elsewhere (the licences ask for the notices to travel with the code).
const NOTICE_FILES = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'];

const problems = []; // hard failures
const warnings = [];
const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const excludedFile = (name) => EXCLUDE_FILE.some((re) => re.test(name));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name.toLowerCase())) walk(full, out); }
    else if (e.isFile() && !excludedFile(e.name)) out.push(full);
  }
  return out;
}

function collect() {
  const files = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isFile() || excludedFile(e.name)) continue;
    if (e.name === 'manifest.json' || ROOT_EXT.has(path.extname(e.name).toLowerCase())) files.push(path.join(ROOT, e.name));
  }
  for (const n of NOTICE_FILES) { const full = path.join(ROOT, n); if (fs.existsSync(full)) files.push(full); }
  for (const d of SHIP_DIRS) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full, files);
  }
  return files;
}

// ---- reference crawl --------------------------------------------------------------------------------------------
function localRef(from, ref) {
  if (!ref || /^(https?:|data:|blob:|chrome|mailto:|#|\/\/)/i.test(ref)) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  return clean.startsWith('/') ? path.join(ROOT, clean) : path.resolve(path.dirname(from), clean);
}

function refsOf(file) {
  const ext = path.extname(file).toLowerCase();
  const txt = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const add = (r) => { const p = localRef(file, r); if (p) out.add(p); };
  let m;
  if (ext === '.html') {
    const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    while ((m = re.exec(txt))) { if (!/^\s*#/.test(m[1])) add(m[1]); }
  } else if (ext === '.js') {
    const re1 = /\bimport\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/g; // static import / export-from
    const re2 = /\bexport\s*[^'"();]*?\bfrom\s*["']([^"']+)["']/g;
    const re3 = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g; // dynamic
    const re4 = /new\s+(?:Shared)?Worker\s*\(\s*["']([^"']+)["']/g;
    const re5 = /importScripts\s*\(\s*["']([^"']+)["']/g;
    for (const re of [re1, re2, re3, re4, re5]) { while ((m = re.exec(txt))) { if (/^[./]/.test(m[1]) || /\.(m?js|html|css|json)$/.test(m[1])) add(m[1]); } }
    const re6 = /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;
    while ((m = re6.exec(txt))) add(m[1]);
  } else if (ext === '.css') {
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    while ((m = re.exec(txt))) add(m[1]);
  }
  return [...out];
}

function manifestRefs(manifest) {
  const r = new Set();
  const add = (v) => { if (typeof v === 'string' && v) r.add(v.replace(/^\//, '')); };
  const walkIcons = (o) => { if (typeof o === 'string') add(o); else if (o && typeof o === 'object') Object.values(o).forEach(walkIcons); };
  add(manifest.background && manifest.background.service_worker);
  walkIcons(manifest.icons);
  if (manifest.action) { add(manifest.action.default_popup); walkIcons(manifest.action.default_icon); }
  if (manifest.browser_action) { add(manifest.browser_action.default_popup); walkIcons(manifest.browser_action.default_icon); }
  if (manifest.options_ui) add(manifest.options_ui.page);
  add(manifest.options_page);
  add(manifest.side_panel && manifest.side_panel.default_path);
  add(manifest.chrome_url_overrides && Object.values(manifest.chrome_url_overrides)[0]);
  for (const cs of manifest.content_scripts || []) { (cs.js || []).forEach(add); (cs.css || []).forEach(add); }
  for (const w of manifest.web_accessible_resources || []) (w.resources || []).forEach((x) => { if (!/[*]/.test(x)) add(x); });
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return [...r];
}

// ---- content scan -----------------------------------------------------------------------------------------------
function scan(files) {
  const forbidden = [
    [/(^|[^\w.$])eval\s*\(/, 'eval('],
    [/\bnew\s+Function\s*\(/, 'new Function('],
    [/<script[^>]+\bsrc\s*=\s*["']?\s*(https?:)?\/\//i, 'remote <script src>'],
    [/\bimportScripts\s*\(\s*["']\s*(https?:)?\/\//, 'remote importScripts'],
    [/\bimport\s*\(\s*["']\s*(https?:)?\/\//, 'remote dynamic import'],
    [/\bfrom\s+["']https?:\/\//, 'remote ES import'],
    [/\bsetTimeout\s*\(\s*["'`]/, 'setTimeout with string'],
    [/\bsetInterval\s*\(\s*["'`]/, 'setInterval with string'],
  ];
  const soft = [
    [/\.innerHTML\s*\+?=(?!=)/, 'innerHTML ='],
    [/\.outerHTML\s*=(?!=)/, 'outerHTML ='],
    [/\binsertAdjacentHTML\s*\(/, 'insertAdjacentHTML('],
    [/\bdocument\.write\s*\(/, 'document.write('],
    [/\bfetch\s*\(/, 'fetch('],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bnew\s+WebSocket\b/, 'WebSocket'],
    [/\bnavigator\.sendBeacon\b/, 'sendBeacon'],
  ];
  const warnMap = new Map();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== '.js' && ext !== '.html') continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // pure comment lines
      for (const [re, label] of forbidden) if (re.test(line)) fail(`forbidden pattern "${label}" at ${rel(f)}:${i + 1}`);
      for (const [re, label] of soft) if (re.test(line)) {
        const k = label; if (!warnMap.has(k)) warnMap.set(k, []);
        warnMap.get(k).push(`${rel(f)}:${i + 1}`);
      }
    });
  }
  return warnMap;
}

// ---- zip verification (reads the central directory, no external tools) -------------------------------------------
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, size });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB');

// ---- main -------------------------------------------------------------------------------------------------------
function main() {
  // --list: print the files that would ship (one per line) and stop. No zip, no staging, any platform. Used by tests/about-test.mjs.
  if (process.argv.includes('--list')) {
    for (const f of collect().map(rel).sort()) console.log(f);
    for (const n of NOTICE_FILES) if (!fs.existsSync(path.join(ROOT, n))) console.error('missing notice file: ' + n);
    process.exit(0);
  }
  if (process.platform !== 'win32') { console.error('This script needs Windows PowerShell (PowerShell).'); process.exit(1); }
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version;
  if (!/^\d+(\.\d+){0,3}$/.test(version || '')) fail(`manifest version "${version}" is not 1-4 dot-separated integers`);
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (!manifest.minimum_chrome_version) warn('manifest has no minimum_chrome_version');
  if ((manifest.description || '').length > 132) fail(`manifest description is ${manifest.description.length} chars (store limit 132)`);
  if ((manifest.name || '').length > 75) fail('manifest name is longer than 75 chars');

  const files = collect();
  for (const n of NOTICE_FILES) { const p = path.join(ROOT, n); if (!fs.existsSync(p)) fail(`${n} is missing; it must be in the zip root`); else if (/{{[A-Z_]+}}/.test(fs.readFileSync(p, 'utf8'))) warn(`${n} still has a {{PLACEHOLDER}}; fill it before uploading`); }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tabroost-stage-'));
  let zipPath = null;
  try {
    const staged = [];
    for (const f of files) {
      const r = rel(f);
      const dest = path.join(stage, r);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      staged.push({ rel: r, size: fs.statSync(f).size });
    }
    staged.sort((a, b) => a.rel.localeCompare(b.rel));
    const stagedSet = new Set(staged.map((s) => s.rel));

    // 1. manifest-referenced files exist in staging
    for (const r of manifestRefs(manifest)) if (!stagedSet.has(r)) fail(`manifest references "${r}" but it is not in the package`);

    // 2. crawl references from manifest roots through html/js/css
    const reached = new Set();
    const queue = manifestRefs(manifest).map((r) => path.join(ROOT, r));
    while (queue.length) {
      const f = queue.pop();
      const r = rel(f);
      if (reached.has(r)) continue;
      reached.add(r);
      if (!stagedSet.has(r)) { if (fs.existsSync(f)) warn(`referenced but excluded from package: ${r}`); else fail(`referenced file does not exist: ${r}`); continue; }
      if (/\.(html|js|css)$/i.test(f)) for (const ref of refsOf(f)) queue.push(ref);
    }
    // popup.html is opened by code (iconClickAction) not via manifest: crawl all shipped root pages too
    for (const s of staged) if (/^[^/]+\.html$/.test(s.rel) && !reached.has(s.rel)) {
      reached.add(s.rel);
      const q = refsOf(path.join(ROOT, s.rel));
      while (q.length) {
        const f = q.pop(); const r = rel(f);
        if (reached.has(r)) continue; reached.add(r);
        if (!stagedSet.has(r)) { if (!fs.existsSync(f)) fail(`referenced file does not exist: ${r} (from ${s.rel})`); continue; }
        if (/\.(html|js|css)$/i.test(f)) q.push(...refsOf(f));
      }
    }
    const unreached = staged.filter((s) => !reached.has(s.rel) && !/^icons\//.test(s.rel) && s.rel !== 'manifest.json' && !/^_locales\//.test(s.rel));
    for (const u of unreached) warn(`shipped but not reachable from manifest/HTML (dead file? or loaded dynamically): ${u.rel}`);

    // 3. size + content checks
    for (const s of staged) if (s.size > MAX_FILE) fail(`file larger than 10 MB: ${s.rel} (${fmt(s.size)})`);
    const warnMap = scan(staged.map((s) => path.join(ROOT, s.rel)));

    // 4. zip
    fs.mkdirSync(DIST, { recursive: true });
    zipPath = path.join(DIST, `tabroost-${version}.zip`);
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
    // Compress-Archive in Windows PowerShell 5.1 writes backslash entry names, so the .NET ZipArchive API is driven from PowerShell instead.
    const q = (x) => x.replace(/'/g, "''");
    // Entries are added one by one with forward-slash names (both Compress-Archive and ZipFile.CreateFromDirectory wrote backslashes on this setup).
    const cmd = [
      'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
      "$stage = '" + q(stage) + "'; $zipPath = '" + q(zipPath) + "'",
      '$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)',
      'try { Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {',
      "  $name = $_.FullName.Substring($stage.Length).TrimStart([char]92).Replace([string][char]92, '/')",
      '  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal)',
      '} } finally { $zip.Dispose() }',
    ].join('; ');
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    if (ps.status !== 0 || !fs.existsSync(zipPath)) { fail(`zip creation failed: ${(ps.stderr || ps.stdout || '').trim()}`); }
    else {
      const entries = readZipEntries(zipPath).filter((e) => !e.name.endsWith('/'));
      if (!entries.some((e) => e.name === 'manifest.json')) fail('manifest.json is not at the zip root');
      const bs = entries.filter((e) => e.name.includes('\\'));
      if (bs.length) fail(`zip entry names contain backslashes, e.g. "${bs[0].name}". Repack with a newer PowerShell (pwsh) or 7-Zip.`);
      const zs = new Set(entries.map((e) => e.name));
      for (const s of staged) if (!zs.has(s.rel)) fail(`missing from zip: ${s.rel}`);
      if (entries.length !== staged.length) warn(`zip has ${entries.length} files, staging had ${staged.length}`);
      const zsize = fs.statSync(zipPath).size;
      console.log(`\nFiles in ${path.basename(zipPath)} (${entries.length}):`);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) console.log(`  ${String(e.size).padStart(9)}  ${e.name}`);
      console.log(`\nZip: ${zipPath}\nZip size: ${fmt(zsize)}   Uncompressed: ${fmt(entries.reduce((a, e) => a + e.size, 0))}   (store upload limit is about 2 GB; verify on the dashboard)`);
    }

    // 5. summary
    console.log(`\nExtension: ${manifest.name} ${version}   permissions: ${(manifest.permissions || []).join(', ') || '-'}   hosts: ${(manifest.host_permissions || []).join(', ') || '-'}   optional: ${(manifest.optional_permissions || []).concat(manifest.optional_host_permissions || []).join(', ') || '-'}`);
    if (warnMap.size) {
      console.log('\nWarnings (review, not blocking):');
      for (const [k, v] of warnMap) console.log(`  ${k}: ${v.length} place(s)${v.length <= 4 ? ' -> ' + v.join(', ') : ' (first: ' + v.slice(0, 3).join(', ') + ' ...)'}`);
    }
    if (warnings.length) { console.log('\nNotes:'); for (const w of warnings) console.log('  - ' + w); }
    if (problems.length) {
      console.log('\nFAILED:'); for (const p of problems) console.log('  x ' + p);
      if (zipPath && fs.existsSync(zipPath)) console.log('\nThe zip was written but must NOT be uploaded until the failures above are fixed.');
    } else console.log('\nOK: all checks passed. Still do the manual checklist before uploading.');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  process.exit(problems.length ? 1 : 0);
}

main();
