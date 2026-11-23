// Privacy / activity end-to-end test (spec section 12) against a REAL Chrome driven over CDP.
//   node tests/privacy-test.mjs
// Env: CHROME (chrome.exe), CMR_TEST_ROOT (folder for the throw-away profile; default os.tmpdir()), CMR_PORT (default 9456), CMR_TABS (default 60).
// Launches its OWN Chrome with a fresh --user-data-dir (never your real profile), loads this folder unpacked, and kills ONLY the processes that
// carry that profile directory on their command line. The profile is deleted at the end.
//
// What it proves:
//  1. activityTracking OFF + a simulated day of use (about 60 tabs, 5 stashes, 3 restores, sweeps with discards, a duplicate clean, 2 browser restarts,
//     a service-worker kill): every IndexedDB store plus chrome.storage.local / session / sync is dumped and holds NO usage data:
//     activity store empty, no `d` on items or trash items, no `tm` / `rc` on groups, no `f` on snapshot tabs, no fs / actbuf / ramCal keys anywhere.
//  2. precise mode OFF: no exact (x) open-time entries appear when tabs are created (the tabs.onCreated listener is removed after init);
//     the "does a new tab wake an idle worker" probe is reported as information (other, older listeners such as tabs.onUpdated may wake it).
//  3. ON positive control (the test would notice a leak): d / tm / rc / f / activity rows / fs all appear. Precise mode ON gives exact entries.
//  4. Size budget and retention of the activity store with 3 years of synthetic history; the 200-event cap.
//  5. ON -> OFF -> [delete now]: the same empty state as in 1, also when the worker is killed in the middle of the purge (the job resumes).
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { killChrome } from './ui/killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9722);
const NTABS = Number(process.env.CMR_TABS || 60);
const PROFILE = fs.mkdtempSync(path.join(process.env.CMR_TEST_ROOT || os.tmpdir(), 'cmr-priv-'));
// Watchdog: the whole run must finish inside CMR_BUDGET_MS (default 15 min), otherwise kill our Chrome and fail (no silent hangs).
const BUDGET = Number(process.env.CMR_BUDGET_MS || 900000);
let chromeProc = null;
const dog = setTimeout(() => { console.log('FAIL  watchdog: test exceeded ' + BUDGET + ' ms (last step: ' + (globalThis.__step || '?') + ')'); try { killChrome(chromeProc, PROFILE); } catch { /* ignore */ } process.exit(2); }, BUDGET);
dog.unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const info = (s) => console.log('INFO  ' + s);

// ---------- local page server (tabs open real, tiny pages) ----------
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><title>t ${req.url}</title><p>${req.url}`); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOST = `http://127.0.0.1:${server.address().port}`;

// ---------- chrome lifecycle ----------
const profKey = path.basename(PROFILE);
function mine() { try { return Number(execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${profKey}*' } | Measure-Object).Count"`, { encoding: 'utf8' }).trim()); } catch { return -1; } }
function killMine() { try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${profKey}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`); } catch { /* ignore */ } }
async function launch() {
  const c = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', 'about:blank'], { stdio: 'ignore', detached: true });
  c.unref(); chromeProc = c;
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return; } catch { await sleep(500); } }
  throw new Error('chrome did not start');
}
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  ws.onclose = () => { for (const k of Object.keys(pend)) { pend[k]({ error: { message: 'ws closed' }, result: { exceptionDetails: { exception: { description: 'cdp socket closed' } } } }); delete pend[k]; } };
  const send = (method, params = {}, ms = 60000) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => { delete pend[i]; j(new Error('cdp timeout ' + method)); }, ms); pend[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, ws };
}
let br; let EXT; let pg; let ev;
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function boot() {
  await launch();
  await sleep(800);
  br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  EXT = ld.result.id;
  await openDriver();
}
async function openDriver() {
  await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=${Date.now()}`, newWindow: true });
  let t;
  for (let i = 0; i < 40 && !t; i++) { await sleep(300); t = (await J('/json/list')).find((x) => x.type === 'page' && x.url.includes(EXT + '/stash.html')); }
  pg = await cdp(t.webSocketDebuggerUrl);
  await pg.send('Runtime.enable');
  ev = async (expression) => { const r = await pg.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error'); return r.result.result.value; };
  for (let i = 0; i < 40; i++) { try { if ((await msg({ type: 'ping' })).pong) break; } catch { /* waking */ } await sleep(300); }
}
const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
async function closeBrowser(graceful = true) {
  try { if (graceful) await br.send('Browser.close'); } catch { /* ignore */ }
  for (let i = 0; i < 20 && mine() > 0; i++) await sleep(500);
  killMine();
  await sleep(800);
}
async function restartChrome() { await closeBrowser(true); await boot(); }
async function swTargets() { return (await J('/json/list')).filter((t) => t.type === 'service_worker' && t.url.includes(EXT)); }
async function killSW() {
  const ts = (await br.send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'service_worker' && t.url.includes(EXT));
  for (const t of ts) await br.send('Target.closeTarget', { targetId: t.targetId });
  await sleep(700);
  return ts.length;
}
const step = (s) => { globalThis.__step = s; };
const waitFor = async (fn, ms = 20000, step = 250) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } };

