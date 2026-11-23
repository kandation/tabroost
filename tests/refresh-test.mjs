// "Refresh all tabs in this window" end-to-end against a REAL Chrome over CDP (isolated profile, killtree cleanup, watchdog).
//   node tests/refresh-test.mjs      Env: CHROME, CMR_TEST_ROOT (profiles), CMR_PORT (default 9722), CMR_BUDGET_MS (default 8 min)
// Phase A uses a scratch copy of the extension whose manifest lists <all_urls> as REQUIRED host access (so the page check can run):
//   discarded tabs reload; clean loaded tabs reload; a tab with typed-in form text is skipped and keeps its text; an audible tab is skipped;
//   the active tab is untouched and focus does not move; rediscard puts reloaded tabs back to sleep; a stale meta.refresh does not block.
// Phase B uses the shipped manifest (no host access): loaded tabs are skipped with noAccess = true, discarded tabs still reload.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { killChrome } from './ui/killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9722);
const TMP = process.env.CMR_TEST_ROOT || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; let curProc = null; let curProfile = null;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failures++; };
const info = (s) => console.log('INFO  ' + s);
const dog = setTimeout(() => { console.log('FAIL  watchdog: refresh-test exceeded its budget'); if (curProc) killChrome(curProc, curProfile); process.exit(2); }, Number(process.env.CMR_BUDGET_MS || 480000));
dog.unref();

// ---- local pages: every request is counted per path; /form has an input, /audio plays a tone ----
const hits = new Map();
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0]; hits.set(p, (hits.get(p) || 0) + 1);
  res.setHeader('content-type', 'text/html');
  if (p.startsWith('/form')) res.end('<!doctype html><title>form</title><input id="f" type="text"><p>' + p);
  else if (p.startsWith('/audio')) res.end('<!doctype html><title>audio</title><script>const c=new AudioContext();const o=c.createOscillator();o.connect(c.destination);o.start();c.resume();</script><p>' + p);
  else res.end('<!doctype html><title>t</title><p>' + p);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;
const h = (p) => hits.get(p) || 0;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  ws.onclose = () => { for (const k of Object.keys(pend)) { pend[k]({ result: { exceptionDetails: { exception: { description: 'cdp closed' } } } }); delete pend[k]; } };
  const send = (method, params = {}, ms = 60000) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => { delete pend[i]; j(new Error('cdp timeout ' + method)); }, ms); pend[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, ws };
}

