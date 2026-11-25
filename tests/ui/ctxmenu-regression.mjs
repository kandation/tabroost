// Context menu / archive / marquee / column-layout / sidebar-icon regression (real Chrome over CDP).
//   node tests/ui/ctxmenu-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9362;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-ctxmenu-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-ctxmenu-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  return { send: (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed');
  await br.send('Target.createTarget', { url: `chrome-extension://${ld.result.id}/stash.html?t=1`, newWindow: true, width: 1400, height: 900 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 500)); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await fn()) return true; await sleep(150); } return false; };
  const shot = async (name) => { const r = await pg.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const scheme = (s) => pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] });
  const mouse = (type, x, y, o = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : (o.button || 'left'), buttons: type === 'mouseReleased' ? 0 : (o.buttons ?? 1), clickCount: 1, modifiers: o.mod || 0 });
  const rclick = async (x, y, mod = 0) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y, { button: 'right', buttons: 2, mod }); await mouse('mouseReleased', x, y, { button: 'right', mod }); await sleep(400); };
  const lclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(300); };
  const key = async (k, vk) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await sleep(250); };
  const rect = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}; })()`);
  const strip = (s) => JSON.stringify(s);
  const metrics = (w, h) => pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);

  const mkSet = async (title, items, extra = {}) => {
    const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g;
  };
  const plain = (title, n) => Array.from({ length: n }, (_, i) => ({ url: `https://${'abc'[i % 3]}.example.test/${title.replace(/ /g, '')}/${i}`, title: `${title} tab ${i} with a fairly long title` }));
  const A = await mkSet('Zeta stash', plain('Zeta stash', 4));
  const B = await mkSet('Archive me', plain('Archive me', 3));
  const tgs = [{ i: 0, title: 'Research', color: 'blue', collapsed: false, windowIdx: 1 }, { i: 1, title: 'Shopping', color: 'orange', collapsed: false, windowIdx: 2 }];
  const wi = [
    { url: 'https://a.example.test/1', title: 'Alpha one', w: 1, ws: true, tg: 0 }, { url: 'https://a.example.test/2', title: 'Alpha two', w: 1, tg: 0 }, { url: 'https://b.example.test/3', title: 'Plain three', w: 1 },
    { url: 'https://c.example.test/4', title: 'Plain four starts window two', w: 2, ws: true }, { url: 'https://d.example.test/5', title: 'Shop five', w: 2, tg: 1 }, { url: 'https://d.example.test/6', title: 'Shop six', w: 2, tg: 1 }, { url: 'https://e.example.test/7', title: 'Plain seven', w: 2 },
  ];
  const W = await mkSet('Windows and groups', wi, { tabGroups: tgs, windowCount: 2 });
  await until(() => ev(`__cmr.S.allGroups.length>=3`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); __cmr.fn.expandAll(true); })()`); await sleep(1500);
  const vp = await ev(`({w:innerWidth,h:innerHeight})`);
  const ctxState = () => ev(`(()=>{ const m=document.getElementById('ctxMenu'); const r=m.getBoundingClientRect(); return { hidden:m.hidden, x:r.left, y:r.top, r:r.right, b:r.bottom, big:!!m.querySelector('.ctxbig'), labels:[...m.querySelectorAll('.mitem')].map(b=>b.textContent.trim()) }; })()`);
  const toastText = () => ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent`);
  const gheadIn = (g) => ev(`[...document.querySelectorAll('.vrow.ghead:not([hidden])')].some(n=>n.dataset.g==='${g}')`);

  // 1. context menu on an item row
  const ir = await rect(`.vrow.item[data-g="${A}"][data-seq]:not([hidden])`);
  const px = ir.x + 400, py = ir.cy;
  await rclick(px, py);
  let c = await ctxState();
  check('ctx item: menu open, near the pointer, inside the viewport', !c.hidden && c.x >= px - 16 && c.x <= px + 40 && ((c.y >= py - 16 && c.y <= py + 40) || Math.abs(c.b - py) <= 8) && c.r <= vp.w && c.b <= vp.h, strip({ px, py, c }));
  check('ctx item: big Copy tile first + Copy link/title/Open present', c.big && c.labels[0] === 'Copy' && ['Copy link', 'Copy title', 'Open'].every((l) => c.labels.includes(l)), strip(c.labels));
  await shot('ctx-item-light'); await scheme('dark'); await sleep(500); await shot('ctx-item-dark'); await scheme('light'); await sleep(300);
  const cl = await ev(`(()=>{ const b=[...document.querySelectorAll('#ctxMenu .mitem')].find(x=>x.textContent.trim()==='Copy link'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await lclick(cl.x, cl.y);
  c = await ctxState();
  const tt = await toastText();
  check('ctx item: Copy link closes the menu and shows a toast', c.hidden && !!tt, 'toast=' + tt);
  await key('Escape', 27);
  // menu near the bottom-right corner stays inside the viewport
  await rclick(vp.w - 6, vp.h - 6);
  c = await ctxState();
  check('ctx: pointer in a corner (empty area) opens nothing or stays inside viewport', c.hidden || (c.r <= vp.w && c.b <= vp.h), strip(c));

  // 1b. every Copy entry puts the right text on the real clipboard (read back), toasts, and closes the menu
  await br.send('Browser.grantPermissions', { origin: `chrome-extension://${ld.result.id}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  // record what the page writes (reading the system clipboard back is unreliable when the window is not focused)
  await ev(`(()=>{ if (window.__clipRec) return; window.__clipRec = true; const w = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (t) => { window.__lastClip = String(t); return w(t); }; const w2 = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = async (items) => { try { const b = await items[0].getType('text/plain'); window.__lastClip = await b.text(); } catch {} return w2(items); }; })()`);
  const clip = () => ev(`window.__lastClip !== undefined ? window.__lastClip : navigator.clipboard.readText().catch((e) => 'ERR ' + e.message)`);
  const seed = () => ev(`navigator.clipboard.writeText('SENTINEL')`);
  await ev(`(()=>{ const st=document.createElement('style'); st.id='noBarTest'; st.textContent='.selbar { display: none !important; }'; document.head.appendChild(st); return true; })()`);
  const unsel = () => ev(`__cmr.sel.clear()`);
  const rowPt = async (g, seq) => { // scrolled to the middle, measured twice (the list settles after a scroll)
    const q = `(()=>{ const n=[...document.querySelectorAll('.vrow.item[data-g="${g}"][data-seq]:not([hidden])')].find(x=>x._key.endsWith(':${seq}')); if(!n) return null; n.scrollIntoView({block:'center'}); const r=n.getBoundingClientRect(); return {x:r.left+400,y:r.top+r.height/2}; })()`;
    await ev(q); await sleep(1000); return ev(q);
  };
  const copyVia = async (pt, label, expectOpen = true) => {
    await seed();
    for (let tries = 0; tries < 3; tries++) { await rclick(pt.x, pt.y); if (!(await ctxState()).hidden) break; }
    const open = !(await ctxState()).hidden;
    const b = await ev(`(()=>{ const b=[...document.querySelectorAll('#ctxMenu .mitem')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    if (!open || !b) return { open, clip: 'NOBTN', toast: '', hidden: true };
    await lclick(b.x, b.y); await sleep(500);
    return { open, clip: await clip(), toast: await toastText(), hidden: (await ctxState()).hidden };
  };
  const u = (i) => `https://${'abc'[i % 3]}.example.test/Zetastash/${i}`, ti = (i) => `Zeta stash tab ${i} with a fairly long title`;
  await msg({ type: 'saveSettings', patch: { copyFormat: 'urlTitle' } }); await sleep(600);
  const p1 = await rowPt(A, 1);
  let r;
  r = await copyVia(p1, 'Copy'); check('ctx copy: big Copy on a tab follows the Copy format setting (url | title), not just the link', r.clip === `${u(1)} | ${ti(1)}` && r.hidden && /1/.test(r.toast), strip(r));
  await unsel(); r = await copyVia(p1, 'Copy link'); check('ctx copy: Copy link = url only', r.clip === u(1) && r.hidden && !!r.toast, strip(r));
  await unsel(); r = await copyVia(p1, 'Copy title'); check('ctx copy: Copy title = title only', r.clip === ti(1) && r.hidden && !!r.toast, strip(r));
  await unsel(); r = await copyVia(p1, 'Copy title | link'); check('ctx copy: Copy title | link = "title | url"', r.clip === `${ti(1)} | ${u(1)}` && r.hidden && !!r.toast, strip(r));
  await msg({ type: 'saveSettings', patch: { copyFormat: 'titleUrl' } }); await sleep(600);
  await unsel(); r = await copyVia(p1, 'Copy'); check('ctx copy: big Copy honours copyFormat=titleUrl', r.clip === `${ti(1)} | ${u(1)}`, strip(r));
  await msg({ type: 'saveSettings', patch: { copyFormat: 'urlTitle' } }); await sleep(600);
  // several tabs selected, right-click one of them: every selected tab is copied
  const selKeys = (ks) => ev(`(()=>{ const s=__cmr.sel.sel; s.select(${JSON.stringify(ks[0])},'one'); ${JSON.stringify(ks.slice(1))}.forEach((k)=>s.select(k,'add')); return s.size; })()`);
  const fullKey = (i) => ev(`[...document.querySelectorAll('.vrow.item[data-g="${A}"][data-seq]')].map(n=>n._key).find(k=>k.endsWith(':${i}'))`);
  await unsel(); const k0 = await fullKey(0), k2 = await fullKey(2);
  await selKeys([k0, k2]); const p2 = await rowPt(A, 2);
  r = await copyVia(p2, 'Copy link'); check('ctx copy: 2 tabs selected, Copy link on one = both links, toast says 2', r.clip.replace(/\r/g, '') === `${u(0)}\n${u(2)}` && /2/.test(r.toast) && r.hidden, strip(r));
  await selKeys([k0, k2]);
  r = await copyVia(await rowPt(A, 2), 'Copy title | link'); check('ctx copy: 2 tabs selected, Copy title | link = both lines', r.clip.replace(/\r/g, '') === `${ti(0)} | ${u(0)}\n${ti(2)} | ${u(2)}`, strip(r));
  await selKeys([k0, k2]);
  r = await copyVia(await rowPt(A, 2), 'Copy'); check('ctx copy: 2 tabs selected, big Copy = both lines', r.clip.replace(/\r/g, '') === `${u(0)} | ${ti(0)}\n${u(2)} | ${ti(2)}`, strip(r));
  // right-click a row OUTSIDE the selection: the selection moves to that row, only it is copied
  await selKeys([k0, k2]); const p3 = await rowPt(A, 3);
  r = await copyVia(p3, 'Copy link'); check('ctx copy: right-click a row outside the selection copies only that row', r.clip === u(3) && /1/.test(r.toast) && (await ev(`__cmr.sel.sel.size`)) === 1, strip(r));
  // a whole tab set (header): big Copy copies the whole set, with the toast
  await unsel(); await ev(`document.querySelector('.vrow.ghead[data-g="${A}"]').scrollIntoView({block:'center'})`); await sleep(900);
  const hA = await rect(`.vrow.ghead[data-g="${A}"]`);
  r = await copyVia({ x: hA.x + 500, y: hA.cy }, 'Copy'); check('ctx copy: big Copy on a tab set header copies every tab of the set', r.clip.replace(/\r/g, '') === [0, 1, 2, 3].map((i) => `${u(i)} | ${ti(i)}`).join('\n') && r.hidden && !!r.toast, strip(r).slice(0, 300));
  await unsel(); await ev(`document.getElementById('noBarTest').remove()`);
  await key('Escape', 27); await ev(`document.querySelector('.vrow.item[data-g="${A}"][data-seq]:not([hidden])') && document.getElementById('scroller')?.scrollTo(0, 0)`); await sleep(500);

  // 2. context menu on a set header
  const hr = await rect(`.vrow.ghead[data-g="${B}"]`);
  await rclick(hr.x + 500, hr.cy);
  c = await ctxState();
  check('ctx set: menu open with Archive entry, inside viewport', !c.hidden && c.labels.some((l) => /archive/i.test(l)) && c.r <= vp.w && c.b <= vp.h, strip(c.labels));
  await shot('ctx-set-light'); await scheme('dark'); await sleep(500); await shot('ctx-set-dark'); await scheme('light'); await sleep(300);
  await key('Escape', 27);
  check('ctx: Escape closes it', (await ctxState()).hidden);
  await rclick(hr.x + 500, hr.cy, 8); // Shift: the browser menu stays
  check('ctx: Shift+right-click does not open the custom menu', (await ctxState()).hidden);

  // 3. item columns: order in the DOM + alignment, plain / in tab group / multi-window / flat; hover shows x + copy without layout shift
  const ord = await ev(`(()=>{ const n=document.querySelector('.vrow.item[data-g="${A}"][data-seq]:not([hidden])'); const kids=[...n.children]; const idx=(sel)=>kids.findIndex(k=>k.matches(sel)||k.querySelector(sel)); return { x:idx('[data-act="delItem"]'), copy:idx('[data-act="copyTab"]'), fav:idx('.fav'), n:kids.length }; })()`);
  check('copy button is before .fav, delete button before copy', ord.copy >= 0 && ord.fav > ord.copy && ord.x >= 0 && ord.x < ord.copy, strip(ord));
  const cols = (g) => ev(`[...document.querySelectorAll('.vrow.item[data-g="${g}"][data-seq]:not([hidden])')].map(n=>{ const q=(s)=>{ const e=n.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return Math.round(r.left); }; return { x:q('[data-act="delItem"]'), cp:q('[data-act="copyTab"]'), fav:q('.fav'), t:q('.ilink'), cls:n.className.replace(/vrow item ?/,'') }; })`);
  const spread = (rows, k) => { const v = rows.map((r) => r[k]).filter((z) => z != null); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
  const cA = await cols(A);
  check('plain rows: x, copy, favicon, title left edges aligned across rows', ['x', 'cp', 'fav', 't'].every((k) => spread(cA, k) <= 1), strip(cA.slice(0, 2)));
  { const lk = await ev(`(()=>{ const rows=[...document.querySelectorAll('.vrow.item[data-g="${A}"][data-seq]:not([hidden])')]; if(rows.length<2) return null; const left=(n)=>Math.round(n.querySelector('.ilink').getBoundingClientRect().left); const w=(n)=>Math.round(n.querySelector('.ilink').getBoundingClientRect().width); const a=left(rows[0]), wa=w(rows[0]); rows[1]._x.hidden=true; const r={ same: left(rows[1])===a, wsame: Math.abs(w(rows[1])-wa)<=1 }; rows[1]._x.hidden=false; return r; })()`);
  check('locked row (x hidden) keeps the same title column as other rows', !!lk && lk.same && lk.wsame, strip(lk)); }
  const cW = await cols(W);
  const xs = cW.map((r) => r.x), fv = cW.map((r) => r.fav);
  console.log('INFO multiwin columns ' + strip(cW));
  check('multi-window rows: x, copy, favicon, title columns identical for plain, in-group and window rows', ['x', 'cp', 'fav', 't'].every((k) => spread(cW, k) <= 1), strip(cW));
    const geo = (sel) => ev(`(()=>{ const n=document.querySelector(${JSON.stringify(sel)}); const r=n.getBoundingClientRect(); const o={}; for (const [k,s] of [['x','[data-act="delItem"]'],['cp','[data-act="copyTab"]'],['fav','.fav'],['t','.ilink']]) { const e=n.querySelector(s); const b=e.getBoundingClientRect(); o[k]=[Math.round(b.left),Math.round(b.width), getComputedStyle(e).opacity, getComputedStyle(e).visibility]; } o.h=r.height; return o; })()`);
  const rsel = `.vrow.item[data-g="${A}"][data-seq]:not([hidden])`;
  await mouse('mouseMoved', 5, 5, { buttons: 0 }); await sleep(200);
  const before = await geo(rsel);
  const rr = await rect(rsel); await mouse('mouseMoved', rr.x + 500, rr.cy, { buttons: 0 }); await sleep(400);
  const hov = await geo(rsel);
  check('hover: x and copy become visible, no layout shift of favicon/title', +hov.x[2] > 0.5 && +hov.cp[2] > 0.5 && before.fav[0] === hov.fav[0] && before.t[0] === hov.t[0] && before.h === hov.h, strip({ before, hov }));
  // flat view
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1800);
  const flat = await ev(`[...document.querySelectorAll('.vrow.item.fl:not([hidden])')].slice(0,4).map(n=>{ const q=(s)=>{ const e=n.querySelector(s); return e? Math.round(e.getBoundingClientRect().left):null; }; return [q('[data-act="delItem"]'),q('[data-act="copyTab"]'),q('.fav'),q('.ilink')]; })`);
  check('flat view: columns aligned across rows', flat.length > 1 && [0, 1, 2, 3].every((k) => new Set(flat.map((r) => r[k])).size === 1), strip(flat));
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1500);
  await ev(`__cmr.fn.expandAll(true)`); await sleep(800);

  // 3b. multi-window session: a whitespace band + small label at each window start, both densities, 1400 and 1000, light and dark
  const bandInfo = () => ev('[...document.querySelectorAll(".vrow.note.win:not([hidden])")].map((n)=>({ text:n.textContent.trim(), h:Math.round(n.getBoundingClientRect().height) }))');
  for (const dens of ['comfortable', 'compact']) {
    await msg({ type: 'saveSettings', patch: { density: dens } }); await sleep(1200);
    for (const w of [1400, 1000]) {
      await metrics(w, 900); await sleep(700); await ev('__cmr.fn.relayout && __cmr.fn.relayout()'); await sleep(900);
      const bi = await bandInfo();
      check('window label rows (' + dens + ', ' + w + '): one labelled row per window start', bi.length >= 2 && bi.every((r) => r.text.length > 0 && r.h >= 12), strip(bi));
      const cw = await cols(W);
      check('columns aligned across plain / in-group / window-start rows (' + dens + ', ' + w + ')', ['x', 'cp', 'fav', 't'].every((k) => spread(cw, k) <= 1), strip(cw.map((r) => [r.x, r.cp, r.fav, r.t])));
      for (const sch of ['light', 'dark']) { await scheme(sch); await sleep(400); await shot('multiwin-' + dens + '-' + w + '-' + sch); }
      await scheme('light');
    }
  }
  await msg({ type: 'saveSettings', patch: { density: 'comfortable' } }); await metrics(1000, 800); await sleep(900);
  await shot('narrow-1000-sidebar-light'); await scheme('dark'); await sleep(400); await shot('narrow-1000-sidebar-dark'); await scheme('light');
  await metrics(1400, 900); await sleep(800);

  // 4. archive button
  await ev(`document.querySelector('.vrow.ghead[data-g="${B}"] [data-act="archive"]').click()`); await sleep(1200);
  check('archive: set leaves the main list, toast with undo shown', !(await gheadIn(B)) && !!(await toastText()) && (await ev(`!document.getElementById('toastAction').hidden`)), await toastText());
  await ev(`document.querySelector('.navi[data-nav="archived"]').click()`); await sleep(1200);
  check('archive: set listed under the Archived nav', await gheadIn(B));
  await ev(`document.querySelector('.navi[data-nav="all"]').click()`); await sleep(800);
  await pg.send('Page.reload'); await sleep(3500); await until(() => ev(`__cmr.SRCH.status.state==='ready' && __cmr.SRCH.status.docs>=7`), 30000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); })()`);
  await ev(`(()=>{ const i=document.getElementById('search'); i.focus(); i.value='Archive me tab'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(() => ev(`__cmr.V.mode==='search' && __cmr.V.srows.length>=1`), 15000); await sleep(1200);
  const labels = await ev(`[...document.querySelectorAll('.vrow.item:not([hidden])')].map(n=>n.textContent.trim().slice(0,90))`);
  check('search: hits of an archived set carry the Archived prefix', labels.length > 0 && labels.every((t) => t.includes('Archived')), strip(labels));
  await shot('search-archived-light');
  await ev(`(()=>{ const i=document.getElementById('search'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(1000);
  await ev(`document.querySelector('.navi[data-nav="archived"]').click()`); await sleep(1000);
  await ev(`document.querySelector('.vrow.ghead[data-g="${B}"] [data-act="archive"]').click()`); await sleep(800);
  await ev(`document.querySelector('.navi[data-nav="all"]').click()`); await sleep(1000);
  check('archive: button toggles back (set in main list again)', await gheadIn(B));

  // 5. marquee from the bucket label, no text selection
  await ev(`__cmr.fn.expandAll(true)`); await sleep(1000);
  const lb = await ev(`(()=>{ const n=document.querySelector('.vrow.bucket:not([hidden])'); if(!n) return null; const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT); let t; while((t=w.nextNode())) if(t.textContent.trim()){ const r=document.createRange(); r.selectNodeContents(t); const b=r.getBoundingClientRect(); return {x:b.left+4,y:b.top+b.height/2,text:t.textContent.trim()}; } return null; })()`);
  check('marquee: a date bucket label exists', !!lb, strip(lb));
  if (lb) {
    await mouse('mouseMoved', lb.x, lb.y, { buttons: 0 }); await mouse('mousePressed', lb.x, lb.y);
    for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', lb.x + i * 25, lb.y + i * 22); await sleep(20); }
    const mid = await ev(`({ box: !!document.querySelector('.marquee'), sel: window.getSelection().toString() })`);
    await mouse('mouseReleased', lb.x + 300, lb.y + 264); await sleep(300);
    const after = await ev(`({ sel: window.getSelection().toString(), n: __cmr.sel.sel.size })`);
    check('marquee: dragging from the "' + lb.text + '" label draws the box', mid.box, strip(mid));
    check('marquee: no text selected, rows got selected', mid.sel === '' && after.sel === '' && after.n > 0, strip(after));
    await key('Escape', 27);
  }


  // 5b. marquee from the header area, the left margin strip, and not from the search box
  const dragBox = async (x0, y0, x1, y1) => { await mouse('mouseMoved', x0, y0, { buttons: 0 }); await mouse('mousePressed', x0, y0); for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12); await sleep(20); } const mid = await ev('({ box: !!document.querySelector(".marquee"), sel: window.getSelection().toString() })'); await mouse('mouseReleased', x1, y1); await sleep(300); const n = await ev('__cmr.sel.sel.size'); await key('Escape', 27); return { ...mid, n }; };
  const title = await ev('(()=>{ const e=document.querySelector("#main h1, #main .title, #viewTitle"); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,t:e.textContent}; })()');
  if (title) { const rs = await dragBox(title.x, title.y, title.x + 150, title.y + 380); check('marquee: drag starting on the page title draws a box, no text selected', rs.box && rs.sel === '', strip({ title, rs })); } else check('marquee: page title found', false);
  const lst = await rect('.vrow.item[data-seq]:not([hidden])');
  const mx = Math.max(2, lst.x - 8);
  const rm = await dragBox(mx, lst.y + 4, mx + 300, lst.y + 160);
  check('marquee: drag from the margin strip left of the list draws a box and selects rows', rm.box && rm.sel === '' && rm.n > 0, strip({ mx, lstx: lst.x, rm }));
  const sb = await rect('#search');
  await ev('(()=>{ const i=document.getElementById("search"); i.focus(); i.value="selectable words here"; i.dispatchEvent(new Event("input",{bubbles:true})); })()'); await sleep(900);
  const sb2 = await rect('#search');
  await mouse('mouseMoved', sb2.x + 70, sb2.cy, { buttons: 0 }); await mouse('mousePressed', sb2.x + 70, sb2.cy);
  for (let i = 1; i <= 8; i++) { await pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sb2.x + 70 + i * 14, y: sb2.cy, button: 'left', buttons: 1 }); await sleep(20); }
  const mq = await ev('!!document.querySelector(".marquee")');
  await mouse('mouseReleased', sb2.x + 190, sb2.cy); await sleep(200);
  const selTxt = await ev('(()=>{ const i=document.getElementById("search"); return i.value.slice(i.selectionStart,i.selectionEnd); })()');
  console.log('INFO sb', strip(await ev('(()=>{const i=document.getElementById("search");return {ae:document.activeElement.id,v:i.value,a:i.selectionStart,b:i.selectionEnd}})()')), strip(sb2));
  check('search box: drag-selecting text works and starts no marquee', !mq && selTxt.length >= 3, strip({ mq, selTxt }));
  await ev('(()=>{ const i=document.getElementById("search"); i.value=""; i.dispatchEvent(new Event("input",{bubbles:true})); i.blur(); })()'); await sleep(800);

  // 6. sidebar folder icons
  const catIco = await ev(`({ rows:document.querySelectorAll('#catList > *').length, ico:document.querySelectorAll('#catList svg.catico').length, uncat: !!document.querySelector('.navi[data-nav="uncat"] svg.catico'), noTitle:[...document.querySelectorAll('.navi[data-nav]')].filter(n=>!n.title).map(n=>n.dataset.nav) })`);
  check('sidebar: uncategorised row has svg.catico; every catList row has one', catIco.uncat && catIco.ico === catIco.rows, strip(catIco));
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nctxmenu-regression: ${failures} FAILED` : '\nctxmenu-regression: all passed');
process.exit(failures ? 1 : 0);
