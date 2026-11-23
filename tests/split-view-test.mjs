// Split view (two tabs side by side) end to end in a REAL Chrome (needs Chrome 155+ for tabs.createSplit; tests that need it are
// reported as SKIP on older builds). Drives a throw-away profile over CDP, loads a COPY of this extension (the copy gets the optional
// host permission in its manifest so the sweep's page probe can run), serves its own local pages, kills Chrome and deletes the profile.
//
//   node tests/split-view-test.mjs          env: CHROME=path  PORT=9901  PROFILE_ROOT=dir for the throw-away profile
//
// What it covers (letters match the feature checklist):
//   a  stash a window with a split pair + plain tabs: items adjacent with equal `sv`, tabs closed; restore recreates the pair
//      (equal splitViewId, both discarded after load) and the order
//   b  the same url in both panes with dedupeOnStash ON: both panes saved (documented exception), ordinary duplicates still collapse
//   c  a pair inside a Chrome tab group (whole-set restore, chunked restore with the pair on a chunk boundary): group + split recreated
//   d  sweep: the partner of the active pane / of an audible pane is NOT discarded; an idle background split is discarded together and
//      stays paired (ids change, splitViewId survives); protectedTabs() reports 'split-partner'
//   e  drain with one pane on an excluded site: the other pane is saved, the excluded pane stays open as a plain tab, nothing is lost
//   f  snapshot with a pair (`sv` in the stored body) and snapshot restore recreates the split
//   g  Chrome < 155 simulation (debug:splitApi off): restore opens two plain tabs, nothing fails, nothing is lost
//   h  pinned pair (includePinned), session grouping across two windows (restore into new windows), restore into a new window whose
//      FIRST item is a pane, "keep entry" restore, the row icon action (restoreSplit) and a single-tab restore of one pane (plain tab)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './ui/killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.PORT || 9901);
const HP = 8791; // local page server
const PROFILE = fs.mkdtempSync(path.join(process.env.PROFILE_ROOT || os.tmpdir(), 'cmr-split-'));
const EXTDIR = fs.mkdtempSync(path.join(process.env.PROFILE_ROOT || os.tmpdir(), 'cmr-splitext-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chrome = null;
let srv = null;
const cleanup = () => { try { srv && srv.close(); } catch { /* ignore */ } killChrome(chrome, PROFILE); try { fs.rmSync(EXTDIR, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
let fails = 0;
let skips = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); if (!ok) fails++; };
const info = (k, v) => console.log('      ' + k.padEnd(34) + (typeof v === 'string' ? v : JSON.stringify(v)));

// ---------- the extension copy (host permission granted in the manifest so the sweep probe may run) ----------
fs.cpSync(ROOT, EXTDIR, { recursive: true, filter: (s) => !/[\\/](tests|docs|dist|store-assets|site|bench|tools|fullpage-screenshot|dev|\.git|graphify-out|node_modules)([\\/]|$)/.test(path.relative(ROOT, s)) });
{
  const mp = path.join(EXTDIR, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.host_permissions = ['<all_urls>'];
  delete m.optional_host_permissions;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
}

// ---------- local pages ----------
function wav(sec) {
  const rate = 8000; const n = Math.floor(rate * sec); const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return b;
}
const TONE = wav(1);
srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/tone.wav') { res.setHeader('content-type', 'audio/wav'); return res.end(TONE); }
  const name = u.searchParams.get('i') || 'x';
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>${name.replace(/[<>&]/g, '')}</title><p>${name.replace(/[<>&]/g, '')}</p>${u.searchParams.get('a') ? '<audio src="/tone.wav" autoplay loop></audio>' : ''}`);
}).listen(HP, '127.0.0.1');
const URLX = (n, host = '127.0.0.1', extra = '') => `http://${host}:${HP}/p?i=${n}${extra}`;

// ---------- CDP ----------
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)).slice(0, 500)); return r.result.result.value; };
  return { send, ev, close: () => ws.close() };
}
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
const jx = JSON.stringify;

