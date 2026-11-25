// Sync protocol 2: categories (kind 'c'), the extra tab-set / tab fields, and preferences (kind 's') with the "sync settings too" toggle.
// Pure node (in-memory bookmark tree, MemStore): the same engine / merge code the extension runs.
import { test, assert, eq } from './t.mjs';
import { setupDevices, quiesce, round } from './harness.mjs';
import { SETTINGS_SYNC_EXCLUDE, SYNCABLE_SETTING_KEYS, collectFields, diffFields, toLocalPatch, isPrefField } from '../../lib/sync/prefs.js';
import { applyOp } from '../../lib/sync/merge.js';
import { sanitizeSettingsPatch } from '../../lib/settings.js';
import { DEFAULTS } from '../../lib/constants.js';
import { MemStore } from './harness.mjs';

const PW = 'correct horse battery';
const same = (...ds) => { const d0 = ds[0].store.dump(); for (const d of ds) eq(d.store.dump(), d0, d.id + ' differs'); };
const joined = async (d) => { d.view.deliver(); await d.engine.join(PW, { deviceName: d.id }); };
const syncable = (d) => Object.fromEntries(SYNCABLE_SETTING_KEYS.map((k) => [k, d.local.settings[k]]));

test('protocol 2: categories converge (create, rename on one device + recolour on another, delete wins over a concurrent edit)', async () => {
  const { clock, devs } = await setupDevices(3, { seed: 11 });
  const [A, B, C] = devs;
  await A.engine.enable(PW);
  await A.addGroup('g1', { title: 'G' });
  await A.addCat('c1', { name: 'Work', color: 'blue', ord: 0 });
  await A.addCat('c2', { name: 'Later', color: 'red', ord: 1 });
  await A.setGroup('g1', { cat: 'c1' });
  await A.engine.push();
  await joined(B); await joined(C);
  same(A, B, C);
  assert(B.store.cats.get('c1').name === 'Work' && B.store.groups.get('g1').cat === 'c1');
  await B.setCat('c1', { name: 'Work!' });
  await C.setCat('c1', { color: 'green' }); // another field of the same category: both survive
  await quiesce(devs, clock);
  same(A, B, C);
  eq(A.store.cats.get('c1').name, 'Work!'); eq(A.store.cats.get('c1').color, 'green');
  // delete on A races with an edit on B: the purge wins on every device, the other category stays
  await A.purge('c', 'c2');
  await B.setCat('c2', { name: 'Edited late' });
  await quiesce(devs, clock);
  same(A, B, C);
  assert(!A.store.cats.has('c2') && A.store.cats.has('c1'));
  assert(!C.store.cats.has('c2'));
});

test('protocol 2: tab-set fields pinned / archived / pending / note / colour / emoji / category and tab field ws merge per field', async () => {
  const { clock, devs } = await setupDevices(2, { seed: 12 });
  const [A, B] = devs;
  await A.engine.enable(PW);
  await A.addGroup('g1', { title: 'T', pinned: true, note: 'first', color: 3, emoji: '\u{1F680}' });
  await A.addItem('i1', 'g1', { w: 2, ws: true, sv: 1 });
  await A.engine.push();
  await joined(B);
  same(A, B);
  assert(B.store.groups.get('g1').pinned === true && B.store.groups.get('g1').emoji === '\u{1F680}' && B.store.items.get('i1').ws === true);
  // disjoint fields changed on both sides at the same time: nothing is lost
  await A.setGroup('g1', { archived: true, note: 'from A' });
  await B.setGroup('g1', { pending: true, color: 5, cat: 'c9' });
  await quiesce(devs, clock);
  same(A, B);
  const g = A.store.groups.get('g1');
  assert(g.archived && g.pending && g.pinned && g.color === 5 && g.note === 'from A' && g.cat === 'c9' && g.emoji === '\u{1F680}');
  // clearing a value travels too (colour back to none, window start removed)
  await B.setGroup('g1', { color: null, emoji: null, pinned: false });
  await B.setItem('i1', { ws: null });
  await quiesce(devs, clock);
  same(A, B);
  assert(A.store.groups.get('g1').color === null && A.store.groups.get('g1').pinned === false);
});

test('protocol 2: a kind or field an old peer does not know is skipped, not fatal (unknown kind, unknown or device-specific preference fields)', async () => {
  const { clock, devs } = await setupDevices(2, { seed: 13 });
  const [A, B] = devs;
  await A.engine.enable(PW);
  await joined(B);
  await A.engine.recordLocal([A.engine.stamp('z', 'whatever', { a: 1 })]); // a future kind
  await A.engine.recordLocal([A.engine.stamp('s', 'prefs', { 's:theme': 'dark', 'x:evil': 1, 's:lowMemRatio': 0.9, 's:__proto__': 'x', 'p:view': { sort: 'nope', evil: true } })]);
  await quiesce(devs, clock, { ignoreOutbox: true });
  eq(B.local.settings.theme, 'dark');
  eq(B.local.settings.lowMemRatio, DEFAULTS.lowMemRatio, 'device-specific key must not be applied');
  eq(B.local.view.sort, 'created', 'a view value is sanitised before it is stored');
  assert(!('evil' in B.local.view));
  // still alive: later changes keep flowing
  await A.changeSettings({ density: 'compact' });
  await quiesce(devs, clock);
  eq(B.local.settings.density, 'compact');
});

