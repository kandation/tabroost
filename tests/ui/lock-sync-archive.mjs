// Real-Chrome regression: password lock + sync together, locked stashing, and the encrypted backup / erase / import flow.
//   node tests/ui/lock-sync-archive.mjs        Env: CHROME, CMR_TEST_ROOT, CMR_PORT (default 9731)
// One throw-away Chrome (own profile, killtree cleanup, watchdog). bookmarks / <all_urls> are OPTIONAL in the shipped manifest and
// cannot be granted headlessly, so the extension runs from a scratch copy whose manifest lists them as required.
// Steps: (1) service worker loads without errors; (2) lock ON + sync ON: stash, lock, stash while locked (inbox), unlock, sync resumes,
// nothing lost, no plain text in IndexedDB / storage.local / the sync bookmark folder; (3) lock-screen erase flow: the backup link gives a
// .tabroost file with no plain text, the erase button needs the typed word AND (link pressed OR the tick); (4) after the erase the
// backup imports with the old password and with the recovery key as NEW groups, a wrong secret is refused; (5) a11y of the lock screen.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.CMR_TEST_ROOT || os.tmpdir();
const ROOT = fs.mkdtempSync(path.join(BASE, 'cmr-lsa-ext-'));
fs.cpSync(SRC, ROOT, { recursive: true, filter: (f) => !/[\/](dist|site|store-assets|docs|bench|dev|knowledge|fullpage-screenshot|\.git|node_modules)([\/]|$)/.test(path.relative(SRC, f)) });
{ const mp = path.join(ROOT, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.permissions = [...new Set([...(m.permissions || []), ...(m.optional_permissions || [])])]; m.host_permissions = ['<all_urls>']; delete m.optional_permissions; delete m.optional_host_permissions;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2)); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9731);
const PROFILE = fs.mkdtempSync(path.join(BASE, 'cmr-lsa-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-lsa-dl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failures++; };

// local pages: /t/<name> has <title>name</title>, so the stash stores real, known titles and 127.0.0.1 URLs
const srv = http.createServer((req, res) => { const n = decodeURIComponent(req.url.split('/').pop() || 'x'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>${n}</title><p>${n}</p>`); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const WEB = srv.address().port;
const NEEDLES_A = ['zqalpha1', 'zqalpha2', 'zqalpha3', 'zqalpha4'];   // stashed while unlocked
const NEEDLES_B = ['zqbravo1', 'zqbravo2', 'zqbravo3'];                // stashed while locked (inbox)
const NEEDLES = [...NEEDLES_A, ...NEEDLES_B, `127.0.0.1:${WEB}`];
const PW = 'correct horse 42 battery';
const SYNC_PASS = 'sync passphrase for the lsa test';

const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
const cleanup = () => { killChrome(chrome, PROFILE); try { srv.close(); } catch { /* */ } for (const d of [ROOT, DL]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } };
process.on('exit', cleanup);
const dog = setTimeout(() => { console.log('FAIL  watchdog'); cleanup(); process.exit(2); }, 420000);
dog.unref();
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(u, errors) {
  const ws = new WebSocket(u); let id = 0; const p = {};
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p[m.id]) { p[m.id](m); delete p[m.id]; }
    else if (m.method && m.method.startsWith('Browser.download')) dlEvents.push(m.method + ' ' + JSON.stringify(m.params).slice(0, 500));
    else if (errors && m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => j(new Error('timeout ' + method)), 60000); p[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };
  return { send, ev, ws };
}
const until = async (fn, ms = 20000, step = 250) => { for (let t = 0; t < ms; t += step) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const dlEvents = [];
const hasNeedle = (s) => NEEDLES.filter((n) => s.includes(n));

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  await br.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL.replace(/\\/g, '/'), eventsEnabled: true });
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;

  // ---- 1. service worker loads without errors ----
  const swErrors = [];
  let swT = null;
  for (let i = 0; i < 40 && !swT; i++) { swT = (await J('/json/list')).find((t) => t.type === 'service_worker' && t.url.includes(EXT)); if (!swT) await sleep(250); }
  if (swT) { const sw = await cdp(swT.webSocketDebuggerUrl, swErrors); await sw.send('Runtime.enable'); await sleep(1500); sw.ws.close(); }
  check('1 service worker target exists', !!swT);

  const pageErrors = [];
  let pg;
  const openList = async (hash = '') => {
    if (pg) { try { await br.send('Target.closeTarget', { targetId: pg.targetId }); pg.ws.close(); } catch { /* */ } }
    const { result } = await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html${hash}`, newWindow: true });
    let t; for (let i = 0; i < 30 && !t; i++) { await sleep(200); t = (await J('/json/list')).find((x) => x.id === result.targetId); }
    pg = await cdp(t.webSocketDebuggerUrl, pageErrors);
    pg.targetId = result.targetId;
    await pg.send('Runtime.enable'); await pg.send('Page.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(2500);
    return pg;
  };
  await openList();
  const msg = (m) => pg.ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const ping = await msg({ type: 'ping' });
  check('1 service worker answers (init finished, no parse / import error)', !!ping && ping.pong === true, JSON.stringify(ping));
  check('1 service worker raised no exception while loading', swErrors.length === 0, swErrors.join(' | ').slice(0, 300));
  const st0 = await msg({ type: 'lock.status' });
  check('1 lock is OFF by default', st0.enabled === false && st0.locked === false, JSON.stringify(st0).slice(0, 120));

  const dbJson = (expr) => pg.ev(`(async()=>{ const db = await import('./lib/db.js'); return JSON.stringify(await (${expr})(db)); })()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const groupsNow = () => dbJson('(d)=>d.listGroups().then(g=>g.map(x=>({id:x.id,title:x.title,count:x.count,phase:x.phase,del:!!x.del})))');
  const itemTitles = async () => { const gs = await groupsNow(); const out = []; for (const g of gs) { const it = await dbJson(`(d)=>d.getItemsPage('${g.id}',0,500).then(p=>p.map(x=>({t:x.title,u:x.url})))`); out.push(...it); } return out; };
  const dumpAll = () => pg.ev(`(async()=>{
    const db = await new Promise((r, j) => { const q = indexedDB.open('cmr'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    let out = ''; const names = [...db.objectStoreNames];
    for (const n of names) { const rows = await new Promise((r, j) => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); out += '\\n#' + n + ' ' + rows.length + '\\n'; try { out += JSON.stringify(rows, (k, v) => (v instanceof ArrayBuffer ? 'AB' + v.byteLength : ArrayBuffer.isView(v) ? 'TA' + v.byteLength : v)); } catch (e) { out += 'ERR ' + e; } }
    db.close(); return JSON.stringify({ names, out });
  })()`).then(JSON.parse);
  const storageLocal = () => pg.ev(`chrome.storage.local.get(null).then((o)=>JSON.stringify(o))`);
  const bmDump = () => pg.ev(`chrome.bookmarks.getTree().then((t)=>JSON.stringify(t))`);
  const makeTabs = async (names) => {
    const urls = names.map((n) => `http://127.0.0.1:${WEB}/t/${n}`);
    const w = await pg.ev(`chrome.windows.create({ url: ${JSON.stringify(urls)}, focused: false, width: 800, height: 600 }).then((w)=>w.id)`);
    await until(async () => (await pg.ev(`chrome.tabs.query({ windowId: ${w} }).then((t)=>t.filter((x)=>x.status==='complete'&&x.title).length)`)) === names.length, 20000);
    return w;
  };
  const stashWin = async (names) => { const w = await makeTabs(names); const r = await msg({ type: 'stashNow', scope: 'window', windowId: w }); return { w, r }; };
  const winTabs = (w) => pg.ev(`chrome.tabs.query({ windowId: ${w} }).then((t)=>t.length).catch(()=>0)`);
  const syncSt = () => msg({ type: 'sync/getStatus' });
  const bmCount = async () => { const t = JSON.parse(await bmDump()); let n = 0; const walk = (x) => { if (x.url && x.url.includes('cmr.invalid')) n++; (x.children || []).forEach(walk); }; walk(t[0]); return n; };

  // ---- 2a. lock ON, stash while unlocked ----
  const pre = await msg({ type: 'lock.enable', password: PW, withRecovery: true });
  check('2 lock.enable ok + recovery key', !!pre.recoveryKey && !pre.error, pre.error || '');
  const RECKEY = pre.recoveryKey;
  check('2 migration finished (state on)', !!(await until(async () => { const s = await msg({ type: 'lock.status' }); return s.state === 'on' && !s.job; }, 30000)));
  await openList();
  const a = await stashWin(NEEDLES_A);
  check('2 unlocked stash: 4 tabs saved (titles readable) and closed', !!(await until(async () => (await itemTitles()).filter((i) => NEEDLES_A.includes(i.t)).length === 4, 25000)) && !!(await until(async () => (await winTabs(a.w)) <= 1, 8000)), JSON.stringify(a.r).slice(0, 100));

  // ---- 2b. sync ON with the lock on ----
  const en = await msg({ type: 'sync/enable', passphrase: SYNC_PASS, deviceName: 'lsa', scope: { mode: 'all' }, budgetMB: 4 });
  check('2 sync/enable works with the lock on', en && en.ok === true, JSON.stringify(en).slice(0, 160));
  const bm1 = await until(async () => { const n = await bmCount(); return n > 0 ? n : 0; }, 40000, 500);
  check('2 sync folder holds records after enabling', bm1 > 0, 'records=' + bm1);
  console.log('INFO  sync status: ' + JSON.stringify(await syncSt()).slice(0, 220));
  const bmTxt1 = await bmDump();
  check('2 sync folder has no plain titles / URLs', hasNeedle(bmTxt1).length === 0, hasNeedle(bmTxt1).join(','));

  // ---- 2c. lock, stash while locked ----
  const lk = await msg({ type: 'lock.lockNow' });
  check('2 lock.lockNow ok', !lk.error, JSON.stringify(lk).slice(0, 80));
  check('2 status says locked', !!(await until(async () => (await msg({ type: 'lock.status' })).locked, 8000)));
  const lsync = await syncSt();
  check('2 sync stands still while locked (answers locked)', lsync && lsync.ok === false && lsync.error === 'locked', JSON.stringify(lsync).slice(0, 120));
  await openList(); // the old page reloaded itself into the lock screen; use a fresh one for messages
  const b = await stashWin(NEEDLES_B);
  check('2 locked stash accepted', !b.r.error, JSON.stringify(b.r).slice(0, 120));
  check('2 locked stash: tabs closed after the digest check', !!(await until(async () => (await winTabs(b.w)) <= 1, 15000)), 'tabs left=' + await winTabs(b.w));
  const stL = await msg({ type: 'lock.status' });
  check('2 locked stash waits in the inbox', stL.inboxGroups >= 1, 'inbox=' + stL.inboxGroups);
  let dump = await dumpAll();
  check('2 locked: no plain needle in any IndexedDB store', hasNeedle(dump.out).length === 0, hasNeedle(dump.out).join(','));
  let sl = await storageLocal();
  check('2 locked: no plain needle in storage.local', hasNeedle(sl).length === 0, hasNeedle(sl).join(','));

  // ---- 2d. unlock through the lock screen ----
  check('2 locked page shows the lock screen and no list rows', !!(await until(() => pg.ev(`!!document.getElementById('lockScreen')`), 10000)) && (await pg.ev(`document.querySelectorAll('[data-gid], .grp').length`)) === 0);
  const aud = await pg.ev(`(()=>{ const out={unnamed:[],dup:[]}; const vis=(e)=>{const c=getComputedStyle(e);return c.display!=='none'&&c.visibility!=='hidden'}; const nm=(e)=>!!(e.getAttribute('aria-label')||(e.labels&&e.labels.length)||e.textContent.trim()||e.title||e.placeholder);
    for (const e of document.querySelectorAll('#lockScreen button, #lockScreen input, #lockScreen a[href], #lockScreen select')) { if (!vis(e)||e.closest('[hidden]')) continue; if(!nm(e)) out.unnamed.push(e.tagName+'#'+e.id); }
    const seen=new Map(); for (const e of document.querySelectorAll('[id]')) seen.set(e.id,(seen.get(e.id)||0)+1); for (const [k,n] of seen) if(n>1) out.dup.push(k);
    out.dialog = document.getElementById('lockScreen').getAttribute('role')==='dialog'; out.live = document.querySelectorAll('#lockScreen [aria-live]').length; return out; })()`);
  check('5 lock screen: controls named, no duplicate ids, dialog role, live region', aud.unnamed.length === 0 && aud.dup.length === 0 && aud.dialog && aud.live > 0, JSON.stringify(aud));
  await pg.ev(`(()=>{ const i=document.getElementById('lkPw'); i.value='wrong password here'; i.form.requestSubmit(); })()`);
  await sleep(1500);
  check('2 wrong password refused (screen stays, message shown)', await pg.ev(`!!document.getElementById('lockScreen') && !!document.getElementById('lkMsg').textContent.trim()`));
  await pg.ev(`(()=>{ const i=document.getElementById('lkPw'); i.value=${JSON.stringify(PW)}; i.form.requestSubmit(); })()`);
  check('2 unlock with the password removes the lock screen', !!(await until(() => pg.ev(`!document.getElementById('lockScreen')`), 15000)));
  check('2 inbox drained by the seal job', !!(await until(async () => (await msg({ type: 'lock.status' })).inboxGroups === 0, 40000)));
  const titles = (await itemTitles()).map((i) => i.t);
  check('2 nothing lost: all 7 titles readable after unlock', NEEDLES_A.concat(NEEDLES_B).every((n) => titles.includes(n)), titles.join(','));
  const resumed = await until(async () => { const s = await syncSt(); return s && s.ok && s.status; }, 20000);
  check('2 sync answers again after unlock', !!resumed, JSON.stringify(resumed).slice(0, 160));
  await msg({ type: 'sync/now' });
  const bm2 = await until(async () => { const n = await bmCount(); return n > bm1 ? n : 0; }, 60000, 1000);
  check('2 sync resumed: the locked-stash groups reached the sync folder', bm2 > bm1, `records ${bm1} -> ${bm2}`);
  const s2 = await syncSt();
  console.log('INFO  sync status after unlock: ' + JSON.stringify(s2).slice(0, 300));
  check('2 sync reports no error after unlock', s2 && s2.ok && s2.status && s2.status.state !== 'error' && !s2.status.lastError, JSON.stringify(s2.status && { state: s2.status.state, err: s2.status.lastError }));
  dump = await dumpAll();
  check('2 unlocked: no plain needle in any IndexedDB store', hasNeedle(dump.out).length === 0, hasNeedle(dump.out).join(','));
  sl = await storageLocal();
  check('2 unlocked: no plain needle in storage.local', hasNeedle(sl).length === 0, hasNeedle(sl).join(','));
  const bmTxt2 = await bmDump();
  check('2 sync folder still has no plain titles / URLs', hasNeedle(bmTxt2).length === 0, hasNeedle(bmTxt2).join(','));

  // ---- 3. erase flow from the lock screen ----
  await msg({ type: 'lock.lockNow' }); await sleep(1000);
  await openList();
  await until(() => pg.ev(`!!document.getElementById('lockScreen')`), 10000);
  await pg.ev(`document.querySelector('.lk-links .lk-link').click()`); // "forgot password"
  await sleep(400);
  await pg.ev(`(()=>{ const box=document.querySelector('.lk-erase'); box.hidden=false; })()`);
  const word = await pg.ev(`import('./lib/lockui.js').then((m)=>m.strings().eraseWord)`);
  check('3 erase box present on the lock screen', await pg.ev(`!!document.getElementById('lkWord')`), String(word));
  const goDis = () => pg.ev(`document.getElementById('lkGo').disabled`);
  const tick = (v) => pg.ev(`(()=>{ const s=document.getElementById('lkSkip'); s.checked=${v}; s.dispatchEvent(new Event('change')); })()`);
  check('3 erase button disabled at first', (await goDis()) === true);
  await pg.ev(`(()=>{ const w=document.getElementById('lkWord'); w.value=${JSON.stringify(word)}; w.dispatchEvent(new Event('input')); })()`);
  check('3 typed word alone is not enough', (await goDis()) === true);
  await tick(true);
  check('3 typed word + explicit "no backup" tick enables erase', (await goDis()) === false);
  await tick(false);
  check('3 unticking disables it again', (await goDis()) === true);
  await pg.ev(`document.getElementById('lkMk').click()`);
  check('3 backup link appears while locked', !!(await until(() => pg.ev(`!!document.getElementById('lkDl')`), 20000)));
  check('3 link made but not pressed: still disabled', (await goDis()) === true);
  const blob = await pg.ev(`(async()=>{ const a=document.getElementById('lkDl'); const t=await (await fetch(a.href)).text(); return JSON.stringify({ name:a.download, text:t }); })()`).then(JSON.parse);
  check('3 backup file name ends .tabroost', /\.tabroost$/.test(blob.name), blob.name);
  check('3 backup file has no plain titles / URLs', hasNeedle(blob.text).length === 0 && blob.text.length > 500, `len=${blob.text.length} hits=${hasNeedle(blob.text)}`);
  check('3 every backup line is JSON', blob.text.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  { const r = await pg.ev(`(()=>{ const a=document.getElementById('lkDl'); const b=a.getBoundingClientRect(); return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2}); })()`); const c = JSON.parse(r); for (const type of ['mousePressed','mouseReleased']) await pg.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 }); }
  // Chrome in this automated setup cancels EVERY blob download at the end (a plain a.txt too), so the saved file is not checked on disk:
  // the download must begin with the right suggested name and the byte size of the offered blob; the import below reads the blob text.
  await sleep(1500);
  const began = dlEvents.find((e) => e.startsWith('Browser.downloadWillBegin'));
  const prog = dlEvents.filter((e) => e.startsWith('Browser.downloadProgress')).map((e) => JSON.parse(e.slice(e.indexOf('{')))).find((p) => p.totalBytes);
  check('3 pressing the link starts a download named tabroost-archive-DATE.tabroost with the blob size', !!began && /suggestedFilename":"tabroost-archive-[0-9-]+.tabroost"/.test(began) && prog && prog.totalBytes === Buffer.byteLength(blob.text), dlEvents.length + ' events');
  const FILE = path.join(DL, blob.name); fs.writeFileSync(FILE, blob.text);
  check('3 typed word + pressed save link enables erase', (await goDis()) === false);
  await pg.ev(`document.getElementById('lkGo').click()`);
  check('3 erase done: lock is off', !!(await until(async () => (await msg({ type: 'lock.status' })).enabled === false, 30000)));
  await sleep(1500);
  await openList();
  const gAfter = await groupsNow();
  check('3 after erase the list is empty', gAfter.filter((g) => !g.del).length === 0, JSON.stringify(gAfter).slice(0, 100));
  console.log('INFO  sync after erase: ' + JSON.stringify(await syncSt()).slice(0, 200));

  // ---- 4. import the backup ----
  if (FILE) {
    await openList('#settings');
    check('4 settings card offers the import button (lock off)', !!(await until(() => pg.ev(`!!document.getElementById('lkImportOpen')`), 10000)));
    const doImport = async (kind, secret) => {
      await pg.ev(`document.getElementById('lkImportOpen') && document.getElementById('lkImportOpen').click()`);
      await until(() => pg.ev(`!!document.getElementById('arFile')`), 5000);
      const doc = await pg.send('DOM.getDocument', {});
      const q = await pg.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#arFile' });
      await pg.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [FILE.replace(/\\/g, '/')] });
      await pg.ev(`(()=>{ const k=document.getElementById('arKind'); k.value=${JSON.stringify(kind)}; k.dispatchEvent(new Event('change')); document.getElementById('arSecret').value=${JSON.stringify(secret)}; document.getElementById('arGo').click(); })()`);
      await sleep(500);
      await until(() => pg.ev(`!document.getElementById('arGo').disabled`), 60000, 300);
      await sleep(800);
      return pg.ev(`(document.getElementById('arMsg')||{}).textContent`);
    };
    const live = async () => (await groupsNow()).filter((g) => !g.del);
    const m1 = await doImport('pw', 'not the old password');
    check('4 wrong password refused, nothing added', (await live()).length === 0, String(m1));
    const m2 = await doImport('rec', 'AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA');
    check('4 wrong recovery key refused, nothing added', (await live()).length === 0, String(m2));
    const m3 = await doImport('pw', PW);
    const g3 = await live();
    const t3 = (await itemTitles()).map((i) => i.t);
    check('4 import with the old password: tab sets return as new groups', g3.length >= 2 && NEEDLES_A.concat(NEEDLES_B).every((n) => t3.includes(n)), `groups=${g3.length} msg=${m3}`);
    const m4 = await doImport('rec', RECKEY);
    const g4 = await live();
    check('4 import with the recovery key adds them again as new groups', g4.length === g3.length * 2, `before=${g3.length} after=${g4.length} msg=${m4}`);
    check('4 imported groups are committed with items', g4.every((g) => g.phase === 'committed' && g.count > 0), JSON.stringify(g4.map((g) => [g.phase, g.count])));
  }

  const real = pageErrors.filter((e) => !/ResizeObserver/i.test(e));
  check('list page raised no uncaught exception during the run', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e)); failures++;
} finally {
  cleanup();
  console.log(failures ? `lock-sync-archive: ${failures} FAILED` : 'lock-sync-archive: ALL PASSED');
  process.exit(failures ? 1 : 0);
}
