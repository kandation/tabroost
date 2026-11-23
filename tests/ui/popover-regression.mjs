// Regression test for the shared popover manager (lib/popover.js): drives a REAL Chrome through CDP with real mouse/keyboard input.
//   node tests/ui/popover-regression.mjs            (Windows default Chrome path, or set CHROME=...)
// It launches its own throw-away profile (temp dir), loads this extension unpacked, seeds two sessions and checks every menu:
// opens, is on top, closes on outside click / Esc / trigger re-click / list scroll / route change / opening another popover,
// focus returns to the trigger, and no popover or scrim is left behind. Exit code 1 on any failure.
import { killChrome } from './killtree.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 200);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-popover-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

async function waitUp() { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch { await sleep(500); } } throw new Error('chrome did not start'); }
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, ws };
}

try {
  await waitUp();
  await sleep(1000);
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const br = await cdp(ver.webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;
  await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=1`, newWindow: true, width: 1280, height: 860 });
  await sleep(3000);
  const target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable');
  await pg.send('Page.bringToFront');
  await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);

  // seed two sessions
  for (let n = 0; n < 2; n++) {
    const g = (await msg({ type: 'debug:seedGroup', title: 'Seed ' + n })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: 40 }, (_, i) => ({ url: `https://example.test/${n}/${i}`, title: `Page ${n}-${i}` })) });
    await msg({ type: 'debug:seedDone', gid: g });
  }
  await msg({ type: 'catSave', cat: { name: 'Work', color: 'blue' } });
  for (let i = 0; i < 40 && !(await ev(`document.querySelectorAll('.vrow.ghead:not([hidden])').length >= 1 && document.querySelectorAll('#catList .navi').length >= 1`)); i++) await sleep(300);
  await sleep(800);

  // ---------- real input helpers ----------
  const center = async (sel) => { const r = await ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const b=e.getBoundingClientRect(); return [b.left+b.width/2, b.top+b.height/2]; })()`); if (!r) throw new Error('no element ' + sel); return r; };
  const mouse = (type, x, y, extra = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y, button = 'left') => { await mouse('mouseMoved', x, y); await pg.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }); await pg.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }); await sleep(250); };
  const click = async (sel, button) => { if (sel.startsWith('#moreMenu ')) await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`); const [x, y] = await center(sel); await clickAt(x, y, button); };
  const esc = async () => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(250); };
  const wheel = async (x, y) => { await pg.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400 }); await sleep(350); };
  const openCount = () => ev(`document.querySelectorAll(':popover-open').length`);
  const isOpen = (sel) => ev(`(()=>{ const m=document.querySelector(${JSON.stringify(sel)}); return !!m && !m.hidden && m.matches(':popover-open'); })()`);
  const onTop = (sel) => ev(`(()=>{ const m=document.querySelector(${JSON.stringify(sel)}); const b=m.getBoundingClientRect(); const p=document.elementFromPoint(b.left+b.width/2, b.top+Math.min(40,b.height/2)); const inView=b.left>=0&&b.top>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1; return {covered: !(p && m.contains(p)), inView, bg:getComputedStyle(m).backgroundColor, rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]}; })()`);
  const focusIs = (sel) => ev(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);
  const nothingLeft = async (label) => {
    const c = await openCount();
    const blocker = await ev(`(()=>{ const sc=document.getElementById('menuScrim'); const el=document.elementFromPoint(innerWidth*0.55, innerHeight*0.55); return {scrimHidden: sc.hidden, hit: el ? (el.closest('.menu,#menuScrim,[popover]') ? 'overlay' : 'page') : 'none'}; })()`);
    check(`${label}: no popover / scrim / invisible blocker left`, c === 0 && blocker.scrimHidden && blocker.hit === 'page', JSON.stringify({ open: c, ...blocker }));
  };

  const MENUS = [
    { name: 'top-bar sort / group', trigger: '#btnView', menu: '#viewMenu' },
    { name: 'filter', trigger: '#btnFilter', menu: '#filterMenu' },
    { name: 'session ⋯', trigger: '.vrow.ghead:not([hidden]) [data-act=more]', menu: '#moreMenu' },
    { name: 'session sort (chevron)', trigger: '.vrow.ghead:not([hidden]) [data-act=itemSortMenu]', menu: '#itemSortMenu' },
  ];
  const titlePt = await center('#viewTitle'); // harmless spot outside every menu (the page title)
  const wheelPt = [300, 600]; // over the list (left edge, outside the menus)

  const toTop = async () => { await ev(`document.getElementById('scroller').scrollTop = 0`); await sleep(400); };
  for (const m of MENUS) {
    await toTop();
    // a) open
    await click(m.trigger);
    check(`${m.name}: opens (top layer)`, await isOpen(m.menu), (await isOpen(m.menu)) ? '' : JSON.stringify(await ev(`(()=>{ const e=document.querySelector(${JSON.stringify(m.trigger)}); if(!e) return 'no trigger'; const b=e.getBoundingClientRect(); const p=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2); return {rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)], hit:p&&p.outerHTML.slice(0,80), vw:innerWidth, vh:innerHeight, groups:document.querySelectorAll('.vrow.ghead:not([hidden])').length}; })()`)));
    const t1 = await onTop(m.menu);
    check(`${m.name}: solid background, inside the viewport, not covered by the list`, !t1.covered && t1.inView && !/rgba\(0, 0, 0, 0\)|transparent/.test(t1.bg), JSON.stringify(t1));
    // b) outside click
    await clickAt(...titlePt);
    check(`${m.name}: closes on outside click`, !(await isOpen(m.menu)));
    // c) Esc + focus back
    await click(m.trigger);
    await esc();
    check(`${m.name}: closes on Esc`, !(await isOpen(m.menu)));
    check(`${m.name}: Esc returns focus to the trigger`, await focusIs(m.trigger));
    // d) toggle
    await click(m.trigger);
    const openedAgain = await isOpen(m.menu);
    await click(m.trigger);
    check(`${m.name}: re-click on the trigger toggles it closed (and it stays closed)`, openedAgain && !(await isOpen(m.menu)));
    // e) list scroll
    await click(m.trigger);
    await wheel(...wheelPt);
    check(`${m.name}: closes when the list scrolls`, !(await isOpen(m.menu)));
    await nothingLeft(m.name);
  }

  // single popover at a time: open sort, then the filter button
  await click('#btnView');
  await click('#btnFilter');
  check('opening another popover closes the current one (exactly one open)', (await openCount()) === 1 && (await isOpen('#filterMenu')) && !(await isOpen('#viewMenu')));

  // ---------- submenus of the session ⋯ menu ----------
  {
    const kd = async (key, code, vk) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await sleep(250); };
    const subOpenState = () => ev(`(()=>{ const m=document.getElementById('moreMenu'); const open=[...m.querySelectorAll('.msub:not([hidden])')]; return {n:open.length, rect: open[0]?(()=>{const b=open[0].getBoundingClientRect(); return [Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]})():null, vw:innerWidth, vh:innerHeight, focusInSub: !!(document.activeElement && document.activeElement.closest('.msub')), pos: open[0]?getComputedStyle(open[0]).position:null}; })()`);
    await toTop();
    await click('.vrow.ghead:not([hidden]) [data-act=more]');
    const top = await ev(`(()=>{ const m=document.getElementById('moreMenu'); const rows=[...m.querySelectorAll('[role^="menuitem"]')].filter(x=>!x.closest('.msub')); return {rows: rows.length, scrolls: m.scrollHeight > m.clientHeight + 1, subs: m.querySelectorAll('.mitem.msp').length, aria: [...m.querySelectorAll('.mitem.msp')].every(x=>x.getAttribute('aria-haspopup')==='menu' && x.getAttribute('aria-expanded')==='false')}; })()`);
    check('session ⋯: short top level (<= 9 rows) and never needs a scrollbar', top.rows <= 9 && !top.scrolls && top.subs === 3, JSON.stringify(top));
    check('session ⋯: submenu parents carry aria-haspopup / aria-expanded', top.aria);
    // click opens, inside the viewport (flips when needed)
    await click('#moreMenu .mitem.msp');
    let st = await subOpenState();
    check('submenu: click opens it, fully inside the viewport (flip when it would clip)', st.n === 1 && st.rect && st.rect[0] >= 0 && st.rect[2] <= st.vw && st.rect[3] <= st.vh, JSON.stringify(st));
    await click('#moreMenu .mitem.msp');
    check('submenu: second click closes it', (await subOpenState()).n === 0);
    // keyboard: Right opens + focuses first, Left closes only the submenu
    await ev(`document.querySelector('#moreMenu .mitem.msp').focus()`);
    await kd('ArrowRight', 'ArrowRight', 39);
    st = await subOpenState();
    check('submenu: ArrowRight opens it and focuses its first row', st.n === 1 && st.focusInSub);
    await kd('ArrowDown', 'ArrowDown', 40);
    check('submenu: arrows move inside the submenu only', (await subOpenState()).focusInSub);
    await kd('ArrowLeft', 'ArrowLeft', 37);
    st = await subOpenState();
    check('submenu: ArrowLeft closes only the submenu (menu stays, focus on the parent)', st.n === 0 && (await isOpen('#moreMenu')) && (await ev(`document.activeElement.classList.contains('msp')`)));
    await kd('ArrowRight', 'ArrowRight', 39);
    await esc();
    check('submenu: Esc closes only the submenu', (await subOpenState()).n === 0 && (await isOpen('#moreMenu')));
    await esc();
    check('submenu: a second Esc closes the whole menu and returns focus', !(await isOpen('#moreMenu')) && (await focusIs('.vrow.ghead:not([hidden]) [data-act=more]')));
    // hover opens after a short delay, moving to a plain row closes it
    await click('.vrow.ghead:not([hidden]) [data-act=more]');
    const [hx, hy] = await center('#moreMenu .mitem.msp');
    await mouse('mouseMoved', hx, hy); await sleep(450);
    check('submenu: hover opens it', (await subOpenState()).n === 1);
    const [px, py] = await center('#moreMenu [data-act=mRename]');
    await mouse('mouseMoved', px, py); await sleep(650);
    check('submenu: moving to another row closes it', (await subOpenState()).n === 0);
    // outside click closes everything
    await click('#moreMenu .mitem.msp');
    await clickAt(...titlePt);
    check('submenu: outside click closes the menu with its submenu', !(await isOpen('#moreMenu')));
    await nothingLeft('submenus');
    // narrow: accordion inside the bottom sheet
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    await toTop();
    await click('.vrow.ghead:not([hidden]) [data-act=more]');
    await click('#moreMenu .mitem.msp');
    st = await subOpenState();
    check('narrow: submenu expands in place inside the sheet (accordion)', st.n === 1 && st.pos === 'static' && (await ev(`document.getElementById('moreMenu').classList.contains('sheet')`)), JSON.stringify(st));
    await esc(); await esc();
    await nothingLeft('narrow submenu');
    await pg.send('Emulation.clearDeviceMetricsOverride');
    await sleep(500);
  }
  // ---------- the same short-top-level + submenu treatment for the sort/group, tab-sort and category menus ----------
  {
    const kd2 = async (key, code, vk) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await sleep(250); };
    const shape = (sel) => ev(`(()=>{ const m=document.querySelector(${JSON.stringify(sel)}); const all=[...m.querySelectorAll('[role^="menuitem"]')]; const top=all.filter(x=>!x.closest('.msub')); return { top: top.length, all: all.length, subs: m.querySelectorAll('.mitem.msp').length, scrolls: m.scrollHeight > m.clientHeight + 1, aria: [...m.querySelectorAll('.mitem.msp')].every(p=>p.getAttribute('aria-haspopup')==='menu' && p.getAttribute('aria-expanded')==='false') }; })()`);
    const openSubs = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel + ' .msub:not([hidden])')}).length`);
    const CASES = [
      { name: 'sort / group', open: async () => { await click('#btnView'); }, menu: '#viewMenu', maxTop: 18, minAll: 30 },
      { name: 'tab sort (session chevron)', open: async () => { await click('.vrow.ghead:not([hidden]) [data-act=itemSortMenu]'); }, menu: '#itemSortMenu', maxTop: 12, minAll: 12 },
      { name: 'category', open: async () => { await ev(`document.querySelector('.navi[data-menu-cat]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 300 }))`); await sleep(400); }, menu: '#catMenu', maxTop: 6, minAll: 5 },
    ];
    for (const c of CASES) {
      await toTop();
      await c.open();
      check(`${c.name}: opens`, await isOpen(c.menu));
      const sh = await shape(c.menu);
      check(`${c.name}: short top level, has submenus, every action still reachable`, sh.top <= c.maxTop && sh.subs >= 1 && sh.all >= c.minAll && sh.aria, JSON.stringify(sh));
      await ev(`document.querySelector(${JSON.stringify(c.menu + ' .mitem.msp')}).focus()`);
      await kd2('ArrowRight', 'ArrowRight', 39);
      check(`${c.name}: Right arrow opens the submenu`, (await openSubs(c.menu)) === 1);
      const inView = await ev(`(()=>{ const s=document.querySelector(${JSON.stringify(c.menu + ' .msub:not([hidden])')}); const b=s.getBoundingClientRect(); return b.left>=0 && b.top>=0 && b.right<=innerWidth && b.bottom<=innerHeight; })()`);
      check(`${c.name}: submenu stays inside the viewport`, inView);
      await esc();
      check(`${c.name}: Esc closes only the submenu`, (await openSubs(c.menu)) === 0 && (await isOpen(c.menu)));
      await esc();
      check(`${c.name}: second Esc closes the menu`, !(await isOpen(c.menu)));
      await nothingLeft(c.name + ' (short menu)');
    }
    // choosing inside a submenu works and keeps keyboard position
    await click('#btnView');
    await ev(`document.querySelector('#viewMenu .mitem.msp').focus()`);
    await kd2('ArrowRight', 'ArrowRight', 39);
    await ev(`document.querySelector('#viewMenu .msub:not([hidden]) [role^="menuitem"]').click()`);
    await sleep(500);
    { const dbg = await ev(`JSON.stringify({ open: document.getElementById('viewMenu').matches(':popover-open'), hint: !!document.querySelector('#viewMenu .mitem.msp .subhint'), chk: document.querySelectorAll('#viewMenu [aria-checked="true"]').length })`); check('sort / group: picking an "other" sort applies it, menu stays open with the choice shown on the submenu row', (await isOpen('#viewMenu')) && (await ev(`!!document.querySelector('#viewMenu .mitem.msp .subhint') && document.querySelector('#viewMenu [aria-checked="true"]')!==null`)), dbg); }
    await esc(); await esc();
    await nothingLeft('sort / group after pick');
  }
  await click('#btnView');
  check('...and back: only the sort menu is open', (await openCount()) === 1 && (await isOpen('#viewMenu')));
  // route change closes it
  await click('.sidefoot [data-view=settings]');
  check('route change (settings) closes the open popover', (await openCount()) === 0);
  // settings select is not blocked by anything and keeps working
  const sel = '#selTheme';
  await click(sel);
  await sleep(200);
  const selOk = await ev(`(()=>{ const s=document.querySelector('${sel}'); return document.activeElement===s; })()`);
  check('settings <select> can be used (focus, no overlay in the way)', selOk);
  await esc();
  await click('.navi[data-nav=all]');
  await sleep(500);

  await toTop();
  // category: ⋯ -> move to category, and right-click on a category in the sidebar
  await click('.vrow.ghead:not([hidden]) [data-act=more]');
  await click('#moreMenu [data-act=mMoveCat]');
  check('category menu (from ⋯ → move to category) opens', await isOpen('#catMenu'));
  await clickAt(...titlePt);
  check('category menu closes on outside click', !(await isOpen('#catMenu')));
  await click('#catList .navi', 'right');
  check('category context menu opens on right-click', await isOpen('#catMenu'));
  await esc();
  check('category context menu closes on Esc', !(await isOpen('#catMenu')));
  await nothingLeft('category menus');

  // phone sheet (bottom sheet + scrim): closes on scrim click and leaves no scrim behind
  await pg.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await click('#btnView');
  const sheet = await ev(`(()=>{ const m=document.getElementById('viewMenu'); const sc=document.getElementById('menuScrim'); return {sheet:m.classList.contains('sheet'), scrim:!sc.hidden, open:m.matches(':popover-open')}; })()`);
  check('narrow width: opens as a bottom sheet with a scrim', sheet.sheet && sheet.scrim && sheet.open, JSON.stringify(sheet));
  await clickAt(210, 60);
  check('narrow width: closes when the area above the sheet is tapped', !(await isOpen('#viewMenu')));
  await nothingLeft('narrow sheet');
  await pg.send('Emulation.clearDeviceMetricsOverride');
} catch (e) {
  console.log('FAIL  test crashed: ' + (e && e.message));
  failures++;
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall popover checks passed');
cleanup();
process.exit(failures ? 1 : 0);
