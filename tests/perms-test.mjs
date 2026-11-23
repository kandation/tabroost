// Optional-permission guards, pure Node with a fake `chrome`:   node tests/perms-test.mjs
// Covers lib/perms.js (contains / request / remove / onAdded payloads), the sweep (never sleeps a tab it cannot check; reports
// 'noHostAccess'), the probe when executeScript is refused, chrome.sessions / chrome.bookmarks missing, and that nothing is deleted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

// ---- fake chrome ----------------------------------------------------------------------------------------------------------
function makeChrome({ granted = [], origins = [], tabs = [] } = {}) {
  const calls = { discard: [], exec: 0, requests: [], removes: [] };
  const store = { settings: { autoSuspend: true, suspendAfterMin: 1, whitelist: '' } };
  const sess = {};
  const g = new Set(granted); const o = new Set(origins);
  const api = {
    calls, granted: g, origins: o,
    storage: {
      local: { get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries((Array.isArray(k) ? k : Object.keys(k || {})).map((x) => [x, store[x]]))), set: async (v) => { Object.assign(store, v); } },
      session: { get: async (k) => (typeof k === 'string' ? { [k]: sess[k] } : {}), set: async (v) => { Object.assign(sess, v); } },
      onChanged: { addListener() {} },
    },
    permissions: {
      contains: async (p) => (p.permissions || []).every((x) => g.has(x)) && (p.origins || []).every((x) => o.has(x)),
      request: async (p) => { calls.requests.push(p); return !!api._allow; },
      remove: async (p) => { calls.removes.push(p); (p.permissions || []).forEach((x) => g.delete(x)); (p.origins || []).forEach((x) => o.delete(x)); return true; },
      onAdded: { addListener() {} }, onRemoved: { addListener() {} },
    },
    tabs: {
      query: async () => tabs,
      discard: async (id) => { calls.discard.push(id); return { id }; },
    },
    system: { memory: { getInfo: async () => ({ capacity: 100, availableCapacity: 90 }) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, get: async () => null },
    runtime: { getURL: (p) => p, sendMessage: async () => {} },
    _allow: true,
  };
  api.scripting = { executeScript: async () => { calls.exec++; return [{ result: { b: false, m: 0 } }]; } };
  return api;
}

const P = await imp('lib/perms.js');