test('settings: per-key last-writer-wins, only syncable keys travel, a fresh device never overwrites with defaults', async () => {
  const { clock, devs } = await setupDevices(3, { seed: 14 });
  const [A, B, C] = devs;
  await A.engine.enable(PW);
  await A.changeSettings({ theme: 'dark', suspendAfterMin: 45, whitelist: ['example.com'], shortcutsOn: false, lowMemRatio: 0.5, activityTracking: false });
  await A.prefs.scan();
  await A.engine.push();
  await joined(B); await joined(C); // B and C start at the defaults and must not push them over A's values
  await quiesce(devs, clock);
  for (const d of [B, C]) {
    eq(d.local.settings.theme, 'dark'); eq(d.local.settings.suspendAfterMin, 45); eq(d.local.settings.whitelist, ['example.com']);
    // device-specific keys stayed where they were
    eq(d.local.settings.shortcutsOn, DEFAULTS.shortcutsOn); eq(d.local.settings.lowMemRatio, DEFAULTS.lowMemRatio); eq(d.local.settings.activityTracking, DEFAULTS.activityTracking);
  }
  eq(A.local.settings.theme, 'dark');
  // different keys changed on two devices at the same moment: both survive
  await B.changeSettings({ density: 'compact' });
  await C.changeSettings({ accent: 'teal' });
  await quiesce(devs, clock);
  for (const d of devs) { eq(d.local.settings.density, 'compact'); eq(d.local.settings.accent, 'teal'); eq(d.local.settings.theme, 'dark'); }
  // the same key: the later change wins on every device
  await clock.advance(5000);
  await A.changeSettings({ theme: 'light' });
  await clock.advance(5000);
  await C.changeSettings({ theme: 'time' });
  await quiesce(devs, clock);
  for (const d of devs) eq(d.local.settings.theme, 'time');
  eq(syncable(A), syncable(B)); eq(syncable(B), syncable(C));
});

test('settings: a received value never echoes back (no op queued, nothing written twice) and a restart changes nothing', async () => {
  const { clock, devs } = await setupDevices(2, { seed: 15 });
  const [A, B] = devs;
  await A.engine.enable(PW);
  await joined(B);
  await A.changeSettings({ theme: 'dark' });
  await quiesce(devs, clock);
  eq(B.local.settings.theme, 'dark');
  const writes = B.writes.length;
  assert(writes === 1, 'applied once, got ' + writes);
  // B's own scan after the apply finds nothing to send
  eq(await B.prefs.scan(), 0, 'no echo op');
  eq(B.engine._P().outbox.length, 0);
  const seqBefore = B.engine._P().own.ownSeq;
  await quiesce(devs, clock);
  eq(B.engine._P().own.ownSeq, seqBefore, 'nothing was published by B');
  eq(A.writes.length, 0, 'A never received its own value back');
  await B.restart();
  eq(await B.prefs.scan(), 0);
  await quiesce(devs, clock);
  eq(B.writes.length, writes);
});

test('settings toggle: OFF sends nothing and ignores incoming; ON later publishes this device and fills in from the others', async () => {
  const { clock, devs } = await setupDevices(2, { seed: 16 });
  const [A, B] = devs;
  await A.engine.enable(PW);
  await joined(B);
  await A.changeSettings({ theme: 'dark' });
  await quiesce(devs, clock);
  eq(B.local.settings.theme, 'dark');
  // B turns it OFF
  B.syncSettingsOn = false;
  await B.changeSettings({ density: 'compact' }); // a local change: must not be sent
  await A.changeSettings({ accent: 'pink' }); // an incoming change: must be ignored by B
  await quiesce(devs, clock);
  eq(B.local.settings.accent, DEFAULTS.accent, 'B ignored the incoming value');
  eq(A.local.settings.density, DEFAULTS.density, 'B sent nothing');
  eq(B.local.settings.density, 'compact', 'B keeps its own value');
  // tab data still flows with the toggle off
  await A.addGroup('g1', { title: 'Still syncs' });
  await quiesce(devs, clock);
  assert(B.store.groups.has('g1'));
  // B turns it ON: its value is published, the missed incoming value is read again
  await clock.advance(5000);
  B.syncSettingsOn = true;
  await B.prefs.enable();
  await quiesce(devs, clock);
  eq(A.local.settings.density, 'compact', 'B published its current value');
  eq(B.local.settings.accent, 'pink', 'B received what it had ignored');
  eq(syncable(A), syncable(B));
  // and the other direction keeps working
  await A.changeSettings({ theme: 'light' });
  await quiesce(devs, clock);
  eq(B.local.settings.theme, 'light');
});

