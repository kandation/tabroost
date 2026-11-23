// Store assets for the chosen direction (A) and working name. Change NAME/TAG below to rename.
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath, pathToFileURL} from 'node:url'; import {execSync} from 'node:child_process';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Tabroost', DIR = 'a-sleepy';
const TAG = {en: 'Give your tabs a place to rest.', th: 'ให้แท็บได้พัก ให้เครื่องได้หายใจ'};
const SUB = {en: 'Save every tab to a searchable list. Sleep idle tabs. Get your RAM back.', th: 'เก็บทุกแท็บไว้ในรายการค้นหาได้ พักแท็บที่ไม่ใช้ คืนแรมให้เครื่อง'};
const FEAT = {en: ['Save & close all tabs', 'Restore without RAM spikes', 'Sleep idle tabs'], th: ['เก็บและปิดทุกแท็บ', 'เปิดคืนโดยแรมไม่พุ่ง', 'พักแท็บที่ไม่ใช้']};
const svgIcon = fs.readFileSync(path.join(root, 'svg', `${DIR}-icon-fullbleed.svg`), 'utf8');
const P = f => pathToFileURL(path.join(root, 'png', DIR, f)).href;
const FONT = `font-family:"Leelawadee UI","Segoe UI",Tahoma,sans-serif`;
const base = `*{box-sizing:border-box}body{margin:0;${FONT}}svg{display:block}`;
const icon = n => svgIcon.replace('<svg ', `<svg width="${n}" height="${n}" `);
const bg = `background:radial-gradient(120% 140% at 85% 0%,#4A2A9E 0%,#2A1766 45%,#1A0F45 100%)`;
const promo = l => `<!doctype html><meta charset="utf-8"><style>${base}body{width:440px;height:280px;${bg};color:#FFF3DC;position:relative;overflow:hidden}
.i{position:absolute;left:32px;top:30px;filter:drop-shadow(0 6px 14px rgba(0,0,0,.35))}
h1{position:absolute;left:32px;top:132px;margin:0;font-size:42px;font-weight:700;letter-spacing:-.5px;line-height:1.2}
p{position:absolute;left:32px;top:196px;right:28px;margin:0;font-size:19px;line-height:1.5;color:#FFC247;font-weight:600}
.z{position:absolute;right:-40px;bottom:-50px;opacity:.10}</style>
<div class="i">${icon(84)}</div><div class="z">${icon(230)}</div><h1>${NAME}</h1><p>${TAG[l]}</p>`;
const marquee = l => `<!doctype html><meta charset="utf-8"><style>${base}body{width:1400px;height:560px;${bg};color:#FFF3DC;position:relative;overflow:hidden}
.i{position:absolute;left:110px;top:140px;filter:drop-shadow(0 12px 28px rgba(0,0,0,.4))}
.t{position:absolute;left:400px;top:118px;right:80px}
h1{margin:0;font-size:104px;font-weight:700;letter-spacing:-2px;line-height:1.15}
.tag{margin:10px 0 0;font-size:42px;font-weight:600;color:#FFC247;line-height:1.35}
.sub{margin:16px 0 0;font-size:26px;line-height:1.55;color:#E6DAF7;max-width:860px}
.f{position:absolute;left:400px;bottom:64px;display:flex;gap:16px}
.f span{padding:10px 20px;border-radius:999px;background:rgba(255,243,220,.12);border:1.5px solid rgba(255,243,220,.28);font-size:23px;font-weight:600}
.z{position:absolute;right:-90px;top:-80px;opacity:.07}</style>
<div class="z">${icon(520)}</div><div class="i">${icon(240)}</div>
<div class="t"><h1>${NAME}</h1><div class="tag">${TAG[l]}</div><div class="sub">${SUB[l]}</div></div>
<div class="f">${FEAT[l].map(x => `<span>${x}</span>`).join('')}</div>`;
const bar = (bgc, fg, pill, iconFile) => `<div style="background:${bgc};padding:8px 10px;border-radius:10px;display:flex;align-items:center;gap:10px;width:540px;color:${fg}">
  <div style="display:flex;gap:6px"><i style="width:12px;height:12px;border-radius:50%;background:${fg};opacity:.25"></i><i style="width:12px;height:12px;border-radius:50%;background:${fg};opacity:.25"></i></div>
  <div style="flex:1;height:30px;border-radius:15px;background:${pill};font-size:12px;line-height:30px;padding-left:14px;opacity:.9">example.com</div>
  <div style="width:24px;height:24px;border-radius:5px;background:${fg};opacity:.12"></div>
  <div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center"><img src="${P(iconFile)}" width="16" height="16"></div>
  <div style="width:24px;height:24px;border-radius:5px;background:${fg};opacity:.12"></div></div>`;
