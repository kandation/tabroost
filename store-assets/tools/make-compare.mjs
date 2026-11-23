import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath, pathToFileURL} from 'node:url'; import {execSync} from 'node:child_process';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = (d, f) => pathToFileURL(path.join(root, 'png', d, f)).href;
const row = d => ['#ffffff', '#202124'].map((bg, i) => `<div class="cell" style="background:${bg}">
  <img src="${U(d,'icon16.png')}" width=16> <img src="${U(d,'icon32.png')}" width=32> <img src="${U(d,'icon48.png')}" width=48> <img src="${U(d,'icon128.png')}" width=96>
  <img src="${U(d,'icon16.png')}" width=96 style="image-rendering:pixelated"> <img src="${U(d,i?'mono16-white.png':'mono16.png')}" width=16> <img src="${U(d,i?'mono32-white.png':'mono32.png')}" width=32> <img src="${U(d,i?'mono32-white.png':'mono32.png')}" width=96></div>`).join('');
const html = `<!doctype html><style>body{margin:0;font:14px sans-serif}.r{display:flex}.cell{padding:14px;display:flex;gap:14px;align-items:center;width:600px}</style>` + ['a-sleepy', 'b-nest', 'c-chip'].map(d => `<div class="r">${row(d)}</div>`).join('');
const jf = path.join(root, 'tools', 'jobs-cmp.json'); fs.writeFileSync(jf, JSON.stringify([{html, w: 1200, h: 500, out: path.join(root, 'png', 'compare-directions.png'), transparent: false}]));
console.log(execSync(`node "${path.join(root, 'tools', 'render.mjs')}" "${jf}"`).toString()); fs.unlinkSync(jf);
