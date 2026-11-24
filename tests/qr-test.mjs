// QR generator test: node tests/qr-test.mjs
// Part 1 (pure node): structural invariants of lib/qr.js (sizes, finder/timing patterns, chosen versions, errors, SVG shape).
// Part 2 (real Chrome over CDP): render codes with qrCanvas and DECODE them. Uses the built-in BarcodeDetector when Chrome has
//   it for qr_code; otherwise falls back to the npm package `jsqr`, a DEV-ONLY tool that lives in a temp directory OUTSIDE the
//   project (installed there on demand, never added to package.json, never shipped).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { killChrome } from './ui/killtree.mjs';
import { qrMatrix, qrSvg } from '../lib/qr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.PORT ? +process.env.PORT : 9370;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Part 1: structure ----------
const FINDER = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
function hasFinder(m, ox, oy) { for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) if (m.get(ox + x, oy + y) !== (FINDER[y][x] === '1')) return false; return true; }
function structural(m) {
  const s = m.size;
  if (s !== m.version * 4 + 17) return 'size/version mismatch';
  if (!hasFinder(m, 0, 0) || !hasFinder(m, s - 7, 0) || !hasFinder(m, 0, s - 7)) return 'finder';
  for (let i = 8; i < s - 8; i++) if (m.get(i, 6) !== (i % 2 === 0) || m.get(6, i) !== (i % 2 === 0)) return 'timing';
  if (!m.get(8, s - 8)) return 'dark module';
  for (let i = 0; i < 8; i++) if (m.get(7, i) || m.get(i, 7) || m.get(s - 8, i) || m.get(s - 1 - i, 7) || m.get(7, s - 1 - i) || m.get(i, s - 8)) return 'separator';
  return '';
}
const url20 = 'https://example.com/ab'; // 21 chars
const cases = [
  ['HELLO', 'M', 1], ['HELLO', 'H', 1],
  [url20, 'M', 2],
  ['https://example.com/' + 'a'.repeat(180), 'M', null],
  ['https://example.com/ค้นหา?q=' + 'ทดสอบ'.repeat(5), 'M', null],
];
for (const [t, e, v] of cases) {
  const m = qrMatrix(t, { ecc: e });
  check(`structure ${JSON.stringify(t.slice(0, 24))} ecc ${e} -> v${m.version} ${m.size}x${m.size}`, structural(m) === '' && (v === null || m.version === v), structural(m));
}
check('sizes 21/25/29', qrMatrix('a').size === 21 && qrMatrix('x'.repeat(15), { ecc: 'M' }).size === 25 && qrMatrix('x'.repeat(30), { ecc: 'M' }).size === 29);
// capacity limits (byte mode): v1 L = 17 bytes, v40 L = 2953, v40 H = 1273
check('v1-L holds 17 bytes, 18 goes to v2', qrMatrix('x'.repeat(17), { ecc: 'L' }).version === 1 && qrMatrix('x'.repeat(18), { ecc: 'L' }).version === 2);
check('v40-L holds 2953 bytes', qrMatrix('x'.repeat(2953), { ecc: 'L' }).version === 40);
check('v40-H holds 1273 bytes', qrMatrix('x'.repeat(1273), { ecc: 'H' }).version === 40);
for (const [n, e] of [[2954, 'L'], [1274, 'H']]) { let err = null; try { qrMatrix('x'.repeat(n), { ecc: e }); } catch (x) { err = x; } check(`too long (${n} bytes, ${e}) throws`, err instanceof Error && /too long/.test(err.message)); }
{ let err = null; try { qrMatrix('a', { ecc: 'Z' }); } catch (x) { err = x; } check('unknown ecc throws', err instanceof Error); }
{ // every version appears at least once and passes the structural checks
  const seen = new Set(); let bad = '';
  for (const e of ['L', 'M', 'Q', 'H']) for (let n = 1; n <= 2953; n += n < 200 ? 3 : 41) { try { const m = qrMatrix('y'.repeat(n), { ecc: e }); seen.add(m.version); bad = bad || structural(m); } catch { break; } }
  check(`all 40 versions reachable and well-formed (${seen.size})`, seen.size === 40 && bad === '', bad);
}
{ const m = qrMatrix('https://example.com/', { ecc: 'M' }); const svg = qrSvg(m, { margin: 4 }); const n = m.size + 8;
  check('svg: viewBox, crispEdges, single path', svg.includes(`viewBox="0 0 ${n} ${n}"`) && svg.includes('shape-rendering="crispEdges"') && (svg.match(/<path /g) || []).length === 1 && !/https?:\/\/(?!www\.w3\.org)/.test(svg)); }

