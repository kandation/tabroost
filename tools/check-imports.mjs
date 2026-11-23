// Verifies that every `import {a, b} from './x.js'` / `import * as ns` resolves to an existing file + export,
// and that `ns.member` accesses of namespace imports exist. Run: node tools/check-imports.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tools' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
})(root);

const exportsOf = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop(); if (t) names.add(t); }
  return names;
};

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+([A-Za-z0-9_$]+)|\{([^}]*)\})\s+from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(f), m[3]);
    if (!fs.existsSync(target)) { console.log(`${rel}: missing file ${m[3]}`); bad++; continue; }
    const ex = exportsOf(target);
    if (m[2] != null) {
      for (const raw of m[2].split(',')) {
        const n = raw.trim().split(/\s+as\s+/)[0].trim();
        if (n && !ex.has(n)) { console.log(`${rel}: '${n}' is not exported by ${m[3]}`); bad++; }
      }
    } else {
      const ns = m[1];
      for (const u of src.matchAll(new RegExp(`\b${ns}\.([A-Za-z0-9_$]+)`, 'g'))) {
        if (!ex.has(u[1])) { console.log(`${rel}: ${ns}.${u[1]} is not exported by ${m[3]}`); bad++; }
      }
    }
  }
}
console.log(bad ? `check-imports: ${bad} problem(s)` : `check-imports: ok (${files.length} files)`);
process.exit(bad ? 1 : 0);
