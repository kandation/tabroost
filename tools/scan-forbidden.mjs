#!/usr/bin/env node
// Cross-platform scan of the shippable JS/HTML for patterns the Chrome Web Store does not allow
// (eval, new Function, remote scripts/imports). Used by CI; tools/package.mjs runs the same rules on the staged files.
//   node tools/scan-forbidden.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['tests', 'tools', 'dev', 'docs', 'store-assets', 'fullpage-screenshot', 'node_modules', '.git', '.github', 'bench', 'dist', 'site']);
const BAD = [
  [/(^|[^\w.$])eval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/<script[^>]+\bsrc\s*=\s*["']?\s*(https?:)?\/\//i, 'remote <script src>'],
  [/\bimportScripts\s*\(\s*["']\s*(https?:)?\/\//, 'remote importScripts'],
  [/\bimport\s*\(\s*["']\s*(https?:)?\/\//, 'remote import()'],
  [/\bfrom\s+["']https?:\/\//, 'remote ES import'],
];
let scanned = 0; let problems = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f); continue; }
    if (!/\.(js|mjs|html)$/.test(e.name)) continue;
    scanned++;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const [re, label] of BAD) if (re.test(line)) { console.log(`FORBIDDEN ${label}  ${path.relative(ROOT, f)}:${i + 1}`); problems++; }
    });
  }
})(ROOT);
console.log(`scanned ${scanned} files, problems: ${problems}`);
process.exit(problems ? 1 : 0);