// ---------- Part 2: decode in real Chrome ----------
const longUrl = 'https://example.com/path/to/some/page?utm_source=newsletter&utm_medium=email&utm_campaign=spring_sale_2026&ref=abc123&session=9f8e7d6c5b4a&redirect=https%3A%2F%2Fexample.org%2Fx';
const thai = 'https://example.com/ค้นหา?q=ทดสอบภาษาไทย&name=สวัสดีชาวโลก';
const text300 = Array.from({ length: 300 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789 .,;:!?-'[(i * 7) % 43]).join('');
const decodeSet = [
  ['short URL', 'https://example.com/a', 'M'], ['long URL (~' + longUrl.length + ')', longUrl, 'M'], ['Thai URL', thai, 'M'], ['300 chars', text300, 'M'],
  ['emoji + mixed', 'Tabroost 🙂 ทดสอบ café', 'Q'], ['v33 2000 chars', 'z9'.repeat(1000), 'L'], ['v40 2900 chars', 'q7'.repeat(1450), 'L'], ['v25 H', 'h3'.repeat(300), 'H'],
  ...['L', 'M', 'Q', 'H'].map((e) => [`ecc ${e}`, 'https://example.com/ecc-level-test?x=1&y=ทดสอบ', e]),
];

function loadJsqr() {
  const dir = process.env.JSQR_DIR || path.join(os.tmpdir(), 'qrdev');
  const req = createRequire(path.join(dir, 'x.js'));
  try { return req('jsqr'); } catch { /* install below */ }
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}');
  spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['i', 'jsqr', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' });
  return req('jsqr');
}

const server = http.createServer((q, r) => {
  if (q.url === '/lib/qr.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(fs.readFileSync(path.join(ROOT, 'lib/qr.js'))); } else { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><meta charset=utf-8><body>'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HTTP = server.address().port;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-qr-'));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--window-size=900,700', `http://127.0.0.1:${HTTP}/`], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  let target;
  for (let i = 0; i < 40 && !target; i++) { target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${HTTP}`)); if (!target) await sleep(300); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };

  const hasBD = await ev(`(async()=>{ if(!('BarcodeDetector' in window)) return false; try { return (await BarcodeDetector.getSupportedFormats()).includes('qr_code'); } catch { return false; } })()`);
  console.log(`decoder: ${hasBD ? 'Chrome BarcodeDetector (qr_code)' : 'jsqr (dev-only, installed outside the project)'}`);
  const jsqr = hasBD ? null : loadJsqr();

  // render in the page with the real qrCanvas; return either the BarcodeDetector result or the raw pixels
  const render = (text, ecc) => ev(`(async()=>{
    const { qrMatrix, qrCanvas } = await import('/lib/qr.js');
    const m = qrMatrix(${JSON.stringify(text)}, { ecc: ${JSON.stringify(ecc)} });
    const c = qrCanvas(m, document.createElement('canvas'), { scale: 6, margin: 4 });
    const out = { version: m.version, w: c.width };
    if (${hasBD}) { const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c); out.text = r.length ? r[0].rawValue : null; }
    else { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = ''; for (let i = 0; i < d.length; i += 4096) s += String.fromCharCode(...d.subarray(i, i + 4096)); out.px = btoa(s); }
    return out;
  })()`);
  for (const [label, text, ecc] of decodeSet) {
    let r, got = null, err = '';
    try {
      r = await render(text, ecc);
      if (hasBD) got = r.text;
      else { const buf = Buffer.from(r.px, 'base64'); const res = jsqr(new Uint8ClampedArray(buf), r.w, r.w); got = res ? new TextDecoder().decode(Uint8Array.from(res.binaryData)) : null; }
    } catch (e) { err = e.message; }
    check(`decode ${label} (ecc ${ecc}${r ? ', v' + r.version : ''})`, got === text, err || (got === null ? 'no code found' : 'decoded text differs'));
  }
} catch (e) {
  check('chrome decode run', false, String(e && e.stack || e));
} finally {
  server.close(); cleanup();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
