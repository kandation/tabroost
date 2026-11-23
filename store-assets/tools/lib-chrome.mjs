// Shared helper for the store-asset tools: launches ONE Chrome with the extension (CDP Extensions.loadUnpacked) in a scratch profile,
// and kills the whole tree + deletes the profile at the end. Scratch root: CMR_TEST_ROOT or os.tmpdir().
import {spawn} from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {killChrome} from '../../tests/ui/killtree.mjs';
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const SCRATCH = process.env.CMR_TEST_ROOT || os.tmpdir();
export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise(r => (ws.onopen = r));
  let id = 0; const pend = {}; const handlers = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } else handlers.forEach(h => h(m)); };
  return {send: (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({id: i, method, params})); }), on: h => handlers.push(h), close: () => ws.close()};
}
export async function launch({extDir = REPO, port = 9600 + Math.floor(Math.random() * 300), size = '1400,1000', args = []} = {}) {
  const profile = fs.mkdtempSync(path.join(SCRATCH, 'tabroost-shots-'));
  const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', `--window-size=${size}`, ...args, 'about:blank'], {stdio: 'ignore'});
  const cleanup = () => killChrome(chrome, profile);
  process.on('exit', cleanup);
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(500); } }
  await sleep(800);
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const br = await cdp(ver.webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', {path: extDir.split(path.sep).join('/')});
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const ext = ld.result.id;
  async function open(url, {w = 1280, h = 800} = {}) {
    await br.send('Target.createTarget', {url, newWindow: true, width: w + 40, height: h + 140}); await sleep(2500);
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(x => x.type === 'page' && x.url.startsWith(url.split('#')[0].split('?')[0]));
    const t = list.pop(); const pg = await cdp(t.webSocketDebuggerUrl); await pg.send('Runtime.enable'); await pg.send('Page.enable'); await pg.send('Page.bringToFront');
    const ev = async expr => { const r = await pg.send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true}); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
    const size = (ww, hh) => pg.send('Emulation.setDeviceMetricsOverride', {width: ww, height: hh, deviceScaleFactor: 1, mobile: false});
    const shot = async (file, clip) => { const r = await pg.send('Page.captureScreenshot', {format: 'png', ...(clip ? {clip: {...clip, scale: 1}} : {})}); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
    return {pg, ev, size, shot, id: t.id, sendMsg: m => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`)};
  }
  return {port, ext, br, open, profile, chrome, close: cleanup, closeTab: id => fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {})};
}
