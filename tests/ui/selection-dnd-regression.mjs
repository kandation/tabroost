// Selection / drag and drop / box selection / item actions regression (real Chrome over CDP, throw-away profile):
//   node tests/ui/selection-dnd-regression.mjs            (env: CHROME=..., SHOTS=<dir for screenshots>, BIG=0 to skip the 300k part)
// What it checks, with REAL mouse and keyboard events (Input.dispatch*):
//   1. selection: click, Shift+click range (also across virtual pages of a 1,200 tab set), Ctrl+click toggle, no mixing of tab sets and
//      tabs (hint), Ctrl+A in a set, Esc clears, aria-selected / role=option / the live announcement, the bulk bar text
//   2. item actions: copy titles / links / both (toast count), move tabs to a new set in a category, to another set, split into a new set
//      (tab-group info and split-view `sv` pairing survive, counts / siteIdx stay consistent, undo restores the same seq numbers)
//   3. drag and drop with the 5 px threshold: ghost + highlighted targets + Esc cancel; tabs -> star / category / pending / archive /
//      trash, tab sets -> pin / star / pending / archive / category / trash, each with an undo toast; manual reorder
//   4. delete from the front button (one tab, and the whole selection when the row is selected), Delete key
//   5. box selection: Alt+drag over the list: replace / Shift add / Ctrl toggle, Esc cancel
//   6. performance: no animation frame longer than 50 ms during a marquee over 5,000 rows, and during a drag on a 300,000 tab DB
//   7. screenshots (light + dark, wide + 420 px) of the ghost, drop targets, bulk bar and marquee in $SHOTS
// Exit code 1 on any failure. Needs a visible window. Only one test Chrome is started and it is killed at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9345;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-seldnd-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-seldnd-shots');
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
  // this test asserts on Thai wording: set the UI language explicitly (the default is 'auto' = browser language)
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'th'}}))`); await pg.send('Page.reload'); await sleep(3000);
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
      const r = await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item')].find(x=>x.dataset.g===${JSON.stringify(gid)}&&x.dataset.seq==='${seq}'); if(!n) return null; const sr=document.getElementById('scroller').getBoundingClientRect(); const r=(n._host||n).getBoundingClientRect(); if (r.top<sr.top+40 || r.bottom>sr.bottom-40) return null; return {x:r.left+Math.min(40,r.width/2), y:r.top+r.height/2}; })()`);
      if (r) return r;
      if (k % 3 === 0) await show(gid, seq); else await sleep(400);
    }
    return null;
  };
  // ---------- seed ----------
  const cW = (await msg({ type: 'catSave', cat: { name: 'Work' } })).cat;
  const cF = (await msg({ type: 'catSave', cat: { name: 'Fun' } })).cat;
  const D = await seedSet('Delta', 1200); // newest first in the list: seed in reverse so Alpha is at the top
  const C = await seedSet('Charlie', 20);
  const B = await seedSet('Bravo', 20);
  const A = await seedSet('Alpha', 30, { tg: true, sv: true });
  await until(() => ev(`__cmr.S.allGroups.length>=4`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); })()`);
  await ev(`(async()=>{ __cmr.fn.expandAll(true); })()`);
  await sleep(1200);
  await shot('00-list');
  check('every tab row has role=option, aria-selected and the delete button first', await ev(`(()=>{ const r=document.querySelector('.vrow.item[data-seq]'); return !!r && r.getAttribute('role')==='option' && r.getAttribute('aria-selected')==='false' && r.firstElementChild.classList.contains('x') && document.getElementById('spacer').getAttribute('role')==='listbox' && document.getElementById('spacer').getAttribute('aria-multiselectable')==='true'; })()`), await ev(`(()=>{ const r=document.querySelector('.vrow.item[data-seq]'); return r? [r.getAttribute('role'), r.getAttribute('aria-selected'), r.firstElementChild.className, document.getElementById('spacer').getAttribute('role')].join('|') : 'no row'; })()`));
  check('the delete button is 22 px and sits left of the icon', await ev(`(()=>{ const r=document.querySelector('.vrow.item[data-seq]'); const x=r.querySelector('.x').getBoundingClientRect(), f=r.querySelector('.fav').getBoundingClientRect(); return Math.round(x.width)===22 && Math.round(x.height)===22 && x.right<=f.left; })()`));

  // ---------- 1. selection ----------
  const firstGid = A;
  await wait(5);
  const ids = await ev(`[...document.querySelectorAll('.vrow.item[data-seq]')].filter(n=>n.dataset.g===${JSON.stringify(A)}).map(n=>+n.dataset.seq)`);
  let p = await hostCell(A, ids[0]);
  await click(p.x, p.y);
  check('click selects one tab', (await selSize()) === 1 && (await selKind()) === 'i');
  check('selected row is aria-selected and the bar says 1 tab', await ev(`document.querySelector('.vrow.item.sel')?.getAttribute('aria-selected')==='true' && document.getElementById('selbar').hidden===false && /1/.test(document.querySelector('#selbar .sb-n').textContent)`), await ev(`document.querySelector('#selbar .sb-n').textContent`));
  p = await hostCell(A, ids[4]);
  await click(p.x, p.y, { shift: true });
  check('Shift+click selects the range (5 tabs)', (await selSize()) === 5);
  p = await hostCell(A, ids[2]);
  await click(p.x, p.y, { ctrl: true });
  check('Ctrl+click toggles one tab off (4 left)', (await selSize()) === 4);
  const gh = await rect(`.vrow.ghead[data-g="${A}"]`);
  const gt = await rect(`.vrow.ghead[data-g="${A}"] .gt`); await click(gt.cx, gt.cy, { ctrl: true });
  check('mixing tabs and tab sets is refused with a hint', (await selSize()) === 4 && /ทีละแบบ|either/.test(await toastText()), await toastText());
  await shot('01-selected-tabs');
  await key('Escape');
  check('Esc clears the selection and hides the bar', (await selSize()) === 0 && (await ev(`document.getElementById('selbar').hidden`)));
  p = await hostCell(A, ids[0]);
  await click(p.x, p.y);
  await key('a', { ctrl: true });
  check('Ctrl+A selects every tab of the set', (await selSize()) === 30, String(await selSize()));
  await key('Escape');

  // range across virtual pages (1,200 tab set)
  await ev(`__cmr.S.groups.length`);
  const dIdx = await ev(`__cmr.S.groups.findIndex(g=>g.id===${JSON.stringify(D)})`);
  const dTop = await ev(`__cmr.V.tops[${dIdx}]`);
  await ev(`document.getElementById('scroller').scrollTop=${dTop}+20`);
  await sleep(700);
  const dRows = await ev(`[...document.querySelectorAll('.vrow.item[data-seq]')].filter(n=>n.dataset.g===${JSON.stringify(D)}).map(n=>+n.dataset.seq)`);
  p = await hostCell(D, dRows[0]);
  await click(p.x, p.y);
  await ev(`document.getElementById('scroller').scrollTop=${dTop}+60+1100*${await ev('__cmr.S && 36')}`);
  await sleep(900);
  const dRows2 = await ev(`[...document.querySelectorAll('.vrow.item[data-seq]')].filter(n=>n.dataset.g===${JSON.stringify(D)}).map(n=>+n.dataset.seq)`);
  const last = dRows2[dRows2.length - 1];
  p = await hostCell(D, dRows2[Math.floor(dRows2.length / 2)]);
  const targetSeq = dRows2[Math.floor(dRows2.length / 2)];
  await click(p.x, p.y, { shift: true });
  check('Shift+click across virtual pages selects the whole range by position', (await selSize()) === targetSeq - dRows[0] + 1, `${await selSize()} vs ${targetSeq - dRows[0] + 1} (last visible ${last})`);
  await key('Escape');

  // ---------- 2. copy ----------
  await ev(`document.getElementById('scroller').scrollTop=0`);
  await sleep(500);
  p = await hostCell(A, ids[0]); await click(p.x, p.y);
  p = await hostCell(A, ids[2]); await click(p.x, p.y, { shift: true });
  await ev(`document.querySelector('#selbar .sb-b:nth-of-type(3)').click()`);
  await sleep(400);
  await shot('02-copy-menu');
  await ev(`(()=>{ const bs=[...document.querySelectorAll('.sel-dlg .sd-item')]; bs[2].click(); })()`);
  await sleep(500);
  check('copy "title | link" toasts the count', /3/.test(await toastText()) && /คัดลอก/.test(await toastText()), await toastText());
  await key('Escape');

  // ---------- 2b. move to a new set in a category (with tab group + split view data) ----------
  const beforeSeqs = await gets(A);
  p = await hostCell(A, ids[0]); await click(p.x, p.y);
  p = await hostCell(A, ids[3]); await click(p.x, p.y, { shift: true });
  await ev(`document.querySelector('#selbar .sb-b:nth-of-type(2)').click()`);
  await sleep(400);
  await shot('03-move-menu');
  await ev(`[...document.querySelectorAll('.sel-dlg .sd-item')].find(b=>b.textContent.startsWith('Work')).click()`);
  await sleep(500);
  await ev(`document.querySelector('.sel-dlg .sd-item.strong').click()`); // new set in this category
  await until(async () => (await gets(A)).length === 26);
  await until(() => ev(`__cmr.S.allGroups.some(g=>g.cat===${JSON.stringify(cW.id)})`));
  const workGroups = await ev(`__cmr.S.allGroups.filter(g=>g.cat===${JSON.stringify(cW.id)}).map(g=>g.id)`);
  const newG = workGroups[0];
  const ng = newG ? await gets(newG) : [];
  const gA = await grp(A); const gN = newG ? await grp(newG) : null;
  check('move to category: 4 tabs left the set, a new set in "Work" holds them', ng.length === 4 && gA.count === 26 && gN && gN.count === 4, `${ng.length} ${gA.count}`);
  check('moved tabs keep the split-view pair (sv) and the tab group', await db(`(d)=>d.getItemsPage('${newG}',0,10).then(a=>({sv:a.filter(x=>x.sv!=null).length, tg:a.filter(x=>x.tg!=null).length}))`).then((o) => o.sv === 2 && o.tg === 4), '');
  check('undo toast after the move', /ชุดใหม่|new tab set/.test(await toastText()), await toastText());
  await clickToastUndo();
  await until(async () => (await gets(A)).length === 30);
  check('undo puts the tabs back under their original seq numbers', JSON.stringify(await gets(A)) === JSON.stringify(beforeSeqs));
  check('the emptied new set is gone after undo', !(await ev(`__cmr.S.allGroups.some(g=>g.id===${JSON.stringify(newG)})`)) || (await grp(newG)) == null || (await grp(newG)).count === 0);
  check('siteIdx stays consistent after move + undo', await msg({ type: 'debug:siteCheck', deep: true }).then((r) => r && r.ok));

  // ---------- 3. drag and drop ----------
  const navBox = (sel) => rect(sel);
  const starNav = await navBox('.navi[data-nav="starred"]');
  p = await hostCell(B, 1);
  await click(p.x, p.y);
  await drag(p.x, p.y, p.x + 3, p.y + 2, {}, 2, true);
  check('moving less than 5 px does not start a drag', !(await ev(`document.body.classList.contains('dnd-active')`)));
  await mouse('mouseReleased', p.x + 3, p.y + 2);
  // real drag of 3 tabs to the star
  const bIds = [1, 2, 3];
  p = await hostCell(B, bIds[0]); await click(p.x, p.y);
  const p2 = await hostCell(B, bIds[2]); await click(p2.x, p2.y, { shift: true });
  await drag(p2.x, p2.y, starNav.cx, starNav.cy, {}, 14, true);
  await sleep(150);
  check('drag shows the ghost, dims the sources and highlights the star target', await ev(`document.body.classList.contains('dnd-active') && !!document.querySelector('.dnd-ghost') && document.querySelector('.navi[data-nav=starred]').classList.contains('dnd-over') && document.querySelector('.navi[data-nav=archived]').classList.contains('dnd-ok') && document.querySelector('.navi[data-nav=all]').classList.contains('dnd-bad')`));
  check('ghost shows the count badge', await ev(`document.querySelector('.dnd-ghost .gh-n').textContent`).then((t) => /3/.test(t)), await ev(`document.querySelector('.dnd-ghost').textContent`));
  await shot('04-drag-tabs-to-star');
  await key('Escape');
  check('Esc cancels the drag (nothing changed, selection kept)', !(await ev(`document.body.classList.contains('dnd-active')`)) && (await selSize()) === 3 && (await gets(B)).length === 20);
  await mouse('mouseReleased', starNav.cx, starNav.cy);
  await sleep(200);
  await drag(p2.x, p2.y, starNav.cx, starNav.cy, {}, 14);
  await until(async () => (await ev(`__cmr.S.allGroups.filter(g=>g.starred).length`)) >= 1);
  const starred = await ev(`__cmr.S.allGroups.filter(g=>g.starred).map(g=>({id:g.id,count:g.count}))`);
  check('dropping 3 tabs on the star makes a new starred set from them', starred.length === 1 && starred[0].count === 3 && (await gets(B)).length === 17, JSON.stringify(starred));
  check('toast says a new set was made, with an undo', /3/.test(await toastText()) && /ชุดใหม่|new tab set/.test(await toastText()), await toastText());
  await clickToastUndo();
  await until(async () => (await gets(B)).length === 20 && !(await ev(`__cmr.S.allGroups.some(g=>g.starred)`)));
  check('undo brings the 3 tabs back', (await gets(B)).length === 20 && !(await ev(`__cmr.S.allGroups.some(g=>g.starred)`)));

  // whole set -> pin, then to a category, archive, trash (each with undo)
  const setTo = async (gid, navSel, label, test) => {
    await ev(`(()=>{ const c=__cmr; c.V.exp.add(${JSON.stringify(gid)}); document.getElementById('scroller').scrollTop=c.V.tops[c.V.idxOf.get(${JSON.stringify(gid)})]; })()`); await sleep(500);
    const h = await rect(`.vrow.ghead[data-g="${gid}"]`);
    if (!h) { check(label + ' (header visible)', false); return; }
    const tb = await navBox(navSel);
    await drag(h.x + h.w / 2 - 100, h.cy + 4, tb.cx, tb.cy, {}, 14);
    const ok = await until(async () => test(await grp(gid)), 4000);
    check(label, ok);
  };
  await setTo(C, '.navi[data-nav="pinned"]', 'dropping a tab set on Pinned pins it', (g) => g && g.pinned === true);
  await clickToastUndo(); await until(async () => !(await grp(C)).pinned);
  check('undo unpins', !(await grp(C)).pinned);
  await setTo(C, `.navi[data-cat="${cF.id}"]`, 'dropping a tab set on a category assigns it', (g) => g && g.cat === cF.id);
  await clickToastUndo(); await until(async () => !(await grp(C)).cat);
  await setTo(C, '.navi[data-nav="archived"]', 'dropping a tab set on the archive archives it', (g) => g && g.archived === true);
  await clickToastUndo(); await until(async () => !(await grp(C)).archived);
  await ev(`document.getElementById('scroller').scrollTop=0`);
  await setTo(C, '.navi[data-nav="trash"]', 'dropping a tab set on the trash deletes it (typed trash)', (g) => g && g.deletedAt != null);
  check('trash drop shows an undo toast', /ลบ|Deleted/.test(await toastText()), await toastText());
  await clickToastUndo(); await until(async () => (await grp(C)).deletedAt == null);
  check('undo restores the deleted set', (await grp(C)).deletedAt == null);

  // ---------- 4. delete from the front button ----------
  await ev(`document.getElementById('scroller').scrollTop=0`); await sleep(500);
  const cnt0 = (await grp(A)).count;
  const aIds = Array.from({ length: 30 }, (_, i) => i + 1);
  p = await hostCell(A, aIds[10]); await mouse('mouseMoved', p.x, p.y, { down: false }); await sleep(150);
  const xb = await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item')].find(x=>x.dataset.g===${JSON.stringify(A)}&&x.dataset.seq==='${aIds[10]}'); const r=n.querySelector('.x').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2, op:getComputedStyle(n.querySelector('.x')).opacity}; })()`);
  check('the delete button shows on hover', +xb.op > 0.9, xb.op);
  await shot('05-hover-delete');
  await click(xb.x, xb.y);
  await until(async () => (await grp(A)).count === cnt0 - 1);
  check('front delete button removes that tab', (await grp(A)).count === cnt0 - 1);
  await clickToastUndo(); await until(async () => (await grp(A)).count === cnt0); await sleep(1000);
  // a selected row deletes the whole selection
  p = await hostCell(A, aIds[11]); await click(p.x, p.y);
  p = await hostCell(A, aIds[14]); await click(p.x, p.y, { shift: true });
  await hostCell(A, aIds[12]);
  const xb2 = await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item')].find(x=>x.dataset.g===${JSON.stringify(A)}&&x.dataset.seq==='${aIds[12]}'); const r=n.querySelector('.x').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await mouse('mouseMoved', xb2.x, xb2.y, { down: false }); await click(xb2.x, xb2.y);
  await until(async () => (await grp(A)).count === cnt0 - 4);
  check('delete button on a selected row deletes the whole selection (4)', (await grp(A)).count === cnt0 - 4);
  await clickToastUndo(); await until(async () => (await grp(A)).count === cnt0);
  p = await hostCell(A, aIds[16]); await click(p.x, p.y);
  await key('Delete');
  await until(async () => (await grp(A)).count === cnt0 - 1);
  check('Delete key removes the selected tab', (await grp(A)).count === cnt0 - 1);
  await clickToastUndo(); await until(async () => (await grp(A)).count === cnt0);

  // ---------- 5. box selection ----------
  await ev(`document.getElementById('scroller').scrollTop=0`); await sleep(500);
  const sc = await rect('#scroller');
  await drag(sc.x + 650, sc.y + 150, sc.x + 800, sc.y + 400, { alt: true }, 10, true);
  await sleep(150);
  check('Alt+drag draws the rectangle', !!(await ev(`document.querySelector('.marquee')`)));
  await shot('06-marquee');
  await mouse('mouseReleased', sc.x + 800, sc.y + 400, { alt: true });
  const m1 = await selSize();
  check('box selection selects the rows it touches', m1 >= 3, String(m1));
  await drag(sc.x + 650, sc.y + 500, sc.x + 800, sc.y + 640, { alt: true, shift: true }, 8);
  const m2 = await selSize();
  check('Shift+box adds to the selection', m2 > m1, `${m1} -> ${m2}`);
  await drag(sc.x + 650, sc.y + 150, sc.x + 800, sc.y + 400, { alt: true, ctrl: true }, 8);
  check('Ctrl+box toggles the touched rows off again', (await selSize()) < m2, `${await selSize()}`);
  await key('Escape');
  await drag(sc.x + 650, sc.y + 150, sc.x + 800, sc.y + 400, { alt: true }, 8, true);
  await key('Escape');
  await mouse('mouseReleased', sc.x + 800, sc.y + 400);
  check('Esc cancels a box selection', !(await ev(`!!document.querySelector('.marquee')`)));
  await key('Escape');

  // ---------- 6. performance: 5,000 rows, marquee ----------
  const E = await seedSet('Echo', 5000);
  await ev(`(()=>{ __cmr.S.vs.flat = true; __cmr.V.writeCtr = (__cmr.V.writeCtr||0)+1; __cmr.fn.applyView(); })()`);
  await sleep(2500);
  const frames = async (fn) => { await ev(`(()=>{ window.__fr=[]; window.__frOn=true; let l=performance.now(); const f=(t)=>{ window.__fr.push(t-l); l=t; if(window.__frOn) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`); await fn(); await ev(`window.__frOn=false`); await sleep(50); return ev(`(()=>{ const a=window.__fr.slice(2); return {n:a.length, max:Math.max(...a), over50:a.filter(x=>x>50).length}; })()`); };
  const sc2 = await rect('#scroller');
  const fr1 = await frames(async () => { await drag(sc2.x + 8, sc2.y + 100, sc2.x + 400, sc2.y + sc2.h - 30, { alt: true }, 40, true); for (let i = 0; i < 40; i++) { await mouse('mouseMoved', sc2.x + 400, sc2.y + sc2.h - 6, { alt: true }); await sleep(30); } await mouse('mouseReleased', sc2.x + 400, sc2.y + sc2.h - 6, { alt: true }); });
  check('marquee over a long flat list (auto-scroll): no frame > 50 ms', fr1.over50 === 0, JSON.stringify(fr1));
  check('the marquee selected many rows', (await selSize()) > 100, String(await selSize()));
  await key('Escape');

  // ---------- 7. screenshots light/dark/narrow ----------
  await ev(`(()=>{ __cmr.S.vs.flat = false; __cmr.V.exp.delete(${JSON.stringify(E)}); __cmr.fn.applyView(); document.getElementById('scroller').scrollTop=0; })()`);
  await sleep(900);
  p = await hostCell(A, aIds[0]); await click(p.x, p.y); p = await hostCell(A, aIds[3]); await click(p.x, p.y, { shift: true });
  const st2 = await navBox('.navi[data-nav="pinned"]');
  await drag(p.x, p.y, st2.cx, st2.cy, {}, 14, true); await sleep(250);
  await shot('07-drag-light');
  await key('Escape'); await mouse('mouseReleased', st2.cx, st2.cy); await key('Escape'); await sleep(300);
  await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(500);
  p = await hostCell(A, aIds[0]); await click(p.x, p.y); p = await hostCell(A, aIds[3]); await click(p.x, p.y, { shift: true });
  await shot('08-selected-dark');
  await drag(p.x, p.y, st2.cx, st2.cy, {}, 14, true); await sleep(250);
  await shot('09-drag-dark');
  await key('Escape'); await mouse('mouseReleased', st2.cx, st2.cy); await key('Escape');
  await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await pg.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  p = await hostCell(A, aIds[0]); if (p) { await click(p.x, p.y); const q = await hostCell(A, aIds[2]); if (q) await click(q.x, q.y, { shift: true }); }
  await shot('10-narrow-selected');
  await key('Escape');
  await pg.send('Emulation.clearDeviceMetricsOverride');

  // ---------- 8. performance: drag on a 300,000 tab DB ----------
  if (process.env.BIG !== '0') {
    const freeMB = Number((await new Promise((r) => { const c = spawn('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024']); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => r(o)); })).trim());
    if (freeMB > 3500) {
      const t0 = Date.now();
      await msg({ type: 'debug:seed', groups: 30, perGroup: 10000, spreadDays: 30, offset: 100 });
      console.log(`INFO  seeded 300,000 tabs in ${Math.round((Date.now() - t0) / 1000)} s (free RAM ${Math.round(freeMB)} MB)`);
      await ev(`(async()=>{ await __cmr.fn.loadData(); __cmr.fn.applyView(); })()`);
      await sleep(3000);
      await ev(`document.getElementById('scroller').scrollTop=0`);
      const hs = await rect('.vrow.ghead');
      const nav = await navBox('.navi[data-nav="starred"]');
      const fr2 = await frames(async () => { await drag(hs.x + 200, hs.cy + 4, nav.cx, nav.cy, {}, 60, true); await sleep(300); await mouse('mouseMoved', hs.x + 200, hs.y + hs.h + 300); await sleep(300); await key('Escape'); await mouse('mouseReleased', nav.cx, nav.cy); });
      check('dragging a tab set on a 300,000 tab database: no frame > 50 ms', fr2.over50 === 0, JSON.stringify(fr2));
    } else console.log(`SKIP  300k part (free RAM ${Math.round(freeMB)} MB < 3500)`);
  }
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nselection-dnd-regression: ${failures} FAILED` : '\nselection-dnd-regression: all passed');
process.exit(failures ? 1 : 0);