// ---------- audit: dump everything that could hold usage data ----------
const AUDIT = `(async()=>{
  const open=()=>new Promise((res,rej)=>{const r=indexedDB.open('cmr');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const db=await open();
  const all=(n)=>new Promise((res)=>{const r=db.transaction(n).objectStore(n).getAll();r.onsuccess=()=>res(r.result)});
  const bad=['fs','actbuf','ramCal'];
  const found=[]; const walk=(o,p,depth)=>{ if(!o||typeof o!=='object'||depth>6) return; for(const k of Object.keys(o)){ if(bad.includes(k)) found.push(p+'.'+k); walk(o[k],p+'.'+k,depth+1);} };
  const out={stores:{},itemsD:0,items:0,trashD:0,trashItems:0,groupsTm:0,groupsRc:0,groups:0,snapF:0,snapTabs:0,snaps:0,act:0,badKeys:found,purgeJob:null};
  for(const n of db.objectStoreNames){ const rows=await all(n); out.stores[n]=rows.length;
    if(n==='items'){out.items=rows.length; for(const r of rows) if(r.d!==undefined) out.itemsD++;}
    if(n==='trash'){ for(const r of rows){ for(const x of (r.items||[])){ out.trashItems++; if(x&&x.d!==undefined) out.trashD++; } if(r.d!==undefined) out.trashD++; } }
    if(n==='groups'){out.groups=rows.length; for(const g of rows){ if(g.tm!==undefined) out.groupsTm++; if(g.rc!==undefined) out.groupsRc++; }}
    if(n==='activity') out.act=rows.length;
    if(n==='meta'){ walk(rows,'meta',0); for(const r of rows){ if(r.purgeJob) out.purgeJob=r.purgeJob; if(r.k==='meta'&&r.v&&r.v.purgeJob) out.purgeJob=r.v.purgeJob; } }
    if(n==='snapshots'){ const {gunzipJson}=await import('./lib/snapfmt.js'); out.snaps=rows.length; for(const r of rows){ if(!r.gz) continue; const b=await gunzipJson(r.gz); for(const t of (b.tabs||[])){ out.snapTabs++; if(t&&t.f!==undefined) out.snapF++; } } }
  }
  db.close();
  for(const area of ['local','session','sync']){ try{ const all=await chrome.storage[area].get(null); walk(all,area,0); out['keys_'+area]=Object.keys(all);}catch(e){ out['keys_'+area]=['ERR '+e.message]; } }
  out.badKeys=found; return out;
})()`;
const audit = () => ev(AUDIT);
function assertEmpty(a, label) {
  check(`${label}: activity store empty`, a.act === 0, `rows=${a.act}`);
  check(`${label}: no item / trash item has d`, a.itemsD === 0 && a.trashD === 0, `items=${a.items} (d ${a.itemsD}) trashItems=${a.trashItems} (d ${a.trashD})`);
  check(`${label}: no group has tm / rc`, a.groupsTm === 0 && a.groupsRc === 0, `groups=${a.groups} (tm ${a.groupsTm}, rc ${a.groupsRc})`);
  check(`${label}: no snapshot tab has f`, a.snapF === 0, `snapshots=${a.snaps} tabs=${a.snapTabs} (f ${a.snapF})`);
  check(`${label}: no fs / actbuf / ramCal key anywhere`, a.badKeys.length === 0, JSON.stringify(a.badKeys));
}

