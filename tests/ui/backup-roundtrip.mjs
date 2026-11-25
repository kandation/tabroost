// Backup file round trip in real Chrome (CDP): export -> wipe -> import must give back EVERY item the file promises, and a second import
// must merge without duplicating or losing anything. Also: older formats (v2 ndjson, v1 json) import, hostile input is ignored.
//   node tests/ui/backup-roundtrip.mjs        Env: CHROME, CMR_PORT (default 9451)
// One throw-away Chrome (own profile, killtree cleanup). The download is captured in the page (no file dialog).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9451);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-backup-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => killChrome(chrome, PROFILE);
process.on('exit', cleanup);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  return { send: (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }) };
}

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  if (!ld.result) throw new Error('loadUnpacked failed');
  await br.send('Target.createTarget', { url: `chrome-extension://${ld.result.id}/stash.html?t=1`, newWindow: true, width: 1400, height: 900 });
  await sleep(3000);
  const target = (await J('/json/list')).find((t) => t.type === 'page' && t.url.includes('stash.html'));
  const pg = await cdp(target.webSocketDebuggerUrl);
  await pg.send('Runtime.enable'); await pg.send('Page.bringToFront');
  const ev = async (expr) => { const r = await pg.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const until = async (fn, ms = 10000) => { for (let t = 0; t < ms; t += 150) { if (await fn()) return true; await sleep(150); } return false; };

  // ---- the state the file must carry (everything marked YES in the audit) ----
  const mkSet = async (title, items, extra = {}) => { const g = (await msg({ type: 'debug:seedGroup', title, ...extra })).gid; await msg({ type: 'debug:seedItems', gid: g, items }); await msg({ type: 'debug:seedDone', gid: g }); return g; };
  const work = (await msg({ type: 'catSave', cat: { name: 'Work', color: 'green' } })).cat;
  const later = (await msg({ type: 'catSave', cat: { name: 'Later', color: 'red' } })).cat;
  const tabGroups = [{ i: 0, title: 'Docs', color: 'blue', collapsed: true, windowIdx: 1 }, { i: 1, title: 'Misc', color: 'pink', collapsed: false, windowIdx: 2 }];
  const G1 = await mkSet('Alpha', [
    { url: 'https://a.example.test/1', title: 'A one', w: 1, ws: true, tg: 0 }, { url: 'https://a.example.test/2', title: 'A two', w: 1, tg: 0 },
    { url: 'https://a.example.test/3', title: 'A three', w: 2, ws: true, tg: 1, sv: 0 }, { url: 'https://a.example.test/4', title: 'A four', w: 2, tg: 1, sv: 0 }], { windowCount: 2, tabGroups });
  const G2 = await mkSet('Beta', [{ url: 'https://b.example.test/1', title: 'B one' }, { url: 'https://b.example.test/2', title: 'B two' }]);
  const G3 = await mkSet('Gamma (deleted)', [{ url: 'https://c.example.test/1', title: 'C one' }]);
  const G4 = await mkSet('Delta', [{ url: 'https://d.example.test/1', title: 'D one' }, { url: 'https://d.example.test/2', title: 'D two' }, { url: 'https://d.example.test/3', title: 'D three' }]);
  for (const [g, f] of [[G1, 'starred'], [G1, 'pinned'], [G2, 'archived'], [G2, 'pending'], [G4, 'locked']]) await msg({ type: 'setFlag', groupId: g, flag: f, value: true });
  await msg({ type: 'groupNote', groupId: G1, note: 'remember the milk' });
  await msg({ type: 'groupLook', groupId: G1, color: 3, emoji: '\u{1F680}' });
  await msg({ type: 'groupsSetCat', gids: [G1], cat: work.id });
  await msg({ type: 'groupsSetCat', gids: [G2], cat: later.id });
  await msg({ type: 'deleteGroup', groupId: G3 });
  await msg({ type: 'setFlag', groupId: G4, flag: 'locked', value: false });
  const d4 = await ev(`(async()=>{ const db = await import('./lib/db.js'); return JSON.stringify((await db.getItemsPage(${JSON.stringify(G4)}, 0, 10)).map((x)=>x.seq)); })()`).then(JSON.parse);
  await msg({ type: 'deleteItems', groupId: G4, seqs: [d4[0]] }); // -> one trash row
  await msg({ type: 'setFlag', groupId: G4, flag: 'locked', value: true });
  const SET = { theme: 'dark', suspendAfterMin: 45, whitelist: ['example.com', 'meet.test'], excludeSites: ['secret.test'], density: 'compact', autoRulesOn: true, autoRulesText: 'github.com=Work', shortcutsOn: false, snapshotMinutes: 10, accent: 'teal', closeDuplicates: 'onStash' };
  await msg({ type: 'saveSettings', patch: SET });
  const VIEW = { sort: 'title', starredFirst: true, groupBy: 'site', slotMode: 'hour', itemSort: 'title', itemDir: 'desc', sortRev: true, flat: false, flatSort: 'site', flatDir: 'asc' };
  await msg({ type: 'saveView', view: VIEW });
  await msg({ type: 'prefs:set', name: 'print', value: { urls: false, split: false, qr: true } });
  await msg({ type: 'prefs:set', name: 'emoji', value: ['\u{1F680}', '\u{1F4DA}'] });
  await ev(`(()=>{ localStorage.setItem('cmr.printOpts', JSON.stringify({urls:false,split:false,qr:true})); localStorage.setItem('cmr.emojiRecent', JSON.stringify(['\u{1F680}','\u{1F4DA}'])); localStorage.setItem('cmr.exp', JSON.stringify({ [${JSON.stringify(G2)}]: 0 })); localStorage.setItem('cmr.isort', JSON.stringify({ [${JSON.stringify(G2)}]: ['title','desc'] })); })()`);
  await sleep(500);

  // ---- canonical dump of everything the file promises ----
  const DUMP = `(async()=>{
    const db = await import('./lib/db.js'); const { getSettings } = await import('./lib/settings.js'); const { DEFAULTS } = await import('./lib/constants.js');
    const gs = [...(await db.listGroups({ deleted: false })), ...(await db.listGroups({ deleted: true }))].sort((a,b)=>a.id<b.id?-1:1);
    const groups = [];
    for (const g of gs) { const items = []; for (let after = 0;;) { const p = await db.getItemsPage(g.id, after, 500); if (!p.length) break; for (const r of p) items.push({ url: r.url, title: r.title, w: r.w||0, ws: !!r.ws, tg: r.tg === undefined ? -1 : r.tg, sv: r.sv === undefined ? -1 : r.sv }); after = p[p.length-1].seq; if (p.length < 500) break; }
      groups.push({ id: g.id, title: g.title, createdAt: g.createdAt, starred: !!g.starred, locked: !!g.locked, pinned: !!g.pinned, pending: !!g.pending, archived: !!g.archived, note: g.note||'', cat: g.cat||null, color: g.color||null, emoji: g.emoji||null, windowCount: g.windowCount||1, tabGroups: g.tabGroups||[], deleted: g.deletedAt != null, items }); }
    const cats = (await db.listCategories()).map((c)=>({ id: c.id, name: c.name, color: c.color })).sort((a,b)=>a.id<b.id?-1:1);
    const tr = (await db.listTrash()).items.map((r)=>({ g: r.g, reason: r.delReason||'deleted', urls: r.items.map((x)=>x.url) })).sort((a,b)=>(a.g+a.urls.join())<(b.g+b.urls.join())?-1:1);
    const st = await getSettings(); const settings = {}; for (const k of Object.keys(DEFAULTS)) settings[k] = st[k];
    const sv = await chrome.storage.local.get(['view','prefs']);
    const ls = (k) => { try { return JSON.parse(localStorage.getItem(k)||'null'); } catch { return null; } };
    return JSON.stringify({ groups, cats, trash: tr, settings, view: sv.view||null, print: ls('cmr.printOpts'), emoji: ls('cmr.emojiRecent'), exp: ls('cmr.exp'), isort: ls('cmr.isort'), mirror: sv.prefs||null });
  })()`;
  const dump = () => ev(DUMP).then(JSON.parse);
  const before = await dump();
  check('seed: 4 sets (one deleted), 2 categories, 1 trash row, settings + view + prefs present', before.groups.length === 4 && before.groups.some((g) => g.deleted) && before.cats.length === 2 && before.trash.length === 1 && before.settings.theme === 'dark' && before.view && before.view.sort === 'title' && before.print && before.print.qr === true && before.exp, JSON.stringify({ g: before.groups.length, c: before.cats.length, t: before.trash.length }));
  check('seed: the page mirror copy of print options / emoji is in chrome.storage.local (what sync and the file read)', before.mirror && before.mirror.print && before.mirror.print.qr === true && before.mirror.emoji.length === 2, JSON.stringify(before.mirror));

  // ---- export (capture the blob instead of a download) ----
  await ev(`(()=>{ window.__blob = null; URL.createObjectURL = (b) => { window.__blob = b; return 'blob:test'; }; HTMLAnchorElement.prototype.click = function () {}; })()`);
  await ev(`document.querySelector('[data-act="exportNdjson"]').click()`);
  check('export: a file was produced', await until(() => ev(`!!window.__blob`)));
  const text = await ev(`window.__blob.text()`);
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const types = lines.map((l) => l.type);
  check('export: format 3 header, settings, prefs, categories, groups, items, trash, end marker', lines[0].type === 'header' && lines[0].version === 3 && types.includes('settings') && types.includes('prefs') && types.filter((t) => t === 'category').length === 2 && types.filter((t) => t === 'group').length === 4 && types.filter((t) => t === 'item').length >= 8 && types.includes('trash') && types[types.length - 1] === 'end', JSON.stringify(types.slice(0, 6)));
  check('export: no sync configuration, lock data or permission state anywhere in the file', !/passphrase|syncFlag|"lock"|wrappedDEK|vaultId|sync-folder|"cfg"/i.test(text.replace(/"locked"/g, '')));

  // ---- wipe everything ----
  await ev(`document.querySelectorAll('input.switch').length`); // (page is alive)
  await msg({ type: 'setFlag', groupId: G4, flag: 'locked', value: false });
  for (const g of [G1, G2, G3, G4]) await msg({ type: 'deleteGroup', groupId: g });
  await msg({ type: 'emptyTrash' });
  for (const c of [work.id, later.id]) await msg({ type: 'catDelete', id: c });
  await msg({ type: 'saveSettings', patch: { theme: 'light', suspendAfterMin: 20, whitelist: [], excludeSites: [], density: 'comfortable', autoRulesOn: false, autoRulesText: '', shortcutsOn: true, snapshotMinutes: 3, accent: 'blue', closeDuplicates: 'off' } });
  await msg({ type: 'saveView', view: {} });
  await msg({ type: 'prefs:set', name: 'print', value: {} });
  await msg({ type: 'prefs:set', name: 'emoji', value: [] });
  await ev(`localStorage.clear()`);
  await sleep(600);
  const wiped = await dump();
  check('wipe: no sets, no categories, no trash, settings back to defaults', wiped.groups.length === 0 && wiped.cats.length === 0 && wiped.trash.length === 0 && wiped.settings.theme === 'light' && wiped.exp === null, JSON.stringify({ g: wiped.groups.length, c: wiped.cats.length, t: wiped.trash.length }));

  // ---- import the file back (text path = the same importLines as the file picker) ----
  const importText = async (t, { settings = true } = {}) => {
    await ev(`(()=>{ document.getElementById('impSettings').checked = ${settings}; document.getElementById('importStatus').textContent = ''; document.getElementById('importText').value = ${JSON.stringify(t)}; document.querySelector('[data-act="importText"]').click(); })()`);
    await until(() => ev(`document.getElementById('importStatus').textContent.length > 0`), 20000);
    await sleep(800);
    return ev(`document.getElementById('importStatus').textContent`);
  };
  const st1 = await importText(text);
  await sleep(1000);
  const after = await dump();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('round trip: tab sets (ids, titles, flags, notes, colours, emoji, categories, tab-group definitions, windows, split pairs, deleted state) identical', same(after.groups, before.groups), same(after.groups, before.groups) ? '' : JSON.stringify(after.groups).slice(0, 600));
  check('round trip: categories identical (ids, names, colours)', same(after.cats, before.cats), JSON.stringify(after.cats));
  check('round trip: the recoverable trash row came back', same(after.trash, before.trash), JSON.stringify(after.trash));
  check('round trip: every setting (including site rules and device-specific ones) restored', same(after.settings, before.settings), JSON.stringify(Object.keys(before.settings).filter((k) => !same(before.settings[k], after.settings[k]))));
  check('round trip: saved view, print options, recent emoji, expanded state, per-set sort', same(after.view, before.view) && same(after.print, before.print) && same(after.emoji, before.emoji) && same(after.exp, before.exp) && same(after.isort, before.isort), JSON.stringify({ v: after.view, p: after.print, e: after.emoji, x: after.exp, i: after.isort }));
  check('round trip: status line reports categories / trash / settings', /categor|หมวด/i.test(st1) && /trash|ถังขยะ/i.test(st1), st1);

  // ---- merge: importing the same file again, with an extra local tab, adds nothing twice and removes nothing ----
  const extra = await mkSet('Local only', [{ url: 'https://local.example.test/keep', title: 'keep me' }]);
  await msg({ type: 'setFlag', groupId: G4, flag: 'locked', value: false });
  await msg({ type: 'renameGroup', groupId: G1, title: 'Alpha (renamed here)' });
  await msg({ type: 'renameGroup', groupId: G4, title: 'Delta' });
  await msg({ type: 'setFlag', groupId: G4, flag: 'locked', value: true });
  const mid = await dump();
  const st2 = await importText(text, { settings: false });
  await sleep(800);
  const merged = await dump();
  const strip = (d) => ({ ...d, groups: d.groups.filter((g) => g.id !== extra) });
  check('merge: the same file twice duplicates no set, tab, category or trash row', merged.groups.length === mid.groups.length && same(merged.cats, mid.cats) && same(merged.trash, mid.trash) && same(merged.groups.map((g) => g.items.length), mid.groups.map((g) => g.items.length)), st2);
  check('merge: nothing existing was lost or replaced (local set, local rename kept)', merged.groups.some((g) => g.id === extra && g.items.length === 1) && merged.groups.find((g) => g.id === G1).title === 'Alpha (renamed here)' && same(strip(merged).groups, strip(mid).groups), '');
  // a tab that exists only in the file is added to the existing set
  const one = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const g1line = one.find((l) => l.type === 'group' && l.id === G1);
  const mergeFile = [JSON.stringify({ type: 'header', format: 'cmr', version: 3 }), JSON.stringify(g1line), JSON.stringify({ type: 'item', g: G1, url: 'https://a.example.test/NEW', title: 'only in the file', ts: 1 }), JSON.stringify({ type: 'item', g: G1, url: 'https://a.example.test/1', title: 'dup', ts: 1 })].join('\n');
  await importText(mergeFile, { settings: false });
  await sleep(800);
  const merged2 = await dump();
  const m1 = merged2.groups.find((g) => g.id === G1);
  check('merge: a tab only the file has is added to the existing set once; the tab it already has is not duplicated', m1.items.length === mid.groups.find((g) => g.id === G1).items.length + 1 && m1.items.filter((i) => i.url.endsWith('/NEW')).length === 1 && m1.items.filter((i) => i.url.endsWith('/a.example.test/1') || i.url === 'https://a.example.test/1').length === 1, String(m1.items.length));

  // ---- older formats still import ----
  const v2 = [JSON.stringify({ type: 'header', format: 'cmr', version: 2, exportedAt: 'x' }), JSON.stringify({ type: 'group', id: 'oldg1', title: 'From v2', createdAt: 1700000000000, starred: true, locked: false, source: 'import', ord: 0, windowCount: 1, deletedAt: null }), JSON.stringify({ type: 'item', g: 'oldg1', url: 'https://v2.example.test/1', title: 'v2 tab', ts: 1 })].join('\n');
  await importText(v2, { settings: false });
  const v1 = JSON.stringify({ app: 'clean-my-ram', schema: 1, exportedAt: 'x', groups: [{ title: 'From v1', starred: false, locked: false, items: [{ url: 'https://v1.example.test/1', title: 'v1 tab', ts: 1 }] }] });
  await importText(v1, { settings: false });
  const old = await dump();
  check('older backups: format 2 (ndjson) and format 1 (json) still import as tab sets', old.groups.some((g) => g.title === 'From v2' && g.starred && g.items.length === 1) && old.groups.some((g) => g.title === 'From v1' && g.items.length === 1));

  // ---- untrusted input ----
  const bad = [JSON.stringify({ type: 'header', format: 'cmr', version: 3 }),
    JSON.stringify({ type: 'settings', v: 4, values: { theme: '<script>x</script>', suspendAfterMin: -5, language: 'xx', snapshotMinutes: 7, accent: 'neon', whitelist: 'notalist', __proto__: { polluted: 1 }, constructor: 1, sec: { evil: 1 }, syncFlag: true, evilKey: 'x' } }),
    JSON.stringify({ type: 'prefs', view: { sort: 'nope', groupBy: 5 }, print: { urls: 'maybe', qr: 'yes', rm: 1 }, emoji: ['<b>', 'a b', 1, '\u{1F600}'], exp: { 'bad key!': 0, ok1: 0 }, isort: { ok1: ['title', 'sideways'], ok2: ['title', 'asc'] } }),
    JSON.stringify({ type: 'category', id: '../../x', name: 'evil' }), JSON.stringify({ type: 'category', id: 'catok1', name: 'x'.repeat(500), color: 'plaid' }),
    JSON.stringify({ type: 'group', id: 'bad id with spaces', title: 'T'.repeat(5000), starred: 'yes', pinned: 1, note: 'n'.repeat(10000), color: 99, emoji: '<img>', windowCount: 1e9, cat: 'nonexistent' }),
    JSON.stringify({ type: 'item', url: 'javascript:alert(1)', title: 'xss' }), JSON.stringify({ type: 'item', url: 'https://ok.example.test/x', title: 't'.repeat(5000), ts: 'soon' }),
    JSON.stringify({ type: 'trash', g: 'nogroup', items: [{ url: 'file:///etc/passwd' }, { url: 'javascript:1' }, { url: 'https://ok.example.test/t' }] }),
    '{"type":"group","x":"' + 'y'.repeat(4.5 * 1024 * 1024) + '"}', 'not json at all', '[1,2,3]'].join('\n');
  const beforeBad = await dump();
  await importText(bad, { settings: true });
  await sleep(800);
  const afterBad = await dump();
  const nb = afterBad.groups.find((g) => g.items.some((i) => i.url === 'https://ok.example.test/x'));
  check('untrusted: unknown / invalid settings values are dropped by the settings sanitiser (theme, language, accent, injected keys)', afterBad.settings.theme === beforeBad.settings.theme && afterBad.settings.language === beforeBad.settings.language && afterBad.settings.accent === beforeBad.settings.accent && afterBad.settings.snapshotMinutes === beforeBad.settings.snapshotMinutes && afterBad.settings.suspendAfterMin >= 0 && Array.isArray(afterBad.settings.whitelist), JSON.stringify({ t: afterBad.settings.theme, s: afterBad.settings.suspendAfterMin }));
  check('untrusted: prefs are cleaned (bad view -> valid, bad emoji dropped, bad ids dropped, bad sort direction dropped)', afterBad.view && afterBad.view.sort === 'created' && JSON.stringify(afterBad.emoji) === JSON.stringify(['\u{1F600}']) && !('bad key!' in (afterBad.exp || {})) && afterBad.exp.ok1 === 0 && afterBad.isort.ok2 && !afterBad.isort.ok1, JSON.stringify({ v: afterBad.view, e: afterBad.emoji, x: afterBad.exp, i: afterBad.isort }));
  check('untrusted: only the safe tab was imported (javascript: / file: links dropped, title capped, no id injection), the 4.5 MB line and garbage were skipped', !!nb && nb.title.length <= 500 && nb.items.every((i) => /^https?:/.test(i.url) && i.title.length <= 1024) && !afterBad.groups.some((g) => g.items.some((i) => /^(javascript|file):/.test(i.url))) && afterBad.groups.every((g) => /^[A-Za-z0-9_-]{1,40}$/.test(g.id)) && !afterBad.cats.some((c) => c.name === 'evil'), nb ? nb.title.length + '/' + nb.id : 'no set');
  check('untrusted: nothing that existed before the hostile file was lost', beforeBad.groups.every((g) => afterBad.groups.some((x) => x.id === g.id && x.items.length >= g.items.length)));
  const pol = await ev(`({}).polluted === undefined && Object.prototype.polluted === undefined`);
  check('untrusted: no prototype pollution', pol === true);

  const errs = await ev(`(window.__errs||[]).length`);
  console.log('page errors recorded: ' + errs);
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e));
  failures++;
}
cleanup();
console.log(failures ? `\nbackup-roundtrip: ${failures} FAILED` : '\nbackup-roundtrip: all passed');
process.exit(failures ? 1 : 0);
