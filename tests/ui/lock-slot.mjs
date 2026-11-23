// Real-Chrome regression: the lock's second unlock methods (backup password + passkey through WebAuthn PRF).
//   node tests/ui/lock-slot.mjs        Env: CHROME, CMR_TEST_ROOT, CMR_PORT (default 9741)
// One throw-away Chrome (own profile, killtree cleanup, watchdog). The passkey is a CDP VIRTUAL authenticator (WebAuthn.addVirtualAuthenticator
// with hasPrf) attached to the one list page that stays open for the whole run (a virtual authenticator belongs to its tab).
// Steps: lock ON + stash; settings card: add backup password (refusals: wrong current password, same as main), add passkey; change the main
// password (both slots stay valid); lock screen: unlock with the backup password, with the passkey, wrong tries share ONE lockout with the
// main password; encrypted backup file opens with the backup password and with the passkey after "erase everything", which also clears the
// slots; removing a slot in the card makes its secret open nothing; no plain text in IndexedDB / storage.local at any point.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.CMR_TEST_ROOT || os.tmpdir();
const ROOT = fs.mkdtempSync(path.join(BASE, 'cmr-slot-ext-'));
fs.cpSync(SRC, ROOT, { recursive: true, filter: (f) => !/[\/](dist|site|store-assets|docs|bench|dev|knowledge|fullpage-screenshot|\.git|node_modules)([\/]|$)/.test(path.relative(SRC, f)) });
{ const mp = path.join(ROOT, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.permissions = [...new Set([...(m.permissions || []), ...(m.optional_permissions || [])])]; m.host_permissions = ['<all_urls>']; delete m.optional_permissions; delete m.optional_host_permissions;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2)); }
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9741);
const PROFILE = fs.mkdtempSync(path.join(BASE, 'cmr-slot-'));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-slot-dl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failures++; };

