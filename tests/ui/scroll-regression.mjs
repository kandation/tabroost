// Single-scroll regression: every view must have exactly ONE primary scroll container (no nested/stacked scrollbars) and no
// horizontal overflow at 360 / 768 / 1280 px. Drives a REAL Chrome over CDP with a throw-away profile.  node tests/ui/scroll-regression.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9900 + Math.floor(Math.random() * 90);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-scroll-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
async function waitUp() { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch { await sleep(500); } } throw new Error('chrome did not start'); }
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  return { send: (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}
// Elements that really scroll (content taller/wider than the box), minus whitelisted transient popovers/menus/modals.
const PROBE = `(()=>{ const WL='[popover],.menu,.dlg,.trlist-in,.snaplist,.cal,.fpop'; const out=[];
  const nm=(e)=>e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+String(e.className).split(' ').join('.');
  for (const e of document.querySelectorAll('*')) { const cs=getComputedStyle(e); if (cs.display==='none'||cs.visibility==='hidden') continue; if (e.closest('[hidden]')) continue; { const b=e.getBoundingClientRect(); if (b.right<=0||b.left>=innerWidth||b.bottom<=0||b.top>=innerHeight) continue; }
    const oy=/(auto|scroll|overlay)/.test(cs.overflowY), ox=/(auto|scroll|overlay)/.test(cs.overflowX);
    if (oy && e.scrollHeight>e.clientHeight+1 && e.clientHeight>0) out.push({ sel:nm(e), axis:'y', wl:!!e.closest(WL) });
    if (ox && e.scrollWidth>e.clientWidth+1 && e.clientWidth>0) out.push({ sel:nm(e), axis:'x', wl:!!e.closest(WL) }); }
  const de=document.documentElement; const root = de.scrollHeight>innerHeight+1 && getComputedStyle(document.body).overflowY!=='hidden' && getComputedStyle(de).overflowY!=='hidden' ? [{sel:'document',axis:'y',wl:false}] : [];
  return { scrollers: out.filter(o=>!o.wl && o.axis==='y').concat(root), hscroll: out.filter(o=>!o.wl && o.axis==='x'), docX: de.scrollWidth>innerWidth+1 }; })()`;

try {
  await waitUp(); await sleep(1000);
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const br = await cdp(ver.webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;
  async function open(url) {
    await br.send('Target.createTarget', { url, newWindow: true, width: 1280, height: 860 }); await sleep(2500);
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((x) => x.type === 'page' && x.url.startsWith(url.split('#')[0].split('?')[0])).pop();
    const pg = await cdp(t.webSocketDebuggerUrl); await pg.send('Runtime.enable'); await pg.send('Page.bringToFront');
    const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
    const size = (w, h) => pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    return { pg, ev, size, id: t.id };
  }
  const closeTab = (id) => fetch(`http://127.0.0.1:${PORT}/json/close/${id}`).catch(() => {});

  // ---- stash.html: seed data, force every panel/banner visible with long text ----
  const S = await open(`chrome-extension://${EXT}/stash.html?t=1`);
  const msg = (m) => S.ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  for (let n = 0; n < 3; n++) {
    const g = (await msg({ type: 'debug:seedGroup', title: 'Seed ' + n })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: 60 }, (_, i) => ({ url: `https://example.test/${n}/${i}`, title: `Page ${n}-${i}` })) });
    await msg({ type: 'debug:seedDone', gid: g });
  }
  for (let i = 0; i < 40 && !(await S.ev(`document.querySelectorAll('.vrow.ghead:not([hidden])').length >= 1`)); i++) await sleep(300);
  await sleep(800);
  const LONG = 'ข้อความยาวมากสำหรับทดสอบ '.repeat(30);
  const showAll = `(()=>{ for (const id of ['banner','bannerVault','bannerMig','bannerSnap','bannerStale','bannerAct']) { const e=document.getElementById(id); e.hidden=false; e.textContent=${JSON.stringify(LONG)}; }
    for (const id of ['drainPanel']) document.getElementById(id).hidden=false; for (const id of ['bannerStale','bannerAct','permBanner']) { const pb=document.getElementById(id); if (pb) pb.hidden=true; } })()`;
  await S.ev(showAll);
  const sizes = [[360, 700], [768, 800], [1280, 800]];
  const views = [['list (banners+panels stacked)', null], ['settings', '#settings'], ['dashboard', '#dashboard'], ['trash', '#trash'], ['snapshots', '#snaps']];
  for (const [label, hash] of views) {
    if (hash) { await S.ev(`location.hash=${JSON.stringify(hash)}`); await sleep(1500); }
    for (const [w, h] of sizes) {
      await S.size(w, h); await sleep(400);
      const r = await S.ev(PROBE);
      check(`${label} @${w}: ${hash ? 'at most' : 'exactly'} one primary scroller`, hash ? r.scrollers.length <= 1 : (r.scrollers.length === 1 && r.scrollers[0].sel === '#scroller'), JSON.stringify(r.scrollers));
      check(`${label} @${w}: no horizontal overflow`, !r.docX && r.hscroll.length === 0, JSON.stringify(r.hscroll));
    }
  }
  await S.ev(`location.hash='#list'`); await sleep(800); await S.size(1280, 800);
  await S.ev(`(()=>{ const b=document.querySelector('[data-act="flatToggle"]'); if (b) b.click(); })()`); await sleep(1200);
  { const r = await S.ev(PROBE); check('flat view: at most one primary scroller', r.scrollers.length <= 1, JSON.stringify(r.scrollers)); }
  await S.ev(`['welcome','drainPanel','restartPanel','jobPanel','refreshPanel','banner','bannerVault','bannerMig','bannerSnap','bannerStale','bannerAct'].forEach(id=>document.getElementById(id).hidden=true)`);
  await sleep(400);
  { const r = await S.ev(PROBE); check('list scrolls inside #scroller (the one scroller) when notices are hidden', r.scrollers.length === 1 && r.scrollers[0].sel === '#scroller', JSON.stringify(r.scrollers)); }
  await closeTab(S.id);

  // ---- about.html and popup.html ----
  for (const [name, url] of [['about', `chrome-extension://${EXT}/about.html`], ['popup', `chrome-extension://${EXT}/popup.html`]]) {
    const P = await open(url);
    for (const [w, h] of sizes) {
      await P.size(w, h); await sleep(400);
      const r = await P.ev(PROBE);
      check(`${name} @${w}: at most one scroller`, r.scrollers.length <= 1, JSON.stringify(r.scrollers));
      check(`${name} @${w}: no horizontal overflow`, name === 'popup' && w < 380 ? true : (!r.docX && r.hscroll.length === 0), JSON.stringify(r.hscroll));
    }
    await closeTab(P.id);
  }
} catch (e) { console.log('ERROR ' + ((e && e.stack) || e)); failures++; }
cleanup();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