// ---------- scenario helpers ----------
const newWindow = (n, tag) => ev(`chrome.windows.create({url:${JSON.stringify(Array.from({ length: n }, (_, i) => `${HOST}/${tag}/${i}`))}, focused:false}).then(w=>w.id)`);
const groupsList = () => ev(`(async()=>{const db=await import('./lib/db.js'); return (await db.listGroups()).map(g=>({id:g.id,phase:g.phase,count:g.count}))})()`);
async function stashWindows(count, perWin, tag) {
  for (let i = 0; i < count; i++) {
    const before = (await groupsList()).length;
    const wid = await newWindow(perWin, `${tag}${i}`);
    await sleep(1200);
    await msg({ type: 'debug:stashWindow', windowId: wid });
    await waitFor(async () => (await groupsList()).length > before, 20000);
    await sleep(500);
  }
}
async function simulateDay(label) {
  // 1. bulk of open tabs, so the sweep has work
  const wBulk = await newWindow(NTABS, 'bulk' + label);
  await sleep(3000);
  // 2. five stashes
  await stashWindows(5, 4, 'st' + label);
  // 3. three restores
  const gs = (await groupsList()).filter((g) => g.phase === 'committed').slice(0, 3);
  for (const g of gs) { await msg({ type: 'restoreGroup', groupId: g.id, newWindow: true }); await sleep(2500); }
  // 4. sweeps with discards (min 0 = everything idle counts)
  await msg({ type: 'debug:sweep', min: 0 }); await sleep(1500);
  const disc = await ev(`chrome.tabs.query({discarded:true}).then(t=>t.length)`);
  info(`${label}: tabs open ${(await ev(`chrome.tabs.query({}).then(t=>t.length)`))}, discarded ${disc}`);
  // 5. one duplicate clean
  await ev(`Promise.all([chrome.tabs.create({url:${JSON.stringify(HOST + '/dup')},active:false}),chrome.tabs.create({url:${JSON.stringify(HOST + '/dup')},active:false})])`);
  await sleep(1500);
  await msg({ type: 'closeDuplicatesNow' }); await sleep(1500);
  // 6. snapshots
  await msg({ type: 'snapNow' }); await sleep(800);
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(800);
  return wBulk;
}

