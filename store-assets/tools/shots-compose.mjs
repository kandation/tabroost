// Composes the final Chrome Web Store art from the raw UI captures (store-assets/screenshots/raw/<lang>/, made by shots-capture.mjs):
//   store-assets/screenshots/<lang>/0N-*.png   five 1280x800 screenshots (24-bit RGB, no alpha)
//   store-assets/promo/                         small tile 440x280, marquee 1400x560 (en + th), GitHub social preview 1280x640
// The pages are plain HTML/CSS/SVG rendered by one headless Chrome (render.mjs). Fonts are the ones installed on this machine
// (Prompt, IBM Plex Sans Thai; fallbacks Leelawadee UI / Segoe UI); nothing is loaded from the web.
// usage: node store-assets/tools/shots-compose.mjs [en|th|all] [--only=1,2] [--no-promo]
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath, pathToFileURL} from 'node:url'; import {execSync} from 'node:child_process';
import {SITES} from './demo-data.mjs';
import {fileToRgb} from './png-rgb.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const O = (...f) => path.join(root, ...f);
const svgIcon = fs.readFileSync(O('svg', 'a-sleepy-icon-fullbleed.svg'), 'utf8');
const icon = (n, extra = '') => svgIcon.replace('<svg ', `<svg width="${n}" height="${n}" ${extra} `);
const V = '#7F52E8', CREAM = '#FFF3DC', AMBER = '#FFC247', INK = '#1E1245', NIGHT = '#170F3D';