// ---- 1. perms.js -----------------------------------------------------------------------------------------------------------
{
  const c = makeChrome();
  check('host / bookmarks / sessions start as not granted', JSON.stringify(await P.snapshot(c)) === '{"host":false,"bookmarks":false,"sessions":false}');
  c._allow = false;
  check('request denied -> false, nothing granted', (await P.request('bookmarks', c)) === false && !(await P.has('bookmarks', c)));
  c._allow = true; c.granted.add('bookmarks'); c.origins.add('<all_urls>');
  check('after grant: has(bookmarks) and hasHost are true', (await P.has('bookmarks', c)) && (await P.hasHost(c)));
  check('remove() takes it back', (await P.remove('bookmarks', c)) && !(await P.has('bookmarks', c)));
  check('request sends the right shape', (await P.request('host', c)) && JSON.stringify(c.calls.requests[c.calls.requests.length - 1]) === '{"origins":["<all_urls>"]}');
  check('unknown name never throws and is false', (await P.has('nope', c)) === false && (await P.request('nope', c)) === false);
  check('missing chrome.permissions reads as not granted', (await P.has('host', {})) === false && (await P.request('host', {})) === false);
  const thrower = { permissions: { contains: async () => { throw new Error('x'); }, request: () => { throw new Error('y'); } } };
  check('contains / request that throw read as false', (await P.has('sessions', thrower)) === false && (await P.request('sessions', thrower)) === false);
  check('namesIn: onAdded / onRemoved payloads', JSON.stringify(P.namesIn({ permissions: ['bookmarks'], origins: ['<all_urls>'] })) === '["bookmarks","host"]' && P.namesIn({ permissions: ['tabs'] }).length === 0 && P.namesIn(null).length === 0);
  check('bookmarksApi / sessionsApi are null when the API is missing', P.bookmarksApi({}) === null && P.sessionsApi({ sessions: {} }) === null && P.sessionsApi({ sessions: { getRecentlyClosed() {} } }) !== null);
  check('isAccessError recognises the Chrome messages', P.isAccessError(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')) && !P.isAccessError(new Error('boom')));
}

// ---- 2. sweep with the host permission missing ----------------------------------------------------------------------------
const tab = (id) => ({ id, url: 'https://example.com/' + id, title: 't' + id, active: false, pinned: false, audible: false, discarded: false, status: 'complete', lastAccessed: Date.now() - 3600e3, windowId: 1 });
{
  const c = makeChrome({ tabs: [tab(1), tab(2)] });
  globalThis.chrome = c;
  const S = await imp('lib/suspend.js');
  const r = await S.sweep(0);
  check('sweep without host access reports noHostAccess', r && r.skipped === 'noHostAccess', JSON.stringify(r));
  check('sweep without host access discards nothing and does not even probe', c.calls.discard.length === 0 && c.calls.exec === 0);
  const stat = (await c.storage.session.get('sweepStat')).sweepStat;
  check('status note is stored for the UI', stat && stat.reason === 'noHostAccess');

  // probe refused page by page (restricted page / partial grant): every tab counts as unchecked, so it stays awake
  c.origins.add('<all_urls>');
  c.scripting.executeScript = async () => { c.calls.exec++; throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'); };
  const p = await S.runProbe(1);
  check('probe with executeScript refused -> ok:false', p.ok === false && p.b === true);
  check('isBusy treats an unchecked tab as busy (duplicates are not closed)', (await S.isBusy(1)) === true);
  check('probeProtect says "probe" (do not sleep)', (await S.probeProtect(1, { mediaProtect: true }, Date.now(), {})) === 'probe');
  const r2 = await S.sweep(0).catch((e) => ({ err: String(e) }));
  check('sweep with access but every probe refused sleeps nothing', c.calls.discard.length === 0, JSON.stringify(r2));

  // granted path: a clean tab IS slept (auto-sleep works exactly as before)
  c.scripting.executeScript = async () => { c.calls.exec++; return [{ result: { b: false, m: 0 } }]; };
  const r3 = await S.sweep(0).catch((e) => ({ err: String(e) }));
  check('granted + probe clean: tab is discarded as before', c.calls.discard.length >= 1, JSON.stringify(r3));
  c.calls.discard.length = 0;
  c.scripting.executeScript = async () => [{ result: { b: true, m: 0 } }];
  await S.sweep(0).catch(() => {});
  check('granted + unsaved form: tab is not discarded', c.calls.discard.length === 0);
}

// ---- 3. recently closed without the sessions permission -------------------------------------------------------------------
{
  const c = makeChrome(); globalThis.chrome = c;
  const SN = await imp('lib/snapshot.js');
  const list = await SN.recentlyClosed(10);
  check('recentlyClosed with chrome.sessions undefined -> [] (no throw)', Array.isArray(list) && list.length === 0);
  c.sessions = { getRecentlyClosed: async () => [{ lastModified: 1, tab: { sessionId: 's1', url: 'https://a.test/', title: 'A' } }] };
  const list2 = await SN.recentlyClosed(10);
  check('with the permission the list is returned as before', list2.length === 1 && list2[0].sid === 's1');
}

// ---- 4. static checks: no data loss in the guard code, manifest + locales ---------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, 'lib/perms.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'lib/permsui.js'), 'utf8');
  check('perms code touches no database / storage clear / delete API', !/deleteDatabase|storage\.local\.clear|indexedDB/.test(src.replace(/\/\/.*$/gm, '')));
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  check('manifest: bookmarks + sessions optional, no required host access', !m.permissions.includes('bookmarks') && !m.permissions.includes('sessions') && !m.host_permissions && m.optional_permissions.includes('bookmarks') && m.optional_permissions.includes('sessions') && m.optional_host_permissions.includes('<all_urls>'));
  check('manifest: scripting stays required (it fails safely without host access)', m.permissions.includes('scripting'));
  const loc = ['en', 'th'].map((l) => JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', l, 'messages.json'), 'utf8')));
  const used = (JSON.stringify(m).match(/__MSG_[A-Za-z0-9_]+__/g) || []).map((s) => s.slice(6, -2));
  check('every __MSG_ in the manifest exists in en and th', used.length >= 8 && used.every((k) => loc.every((d) => d[k] && d[k].message)), used.filter((k) => !loc.every((d) => d[k])).join(','));
  check('descriptions are at most 132 characters', loc.every((d) => d.extDesc.message.length <= 132));
  check('default_locale is en', m.default_locale === 'en');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nperms-test: all passed');
process.exit(failures ? 1 : 0);
