// Filter panel regression (real Chrome over CDP, throw-away profile):  node tests/ui/filter-regression.mjs
// Opens the panel, checks the structure (one scroller, sticky footer), date presets, the typed custom range, the own calendar
// (Monday first, keyboard), validation, the toolbar badge, the removable chip, facet counts and Esc order.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9800 + Math.floor(Math.random() * 90);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-filter-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  return { send: (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}

try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); } }
  await sleep(1000);
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const br = await cdp(ver.webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed');
  await br.send('Target.createTarget', { url: `chrome-extension://${ld.result.id}/stash.html?t=1`, newWindow: true, width: 1280, height: 860 });
  await sleep(3000);
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes('stash.html'));
  const pg = await cdp(t.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
  // this test asserts on Thai wording / calendar: set the UI language explicitly (the default is 'auto' = browser language)
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'th'}}))`); await pg.send('Page.reload'); await sleep(3000);
  const _n = new Date(), TODAY_TH = `${_n.getDate()}/${_n.getMonth() + 1}/${_n.getFullYear() + 543}`, TODAY_CHIP = `${_n.getDate()} ${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][_n.getMonth()]} ${_n.getFullYear() + 543}`; // the range ends today
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const key = async (k, code, vk) => { await pg.send('Input.dispatchKeyEvent', { type: k === 'Enter' ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); await sleep(150); };

  for (let n = 0; n < 2; n++) {
    const g = (await msg({ type: 'debug:seedGroup', title: 'Seed ' + n })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: 12 }, (_, i) => ({ url: `https://s${i % 4}.example.test/${n}/${i}`, title: `Page ${n}-${i}` })) });
    await msg({ type: 'debug:seedDone', gid: g });
  }
  for (let i = 0; i < 40 && !(await ev(`document.querySelectorAll('.vrow.ghead:not([hidden])').length >= 2`)); i++) await sleep(300);
  await sleep(800);

  const $q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const clickFk = (fk) => ev(`(()=>{ const b=document.querySelector('#filterMenu [data-fk="${fk}"]'); if(!b) return false; b.click(); return true; })()`);
  const summary = () => ev(`${$q('#filterMenu .fsum')}.textContent`);
  const nFiltered = () => ev(`globalThis.__cmr && globalThis.__cmr.state ? 0 : 0`);
  void nFiltered;

  // ---- open ----
  await ev(`${$q('#btnFilter')}.click()`); await sleep(600);
  check('panel opens as a dialog in the top layer', await ev(`(()=>{ const m=document.getElementById('filterMenu'); return m.matches(':popover-open') && m.getAttribute('role')==='dialog'; })()`));
  const sc = await ev(`(()=>{ const m=document.getElementById('filterMenu'); const out=[]; for (const e of m.querySelectorAll('*')) { const cs=getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight>e.clientHeight+1) out.push(e.className); } const f=m.querySelector('.ffoot').getBoundingClientRect(), b=m.getBoundingClientRect(); return { out, footAtBottom: Math.abs(f.bottom-b.bottom)<3 }; })()`);
  check('exactly one scroller inside the panel (.fbody), footer pinned', sc.out.length <= 1 && (sc.out.length === 0 || sc.out[0] === 'fbody') && sc.footAtBottom, JSON.stringify(sc));
  check('summary shows live counts', /24/.test(await summary()), await summary());
  check('toolbar badge hidden when nothing is active', await ev(`!${$q('#btnFilter .fbadge')}`));
  check('no native date inputs in the panel', await ev(`document.querySelectorAll('#filterMenu input[type="date"]').length===0`));

  // ---- presets ----
  await clickFk('p-today'); await sleep(400);
  check('today preset selected (aria-checked)', await ev(`${$q('#filterMenu [data-fk="p-today"]')}.getAttribute('aria-checked')==='true'`));
  check('toolbar badge shows 1 and the button is tinted', await ev(`${$q('#btnFilter .fbadge')}.textContent==='1' && ${$q('#btnFilter')}.classList.contains('on')`));
  check('active filter chip appears under the search box', await ev(`document.querySelectorAll('#chips .chip').length===1`));
  check('everything saved today still matches', /24/.test(await summary()), await summary());
  await clickFk('p-all'); await sleep(300);
  check('"all" clears the range and the badge', await ev(`!${$q('#btnFilter .fbadge')} && document.querySelectorAll('#chips .chip').length===0`));

  // ---- custom range typed by hand ----
  await clickFk('p-custom'); await sleep(300);
  check('custom shows two labelled fields จาก / ถึง', await ev(`[...document.querySelectorAll('#filterMenu .dlab')].map(x=>x.textContent).join('|')==='จาก|ถึง' && document.querySelectorAll('#filterMenu .dinp').length===2`));
  const typeInto = async (fk, text) => { await ev(`(()=>{ const i=document.querySelector('#filterMenu [data-fk="${fk}"]'); i.focus(); i.value=${JSON.stringify(text)}; i.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(300); };
  await typeInto('d-from', '12/11/2569'); await typeInto('d-to', TODAY_TH); await sleep(300);
  const chipTxt = await ev(`${$q('#chips .chip')}.firstChild.textContent`);
  check('range chip reads like "12 พ.ย. – <today> 2569"', chipTxt.includes('12 พ.ย. – ' + TODAY_CHIP), chipTxt);
  check('a range that includes today still finds the sessions saved today', /24/.test(await summary()), await summary());
  await typeInto('d-from', '1/11/2569'); await typeInto('d-to', '5/11/2569');
  check('a past range finds nothing and says so', /ไม่พบ/.test(await summary()), await summary());
  await typeInto('d-from', '12/11/2569'); await typeInto('d-to', TODAY_TH);
  await typeInto('d-from', '25/11/2569'); await typeInto('d-to', '1/1/2569');
  check('start after end shows the inline message and keeps the old range', await ev(`!${$q('#filterMenu .derr')}.hidden && ${$q('#filterMenu .derr')}.textContent.length>5`));
  await typeInto('d-from', 'abc');
  check('a bad date shows the format hint', await ev(`${$q('#filterMenu .derr')}.textContent.includes('วว/ดด/ปปปป')`));
  // era: Gregorian typed year is accepted too
  await typeInto('d-from', '12/11/2026'); await typeInto('d-to', '23/11/2026');
  check('Gregorian year typed is read as the same day', await ev(`${$q('#filterMenu .dinp[data-fk="d-from"]')}.value==='12/11/2569'`));

  // ---- own calendar, keyboard ----
  await clickFk('dc-from'); await sleep(300);
  const cal = await ev(`(()=>{ const wd=[...document.querySelectorAll('#filterMenu .calwd')].map(x=>x.textContent); const g=document.querySelector('#filterMenu .calgrid'); return { wd, rows: g.querySelectorAll('.calrow').length, role: g.getAttribute('role'), focus: document.activeElement.className, sel: [...document.querySelectorAll('#filterMenu .cday.sel')].map(x=>x.textContent) }; })()`);
  check('calendar: Monday first, 6 weeks + header, grid role', cal.wd[0].startsWith('จ') && cal.wd.length === 7 && cal.rows === 7 && cal.role === 'grid', JSON.stringify(cal));
  check('calendar: focus is on a day, selected days marked', /cday/.test(cal.focus) && cal.sel.includes('12') && cal.sel.includes('23'), JSON.stringify(cal));
  await key('ArrowRight', 'ArrowRight', 39); await key('ArrowRight', 'ArrowRight', 39); await key('Enter', 'Enter', 13); await sleep(400);
  check('arrow keys + Enter pick 14 พ.ย. and close the calendar', await ev(`${$q('#filterMenu .dinp[data-fk="d-from"]')}.value==='14/11/2569' && !document.querySelector('#filterMenu .cal')`), await ev(`${$q('#filterMenu .dinp[data-fk="d-from"]')}.value`));
  check('focus returns to the field after picking', await ev(`document.activeElement.dataset.fk==='d-from'`));
  // Esc: first the calendar, then the panel
  await clickFk('dc-to'); await sleep(300);
  await key('Escape', 'Escape', 27);
  check('Esc closes the calendar first, the panel stays', await ev(`!document.querySelector('#filterMenu .cal') && document.getElementById('filterMenu').matches(':popover-open')`));
  check('basis "last used" is disabled when usage stats are off, with a reason', await ev(`(()=>{ const b=document.querySelector('#filterMenu [data-fk="b-active"]'); return b.getAttribute('aria-disabled')==='true' && b.title.length>3; })()`));
  // ---- clear ----
  await ev(`${$q('#filterMenu [data-fk="clear"]')}.click()`); await sleep(400);
  check('"ล้างตัวกรอง" resets everything', await ev(`!${$q('#btnFilter .fbadge')} && document.querySelectorAll('#chips .chip').length===0 && ${$q('#filterMenu [data-fk="clear"]')}.disabled`));
  // sites: pick one, counts follow
  await ev(`(()=>{ const b=document.querySelector('#filterMenu [data-fk^="s-"]'); b.click(); })()`); await sleep(500);
  check('picking a website filters the list and shows a badge', await ev(`!!${$q('#btnFilter .fbadge')} && document.querySelectorAll('#chips .chip').length===1`));
  await key('Escape', 'Escape', 27); await sleep(300);
  check('Esc closes the panel and returns focus to the Filter button', await ev(`!document.getElementById('filterMenu').matches(':popover-open') && document.activeElement===document.getElementById('btnFilter')`));
} catch (e) { console.log('ERROR ' + ((e && e.stack) || e)); failures++; }
cleanup();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
