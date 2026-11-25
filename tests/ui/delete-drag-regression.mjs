// Drag-to-trash regression (real Chrome over CDP): dragging tab rows onto the trash target removes rows, leaves no gap, undo restores.
//   node tests/ui/delete-drag-regression.mjs  (cases: one tab, last tab of a set, several selected, all tabs of a set, flat view, search active)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9347;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-deldrag-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-deldrag-shots');
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
  const db = (expr) => ev(`(async()=>{ const db = await import('./lib/db.js'); return JSON.stringify(await (${expr})(db)); })()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await fn()) return true; await sleep(150); } return false; };
  const shot = async (name) => { const r = await pg.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const mods = (m) => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.shift ? 8 : 0);
  const mouse = (type, x, y, o = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers: mods(o), ...(type === 'mouseMoved' && o.down === false ? { buttons: 0 } : {}) });
  const click = async (x, y, o = {}) => { await mouse('mouseMoved', x, y, { ...o, down: false }); await mouse('mousePressed', x, y, o); await mouse('mouseReleased', x, y, o); await sleep(60); };
  const drag = async (x0, y0, x1, y1, o = {}, steps = 12, hold = false) => {
    await mouse('mouseMoved', x0, y0, { ...o, down: false }); await mouse('mousePressed', x0, y0, o);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, o); await sleep(16); }
    if (!hold) { await mouse('mouseReleased', x1, y1, o); await sleep(120); }
  };
  const key = async (k, o = {}, code = k) => { const vk = { Escape: 27, Delete: 46, ArrowDown: 40, ArrowUp: 38, Enter: 13 }[k] || k.toUpperCase().charCodeAt(0); await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods(o) }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods(o) }); await sleep(80); };
  const rect = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}; })()`);
  const selSize = () => ev(`__cmr.sel.sel.size`);
  const selKind = () => ev(`__cmr.sel.sel.kind`);
  const toastText = () => ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent`);
  const clickToastUndo = () => ev(`(()=>{ const b=document.getElementById('toastAction'); if(b.hidden) return false; b.click(); return true; })()`);
  const gets = (gid) => db(`(d)=>d.getItemsPage('${gid}',0,5000).then(a=>a.map(x=>x.seq))`);
  const grp = (gid) => db(`(d)=>d.getGroup('${gid}')`);
  const seedSet = async (title, n, extra = {}) => {
    const g = (await msg({ type: 'debug:seedGroup', title, ...(extra.tg ? { tabGroups: [{ i: 0, title: 'TG', color: 'blue', collapsed: false }] } : {}) })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: n }, (_, i) => ({ url: `https://${'abc'[i % 3]}.example.test/${title}/${i}`, title: `${title} tab ${i}`, ...(extra.tg ? { tg: i < 6 ? 0 : -1 } : {}), ...(extra.sv && i < 2 ? { sv: 0 } : {}) })) });
    await msg({ type: 'debug:seedDone', gid: g });
    return g;
  };
  const wait = (n) => until(() => ev(`document.querySelectorAll('.vrow.item[data-seq]').length >= ${n}`));
  const rowBox = (title, n) => rect(`.vrow.item[data-g="${title}"][data-seq="${n}"]`);
  const show = async (gid, seq) => { await ev(`(()=>{ const c=__cmr, i=c.V.idxOf.get(${JSON.stringify(gid)}); const sc=document.getElementById('scroller'); sc.scrollTop=Math.max(0, c.V.tops[i] + (c.V.bucketAt[i]?c.H.bucket:0) + c.H.group + (${seq || 1}-1)*c.H.item - 260); })()`); await sleep(500); };
  const hostCell = async (gid, seq) => {
    for (let k = 0; k < 8; k++) {
      const r = await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item')].find(x=>!x.hidden&&x.dataset.g===${JSON.stringify(gid)}&&x.dataset.seq==='${seq}'); if(!n) return null; const sr=document.getElementById('scroller').getBoundingClientRect(); const r=(n._host||n).getBoundingClientRect(); if (r.top<sr.top+40 || r.bottom>sr.bottom-40) return null; return {x:r.left+Math.min(40,r.width/2), y:r.top+r.height/2}; })()`);
      if (r) return r;
      if (k % 3 === 0) await show(gid, seq); else await sleep(400);
    }
    return null;
  };
  const navBox = (sel) => rect(sel);
  // layout sanity: visible rows are contiguous (no gap) and the scroll height matches V.total
  const layoutState = () => ev(`(()=>{ const c=__cmr, sc=document.getElementById('scroller'), sp=document.getElementById('spacer'); const sr=sc.getBoundingClientRect(); const lo=sr.top, hi=Math.min(sr.bottom, sp.getBoundingClientRect().bottom); const rows=[...document.querySelectorAll('#spacer .vrow:not([hidden])')].map(n=>{const r=n.getBoundingClientRect(); return [Math.max(lo,r.top), Math.min(hi,r.bottom)];}).filter(x=>x[1]>x[0]).sort((a,b)=>a[0]-b[0]); let cur=lo, maxGap=0; for(const [t,b] of rows){ maxGap=Math.max(maxGap,t-cur); cur=Math.max(cur,b);} maxGap=Math.max(maxGap,hi-cur); return {n:rows.length, maxGap:Math.round(maxGap), total:c.V.total, sh:sp.offsetHeight}; })()`);
  const rowsOf = (gid) => ev(`[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].filter(n=>n.dataset.g===${JSON.stringify(gid)}).map(n=>+n.dataset.seq)`);
  const hdr = (g) => ev(`!!document.querySelector('.vrow.ghead:not([hidden])[data-g="${g}"]')`);
  const reexp = async (g) => { await ev(`(()=>{ __cmr.V.exp.add(${JSON.stringify(g)}); __cmr.fn.relayout(); })()`); await sleep(700); };
  const rowEls = () => ev(`document.querySelectorAll('.vrow.item[data-seq]:not([hidden])').length`);
  const dropTrash = async (from, o = {}) => { const tb = await navBox('.navi[data-nav="trash"]'); await drag(from.x, from.y, tb.cx, tb.cy, o, 14); await sleep(1100); };
  const A = await seedSet('Alpha', 6);
  const B = await seedSet('Bravo', 1);
  const C = await seedSet('Charlie', 8);
  await until(() => ev(`__cmr.S.allGroups.length>=3`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); })()`);
  await ev(`(async()=>{ __cmr.fn.expandAll(true); })()`);
  await sleep(1200);
  const noGap = async (label) => { const s = await layoutState(); check(label + ': no gap between rows, spacer height = V.total', s.maxGap <= 2 && Math.abs(s.total - s.sh) <= 2, JSON.stringify(s)); return s; };

  // 1. one tab of a multi-tab expanded set
  let p = await hostCell(A, 3);
  await dropTrash(p);
  check('1. dragged tab leaves the DB', !(await gets(A)).includes(3), JSON.stringify(await gets(A)));
  check('1. its row is gone from the DOM', !(await rowsOf(A)).includes(3), JSON.stringify(await rowsOf(A)));
  await noGap('1');
  check('1. selection cleared', (await selSize()) === 0);
  await clickToastUndo(); await until(async () => (await gets(A)).includes(3)); await sleep(1000);
  check('1. undo restores the tab row', (await rowsOf(A)).includes(3), JSON.stringify(await rowsOf(A)));

  // 2. the only tab of a one-tab set
  p = await hostCell(B, 1);
  await dropTrash(p);
  check('2. last tab: set soft-deleted', (await grp(B)).deletedAt != null);
  check('2. its row and header are gone', (await rowsOf(B)).length === 0 && !(await hdr(B)), JSON.stringify(await rowsOf(B)));
  await noGap('2');
  await clickToastUndo(); await until(async () => (await grp(B)).deletedAt == null); await sleep(1000);
  await reexp(B); check('2. undo restores the set and its tab', !!(await hdr(B)) && (await rowsOf(B)).includes(1), JSON.stringify(await rowsOf(B)));

  // 2b. the last survivor of a bigger set
  for (const s of [1, 2, 3, 4, 5]) await msg({ type: 'deleteItems', groupId: A, seqs: [s] });
  await sleep(1200);
  p = await hostCell(A, 6);
  await dropTrash(p);
  check('2b. last survivor of a set: row + header gone', (await rowsOf(A)).length === 0 && !(await hdr(A)), JSON.stringify(await rowsOf(A)));
  await noGap('2b');
  await clickToastUndo(); await until(async () => (await grp(A)).deletedAt == null); await sleep(800);

  // 3. several selected tabs
  p = await hostCell(C, 2); await click(p.x, p.y);
  const p4 = await hostCell(C, 4); await click(p4.x, p4.y, { shift: true });
  check('3. 3 tabs selected', (await selSize()) === 3);
  await dropTrash(p4);
  const left = await gets(C);
  check('3. three tabs deleted from the DB', left.length === 5 && ![2, 3, 4].some((s) => left.includes(s)), JSON.stringify(left));
  check('3. their rows are gone', !(await rowsOf(C)).some((s) => [2, 3, 4].includes(s)), JSON.stringify(await rowsOf(C)));
  await noGap('3');
  await clickToastUndo(); await until(async () => (await gets(C)).length === 8); await sleep(1000);
  check('3. undo restores all three rows', (await rowsOf(C)).length === 8, JSON.stringify(await rowsOf(C)));

  // 3b. every tab of a set selected and dragged
  p = await hostCell(C, 1); await click(p.x, p.y);
  await key('a', { ctrl: true });
  const selN = await selSize();
  const pl = await hostCell(C, 5);
  await dropTrash(pl);
  check('3b. all tabs of a set dragged: set gone, no leftover rows', (await grp(C)).deletedAt != null && (await rowsOf(C)).length === 0 && !(await hdr(C)), 'sel=' + selN + ' ' + JSON.stringify(await rowsOf(C)));
  await noGap('3b');
  await clickToastUndo(); await until(async () => (await grp(C)).deletedAt == null); await sleep(1000);
  await reexp(C); check('3b. undo restores set rows', (await rowsOf(C)).length === 8, JSON.stringify(await rowsOf(C)));

  // 4. flat all-tabs view
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1800);
  check('4. flat view shows tab rows', (await rowEls()) >= 10, String(await rowEls()));
  const total0 = await ev(`__cmr.V.fl && __cmr.V.fl.obj.total`);
  p = await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')][2]; const r=(n._host||n).getBoundingClientRect(); return {x:r.left+40,y:r.top+r.height/2,g:n.dataset.g,s:+n.dataset.seq}; })()`);
  await dropTrash(p); await sleep(600);
  check('4. flat: row gone', !(await ev(`[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].some(n=>n.dataset.g===${JSON.stringify(p.g)}&&+n.dataset.seq===${p.s})`)));
  check('4. flat: total shrank by 1', (await ev(`__cmr.V.fl.obj.total`)) === total0 - 1, total0 + ' -> ' + (await ev(`__cmr.V.fl.obj.total`)));
  await noGap('4');
  await clickToastUndo(); await sleep(1800);
  check('4. flat: undo restores total', (await ev(`__cmr.V.fl.obj.total`)) === total0, String(await ev(`__cmr.V.fl.obj.total`)));
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1200);

  // 5. search active (reload so the search worker indexes the seeded tabs)
  await pg.send('Page.reload'); await sleep(3500); await until(() => ev(`__cmr.SRCH.status.state==='ready' && __cmr.SRCH.status.docs>=15`), 30000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); __cmr.fn.expandAll(true); })()`); await sleep(1200);
  await ev(`(()=>{ const i=document.getElementById('search'); i.focus(); i.value='Charlie tab'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(() => ev(`__cmr.V.mode==='search' && __cmr.V.srows.length>=4`), 15000); await sleep(1200); console.log('INFO search', await ev(`JSON.stringify({m:__cmr.V.mode,q:__cmr.S.query,st:__cmr.SRCH.status.state,docs:__cmr.SRCH.status.docs,cur:!!__cmr.SRCH.cur,rows:__cmr.V.srows.length,info:document.getElementById('searchInfo').textContent})`));
  const hits = await ev(`document.querySelectorAll('.vrow.item:not([hidden])').length`);
  p = await ev(`(()=>{ const n=document.querySelectorAll('.vrow.item:not([hidden])')[1]; if(!n) return null; const r=n.getBoundingClientRect(); return {x:r.left+78,y:r.top+r.height/2,k:n._key,t:n.textContent.slice(0,40)}; })()`);
  check('5. search shows hits', hits >= 4 && !!p, String(hits));
  if (p) {
    await dropTrash(p); await sleep(900);
    const after = await ev(`document.querySelectorAll('.vrow.item:not([hidden])').length`);
    check('5. search: hit list shrank by 1 (no stale row / gap)', after === hits - 1, hits + ' -> ' + after + ' ' + JSON.stringify(p));
    await noGap('5');
    await clickToastUndo(); await sleep(1500);
    check('5. search: undo brings the hit back', (await ev(`document.querySelectorAll('.vrow.item:not([hidden])').length`)) === hits);
  }
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\ndelete-drag-regression: ${failures} FAILED` : '\ndelete-drag-regression: all passed');
process.exit(failures ? 1 : 0);
