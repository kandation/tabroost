// Our own <dialog> question dialogs (lib/dialogs.js) instead of window.prompt / confirm / alert (real Chrome over CDP).
//   node tests/ui/dialogs-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9368;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-dialogs-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-dialogs-shots');
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
  const EXT = ld.result.id;
  await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=1`, newWindow: true, width: 1400, height: 900 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 500)); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await fn()) return true; await sleep(150); } return false; };
  const shot = async (name) => { const r = await pg.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const scheme = (s) => pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] });
  const key = async (k, vk, modifiers = 0) => { await pg.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, modifiers }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, modifiers }); await sleep(300); };
  const typeText = async (t) => { await pg.send('Input.insertText', { text: t }); await sleep(150); };
  const rect = (sel) => ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}; })()`);
  const lclick = async (x, y) => { for (const [type, b] of [['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseReleased', 'left']]) await pg.send('Input.dispatchMouseEvent', { type, x, y, button: b, buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(350); };
  const S = JSON.stringify;
  await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:'en'}}))`); await pg.send('Page.reload'); await sleep(3000);

  // no native dialog may ever be called: record every call (and answer in a way that would change behaviour, so a leak is visible)
  const stubs = `(()=>{ window.__native = []; for (const k of ['prompt','confirm','alert']) window[k] = (...a) => { window.__native.push(k + ':' + String(a[0]).slice(0,40)); return k === 'prompt' ? 'NATIVE' : true; }; })()`;
  await ev(stubs);

  const mkSet = async (title, items) => {
    const g = (await msg({ type: 'debug:seedGroup', title })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g;
  };
  const plain = (title, n) => Array.from({ length: n }, (_, i) => ({ url: `https://${'abc'[i % 3]}.example.test/${title.replace(/ /g, '')}/${i}`, title: `${title} tab ${i}` }));
  const A = await mkSet('Alpha set', plain('Alpha', 3));
  const BIG = await mkSet('Big set', plain('Big', 60));
  await until(() => ev(`__cmr.S.allGroups.length>=2`), 15000);
  await ev(`(()=>{ const st=document.createElement('style'); st.textContent='#welcome, #panels, .banner { display: none !important; }'; document.head.appendChild(st); window.__errs=[]; addEventListener('error',(e)=>__errs.push(String(e.message))); addEventListener('unhandledrejection',(e)=>__errs.push(String(e.reason&&e.reason.message||e.reason))); })()`);
  await sleep(500);

  const dlg = () => ev(`(()=>{ const d=document.querySelector('dialog.cmd-dlg[open]'); if(!d) return null; const r=d.getBoundingClientRect(); const f=d.querySelector('.cmd-in'); const ok=d.querySelector('.cmd-ok'); const ae=document.activeElement;
    return { modal:d.matches(':modal'), title:(d.querySelector('.cmd-t')||{}).textContent||'', aria:d.getAttribute('aria-label'), msg:(d.querySelector('.cmd-msg')||{}).textContent||'', label:(d.querySelector('.cmd-lab')||{}).textContent||'', tag:f?f.tagName:'', value:f?f.value:'', ph:f?f.placeholder:'',
      ok:ok.textContent, cancel:d.querySelector('.cmd-cancel').textContent, okDisabled:ok.disabled, danger:d.classList.contains('danger'), focus:ae===f?'field':(ae&&ae.className)||'', selAll:f?(f.selectionStart===0&&f.selectionEnd===f.value.length):null,
      x:r.left,y:r.top,r:r.right,b:r.bottom,w:r.width, h:r.height, bg:getComputedStyle(d).backgroundColor }; })()`);
  const noDlg = async () => (await until(() => ev(`!document.querySelector('dialog.cmd-dlg')`), 3000));
  const native = () => ev(`window.__native.slice()`);
  const openMore = async (g) => {
    await ev(`(()=>{ const i=__cmr.V.idxOf.get('${g}'); document.getElementById('scroller').scrollTop=Math.max(0,__cmr.V.tops[i]-80); })()`); await sleep(700);
    await ev(`document.querySelector('.vrow.ghead[data-g="${g}"] [data-act="more"]').click()`); await sleep(500);
  };
  const menuClick = async (act) => { await ev(`document.querySelector('#moreMenu [data-act="${act}"]').click()`); await sleep(500); };
  const fire = async (act, attrs = {}) => { // a synthetic [data-act] button, handled by the page's delegated click handler like a real one
    await ev(`(()=>{ const b=document.createElement('button'); b.id='tmpAct'; b.dataset.act=${S(act)}; for (const [k,v] of Object.entries(${S(attrs)})) b.dataset[k]=v; document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(500);
  };
  const okBtn = () => rect('dialog.cmd-dlg .cmd-ok');
  const cancelBtn = () => rect('dialog.cmd-dlg .cmd-cancel');
  const groupField = (g, f) => ev(`__cmr.S.allGroups.find((x)=>x.id==='${g}')?.${f}`);

  // ---------- 1. import: a real <dialog> with a textarea ----------
  await openMore(A); await menuClick('mImportHere');
  let d = await dlg();
  check('import: opens as a modal <dialog> with a multi-line textarea', !!d && d.modal && d.tag === 'TEXTAREA', S(d));
  check('import: exact old message is the label, titled, aria-label set, buttons labelled', d && d.label === 'Paste links (one per line, or OneTab text)' && d.title === 'Import links' && d.aria === 'Import links' && d.ok === 'OK' && d.cancel === 'Cancel', S(d));
  check('import: field is focused', d && d.focus === 'field', S(d));
  check('import: inside the viewport', d && d.x >= 0 && d.y >= 0 && d.r <= 1400 && d.b <= 900, S(d));
  await shot('import-light'); await scheme('dark'); await sleep(200); await shot('import-dark'); await scheme('light');
  // Esc cancels, nothing imported
  const cnt0 = await groupField(A, 'count');
  await typeText('https://esc.example.test/x'); await key('Escape', 27);
  check('import: Esc closes the dialog and imports nothing', (await noDlg()) && (await groupField(A, 'count')) === cnt0 && (await native()).length === 0, S({ cnt0, now: await groupField(A, 'count') }));
  // paste links + OK
  await openMore(A); await menuClick('mImportHere');
  await typeText('https://one.example.test/a\nhttps://two.example.test/b\nhttps://three.example.test/c');
  d = await dlg();
  check('import: Enter in the textarea adds a line (does not submit)', d && d.value.split('\n').length === 3, S(d));
  await key('Enter', 13); d = await dlg();
  check('import: plain Enter keeps the dialog open', !!d, S(d && d.value));
  await key('Backspace', 8);
  const ob = await okBtn(); await lclick(ob.cx, ob.cy);
  check('import: OK closes and imports the 3 pasted links', (await noDlg()) && await until(async () => (await groupField(A, 'count')) === cnt0 + 3, 8000), S({ cnt0, now: await groupField(A, 'count') }));
  // Ctrl+Enter submits
  await openMore(A); await menuClick('mImportHere');
  await typeText('https://four.example.test/d');
  await key('Enter', 13, 2);
  check('import: Ctrl+Enter submits', (await noDlg()) && await until(async () => (await groupField(A, 'count')) === cnt0 + 4, 8000));
  // backdrop click cancels
  await openMore(A); await menuClick('mImportHere'); await typeText('https://backdrop.example.test/z');
  await lclick(5, 5);
  check('import: a click on the backdrop cancels', (await noDlg()) && (await groupField(A, 'count')) === cnt0 + 4);
  // Cancel button
  await openMore(A); await menuClick('mImportHere'); await typeText('https://cancel.example.test/z');
  const cb = await cancelBtn(); await lclick(cb.cx, cb.cy);
  check('import: Cancel button cancels', (await noDlg()) && (await groupField(A, 'count')) === cnt0 + 4);

  // ---------- 2. rename (single line) ----------
  await openMore(A); await menuClick('mRename');
  d = await dlg();
  check('rename: single-line input, current title preselected, titled', d && d.tag === 'INPUT' && d.value === 'Alpha set' && d.selAll === true && d.label === 'Tab set name' && d.title === 'Rename tab set', S(d));
  await typeText('Renamed by dialog'); await key('Enter', 13);
  check('rename: Enter submits and the set is renamed', (await noDlg()) && await until(async () => (await groupField(A, 'title')) === 'Renamed by dialog', 8000), await groupField(A, 'title'));
  await openMore(A); await menuClick('mRename'); await typeText('Should not apply'); await key('Escape', 27);
  check('rename: Esc leaves the title as it was', (await noDlg()) && (await groupField(A, 'title')) === 'Renamed by dialog');
  // note is multi-line
  await openMore(A); await menuClick('mNote'); d = await dlg();
  check('note: multi-line textarea', d && d.tag === 'TEXTAREA' && d.label === 'Note for this tab set', S(d));
  await typeText('line one\nline two'); await key('Enter', 13, 2);
  check('note: Ctrl+Enter saves a two-line note', (await noDlg()) && await until(async () => (await groupField(A, 'note')) === 'line one\nline two', 8000), S(await groupField(A, 'note')));

  // ---------- 3. confirms ----------
  // 3a. danger confirm (delete usage stats): cancel, then OK
  await fire('actPurgeAll'); d = await dlg();
  check('confirm: opens, message kept, danger OK button, focus on OK', d && d.modal && /Delete all usage stats/.test(d.msg) && d.danger && d.focus.includes('cmd-ok') && d.tag === '' && d.title === 'Delete usage stats', S(d));
  await shot('confirm-danger-light'); await scheme('dark'); await sleep(200); await shot('confirm-danger-dark'); await scheme('light');
  await key('Escape', 27);
  check('confirm: Esc = cancel (stats not purged)', (await noDlg()) && !(await ev(`!document.getElementById('actPurgeProg').hidden`)));
  await fire('actPurgeAll'); const cb2 = await cancelBtn(); await lclick(cb2.cx, cb2.cy);
  check('confirm: Cancel button = cancel', (await noDlg()) && !(await ev(`!document.getElementById('actPurgeProg').hidden`)));
  await fire('actPurgeAll'); const ob2 = await okBtn(); await lclick(ob2.cx, ob2.cy);
  check('confirm: OK = proceed (purge progress shown)', (await noDlg()) && await until(() => ev(`document.getElementById('actPurgeProg').textContent!==''`), 5000));
  // 3b. purge one trashed set for good
  const T = await mkSet('Trash me', plain('Trash', 2));
  await msg({ type: 'deleteGroup', groupId: T }); await sleep(800);
  const inTrash = () => ev(`import(location.origin + '/lib/db.js').then(async (db)=>{ const t = await db.listTrash(); return (t.groups||[]).some((g)=>g.id==='${T}') || JSON.stringify(t).includes('${T}'); })`);
  const had = await inTrash();
  await fire('purgeGroup', { g: T }); d = await dlg();
  check('purge confirm: danger dialog with the exact old message', had && d && d.danger && d.msg === 'Delete this tab set for good? This cannot be undone.', S({ had, d }));
  await key('Escape', 27); await noDlg(); await sleep(300);
  check('purge confirm: cancel keeps the set in the trash', await inTrash());
  await fire('purgeGroup', { g: T }); const ob3 = await okBtn(); await lclick(ob3.cx, ob3.cy);
  check('purge confirm: OK removes it for good', (await noDlg()) && await until(async () => !(await inTrash()), 6000));
  // 3c. "open many tabs" confirm (60 > 50): cancel must open nothing
  const tabsBefore = await ev(`chrome.tabs.query({}).then((t)=>t.length)`);
  await fire('openGroup', { g: BIG }); d = await dlg();
  check('open-many confirm: opens with the exact old message, not danger', d && !d.danger && /open 60 tabs/.test(d.msg) && d.title === 'Open many tabs', S(d));
  const cb3 = await cancelBtn(); await lclick(cb3.cx, cb3.cy); await sleep(1200);
  check('open-many confirm: Cancel opens no tab', (await noDlg()) && (await ev(`chrome.tabs.query({}).then((t)=>t.length)`)) === tabsBefore);
  // 3d. the tidy-up confirm only shows when there is something to tidy; check the dialog helper directly for the long multi-line message
  await ev(`import('./lib/dialogs.js').then((m)=>{ window.__p = m.askConfirm({ title:'Tidy tabs', message:'Tidying up will:\\n• Close 3 duplicate tab(s) (you can reopen them)\\n• Chrome internal pages: close 1 without saving · save 2 to the list\\n• Put 5 idle tab(s) to sleep', okLabel:'OK', cancelLabel:'Cancel' }); })`); await sleep(400);
  d = await dlg();
  check('multi-line message keeps its line breaks (pre-wrap)', d && await ev(`getComputedStyle(document.querySelector('.cmd-msg')).whiteSpace`) === 'pre-wrap' && d.msg.split('\n').length === 4, S(d));
  await key('Enter', 13);
  check('confirm helper: Enter on the focused OK resolves true', (await ev(`window.__p`)) === true || (await ev(`window.__p.then((v)=>v)`)) === true);
  // textContent only: markup in a message is shown literally
  await ev(`import('./lib/dialogs.js').then((m)=>{ window.__q = m.askText({ title:'<b>t</b>', message:'<img src=x onerror="window.__xss=1">', label:'<i>l</i>', value:'<u>v</u>' }); })`); await sleep(400);
  check('no innerHTML: markup in title/message/label is inert text', await ev(`!window.__xss && !document.querySelector('.cmd-dlg img, .cmd-dlg b, .cmd-dlg i') && document.querySelector('.cmd-t').textContent==='<b>t</b>'`));
  await key('Escape', 27);
  check('askText: Esc resolves null', (await ev(`window.__q`)) === null);

  // ---------- 4. category prompt ----------
  await fire('catAdd'); d = await dlg();
  check('category: input dialog (old label "Category name"), titled', d && d.tag === 'INPUT' && d.label === 'Category name' && d.title === 'New category', S(d));
  await typeText('Dialog cat'); await key('Enter', 13);
  check('category: Enter creates it', (await noDlg()) && await until(() => ev(`document.getElementById('catList').textContent.includes('Dialog cat')`), 6000));

  // ---------- 5. RESET gate ----------
  await fire('dbReset'); d = await dlg();
  check('RESET: message shown, field empty, OK disabled', d && d.tag === 'INPUT' && /Type RESET to confirm/.test(d.msg) && d.value === '' && d.okDisabled && d.title === 'Reset the list', S(d));
  await shot('reset-light');
  await typeText('reset'); d = await dlg();
  check('RESET: lower-case "reset" keeps OK disabled', d && d.okDisabled, S(d));
  await key('Enter', 13); d = await dlg();
  check('RESET: Enter does not submit while disabled', !!d);
  await typeText(' '); d = await dlg();
  check('RESET: "reset " still disabled', d && d.okDisabled);
  await ev(`(()=>{ const f=document.querySelector('.cmd-in'); f.value=''; f.dispatchEvent(new Event('input',{bubbles:true})); })()`); await typeText('RESET'); d = await dlg();
  check('RESET: exactly RESET enables OK', d && !d.okDisabled, S(d));
  await typeText('X'); d = await dlg();
  check('RESET: RESETX disables it again', d && d.okDisabled);
  await key('Escape', 27);
  check('RESET: Esc cancels without resetting', (await noDlg()) && (await ev(`__cmr.S.allGroups.length`)) >= 2);

  // ---------- 6. no native dialog ever ----------
  const nat = await native(); const errs = await ev(`window.__errs`);
  check('window.prompt / confirm / alert were never called', nat.length === 0, S(nat));
  check('no page errors', errs.length === 0, S(errs));

  // ---------- 7. popup width (380px page): dialog fits ----------
  const pop = await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/popup.html`, newWindow: true, width: 420, height: 700 });
  await sleep(2500);
  const pt = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('popup.html'));
  const pp = await cdp(pt.webSocketDebuggerUrl);
  await pp.send('Runtime.enable'); await pp.send('Page.bringToFront'); await pp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await pp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 560, deviceScaleFactor: 1, mobile: false });
  const pev = async (expr) => { const r = await pp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };
  await pev(`import('./lib/dialogs.js').then((m)=>{ window.__pp = m.askConfirm({ title:'Tidy tabs', message:'Tidy tabs now. This will:\\n• close 3 duplicate tab(s) (you can reopen them)\\n• Chrome internal pages: close 1, save to the list and close 2\\n• put 5 unused tab(s) to sleep', okLabel:'OK', cancelLabel:'Cancel' }); })`); await sleep(500);
  const pd = await pev(`(()=>{ const d=document.querySelector('dialog.cmd-dlg[open]'); const r=d.getBoundingClientRect(); return { x:r.left, r:r.right, y:r.top, b:r.bottom, vw:innerWidth, vh:innerHeight, sw:document.documentElement.scrollWidth }; })()`);
  check('popup: dialog fits inside the 380px popup, no horizontal overflow', pd.x >= 0 && pd.r <= pd.vw && pd.y >= 0 && pd.b <= pd.vh && pd.sw <= pd.vw, S(pd));
  const ps = await pp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, 'popup-confirm.png'), Buffer.from(ps.result.data, 'base64'));
  await pp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300);
  check('popup: Esc cancels (false)', (await pev(`window.__pp`)) === false);

  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\ndialogs-regression: ${failures} FAILED` : '\ndialogs-regression: all passed');
process.exit(failures ? 1 : 0);
