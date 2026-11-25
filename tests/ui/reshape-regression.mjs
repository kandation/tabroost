// Reshape regression (real Chrome over CDP): merge windows / ungroup tab groups of one stashed session, undo, visuals in light + dark.
//   node tests/ui/reshape-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9361;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-reshape-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-reshape-shots');
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
  const scheme = (s) => pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] });
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);

  // seed: window 1 = [tg0 a b][plain c]; window 2 = [plain d (window start)][tg1 e f][plain g]
  const tgs = [{ i: 0, title: 'Research', color: 'blue', collapsed: false, windowIdx: 1 }, { i: 1, title: 'Shopping', color: 'orange', collapsed: false, windowIdx: 2 }];
  const items = [
    { url: 'https://a.example.test/1', title: 'Alpha one', w: 1, ws: true, tg: 0 }, { url: 'https://a.example.test/2', title: 'Alpha two', w: 1, tg: 0 }, { url: 'https://b.example.test/3', title: 'Plain three', w: 1 },
    { url: 'https://c.example.test/4', title: 'Plain four starts window two', w: 2, ws: true }, { url: 'https://d.example.test/5', title: 'Shop five', w: 2, tg: 1 }, { url: 'https://d.example.test/6', title: 'Shop six', w: 2, tg: 1 }, { url: 'https://e.example.test/7', title: 'Plain seven', w: 2 },
  ];
  const G = (await msg({ type: 'debug:seedGroup', title: 'Reshape me', tabGroups: tgs, windowCount: 2 })).gid;
  await msg({ type: 'debug:seedItems', gid: G, items }); await msg({ type: 'debug:seedDone', gid: G });
  await until(() => ev(`__cmr.S.allGroups.some(g=>g.id==='${G}')`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); __cmr.fn.expandAll(true); })()`); await sleep(1500);
  const state = () => db(`async(d)=>{ const g=await d.getGroup('${G}'); const it=await d.getItemsPage('${G}',0,5000); return { g:{count:g.count,windowCount:g.windowCount,tabGroups:g.tabGroups||null}, it:it.map(x=>({seq:x.seq,url:x.url,w:x.w,ws:x.ws,tg:x.tg})) }; }`);
  const dom = () => ev(`(()=>{ const q=(s)=>[...document.querySelectorAll(s)].filter(n=>!n.hidden&&n.dataset.g==='${G}'); const dots=[...document.querySelectorAll('.tgdot')].filter(n=>n.offsetParent!==null&&getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().width>0); return { wstart:[...document.querySelectorAll('.vrow.note.win')].filter(n=>!n.hidden).length, sub:q('.vrow.sub').length, items:q('.vrow.item[data-seq]').length, dots:dots.length, ugb:q('.vrow.sub').filter(n=>n.querySelector('.ugb')).length }; })()`);
  const relayout = async () => { await ev(`__cmr.fn.relayout && __cmr.fn.relayout()`); await sleep(1200); };
  const strip = (s) => JSON.stringify(s);

  const s0 = await state(); const d0 = await dom();
  check('a. before: windowCount 2, 2 tab groups, 7 items', s0.g.windowCount === 2 && s0.g.tabGroups.length === 2 && s0.it.length === 7 && s0.g.count === 7, strip(s0.g));
  check('a. wstart rows exist, sub rows exist, no visible .tgdot, ugb on sub rows', d0.wstart >= 2 && d0.sub >= 2 && d0.dots === 0 && d0.ugb >= 2, strip(d0));
  await shot('01-light-multiwin-tg'); await scheme('dark'); await sleep(600); await shot('02-dark-multiwin-tg');
  await scheme('light'); await sleep(300);
  // menu with the two new items
  const openMenu = async () => { await ev(`document.querySelector('.vrow[data-g="${G}"] [data-act="more"]').click()`); await sleep(500); await ev(`(()=>{ const p=[...document.querySelectorAll('#moreMenu .msp')].pop(); p.click(); })()`); await sleep(500); };
  await openMenu();
  const menuItems = await ev(`['mMergeWin','mUngroupAll'].map(a=>{ const b=document.querySelector('#moreMenu [data-act="'+a+'"]'); return b? b.textContent.trim():null; })`);
  check('f. menu shows both new items', menuItems.every(Boolean), strip(menuItems));
  await shot('03-light-menu'); await scheme('dark'); await sleep(500); await shot('04-dark-menu'); await scheme('light'); await sleep(300);
  await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300);

  // b. merge
  const r1 = await msg({ type: 'reshapeGroup', groupId: G, merge: true });
  check('b. merge ok, undo handle returned', r1.ok && r1.changed >= 1 && r1.undo && r1.undo.type === 'undoReshape', strip(r1));
  await sleep(1500); await relayout();
  const s1 = await state(); const d1 = await dom();
  check('b. windowCount 1, no item has w/ws', s1.g.windowCount === 1 && s1.it.every((x) => x.w === undefined && x.ws === undefined), strip(s1.g));
  check('b. tab groups survive the merge with items intact', s1.g.tabGroups.length === 2 && s1.it.filter((x) => x.tg === 0).length === 2 && s1.it.filter((x) => x.tg === 1).length === 2, strip(s1.g.tabGroups));
  check('b. no .wstart rows in the DOM, sub rows remain', d1.wstart === 0 && d1.sub >= 2, strip(d1));
  check('e. merge: count and items unchanged', s1.g.count === 7 && s1.it.length === 7 && s1.it.every((x, i) => x.url === s0.it[i].url), '');
  await shot('05-light-merged');

  // d. undo restores exactly
  const u1 = await msg(r1.undo);
  check('d. undoReshape ok', u1.ok && !u1.error, strip(u1));
  await sleep(1500); await relayout();
  const s2 = await state(); const d2 = await dom();
  check('d. undo after merge restores group + items exactly', strip(s2) === strip(s0), strip(s2.g));
  check('d. undo re-renders wstart rows', d2.wstart === d0.wstart, strip(d2));
  const u1b = await msg({ type: 'undoReshape' });
  check('d. a second undo is a harmless no-op', strip(await state()) === strip(s0), strip(u1b));

  // c. ungroup one tab group
  const r2 = await msg({ type: 'reshapeGroup', groupId: G, ungroup: 0 });
  await sleep(1500); await relayout();
  const s3 = await state(); const d3 = await dom();
  check('c. ungroup tg 0: its items lose tg, group removed, other remains', r2.ok && s3.it.filter((x) => x.tg === 0).length === 0 && s3.it.filter((x) => x.tg === 1).length === 2 && s3.g.tabGroups.length === 1 && s3.g.tabGroups[0].i === 1, strip(s3.g.tabGroups));
  check('c. its sub row disappeared (1 sub row left), windows untouched', d3.sub === d2.sub - 1 && s3.g.windowCount === 2 && s3.it[0].ws === true, strip(d3));
  check('e. ungroup one: count/items unchanged', s3.g.count === 7 && s3.it.length === 7, '');
  const u2 = await msg(r2.undo); await sleep(1200);
  check('d. undo after ungroup-one restores exactly', strip(await state()) === strip(s0), strip(u2));
  const r3 = await msg({ type: 'reshapeGroup', groupId: G, ungroup: 'all' });
  await sleep(1500); await relayout();
  const s4 = await state(); const d4 = await dom();
  check('c. ungroup all: tabGroups empty, no tg on items, no sub rows', r3.ok && !(s4.g.tabGroups && s4.g.tabGroups.length) && s4.it.every((x) => x.tg === undefined) && d4.sub === 0, strip(d4));
  check('c. ungroup all keeps windows (wstart rows still there)', s4.g.windowCount === 2 && d4.wstart >= 2, strip(d4));
  check('e. ungroup all: count/items unchanged', s4.g.count === 7 && s4.it.length === 7, '');
  await shot('06-light-ungrouped');
  const u3 = await msg(r3.undo); await sleep(1500); await relayout();
  check('d. undo after ungroup-all restores exactly', strip(await state()) === strip(s0), strip(u3));
  // merge then ungroup all, one undo: only the last step goes back
  await msg({ type: 'reshapeGroup', groupId: G, merge: true }); await msg({ type: 'reshapeGroup', groupId: G, ungroup: 'all' });
  const u4 = await msg({ type: 'undoReshape' }); await sleep(800);
  const s5 = await state();
  check('d. only the last reshape is undone (merge stays)', u4.ok && s5.g.windowCount === 1 && s5.g.tabGroups.length === 2, strip(s5.g));
  const bad = await msg({ type: 'reshapeGroup', groupId: 'nope', merge: true });
  check('e. unknown group is rejected cleanly', !bad.ok || !!bad.error, strip(bad));
  // back to the seeded shape (the merge step is no longer undoable, so reseed the rows by hand through the db)
  await db(`async(d)=>{ const s=${JSON.stringify(s0)}; return 1; }`);
  const G2 = (await msg({ type: 'debug:seedGroup', title: 'Overlap check', tabGroups: tgs, windowCount: 2 })).gid;
  await msg({ type: 'debug:seedItems', gid: G2, items }); await msg({ type: 'debug:seedDone', gid: G2 });
  await until(() => ev(`__cmr.S.allGroups.some(g=>g.id==='${G2}')`), 15000); await sleep(1500);
  await msg({ type: 'deleteGroup', groupId: G }); await sleep(800);
  await ev(`__cmr.fn.expandAll(true)`); await relayout();
  // UI path: menu item click -> toast -> undo button
  await ev(`document.querySelector('.vrow[data-g="${G2}"] [data-act="more"]').click()`); await sleep(500);
  await ev(`[...document.querySelectorAll('#moreMenu .msp')].pop().click()`); await sleep(400);
  await ev(`document.querySelector('#moreMenu [data-act="mMergeWin"]').click()`); await sleep(1500);
  const sUi = await db(`async(d)=>{ const g=await d.getGroup('${G2}'); return g.windowCount; }`);
  check('UI. menu "merge windows" merges', sUi === 1, String(sUi));
  const toastTxt = await ev(`document.getElementById('toast').hidden ? '' : document.getElementById('toastText').textContent`);
  check('UI. toast with text + undo button', !!toastTxt && (await ev(`!document.getElementById('toastAction').hidden`)), toastTxt);
  await ev(`document.getElementById('toastAction').click()`); await sleep(1500);
  check('UI. toast undo restores 2 windows', (await db(`async(d)=>(await d.getGroup('${G2}')).windowCount`)) === 2);
  await relayout();
  const ugbBox = await ev(`(()=>{ const b=document.querySelector('.vrow.sub[data-g="${G2}"] .ugb'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,tg:b.closest('.vrow').dataset.tg}; })()`);
  check('UI. sub row has an ungroup button', !!ugbBox, strip(ugbBox));
  if (ugbBox) {
    await ev(`document.querySelector('.vrow.sub[data-g="${G2}"] .ugb').click()`); await sleep(1500);
    const g2 = await db(`async(d)=>(await d.getGroup('${G2}')).tabGroups||[]`);
    check('UI. per-group ungroup button removes only that tab group', g2.length === 1 && g2[0].i !== Number(ugbBox.tg), strip(g2));
  }
  await ev(`document.getElementById('toastAction').click()`); await sleep(1200);
  await relayout();
  await scheme('light'); await sleep(300); await shot('07-light-final'); await scheme('dark'); await sleep(500); await shot('08-dark-final');
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nreshape-regression: ${failures} FAILED` : '\nreshape-regression: all passed');
process.exit(failures ? 1 : 0);