const side = (cls, title, monoSuffix, barBg, barFg, barPill) => `<div class="p ${cls}"><h2>${title}</h2>
<div class="g"><figure><img src="${P('icon16.png')}" width=16>16</figure><figure><img src="${P('icon32.png')}" width=32>32</figure><figure><img src="${P('icon48.png')}" width=48>48</figure><figure><img src="${P('icon128.png')}" width=128>128 (16px pad)</figure><figure><img class="zoom" src="${P('icon16.png')}" width=128>16 @ 8x</figure></div>
<div class="g"><figure><img src="${P('mono16' + monoSuffix + '.png')}" width=16>mono 16</figure><figure><img src="${P('mono32' + monoSuffix + '.png')}" width=32>mono 32</figure></div>
<div class="sm">Toolbar mock, 16px icon (1x)</div>${bar(barBg, barFg, barPill, 'icon16.png')}
<div class="sm">Toolbar mock, 32px PNG shown at 16 CSS px (2x display)</div>${bar(barBg, barFg, barPill, 'icon32.png')}</div>`;
const sheet = `<!doctype html><meta charset="utf-8"><style>${base}body{width:1200px;height:700px;background:#fff;color:#222}
.row{display:flex}.p{width:600px;padding:26px 30px 20px}.dk{background:#202124;color:#eee}.lt{background:#fff}
h2{margin:0 0 16px;font-size:15px;font-weight:600}.g{display:flex;align-items:flex-end;gap:26px;margin-bottom:16px}
.g figure{margin:0;text-align:center;font-size:11px;color:#8a8a90}.g img{display:block;margin:0 auto 6px}
.zoom{image-rendering:pixelated}.sm{font-size:12px;opacity:.65;margin:16px 0 8px}</style>
<div class="row">${side('lt', NAME + ' on light (#ffffff)', '', '#dfe1e5', '#202124', '#fff')}${side('dk', NAME + ' on dark (#202124)', '-white', '#35363a', '#e8eaed', '#202124')}</div>
<div class="row" style="background:#f4f2fb"><div class="p" style="width:1200px;padding-top:20px;display:flex;gap:30px;align-items:center"><img src="${P('icon512-preview.png')}" width=200><div style="font-size:14px;line-height:1.7;color:#444"><b>Contrast of tile vs toolbar</b><br>tile #7F52E8 vs white 4.9:1, vs #202124 3.3:1 (both above the 3:1 non-text minimum)<br>cream glyph #FFF3DC vs tile 4.5:1, amber z #FFC247 vs tile 3.1:1<br>Mono badge: black on light / white on dark, glyph silhouette with cut-out eyes.</div></div></div>`;
const O = f => path.join(root, f);
// The promo tiles and the marquee are now made by shots-compose.mjs (same file names); this script only renders the icon preview sheet.
const jobs = [
  {html: sheet, w: 1200, h: 700, out: O('promo/preview-sheet.png'), transparent: false},
];
const jf = O('tools/jobs-store.json'); fs.writeFileSync(jf, JSON.stringify(jobs));
console.log(execSync(`node "${O('tools/render.mjs')}" "${jf}"`).toString()); fs.unlinkSync(jf);
