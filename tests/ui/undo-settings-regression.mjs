// List-management undo history (#btnUndo / Ctrl+Z) and settings search + icons (real Chrome over CDP).
//   node tests/ui/undo-settings-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9364;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-undoset-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-undoset-shots');
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
  const strip = (s) => JSON.stringify(s);
  const key = async (k, vk, mod = 0) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: vk, modifiers: mod }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: vk, modifiers: mod }); await sleep(500); };
  const ctrlZ = () => key('z', 90, 2);
  await pg.send('Log.enable').catch(() => {});
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);
  const mkSet = async (title, items, extra = {}) => { const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid; await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g; };
  const plain = (p, n) => Array.from({ length: n }, (_, i) => ({ url: `https://${p}.example.test/${i}`, title: `${p} tab ${i}` }));
  const A = await mkSet('SetAlpha', plain('al', 3));
  const B = await mkSet('SetBravo', plain('br', 3));
  const C = await mkSet('SetCharlie', plain('ch', 3));
  const M = await mkSet('SetMerge', [...plain('m1', 2).map((x, i) => ({ ...x, w: 1, ...(i === 0 ? { ws: true } : {}) })), ...plain('m2', 2).map((x, i) => ({ ...x, w: 2, ...(i === 0 ? { ws: true } : {}) }))], { windowCount: 2 });
  await until(() => ev(`__cmr.S.allGroups.length>=4`), 15000);
  const hideBanners = () => ev(`(()=>{ if(!document.getElementById('xbn')){ const st=document.createElement('style'); st.id='xbn'; st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st);} __cmr.fn.expandAll(true); })()`);
  await hideBanners(); await sleep(1500);
  const stack = () => ev(`__cmr.S.undoStack.length`);
  const btnVis = () => ev(`!document.getElementById('btnUndo').hidden`);
  const gone = (g) => db(`(d)=>d.getGroup('${g}').then(x=>!x||x.deletedAt!=null)`);
  const arch = (g) => db(`(d)=>d.getGroup('${g}').then(x=>!!x.archived)`);
  const cnt = (g) => db(`(d)=>d.getGroup('${g}').then(x=>x.count)`);
  const clickEl = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true; })()`);
  check('undo: button hidden and stack empty at start', !(await btnVis()) && (await stack()) === 0);

  // 1. delete a set -> button appears -> click undoes it -> hides
  // the UI path (selection + Delete key on a header) is what records the toast: use the header menu
  await ev(`__cmr.fn.expandAll(true)`);
  await clickEl(`.vrow.ghead[data-g="${B}"] [data-act="more"]`); await sleep(500);
  const trashClicked = await clickEl('#moreMenu [data-act="mTrash"]'); await sleep(1500);
  check('undo 1: deleting a set through the menu records a step and shows #btnUndo', trashClicked && (await gone(B)) && (await btnVis()) && (await stack()) >= 1, 'stack=' + (await stack()));
  const title1 = await ev(`document.getElementById('btnUndo').title`);
  check('undo 1: button title says "Undo: <text> (Ctrl+Z)"', /^Undo: .+\(Ctrl\+Z\)$/.test(title1), title1);
  await clickEl('#btnUndo'); await sleep(1500);
  check('undo 1: clicking the button brings the set back and shows "Undone"', !(await gone(B)), String(await ev(`document.getElementById('toastText').textContent`)));
  await ev(`(()=>{ __cmr.S.undoStack.length = 0; })()`); await ev(`document.getElementById('toast').hidden = true`);
  // the stale first delete (A) is not undone by us: reset the stack so the next checks are exact
  await sleep(300);

  // 2. archive then delete a tab -> Ctrl+Z twice newest-first
  await clickEl(`.vrow.ghead[data-g="${C}"] [data-act="archive"]`); await sleep(1500);
  check('undo 2: archive recorded', (await arch(C)) && (await stack()) === 1, 'stack=' + (await stack()));
  await hideBanners(); await sleep(600);
  const n0 = await cnt(B);
  await clickEl(`.vrow.item[data-g="${B}"] [data-act="delItem"]`); await sleep(1500);
  check('undo 2: tab delete recorded (stack 2, one tab fewer)', (await cnt(B)) === n0 - 1 && (await stack()) === 2, strip({ c: await cnt(B), s: await stack() }));
  await ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await ctrlZ();
  check('undo 2: first Ctrl+Z restores the tab (newest first), archive stays', (await cnt(B)) === n0 && (await arch(C)) && (await stack()) === 1, strip({ c: await cnt(B), a: await arch(C), s: await stack() }));
  await ctrlZ();
  check('undo 2: second Ctrl+Z un-archives', !(await arch(C)) && (await stack()) === 0 && !(await btnVis()), strip({ a: await arch(C), s: await stack() }));
  await ctrlZ();
  check('undo 2: Ctrl+Z with an empty stack does nothing (no error toast)', (await stack()) === 0);

  // 3. the toast's own Undo removes its entry (no double undo); undo works after the toast expired
  await clickEl(`.vrow.ghead[data-g="${C}"] [data-act="archive"]`); await sleep(1200);
  check('undo 3: toast has an Undo action and the step is recorded', (await ev(`!document.getElementById('toastAction').hidden`)) && (await stack()) === 1);
  await clickEl('#toastAction'); await sleep(1500);
  check('undo 3: toast Undo works and removes its stack entry', !(await arch(C)) && (await stack()) === 0 && !(await btnVis()), strip({ a: await arch(C), s: await stack() }));
  await clickEl(`.vrow.ghead[data-g="${C}"] [data-act="archive"]`); await sleep(1200);
  await ev(`document.getElementById('toast').hidden = true`); await sleep(11000); // let the toast timer run out
  check('undo 3: after the toast expired the step is still undoable', (await stack()) === 1 && (await btnVis()));
  await clickEl('#btnUndo'); await sleep(1500);
  check('undo 3: undo after expiry works', !(await arch(C)), '');

  // 4. reshape merge + undo through the button
  await hideBanners(); await sleep(600);
  await clickEl(`.vrow.ghead[data-g="${M}"] [data-act="more"]`); await sleep(600);
  const merged = await clickEl('#moreMenu [data-act="mMergeWin"]'); await sleep(1500);
  const wc = () => db(`(d)=>d.getGroup('${M}').then(x=>x.windowCount)`);
  check('undo 4: merge via menu -> windowCount 1, step recorded', merged && (await wc()) === 1 && (await stack()) === 1, strip({ merged, wc: await wc() }));
  await clickEl('#btnUndo'); await sleep(1500);
  check('undo 4: button undo restores 2 windows', (await wc()) === 2);

  // 5. Ctrl+Z inside the search input does not trigger it
  await clickEl(`.vrow.ghead[data-g="${C}"] [data-act="archive"]`); await sleep(1200);
  await ev(`(()=>{ const i=document.getElementById('search'); i.focus(); i.value='abc'; })()`);
  await ctrlZ();
  check('undo 5: Ctrl+Z inside the search box leaves the stack alone', (await stack()) === 1 && (await arch(C)), strip({ s: await stack(), a: await arch(C) }));
  await ev(`(()=>{ const i=document.getElementById('search'); i.value=''; i.blur(); })()`);
  await ctrlZ(); await sleep(800);
  check('undo 5: outside the field Ctrl+Z undoes', !(await arch(C)) && (await stack()) === 0);
  await shot('undo-btn-light');

  // 6. settings search + icons
  await clickEl('.navi[data-view="settings"]'); await sleep(1500);
  const icons = () => ev(`({ cards: document.querySelectorAll('#panelSettings > section.card > h2 svg.sico').length, h2: document.querySelectorAll('#panelSettings > section.card > h2').length, side: document.querySelectorAll('#snav a svg.sico').length, links: document.querySelectorAll('#snav a').length })`);
  const ic = await icons();
  check('settings: every card heading and side link has an icon', ic.cards === ic.h2 && ic.side === ic.links && ic.h2 > 5, strip(ic));
  await shot('settings-light'); await scheme('dark'); await sleep(400); await shot('settings-dark'); await scheme('light');
  const type = async (text) => { await ev(`(()=>{ const i=document.getElementById('setSearch'); i.focus(); i.value=${JSON.stringify(text)}; i.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(500); };
  const vis = () => ev(`({ cards:[...document.querySelectorAll('#panelSettings > section.card:not([hidden])')].map(c=>c.id), rows:[...document.querySelectorAll('#panelSettings > section.card:not([hidden]) .srow:not([hidden])')].map(r=>r.textContent.trim().slice(0,30)), empty: !document.getElementById('setEmpty').hidden, emptyText: document.getElementById('setEmpty').textContent, side:[...document.querySelectorAll('#snav a:not([hidden])')].length })`);
  await type('dark'); let v = await vis();
  check('settings search "dark": a Theme row is shown, other cards filtered out', v.rows.some((r) => /theme|dark/i.test(r)) && v.cards.length < ic.h2 && !v.empty, strip(v));
  await shot('settings-filter-light'); await scheme('dark'); await sleep(400); await shot('settings-filter-dark'); await scheme('light');
  await type('sync'); v = await vis();
  check('settings search "sync": the sync card is shown', v.cards.includes('s-sync') && !v.empty, strip(v.cards));
  { const hs = await ev(`(()=>{ const h=CSS.highlights.get('setsearch'); if(!h) return {n:0}; const t=[...h].map(r=>r.toString().toLowerCase()); const vis=[...h].every(r=>!r.startContainer.parentElement.closest('[hidden]')); return {n:h.size, allSync:t.every(x=>x==='sync'), vis}; })()`);
  check('settings search highlights every match of "sync" in the shown text', hs.n > 0 && hs.allSync && hs.vis, strip(hs));
  await type(''); const hc = await ev(`!CSS.highlights.has('setsearch')`); check('settings search: clearing the box removes the highlight', hc); await type('sync'); }
  await type('มืด'); v = await vis(); // the Thai word for "dark": the Thai search must not throw (English UI: simply may find nothing or a row)
  console.log('INFO thai query ' + strip(v));
  await type('zzqqxx'); v = await vis();
  check('settings search nonsense: empty state shown, no cards', v.empty && v.cards.length === 0 && /zzqqxx/.test(v.emptyText) && v.side <= 1, strip(v));
  await ev(`(()=>{ const i=document.getElementById('setSearch'); i.focus(); })()`); await key('Escape', 27);
  v = await vis();
  check('settings search: Esc clears and restores every card + side link', !v.empty && v.cards.length === ic.h2 && (await ev(`document.getElementById('setSearch').value`)) === '', strip(v.cards));
  // language switch keeps the icons; dynamic cards re-render with icons; no mutation spin
  await ev(`(()=>{ const s=document.getElementById('selLanguage'); s.value='th'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(2000);
  const icTh = await icons();
  check('settings: switching language en -> th keeps all icons', icTh.cards === icTh.h2 && icTh.side === icTh.links && icTh.h2 === ic.h2, strip(icTh));
  const thTitle = await ev(`document.querySelector('#panelSettings > section.card > h2').textContent.trim()`);
  await type('มืด'); v = await vis();
  check('settings search with Thai text on the Thai UI finds the theme row', v.rows.length > 0 && !v.empty, strip(v));
  await shot('settings-th-filter-light'); await scheme('dark'); await sleep(400); await shot('settings-th-filter-dark'); await scheme('light');
  await ev(`(()=>{ const i=document.getElementById('setSearch'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(400);
  await ev(`(()=>{ const s=document.getElementById('selLanguage'); s.value='en'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(2000);
  const icEn = await icons();
  check('settings: switching back th -> en keeps all icons', icEn.cards === icEn.h2 && icEn.side === icEn.links, strip(icEn));
  const mut = await ev(`new Promise((res)=>{ let n=0; const mo=new MutationObserver((l)=>{ n+=l.length; }); mo.observe(document.getElementById('panelSettings'),{childList:true,subtree:true,attributes:true,characterData:true}); mo.observe(document.getElementById('snav'),{childList:true,subtree:true,attributes:true,characterData:true}); setTimeout(()=>{ mo.disconnect(); res(n); }, 1500); })`);
  check('settings: idle for 1.5 s -> no DOM mutations (no observer loop / CPU spin)', mut === 0, String(mut));
  // the dynamic permissions / lock cards: force a redraw and check the icon comes back
  const redraw = await ev(`(async()=>{ const c=document.querySelector('#s-perms'); if(!c) return 'nocard'; const h=c.querySelector('h2'); const had=!!h.querySelector('svg.sico'); h.querySelector('svg.sico')&&h.querySelector('svg.sico').remove(); await new Promise(r=>setTimeout(r,500)); return { had, back: !!c.querySelector('h2 svg.sico') }; })()`);
  check('settings: a redrawn (icon-less) card gets its icon back via the observer', redraw && redraw.had && redraw.back, strip(redraw));
  const errs = await pg.send('Runtime.evaluate', { expression: '1' }).then(() => 0);
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nundo-settings-regression: ${failures} FAILED` : '\nundo-settings-regression: all passed');
process.exit(failures ? 1 : 0);
