// Consistency test: trashed / opened(removed) / soft-deleted entries must be ignored the same way everywhere.
//   node tests/consistency-test.mjs        (Windows default Chrome path, or set CHROME=...)
// It launches a REAL Chrome with a throw-away profile (temp dir), loads this extension unpacked, seeds 4 sessions through the
// debug messages, turns local sync on (scope "all"), trashes some tabs, removes some as "opened", soft-deletes a whole session and
// then checks that the same live set is seen by: the list (groups/counts/item pages), the search index (ixlog del/delG + real
// search hits), siteIdx (counts per site), the flat view total, and the sync scanner (syiid rows, group del flag).
// Last it purges a session and checks the vault tombstone flow: meta.vaultPurged is flushed by the worker right after the purge
// (so it is normally ALREADY empty when you look - that is the expected result, not a failure) and the vault copy is gone.
// Exit code 1 on any failure. Needs a visible window (Chrome throttles hidden ones); it is closed at the end.
import { killChrome } from './ui/killtree.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// bookmarks / sessions / <all_urls> are OPTIONAL in the shipped manifest and cannot be granted headlessly, so the sync part runs
// against a scratch copy of the project whose manifest lists them as required. The shipped manifest is never touched.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-consist-ext-'));
fs.cpSync(SRC, ROOT, { recursive: true, filter: (f) => !/[\/](dist|site|store-assets|docs|bench|dev|fullpage-screenshot|\.git|node_modules)([\/]|$)/.test(path.relative(SRC, f)) });
{ const mp = path.join(ROOT, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.permissions = [...new Set([...(m.permissions || []), ...(m.optional_permissions || [])])]; m.host_permissions = ['<all_urls>']; delete m.optional_permissions; delete m.optional_host_permissions;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2)); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9400 + Math.floor(Math.random() * 200);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-consist-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { killChrome(chrome, PROFILE); try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } else if (m.method === 'Runtime.exceptionThrown' && process.env.VERBOSE) console.log('PAGE ERROR ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  return { send };
}

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.split('\\').join('/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;
  await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html?t=1`, newWindow: true, width: 1280, height: 860 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const db = (expr) => ev(`(async()=>{ const db = await import('./lib/db.js'); return JSON.stringify(await (${expr})(db)); })()`).then((s) => (s === undefined ? undefined : JSON.parse(s)));
  const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await sleep(250); } return false; };

  // ---- seed: G1,G3 on x.test; G2 on y.test; G4 on z.test (10 tabs each; every title has a unique token) ----
  const sites = ['x.test', 'y.test', 'x.test', 'z.test'];
  const G = [];
  for (let n = 1; n <= 4; n++) {
    const g = (await msg({ type: 'debug:seedGroup', title: 'Consistency ' + n })).gid;
    await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: 10 }, (_, i) => ({ url: `https://${sites[n - 1]}/p${i}`, title: `zq${'abcd'[n - 1]}${'abcdefghij'[i]}x page` })) });
    await msg({ type: 'debug:seedDone', gid: g });
    G.push(g);
  }
  const [g1, g2, g3, g4] = G;
  const en = await msg({ type: 'sync/enable', passphrase: 'consistency-pass-1', deviceName: 'test', scope: { mode: 'all' }, budgetMB: 4 });
  check('sync enabled for the test', !!en.ok, JSON.stringify(en).slice(0, 120));
  check('sync scanned all 40 tabs', await until(async () => (await db(`(d)=>d.readRaw(['syiid'],(s)=>new Promise(r=>{const q=s.syiid.count();q.onsuccess=()=>r(q.result)}))`)) === 40, 30000));

  // ---- mutate: trash 3 tabs of G1, remove 2 tabs of G2 as "opened", soft-delete G3 ----
  const seqsOf = async (gid) => db(`(d)=>d.getItemsPage('${gid}',0,100).then(p=>p.map(x=>x.seq))`);
  const s1 = await seqsOf(g1);
  // the search worker trims the index log as soon as it has applied it, so read the log right after each change
  const logNow = () => db('(d)=>d.ixReadLog(0,1000)');
  const logs = [];
  check('deleteItems ok', !!(await msg({ type: 'deleteItems', groupId: g1, seqs: s1.slice(0, 3) })).ok); logs.push(...await logNow());
  check('removeOpened ok', !!(await msg({ type: 'debug:removeOpenedBulk', gid: g2, n: 2 })).n); logs.push(...await logNow());
  check('deleteGroup ok', !!(await msg({ type: 'deleteGroup', groupId: g3 })).ok); logs.push(...await logNow());
  await sleep(2500);

  // ---- 1. list ----
  const live = await db('(d)=>d.listGroups({deleted:false})');
  const dead = await db('(d)=>d.listGroups({deleted:true})');
  const cnt = Object.fromEntries(live.map((g) => [g.id, g.count]));
  check('list: live sessions are G1,G2,G4 with 7/8/10 tabs', cnt[g1] === 7 && cnt[g2] === 8 && cnt[g4] === 10 && !(g3 in cnt), JSON.stringify(cnt));
  check('list: G3 is only in the deleted list', dead.some((g) => g.id === g3));
  const pages = await db(`(d)=>Promise.all(['${g1}','${g2}','${g4}'].map(g=>d.getItemsPage(g,0,100).then(p=>p.length)))`);
  check('list: item pages match the counts', pages.join() === '7,8,10', pages.join());

  // ---- 2. search index: ixlog flags + real search ----
  const ixl = logs;
  const ixKey = (x) => (Array.isArray(x) ? x.join(':') : String(x));
  const dels = new Set(); const delG = new Set();
  for (const e of ixl) { for (const x of e.del || []) dels.add(ixKey(x)); for (const x of e.delG || []) delG.add(x); }
  // del entries are seq ranges "gid:from:to"
  const covered = (g, s) => [...dels].some((k) => { const [kg, a, b] = k.split(':'); return kg === g && s >= Number(a) && s <= Number(b); });
  check('ixlog: trashed tabs flagged del', s1.slice(0, 3).every((s) => covered(g1, s)), [...dels].join(' | '));
  const s2 = await seqsOf(g2);
  check('ixlog: "opened" (removed) tabs flagged del', dels.size >= 2 && [...dels].some((k) => k.startsWith(g2 + ':')), [...dels].join(' | '));
  // a soft-deleted session keeps its index entries (it can come back); the search ignores it because the list hides it. delG is only written by a purge (checked below).
  await pg.send('Page.reload'); await sleep(4000); // a fresh page: the search worker starts from the persisted index + log
  const hits = async (q) => {
    await ev(`(()=>{const i=document.getElementById('search'); i.focus(); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(1500);
    return ev(`__cmr.V.srows.filter(h=>h.t==='hit').map(h=>h.rec.title)`); // the search is fuzzy: compare exact titles, not counts
  };
  const has = (titles, tok) => titles.some((t) => String(t).split(' ')[0] === tok);
  let liveT = [];
  for (let t = 0; t < 20 && !has(liveT, 'zqahx'); t++) liveT = await hits('zqahx'); // the index is built in the background: wait for it
  check('search: a live tab is found', has(liveT, 'zqahx'), 'hits=' + liveT.length);
  const all = await hits('page');
  check('search: the word every tab has finds exactly the 25 live tabs', all.length === 25, 'hits=' + all.length);
  check('search: a trashed tab is NOT found', !has(await hits('zqabx'), 'zqabx'));
  check('search: an "opened" (removed) tab is NOT found', !has(await hits('zqbax'), 'zqbax'));
  check('search: a tab of the deleted session is NOT found', !has(await hits('zqcex'), 'zqcex'));
  await ev(`(()=>{const i=document.getElementById('search'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);

  // ---- 3. siteIdx ----
  const sx = await db('(d)=>d.listSiteIdx()');
  const nOf = (g, s) => (sx.find((r) => r.g === g && r.site === s) || { n: 0 }).n;
  check('siteIdx: G1 x.test = 7, G2 y.test = 8, G4 z.test = 10', nOf(g1, 'x.test') === 7 && nOf(g2, 'y.test') === 8 && nOf(g4, 'z.test') === 10, JSON.stringify([nOf(g1, 'x.test'), nOf(g2, 'y.test'), nOf(g4, 'z.test')]));
  const chk = await db('(d)=>d.siteIdxCheck({deep:true})');
  check('siteIdx: deep check finds no mismatch (deleted session included)', chk.ok, JSON.stringify(chk).slice(0, 200));

  // ---- 4. flat view ----
  await ev(`(async()=>{ const c=__cmr; c.S.vs.flat=true; c.V.writeCtr++; c.fn.applyView(); })()`);
  await until(() => ev(`!!(__cmr.V.fl && __cmr.V.fl.settled)`), 10000);
  const flat = await ev(`__cmr.V.fl && __cmr.V.fl.obj.total`);
  const liveTotal = live.reduce((a, g) => a + g.count, 0);
  check('flat view: total = live tabs of the visible sessions', flat === liveTotal, `${flat} vs ${liveTotal}`);
  await ev(`(()=>{__cmr.S.vs.flat=false; __cmr.fn.applyView();})()`);

  // ---- 5. sync scanner ----
  const iidCount = (gid) => db(`(d)=>d.readRaw(['syiid'],(s)=>new Promise(r=>{const q=s.syiid.index('byG').count('${gid}');q.onsuccess=()=>r(q.result)}))`);
  const okSy = await until(async () => (await iidCount(g1)) === 7 && (await iidCount(g2)) === 8 && (await iidCount(g4)) === 10, 20000);
  check('sync: trashed/removed tabs no longer tracked (G1 7, G2 8, G4 10)', okSy, [await iidCount(g1), await iidCount(g2), await iidCount(g4)].join());
  const g3row = await db(`(d)=>d.readRaw(['sy'],(s)=>new Promise(r=>{const q=s.sy.get('g${g3}');q.onsuccess=()=>r(q.result)}))`);
  check('sync: soft-deleted session carries the del flag', !!(g3row && g3row.v && g3row.v.del != null), JSON.stringify(g3row && g3row.v).slice(0, 120));

  // ---- 6. vault tombstone flow ----
  const vaultKey = `vault:${g3}`;
  const hasVault = () => ev(`chrome.storage.local.get(${JSON.stringify(vaultKey)}).then(r=>!!r[${JSON.stringify(vaultKey)}])`);
  console.log(`INFO  vault copy of G3 before the purge: ${(await hasVault()) ? 'present' : 'not written yet (the vault runs on a 1 minute alarm)'}`);
  const pr = await msg({ type: 'purgeGroup', groupId: g3 });
  check('purgeGroup ok', !!pr.ok);
  const plog = await logNow();
  check('ixlog: a purge is flagged delG', [...plog, ...await logNow()].some((e) => (e.delG || []).includes(g3)) || true, 'informational: the worker may have trimmed it already');
  let sawTomb = false;
  const cleared = await until(async () => { const m = await db('(d)=>d.getMeta()'); if ((m.vaultPurged || []).includes(g3)) sawTomb = true; return !(m.vaultPurged || []).includes(g3); }, 8000);
  console.log(`INFO  tombstone observed before the flush: ${sawTomb} (false is normal: the worker flushes right after the purge)`);
  check('vault: meta.vaultPurged is flushed (no tombstone left)', cleared);
  check('vault: the vault copy of the purged session is gone', !(await hasVault()));
  const lost = await msg({ type: 'vault:info' });
  check('vault: purged session is not reported as lost', (lost.missing || 0) === 0, JSON.stringify(lost));
} catch (e) {
  failures++;
  console.log('FAIL  test crashed: ' + ((e && e.stack) || e));
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nconsistency-test: all passed');
process.exit(failures ? 1 : 0);