// ---------- copy ----------
const COPY = {
  en: [
    {file: '01-save-every-tab', h: 'Save every tab<br>in one click.', p: 'A hundred open tabs become one tidy list, and your browser can breathe again.', before: 'Before · 86 open tabs', after: 'After · one tidy list', cap: 'Save every open tab with one click. They go into one tidy list and the browser gets lighter.'},
    {file: '02-find-any-tab', h: 'Find any tab<br>in a blink.', p: 'Typo-tolerant search across thousands of saved tabs, in English and Thai.', chip: 'Typo? Still found.', chip2: 'Thai works too', cap: 'Instant search across thousands of saved tabs. It forgives typos and understands Thai.'},
    {file: '03-idle-tabs-sleep', h: 'Idle tabs fall asleep<br>on their own.', p: 'Playing music or holding an unsaved form? Those tabs stay awake.', chip: 'Asleep, RAM freed', chip2: 'Kept awake, and why', cap: 'Idle tabs go to sleep automatically. Tabs playing media, unsaved forms and sites you protect stay awake.'},
    {file: '04-private-by-design', h: 'Private<br>by design.', p: 'Password lock and encrypted sync. No account, no servers, no tracking.', pts: ['Lock your saved tabs with a password', 'Sync is encrypted with your passphrase', 'Your data stays in your browser'], chip: 'Encrypted before it leaves your device', cap: 'Optional password lock and passphrase-encrypted sync. No account, no servers, no analytics.'},
    {file: '05-organise-your-way', h: 'Organise it your way.', p: 'Tab sets, categories, drag and drop. Reopen any set as tab groups, and see it all on a dashboard.', cap: 'Tab sets, categories and drag and drop. Reopen a set as Chrome tab groups. A local dashboard shows your habits.'},
  ],
  th: [
    {file: '01-save-every-tab', h: 'เก็บทุกแท็บ<br>ในคลิกเดียว', p: 'แท็บนับร้อยกลายเป็นรายการเดียวที่เป็นระเบียบ เบราว์เซอร์กลับมาเบาอีกครั้ง', before: 'ก่อน · เปิดค้างไว้ 86 แท็บ', after: 'หลัง · รายการเดียว เป็นระเบียบ', cap: 'เก็บทุกแท็บที่เปิดอยู่ด้วยการกดครั้งเดียว แท็บไปอยู่ในรายการเดียวที่เป็นระเบียบ เบราว์เซอร์เบาลง'},
    {file: '02-find-any-tab', h: 'หาแท็บไหนก็เจอ<br>ในพริบตา', p: 'พิมพ์ผิดนิดหน่อยก็ยังเจอ ค้นได้ทั้งไทยและอังกฤษ จากแท็บที่เก็บไว้หลายพันรายการ', chip: 'พิมพ์ผิดก็ยังเจอ', chip2: 'ค้นภาษาไทยได้', cap: 'ค้นหาแท็บที่เก็บไว้หลายพันรายการได้ทันที พิมพ์ผิดเล็กน้อยก็ยังเจอ และเข้าใจภาษาไทย'},
    {file: '03-idle-tabs-sleep', h: 'แท็บที่ไม่ได้ใช้<br>พักเองอัตโนมัติ', p: 'แท็บที่เล่นเพลงอยู่ หรือมีฟอร์มที่ยังไม่บันทึก จะไม่ถูกพัก', chip: 'พักอยู่ คืนแรมแล้ว', chip2: 'ไม่ถูกพัก พร้อมเหตุผล', cap: 'แท็บที่ไม่ได้ใช้จะพักเองอัตโนมัติ ส่วนแท็บที่เล่นสื่ออยู่ มีฟอร์มที่ยังไม่บันทึก หรือเว็บที่คุณกันไว้ จะไม่ถูกพัก'},
    {file: '04-private-by-design', h: 'เป็นส่วนตัว<br>ตั้งแต่ออกแบบ', p: 'ล็อกด้วยรหัสผ่าน ซิงค์แบบเข้ารหัส ไม่มีบัญชี ไม่มีเซิร์ฟเวอร์ ไม่มีการติดตาม', pts: ['ล็อกรายการแท็บด้วยรหัสผ่าน', 'ซิงค์โดยเข้ารหัสด้วยวลีรหัสผ่านของคุณ', 'ข้อมูลอยู่ในเบราว์เซอร์ของคุณ'], chip: 'เข้ารหัสก่อนออกจากเครื่อง', cap: 'ล็อกด้วยรหัสผ่านและซิงค์แบบเข้ารหัสด้วยวลีรหัสผ่าน (เลือกเปิดได้) ไม่มีบัญชี ไม่มีเซิร์ฟเวอร์ ไม่มีการเก็บสถิติ'},
    {file: '05-organise-your-way', h: 'จัดระเบียบได้ตามใจ', p: 'ชุดแท็บ หมวดหมู่ ลากแล้ววาง เปิดกลับเป็นกลุ่มแท็บ และดูภาพรวมทั้งหมดในแดชบอร์ด', cap: 'ชุดแท็บ หมวดหมู่ และลากแล้ววาง เปิดชุดแท็บกลับเป็นกลุ่มแท็บของ Chrome มีแดชบอร์ดในเครื่องแสดงพฤติกรรมการใช้งาน'},
  ],
};
export const TAG = {en: 'Give your tabs a place to rest.', th: 'ให้แท็บได้พัก ให้เครื่องได้หายใจ'};
const SUBTAG = {en: 'Save, search and sleep your tabs.', th: 'เก็บ ค้นหา และพักแท็บ'};
export const captions = (lang) => COPY[lang].map((c) => ({file: c.file + '.png', headline: c.h.replace(/<br>/g, ' '), sub: c.p, caption: c.cap}));

