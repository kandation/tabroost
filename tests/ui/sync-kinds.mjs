// Sync protocol 2 on the REAL IndexedDB / bookmarks glue (real Chrome over CDP): categories and the extra tab-set fields travel between two
// devices (the service worker's controller = device A, tests/ui/peer.html with its own database = device B), the preferences scan runs without
// errors, and the "sync settings too" switch works and is reported in the status.
//   node tests/ui/sync-kinds.mjs        Env: CHROME, CMR_TEST_ROOT, CMR_PORT (default 9452)
// bookmarks is an OPTIONAL permission and cannot be granted headlessly: the extension runs from a scratch copy whose manifest lists it as required.
// (Settings values themselves are checked in node: tests/sync/prefs-sync.mjs; both devices of this test share one browser profile, so they would share the settings.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.CMR_TEST_ROOT || os.tmpdir();
const ROOT = fs.mkdtempSync(path.join(BASE, 'cmr-sk-ext-'));
fs.cpSync(SRC, ROOT, { recursive: true, filter: (f) => !/[\/](dist|site|store-assets|docs|bench|dev|knowledge|fullpage-screenshot|\.git|node_modules)([\/]|$)/.test(path.relative(SRC, f)) });
{ const mp = path.join(ROOT, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.permissions = [...new Set([...(m.permissions || []), ...(m.optional_permissions || [])])]; m.host_permissions = ['<all_urls>']; delete m.optional_permissions; delete m.optional_host_permissions;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2)); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9452);
const PROFILE = fs.mkdtempSync(path.join(BASE, 'cmr-sk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failures++; };
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
chrome.unref();
const cleanup = () => { killChrome(chrome, PROFILE); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ } };
process.on('exit', cleanup);
const dog = setTimeout(() => { console.log('FAIL  watchdog'); cleanup(); process.exit(2); }, 300000);
dog.unref();
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(u, errors) {
  const ws = new WebSocket(u); let id = 0; const p = {};
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p[m.id]) { p[m.id](m); delete p[m.id]; } else if (errors && m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => j(new Error('timeout ' + method)), 60000); p[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };
  return { send, ev, ws };
}
const until = async (fn, ms = 45000, step = 400) => { for (let t = 0; t < ms; t += step) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const PASS = 'a sync passphrase for the kinds test';

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;
  const errors = [];
  const open = async (url) => {
    const { result } = await br.send('Target.createTarget', { url, newWindow: true });
    let t; for (let i = 0; i < 30 && !t; i++) { await sleep(200); t = (await J('/json/list')).find((x) => x.id === result.targetId); }
    const p = await cdp(t.webSocketDebuggerUrl, errors);
    await p.send('Runtime.enable'); await p.send('Page.enable');
    await sleep(2500);
    return p;
  };
  const A = await open(`chrome-extension://${EXT}/stash.html`);
  const msg = (m) => A.ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  check('service worker answers', (await msg({ type: 'ping' })).pong === true);

  // ---- device A: categories + a set with every extra field ----
  const work = (await msg({ type: 'catSave', cat: { name: 'Work', color: 'green' } })).cat;
  const later = (await msg({ type: 'catSave', cat: { name: 'Later', color: 'red' } })).cat;
  const gid = (await msg({ type: 'debug:seedGroup', title: 'Kinds' })).gid;
  await msg({ type: 'debug:seedItems', gid, items: [{ url: 'https://k.example.test/1', title: 'one', w: 1, ws: true }, { url: 'https://k.example.test/2', title: 'two', w: 1 }] });
  await msg({ type: 'debug:seedDone', gid });
  for (const f of ['pinned', 'pending', 'archived', 'starred']) await msg({ type: 'setFlag', groupId: gid, flag: f, value: true });
  await msg({ type: 'groupNote', groupId: gid, note: 'a note' });
  await msg({ type: 'groupLook', groupId: gid, color: 4, emoji: '\u{1F4DA}' });
  await msg({ type: 'groupsSetCat', gids: [gid], cat: work.id });
  const en = await msg({ type: 'sync/enable', passphrase: PASS, deviceName: 'A', scope: { mode: 'all' }, budgetMB: 4 });
  check('A: sync enabled (protocol 2, "sync settings too" on by default)', en.ok === true, JSON.stringify(en).slice(0, 120));
  const st = (await msg({ type: 'sync/getStatus' })).status;
  check('A: status reports syncSettings=true, canSyncSettings=true, proto=2', st.syncSettings === true && st.canSyncSettings === true && st.proto === 2, JSON.stringify({ s: st.syncSettings, c: st.canSyncSettings, p: st.proto }));

  // ---- device B joins ----
  const B = await open(`chrome-extension://${EXT}/tests/ui/peer.html`);
  const bdb = (expr) => B.ev(`(async()=>{ const db = window.peer.db; return JSON.stringify(await (${expr})(db)); })()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const j = await B.ev(`window.peer.ctl.handle({type:'sync/join', passphrase:${JSON.stringify(PASS)}, deviceName:'B', scope:{mode:'all'}}).then(JSON.stringify)`).then(JSON.parse);
  check('B: joined', j.ok === true, JSON.stringify(j).slice(0, 160));
  const bGroup = () => bdb(`(d)=>d.listGroups().then((l)=>l.find((g)=>g.title==='Kinds')||null)`);
  const okB = await until(async () => { const g = await bGroup(); const c = await bdb('(d)=>d.listCategories()'); return g && c.length === 2 && g.cat; });
  const g0 = await bGroup(); const cats0 = await bdb('(d)=>d.listCategories()');
  check('B received both categories (names, colours)', okB && cats0.some((c) => c.name === 'Work' && c.color === 'green') && cats0.some((c) => c.name === 'Later' && c.color === 'red'), JSON.stringify(cats0.map((c) => c.name)));
  check('B received the set with pinned / to-do / archived / starred, note, colour, emoji and category', !!g0 && g0.pinned === true && g0.pending === true && g0.archived === true && g0.starred === true && g0.note === 'a note' && g0.color === 4 && g0.emoji === '\u{1F4DA}' && g0.cat === work.id, JSON.stringify(g0 && { p: g0.pinned, n: g0.note, c: g0.color, e: g0.emoji, cat: g0.cat }));
  const items0 = await bdb(`(d)=>d.getItemsPage('${g0.id}',0,50).then((p)=>p.map((x)=>({u:x.url,w:x.w||0,ws:!!x.ws})))`);
  check('B received the tabs including the window-start flag', items0.length === 2 && items0.some((x) => x.u.endsWith('/1') && x.ws === true && x.w === 1), JSON.stringify(items0));

  // ---- changes in both directions ----
  await msg({ type: 'catSave', cat: { id: work.id, name: 'Work (renamed)' } });
  await msg({ type: 'catDelete', id: later.id });
  await msg({ type: 'groupNote', groupId: gid, note: 'edited on A' });
  const bNow = await until(async () => { const c = await bdb('(d)=>d.listCategories()'); const g = await bGroup(); return c.length === 1 && c[0].name === 'Work (renamed)' && g && g.note === 'edited on A' ? { c, g } : null; });
  check('A -> B: rename, delete of a category and an edited note arrive', !!bNow, bNow ? '' : JSON.stringify(await bdb('(d)=>d.listCategories()')));
  await B.ev(`window.peer.db.updateGroup(${JSON.stringify(g0.id)}, { pinned: false, emoji: null })`);
  const nc = await B.ev(`window.peer.db.saveCategory({ name: 'Made on B', color: 'cyan' }).then((c) => c.id)`);
  const aNow = await until(async () => {
    const g = await A.ev(`(async()=>{ const db = await import('./lib/db.js'); const g = await db.getGroup(${JSON.stringify(gid)}); const c = await db.listCategories(); return JSON.stringify({ pinned: !!g.pinned, emoji: g.emoji || null, note: g.note, cats: c.map((x) => x.name) }); })()`).then(JSON.parse);
    return g.pinned === false && g.emoji === null && g.note === 'edited on A' && g.cats.includes('Made on B') && g.cats.length === 2 ? g : null;
  });
  check('B -> A: unpin + emoji removed (other fields untouched) and a category made on B arrive', !!aNow, JSON.stringify(aNow));
  check('B: status shows protocol 2 for this device', ((await B.ev(`window.peer.ctl.handle({type:'sync/getStatus'}).then(JSON.stringify)`).then(JSON.parse)).status.proto) === 2);

  // ---- the switch ----
  const off = await msg({ type: 'sync/setSettingsSync', on: false });
  const stOff = (await msg({ type: 'sync/getStatus' })).status;
  check('A: "sync settings too" can be turned off (status follows)', off.ok === true && stOff.syncSettings === false);
  await msg({ type: 'saveSettings', patch: { density: 'compact' } });
  await sleep(2500);
  const on = await msg({ type: 'sync/setSettingsSync', on: true });
  const stOn = (await msg({ type: 'sync/getStatus' })).status;
  check('A: ... and on again without error', on.ok === true && stOn.syncSettings === true && stOn.state !== 'error', JSON.stringify({ s: stOn.state, e: stOn.error }));
  const sy = await A.ev(`(async()=>{ const db = await import('./lib/db.js'); const r = await db.readRaw(['sy'], (s) => db.req(s.sy.get('sprefs'))); return JSON.stringify(r ? { v: !!r.v, fh: Object.keys(r.fh || {}).length } : null); })()`).then(JSON.parse);
  check('A: the preferences entity has a synced baseline and field versions (the scan ran)', !!sy && sy.v === true && sy.fh > 0, JSON.stringify(sy));
  check('no script errors on either page', errors.length === 0, errors.join(' | ').slice(0, 400));
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nsync-kinds: ${failures} FAILED` : '\nsync-kinds: all passed');
process.exit(failures ? 1 : 0);
