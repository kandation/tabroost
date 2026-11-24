// Set colour (pastel header), emoji, "Colour and emoji" dialog, restructured ⋯ menu, and "More…" opening at the pointer (real Chrome over CDP).
//   node tests/ui/look-menu-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9365;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-look-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-look-shots');
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
  const scheme = async (s) => { await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] }); await sleep(350); };
  const mouse = (type, x, y, o = {}) => pg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : (o.button || 'left'), buttons: type === 'mouseReleased' ? 0 : (o.buttons ?? 1), clickCount: 1, modifiers: o.mod || 0 });
  const rclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', x, y, { button: 'right' }); await sleep(400); };
  const lclick = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(350); };
  const key = async (k, vk, mod = 0) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mod }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mod }); await sleep(250); };
  const enter = async () => { await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(300); };
  const rect = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,r:r.right,b:r.bottom,cx:r.left+r.width/2,cy:r.top+r.height/2}; })()`);
  const S = (o) => JSON.stringify(o);
  const metrics = (w, h) => pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);

  const mkSet = async (title, items, extra = {}) => {
    const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g;
  };
  const plain = (title, n) => Array.from({ length: n }, (_, i) => ({ url: `https://${'abc'[i % 3]}.example.test/${title.replace(/ /g, '')}/${i}`, title: `${title} tab ${i}` }));
  const A = await mkSet('Colour set', plain('Colour set', 4));
  const B = await mkSet('Other set', plain('Other set', 3));
  const tgs = [{ i: 0, title: 'Research', color: 'blue', collapsed: false, windowIdx: 1 }];
  const W = await mkSet('Windows set', [
    { url: 'https://a.example.test/1', title: 'Alpha one', w: 1, ws: true, tg: 0 }, { url: 'https://a.example.test/2', title: 'Alpha two', w: 1, tg: 0 },
    { url: 'https://c.example.test/4', title: 'Beta', w: 2, ws: true }, { url: 'https://e.example.test/7', title: 'Beta two', w: 2 },
  ], { tabGroups: tgs, windowCount: 2 });
  await until(() => ev(`__cmr.S.allGroups.length>=3`), 15000);
  const prep = `(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); window.__errs=[]; addEventListener('error',(e)=>__errs.push(String(e.message))); addEventListener('unhandledrejection',(e)=>__errs.push('rej:'+String(e.reason&&e.reason.stack||e.reason).slice(0,300))); window.prompt=(m,v)=>{ window.__prompted=m; return window.__promptReply ?? null; }; })()`;
  await ev(prep); await sleep(800);
  await metrics(1400, 900); await sleep(400);
  const vp = await ev(`({w:innerWidth,h:innerHeight})`);
  const gsel = (g) => `.vrow.ghead[data-g="${g}"]`;
  const hdr = (g) => ev(`(()=>{ const n=document.querySelector('${gsel(g)}'); if(!n) return null; const cs=getComputedStyle(n,'::before'); const st=n.querySelector('.gstack'); return { col:n.dataset.col||'', cls:n.className, bg:cs.backgroundColor, bd:cs.borderTopColor, emoji: st? st.classList.contains('emoji'):null, emo: n.querySelector('.gemo')?.textContent||'', emoShown: n.querySelector('.gemo') ? getComputedStyle(n.querySelector('.gemo')).display!=='none':null, favShown: [...n.querySelectorAll('.gstack .fs')].filter(f=>getComputedStyle(f).display!=='none').length, title:n.querySelector('.gtitle,.gt,.title')?.textContent||'' }; })()`);
  const reveal = async (g) => { await ev(`(()=>{ const n=document.querySelector('${gsel(g)}'); const r=n&&!n.hidden&&n.getBoundingClientRect(); if(r&&r.top>=0&&r.bottom<=innerHeight) return; const i=__cmr.V.idxOf.get('${g}'); document.getElementById('scroller').scrollTop=Math.max(0,__cmr.V.tops[i]-70); })()`); await sleep(500); };
  const look = (groupId, o) => msg({ type: 'groupLook', groupId, ...o });
  const waitCol = (g, c) => until(() => ev(`(document.querySelector('${gsel(g)}')?.dataset.col||'')==='${c}'`), 4000);

  console.log('INFO header', (await ev(`document.querySelector('${gsel(A)}').outerHTML.replace(/<svg[\\s\\S]*?<\\/svg>/g,'<svg/>').slice(0,1500)`)));

  // ---------- 1. colours ----------
  const contrast = `
    const P=(c)=>{ let m=c.match(/rgba?\\(([^)]+)\\)/); if(m){ const a=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [a[0],a[1],a[2],a.length>3?a[3]:1]; } m=c.match(/color\\(srgb ([^)]+)\\)/); if(m){ const a=m[1].split(/[ \\/]+/).map(Number); return [a[0]*255,a[1]*255,a[2]*255,a.length>3?a[3]:1]; } return null; };
    const L=(c)=>{ const f=(v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
    const CR=(a,b)=>{ const x=L(a),y=L(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
    const blend=(f,b)=>[f[0]*f[3]+b[0]*(1-f[3]),f[1]*f[3]+b[1]*(1-f[3]),f[2]*f[3]+b[2]*(1-f[3]),1];`;
  const readable = (g) => ev(`(()=>{ ${contrast}
    const n=document.querySelector('${gsel(g)}'); const base=P(getComputedStyle(n,'::before').backgroundColor); const out=[]; const bad=[];
    const w=document.createTreeWalker(n,NodeFilter.SHOW_TEXT); let t;
    while((t=w.nextNode())){ if(!t.textContent.trim()) continue; const e=t.parentElement; if(e.closest('.gemo')) continue; const r=e.getBoundingClientRect(); if(!r.width||getComputedStyle(e).visibility==='hidden') continue;
      let bg=base; const chain=[]; for(let x=e;x&&x!==n.parentElement;x=x.parentElement){ const b=P(getComputedStyle(x).backgroundColor); if(b&&b[3]>0) chain.push(b); }
      for(const b of chain.reverse()) bg=blend(b,bg);
      const fg=P(getComputedStyle(e).color); const op=parseFloat(getComputedStyle(e).opacity); const f2=[fg[0],fg[1],fg[2],fg[3]*op]; const cr=CR(blend(f2,bg),bg); out.push(cr); if(cr<3.2) bad.push(e.className+':'+t.textContent.trim().slice(0,12)+':'+cr.toFixed(2)); }
    const svgs=[...n.querySelectorAll('.acts svg, .tb svg')].map(s=>{ const fg=P(getComputedStyle(s).color); return CR(fg,base); });
    return { minText: Math.min(...out).toFixed(2), n: out.length, bad, minIcon: svgs.length? Math.min(...svgs).toFixed(2):null }; })()`);
  for (const sch of ['light', 'dark']) {
    await scheme(sch);
    for (let c = 1; c <= 8; c++) {
      await look(A, { color: c }); await waitCol(A, c); await sleep(200);
      const h = await hdr(A); const rd = await readable(A);
      const bgOk = h.col === String(c) && h.bg !== 'rgba(0, 0, 0, 0)';
      check(`colour ${c} (${sch}): header filled, text readable (min ${rd.minText}, icons ${rd.minIcon})`, bgOk && parseFloat(rd.minText) >= 3.2 && (rd.minIcon == null || parseFloat(rd.minIcon) >= 3), S({ bg: h.bg, bd: h.bd, bad: rd.bad }));
    }
    await look(A, { color: null }); await waitCol(A, '');
    const plainBg = (await hdr(A)).bg;
    const bgs = new Set();
    for (let c = 1; c <= 8; c++) { await look(A, { color: c }); await waitCol(A, c); bgs.add((await hdr(A)).bg); }
    check(`colours (${sch}): 8 distinct pastels, all different from the uncoloured header (${plainBg})`, bgs.size === 8 && !bgs.has(plainBg), S([...bgs]));
  }
  const extra = [];
  for (let i = 0; i < 5; i++) extra.push(await mkSet('Colour ' + (i + 4), plain('Colour ' + (i + 4), 2)));
  const eight = [A, B, W, ...extra].slice(0, 8);
  await until(() => ev(`__cmr.S.allGroups.length>=8`), 15000);
  for (let i = 0; i < 8; i++) await look(eight[i], { color: i + 1 });
  await sleep(1500);
  await ev(`__cmr.fn.expandAll(false)`); await sleep(600);
  for (const sch of ['light', 'dark']) { await scheme(sch); await shot('colours8-' + sch); }
  await ev(`__cmr.fn.expandAll(true)`); await sleep(600);
  await shot('colours8-open-dark'); await scheme('light'); await shot('colours8-open-light');

  await look(A, { color: 3 }); await waitCol(A, 3);
  await ev(`__cmr.fn.expandAll(false)`); await sleep(400);
  const hh = await rect(gsel(A));
  for (const sch of ['light', 'dark']) {
    await scheme(sch);
    await mouse('mouseMoved', 5, 5, { buttons: 0 }); await sleep(250);
    const b0 = (await hdr(A)).bg;
    await mouse('mouseMoved', hh.x + 300, hh.cy, { buttons: 0 }); await sleep(400);
    const b1 = (await hdr(A)).bg;
    check(`hover (${sch}): coloured header changes shade on hover`, b0 !== b1, S({ b0, b1 }));
    await mouse('mouseMoved', 5, 5, { buttons: 0 });
  }
  await scheme('light');
  for (const [flag, expected] of [['starred', 'accent'], ['pinned', 'warn']]) {
    const r = await ev(`(()=>{ const n=document.querySelector('${gsel(A)}'); const probe=document.createElement('i'); probe.style.color='var(--${expected})'; document.body.appendChild(probe); const want=getComputedStyle(probe).color; probe.remove(); n.classList.add('${flag}'); const bd=getComputedStyle(n,'::before').borderTopColor; n.classList.remove('${flag}'); return { bd, want }; })()`);
    check(`coloured + ${flag}: border still shows the ${flag} colour (var(--${expected}))`, r.bd === r.want, S(r));
  }
  await ev(`__cmr.fn.expandAll(true)`); await sleep(400); await reveal(A);

  // ---------- 2. emoji ----------
  await look(A, { color: null, emoji: '🚀' }); await until(() => ev(`document.querySelector('${gsel(A)} .gstack.emoji')`), 4000); await sleep(300);
  let h = await hdr(A);
  check('emoji: .gstack.emoji, emoji shown, favicon mosaic hidden, title has no emoji prefix', h.emoji && h.emoShown && h.emo === '🚀' && h.favShown === 0 && !h.title.includes('🚀'), S(h));
  await metrics(1600, 900); await sleep(500); await reveal(A);
  const al = await ev(`(()=>{ const n=document.querySelector('${gsel(A)}'); const e=n.querySelector('.gemo').getBoundingClientRect(); const c=n.querySelector('.c-cnt').getBoundingClientRect(); const st=n.querySelector('.gstack').getBoundingClientRect(); return { emoCy:(e.top+e.bottom)/2, cntCy:(c.top+c.bottom)/2, w:e.width, ht:e.height, stack:[st.left,st.right], cnt:c.left, vis:getComputedStyle(n.querySelector('.gstack')).display }; })()`);
  check('emoji: vertically aligned with the chips and not overlapping the count chip', al.vis !== 'none' && Math.abs(al.emoCy - al.cntCy) <= 4 && al.stack[1] <= al.cnt + 1 && al.w > 8, S(al));
  await ev(`__cmr.fn.relayout && __cmr.fn.relayout()`); await sleep(500);
  await msg({ type: 'debug:seedItems', gid: A, items: plain('Colour set', 6).slice(4) }); await sleep(1500);
  h = await hdr(A);
  check('emoji: still replaces the mosaic after repaint / new items', h.emoji && h.favShown === 0, S(h));
  await look(A, { color: 5 }); await waitCol(A, 5); await sleep(300); await shot('emoji-colour-light'); await scheme('dark'); await shot('emoji-colour-dark'); await scheme('light');
  await look(A, { emoji: '' }); await until(() => ev(`!document.querySelector('${gsel(A)} .gstack.emoji')`), 4000);
  h = await hdr(A);
  check('emoji removed: mosaic comes back (favicon slots visible)', !h.emoji && !h.emoShown && h.favShown > 0, S(h));
  await metrics(1400, 900); await sleep(400);
  await look(A, { color: null }); await waitCol(A, '');
  for (const g of eight.slice(1)) await look(g, { color: null });
  await sleep(500);

  // ---------- 4. the ⋯ menu ----------
  const menu = () => ev(`(()=>{ const m=document.getElementById('moreMenu'); const r=m.getBoundingClientRect(); const vis=(e)=>!!(e.offsetParent||e.getClientRects().length); return { open: !m.hidden && vis(m) && r.width>0, x:r.left, y:r.top, r:r.right, b:r.bottom, h:r.height, sh:m.scrollHeight, ch:m.clientHeight, scroll:getComputedStyle(m).overflowY, tiles:[...m.querySelectorAll('.mtile')].map(t=>({act:t.dataset.act,on:t.getAttribute('aria-checked'),cls:t.classList.contains('on'),role:t.getAttribute('role')})), items:[...m.querySelectorAll(':scope > .mitem, :scope > .msep')].map(x=>x.classList.contains('msep')?'---':x.dataset.act+':'+x.textContent.trim().slice(0,22)), nested:!!m.querySelector('[data-act="subMore"],[data-act="mMore"]') }; })()`);
  const openMore = async (g) => { await reveal(g); await ev(`document.querySelector('${gsel(g)} [data-act="more"]').click()`); await sleep(500); return menu(); };
  const closeAny = async () => { await key('Escape', 27); await sleep(200); };
  let m = await openMore(A);
  check('⋯ menu: opens next to the ⋯ button, inside viewport', m.open && m.r <= vp.w && m.b <= vp.h && m.x >= 0, S({ x: m.x, y: m.y, r: m.r, b: m.b }));
  check('⋯ menu: 4 toggle tiles pin/star/archive/lock (role menuitemcheckbox, aria-checked false)', S(m.tiles.map((t) => t.act)) === S(['mPin', 'mStar', 'mArchive', 'mLock']) && m.tiles.every((t) => t.on === 'false' && !t.cls && t.role === 'menuitemcheckbox'), S(m.tiles));
  const want = ['mRename', 'mLookDlg', 'mNote', 'mMoveCat', '---', 'subToggle', 'printGroup', 'subToggle', '---', 'mDedupe', 'mImportHere', 'mPending', '---', 'mTrash'];
  const got = m.items.map((s) => s.split(':')[0]).filter((x) => x !== 'mSync');
  check('⋯ menu: order Rename / Colour&emoji / Note / Move, sep, Copy▸ Print Open other▸, sep, dedupe import to-do, sep, Trash; no nested More', S(got) === S(want) && !m.nested, S(m.items));
  await shot('more-menu-light'); await scheme('dark'); await shot('more-menu-dark'); await scheme('light');
  await key('ArrowDown', 40); await key('ArrowDown', 40);
  const foc1 = await ev(`document.activeElement.dataset.act||document.activeElement.className`);
  await key('ArrowUp', 38);
  const foc2 = await ev(`document.activeElement.dataset.act||document.activeElement.className`);
  check('⋯ menu: ArrowDown/ArrowUp move focus among items', foc1 !== foc2 && !!foc1, S({ foc1, foc2 }));
  for (const [label, expect] of [['Copy', ['copyGroup']], ['Open another', ['mRestoreIncog', 'refreshSession']]]) {
    const r = await ev(`(()=>{ const p=[...document.querySelectorAll('#moreMenu .msp')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)})); if(!p) return null; p.click(); const b=p.nextElementSibling; const r=b.getBoundingClientRect(); return { open:!b.hidden, exp:p.getAttribute('aria-expanded'), acts:[...b.querySelectorAll('.mitem')].map(x=>x.dataset.act), r:r.right, b:r.bottom, w:r.width }; })()`);
    await sleep(300);
    check(`submenu "${label}" opens with its items, inside the viewport`, r && r.open && r.exp === 'true' && expect.every((a) => r.acts.includes(a)) && r.r <= vp.w && r.b <= vp.h, S(r));
  }
  await shot('more-menu-submenu-light');
  await closeAny();
  await closeAny();
  check('⋯ menu: first Esc closes the open submenu, second closes the menu', !(await menu()).open);

  for (const [act, flag] of [['mPin', 'pinned'], ['mStar', 'starred'], ['mLock', 'locked'], ['mArchive', 'archived']]) {
    await openMore(B);
    const rt = await rect(`#moreMenu .mtile[data-act="${act}"]`);
    await lclick(rt.cx, rt.cy);
    const after = await menu();
    const gOn = await until(() => ev(`!!__cmr.S.allGroups.find(x=>x.id==='${B}')?.${flag}`), 4000);
    check(`tile ${act}: click sets ${flag} and closes the menu`, gOn && !after.open, S({ open: after.open }));
    if (act === 'mArchive') { await ev(`document.querySelector('.navi[data-nav="archived"]').click()`); await sleep(1000); }
    const mm = await openMore(B);
    const tl = mm.tiles.find((t) => t.act === act);
    check(`tile ${act}: reopened menu shows the on state (aria-checked true, .on)`, tl && tl.on === 'true' && tl.cls, S(mm.tiles));
    if (act === 'mLock') await shot('more-menu-tiles-on-light');
    const rt2 = await rect(`#moreMenu .mtile[data-act="${act}"]`);
    await lclick(rt2.cx, rt2.cy);
    const gOff = await until(() => ev(`!__cmr.S.allGroups.find(x=>x.id==='${B}')?.${flag}`), 4000);
    check(`tile ${act}: second click clears ${flag}`, gOff);
    if (act === 'mArchive') { await ev(`document.querySelector('.navi[data-nav="all"]').click()`); await sleep(1000); }
  }
  await openMore(B);
  await ev(`window.__promptReply='Renamed set'; document.querySelector('#moreMenu [data-act="mRename"]').click()`); await sleep(700);
  check('item Rename: asks for a name and renames', await until(() => ev(`__cmr.S.allGroups.find(x=>x.id==='${B}')?.title==='Renamed set'`), 4000) && !(await menu()).open);
  await openMore(B);
  await ev(`window.__promptReply='a note'; document.querySelector('#moreMenu [data-act="mNote"]').click()`); await sleep(700);
  check('item Note: stores the note', await until(() => ev(`__cmr.S.allGroups.find(x=>x.id==='${B}')?.note==='a note'`), 4000));
  await openMore(B);
  await ev(`document.querySelector('#moreMenu [data-act="mMoveCat"]').click()`); await sleep(600);
  const mc = await ev(`(()=>{ const m=document.getElementById('moreMenu'); return { labels:[...m.querySelectorAll('.mitem')].map(x=>x.textContent.trim()).slice(0,6), cat:!!document.querySelector('[data-act="moveToCat"]'), open:!m.hidden }; })()`);
  check('item Move to category: opens a picker', mc.cat, S(mc)); await closeAny(); await closeAny();
  await openMore(B);
  await ev(`document.querySelector('#moreMenu [data-act="mPending"]').click()`); await sleep(500);
  check('item To-do toggles pending', await until(() => ev(`!!__cmr.S.allGroups.find(x=>x.id==='${B}')?.pending`), 4000));
  const pend = await openMore(B); await closeAny();
  check('only-if rules: single window / no tab groups -> no merge, no ungroup', !pend.items.some((x) => x.startsWith('mMergeWin') || x.startsWith('mUngroupAll')), S(pend.items));
  check('To-do item shows its on-state (aria-checked)', await ev(`(async()=>{ document.querySelector('${gsel(B)} [data-act="more"]').click(); await new Promise(r=>setTimeout(r,400)); const x=document.querySelector('#moreMenu [data-act="mPending"]').getAttribute('aria-checked'); return x==='true'; })()`)); await closeAny();
  m = await openMore(W);
  check('multi-window set with tab groups shows merge + ungroup', m.items.some((x) => x.startsWith('mMergeWin')) && m.items.some((x) => x.startsWith('mUngroupAll')), S(m.items));
  await shot('more-menu-windows-set-light'); await closeAny();
  await openMore(B);
  await ev(`document.querySelector('#moreMenu [data-act="mDedupe"]').click()`); await sleep(700);
  check('item Dedupe: closes the menu and answers with a toast', !(await menu()).open && await ev(`!document.getElementById('toast').hidden`));
  await openMore(B);
  await ev(`document.querySelector('#moreMenu .msp').click()`); await sleep(300);
  await ev(`document.querySelector('#moreMenu .msub [data-act="copyGroup"]').click()`); await sleep(700);
  check('submenu item Copy: closes the menu and toasts', !(await menu()).open && await ev(`!document.getElementById('toast').hidden`));
  for (const hgt of [420, 320]) {
    await metrics(1400, hgt); await sleep(500);
    await reveal(W);
    m = await openMore(W);
    const reach = await ev(`(()=>{ const mm=document.getElementById('moreMenu'); mm.scrollTop=mm.scrollHeight; const t=mm.querySelector('[data-act="mTrash"]').getBoundingClientRect(); const r=mm.getBoundingClientRect(); const ok=t.bottom<=r.bottom+1 && t.top>=r.top-1 && r.bottom<=innerHeight; mm.scrollTop=0; return { ok, trashB:t.bottom, menuB:r.bottom, vh:innerHeight }; })()`);
    check(`⋯ menu at viewport height ${hgt}: inside viewport, scrollable to Trash`, m.open && m.b <= hgt && m.y >= 0 && (m.sh <= m.ch + 1 || /auto|scroll/.test(m.scroll)) && reach.ok, S({ m: { y: m.y, b: m.b, h: m.h, sh: m.sh, ch: m.ch, scroll: m.scroll }, reach }));
    await shot('more-menu-h' + hgt + '-light'); await scheme('dark'); await shot('more-menu-h' + hgt + '-dark'); await scheme('light');
    await closeAny();
  }
  await metrics(1400, 900); await sleep(500);

  // ---------- 5. context menu -> More… at the pointer ----------
  const ctxHidden = () => ev(`document.getElementById('ctxMenu').hidden`);
  const ctxMore = async (px, py) => {
    await rclick(px, py);
    if (await ctxHidden()) return { err: 'ctx menu not open' };
    const ok = await ev(`(()=>{ const b=[...document.querySelectorAll('#ctxMenu .mitem')].find(x=>x.textContent.trim().startsWith('More')); if(!b) return false; b.click(); return true; })()`);
    await sleep(500);
    return { ok, m: await menu() };
  };
  await reveal(A);
  const hdrR = await rect(gsel(A));
  await mouse('mouseMoved', 5, 5, { buttons: 0 });
  const moreBtn = await rect(gsel(A) + ' [data-act="more"]');
  for (const [name, px, py] of [['middle', hdrR.x + 450, hdrR.cy], ['near right edge', hdrR.r - 5, hdrR.cy]]) {
    const r = await ctxMore(px, py);
    const near = r.m && (Math.abs(r.m.x - px) <= 16 || Math.abs(r.m.r - px) <= 16) && (Math.abs(r.m.y - py) <= 40 || Math.abs(r.m.b - py) <= 40);
    check(`ctx More… (${name}): ⋯ menu at the pointer (${px},${Math.round(py)}), inside viewport`, r.m && r.m.open && near && r.m.r <= vp.w && r.m.b <= vp.h && r.m.x >= 0, S({ err: r.err, px, py, m: r.m && { x: r.m.x, y: r.m.y, r: r.m.r, b: r.m.b }, btnX: moreBtn.x }));
    if (name === 'middle') await shot('ctx-more-at-pointer-light');
    await closeAny(); await closeAny();
  }
  // low on screen: shrink the viewport so the header sits near the bottom edge
  await metrics(1400, 560); await sleep(500);
  await reveal(A);
  await ev(`(()=>{ const sc=document.getElementById('scroller'); const n=document.querySelector('${gsel(A)}'); const t=n.getBoundingClientRect().top; sc.scrollTop=Math.max(0,sc.scrollTop-(innerHeight-120-t)); })()`); await sleep(500);
  const lowR = await rect(gsel(A));
  console.log('INFO low header at', Math.round(lowR.cy), 'of 560');
  const rl = await ctxMore(lowR.x + 450, lowR.cy);
  check('ctx More… (header near the bottom edge): menu inside the viewport', rl.m && rl.m.open && rl.m.b <= 560 && rl.m.y >= 0 && rl.m.r <= vp.w, S({ y: lowR.cy, err: rl.err, m: rl.m && { y: rl.m.y, b: rl.m.b } }));
  await shot('ctx-more-bottom-light'); await closeAny(); await closeAny();
  await metrics(1400, 900); await sleep(500);
  m = await openMore(A);
  check('⋯ button path still anchors under the button', Math.abs(m.r - moreBtn.r) <= 12 || Math.abs(m.x - moreBtn.x) <= 12, S({ mr: m.r, btnR: moreBtn.r, mx: m.x }));
  await closeAny();

  // ---------- 3. dialog ----------
  const dlg = () => ev(`(()=>{ const d=document.querySelector('dialog.look-dlg'); if(!d) return null; const r=d.getBoundingClientRect(); return { open:d.open, x:r.left,y:r.top,r:r.right,b:r.bottom, sw:d.querySelectorAll('.ld-c').length, tabs:[...d.querySelectorAll('.ld-tab')].map(t=>t.title), tabOn:d.querySelector('.ld-tab.on')?.dataset.id, emo:[...d.querySelectorAll('.ld-e')].map(e=>e.textContent), prev:d.querySelector('.ld-prev')?.textContent, prevCol:d.querySelector('.ld-prev')?.dataset.col, onC:d.querySelector('.ld-c.on')?.dataset.c, focus:document.activeElement.className }; })()`);
  await ev(`localStorage.removeItem('cmr.emojiRecent')`);
  await reveal(A);
  await openMore(A);
  await ev(`document.querySelector('#moreMenu [data-act="mLookDlg"]').click()`); await sleep(600);
  let d = await dlg();
  check('dialog: opens as modal from the menu item, 9 swatches (none + 8), 10 tabs (frequent + 9 categories), grid filled', d && d.open && d.sw === 9 && d.tabs.length === 10 && d.emo.length > 10 && d.x >= 0 && d.b <= vp.h && d.r <= vp.w, S(d && { sw: d.sw, tabs: d.tabs, n: d.emo.length, b: d.b }));
  await shot('look-dialog-light'); await scheme('dark'); await shot('look-dialog-dark'); await scheme('light');
  const sw3 = await rect('dialog.look-dlg .ld-c[data-c="3"]');
  await lclick(sw3.cx, sw3.cy);
  check('dialog: swatch click applies the colour at once (header data-col=3, preview, aria-checked)', await waitCol(A, 3) && (await dlg()).onC === '3' && (await dlg()).prevCol === '3');
  const grids = [];
  const nTabs = d.tabs.length;
  for (let i = 0; i < nTabs; i++) {
    const tb = await rect(`dialog.look-dlg .ld-tab:nth-child(${i + 1})`);
    await lclick(tb.cx, tb.cy);
    const dd = await dlg();
    if (!dd) { console.log('INFO dialog gone after tab', i, S(tb), S(await ev(`({w:innerWidth,h:innerHeight,tgt:document.elementFromPoint(${tb.cx},${tb.cy})?.className})`))); break; }
    grids.push({ id: dd.tabOn, n: dd.emo.length, first: dd.emo[0] });
  }
  check('dialog: every tab switches the grid (all distinct tabs, categories non-empty)', new Set(grids.map((x) => x.id)).size === nTabs && grids.slice(1).every((x) => x.n > 10) && new Set(grids.map((x) => x.first)).size >= 8, S(grids));
  await shot('look-dialog-category-light');
  const e1 = await rect('dialog.look-dlg .ld-e:nth-child(5)');
  const e1t = await ev(`document.querySelector('dialog.look-dlg .ld-e:nth-child(5)').textContent`);
  await lclick(e1.cx, e1.cy);
  check('dialog: emoji click applies at once (header emoji)', await until(() => ev(`document.querySelector('${gsel(A)} .gemo')?.textContent===${JSON.stringify(e1t)}`), 4000), e1t);
  const rec = await ev(`localStorage.getItem('cmr.emojiRecent')`);
  check('dialog: recents saved in localStorage cmr.emojiRecent', rec && JSON.parse(rec)[0] === e1t, rec);
  const tf = await rect('dialog.look-dlg .ld-tab:nth-child(1)'); await lclick(tf.cx, tf.cy);
  d = await dlg();
  check('dialog: "frequent" tab lists the recent emoji first', d.emo[0] === e1t && d.tabOn === 'freq', S(d.emo.slice(0, 3)));
  const tc = await rect('dialog.look-dlg .ld-tab:nth-child(3)'); await lclick(tc.cx, tc.cy);
  const e2t = await ev(`document.querySelector('dialog.look-dlg .ld-e:nth-child(2)').textContent`);
  const e2 = await rect('dialog.look-dlg .ld-e:nth-child(2)'); await lclick(e2.cx, e2.cy);
  await lclick(tf.cx, tf.cy);
  d = await dlg();
  check('dialog: newest recent comes first, previous second', d.emo[0] === e2t && d.emo[1] === e1t, S(d.emo.slice(0, 3)));
  await key('Escape', 27);
  check('dialog: Esc closes it', (await dlg()) === null);
  await pg.send('Page.reload'); await sleep(3500); await until(() => ev(`__cmr.V.idxOf.has('${A}')`), 15000);
  await ev(prep); await sleep(800); await reveal(A);
  h = await hdr(A);
  check('persist: colour 3 + emoji survive a reload', h.col === '3' && h.emo === e2t && h.emoji, S({ col: h.col, emo: h.emo }));
  await shot('look-persisted-light'); await scheme('dark'); await shot('look-persisted-dark'); await scheme('light');
  await reveal(A);
  await openMore(A); await ev(`document.querySelector('#moreMenu [data-act="mLookDlg"]').click()`); await sleep(600);
  d = await dlg();
  check('dialog reopened: current colour and emoji are marked', d.onC === '3' && d.prev === e2t, S({ onC: d.onC, prev: d.prev }));
  check('dialog: initial focus on Done (keyboard friendly)', /primary/.test(d.focus), d.focus);
  const trail = [];
  for (let i = 0; i < 40; i++) { await key('Tab', 9, 8); const f = await ev(`(()=>{ const a=document.activeElement; return a.className+'|'+(a.dataset.c||a.dataset.id||''); })()`); trail.push(f); if (/(^|s)ld-c(s||)/.test(f)) break; }
  check('dialog: Shift+Tab reaches the colour swatches (keyboard only)', /(^|s)ld-c(s||)/.test(trail[trail.length - 1]), trail.slice(-4).join(' > '));
  const cc = trail[trail.length - 1].split('|')[1];
  await enter();
  const afterEnter = await dlg();
  check('dialog: Enter on a focused swatch applies it', afterEnter && afterEnter.onC === cc && await waitCol(A, cc), S({ cc, onC: afterEnter && afterEnter.onC }));
  let inside = true;
  for (let i = 0; i < 30; i++) { await key('Tab', 9); if (!(await ev(`document.activeElement===document.body || !!document.activeElement.closest('dialog.look-dlg')`))) { inside = false; break; } }
  check('dialog: Tab focus stays inside the modal', inside);
  const sw0 = await rect('dialog.look-dlg .ld-c[data-c="0"]'); await lclick(sw0.cx, sw0.cy);
  check('dialog: "none" swatch removes the colour', await waitCol(A, ''), S((await hdr(A)).col));
  const clr = await rect('dialog.look-dlg .ld-clear'); await lclick(clr.cx, clr.cy);
  check('dialog: "remove emoji" clears the emoji (mosaic back)', await until(() => ev(`!document.querySelector('${gsel(A)} .gstack.emoji')`), 4000));
  await shot('look-dialog-cleared-light');
  const dn = await rect('dialog.look-dlg .btn.primary'); await lclick(dn.cx, dn.cy);
  check('dialog: Done closes it', (await dlg()) === null);
  await metrics(900, 380); await sleep(400);
  await reveal(A);
  await openMore(A); await ev(`document.querySelector('#moreMenu [data-act="mLookDlg"]').click()`); await sleep(600);
  d = await dlg();
  const reachD = await ev(`(()=>{ const dl=document.querySelector('dialog.look-dlg'); const r=dl.getBoundingClientRect(); const cs=getComputedStyle(dl); return { y:r.top,b:r.bottom,h:r.height, ov:cs.overflowY, sh:dl.scrollHeight, ch:dl.clientHeight }; })()`);
  check('dialog at 380px height: inside viewport and scrollable if taller', d && reachD.y >= -1 && reachD.b <= 381 && (reachD.sh <= reachD.ch + 1 || /auto|scroll/.test(reachD.ov)), S(reachD));
  await shot('look-dialog-h380-light');
  await key('Escape', 27);
  await metrics(1400, 900); await sleep(400);

  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nlook-menu-regression: ${failures} FAILED` : '\nlook-menu-regression: all passed');
process.exit(failures ? 1 : 0);