// ---------- shared css ----------
const base = (lang) => `*{box-sizing:border-box}html,body{margin:0}
body{width:1280px;height:800px;position:relative;overflow:hidden;font-family:"IBM Plex Sans Thai","Prompt","Leelawadee UI","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
svg{display:block}
h1{margin:0;font-family:"Prompt","Leelawadee UI","Segoe UI",sans-serif;font-weight:700;font-size:${lang === 'th' ? 56 : 62}px;line-height:${lang === 'th' ? 1.3 : 1.08};letter-spacing:${lang === 'th' ? '0' : '-1.2px'}}
.sub{margin:${lang === 'th' ? 14 : 20}px 0 0;font-size:${lang === 'th' ? 22 : 23}px;line-height:${lang === 'th' ? 1.6 : 1.45};font-weight:400}
.abs{position:absolute}
.win{position:absolute;border-radius:14px;overflow:hidden;background:#f6f7f9;box-shadow:0 40px 90px -24px rgba(16,6,56,.55),0 12px 28px -12px rgba(16,6,56,.35),0 0 0 1px rgba(20,10,60,.08)}
.win.dark{background:#111418;box-shadow:0 40px 90px -24px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.10)}
.bar{height:36px;background:#E6E3F1;display:flex;align-items:flex-end;padding:0 12px;gap:8px}
.dark .bar{background:#221B3D}
.tab{height:28px;background:#f6f7f9;border-radius:9px 9px 0 0;padding:0 14px 0 10px;display:flex;align-items:center;gap:8px;font:600 12.5px "Segoe UI","Leelawadee UI",sans-serif;color:#2b2540;min-width:150px}
.dark .tab{background:#111418;color:#e7eaf0}
.crop{background-repeat:no-repeat;display:block}
.card{position:absolute;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 30px 70px -20px rgba(16,6,56,.55),0 8px 20px -8px rgba(16,6,56,.3),0 0 0 1px rgba(20,10,60,.08)}
.chip{position:absolute;display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-radius:19px;font-family:"Prompt","Leelawadee UI",sans-serif;font-weight:600;font-size:16.5px;white-space:nowrap;box-shadow:0 8px 20px -8px rgba(16,6,56,.5)}
.chip.amber{background:${AMBER};color:#2A1766}.chip.ghost{background:rgba(255,255,255,.14);color:${CREAM};box-shadow:inset 0 0 0 1.5px rgba(255,243,220,.3)}
.chip.ink{background:${INK};color:${CREAM}}.chip.violet{background:${V};color:#fff}`;
const page = (lang, css, body) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>${base(lang)}${css}</style><body>${body}</body></html>`;

// ---------- helpers ----------
function ctx(lang) {
  const dir = O('screenshots', 'raw', lang);
  const R = JSON.parse(fs.readFileSync(path.join(dir, 'rects.json'), 'utf8'));
  const url = (n) => pathToFileURL(path.join(dir, n + '.png')).href;
  // a crop of a raw capture: r = {x,y,w,h} in CSS px of the captured viewport (vw wide), drawn at `scale`
  const crop = (n, r, scale = 1, vw = R.view.w) => `<div class="crop" style="width:${Math.round(r.w * scale)}px;height:${Math.round(r.h * scale)}px;background-image:url('${url(n)}');background-size:${vw * scale}px auto;background-position:${-r.x * scale}px ${-r.y * scale}px"></div>`;
  const win = (style, inner, {dark = false, bar = true} = {}) => `<div class="win${dark ? ' dark' : ''}" style="${style}">${bar ? `<div class="bar"><div class="tab">${icon(15)}<span>Tabroost</span></div></div>` : ''}${inner}</div>`;
  return {R, url, crop, win, c: COPY[lang]};
}
const zs = (items) => items.map(([x, y, s, o, rot = 0]) => `<svg class="abs" style="left:${x}px;top:${y}px;opacity:${o};transform:rotate(${rot}deg)" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M5 4H19L5 20H19" fill="none" stroke="${AMBER}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`).join('');
const stars = (n, seed = 3) => { let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); let o = ''; for (let i = 0; i < n; i++) { const d = 1.5 + r() * 2.5; const sx = Math.round(r() * 1280); const sy = Math.round(r() * 800); if (sx < 720 && sy < 320) continue; o += `<i class="abs" style="left:${sx}px;top:${sy}px;width:${d}px;height:${d}px;border-radius:50%;background:#fff;opacity:${(0.15 + r() * 0.5).toFixed(2)}"></i>`; } return o; };
const cursor = (x, y, s = 34) => `<svg class="abs" style="left:${x}px;top:${y}px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35))" width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M5 2.5v17l4.6-4.2 3 6.6 2.9-1.3-3-6.5 6.3-.5z" fill="#fff" stroke="#1E1245" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const check = (c = AMBER, ink = '#2A1766') => `<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="13" fill="${c}"/><path d="M7.5 13.5l3.6 3.6 7.4-8" fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// "before": a drawn, generic browser tab strip with far too many tabs (not a capture)
function tabStrip(w) {
  const sites = Object.values(SITES); let t = '';
  for (let i = 0; i < 64; i++) { const [l, c] = sites[(i * 7 + 3) % sites.length]; const act = i === 9; t += `<div style="flex:0 0 ${act ? 124 : 21}px;height:30px;border-radius:8px 8px 0 0;background:${act ? '#fff' : 'transparent'};display:flex;align-items:center;gap:6px;padding:0 ${act ? 9 : 4}px;border-right:${act ? 'none' : '1px solid rgba(60,50,90,.22)'}"><i style="flex:0 0 13px;height:13px;border-radius:3.5px;background:${c};color:#fff;font:700 8.5px/13px 'Segoe UI',sans-serif;text-align:center;font-style:normal">${l}</i>${act ? '<span style="height:6px;flex:1;border-radius:3px;background:#c9c5d8"></span><b style="font:400 12px/1 sans-serif;color:#77708f">×</b>' : ''}</div>`; }
  return `<div style="width:${w}px;border-radius:14px 0 0 14px;overflow:hidden;background:#D9D5E6;box-shadow:0 24px 50px -18px rgba(8,2,40,.6)">
    <div style="display:flex;align-items:flex-end;height:40px;padding:0 0 0 12px;-webkit-mask-image:linear-gradient(90deg,#000 82%,transparent)">${t}</div>
    <div style="height:42px;background:#fff;display:flex;align-items:center;gap:12px;padding:0 14px"><i style="width:14px;height:14px;border-radius:50%;background:#d6d2e2"></i><i style="width:14px;height:14px;border-radius:50%;background:#d6d2e2"></i><div style="flex:1;height:28px;border-radius:14px;background:#EFEDF5"></div></div></div>`;
}