async function withChrome(extPath, label, body) {
  const profile = fs.mkdtempSync(path.join(TMP, 'cmr-refr-')); curProfile = profile;
  const c = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--window-size=1100,800', 'about:blank'], { stdio: 'ignore', detached: true });
  c.unref(); curProc = c;
  try {
    const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
    for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
    const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
    const ld = await br.send('Extensions.loadUnpacked', { path: extPath.replace(/\\/g, '/') });
    if (!ld.result) throw new Error('loadUnpacked failed ' + JSON.stringify(ld));
    const EXT = ld.result.id;
    await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=${Date.now()}`, newWindow: true });
    let t; for (let i = 0; i < 40 && !t; i++) { await sleep(300); t = (await J('/json/list')).find((x) => x.type === 'page' && x.url.includes(EXT + '/stash.html')); }
    const pg = await cdp(t.webSocketDebuggerUrl); await pg.send('Runtime.enable');
    const ev = async (expression) => { const r = await pg.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
    const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
    for (let i = 0; i < 40; i++) { try { if ((await msg({ type: 'ping' })).pong) break; } catch { /* waking */ } await sleep(300); }
    console.log(`--- ${label}`);
    await body({ ev, msg });
  } finally { killChrome(c, profile); curProc = null; await sleep(800); }
}

async function setupWindow(ev, tag, { nOk = 12, nDisc = 4, withAudio = true }) {
  const urls = [`${HOST}/${tag}/active`, ...Array.from({ length: nOk }, (_, i) => `${HOST}/${tag}/ok${i}`), `${HOST}/form/${tag}`, ...(withAudio ? [`${HOST}/audio/${tag}`] : []), ...Array.from({ length: nDisc }, (_, i) => `${HOST}/${tag}/disc${i}`)];
  const w = await ev(`chrome.windows.create({url:${JSON.stringify(urls)},focused:false}).then(w=>({id:w.id}))`);
  await sleep(4000);
  const tabs = await ev(`chrome.tabs.query({windowId:${w.id}}).then(a=>a.map(t=>({id:t.id,url:t.url,active:t.active})))`);
  const byUrl = (u) => tabs.find((t) => t.url === u);
  const disc = tabs.filter((t) => /\/disc\d$/.test(t.url));
  for (const d of disc) await ev(`chrome.tabs.discard(${d.id})`);
  return { wid: w.id, tabs, byUrl, disc, formTab: byUrl(`${HOST}/form/${tag}`), audioTab: withAudio ? byUrl(`${HOST}/audio/${tag}`) : null, activeTab: byUrl(`${HOST}/${tag}/active`) };
}
const waitJob = async (ev, ms = 90000) => { const t0 = Date.now(); for (;;) { const j = await ev(`(async()=>{const db=await import('./lib/db.js');return (await db.getMeta()).refresh||null})()`); if (!j) return true; if (Date.now() - t0 > ms) return false; await sleep(400); } };

try {
  // ---------------- phase A: scratch copy with required <all_urls> ----------------
  const scratch = fs.mkdtempSync(path.join(TMP, 'cmr-refr-ext-'));
  fs.cpSync(ROOT, scratch, { recursive: true, filter: (p) => !/(^|[\\/])(dist|site|store-assets|bench|tests|docs|node_modules|fullpage-screenshot|dev|\.git)([\\/]|$)/.test(path.relative(ROOT, p)) });
  const mf = JSON.parse(fs.readFileSync(path.join(scratch, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>']; delete mf.optional_host_permissions;
  fs.writeFileSync(path.join(scratch, 'manifest.json'), JSON.stringify(mf));
  await withChrome(scratch, 'phase A: host access granted', async ({ ev, msg }) => {
    const S = await setupWindow(ev, 'a', {});
    check('A setup: window has 12 ok + form + audio + 4 discarded + active', S.tabs.length === 19 && S.disc.length === 4, `tabs=${S.tabs.length}`);
    check('A setup: page access is granted in the scratch manifest', (await ev(`chrome.permissions.contains({origins:['<all_urls>']})`)) === true);
    await ev(`chrome.scripting.executeScript({target:{tabId:${S.formTab.id}},func:()=>{const i=document.getElementById('f');i.value='draft text';i.dispatchEvent(new Event('input',{bubbles:true}));}}).then(()=>1)`);
    const aud = await ev(`chrome.tabs.get(${S.audioTab.id}).then(t=>t.audible)`);
    if (!aud) info('audio tab is not reported audible by Chrome in this environment (that check is skipped)');
    const before = new Map(S.tabs.map((t) => [t.url, h(new URL(t.url).pathname)]));
    const activeId0 = await ev(`chrome.tabs.query({windowId:${S.wid},active:true}).then(a=>a[0].id)`);
    const focused0 = await ev(`chrome.windows.getLastFocused().then(w=>w.id)`);
    const r = await msg({ type: 'refreshAll', scope: 'window', windowId: S.wid, rediscard: false });
    check('A: refreshAll accepted and counts every web tab except the active one', r.total === 18 && !r.noAccess, JSON.stringify(r));
    check('A: job finished', await waitJob(ev));
    await sleep(1500);
    const d = (u) => h(new URL(u).pathname) - before.get(u);
    check('A: every discarded tab reloaded once', S.disc.every((t) => d(t.url) === 1), S.disc.map((t) => d(t.url)).join(','));
    const clean = S.tabs.filter((t) => /\/ok\d+$/.test(t.url));
    check('A: clean loaded tabs reloaded', clean.every((t) => d(t.url) >= 1), clean.map((t) => d(t.url)).join(','));
    check('A: the form tab with typed text was skipped and keeps its text', d(S.formTab.url) === 0 && (await ev(`chrome.scripting.executeScript({target:{tabId:${S.formTab.id}},func:()=>document.getElementById('f').value}).then(r=>r[0].result)`)) === 'draft text');
    if (aud) check('A: the audible tab was skipped', d(S.audioTab.url) === 0);
    check('A: the active tab was not touched', d(S.activeTab.url) === 0);
    check('A: the active tab did not change', (await ev(`chrome.tabs.query({windowId:${S.wid},active:true}).then(a=>a[0].id)`)) === activeId0);
    check('A: window focus did not move', (await ev(`chrome.windows.getLastFocused().then(w=>w.id)`)) === focused0);
    // rediscard
    const b2 = new Map(S.tabs.map((t) => [t.url, h(new URL(t.url).pathname)]));
    const r2 = await msg({ type: 'refreshAll', scope: 'window', windowId: S.wid, rediscard: true });
    check('A: second refresh (rediscard) accepted', r2.total === 18, JSON.stringify(r2));
    check('A: second job finished', await waitJob(ev));
    await sleep(1500);
    const nd = await ev(`chrome.tabs.query({windowId:${S.wid},discarded:true}).then(a=>a.length)`);
    check('A: rediscard put the reloaded tabs back to sleep (>= 9 discarded)', nd >= 9, `discarded=${nd}`);
    check('A: form tab is still loaded', await ev(`chrome.tabs.get(${S.formTab.id}).then(t=>!t.discarded)`));
    check('A: the second refresh reloaded the sleeping tabs again', S.disc.every((t) => h(new URL(t.url).pathname) - b2.get(t.url) === 1));
    // stale job
    await msg({ type: 'debug:staleRefresh' });
    const r3 = await msg({ type: 'refreshAll', scope: 'window', windowId: S.wid, rediscard: false });
    check('A: a stale meta.refresh does not block a new refresh', r3.error !== 'busy' && r3.total > 0, JSON.stringify(r3));
    check('A: and the new job finishes', await waitJob(ev));
  });
  fs.rmSync(scratch, { recursive: true, force: true });

  // ---------------- phase B: shipped manifest (optional host access NOT granted) ----------------
  await withChrome(ROOT, 'phase B: shipped manifest, no host access', async ({ ev, msg }) => {
    const S = await setupWindow(ev, 'b', { nOk: 6, nDisc: 3, withAudio: false });
    check('B setup: no host access', (await ev(`chrome.permissions.contains({origins:['<all_urls>']})`)) === false);
    const before = new Map(S.tabs.map((t) => [t.url, h(new URL(t.url).pathname)]));
    const r = await msg({ type: 'refreshAll', scope: 'window', windowId: S.wid, rediscard: false });
    check('B: noAccess is reported with the number of loaded tabs', r.noAccess === true && r.loaded >= 7, JSON.stringify(r));
    check('B: job finished', await waitJob(ev));
    await sleep(1500);
    const d = (u) => h(new URL(u).pathname) - before.get(u);
    check('B: discarded tabs still reload', S.disc.every((t) => d(t.url) === 1), S.disc.map((t) => d(t.url)).join(','));
    check('B: loaded tabs are skipped (not reloaded blindly)', S.tabs.filter((t) => /\/ok\d+$|\/form\//.test(t.url)).every((t) => d(t.url) === 0));
  });
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e)); failures++;
} finally {
  try { server.close(); } catch { /* ignore */ }
  if (curProc) killChrome(curProc, curProfile);
  console.log(failures ? `refresh-test: ${failures} FAILED` : 'refresh-test: ALL PASSED');
  process.exit(failures ? 1 : 0);
}