const srv = http.createServer((req, res) => { const n = decodeURIComponent(req.url.split('/').pop() || 'x'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>${n}</title><p>${n}</p>`); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const WEB = srv.address().port;
const NEEDLES = ['zsslot1', 'zsslot2', 'zsslot3'];
const ALLNEEDLES = [...NEEDLES, `127.0.0.1:${WEB}`];
const PW = 'correct horse 42 battery';
const PW2 = 'the second main password 77';
const BK = 'my backup phrase 2026 blue';

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
    else if (errors && m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => j(new Error('timeout ' + method)), 60000); p[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 400)); return r.result.result.value; };
  return { send, ev, ws };
}
const until = async (fn, ms = 20000, step = 250) => { for (let t = 0; t < ms; t += step) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const hasNeedle = (s) => ALLNEEDLES.filter((n) => s.includes(n));

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed: ' + JSON.stringify(ld));
  const EXT = ld.result.id;
  const swErrors = [];
  let swT = null;
  for (let i = 0; i < 40 && !swT; i++) { swT = (await J('/json/list')).find((t) => t.type === 'service_worker' && t.url.includes(EXT)); if (!swT) await sleep(250); }
  if (swT) { const sw = await cdp(swT.webSocketDebuggerUrl, swErrors); await sw.send('Runtime.enable'); await sleep(1500); sw.ws.close(); }
  check('1 service worker target exists and raised no exception', !!swT && swErrors.length === 0, swErrors.join(' | ').slice(0, 200));

  // ---- the ONE list page (it keeps the virtual authenticator) ----
  const pageErrors = [];
  const { result } = await br.send('Target.createTarget', { url: `chrome-extension://${EXT}/stash.html#settings`, newWindow: true });
  let t0; for (let i = 0; i < 30 && !t0; i++) { await sleep(200); t0 = (await J('/json/list')).find((x) => x.id === result.targetId); }
  const pg = await cdp(t0.webSocketDebuggerUrl, pageErrors);
  await pg.send('Runtime.enable'); await pg.send('Page.enable'); await pg.send('Page.bringToFront'); await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // WebAuthn refuses with NotAllowedError ("page does not have focus") when another window took the OS foreground, which focus emulation does not cover: keep the tab in front for the whole run.
  setInterval(() => { pg.send('Page.bringToFront').catch(() => {}); br.send('Target.activateTarget', { targetId: result.targetId }).catch(() => {}); }, 400).unref();
  await sleep(2500);
  const reload = async (hash) => { if (hash != null) await pg.ev(`location.hash=${JSON.stringify(hash)}`); await pg.send('Page.reload'); await sleep(2500); };
  const msg = (m) => pg.ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const waitUi = (sel, ms = 10000) => until(() => pg.ev(`!!document.querySelector(${JSON.stringify(sel)})`), ms);
  const setVal = (id, v) => pg.ev(`(()=>{ const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const click = (id) => pg.ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const text = (sel) => pg.ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`);
  const status = () => msg({ type: 'lock.status' });
  const clearFail = () => pg.ev(`chrome.storage.local.remove('lockFail')`);

  const en = await pg.send('WebAuthn.enable', { enableUI: false });
  const va = await pg.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true, hasHmacSecret: true } });
  check('1 virtual authenticator with PRF added to the extension page', !!(en.result && va.result && va.result.authenticatorId), JSON.stringify(va).slice(0, 120));
  check('1 extension page can use WebAuthn (secure context, credentials API)', await pg.ev(`isSecureContext && !!navigator.credentials && location.protocol==='chrome-extension:'`));

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
  const makeTabs = async (names) => {
    const urls = names.map((n) => `http://127.0.0.1:${WEB}/t/${n}`);
    const w = await pg.ev(`chrome.windows.create({ url: ${JSON.stringify(urls)}, focused: false, width: 800, height: 600 }).then((w)=>w.id)`);
    await until(async () => (await pg.ev(`chrome.tabs.query({ windowId: ${w} }).then((t)=>t.filter((x)=>x.status==='complete'&&x.title).length)`)) === names.length, 20000);
    return w;
  };

  // ---- 2. lock ON, stash ----
  check('2 lock is off by default', (await status()).enabled === false);
  const pre = await msg({ type: 'lock.enable', password: PW, withRecovery: true });
  check('2 lock.enable ok', !!pre.recoveryKey && !pre.error, pre.error || '');
  check('2 migration finished', !!(await until(async () => { const s = await status(); return s.state === 'on' && !s.job; }, 30000)));
  const w = await makeTabs(NEEDLES);
  const sr = await msg({ type: 'stashNow', scope: 'window', windowId: w });
  check('2 3 tabs stashed while unlocked', !!(await until(async () => (await itemTitles()).filter((i) => NEEDLES.includes(i.t)).length === 3, 25000)), JSON.stringify(sr).slice(0, 80));
  check('2 status shows no slots yet', ((await status()).slots || []).length === 0);

  // ---- 3. settings card: backup password ----
  await reload('#settings');
  check('3 settings card shows the "other ways to unlock" section', !!(await waitUi('#lkBkAddOpen')));
  await click('lkBkAddOpen');
  await waitUi('#lkB0');
  await setVal('lkB0', 'not my password'); await setVal('lkB1', BK); await setVal('lkB2', BK); await click('lkBkGo2');
  check('3 wrong current password: refused, no slot', !!(await until(async () => /./.test((await text('.lkc-msg.bad')).trim()), 15000)) && ((await status()).slots || []).length === 0);
  await clearFail();
  await setVal('lkB0', PW); await setVal('lkB1', PW); await setVal('lkB2', PW); await click('lkBkGo2');
  check('3 backup password equal to the main one: refused', !!(await until(async () => /./.test((await text('.lkc-msg.bad')).trim()), 15000)) && ((await status()).slots || []).length === 0, (await text('.lkc-msg.bad')).trim());
  await setVal('lkB0', PW); await setVal('lkB1', 'short'); await setVal('lkB2', 'short'); await click('lkBkGo2');
  await sleep(500);
  check('3 too short backup password: refused', ((await status()).slots || []).length === 0);
  await setVal('lkB0', PW); await setVal('lkB1', BK); await setVal('lkB2', BK); await click('lkBkGo2');
  const s1 = await until(async () => { const s = await status(); return (s.slots || []).some((x) => x.kind === 'pw') ? s : null; }, 20000);
  check('3 backup password added (slot visible, no secret in status)', !!s1 && !JSON.stringify(s1.slots).includes(BK) && !/"(ct|iv|salt)"/.test(JSON.stringify(s1.slots)), JSON.stringify(s1 && s1.slots));
  check('3 card now offers to remove it instead', !!(await waitUi('#lkBkRmOpen')));

  // ---- 4. settings card: passkey ----
  check('4 card offers "add passkey"', !!(await waitUi('#lkPkAddOpen')));
  await click('lkPkAddOpen');
  await waitUi('#lkP0');
  await setVal('lkP0', PW); await setVal('lkP1', 'test key A'); await click('lkPkGo');
  const s2 = await until(async () => { const s = await status(); return (s.slots || []).some((x) => x.kind === 'prf') ? s : null; }, 30000);
  check('4 passkey created through WebAuthn PRF in the extension page and added', !!s2, (await text('.lkc-msg')).trim().slice(0, 100));
  const pkSlot = s2 && s2.slots.find((x) => x.kind === 'prf');
  check('4 passkey slot carries only public data (id, name, credential id, salt)', !!pkSlot && pkSlot.name === 'test key A' && typeof pkSlot.cid === 'string' && typeof pkSlot.psalt === 'string' && Object.keys(pkSlot).sort().join() === 'cid,id,kind,name,psalt,ts', JSON.stringify(pkSlot));
  const dumpMeta = await pg.ev(`(async()=>{ const db = await import('./lib/db.js'); const r = await db.getLockRow(); return JSON.stringify(r, (k, v) => (v instanceof Uint8Array ? 'U' + v.length : v)); })()`);
  check('4 meta.lock stores no plain secret (no password, no PRF output field)', !dumpMeta.includes(BK) && !dumpMeta.includes(PW) && /"slots":\[/.test(dumpMeta) && !/"prf":/.test(dumpMeta), dumpMeta.slice(0, 80));

  // ---- 5. change the main password: slots stay valid ----
  const chg = await msg({ type: 'lock.changePassword', old: PW, new: PW2 });
  check('5 main password changed', chg.ok === true, JSON.stringify(chg));
  check('5 slots survived the change', ((await status()).slots || []).length === 2);

  // ---- 6. lock screen: backup password ----
  await msg({ type: 'lock.lockNow' });
  await reload();
  check('6 locked: lock screen shown', !!(await waitUi('#lockScreen')));
  await pg.ev(`document.querySelector('.lk-links .lk-link').click()`);
  check('6 "forgot" panel offers backup password and passkey', !!(await waitUi('#lkBkOpen:not([hidden])')) && !!(await waitUi('#lkPkOpen')));
  await click('lkBkOpen');
  await setVal('lkBk', 'wrong backup phrase'); await pg.ev(`document.getElementById('lkBk').form.requestSubmit()`);
  check('6 wrong backup password refused (still locked, message shown)', !!(await until(async () => (await status()).failN === 1, 15000)) && !!(await pg.ev(`!!document.getElementById('lockScreen')`)) && /\S/.test(await text('#lkBkMsg')) && !/…\s*$/.test(await text('#lkBkMsg')), (await text('#lkBkMsg')).trim());
  let st = await status();
  check('6 the failure was counted (1)', st.failN === 1, 'failN=' + st.failN);
  // shared lockout: main password (1), passkey with a wrong secret (1) -> three free failures used up; the 4th starts a delay
  const r1 = await msg({ type: 'lock.unlock', password: 'nope nope nope 1' });
  const slotId = pkSlot.id;
  const r2 = await msg({ type: 'lock.unlock', slot: { id: slotId, prf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
  check('6 wrong main password and wrong passkey secret share the counter (n=3)', r1.error === 'wrong' && r2.error === 'wrong' && (await status()).failN === 3, JSON.stringify([r1.failN, r2.failN]));
  const r3 = await msg({ type: 'lock.unlock', backupPassword: 'nope nope nope 3' });
  const r4 = await msg({ type: 'lock.unlock', backupPassword: BK });
  check('6 after the 4th failure even the CORRECT backup password waits (lockout applies)', r3.error === 'wrong' && r3.failUntil > Date.now() && r4.error === 'wait', JSON.stringify([r3.error, r4.error]));
  await clearFail();
  await setVal('lkBk', BK); await pg.ev(`document.getElementById('lkBk').form.requestSubmit()`);
  check('6 backup password unlocks (lock screen gone)', !!(await until(() => pg.ev(`!document.getElementById('lockScreen')`), 20000)));
  check('6 status unlocked, counter reset', await (async () => { const s = await status(); return s.locked === false && s.failN === 0; })());
  const t6 = (await itemTitles()).map((i) => i.t);
  check('6 stashed titles readable after the backup-password unlock (same master key)', NEEDLES.every((n) => t6.includes(n)), t6.join(','));

  // ---- 7. lock screen: passkey ----
  await msg({ type: 'lock.lockNow' });
  await reload();
  await waitUi('#lockScreen');
  await pg.ev(`document.querySelector('.lk-links .lk-link').click()`);
  await waitUi('#lkPkOpen');
  await click('lkPkOpen');
  check('7 passkey (virtual authenticator, PRF) unlocks the list', !!(await until(() => pg.ev(`!document.getElementById('lockScreen')`), 30000)), (await text('#lkSlotMsg')).trim());
  const t7 = (await itemTitles()).map((i) => i.t);
  check('7 titles readable after the passkey unlock', NEEDLES.every((n) => t7.includes(n)));
  check('7 old main password is dead, new main password works', await (async () => { await msg({ type: 'lock.lockNow' }); await sleep(3000); const a = await msg({ type: 'lock.unlock', password: PW }); await clearFail(); const b = await msg({ type: 'lock.unlock', password: PW2 }); return a.error === 'wrong' && b.ok === true; })());

  await reload();
  check('7 page is open and unlocked again', !(await pg.ev(`!!document.getElementById('lockScreen')`)) || !!(await until(() => pg.ev(`!document.getElementById('lockScreen')`), 5000)));
  // ---- 8. archive: made with both slots, erase clears them, imports with the backup password and with the passkey ----
  const arch = await pg.ev(`(async()=>{ const m = await import('./lib/lockarchive.js'); const r = await m.buildArchive({}); if (r.error) return JSON.stringify(r); return JSON.stringify({ name: r.name, text: await r.blob.text() }); })()`).then(JSON.parse);
  check('8 encrypted archive made, no plain text, slots inside the header (public part only)', !arch.error && hasNeedle(arch.text).length === 0 && !arch.text.includes(BK) && /"slots":\[/.test(arch.text.split('\n')[0]), arch.error || String(arch.text.length));
  const FILE = path.join(DL, 'slot-test.tabroost'); fs.writeFileSync(FILE, arch.text);
  const dump1 = await dumpAll(); const sl1 = await storageLocal();
  check('8 unlocked: no plain needle in IndexedDB / storage.local', hasNeedle(dump1.out).length === 0 && hasNeedle(sl1).length === 0, hasNeedle(dump1.out + sl1).join(','));
  await msg({ type: 'lock.resetErase', confirm: 'ลบทั้งหมด' }).catch(() => null); // the page reloads itself, so the answer may be lost
  check('8 erase everything done (lock off)', !!(await until(async () => (await status()).enabled === false, 30000)));
  await sleep(1500);
  const st8 = await status();
  check('8 after erase: lock off, NO slots left', st8.enabled === false && (st8.slots || []).length === 0, JSON.stringify(st8.slots));
  check('8 after erase: meta.lock row gone from IndexedDB', await pg.ev(`(async()=>{ const db = await import('./lib/db.js'); return (await db.getLockRow()) == null; })()`));
  await reload('#settings');
  await waitUi('#lkImportOpen');
  const doImport = async (kind, secret) => {
    await pg.ev(`document.getElementById('lkImportOpen') && document.getElementById('lkImportOpen').click()`);
    await until(() => pg.ev(`!!document.getElementById('arFile')`), 5000);
    const doc = await pg.send('DOM.getDocument', {});
    const q = await pg.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#arFile' });
    await pg.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [FILE.replace(/\\/g, '/')] });
    await pg.ev(`(()=>{ const k=document.getElementById('arKind'); k.value=${JSON.stringify(kind)}; k.dispatchEvent(new Event('change')); document.getElementById('arSecret').value=${JSON.stringify(secret)}; document.getElementById('arGo').click(); })()`);
    await sleep(600);
    await until(() => pg.ev(`!document.getElementById('arGo').disabled`), 60000, 300);
    await sleep(800);
    return pg.ev(`(document.getElementById('arMsg')||{}).textContent`);
  };
  const live = async () => (await groupsNow()).filter((g) => !g.del);
  const i0 = await doImport('bk', 'wrong backup phrase');
  check('8 import with a wrong backup password refused, nothing added', (await live()).length === 0, String(i0));
  const i1 = await doImport('bk', BK);
  const g1 = await live();
  const ti1 = (await itemTitles()).map((i) => i.t);
  check('8 import with the BACKUP PASSWORD: tab sets return', g1.length >= 1 && NEEDLES.every((n) => ti1.includes(n)), `groups=${g1.length} ${i1}`);
  const i2 = await doImport('pk', '');
  const g2 = await live();
  check('8 import with the PASSKEY (PRF): tab sets added again', g2.length === g1.length * 2, `before=${g1.length} after=${g2.length} ${i2}`);

  // ---- 9. new lock after the erase starts without slots; removing slots in the card ----
  const en2 = await msg({ type: 'lock.enable', password: PW, withRecovery: false });
  check('9 new lock after erase has no slots', !en2.error && ((await status()).slots || []).length === 0);
  await until(async () => { const s = await status(); return s.state === 'on' && !s.job; }, 30000);
  await reload('#settings');
  await waitUi('#lkBkAddOpen');
  await click('lkBkAddOpen'); await waitUi('#lkB0');
  await setVal('lkB0', PW); await setVal('lkB1', BK); await setVal('lkB2', BK); await click('lkBkGo2');
  await until(async () => ((await status()).slots || []).some((x) => x.kind === 'pw'), 20000);
  await waitUi('#lkPkAddOpen'); await click('lkPkAddOpen'); await waitUi('#lkP0');
  await setVal('lkP0', PW); await setVal('lkP1', ''); await click('lkPkGo');
  const s9 = await until(async () => { const s = await status(); return (s.slots || []).length === 2 ? s : null; }, 30000);
  check('9 both slots added again (passkey default name used)', !!s9 && s9.slots.some((x) => x.kind === 'prf' && x.name.length > 0));
  // a SECOND passkey: unlocking then goes through prf.evalByCredential with two credentials
  await waitUi('#lkPkAddOpen'); await click('lkPkAddOpen'); await waitUi('#lkP0');
  await setVal('lkP0', PW); await setVal('lkP1', 'second key'); await click('lkPkGo');
  const s9b = await until(async () => { const s = await status(); return s.slots.filter((x) => x.kind === 'prf').length === 2 ? s : null; }, 30000);
  check('9 second passkey added (two credentials in the authenticator)', !!s9b);
  await msg({ type: 'lock.lockNow' });
  await sleep(2500);
  await reload();
  await waitUi('#lockScreen');
  await pg.ev(`document.querySelector('.lk-links .lk-link').click()`);
  await waitUi('#lkPkOpen'); await click('lkPkOpen');
  check('9 with two passkeys the unlock still works (evalByCredential)', !!(await until(() => pg.ev(`!document.getElementById('lockScreen')`), 30000)), (await text('#lkSlotMsg')).trim());
  await reload('#settings');
  await waitUi('#lkBkRmOpen');
  // remove the backup password via the card (asks the current password)
  await waitUi('#lkBkRmOpen'); await click('lkBkRmOpen'); await waitUi('#lkRm0');
  await setVal('lkRm0', 'wrong current'); await click('lkRmGo');
  await until(async () => /./.test((await text('.lkc-msg.bad')).trim()), 15000);
  check('9 removal with a wrong current password refused', ((await status()).slots || []).length === 3);
  await clearFail();
  await setVal('lkRm0', PW); await click('lkRmGo');
  check('9 backup password removed', !!(await until(async () => ((await status()).slots || []).every((x) => x.kind !== 'pw'), 20000)));
  const bkGone = await msg({ type: 'lock.unlock', backupPassword: BK });
  check('9 the removed backup password opens nothing', bkGone.error === 'noSlot' || bkGone.error === 'wrong', JSON.stringify(bkGone));
  // remove both passkeys one by one
  for (let left = 2; left >= 1; left--) {
    await until(() => pg.ev(`!!document.querySelector('[data-slot] button')`), 10000);
    await pg.ev(`document.querySelector('[data-slot] button').click()`); await waitUi('#lkRm0');
    await setVal('lkRm0', PW); await click('lkRmGo');
    await until(async () => ((await status()).slots || []).length === left - 1, 20000);
    await waitUi('#lkPkAddOpen');
  }
  check('9 passkeys removed', ((await status()).slots || []).length === 0);
  await msg({ type: 'lock.lockNow' });
  await reload();
  await waitUi('#lockScreen');
  await pg.ev(`document.querySelector('.lk-links .lk-link').click()`);
  await sleep(1200);
  check('9 lock screen no longer offers the removed methods (recovery form still there)', await pg.ev(`!!document.getElementById('lkRec') && !document.getElementById('lkBkOpen') && !document.getElementById('lkPkOpen')`));

  // ---- 10. a11y of the new lock-screen controls and the card ----
  await clearFail();
  await msg({ type: 'lock.unlock', password: PW });
  await reload('#settings');
  await waitUi('#lkBkAddOpen');
  const aud = await pg.ev(`(()=>{ const out={unnamed:[],dup:[]}; const vis=(e)=>{const c=getComputedStyle(e);return c.display!=='none'&&c.visibility!=='hidden'}; const nm=(e)=>!!(e.getAttribute('aria-label')||(e.labels&&e.labels.length)||e.textContent.trim()||e.title||e.placeholder);
    for (const e of document.querySelectorAll('#s-lock button, #s-lock input, #s-lock select')) { if (!vis(e)||e.closest('[hidden]')) continue; if(!nm(e)) out.unnamed.push(e.tagName+'#'+e.id); }
    const seen=new Map(); for (const e of document.querySelectorAll('[id]')) seen.set(e.id,(seen.get(e.id)||0)+1); for (const [k,n] of seen) if(n>1) out.dup.push(k); return out; })()`);
  check('10 settings card: controls named, no duplicate ids', aud.unnamed.length === 0 && aud.dup.length === 0, JSON.stringify(aud));

  const real = pageErrors.filter((e) => !/ResizeObserver/i.test(e));
  check('list page raised no uncaught exception during the run', real.length === 0, real.slice(0, 3).join(' | '));
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e)); failures++;
} finally {
  cleanup();
  console.log(failures ? `lock-slot: ${failures} FAILED` : 'lock-slot: ALL PASSED');
  process.exit(failures ? 1 : 0);
}