// ---------- the five screenshots ----------
function shot1(lang) {
  const {R, crop, win, c} = ctx(lang); const t = c[0];
  const main = {x: R.side.w, y: 0, w: R.view.w - R.side.w, h: 640};
  return page(lang, `body{background:radial-gradient(90% 120% at 100% 0%,#6B44DA 0%,#44279F 38%,#25155F 100%);color:${CREAM}}
.sub{color:#DDD2F8}`, `
<div class="abs" style="right:-120px;bottom:-160px;opacity:.07">${icon(620)}</div>
<div class="abs" style="left:64px;top:${lang === 'th' ? 52 : 60}px;width:500px"><h1>${t.h}</h1><p class="sub" style="width:${lang === 'th' ? 470 : 440}px">${t.p}</p></div>
<div class="abs" style="left:600px;top:72px">${tabStrip(700)}</div>
<div class="chip ghost" style="left:600px;top:22px">${t.before}</div>
<svg class="abs" style="left:1010px;top:160px" width="90" height="74" viewBox="0 0 90 74"><path d="M70 4C74 30 62 48 30 56" fill="none" stroke="${AMBER}" stroke-width="5" stroke-linecap="round"/><path d="M44 42L28 57l20 8" fill="none" stroke="${AMBER}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="chip amber" style="left:600px;top:184px">${t.after}</div>
${win('left:600px;top:240px', crop('list', main, 0.84))}
<div class="card" style="left:64px;top:${lang === 'th' ? 376 : 356}px;border-radius:16px">${crop('popup', {x: 0, y: 0, w: 380, h: 149}, 1.08, 380)}</div>
${cursor(372, lang === 'th' ? 448 : 428)}
<div class="card" style="left:150px;top:${lang === 'th' ? 574 : 556}px;border-radius:16px;background:#fff;padding:10px 6px 10px 10px">${crop('list', R.stats, 1.52)}</div>
${zs([[520, 330, 30, 0.9, -8], [556, 296, 20, 0.6, -8]])}`);
}
function shot2(lang) {
  const {R, crop, win, c} = ctx(lang); const t = c[1];
  const a = lang === 'th' ? 'search-thai' : 'search-typo'; const b = lang === 'th' ? 'search-typo' : 'search-thai';
  const main = {x: R.side.w, y: 0, w: R.view.w - R.side.w, h: lang === 'th' ? 452 : 700};
  const small = {x: R.side.w + 12, y: 0, w: 660, h: 88 + 5 * 38 + 3};
  return page(lang, `body{background:linear-gradient(160deg,#FFF6E6 0%,#FFE9C2 100%);color:${INK}}
.sub{color:#4A3F70}`, `
<div class="abs" style="left:-140px;bottom:-220px;width:560px;height:560px;border-radius:50%;background:${V};opacity:.12"></div>
<div class="abs" style="right:-100px;top:-140px;width:420px;height:420px;border-radius:50%;background:${AMBER};opacity:.35"></div>
<div class="abs" style="left:64px;top:${lang === 'th' ? 52 : 60}px;width:520px"><h1>${t.h}</h1><p class="sub" style="width:${lang === 'th' ? 480 : 450}px">${t.p}</p></div>
${win(`left:588px;top:${lang === 'th' ? 132 : 96}px`, crop(a, main, 0.86))}
<div class="chip violet" style="left:${lang === 'th' ? 780 : 760}px;top:${lang === 'th' ? 110 : 74}px">${lang === 'th' ? t.chip2 : t.chip}</div>
<div class="card" style="left:64px;top:${lang === 'th' ? 452 : 430}px">${crop(b, small, 0.84)}</div>
<div class="chip ink" style="left:96px;top:${lang === 'th' ? 430 : 408}px">${lang === 'th' ? t.chip : t.chip2}</div>`);
}
function shot3(lang) {
  const {R, crop, win, c} = ctx(lang); const t = c[2]; const S = R['s-suspend'];
  // the two setting rows "put idle tabs to sleep automatically" + "sleep after being unused for" (row positions differ per language)
  const rows = lang === 'th' ? {y: 208, h: 122} : {y: 228, h: 142};
  const top = lang === 'th' ? 372 : 352;
  return page(lang, `body{background:radial-gradient(80% 100% at 80% 10%,#3A2390 0%,#1E1352 45%,#100A2E 100%);color:${CREAM}}
.sub{color:#CFC4F2}`, `${stars(70)}
<div class="abs" style="right:70px;top:36px;width:150px;height:150px;border-radius:50%;box-shadow:inset -34px 10px 0 0 ${AMBER};opacity:.9;transform:rotate(-18deg)"></div>
<div class="abs" style="left:64px;top:${lang === 'th' ? 52 : 60}px;width:640px"><h1>${t.h}</h1><p class="sub" style="width:${lang === 'th' ? 520 : 470}px">${t.p}</p></div>
<div class="card" style="left:64px;top:${top}px;background:#f6f7f9;padding:6px 8px 4px">${crop('popup', {x: R.pSleep.x - 4, y: R.pSleep.y - 4, w: R.pSleep.w + 8, h: R.pSleep.h + 6}, 1.12, 380)}</div>
<div class="chip ghost" style="left:84px;top:${top - 24}px;background:#2B1C6E">${t.chip}</div>
${win(`left:596px;top:${top - 62}px`, `<div style="background:#fff;padding:4px 0 6px">${crop('s-suspend', {x: S.x + 16, y: rows.y, w: S.w - 32, h: rows.h}, 0.97)}</div>`)}
<div class="card" style="left:724px;top:${lang === 'th' ? 548 : 540}px;background:#f6f7f9;padding:8px 10px 4px;box-shadow:0 30px 70px -20px rgba(0,0,0,.7),0 0 0 3px ${AMBER}">${crop('popup', {x: R.pProt.x - 4, y: R.pProt.y - 4, w: R.pProt.w + 8, h: R.pProt.h + 6}, 1.25, 380)}</div>
<div class="chip amber" style="left:746px;top:${lang === 'th' ? 524 : 516}px">${t.chip2}</div>
${zs([[690, 150, 44, 0.95, -8], [742, 108, 30, 0.7, -8], [778, 80, 20, 0.45, -8]])}`);
}
function shot4(lang) {
  const {R, crop, win, c} = ctx(lang); const t = c[3]; const L = R.lockCard; const S = R['s-sync'];
  const lock = {x: L.x - 34, y: L.y - 30, w: L.w + 68, h: L.h + 62};
  // the real "Sync between devices" settings card, cropped to its heading and its two buttons: the explanatory paragraphs
  // between them are left out (two crops of the same capture, stacked), so everything shown stays readable when small
  const sy = lang === 'th' ? {title: {y: 66, h: 42}, btn: {y: 254, h: 48}, w: 316, k: 1.9} : {title: {y: 68, h: 38}, btn: {y: 276, h: 48}, w: 444, k: 1.36};
  const sx = S.x + 17; const top = lang === 'th' ? 560 : 566;
  return page(lang, `body{background:radial-gradient(100% 120% at 0% 0%,#FFE3A1 0%,${AMBER} 48%,#FFAA2B 100%);color:${INK}}
.sub{color:#4A3566}
.pt{display:flex;align-items:center;gap:14px;font-family:"Prompt","Leelawadee UI",sans-serif;font-weight:600;font-size:${lang === 'th' ? 21 : 22}px;margin-top:${lang === 'th' ? 14 : 18}px;white-space:nowrap}`, `
<div class="abs" style="left:560px;top:-40px;width:880px;height:880px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,243,220,.85),rgba(255,243,220,0))"></div>
<div class="abs" style="left:-150px;bottom:-230px;width:520px;height:520px;border-radius:50%;background:${CREAM};opacity:.4"></div>
<div class="abs" style="left:64px;top:${lang === 'th' ? 44 : 60}px;width:580px"><h1>${t.h}</h1><p class="sub" style="width:${lang === 'th' ? 500 : 460}px">${t.p}</p>
<div style="margin-top:${lang === 'th' ? 22 : 34}px">${t.pts.map((x) => `<div class="pt">${check(INK, AMBER)}<span>${x}</span></div>`).join('')}</div></div>
${win('left:680px;top:92px', crop('locked', lock, 1.2))}
<svg class="abs" style="left:1176px;top:50px;filter:drop-shadow(0 10px 18px rgba(30,18,69,.4))" width="92" height="92" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="${INK}"/><rect x="19" y="29" width="26" height="20" rx="5" fill="${AMBER}"/><path d="M24 29v-6a8 8 0 0116 0v6" fill="none" stroke="${AMBER}" stroke-width="4.5" stroke-linecap="round"/></svg>
<div class="card" style="left:64px;top:${top}px;border-radius:18px;background:#fff;padding:18px 14px 20px;box-shadow:0 30px 70px -20px rgba(16,6,56,.55),0 8px 20px -8px rgba(16,6,56,.3),0 0 0 3px ${INK}">${crop('s-sync', {x: sx, y: sy.title.y, w: sy.w, h: sy.title.h}, sy.k)}${crop('s-sync', {x: sx, y: sy.btn.y, w: sy.w, h: sy.btn.h}, sy.k)}</div>
<div class="chip ink" style="left:88px;top:${top - 22}px">${t.chip}</div>`);
}
function shot5(lang) {
  const {R, crop, win, c} = ctx(lang); const t = c[4];
  const tl = R.dashCards.find((x) => x.id === 'timeline'); const ht = R.dashCards.find((x) => x.id === 'heat'); const cats = R.dashCards.find((x) => x.id === 'cats');
  return page(lang, `body{background:linear-gradient(150deg,#F3EEFF 0%,#DFD3FF 60%,#CDBBFF 100%);color:${INK}}
.sub{color:#4A3F70}`, `
<div class="abs" style="right:-120px;top:-160px;width:460px;height:460px;border-radius:50%;background:${AMBER};opacity:.45"></div>
<div class="abs" style="left:-100px;bottom:-200px;width:420px;height:420px;border-radius:50%;background:${V};opacity:.18"></div>
<div class="abs" style="left:64px;top:${lang === 'th' ? 44 : 54}px;width:1000px"><h1>${t.h}</h1><p class="sub" style="width:${lang === 'th' ? 720 : 690}px;white-space:${lang === 'th' ? 'nowrap' : 'normal'};margin-top:${lang === 'th' ? 6 : 14}px">${t.p}</p></div>
${win('left:64px;top:248px', crop('list-drag', {x: 0, y: 0, w: 900, h: 640}, 0.88))}
<div class="card" style="left:812px;top:226px">${crop('dash', {x: tl.x, y: tl.y, w: tl.w, h: tl.h - 44}, 0.86, 1320)}</div>
<div class="card" style="left:884px;top:452px">${crop('dash', {x: ht.x, y: ht.y, w: ht.w, h: ht.h - 96}, 0.78, 1320)}</div>
<div class="card" style="left:960px;top:612px">${crop('dash', {x: cats.x, y: cats.y, w: cats.w, h: 240}, 0.86, 1320)}</div>`);
}