test('settings: random edits on three devices (reordered / duplicated / dropped delivery) converge', async () => {
  const s = await setupDevices(3, { seed: 21 });
  const { clock, devs, rng } = s;
  const [A, B, C] = devs;
  await A.engine.enable(PW);
  await joined(B); await joined(C);
  const keys = [['theme', ['auto', 'light', 'dark', 'time']], ['density', ['comfortable', 'compact']], ['suspendAfterMin', [10, 20, 30, 60]], ['urlDisplay', ['none', 'domain', 'short', 'full']], ['accent', ['blue', 'teal', 'green', 'orange']], ['celebrate', [true, false]]];
  for (let r = 0; r < 40; r++) {
    const d = devs[Math.floor(rng() * 3)];
    const [k, vals] = keys[Math.floor(rng() * keys.length)];
    await d.changeSettings({ [k]: vals[Math.floor(rng() * vals.length)] });
    if (r % 5 === 0) await clock.advance(1500);
    if (r % 9 === 0) await round(devs, { clock, deliver: { shuffle: true, dup: 0.5, dropEvent: 0.3, limit: 9, rng }, advance: 2000 });
  }
  await quiesce(devs, clock);
  eq(syncable(A), syncable(B)); eq(syncable(B), syncable(C));
});

test('upgrade path: field versions an old build noted without applying the value are re-applied after dropping them and replaying', async () => {
  const { clock, devs } = await setupDevices(2, { seed: 17 });
  const [A, B] = devs;
  await A.engine.enable(PW);
  await A.addGroup('g1', { title: 'T' });
  await A.engine.push();
  await joined(B);
  await A.setGroup('g1', { pinned: true, note: 'hello' });
  await quiesce(devs, clock);
  same(A, B);
  // simulate B's OLD build: it noted the versions of pinned / note but never stored the values
  delete B.store.groups.get('g1').pinned; delete B.store.groups.get('g1').note;
  await B.engine.replay();
  assert(B.store.groups.get('g1').pinned === undefined, 'replay alone skips: the versions are already known');
  // the migration (lib/synccontrol.js migrateSchema) forgets those versions first
  const m = await B.store.getMeta('g', 'g1');
  delete m.fh.pinned; delete m.fh.note;
  await B.store.setMeta('g', 'g1', m);
  await B.engine.replay();
  await quiesce(devs, clock);
  same(A, B);
  assert(B.store.groups.get('g1').pinned === true && B.store.groups.get('g1').note === 'hello');
});

test('prefs helpers: collect / diff / patch are strict (excluded keys, defaults, hostile input)', async () => {
  // every excluded key really exists in DEFAULTS and is never a pref field
  for (const k of Object.keys(SETTINGS_SYNC_EXCLUDE)) { assert(k in DEFAULTS, k + ' missing from DEFAULTS'); assert(!isPrefField('s:' + k)); }
  for (const k of ['sec', 'exH', 'wlH', 'settingsVersion', 'syncFlag', 'cfg']) assert(!isPrefField('s:' + k), k + ' must not be syncable');
  const cur = collectFields({ settings: { ...DEFAULTS, theme: 'dark' } });
  eq(Object.keys(diffFields(null, cur)), ['s:theme'], 'only non-defaults are sent the first time');
  eq(diffFields({ ...cur }, cur), {}, 'nothing changed -> nothing sent');
  eq(Object.keys(diffFields({ 's:theme': 'dark' }, collectFields({ settings: { ...DEFAULTS, theme: 'dark', density: 'compact' } }))), ['s:density']);
  const p = toLocalPatch({ 's:theme': 'neon', 's:density': 'compact', 's:lowMemRatio': 0.9, 's:nope': 1, 'p:print': { urls: 'yes', qr: true, extra: 1 }, 'p:emoji': ['\u{1F680}', '<b>', 'a b', 5, '\u{1F680}'] }, sanitizeSettingsPatch);
  eq(p.settings, { density: 'compact' });
  eq(p.print, { urls: true, split: true, qr: true });
  eq(p.emoji, ['\u{1F680}']);
});

test('merge: the preferences entity ignores purges, other ids and malformed field names', async () => {
  const st = new MemStore();
  const seen = [];
  st.prefsHook = () => ({ apply: async (f) => { seen.push(Object.keys(f)); } });
  await applyOp(st, { h: '000000001000', t: 's', id: 'prefs', x: 1 }, 'devx');
  await applyOp(st, { h: '000000001001', t: 's', id: 'other', f: { 's:theme': 'dark' } }, 'devx');
  await applyOp(st, { h: '000000001002', t: 's', id: 'prefs', f: { 's:theme': 'dark', 'bad key': 1, 'q:x': 2 } }, 'devx');
  eq(seen, [['s:theme']]);
  eq(st.purgedIds(), []);
});
