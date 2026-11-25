// Our own <dialog> question dialogs (lib/dialogs.js) instead of window.prompt / confirm / alert (real Chrome over CDP).
//   node tests/ui/dblclick-fold.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9453;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-dblfold-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-dblfold-shots');
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
  const A = await mkSet('Alpha set', Array.from({ length: 3 }, (_, i) => ({ url: `https://a.example.test/${i}`, title: `Alpha tab ${i}` })));
  await until(() => ev(`__cmr.S.allGroups.length>=1`), 15000);
  const rows = () => ev(`document.querySelectorAll('.item').length`);
  const isOpen = () => ev(`!!document.querySelector('.ghead.open')`);
  // a spot on the header that is not a button / field / link / title
  const spot = () => ev(`(()=>{ const h=document.querySelector('.ghead'); const r=h.getBoundingClientRect(); for (let x=r.left+8; x<r.right-8; x+=6) { const e=document.elementFromPoint(x, r.top+r.height/2); if (e && h.contains(e) && !e.closest('button,input,textarea,a,select,[data-act],.gt')) return {x, y:r.top+r.height/2}; } return null; })()`);
  const dbl = async (p) => { for (const n of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await pg.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: n }); await sleep(500); };
  const o0 = await isOpen();
  const p = await spot();
  check('found an empty header spot', !!p, S(p));
  await dbl(p);
  check('double-click on the header flips the list', (await isOpen()) === !o0, 'was open=' + o0);
  const p2 = await spot();
  await dbl(p2);
  check('double-click again flips it back', (await isOpen()) === o0);
  if (await isOpen()) { await dbl(await spot()); }
  const tr = await rect('.ghead .gt');
  const before = await isOpen();
  await dbl({ x: tr.cx, y: tr.cy });
  check('double-click on the title renames, list unchanged', (await ev("!!document.querySelector('.vrow input, [contenteditable=\"true\"]')")) && (await isOpen()) === before);
  await key('Escape', 27);
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\ndblclick-fold: ${failures} FAILED` : '\ndblclick-fold: all passed');
process.exit(failures ? 1 : 0);