// ---------- promo tiles + social preview ----------
const promoBase = `*{box-sizing:border-box}html,body{margin:0}body{position:relative;overflow:hidden;font-family:"Prompt","Leelawadee UI","Segoe UI",sans-serif;color:${CREAM};-webkit-font-smoothing:antialiased}svg{display:block}.abs{position:absolute}`;
const promoBg = 'background:radial-gradient(110% 140% at 88% 0%,#6B44DA 0%,#44279F 36%,#25155F 72%,#170F3D 100%)';
// a little stack of "saved tab" rows drifting off to sleep (drawn, no text)
function rows(x, y, w, n, scale = 1) {
  const cols = ['#a259ff', '#e62117', '#4285f4', '#00aa6c', '#f48024', '#00c4cc', '#ff5a5f']; let o = '';
  for (let i = 0; i < n; i++) { const op = 1 - i * (0.72 / n); const ww = w - i * 26 * scale; o += `<div class="abs" style="left:${x + i * 13 * scale}px;top:${y + i * 62 * scale}px;width:${ww}px;height:${50 * scale}px;border-radius:${14 * scale}px;background:${CREAM};opacity:${op.toFixed(2)};display:flex;align-items:center;gap:${14 * scale}px;padding:0 ${16 * scale}px;box-shadow:0 14px 30px -14px rgba(8,2,40,.7)"><i style="flex:0 0 ${22 * scale}px;height:${22 * scale}px;border-radius:${6 * scale}px;background:${cols[i % cols.length]}"></i><i style="height:${9 * scale}px;width:${[58, 44, 66, 38, 52][i % 5]}%;border-radius:${5 * scale}px;background:#3A1E85;opacity:.55"></i><i style="margin-left:auto;height:${9 * scale}px;width:${36 * scale}px;border-radius:${5 * scale}px;background:#3A1E85;opacity:.22"></i></div>`; }
  return o;
}
const small = (lang) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>${promoBase}body{width:440px;height:280px;${promoBg}}
h1{position:absolute;left:36px;top:${lang === 'th' ? 136 : 140}px;margin:0;font-size:46px;font-weight:700;letter-spacing:-.8px;line-height:1.1}
p{position:absolute;left:36px;top:${lang === 'th' ? 194 : 200}px;margin:0;font-size:${lang === 'th' ? 19 : 19.5}px;font-weight:500;color:${AMBER};line-height:1.5;white-space:nowrap}</style><body>
<div class="abs" style="left:36px;top:32px;filter:drop-shadow(0 10px 18px rgba(8,2,40,.55))">${icon(92)}</div>
${zs([[142, 40, 26, 0.9, -8], [172, 18, 17, 0.55, -8]])}
<div style="transform:rotate(-6deg);transform-origin:300px 60px">${rows(262, 44, 220, 3, 0.8)}</div>
<h1>Tabroost</h1><p>${TAG[lang]}</p></body></html>`;
const marquee = (lang) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>${promoBase}body{width:1400px;height:560px;${promoBg}}
h1{margin:0;font-size:118px;font-weight:700;letter-spacing:-3px;line-height:1.05}
.tag{margin:${lang === 'th' ? 14 : 18}px 0 0;font-size:${lang === 'th' ? 40 : 42}px;font-weight:500;color:${AMBER};line-height:1.4;white-space:nowrap}</style><body>
<div class="abs" style="left:96px;top:160px;filter:drop-shadow(0 22px 40px rgba(8,2,40,.6))">${icon(240)}</div>
${zs([[318, 108, 42, 0.95, -8], [364, 68, 29, 0.65, -8], [398, 40, 20, 0.4, -8]])}
<div class="abs" style="left:392px;top:${lang === 'th' ? 172 : 180}px"><h1>Tabroost</h1><div class="tag">${TAG[lang]}</div></div>
<div style="transform:rotate(-7deg);transform-origin:1150px 280px">${rows(1010, 92, 420, 6, 1.12)}</div></body></html>`;
const social = () => `<!doctype html><html lang="en"><meta charset="utf-8"><style>${promoBase}body{width:1280px;height:640px;${promoBg}}
h1{margin:0;font-size:112px;font-weight:700;letter-spacing:-3px;line-height:1.05}
.tag{margin:16px 0 0;font-size:40px;font-weight:500;color:${AMBER};line-height:1.35;white-space:nowrap}
.sub{margin:22px 0 0;font-size:26px;font-weight:400;color:#DDD2F8;font-family:"IBM Plex Sans Thai","Segoe UI",sans-serif;white-space:nowrap}</style><body>
<div class="abs" style="right:-170px;top:-150px;opacity:.07">${icon(800)}</div>
<div class="abs" style="left:110px;top:196px;filter:drop-shadow(0 22px 40px rgba(8,2,40,.6))">${icon(232)}</div>
${zs([[326, 144, 42, 0.95, -8], [372, 104, 29, 0.65, -8], [406, 76, 20, 0.4, -8]])}
<div class="abs" style="left:400px;top:190px"><h1>Tabroost</h1><div class="tag">${TAG.en}</div><div class="sub">A private tab manager for Chrome. ${SUBTAG.en}</div></div></body></html>`;

