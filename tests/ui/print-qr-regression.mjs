// Window label rows (continuous card frame), print sheet (real rendering, not blank), QR dialog (decoded with jsqr) in real Chrome over CDP.
//   node tests/ui/print-qr-regression.mjs
// jsqr is a DEV-ONLY decoder installed on demand in a temp directory outside the project (same as tests/qr-test.mjs).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9366;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-printqr-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-printqr-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
const S = (o) => JSON.stringify(o);
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  return { send: (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}
function loadJsqr() {
  const dir = process.env.JSQR_DIR || path.join(os.tmpdir(), 'qrdev');
  const req = createRequire(path.join(dir, 'x.js'));
  try { return req('jsqr'); } catch { /* install below */ }
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
  spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['i', 'jsqr', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' });
  return req('jsqr');
}
// minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for pixel checks of screenshots
function decodePng(buf) {
  let p = 8; let w = 0; let h = 0; let ct = 6; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); ct = buf[p + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0; const b = y ? out[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, px: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}

try {
  const jsqr = loadJsqr();
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed');
  await br.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `chrome-extension://${ld.result.id}` }).catch(() => {});
  await br.send('Target.createTarget', { url: `chrome-extension://${ld.result.id}/stash.html?t=1`, newWindow: true, width: 1400, height: 900 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 500)); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await fn()) return true; await sleep(150); } return false; };
  const shotBuf = async (o = {}) => Buffer.from((await pg.send('Page.captureScreenshot', { format: 'png', ...o })).result.data, 'base64');
  const shot = async (name, o) => { const b = await shotBuf(o); fs.writeFileSync(path.join(SHOTS, name + '.png'), b); return b; };
  const scheme = async (s) => { await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] }); await sleep(350); };
  const mouse = (type, x, y, o = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : (o.button || 'left'), buttons: type === 'mouseReleased' ? 0 : (o.buttons ?? 1), clickCount: 1 });
  const rclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', x, y, { button: 'right' }); await sleep(450); };
  const lclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(350); };
  const key = async (k, vk) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await sleep(300); };
  const rect = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,r:r.right,b:r.bottom,cx:r.left+r.width/2,cy:r.top+r.height/2}; })()`);
  const metrics = (w, h) => pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);
  await metrics(1400, 900);

  // Thai text only through escapes (the repository check forbids literal Thai outside the i18n tables)
  const THAI_TITLE = '\u0e17\u0e14\u0e2a\u0e2d\u0e1a\u0e1e\u0e34\u0e21\u0e1e\u0e4c \u0e20\u0e32\u0e29\u0e32\u0e44\u0e17\u0e22';
  const THAI_TAB = '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e0a\u0e32\u0e27\u0e42\u0e25\u0e01 \u0e17\u0e14\u0e2a\u0e2d\u0e1a';
  const LONG = 'https://docs.example.test/a/very/long/path/' + 'segment-'.repeat(14) + '?utm_source=newsletter&utm_medium=email&utm_campaign=spring_sale_2026&ref=abc123&session=9f8e7d6c5b4a';
  const mkSet = async (title, items, extra = {}) => {
    const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g;
  };
  const tgs = [{ i: 0, title: 'Research', color: 'blue', collapsed: false, windowIdx: 1 }, { i: 1, title: 'Shopping', color: 'orange', collapsed: false, windowIdx: 2 }];
  const P = await mkSet(THAI_TITLE, [
    { url: 'https://a.example.test/one', title: 'Alpha one with a rather long title that should wrap onto a second line in the printed page when it is long enough', w: 1, ws: true, tg: 0 },
    { url: LONG, title: THAI_TAB, w: 1, tg: 0 },
    { url: 'https://b.example.test/three', title: 'Plain three', w: 1 },
    { url: 'https://c.example.test/four', title: 'Window two starts', w: 2, ws: true },
    { url: 'https://d.example.test/five', title: 'Shop five', w: 2, tg: 1 },
    { url: 'https://d.example.test/six?x=' + 'y'.repeat(120), title: 'Shop six', w: 2, tg: 1 },
    { url: 'https://e.example.test/seven', title: 'Plain seven', w: 2 },
  ], { tabGroups: tgs, windowCount: 2 });
  const BIG = 'https://big.example.test/' + 'a'.repeat(3100);
  const Q = await mkSet('QR set', [{ url: 'https://q.example.test/hello?x=1&y=2', title: 'QR target tab' }, { url: BIG, title: 'Too long for a QR code' }]);
  await until(() => ev(`__cmr.S.allGroups.length>=2`), 15000);
  const prep = `(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); window.__printed=[]; window.print=()=>{ window.__printed.push(document.body.className); }; })()`;
  await ev(prep); await sleep(600);
  const gsel = (g) => `.vrow.ghead[data-g="${g}"]`;
  const reveal = async (g) => { await ev(`(()=>{ const n=document.querySelector('${gsel(g)}'); const r=n&&!n.hidden&&n.getBoundingClientRect(); if(r&&r.top>=0&&r.bottom<=innerHeight) return; const i=__cmr.V.idxOf.get('${g}'); document.getElementById('scroller').scrollTop=Math.max(0,__cmr.V.tops[i]-70); })()`); await sleep(500); };

  // ---------- (A) window label rows keep the card frame continuous ----------
  await ev(`__cmr.fn.expandAll(true)`); await sleep(1200);
  await reveal(P);
  for (const dens of ['comfortable', 'compact']) {
    await msg({ type: 'saveSettings', patch: { density: dens } }); await sleep(1200); await reveal(P);
    for (const sch of ['light', 'dark']) {
      await scheme(sch); await mouse('mouseMoved', 3, 3, { buttons: 0 }); await sleep(400);
      const geo = await ev(`(()=>{ const h=document.querySelector('${gsel(P)}'); const hr=h.getBoundingClientRect(); const rows=[...document.querySelectorAll('.vrow:not([hidden])')].filter(n=>n.dataset.g==='${P}'); const last=rows.reduce((a,n)=>Math.max(a,n.getBoundingClientRect().bottom),0); return { left:hr.left, right:hr.right, top:hr.top+8, bottom:last, wins:document.querySelectorAll('.vrow.note.win:not([hidden])').length }; })()`);
      const png = decodePng(await shot(`winlabels-${dens}-${sch}`));
      const bx = Math.round(geo.left); const by0 = Math.round(geo.top) + 14; const by1 = Math.min(Math.round(geo.bottom) - 14, png.h - 1);
      const ref = png.px(bx, by0 + 6);
      const bg = png.px(Math.max(0, bx - 6), by0 + 6);
      const diff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      const gapsL = []; const gapsR = [];
      for (let y = by0; y <= by1; y++) {
        let okL = false; for (let dx = -1; dx <= 1; dx++) if (diff(png.px(bx + dx, y), bg) > 6) okL = true;
        if (!okL) gapsL.push(y);
        const rx = Math.round(geo.right) - 1; let okR = false; for (let dx = -1; dx <= 1; dx++) if (diff(png.px(rx + dx, y), bg) > 6) okR = true;
        if (!okR) gapsR.push(y);
      }
      if (gapsL.length) console.log('INFO rows near gap', S(await ev(`[...document.querySelectorAll('.vrow:not([hidden])')].filter(n=>n.dataset.g==='${P}').map(n=>{const r=n.getBoundingClientRect(); return n.className.replace('vrow ','')+' '+Math.round(r.top)+'-'+Math.round(r.bottom);})`)));
      check(`window labels (${dens}, ${sch}): ${geo.wins} label rows; card left/right border has no gaps over ${by1 - by0} px`, geo.wins >= 2 && gapsL.length === 0 && gapsR.length === 0, S({ geo, gapsL: gapsL.slice(0, 8), gapsR: gapsR.slice(0, 8), ref, bg }));
      // bottom of the last row: border + rounding visible below the last item
      const lastRow = await ev(`(()=>{ const rows=[...document.querySelectorAll('.vrow.item:not([hidden])')].filter(n=>n.dataset.g==='${P}'); const n=rows[rows.length-1]; const r=n.getBoundingClientRect(); const cs=getComputedStyle(n,'::before'); const cs2=getComputedStyle(n); return { cls:n.className, b:r.bottom, bw:cs.borderBottomWidth, ibw:cs2.borderBottomWidth, rad:cs.borderBottomLeftRadius, rad2:cs2.borderBottomLeftRadius, l:r.left, r:r.right }; })()`);
      check(`last row (${dens}, ${sch}): bottom border + rounded corners present`, lastRow && (parseFloat(lastRow.bw) > 0 || parseFloat(lastRow.ibw) > 0) && (parseFloat(lastRow.rad) > 0 || parseFloat(lastRow.rad2) > 0), S(lastRow));
    }
    await scheme('light');
  }
  await msg({ type: 'saveSettings', patch: { density: 'comfortable' } }); await sleep(800);
  await ev(`__cmr.fn.expandAll(false)`); await sleep(500);

  // ---------- (B) print ----------
  const openMenuAct = async (g, act) => {
    await reveal(g);
    await ev(`document.querySelector('${gsel(g)} [data-act="more"]').click()`); await sleep(500);
    await ev(`document.querySelector('#moreMenu [data-act="${act}"]').click()`); await sleep(600);
  };
  await openMenuAct(P, 'printGroup');
  const dl = await ev(`(()=>{ const d=document.querySelector('dialog.print-dlg'); if(!d) return null; return { open:d.open, boxes:[...d.querySelectorAll('input[type=checkbox]')].map(c=>c.checked), btns:[...d.querySelectorAll('button')].map(b=>b.textContent.trim()) }; })()`);
  check('print dialog opens (.print-dlg) with 3 options and Cancel / Print buttons', dl && dl.open && dl.boxes.length === 3 && dl.btns.length === 2, S(dl));
  await shot('print-dialog-light'); await scheme('dark'); await shot('print-dialog-dark'); await scheme('light');
  // Cancel prints nothing
  await ev(`document.querySelector('dialog.print-dlg .btn:not(.primary)').click()`); await sleep(500);
  check('print dialog: Cancel opens no print and leaves no sheet', (await ev(`window.__printed.length`)) === 0 && !(await ev(`!!document.getElementById('printSheet')`)) && !(await ev(`!!document.querySelector('dialog.print-dlg')`)));
  await openMenuAct(P, 'printGroup');
  for (let i = 0; i < 3; i++) await ev(`(()=>{ const c=document.querySelectorAll('dialog.print-dlg input[type=checkbox]')[${i}]; if(!c.checked) c.click(); })()`);
  await ev(`document.querySelector('dialog.print-dlg .btn.primary').click()`);
  const printed = await until(() => ev(`window.__printed.length>=1`), 8000);
  const opts = await ev(`localStorage.getItem('cmr.printOpts')`);
  check('print: Print button builds the sheet, adds body.printing and calls window.print once; options saved in cmr.printOpts', printed && (await ev(`window.__printed[0].includes('printing')`)) && opts && JSON.parse(opts).qr === true, opts);
  const st = await ev(`(()=>{ const s=document.getElementById('printSheet'); return { has:!!s, items:s.querySelectorAll('.ps-item').length, wins:[...s.querySelectorAll('.ps-win')].map(x=>x.textContent), tgs:[...s.querySelectorAll('.ps-tg')].map(x=>x.textContent+':'+x.dataset.c), qr:s.querySelectorAll('.ps-qr svg').length, skip:s.querySelectorAll('.ps-qr.skip').length, title:s.querySelector('.ps-title').textContent, meta:s.querySelector('.ps-meta').textContent, foot:s.querySelector('.ps-foot')?.textContent||'', urlsLong:[...s.querySelectorAll('.ps-u')].some(u=>u.textContent.length>150), olStart:[...s.querySelectorAll('.ps-list')].map(l=>l.start) }; })()`);
  check('print sheet content: title (Thai), meta line, 2 window headings, 2 tab-group headings, 7 numbered items, 7 QR svgs, footer', st.has && st.title === THAI_TITLE && st.meta.length > 5 && st.wins.length === 2 && st.tgs.length >= 2 && st.items === 7 && st.qr === 7 && st.foot.length > 3 && st.urlsLong, S(st));
  // real print rendering: emulate the print media and look at the page
  await pg.send('DOM.enable'); await pg.send('Emulation.setEmulatedMedia', { media: 'print' }); await sleep(500);
  const pr = await ev(`(()=>{ const s=document.getElementById('printSheet'); const cs=getComputedStyle(s); const r=s.getBoundingClientRect(); const vis=[...document.body.children].filter(n=>getComputedStyle(n).display!=='none'&&n.tagName!=='SCRIPT'&&n.tagName!=='STYLE').map(n=>n.id||n.tagName); const rows=[...s.querySelectorAll('.ps-row')].map(n=>getComputedStyle(n).breakInside); const heads=[...s.querySelectorAll('.ps-win,.ps-tg')].map(n=>getComputedStyle(n).breakAfter); const tgc=[...s.querySelectorAll('.ps-tg:not(.none)')].map(n=>getComputedStyle(n).borderLeftColor); const wide=[...s.querySelectorAll('.ps-t,.ps-u')].every(n=>n.scrollWidth<=n.clientWidth+1); return { disp:cs.display, w:r.width, h:r.height, bodyH:getComputedStyle(document.body).height, bodyOv:getComputedStyle(document.body).overflow, htmlOv:getComputedStyle(document.documentElement).overflow, vis, rows:[...new Set(rows)], heads:[...new Set(heads)], tgc, wide, bg:cs.backgroundColor, color:cs.color }; })()`);
  check('print media: sheet displayed with real size, everything else hidden', pr.disp === 'block' && pr.w > 300 && pr.h > 400 && pr.vis.length === 1 && pr.vis[0] === 'printSheet', S(pr));
  check('print media: html/body not clipped (overflow visible, height auto)', pr.htmlOv === 'visible' && pr.bodyOv === 'visible', S({ ov: [pr.htmlOv, pr.bodyOv], bodyH: pr.bodyH }));
  check('print media: rows never split (break-inside avoid), headings keep with next, URLs wrap (no overflow), tab-group colours differ', pr.rows.length === 1 && pr.rows[0] === 'avoid' && pr.heads.every((h) => h === 'avoid') && pr.wide && new Set(pr.tgc).size >= 2, S(pr));
  await shot('print-media-full', { captureBeyondViewport: true });
  // decode QR codes of the sheet
  const qrs = await ev(`(async()=>{ const out=[]; for (const q of [...document.querySelectorAll('#printSheet .ps-qr')].slice(0,3)) { const svg=q.querySelector('svg'); const s=new XMLSerializer().serializeToString(svg); const img=new Image(); img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s); await img.decode(); const c=document.createElement('canvas'); c.width=c.height=400; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,400,400); x.drawImage(img,0,0,400,400); const d=x.getImageData(0,0,400,400); out.push({ w:400, data:Array.from(d.data), url:q.closest('.ps-item').querySelector('.ps-u').textContent }); } return out; })()`);
  let okQ = 0; const qd = [];
  for (const q of qrs) { const r = jsqr(Uint8ClampedArray.from(q.data), q.w, q.w); qd.push(r ? r.data === q.url : false); if (r && r.data === q.url) okQ++; }
  check('print QR codes: 3 sampled .ps-qr svgs decode (jsqr) to the row address (incl. the long and the Thai-titled row)', qrs.length === 3 && okQ === 3, S(qd));
  const pdf = await pg.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  const pdfBuf = Buffer.from(pdf.result.data, 'base64');
  const pdfPath = path.join(SHOTS, 'print-sheet.pdf'); fs.writeFileSync(pdfPath, pdfBuf);
  const pages = (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('PDF: produced, non-trivial size, at least 1 page (A4)', pdfBuf.length > 8000 && pages >= 1, S({ bytes: pdfBuf.length, pages }));
  // open the PDF in Chrome's viewer and photograph it: proves the printed pages are not blank
  const t2 = await br.send('Target.createTarget', { url: 'file:///' + pdfPath.replace(/\\/g, '/') });
  await sleep(3500);
  const pt = (await J('/json/list')).find((t) => t.id === t2.result.targetId);
  if (pt) {
    const pv = await cdp(pt.webSocketDebuggerUrl); await pv.send('Page.enable');
    const imgB = Buffer.from((await pv.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64');
    fs.writeFileSync(path.join(SHOTS, 'print-pdf-viewer.png'), imgB);
    const im = decodePng(imgB); let dark = 0; for (let y = 0; y < im.h; y += 3) for (let x = 0; x < im.w; x += 3) { const c = im.px(x, y); if (c[0] < 90 && c[1] < 90 && c[2] < 90) dark++; }
    check('PDF viewer render: page shows dark text pixels (not blank)', dark > 300, 'darkSamples=' + dark);
    await br.send('Target.closeTarget', { targetId: t2.result.targetId });
  } else check('PDF viewer tab found', false);
  await pg.send('Page.bringToFront');
  await pg.send('Emulation.setEmulatedMedia', { media: '' }); await sleep(300);
  // printToPDF itself fires beforeprint/afterprint in Chrome: the real afterprint must already have cleaned up
  const realAfter = await ev(`!document.body.classList.contains('printing') && !document.getElementById('printSheet')`);
  console.log('INFO real afterprint after printToPDF cleaned up:', realAfter);
  await ev(`window.dispatchEvent(new Event('afterprint'))`); await sleep(300);
  check('afterprint: body.printing removed and #printSheet removed', (await ev(`!document.body.classList.contains('printing') && !document.getElementById('printSheet')`)));
  // second print with qr off and urls off: no svg, host only
  await openMenuAct(P, 'printGroup');
  await ev(`(()=>{ const cs=document.querySelectorAll('dialog.print-dlg input[type=checkbox]'); cs.forEach((c)=>{ if(c.checked) c.click(); }); document.querySelector('dialog.print-dlg .btn.primary').click(); })()`);
  await until(() => ev(`window.__printed.length>=2`), 8000);
  const st2 = await ev(`(()=>{ const s=document.getElementById('printSheet'); return { qr:s.querySelectorAll('.ps-qr').length, wins:s.querySelectorAll('.ps-win').length, tgs:s.querySelectorAll('.ps-tg').length, u:s.querySelector('.ps-u')?.textContent }; })()`);
  check('print options off: no QR, no window / tab-group headings, only the host under each title', st2.qr === 0 && st2.wins === 0 && st2.tgs === 0 && st2.u && !st2.u.includes('/'), S(st2));
  await ev(`window.dispatchEvent(new Event('afterprint'))`); await sleep(300);

  // ---------- (C) QR dialog ----------
  await ev(`__cmr.fn.expandAll(true)`); await sleep(1000); await reveal(Q);
  const rowSel = (u) => `.vrow.item[data-g="${Q}"]`;
  const rowRect = await ev(`(()=>{ const rows=[...document.querySelectorAll('.vrow.item:not([hidden])')].filter(n=>n.dataset.g==='${Q}'); const n=rows.find(x=>x.textContent.includes('QR target')); const r=n.getBoundingClientRect(); return { x:r.left+420, y:r.top+r.height/2 }; })()`);
  await rclick(rowRect.x, rowRect.y);
  const labels = await ev(`[...document.querySelectorAll('#ctxMenu .mitem')].map(b=>b.textContent.trim())`);
  check('ctx menu on a tab row has the QR item', labels.some((l) => /QR/i.test(l)), S(labels));
  await ev(`[...document.querySelectorAll('#ctxMenu .mitem')].find(b=>/QR/i.test(b.textContent)).click()`); await sleep(900);
  const qd2 = await ev(`(()=>{ const d=document.querySelector('dialog.qr-dlg'); if(!d) return null; const r=d.getBoundingClientRect(); const p=d.querySelector('.qd-pic').getBoundingClientRect(); return { open:d.open, pic:[Math.round(p.width),Math.round(p.height)], svg:!!d.querySelector('.qd-pic svg'), name:d.querySelector('.qd-name').textContent, url:d.querySelector('.qd-url').textContent, btns:[...d.querySelectorAll('.ld-f button')].map(b=>b.textContent.trim()), inside:r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth, focus:document.activeElement.className }; })()`);
  check('QR dialog: opens modal with large picture, title, url and Copy image / Save as image / Done', qd2 && qd2.open && qd2.svg && qd2.pic[0] >= 200 && qd2.name === 'QR target tab' && qd2.url === 'https://q.example.test/hello?x=1&y=2' && qd2.btns.length === 3 && qd2.inside, S(qd2));
  const decodeDlg = async () => { const d = await ev(`(async()=>{ const svg=document.querySelector('dialog.qr-dlg .qd-pic svg'); const s=new XMLSerializer().serializeToString(svg); const img=new Image(); img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s); await img.decode(); const c=document.createElement('canvas'); c.width=c.height=500; const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,500,500); x.drawImage(img,0,0,500,500); return Array.from(x.getImageData(0,0,500,500).data); })()`); const r = jsqr(Uint8ClampedArray.from(d), 500, 500); return r && r.data; };
  check('QR dialog: code decodes (jsqr) to the tab URL', (await decodeDlg()) === 'https://q.example.test/hello?x=1&y=2');
  await shot('qr-dialog-light'); await scheme('dark'); await shot('qr-dialog-dark'); await scheme('light');
  const dark = await ev(`(()=>{ const d=document.querySelector('dialog.qr-dlg .qd-pic'); return getComputedStyle(d).backgroundColor; })()`);
  await scheme('dark'); const darkPic = await ev(`getComputedStyle(document.querySelector('dialog.qr-dlg .qd-pic')).backgroundColor`); await scheme('light');
  check('QR dialog dark mode: picture keeps a white quiet zone (scannable)', dark === 'rgb(255, 255, 255)' && darkPic === 'rgb(255, 255, 255)', S({ dark, darkPic }));
  // Copy image
  const cp = await rect('dialog.qr-dlg .ld-f button:nth-child(1)'); await lclick(cp.cx, cp.cy);
  const tt = await ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent`);
  check('QR dialog: Copy image answers with a toast (copied or a friendly failure)', !!tt, tt);
  await key('Escape', 27);
  check('QR dialog: Esc closes it', !(await ev(`!!document.querySelector('dialog.qr-dlg')`)));
  await rclick(rowRect.x, rowRect.y); await ev(`[...document.querySelectorAll('#ctxMenu .mitem')].find(b=>/QR/i.test(b.textContent)).click()`); await sleep(800);
  const dn = await rect('dialog.qr-dlg .btn.primary'); await lclick(dn.cx, dn.cy);
  check('QR dialog: Done closes it', !(await ev(`!!document.querySelector('dialog.qr-dlg')`)));
  // too long: toast, no dialog, no crash
  await ev(`window.__errs=[]; addEventListener('error',(e)=>__errs.push(String(e.message))); addEventListener('unhandledrejection',(e)=>__errs.push('rej:'+String(e.reason)));`);
  const bigRect = await ev(`(()=>{ const rows=[...document.querySelectorAll('.vrow.item:not([hidden])')].filter(n=>n.dataset.g==='${Q}'); const n=rows.find(x=>x.textContent.includes('Too long')); const r=n.getBoundingClientRect(); return { x:r.left+420, y:r.top+r.height/2 }; })()`);
  await ev(`document.getElementById('toast').hidden=true`);
  await rclick(bigRect.x, bigRect.y); await ev(`[...document.querySelectorAll('#ctxMenu .mitem')].find(b=>/QR/i.test(b.textContent)).click()`); await sleep(900);
  const longRes = await ev(`({ dlg: !!document.querySelector('dialog.qr-dlg'), toast: document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent, errs: window.__errs })`);
  check('QR dialog: URL over 2953 bytes -> toast, no dialog, no script error', !longRes.dlg && longRes.toast.length > 3 && longRes.errs.length === 0, S(longRes));
  await shot('qr-too-long-toast-light');
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nprint-qr-regression: ${failures} FAILED` : '\nprint-qr-regression: all passed');
process.exit(failures ? 1 : 0);
