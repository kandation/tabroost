// Builds job list for icon PNGs for every direction and renders them.
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath, pathToFileURL} from 'node:url'; import {execSync} from 'node:child_process';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = f => pathToFileURL(path.join(root, 'svg', f)).href;
const page = (src, n) => `<!doctype html><body style="margin:0;background:transparent"><img src="${src}" width="${n}" height="${n}" style="display:block">`;
const jobs = [];
for (const d of ['a-sleepy', 'b-nest', 'c-chip']) {
  const P = (n, f, sz = n, sub = '') => jobs.push({html: page(S(`${d}-${f}.svg`), sz), w: sz, h: sz, out: path.join(root, 'png', d, `${sub}${n}.png`)});
  P('icon16', 'icon-16', 16); P('icon32', 'icon-fullbleed', 32); P('icon48', 'icon-fullbleed', 48); P('icon128', 'icon-128', 128); P('icon512-preview', 'icon-128', 512);
  P('mono16', 'mono-16', 16); P('mono16-white', 'mono-16-white', 16); P('mono32', 'mono', 32); P('mono32-white', 'mono-white', 32);
}
const jf = path.join(root, 'tools', 'jobs-icons.json'); fs.writeFileSync(jf, JSON.stringify(jobs));
console.log(execSync(`node "${path.join(root, 'tools', 'render.mjs')}" "${jf}"`).toString()); fs.unlinkSync(jf);
