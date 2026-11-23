#!/usr/bin/env node
// Keeps THIRD-PARTY-NOTICES.md (the file that ships and that the licences ask us to keep) and the copy rendered by the About page
// (NOTICES in lib/aboutinfo.js) in step.   node tools/check-notices.mjs      (exit code 1 on any difference)
// Checks: every section letter has a "## X." heading in the markdown; every item name appears in the markdown;
// every link in aboutinfo.js appears in the markdown, and every link in the markdown appears in aboutinfo.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function checkNotices() {
  const problems = [];
  const md = fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const { NOTICES } = await import(pathToFileURL(path.join(ROOT, 'lib', 'aboutinfo.js')).href);
  const urlsMd = new Set((md.match(/https?:\/\/[^\s)`|,<>]+/g) || []).map((u) => u.replace(/[.;:]+$/, '')));
  const urlsJs = new Set();
  for (const sec of NOTICES) {
    if (!new RegExp(`^## ${sec.id}\. `, 'm').test(md)) problems.push(`section ${sec.id}: no "## ${sec.id}." heading in THIRD-PARTY-NOTICES.md`);
    if (!sec.title || !sec.title.th || !sec.title.en || !sec.intro || !sec.intro.th || !sec.intro.en) problems.push(`section ${sec.id}: missing th/en title or intro`);
    for (const it of sec.items) {
      if (!md.includes(it.k)) problems.push(`section ${sec.id}: "${it.k}" is not in THIRD-PARTY-NOTICES.md`);
      if (!it.th || !it.en) problems.push(`section ${sec.id}: "${it.k}" lacks th or en text`);
      for (const u of it.url || []) urlsJs.add(u);
    }
  }
  for (const u of urlsJs) if (!urlsMd.has(u)) problems.push(`link only in aboutinfo.js: ${u}`);
  for (const u of urlsMd) if (!urlsJs.has(u)) problems.push(`link only in THIRD-PARTY-NOTICES.md: ${u}`);
  const letters = [...md.matchAll(/^## ([A-G])\. /gm)].map((m) => m[1]);
  for (const l of letters) if (!NOTICES.some((s) => s.id === l)) problems.push(`section ${l} is in the markdown but not in aboutinfo.js`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = await checkNotices();
  if (p.length) { for (const x of p) console.log('x ' + x); process.exit(1); }
  console.log('OK: THIRD-PARTY-NOTICES.md and lib/aboutinfo.js agree');
}