try {
  chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await J('/json/version'); } catch { await sleep(500); } }
  if (!ver) throw new Error('chrome did not start');
  info('chrome', ver.Browser);
  const br = await cdp(ver.webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: EXTDIR.replace(/\\/g, '/') });
  if (!ld.result || !ld.result.id) throw new Error('loadUnpacked failed ' + jx(ld));
  const EXT = ld.result.id;
  await sleep(1500);
  await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=1`, newWindow: true, width: 1100, height: 800 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes(EXT + '/stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  const ev = pg.ev;
  const msg = (o) => ev(`chrome.runtime.sendMessage(${jx(o)})`);
  const meta = async () => (await msg({ type: 'debug:meta' })).meta;
  const until = async (fn, ms = 60000, step = 250) => { const t0 = Date.now(); for (;;) { if (await fn()) return Date.now() - t0; if (Date.now() - t0 > ms) return -1; await sleep(step); } };
  const waitDrain = () => until(async () => !(await meta()).drain);
  const waitJob = () => until(async () => !(await meta()).job);
  const driverWin = await ev('chrome.windows.getCurrent().then(w=>w.id)');

  if (!(await ev("typeof chrome.tabs.createSplit === 'function'"))) {
    console.log('SKIP  this Chrome has no tabs.createSplit (< 155): split view tests need a newer build');
    skips++;
    throw new Error('__skip__');
  }

  // ---- helpers evaluated inside the extension page ----
  const mkWin = (urls, left = 30, opts = {}) => ev(`(async()=>{ const urls=${jx(urls)}; const w=await chrome.windows.create({url:urls[0],left:${left},top:30,width:760,height:520,focused:false}); const ids=[w.tabs[0].id];
    for (let i=1;i<urls.length;i++) ids.push((await chrome.tabs.create({windowId:w.id,url:urls[i],active:false})).id);
    return {wid:w.id,ids} })()`);
  const split = (a, b) => ev(`chrome.tabs.createSplit([${a},${b}])`);
  const tabsOf = (wid) => ev(`chrome.tabs.query(${wid == null ? '{}' : jx({ windowId: wid })}).then(ts=>ts.filter(t=>/^http:\\/\\/(127\\.0\\.0\\.1|localhost):${HP}\\//.test(t.url||t.pendingUrl||'')).sort((a,b)=>a.windowId-b.windowId||a.index-b.index).map(t=>({id:t.id,w:t.windowId,i:t.index,u:(t.url||t.pendingUrl).replace(/^http:\\/\\/[^/]+\\/p\\?i=/,''),d:t.discarded,sv:t.splitViewId,g:t.groupId,p:t.pinned,a:t.active,au:t.audible})))`);
  const closeAllLocal = () => ev(`chrome.tabs.query({}).then(ts=>chrome.tabs.remove(ts.filter(t=>/^http:\\/\\/(127\\.0\\.0\\.1|localhost):${HP}\\//.test(t.url||t.pendingUrl||'')).map(t=>t.id)).catch(()=>0))`);
  const closeExtraWindows = () => ev(`chrome.windows.getAll({windowTypes:['normal']}).then(ws=>Promise.all(ws.filter(w=>w.id!==${driverWin}).map(w=>chrome.windows.remove(w.id).catch(()=>0))))`);
  const dbGroups = () => ev(`import('./lib/db.js').then(async d=>{const gs=await d.listGroups(); const out=[]; for(const g of gs){ const items=await d.getItemsPage(g.id,0,500); out.push({id:g.id,phase:g.phase,count:g.count,wc:g.windowCount,tabGroups:g.tabGroups||null,items:items.map(i=>({s:i.seq,u:i.url.replace(/^http:\\/\\/[^/]+\\/p\\?i=/,''),tg:i.tg,sv:i.sv,w:i.w})) }) } return out})`);
  const purgeAll = () => ev(`import('./lib/db.js').then(async d=>{for (const g of await d.listGroups()) await chrome.runtime.sendMessage({type:'purgeGroup',groupId:g.id}); for (const g of (await d.listTrash()).groups) await chrome.runtime.sendMessage({type:'purgeGroup',groupId:g.id}); return 'ok'})`);
  const reset = async () => { await closeAllLocal(); await closeExtraWindows(); await purgeAll(); await sleep(400); };
  const paired = (a, b) => a && b && a.sv >= 0 && a.sv === b.sv;
  const key = (t) => t.u;
  const runRestore = async (m) => {
    const first = await msg(m);
    let splits = first.splits || 0; let splitFailed = first.splitFailed || 0; let restored = first.restored || 0; let failed = first.failed || 0;
    for (let i = 0; i < 30; i++) {
      const j = (await meta()).job;
      if (!j) break;
      const r = await msg({ type: 'restoreContinue' });
      splits += r.splits || 0; splitFailed += r.splitFailed || 0; restored += r.restored || 0; failed += r.failed || 0;
      await sleep(300);
    }
    await waitJob();
    await sleep(2500); // let the discards of the opened tabs finish
    return { splits, splitFailed, restored, failed, first };
  };

  await msg({ type: 'debug:memStub', ratio: 0.5 });
  await msg({ type: 'saveSettings', patch: { autoSuspend: true, whitelist: [], dedupeOnStash: false, includePinned: false, restoreChunk: 100, stashGrouping: 'window', closeOwnPages: false } });
  await purgeAll();

  // =========================================================================================================== a
  console.log('\n--- a. stash + restore of a split pair among plain tabs');
  {
    const { wid, ids } = await mkWin([URLX('a1'), URLX('a2'), URLX('a3'), URLX('a4')]);
    await sleep(2500);
    const sid = await split(ids[1], ids[2]);
    info('split view id (session only)', sid);
    const before = await tabsOf(wid);
    check('a: panes share a splitViewId >= 0, others -1', paired(before[1], before[2]) && before[0].sv === -1 && before[3].sv === -1, before.map((t) => t.sv));
    const r = await msg({ type: 'debug:stashWindow', windowId: wid });
    check('a: stash result', r.stashed === 4, r);
    check('a: drain finished', (await waitDrain()) >= 0);
    await sleep(500);
    const gs = await dbGroups();
    const it = gs[0] ? gs[0].items : [];
    info('items', it.map((i) => `${i.u}:${i.sv ?? '-'}`).join(' '));
    check('a: 1 group with 4 items in tab order', gs.length === 1 && it.map(key).join() === 'a1,a2,a3,a4', it);
    check('a: panes adjacent with the same small sv, others without', it[1].sv >= 0 && it[1].sv < 65536 && it[1].sv === it[2].sv && it[0].sv === undefined && it[3].sv === undefined, it);
    check('a: raw splitViewId is not persisted (sv is a small pair index)', it[1].sv < 100 && it[1].sv !== sid, { sv: it[1].sv, sid });
    check('a: all tabs of the window closed', (await tabsOf()).length === 0, await tabsOf());
    const rr = await runRestore({ type: 'restoreGroup', groupId: gs[0].id });
    const st = await tabsOf();
    info('restored', st.map((t) => `${t.u}${t.d ? 'd' : ''}:${t.sv}`).join(' '));
    check('a: 4 tabs back in order', st.map(key).join() === 'a1,a2,a3,a4', st);
    check('a: pair recreated (equal splitViewId >= 0)', paired(st[1], st[2]) && st[0].sv === -1 && st[3].sv === -1, st.map((t) => t.sv));
    check('a: panes discarded after load, pairing intact', st[1].d && st[2].d, st.map((t) => t.d));
    check('a: restore reported 1 split, 0 failures', rr.splits === 1 && rr.splitFailed === 0 && rr.failed === 0, rr);
    check('a: entries removed after restore', (await dbGroups()).length === 0);
    await reset();
  }

  // =========================================================================================================== b
  console.log('\n--- b. same url in both panes + dedupeOnStash ON');
  {
    await msg({ type: 'saveSettings', patch: { dedupeOnStash: true } });
    const { wid, ids } = await mkWin([URLX('same'), URLX('same'), URLX('z'), URLX('z'), URLX('b5')]);
    await sleep(2500);
    await split(ids[0], ids[1]);
    const r = await msg({ type: 'debug:stashWindow', windowId: wid });
    await waitDrain();
    await sleep(400);
    const it = ((await dbGroups())[0] || { items: [] }).items;
    info('items', it.map((i) => `${i.u}:${i.sv ?? '-'}`).join(' '));
    check('b: both identical panes saved, the plain duplicate pair still collapsed (4 items from 5 tabs)', it.map(key).join() === 'same,same,z,b5' && r.tabs === 5, { it, r });
    check('b: the two same-url items carry the pair index', it[0].sv >= 0 && it[0].sv === it[1].sv && it[2].sv === undefined, it);
    const rr = await runRestore({ type: 'restoreGroup', groupId: (await dbGroups())[0].id });
    const st = await tabsOf();
    check('b: restored 4 tabs with the pair split', st.length === 4 && paired(st[0], st[1]) && rr.splits === 1, st.map((t) => `${t.u}:${t.sv}`));
    await msg({ type: 'saveSettings', patch: { dedupeOnStash: false } });
    await reset();
  }

  // =========================================================================================================== c
  console.log('\n--- c. pair inside a Chrome tab group (whole set + chunked with the pair on a chunk boundary)');
  for (const chunk of [100, 3]) {
    await msg({ type: 'saveSettings', patch: { restoreChunk: chunk } });
    const tag = chunk === 100 ? 'c' : 'k';
    const { wid, ids } = await mkWin([URLX(tag + '1'), URLX(tag + '2'), URLX(tag + 'A'), URLX(tag + 'B'), URLX(tag + 'C'), URLX(tag + '9')]);
    await sleep(2500);
    const grp = await ev(`(async()=>{ const g=await chrome.tabs.group({tabIds:[${ids[2]},${ids[3]},${ids[4]}],createProperties:{windowId:${wid}}}); await chrome.tabGroups.update(g,{title:'Grp',color:'blue'}); return g })()`);
    await split(ids[2], ids[3]);
    const before = await tabsOf(wid);
    check(`c(${chunk}): grouped pane pair is split inside the group`, paired(before[2], before[3]) && before[2].g === grp && before[3].g === grp, before.map((t) => `${t.u}:${t.sv}:${t.g}`));
    await msg({ type: 'debug:stashWindow', windowId: wid });
    await waitDrain();
    await sleep(400);
    const g = (await dbGroups())[0];
    info('items', g.items.map((i) => `${i.u}:tg${i.tg ?? '-'}:sv${i.sv ?? '-'}`).join(' '));
    check(`c(${chunk}): sv + tg saved on the pair`, g.items[2].sv >= 0 && g.items[2].sv === g.items[3].sv && g.items[2].tg === 0 && g.items[3].tg === 0 && g.items[4].tg === 0 && g.items[4].sv === undefined, g.items);
    const rr = await runRestore({ type: 'restoreGroup', groupId: g.id });
    const st = await tabsOf();
    info('restored', st.map((t) => `${t.u}${t.d ? 'd' : ''}:sv${t.sv}:g${t.g}`).join(' '));
    check(`c(${chunk}): 6 tabs in order`, st.map(key).join() === `${tag}1,${tag}2,${tag}A,${tag}B,${tag}C,${tag}9`, st.map(key));
    const gids = new Set(st.filter((t) => t.g >= 0).map((t) => t.g));
    const gobj = gids.size === 1 ? await ev(`chrome.tabGroups.get(${[...gids][0]}).then(g=>[g.title,g.color])`) : null;
    check(`c(${chunk}): one Chrome tab group 'Grp' (blue) with A,B,C`, gids.size === 1 && st.filter((t) => t.g >= 0).map(key).join() === `${tag}A,${tag}B,${tag}C` && gobj && gobj[0] === 'Grp' && gobj[1] === 'blue', { gids: [...gids], gobj });
    check(`c(${chunk}): the pair is split again (equal splitViewId)`, paired(st[2], st[3]) && st[4].sv === -1, st.map((t) => t.sv));
    check(`c(${chunk}): exactly one pair created, no failure`, rr.splits === 1 && rr.splitFailed === 0 && rr.failed === 0, rr);
    await reset();
  }
  await msg({ type: 'saveSettings', patch: { restoreChunk: 100 } });

  // =========================================================================================================== d
  console.log('\n--- d. sweep: partner of an active / audible pane is shielded, an idle background split goes to sleep together');
  {
    const { wid, ids } = await mkWin([URLX('d0'), URLX('dA'), URLX('dB'), URLX('dI1'), URLX('dI2'), URLX('dN')]);
    await sleep(3000);
    await split(ids[1], ids[2]); // dA + dB
    await split(ids[3], ids[4]); // dI1 + dI2 (idle background split)
    await ev(`chrome.tabs.update(${ids[1]},{active:true})`); // dA is the window's active tab
    await sleep(500);
    const before = await tabsOf(wid);
    check('d: setup (A active, A/B paired, I1/I2 paired)', before[1].a && paired(before[1], before[2]) && paired(before[3], before[4]), before.map((t) => `${t.u}:${t.a ? 'A' : ''}:${t.sv}`));
    const idsBefore = Object.fromEntries(before.map((t) => [t.u, t.id]));
    const prot = await msg({ type: 'protectedTabs' });
    info('protectedTabs', (prot.tabs || []).map((t) => `${t.title}:${t.kind}`).join(' '));
    check("d: popup list names the partner of the active pane 'split-partner'", (prot.tabs || []).some((t) => t.title === 'dB' && t.kind === 'split-partner'), prot);
    await msg({ type: 'debug:sweep', min: 0 });
    await sleep(2500);
    info('sweep status', await ev(`chrome.storage.session.get(['sweepStat','tabProtect']).then(JSON.stringify)`));
    const after = await tabsOf(wid);
    const by = Object.fromEntries(after.map((t) => [t.u, t]));
    info('after sweep', after.map((t) => `${t.u}${t.d ? 'd' : ''}:${t.sv}`).join(' '));
    check('d: the active pane and ITS PARTNER are not discarded', !by.dA.d && !by.dB.d, { dA: by.dA && by.dA.d, dB: by.dB && by.dB.d });
    check('d: they are still paired', paired(by.dA, by.dB), [by.dA.sv, by.dB.sv]);
    check('d: the idle background split was discarded TOGETHER', by.dI1.d && by.dI2.d, [by.dI1.d, by.dI2.d]);
    check('d: ... and is still paired afterwards', paired(by.dI1, by.dI2), [by.dI1.sv, by.dI2.sv]);
    check('d: tab ids were replaced by the discard (re-read ids)', by.dI1.id !== idsBefore.dI1 || by.dI2.id !== idsBefore.dI2, { before: [idsBefore.dI1, idsBefore.dI2], after: [by.dI1.id, by.dI2.id] });
    check('d: a plain idle tab is discarded as before', by.dN.d && by.d0.d, [by.dN.d, by.d0.d]);
    await reset();

    // audible pane: its partner must stay awake although it is idle and in the background
    const w2 = await mkWin([URLX('eAud', '127.0.0.1', '&a=1'), URLX('eMate'), URLX('e0'), URLX('eX')], 60); // (the audio page is the window's first, visible tab: background tabs may not autoplay)
    await sleep(3500);
    await split(w2.ids[0], w2.ids[1]);
    await ev(`chrome.tabs.update(${w2.ids[3]},{active:true})`); // an unrelated tab is the active one
    const ok = await until(async () => (await tabsOf(w2.wid)).some((t) => t.u.startsWith('eAud') && t.au), 15000);
    const b2 = await tabsOf(w2.wid);
    info('audible state', b2.map((t) => `${t.u}:au${t.au ? 1 : 0}:sv${t.sv}`).join(' '));
    if (ok < 0) { console.log('SKIP  d(audible): the audio pane never became audible in this Chrome'); skips++; } else {
      const prot2 = await msg({ type: 'protectedTabs' });
      check("d: protectedTabs: partner of an audible pane = 'split-partner'", (prot2.tabs || []).some((t) => t.title === 'eMate' && t.kind === 'split-partner'), prot2.tabs);
      await msg({ type: 'debug:sweep', min: 0 });
      await sleep(2500);
      const a2 = Object.fromEntries((await tabsOf(w2.wid)).map((t) => [t.u.split('&')[0], t]));
      check('d: the audible pane and its idle partner both stay awake', !a2.eAud.d && !a2.eMate.d && paired(a2.eAud, a2.eMate), { eAud: a2.eAud.d, eMate: a2.eMate.d });
      check('d: other idle tabs of that window were discarded', a2.e0.d, a2.e0.d);
    }
    await reset();

    // protected (whitelisted) partner shields the pair
    await msg({ type: 'saveSettings', patch: { whitelist: ['localhost'] } });
    const w3 = await mkWin([URLX('w0'), URLX('wP', '127.0.0.1'), URLX('wQ', 'localhost'), URLX('wX')], 90);
    await sleep(3000);
    await split(w3.ids[1], w3.ids[2]);
    await ev(`chrome.tabs.update(${w3.ids[3]},{active:true})`);
    await msg({ type: 'debug:sweep', min: 0 });
    await sleep(2500);
    const a3 = Object.fromEntries((await tabsOf(w3.wid)).map((t) => [t.u, t]));
    check('d: a whitelisted pane keeps its partner awake (both stay loaded, still paired)', !a3.wP.d && !a3.wQ.d && paired(a3.wP, a3.wQ), { wP: a3.wP.d, wQ: a3.wQ.d });
    await msg({ type: 'saveSettings', patch: { whitelist: [] } });
    await reset();
  }

  // =========================================================================================================== e
  console.log('\n--- e. drain with one pane on an excluded site');
  {
    await msg({ type: 'saveSettings', patch: { excludeSites: ['localhost'] } });
    const { wid, ids } = await mkWin([URLX('e1'), URLX('ePane1', '127.0.0.1'), URLX('ePane2', 'localhost'), URLX('e4')]);
    await sleep(2500);
    await split(ids[1], ids[2]);
    const r = await msg({ type: 'debug:stashWindow', windowId: wid });
    await waitDrain();
    await sleep(600);
    const it = ((await dbGroups())[0] || { items: [] }).items;
    info('items', it.map((i) => `${i.u}:${i.sv ?? '-'}`).join(' '));
    check('e: the excluded pane is NOT saved, the other three are', r.stashed === 3 && it.map(key).join() === 'e1,ePane1,e4', { r, it });
    check('e: the saved pane has no sv (its partner was not saved)', it.every((i) => i.sv === undefined), it);
    const left = await tabsOf();
    info('left open', left.map((t) => `${t.u}:${t.sv}`).join(' '));
    check('e: the excluded pane is still open as a plain tab, nothing else of the window is left', left.length === 1 && left[0].u === 'ePane2' && left[0].sv === -1, left);
    await msg({ type: 'saveSettings', patch: { excludeSites: [] } });
    await reset();
  }

  // =========================================================================================================== f
  console.log('\n--- f. snapshot with a pair + snapshot restore');
  {
    const { wid, ids } = await mkWin([URLX('f1'), URLX('fA'), URLX('fB'), URLX('f4')]);
    await sleep(2500);
    await split(ids[1], ids[2]);
    const sn = await msg({ type: 'debug:snapAuto', force: true });
    info('snapshot result', sn);
    const body = await ev(`import('./lib/db.js').then(async d=>{ const f=await import('./lib/snapfmt.js'); const list=await d.snapList(); list.sort((a,b)=>b.ts-a.ts); const rec=await d.snapGet(list[0].id); const b=await f.gunzipJson(rec.gz); return {tabs:b.tabs.filter(t=>/:${HP}/.test(t.url)).map(t=>({u:t.url.replace(/^http:\\/\\/[^/]+\\/p\\?i=/,''),w:t.w,i:t.i,sv:t.sv,keys:Object.keys(t).join('')})), groups:b.groups, windows:b.windows, size:rec.gz.byteLength||rec.gz.length}})`);
    info('snapshot tabs', body.tabs.map((t) => `${t.u}:${t.sv ?? '-'}`).join(' '));
    check('f: snapshot rows carry sv on the pair only', body.tabs.length === 4 && body.tabs[1].sv >= 0 && body.tabs[1].sv === body.tabs[2].sv && body.tabs[0].sv === undefined && body.tabs[3].sv === undefined, body.tabs);
    await closeAllLocal(); await closeExtraWindows();
    await sleep(500);
    const items = await ev(`import('./lib/db.js').then(async d=>{ const f=await import('./lib/snapfmt.js'); const list=await d.snapList(); list.sort((a,b)=>b.ts-a.ts); const b=await f.gunzipJson((await d.snapGet(list[0].id)).gz); return b.tabs.filter(t=>/:${HP}/.test(t.url)) })`);
    const r = await msg({ type: 'snapRestore', items, groups: [], windows: 1, title: 'split test' });
    info('snapRestore', r);
    await waitJob();
    await sleep(3000);
    const st = await tabsOf();
    info('restored', st.map((t) => `${t.u}${t.d ? 'd' : ''}:${t.sv}`).join(' '));
    check('f: snapshot restore recreated the pair (equal splitViewId)', st.length === 4 && paired(st.find((t) => t.u === 'fA'), st.find((t) => t.u === 'fB')), st);
    check('f: plain tabs of the snapshot stayed plain', st.find((t) => t.u === 'f1').sv === -1 && st.find((t) => t.u === 'f4').sv === -1);
    await reset();
  }

  // =========================================================================================================== g
  console.log('\n--- g. Chrome < 155 simulation (createSplit unavailable)');
  {
    const { wid, ids } = await mkWin([URLX('g1'), URLX('gA'), URLX('gB'), URLX('g4')]);
    await sleep(2500);
    await split(ids[1], ids[2]);
    await msg({ type: 'debug:stashWindow', windowId: wid });
    await waitDrain();
    await sleep(400);
    const g = (await dbGroups())[0];
    check('g: (stash side is unaffected) pair saved with sv', g.items[1].sv >= 0 && g.items[1].sv === g.items[2].sv, g.items);
    const off = await msg({ type: 'debug:splitApi', off: true });
    check('g: API switched off', off.has === false, off);
    const rr = await runRestore({ type: 'restoreGroup', groupId: g.id });
    const st = await tabsOf();
    info('restored', st.map((t) => `${t.u}${t.d ? 'd' : ''}:${t.sv}`).join(' '));
    check('g: 4 plain tabs restored, nothing lost, nothing failed', st.length === 4 && rr.failed === 0 && rr.restored === 4 && st.every((t) => t.sv === -1), { rr, sv: st.map((t) => t.sv) });
    check('g: the pair is reported as not split (splitFailed), the restore itself is fine', rr.splits === 0 && rr.splitFailed === 1, rr);
    check('g: panes still discarded after load (normal policy)', st[1].d && st[2].d, st.map((t) => t.d));
    check('g: group entries removed as usual', (await dbGroups()).length === 0);
    await msg({ type: 'debug:splitApi', off: false });
    await reset();
  }

  // =========================================================================================================== h
  console.log('\n--- h. pinned pair, session grouping over 2 windows, new window starting with a pane, keep entry, row action, single tab');
  {
    // pinned pair
    await msg({ type: 'saveSettings', patch: { includePinned: true } });
    const wp = await mkWin([URLX('pA'), URLX('pB'), URLX('p3')], 30);
    await sleep(2500);
    await ev(`chrome.tabs.update(${wp.ids[0]},{pinned:true}).then(()=>chrome.tabs.update(${wp.ids[1]},{pinned:true}))`);
    let sidP = null;
    try { sidP = await split(wp.ids[0], wp.ids[1]); } catch (e) { info('pinned createSplit', String(e.message || e)); }
    const bp = await tabsOf(wp.wid);
    info('pinned before', bp.map((t) => `${t.u}:p${t.p ? 1 : 0}:sv${t.sv}`).join(' '));
    if (sidP == null) { console.log('SKIP  h(pinned): Chrome refused to split pinned tabs'); skips++; } else {
      await msg({ type: 'debug:stashWindow', windowId: wp.wid });
      await waitDrain();
      await sleep(400);
      const gp = (await dbGroups())[0];
      check('h: pinned pair saved with sv (includePinned)', gp && gp.items[0].sv >= 0 && gp.items[0].sv === gp.items[1].sv, gp && gp.items);
      await runRestore({ type: 'restoreGroup', groupId: gp.id });
      const sp = await tabsOf();
      check('h: pinned pair comes back as a split pair (restored unpinned: pinned state is not stored)', paired(sp[0], sp[1]) && sp[0].p === sp[1].p, sp.map((t) => `${t.u}:${t.sv}:${t.p}`));
    }
    await msg({ type: 'saveSettings', patch: { includePinned: false } });
    await reset();

    // session grouping over two windows
    await msg({ type: 'saveSettings', patch: { stashGrouping: 'session', dedupeOnStash: true } });
    const wa = await mkWin([URLX('s1'), URLX('sA'), URLX('sB')], 30);
    const wb = await mkWin([URLX('sA'), URLX('sB'), URLX('s9')], 120); // same urls in another window: dedupe must NOT merge split panes
    await sleep(3000);
    await split(wa.ids[1], wa.ids[2]);
    await split(wb.ids[0], wb.ids[1]);
    await msg({ type: 'debug:stashAll', windowId: driverWin, grouping: 'session' });
    await waitDrain();
    await sleep(500);
    const gs = await dbGroups();
    info('session items', gs[0] ? gs[0].items.map((i) => `w${i.w}:${i.u}:${i.sv ?? '-'}`).join(' ') : 'none');
    check('h: session group keeps both pairs (4 panes, none collapsed by dedupe)', gs.length === 1 && gs[0].items.filter((i) => i.sv >= 0).length === 4, gs[0] && gs[0].items);
    if (gs.length === 1) {
      const rr = await runRestore({ type: 'restoreGroup', groupId: gs[0].id, session: true, newWindow: true });
      const st = await tabsOf();
      info('restored (per window)', st.map((t) => `w${t.w}:${t.u}:${t.sv}`).join(' '));
      const wins = [...new Set(st.map((t) => t.w))];
      check('h: session restore recreated 2 windows with one pair each', wins.length === 2 && wins.every((w) => { const l = st.filter((t) => t.w === w); const sv = l.filter((t) => t.sv >= 0); return sv.length === 2 && sv[0].sv === sv[1].sv; }), st.map((t) => `${t.w}:${t.u}:${t.sv}`));
      check('h: no failures, 2 splits', rr.failed === 0 && rr.splits === 2, rr);
    }
    await msg({ type: 'saveSettings', patch: { stashGrouping: 'window', dedupeOnStash: false } });
    await reset();

    // new window whose FIRST item is a pane + keep entry
    const wn = await mkWin([URLX('n1'), URLX('n2'), URLX('n3')]);
    await sleep(2500);
    await split(wn.ids[0], wn.ids[1]);
    await msg({ type: 'debug:stashWindow', windowId: wn.wid });
    await waitDrain();
    await sleep(400);
    const gn = (await dbGroups())[0];
    const rn = await runRestore({ type: 'restoreGroup', groupId: gn.id, newWindow: true, remove: false });
    const sn = await tabsOf();
    info('new window restore', sn.map((t) => `w${t.w}:${t.u}${t.d ? 'd' : ''}:${t.sv}`).join(' '));
    check('h: restore into a new window: first-item pair recreated, third tab plain', sn.length === 3 && paired(sn[0], sn[1]) && sn[2].sv === -1 && new Set(sn.map((t) => t.w)).size === 1 && sn[0].w !== driverWin, sn);
    check('h: "keep entry" variant leaves the saved set in the list', (await dbGroups()).length === 1 && (await dbGroups())[0].count === 3, await dbGroups());
    await closeAllLocal(); await closeExtraWindows();

    // row icon action: open the pair side by side (clicked on the SECOND pane to test the partner lookup) ...
    const gk = (await dbGroups())[0];
    const rk = await msg({ type: 'restoreSplit', key: `${gk.id}:${gk.items[1].s}`, remove: false });
    await sleep(2500);
    const sk = await tabsOf();
    info('restoreSplit', rk);
    check('h: row action opens BOTH panes as a split view', sk.length === 2 && paired(sk[0], sk[1]) && rk.restored === 2 && rk.splits === 1, { rk, sk });
    await closeAllLocal();
    // ... and a normal click on one pane restores just that tab, plain
    const r1 = await msg({ type: 'restoreItems', keys: [`${gk.id}:${gk.items[0].s}`], remove: false });
    await sleep(2000);
    const s1 = await tabsOf();
    check('h: single-tab restore of one pane opens a plain, unsplit tab', r1.restored === 1 && s1.length === 1 && s1[0].sv === -1, { r1, s1 });
    await reset();
  }
} catch (e) {
  if (String(e.message) !== '__skip__') { console.log('FAIL  test crashed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); fails++; }
} finally {
  cleanup();
}
console.log(fails ? `\n${fails} check(s) FAILED${skips ? ` (${skips} skipped)` : ''}` : `\nsplit-view-test: all checks passed${skips ? ` (${skips} skipped)` : ''}`);
process.exit(fails ? 1 : 0);