try {
  info(`profile ${PROFILE}  port ${PORT}  tabs ${NTABS}  host ${HOST}`);
  await boot();
  await msg({ type: 'saveSettings', patch: { activityTracking: false, preciseOpenTime: false, autoSnapshot: true } });
  check('setup: tracking is OFF', (await ev(`chrome.storage.local.get(null)`)) && true);

  // ===== 1. OFF: a simulated day + restarts =====
  await simulateDay('A');
  await restartChrome();
  await msg({ type: 'saveSettings', patch: {} });
  await simulateDay('B');
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(500);
  await killSW();
  await msg({ type: 'ping' });
  await restartChrome();
  await msg({ type: 'snapNow' }); await sleep(800);
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(500);
  const aOff = await audit();
  info(`OFF dump: stores ${JSON.stringify(aOff.stores)}`);
  check('OFF: the simulation really created data (stashes happened)', aOff.items > 0 && aOff.groups >= 5 && aOff.snaps >= 1, `items=${aOff.items} groups=${aOff.groups} snapshots=${aOff.snaps}`);
  assertEmpty(aOff, 'OFF day');

  // ===== 2. precise OFF: tab creation, no exact entries; wake probe =====
  await killSW();
  const swBefore = (await swTargets()).length;
  const probeIds = await ev(`Promise.all(Array.from({length:30},(_, i)=>chrome.tabs.create({url:${JSON.stringify(HOST + '/probe/')}+i,active:false}).then(t=>t.id)))`);
  await sleep(4000);
  const swAfter = (await swTargets()).length;
  info(`wake probe (OFF): worker targets before=${swBefore} after 30 new tabs=${swAfter} (tabs.onUpdated / onRemoved listeners that predate this feature can wake it; the onCreated listener is removed)`);
  await msg({ type: 'ping' });
  const a2 = await audit();
  assertEmpty(a2, 'OFF after 30 idle-worker tab creations');
  await ev(`chrome.tabs.remove(${JSON.stringify(probeIds)})`);

  // ===== 3. ON positive control =====
  await msg({ type: 'saveSettings', patch: { activityTracking: true, preciseOpenTime: false } });
  await sleep(300);
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(800); // observe() fills fs
  const wOn = await newWindow(5, 'on'); await sleep(2500);
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(800);
  await msg({ type: 'debug:stashWindow', windowId: wOn });
  await sleep(2500);
  const gOn = (await groupsList()).filter((g) => g.phase === 'committed');
  await msg({ type: 'restoreGroup', groupId: gOn[gOn.length - 1].id, newWindow: true }); await sleep(2500);
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(800);
  const aOn = await audit();
  check('ON control: activity rows appear', aOn.act > 0, `rows=${aOn.act}`);
  check('ON control: items carry d', aOn.itemsD > 0, `${aOn.itemsD}/${aOn.items}`);
  check('ON control: groups carry tm and rc', aOn.groupsTm > 0 && aOn.groupsRc > 0, `tm ${aOn.groupsTm} rc ${aOn.groupsRc}`);
  check('ON control: snapshot tabs carry f', aOn.snapF > 0, `${aOn.snapF}/${aOn.snapTabs}`);
  check('ON control: fs map exists in session storage', (aOn.keys_session || []).includes('fs'), JSON.stringify(aOn.keys_session));
  check('ON control: nothing leaks into chrome.storage.sync / local', !(aOn.keys_sync || []).some((k) => /^(fs|actbuf|ramCal|activity)/.test(k)) && !(aOn.keys_local || []).some((k) => /^(fs|actbuf|ramCal)$/.test(k)));

  // ===== 4. precise mode ON: exact entries; OFF again: none =====
  await msg({ type: 'saveSettings', patch: { preciseOpenTime: true } });
  const t0 = Date.now();
  const pIds = await ev(`Promise.all(Array.from({length:5},(_, i)=>chrome.tabs.create({url:${JSON.stringify(HOST + '/exact/')}+i,active:false}).then(t=>t.id)))`);
  await sleep(3500);
  const fsOn = await ev(`chrome.storage.session.get('fs').then(r=>r.fs||{})`);
  const ex = pIds.map((i) => fsOn[i]).filter(Boolean);
  check('precise ON: every new tab has an exact (x) entry within 3 s', ex.length === 5 && ex.every((e) => e.x === 1), `${ex.length}/5`);
  check('precise ON: opened minute is the real creation minute', ex.every((e) => Math.abs(e.f - Math.floor(t0 / 60000)) <= 1));
  await msg({ type: 'saveSettings', patch: { preciseOpenTime: false } });
  const qIds = await ev(`Promise.all(Array.from({length:5},(_, i)=>chrome.tabs.create({url:${JSON.stringify(HOST + '/noexact/')}+i,active:false}).then(t=>t.id)))`);
  await sleep(3500);
  const fsOff = await ev(`chrome.storage.session.get('fs').then(r=>r.fs||{})`);
  check('precise OFF (toggled live): new tabs get no entry from tabs.onCreated', qIds.every((i) => !fsOff[i]));
  // after a worker restart with the mode OFF the lazy listener is removed again
  await killSW(); await msg({ type: 'ping' }); await sleep(1200);
  const rIds = await ev(`Promise.all(Array.from({length:5},(_, i)=>chrome.tabs.create({url:${JSON.stringify(HOST + '/noexact2/')}+i,active:false}).then(t=>t.id)))`);
  await sleep(3500);
  const fsOff2 = await ev(`chrome.storage.session.get('fs').then(r=>r.fs||{})`);
  check('precise OFF (after worker restart): still no entry from tabs.onCreated', rIds.every((i) => !fsOff2[i]));
  await ev(`chrome.tabs.remove(${JSON.stringify([...pIds, ...qIds, ...rIds])})`);

  // ===== 5. size budget, retention prune, 200-event cap =====
  await msg({ type: 'debug:actInject', days: 1095, weeks: 157, events: 400 });
  const rowsBytes = async () => ev(`(async()=>{const db=await import('./lib/db.js'); const r=await db.actDumpAll(); return {n:r.length, days:r.filter(x=>x.k[0]==='d').length, weeks:r.filter(x=>x.k[0]==='w').length, ev:r.filter(x=>x.k[0]==='e').length, withH:r.filter(x=>x.k[0]==='d'&&x.h).length, bytes:new Blob([JSON.stringify(r)]).size}})()`);
  const inj = await rowsBytes();
  info(`injected 3 years: ${JSON.stringify(inj)}`);
  await msg({ type: 'saveSettings', patch: { retentionDays: 730 } });
  await msg({ type: 'debug:actPrune' });
  const p730 = await rowsBytes();
  check('retention 730: day rows <= 731 and week rows pruned', p730.days <= 731 && p730.days >= 700 && p730.weeks <= 106, JSON.stringify(p730));
  check('retention 730: whole store under the 1 MB budget (JSON size, an upper bound)', p730.bytes < 1048576, `${p730.bytes} bytes`);
  check('h arrays kept only for the last 90 days', p730.withH <= 92, `rows with h: ${p730.withH}`);
  await msg({ type: 'saveSettings', patch: { retentionDays: 400 } });
  await msg({ type: 'debug:actPrune' });
  const p400 = await rowsBytes();
  check('retention 400: day rows <= 401', p400.days <= 401 && p400.days >= 380, JSON.stringify(p400));
  check('retention 400: store under 300 KB', p400.bytes < 307200, `${p400.bytes} bytes`);
  await msg({ type: 'debug:actBump', kind: 'stash', f: { n: 2 } });
  const capped = await rowsBytes();
  check('event cap: at most 200 events after the next write', capped.ev <= 200 && capped.ev >= 199, `events ${capped.ev} (had ${inj.ev})`);
  await msg({ type: 'saveSettings', patch: { retentionDays: 0 } });
  await msg({ type: 'debug:actPrune' });
  const unl = await rowsBytes();
  check('retention unlimited: nothing pruned', unl.days >= capped.days, `${unl.days} >= ${capped.days}`);
  await msg({ type: 'saveSettings', patch: { retentionDays: 400 } });

  // ===== 6. ON -> OFF -> [delete now], with a worker kill in the middle =====
  // bulk items with d so the purge needs many steps (2000 per transaction)
  const gSeed = (await msg({ type: 'debug:seedGroup', title: 'purge-bulk' })).gid;
  for (let c = 0; c < 20; c++) {
    await msg({ type: 'debug:seedItems', gid: gSeed, items: Array.from({ length: 3000 }, (_, i) => ({ url: `${HOST}/bulk/${c}/${i}`, title: `bulk ${c}-${i}`, d: 32768 * 100 + 50 + (i % 500) })) });
  }
  await msg({ type: 'debug:seedDone', gid: gSeed });
  const mid0 = await audit();
  check('purge setup: data present before OFF', mid0.itemsD >= 60000 && mid0.act > 0 && mid0.groupsTm > 0, `d=${mid0.itemsD} act=${mid0.act} tm=${mid0.groupsTm}`);
  const stats = await msg({ type: 'act:stats' });
  check('act:stats counts days / events / tracked tabs', stats.days > 0 && stats.events > 0, JSON.stringify(stats));
  await msg({ type: 'saveSettings', patch: { activityTracking: false } });
  await msg({ type: 'act:purge' });
  let killed = false; let lastPhase = '';
  for (let i = 0; i < 4000 && !killed; i++) {
    const a = await ev(`(async()=>{const db=await import('./lib/db.js'); const m=await db.getMeta(); return m.purgeJob||null})()`);
    if (a && a.phase === 'items' && a.cursor != null) { await killSW(); killed = true; lastPhase = JSON.stringify(a); }
    else if (!a && i > 20) break;
  }
  check('purge: worker was killed in the middle of the item pass (resume point stored)', killed, lastPhase);
  await msg({ type: 'ping' }).catch(() => {}); // wakes the worker, which resumes the job
  const done = await waitFor(async () => { const j = await ev(`(async()=>{const db=await import('./lib/db.js'); return (await db.getMeta()).purgeJob||null})()`); return j === null; }, 90000, 400);
  check('purge: the interrupted job resumed and finished', done === true);
  await sleep(500);
  const aPurged = await audit();
  assertEmpty(aPurged, 'after ON -> OFF -> delete (resumed)');
  check('purge: only usage data went (items themselves are still there)', aPurged.items >= 60000, `items=${aPurged.items}`);
  check('purge: no purgeJob left behind', aPurged.purgeJob === null);

  // second purge, uninterrupted, starting from fresh data
  await msg({ type: 'saveSettings', patch: { activityTracking: true } });
  await msg({ type: 'debug:actInject', days: 30, weeks: 5, events: 10 });
  await msg({ type: 'debug:snapAuto', force: true }); await sleep(600);
  const w2 = await newWindow(3, 'two'); await sleep(1500); await msg({ type: 'debug:stashWindow', windowId: w2 }); await sleep(2500);
  const m2 = await audit();
  check('second round: data present again', m2.act > 0 && m2.itemsD > 0, `act=${m2.act} d=${m2.itemsD}`);
  await msg({ type: 'saveSettings', patch: { activityTracking: false } });
  await msg({ type: 'act:purge' });
  await waitFor(async () => (await ev(`(async()=>{const db=await import('./lib/db.js'); return (await db.getMeta()).purgeJob||null})()`)) === null && (await audit()).act === 0, 60000, 400);
  assertEmpty(await audit(), 'second purge (uninterrupted)');
  await msg({ type: 'debug:actBump', kind: 'stash', f: { n: 1 } });
  check('OFF after purge: a late write attempt records nothing', (await audit()).act === 0);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
} finally {
  try { server.close(); } catch { /* ignore */ }
  await closeBrowser(false).catch(() => {});
  killMine(); try { killChrome(chromeProc, PROFILE); } catch { /* ignore */ }
  await sleep(1500);
  const left = mine();
  console.log(`chrome processes left for this profile: ${left}`);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failures ? `privacy-test: ${failures} FAILED` : 'privacy-test: ALL PASSED');
  process.exit(failures ? 1 : 0);
}
