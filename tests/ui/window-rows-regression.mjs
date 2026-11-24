// Window label rows (multi-window sessions): layout, merge/undo, other views, keyboard, marquee (real Chrome over CDP).
//   node tests/ui/window-rows-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9363;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-winrows-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-winrows-shots');
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
  const mouse = (type, x, y, o = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const key = async (k, vk) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }); await sleep(200); };
  const strip = (s) => JSON.stringify(s);
  const metrics = (w, h) => pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);
  const mkSet = async (title, items, extra = {}) => {
    const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g;
  };
  const it = (p, n, w, tg) => Array.from({ length: n }, (_, i) => ({ url: `https://${p}.example.test/${i}`, title: `${p} tab ${i}`, w, ...(i === 0 ? { ws: true } : {}), ...(tg != null ? { tg } : {}) }));
  // S1: two windows, no tab groups. S2: two windows + two tab groups. S3: 2 x 45 tabs (scroll length), no groups
  const S1 = await mkSet('NoGroups', [...it('n1', 4, 1), ...it('n2', 4, 2)], { windowCount: 2 });
  const tgs = [{ i: 0, title: 'Research', color: 'blue', collapsed: false, windowIdx: 1 }, { i: 1, title: 'Shopping', color: 'orange', collapsed: false, windowIdx: 2 }];
  const S2 = await mkSet('WithGroups', [...it('g1', 3, 1, 0), { url: 'https://g1.example.test/p', title: 'g1 plain', w: 1 }, ...it('g2', 3, 2, 1), { url: 'https://g2.example.test/p', title: 'g2 plain', w: 2 }], { windowCount: 2, tabGroups: tgs });
  const S3 = await mkSet('LongOne', [...it('l1', 45, 1), ...it('l2', 45, 2)], { windowCount: 2 });
  await until(() => ev(`__cmr.S.allGroups.length>=3`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); __cmr.fn.expandAll(true); })()`); await sleep(1800);
  const sc = `document.getElementById('scroller')`;
  const winRows = (g) => ev(`[...document.querySelectorAll('.vrow.note.win:not([hidden])')].map(n=>({t:(n.textContent.match(/Window [0-9]+/)||[''])[0], top:Math.round(n.getBoundingClientRect().top), h:Math.round(n.getBoundingClientRect().height)}))`);
  const wrows = () => ev(`[...document.querySelectorAll('.vrow.note.win:not([hidden])')].length`);
  // geometry sanity of everything on screen: no two rows overlap, none hidden under another
  const overlap = () => ev(`(()=>{ const rs=[...document.querySelectorAll('#spacer .vrow:not([hidden]):not(._skel)')].map(n=>{const r=n.getBoundingClientRect(); return {k:n.className.slice(0,28)+'|'+(n.dataset.seq||''), t:r.top, b:r.bottom};}).filter(r=>r.b-r.t>2).sort((a,b)=>a.t-b.t); let bad=[]; for(let i=1;i<rs.length;i++) if (rs[i].t < rs[i-1].b - 1.5) bad.push([rs[i-1].k, rs[i].k, Math.round(rs[i-1].b-rs[i].t)]); return {n:rs.length, bad:bad.slice(0,4)}; })()`);
  const totals = () => ev(`({ tot: __cmr.V.total, sh: document.getElementById('spacer').offsetHeight, wgap: getComputedStyle(document.documentElement).getPropertyValue('--h-wgap').trim() })`);
  const toTop = async (gid, off = 0) => { await ev(`(()=>{ const c=__cmr, i=c.V.idxOf.get(${JSON.stringify(gid)}); const sc=document.getElementById('scroller'); sc.scrollTop=Math.max(0, c.V.tops[i] + (c.V.bucketAt[i]?c.H.bucket:0) - 20 + ${off}); })()`); await sleep(600); };
  // labels + order inside one session (DOM order by y): label -> [sub] -> items
  const orderOf = (gid) => ev(`(()=>{ const heads=[...document.querySelectorAll('.vrow.ghead:not([hidden])')].map(n=>({g:n.dataset.g,t:n.getBoundingClientRect().top,b:n.getBoundingClientRect().bottom})).sort((x,y)=>x.t-y.t); const me=heads.find(h=>h.g==='${gid}'); const nx=me?heads.find(h=>h.t>me.t):null; const lo=me?me.b-1:-1e9, hi=nx?nx.t+1:1e9; const q=[...document.querySelectorAll('#spacer .vrow:not([hidden])')].map(n=>({n,y:n.getBoundingClientRect().top})).filter(({n,y})=>y>=lo&&y<hi&&(n.classList.contains('win')||(n.dataset.g==='${gid}'&&(n.classList.contains('item')||n.classList.contains('sub'))))).map(({n,y})=>({y,k:n.classList.contains('win')?'W:'+(n.textContent.match(/Window [0-9]+/)||[''])[0]:n.classList.contains('sub')?'S:'+n.dataset.tg:'i:'+n.dataset.seq})).sort((a,b)=>a.y-b.y); return q.map(x=>x.k); })()`);

  // (1) labels before each window; with and without tab groups
  await toTop(S1); const o1 = await orderOf(S1);
  const iW = o1.map((k, i) => k.startsWith('W:') ? i : -1).filter((i) => i >= 0);
  check('S1 (no tab groups): "Window 1" label before the first item, "Window 2" between item 4 and 5', o1.includes('W:Window 1') && o1.includes('W:Window 2') && o1.indexOf('W:Window 1') < o1.indexOf('i:1') && o1.indexOf('W:Window 2') > o1.indexOf('i:4') && o1.indexOf('W:Window 2') < o1.indexOf('i:5'), strip(o1));
  const ov1 = await overlap(); check('S1: no overlapping rows', ov1.bad.length === 0, strip(ov1));
  const wr1 = await winRows(); const wr1b = wr1.find((r) => r.t === 'Window 1');
  check('S1: label row has the --h-wgap height', wr1b && wr1b.h >= 28 && wr1b.h <= 36, strip(wr1));
  await toTop(S2); const o2 = await orderOf(S2);
  check('S2 (tab groups): order Window 1, Research header, items, plain, Window 2, Shopping header, items', strip(o2.filter((k) => k !== '')) === strip(['W:Window 1', 'S:0', 'i:1', 'i:2', 'i:3', 'i:4', 'W:Window 2', 'S:1', 'i:5', 'i:6', 'i:7', 'i:8']), strip(o2));
  const ov2 = await overlap(); check('S2: no overlapping rows', ov2.bad.length === 0, strip(ov2));
  await shot('win-01-light-comfortable'); await scheme('dark'); await sleep(400); await shot('win-02-dark-comfortable'); await scheme('light');
  // total height: sum of what the DOM says = V.total; scroll to the very bottom reaches the last item
  const tt = await totals(); check('spacer height equals V.total', Math.abs(tt.tot - tt.sh) <= 2, strip(tt));
  await ev(`${sc}.scrollTop = 1e9`); await sleep(900);
  const last = await ev(`(()=>{ const sc=${sc}; const sr=sc.getBoundingClientRect(); const rows=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')]; const lr=rows.filter(n=>n.dataset.g==='${S1}'||true).sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top)[0]; const r=lr.getBoundingClientRect(); return { seq:lr.dataset.seq, g:lr.dataset.g, bottom:r.bottom, viewBottom:sr.bottom, sh:sc.scrollHeight, st:sc.scrollTop, ch:sc.clientHeight }; })()`);
  check('scrolled to the bottom: last row fully visible (no cut-off from a wrong height)', last.bottom <= last.viewBottom + 2 && last.st + last.ch >= last.sh - 2 && last.viewBottom - last.bottom < 80, strip(last));
  // fast scrolling over the long session: no overlaps / gaps / stale label rows afterwards
  let worst = 0, badSeen = 0;
  for (let k = 0; k < 14; k++) { await ev(`${sc}.scrollTop = Math.floor(Math.random()*Math.max(1,${sc}.scrollHeight-${sc}.clientHeight))`); await sleep(45); const o = await overlap(); if (o.bad.length) badSeen++; }
  await sleep(500); const oF = await overlap();
  check('fast random scrolling: rows never overlap after settling', badSeen === 0 && oF.bad.length === 0, strip({ badSeen, oF }));
  await toTop(S3, 0); await sleep(300);
  const o3 = await orderOf(S3); const w3 = o3.filter((k) => k.startsWith('W:'));
  console.log('INFO S3 start ' + strip(o3.slice(0, 5)) + ' labels=' + strip(w3));
  check('S3 long session: Window 1 label first; Window 2 label appears after scrolling to the window boundary', o3[0] === 'W:Window 1', strip(o3.slice(0, 3)));
  await toTop(S3, 45 * 38 + 34 - 100); const o3b = await orderOf(S3);
  const k3 = o3b.indexOf('W:Window 2');
  check('S3: Window 2 label sits between the last tab of window 1 (i:45) and the first of window 2 (i:46)', k3 > 0 && o3b[k3 - 1] === 'i:45' && o3b[k3 + 1] === 'i:46', strip(o3b));
  const sinceLabels = await ev(`[...document.querySelectorAll('.vrow.note.win:not([hidden])')].map(n=>(n.textContent.match(/Window [0-9]+/)||[''])[0])`);
  check('virtual list: no duplicated "Window 1" label rows alive', sinceLabels.filter((t) => t === 'Window 1').length <= 3, strip(sinceLabels));

  // (2) merge: labels disappear, heights shrink; undo brings them back
  await toTop(S2); await sleep(300);
  const h0 = await ev(`__cmr.V.total`); const lab0 = await wrows();
  const r1 = await msg({ type: 'reshapeGroup', groupId: S2, merge: true }); await sleep(1800);
  const h1 = await ev(`__cmr.V.total`); const lab1 = await ev(`[...document.querySelectorAll('.vrow.note.win:not([hidden])')].filter(n=>n.textContent).length`);
  const o2m = await orderOf(S2); const ov2m = await overlap();
  check('merge (S2): its label rows are gone', !o2m.some((k) => k.startsWith('W:')) && lab1 < lab0 + 99, strip(o2m));
  check('merge (S2): list height shrank by 2 label rows', h0 - h1 >= 55 && h0 - h1 <= 70, strip({ h0, h1 }));
  check('merge (S2): no overlapping rows, no stale rows', ov2m.bad.length === 0, strip(ov2m));
  await shot('win-03-merged-light');
  await msg(r1.undo); await sleep(1800); await toTop(S2);
  const h2 = await ev(`__cmr.V.total`); const o2u = await orderOf(S2);
  check('undo (S2): height and label rows are back', h2 === h0 && o2u.filter((k) => k.startsWith('W:')).length === 2, strip({ h0, h2, o2u }));
  // merge of the group without tab groups (runs disappear completely)
  const hn0 = await ev(`__cmr.V.total`);
  const r2 = await msg({ type: 'reshapeGroup', groupId: S1, merge: true }); await sleep(1800); await toTop(S1);
  const on1 = await orderOf(S1); const hn1 = await ev(`__cmr.V.total`);
  check('merge (S1, no tab groups): labels gone, height shrank by 2 rows, items still all there', !on1.some((k) => k.startsWith('W:')) && hn0 - hn1 >= 55 && on1.filter((k) => k.startsWith('i:')).length === 8, strip({ hn0, hn1, on1 }));
  await msg(r2.undo); await sleep(1800); await toTop(S1);
  check('undo (S1): labels back', (await orderOf(S1)).filter((k) => k.startsWith('W:')).length === 2 && (await ev(`__cmr.V.total`)) === hn0);

  // (3) other views show no window rows: flat, search, group-by tab group
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1800);
  check('flat view: no window label rows', (await ev(`document.querySelectorAll('.vrow.note.win:not([hidden])').length`)) === 0);
  await ev(`document.getElementById('btnFlat').click()`); await sleep(1500);
  await ev(`(()=>{ __cmr.S.vs.groupBy='tabgroup'; __cmr.fn.applyView(); })()`); await sleep(2500);
  const gb = await ev(`({ win: document.querySelectorAll('.vrow.note.win:not([hidden])').length, rows: document.querySelectorAll('.vrow:not([hidden])').length })`);
  const ovg = await overlap();
  await toTop(S2); const ogb = await orderOf(S2);
  check('group-by tab group view: the tab-group views of a session carry no window label rows, no overlap', !ogb.some((k) => k.startsWith('W:')) && gb.rows > 3 && ovg.bad.length === 0, strip({ gb, ogb, ovg }));
  await ev(`(()=>{ __cmr.S.vs.groupBy='date'; __cmr.fn.applyView(); })()`); await sleep(2000);
  await ev(`__cmr.fn.expandAll(true)`); await sleep(1200);
  await pg.send('Page.reload'); await sleep(3500); await until(() => ev(`__cmr.SRCH.status.state==='ready' && __cmr.SRCH.status.docs>=100`), 30000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); })()`);
  await ev(`(()=>{ const i=document.getElementById('search'); i.focus(); i.value='n1 tab'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await until(() => ev(`__cmr.V.mode==='search' && __cmr.V.srows.length>=2`), 15000); await sleep(1000);
  check('search view: no window label rows', (await ev(`[...document.querySelectorAll('.vrow.note.win:not([hidden])')].length`)) === 0 && (await ev(`document.querySelectorAll('.vrow.item:not([hidden])').length`)) >= 2);
  await ev(`(()=>{ const i=document.getElementById('search'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); i.blur(); })()`); await sleep(1200);
  await ev(`(()=>{ __cmr.fn.expandAll(true); })()`); await sleep(1200);

  // (4) keyboard / selection / marquee across label rows
  await toTop(S1); await sleep(300);
  const rowBox = (seq) => ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].find(x=>x.dataset.g==='${S1}'&&x.dataset.seq==='${seq}'); if(!n) return null; const scr=document.getElementById('scroller'); scr.scrollTop += n.getBoundingClientRect().top - scr.getBoundingClientRect().top - 220; const r=n.getBoundingClientRect(); return {x:r.left+300,y:r.top+r.height/2}; })()`);
  await toTop(S1); await sleep(500); const b4 = await rowBox(4); await sleep(500); await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].find(x=>x.dataset.g==='${S1}'&&x.dataset.seq==='4'); n.focus(); })()`); await sleep(200);
  await key('ArrowDown', 40);
  const foc = await ev(`({ seq: document.activeElement && document.activeElement.dataset.seq, win: document.activeElement.classList.contains('win'), sel:[...__cmr.sel.sel.set||[]].length })`);
  console.log('INFO kb', strip(foc), strip(await ev(`({ae: document.activeElement.className.slice(0,30), keys:[...__cmr.sel.sel.keys||[]], b4:${JSON.stringify(b4)}})`)));
  check('keyboard: ArrowDown from the last tab of window 1 lands on the first tab of window 2 (label row skipped)', foc.seq === '5' && !foc.win, strip(foc));
  await key('ArrowUp', 38);
  check('keyboard: ArrowUp comes back to tab 4', (await ev(`document.activeElement.dataset.seq`)) === '4');
  await key('Escape', 27);
  // marquee box starting ON the label row ("Window 2") and sweeping down over items
  await ev(`(()=>{ const i5=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].find(x=>x.dataset.g==='${S1}'&&x.dataset.seq==='5'); const n=[...document.querySelectorAll('.vrow.note.win:not([hidden])')].filter(x=>i5&&x.getBoundingClientRect().bottom<=i5.getBoundingClientRect().top+2).pop(); window.__lblRow=n; const scr=document.getElementById('scroller'); if(n) scr.scrollTop += n.getBoundingClientRect().top - scr.getBoundingClientRect().top - 150; })()`); await sleep(500);
  const lbl = await ev(`(()=>{ const n=window.__lblRow; if(!n) return null; const r=n.getBoundingClientRect(); const rg=document.createRange(); const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT); let t; while((t=w.nextNode())) if(t.textContent.trim()){ rg.selectNodeContents(t); const b=rg.getBoundingClientRect(); return {x:b.left+3,y:b.top+b.height/2}; } return {x:r.left+20,y:r.top+r.height/2}; })()`);
  check('marquee: a visible "Window 2" label row exists', !!lbl, strip(lbl));
  if (lbl) {
    await mouse('mouseMoved', lbl.x, lbl.y); await mouse('mousePressed', lbl.x, lbl.y);
    for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', lbl.x + i * 20, lbl.y + i * 18); await sleep(20); }
    const mid = await ev(`({ box: !!document.querySelector('.marquee'), sel: window.getSelection().toString() })`);
    await mouse('mouseReleased', lbl.x + 240, lbl.y + 216); await sleep(300);
    const n = await ev(`__cmr.sel.sel.size`);
    check('marquee from the label row: box drawn, no text selected, tabs of window 2 selected', mid.box && mid.sel === '' && n >= 2, strip({ mid, n }));
    await key('Escape', 27);
  }
  // Select all in the session must not choke on label rows
  await ev(`(()=>{ const n=[...document.querySelectorAll('.vrow.item[data-seq]:not([hidden])')].find(x=>x.dataset.g==='${S1}'&&x.dataset.seq==='6'); if(n) n.focus(); })()`); await sleep(200);
  await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }); await sleep(300);
  check('Ctrl+A selects all 8 tabs of the session', (await ev(`__cmr.sel.sel.size`)) === 8, String(await ev(`__cmr.sel.sel.size`)));
  await key('Escape', 27);

  // (5) screenshots: comfortable + compact, light + dark, S1 + S2 on screen
  for (const dens of ['comfortable', 'compact']) {
    await msg({ type: 'saveSettings', patch: { density: dens } }); await sleep(1500);
    await ev(`__cmr.fn.expandAll(false)`); await sleep(400); await ev(`__cmr.V.exp.add(${JSON.stringify(S1)}); __cmr.V.exp.add(${JSON.stringify(S2)}); __cmr.fn.relayout()`); await sleep(1200);
    await toTop(S1, 40);
    const ovd = await overlap(); check('density ' + dens + ': no overlapping rows', ovd.bad.length === 0, strip(ovd));
    const wd = await winRows(); check('density ' + dens + ': label rows have the density height', wd.length >= 2 && wd.every((r) => r.h === (dens === 'compact' ? 30 : 34)), strip(wd));
    for (const sch of ['light', 'dark']) { await scheme(sch); await sleep(400); await shot('win-' + dens + '-' + sch); }
    await scheme('light');
  }
  await msg({ type: 'saveSettings', patch: { density: 'comfortable' } }); await sleep(800);
  await metrics(1000, 800); await sleep(1000); await ev(`__cmr.fn.relayout()`); await sleep(800); await toTop(S2, 0);
  const ovn = await overlap(); check('1000px wide: no overlapping rows', ovn.bad.length === 0, strip(ovn));
  await shot('win-1000-light'); await scheme('dark'); await sleep(400); await shot('win-1000-dark'); await scheme('light');
  await metrics(1400, 900); await sleep(500);
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nwindow-rows-regression: ${failures} FAILED` : '\nwindow-rows-regression: all passed');
process.exit(failures ? 1 : 0);