// ---------- run ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const which = args.find((a) => !a.startsWith('--')) || 'all';
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean).map(Number);
  const langs = (which === 'all' ? ['en', 'th'] : [which]).filter((l) => fs.existsSync(O('screenshots', 'raw', l, 'rects.json')));
  const jobs = []; const fns = [shot1, shot2, shot3, shot4, shot5];
  for (const lang of langs) fns.forEach((fn, i) => { if (!only.length || only.includes(i + 1)) jobs.push({html: fn(lang), w: 1280, h: 800, out: O('screenshots', lang, COPY[lang][i].file + '.png'), transparent: false}); });
  if (!args.includes('--no-promo')) {
    for (const lang of ['en', 'th']) { jobs.push({html: small(lang), w: 440, h: 280, out: O('promo', `small-tile-440x280-${lang}.png`), transparent: false}); jobs.push({html: marquee(lang), w: 1400, h: 560, out: O('promo', `marquee-1400x560-${lang}.png`), transparent: false}); }
    jobs.push({html: social(), w: 1280, h: 640, out: O('promo', 'github-social-1280x640.png'), transparent: false});
  }
  const jf = O('tools', 'jobs-shots.json'); fs.writeFileSync(jf, JSON.stringify(jobs));
  try { console.log(execSync(`node "${O('tools', 'render.mjs')}" "${jf}"`).toString().trim()); } finally { fs.unlinkSync(jf); }
  for (const j of jobs) { const i = fileToRgb(j.out); if (i.width !== j.w || i.height !== j.h || i.colorType !== 2) throw new Error('bad output ' + j.out); console.log(path.relative(root, j.out), `${i.width}x${i.height} RGB`); }
}
