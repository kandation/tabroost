// Columns of the list page stay on one line whatever a row holds (real Chrome over CDP).
//   node tests/ui/align-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9455;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-align-'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'cmr-align-shots');
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
  const items = (t, n, extra) => Array.from({ length: n }, (_, i) => ({ url: 'https://' + 'abc'[i % 3] + '.example.test/' + t + '/' + i, title: t + ' tab ' + i, ...(extra ? extra(i) : {}) }));
  const mk = async (title, n, extra, more = {}) => { const g = (await msg({ type: 'debug:seedGroup', title, ...more })).gid; await msg({ type: 'debug:seedItems', gid: g, items: items(title || 'x', n, extra) }); await msg({ type: 'debug:seedDone', gid: g }); return g; };
  await mk('', 17, null, { createdAt: Date.now() - 86400000 });
  const b = await mk('Emoji set', 3);
  const c = await mk('Two windows', 6, (i) => ({ w: i < 3 ? 1 : 2, ws: 'normal' }), { windowCount: 2 });
  await msg({ type: 'groupLook', groupId: b, emoji: '🔥', color: 2 });
  await msg({ type: 'groupNote', groupId: c, note: 'note' });
  const measure = () => ev(`(()=>{ const L=(e)=>e&&e.getClientRects().length?Math.round(e.getBoundingClientRect().left*10)/10:null; const R=(e)=>Math.round(e.getBoundingClientRect().right);
    const heads=[...document.querySelectorAll('.ghead:not([hidden])')]; const it=document.querySelector('.item:not([hidden])');
    return { title:heads.map(h=>L(h.querySelector('.gt'))), cnt:heads.map(h=>L(h.querySelector('.c-cnt'))), date:heads.map(h=>L(h.querySelector('.c-date'))),
      item: it?L(it.querySelector('.ilink')):null, cardR: heads.length?R(heads[0]):0, barR: R(document.querySelector('#btnOpenAll')),
      x: it?L(it.querySelector('.x'))+it.querySelector('.x').offsetWidth/2:null, chev: heads.length?L(heads[0].querySelector('.toggle'))+heads[0].querySelector('.toggle').offsetWidth/2:null }; })()`);
  const same = (a) => { const v = a.filter((x) => x !== null); return v.length > 1 && Math.max(...v) - Math.min(...v) <= 1; };
  for (const [lang, density, width] of [['en', 'comfortable', 1400], ['th', 'comfortable', 1400], ['en', 'compact', 1400], ['th', 'comfortable', 1700]]) {
    await ev(`chrome.storage.local.get('settings').then((o)=>chrome.storage.local.set({settings:{...(o.settings||{}),language:${S(lang)},density:${S(density)}}}))`);
    await pg.send('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile: false });
    await pg.send('Page.reload'); await sleep(3000);
    await ev('__cmr.fn.expandAll(false)'); await sleep(700);
    await ev(`document.querySelector('.ghead [data-act=toggle]').click()`); await until(() => ev("!!document.querySelector('.item:not([hidden]) .ilink')"));await sleep(900);
    const m = await measure(); const tag = lang + ' ' + density + ' ' + width + ': ';
    check(tag + 'set titles on one line', same(m.title), S(m.title));
    check(tag + 'tab-count chips on one line', same(m.cnt), S(m.cnt));
    check(tag + 'time chips on one line', same(m.date), S(m.date));
    check(tag + 'toolbar ends where the cards end', Math.abs(m.cardR - m.barR) <= 1, m.cardR + ' vs ' + m.barR);
    if (density === 'comfortable') check(tag + 'tab titles start under the set title', Math.abs(m.item - m.title[0]) <= 1, m.item + ' vs ' + m.title[0]);
    check(tag + 'delete button under the fold arrow', Math.abs(m.x - m.chev) <= 1.5, m.x + ' vs ' + m.chev);
    await shot(lang + '-' + density + '-' + width);
  }
  console.log('shots in ' + SHOTS);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? 'align-regression: ' + failures + ' FAILED' : 'align-regression: all passed');
process.exit(failures ? 1 : 0);
