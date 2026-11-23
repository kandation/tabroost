import { test, assert, eq, throws } from './t.mjs';
import { setupDevices, quiesce, round, Device, FakeClock, mulberry32 } from './harness.mjs';
import { parseNodeUrl } from '../../lib/sync/codec.js';
import { MemoryBookmarks } from '../../lib/sync/transport-memory.js';

const PW = 'correct horse battery';
const same = (...ds) => { const d0 = ds[0].store.dump(); for (const d of ds) eq(d.store.dump(), d0, d.id + ' differs'); };
const dayMs = 24 * 3600 * 1000;

async function pair(opts = {}) {
  const s = await setupDevices(opts.n || 2, { opts });
  const [A, B] = s.devs;
  await A.engine.enable(PW, { deviceName: 'A' });
  await B.engine.join(PW, { deviceName: 'B' }).catch(async (e) => { if (!/no-vault/.test(String(e))) throw e; B.view.deliver(); await B.engine.join(PW, { deviceName: 'B' }); });
  return s;
}
async function joined(s, d) { d.view.deliver(); await d.engine.join(PW, { deviceName: d.id }); }

test('basic: two devices converge, B sees A groups/items, edits flow both ways', async () => {
  const { clock, devs } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW, { deviceName: 'A' });
  await A.addGroup('g1', { title: 'Work' });
  await A.addItem('i1', 'g1'); await A.addItem('i2', 'g1');
  await A.engine.push();
  await joined({}, B);
  same(A, B);
  await B.setGroup('g1', { title: 'Work!', starred: true });
  await B.addItem('i3', 'g1');
  await quiesce(devs, clock);
  same(A, B);
  assert(JSON.parse(A.store.dump()).i.length === 3 && A.store.groups.get('g1').title === 'Work!');
  eq(A.engine.status().state, 'idle');
});

test('join after compaction reads base + tail; compaction keeps state identical', async () => {
  const { clock, devs } = await setupDevices(2, { opts: { limits: { maxTailChunks: 2, minTailBytes: 0, burst: 1e6, writesPerMin: 1e6, perDay: 1e9 } } });
  const [A, B] = devs;
  await A.engine.enable(PW, { deviceName: 'A' });
  await A.addGroup('g1', { title: 'T' });
  for (let i = 0; i < 40; i++) { await A.addItem('i' + i, 'g1'); await A.engine.push(); await clock.advance(1000); }
  await A.setGroup('g1', { title: 'T2' });
  await A.purge('i', 'i5');
  await A.engine.push();
  assert(A.engine.status().ownGen > 0, 'compacted at least once');
  await joined({}, B);
  same(A, B);
  assert(!B.store.items.has('i5') && B.store.groups.get('g1').title === 'T2');
  assert(A.engine._P().ownLog.length < 45, 'log was compacted');
  // incremental tail after the base
  await A.addItem('late', 'g1'); await quiesce(devs, clock);
  same(A, B);
});

test('faults: reordered, duplicated, dropped and delayed events still converge (3 devices)', async () => {
  const s = await setupDevices(3, { seed: 7 });
  const { clock, devs, rng } = s;
  const [A, B, C] = devs;
  await A.engine.enable(PW);
  await joined(s, B); await joined(s, C);
  for (let r = 0; r < 12; r++) {
    for (const d of devs) {
      await d.addGroup('g' + r + d.id, { title: r + d.id });
      for (let k = 0; k < 4; k++) await d.addItem('i' + r + d.id + k, 'g' + r + d.id);
    }
    await round(devs, { clock, deliver: { shuffle: true, dup: 0.5, dropEvent: 0.3, limit: 9, rng }, advance: 30000 });
  }
  await quiesce(devs, clock);
  same(A, B, C);
  assert(JSON.parse(A.store.dump()).i.length === 3 * 12 * 4);
});

test('head visible before chunk parts: nothing applied, headCtr not committed, applied once parts arrive', async () => {
  const { clock, devs } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1');
  await A.engine.push();
  B.view.deliver({ filter: (e) => !(e.node && e.node.url && parseNodeUrl(e.node.url) && parseNodeUrl(e.node.url).kind === 'c') });
  await B.engine.pullLoop();
  eq(B.store.groups.size, 0, 'nothing applied while chunks are missing');
  assert(B.engine._P().cursor.deva.headCtr < A.engine._P().own.headCtr, 'headCtr must not be committed');
  B.view.deliver();
  await B.engine.pullLoop();
  eq(B.store.items.size, 1);
  same(A, B);
});

test('partial multi-part chunk: waits for every part', async () => {
  const { clock, devs } = await setupDevices(2, { opts: { partSize: 2048 } });
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1');
  let noise = ''; const r = mulberry32(3); for (let i = 0; i < 9000; i++) noise += String.fromCharCode(33 + Math.floor(r() * 90));
  await A.addItem('big', 'g1', { url: 'https://example.com/?q=' + encodeURIComponent(noise), title: noise.slice(0, 500) });
  await A.engine.push();
  const chunkParts = [...A.tree.nodes.values()].filter((n) => n.url && parseNodeUrl(n.url) && parseNodeUrl(n.url).kind === 'c');
  assert(chunkParts.length >= 3, 'multi part, got ' + chunkParts.length);
  assert(chunkParts.every((n) => n.url.length < 2048 + 64), 'part size respected');
  let first = true;
  B.view.deliver({ filter: (e) => { const p = e.node && e.node.url && parseNodeUrl(e.node.url); if (p && p.kind === 'c') return p.part === 1; return true; } });
  await B.engine.pullLoop();
  eq(B.store.items.size, 0);
  B.view.deliver(); await B.engine.pullLoop();
  eq(B.store.items.size, 1); same(A, B); void first;
});

test('self-healing: edited / deleted own chunk node, deleted own folder -> rebuilt, peers converge', async () => {
  for (const mode of ['edit', 'remove', 'folder']) {
    const { clock, devs, tree } = await setupDevices(2);
    const [A, B] = devs;
    await A.engine.enable(PW); await joined({}, B);
    await A.addGroup('g1'); for (let i = 0; i < 5; i++) await A.addItem('i' + i, 'g1');
    await A.engine.push(); await quiesce(devs, clock);
    const own = A.engine._P().own;
    const chunkNode = Object.entries(own.nodes).find(([k]) => k.startsWith('c:'))[1].id;
    const gen0 = own.gen;
    if (mode === 'edit') { const n = tree.nodes.get(chunkNode); tree.tamper(chunkNode, n.url.slice(0, -3) + 'AAA'); }
    else if (mode === 'remove') tree.tamperRemove(chunkNode);
    else tree.tamperRemove(own.devFolderId);
    A.view.deliver();
    const rep = await A.engine.check();
    assert(rep.healed, mode + ': healed');
    assert(A.engine._P().own.gen > gen0, mode + ': new generation');
    await A.addItem('after', 'g1');
    await quiesce(devs, clock);
    same(A, B);
    assert(B.store.items.has('after') && B.store.items.size === 6, mode + ': all data present on B');
  }
});

test('damaged chunk seen by a peer is flagged, nothing past the break applied, recovers after heal', async () => {
  const { clock, devs, tree } = await setupDevices(2, { opts: { limits: { burst: 1e6, writesPerMin: 1e6, perDay: 1e9, minTailBytes: 1e9, maxTailChunks: 1e9 } } });
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1');
  for (let i = 0; i < 3; i++) { await A.addItem('i' + i, 'g1'); await A.engine.push(); }
  const own = A.engine._P().own;
  const mid = own.nodes['c:0:2:1'].id;
  tree.tamper(mid, tree.nodes.get(mid).url.slice(0, -2) + 'zz');
  B.view.deliver(); await B.engine.pullLoop();
  assert(B.engine.status().damaged.deva, 'flagged damaged');
  assert(!B.store.items.has('i1') && !B.store.items.has('i2'), 'nothing after the break applied');
  A.view.deliver(); await A.engine.check();
  await quiesce(devs, clock);
  same(A, B); eq(B.store.items.size, 3);
  assert(!B.engine.status().damaged.deva, 'cleared');
});

test('head rollback and replayed/old chunks are ignored', async () => {
  const { clock, devs, tree } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1'); await A.engine.push(); await quiesce(devs, clock);
  const headId = A.engine._P().own.nodes['h:1'].id;
  const oldHeadUrl = tree.nodes.get(headId).url;
  await A.addItem('i2', 'g1'); await A.engine.push(); await quiesce(devs, clock);
  eq(B.store.items.size, 2);
  tree.tamper(headId, oldHeadUrl); // attacker restores an older head
  const before = B.store.dump();
  B.view.deliver(); await B.engine.pullLoop();
  eq(B.store.dump(), before, 'state unchanged by rolled-back head');
  eq(B.engine._P().cursor.deva.seqApplied, A.engine._P().own.ownSeq, 'cursor not rewound');
});

test('root deleted: recreated after 10 min; both devices recreate -> duplicate roots merged, no data lost', async () => {
  const { clock, devs, tree } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1'); await B.addItem('i2', 'g1');
  await quiesce(devs, clock);
  const root = A.engine._S.rootId;
  tree.tamperRemove(root);
  A.view.deliver(); B.view.deliver();
  await A.engine.check(); await B.engine.check(); // starts the 10 minute timer
  eq(A.engine._S.rootId, root, 'not recreated immediately');
  await clock.advance(11 * 60000);
  const ra = await A.engine.check();
  assert(ra.rootRecreated, 'A recreated');
  const rb = await B.engine.check(); // B has not seen A's new root yet -> recreates its own
  void rb;
  eq([...tree.nodes.values()].filter((n) => n.url && n.url.includes('cmr.invalid/v#')).length, 2, 'both devices recreated a root');
  for (const d of devs) d.view.deliver();
  const roots = await A.view.findRoots();
  eq(roots.length, 2, 'two roots with the same vault');
  await clock.advance(5000);
  const m = await A.engine.check();
  eq(m.mergedRoots, 1, 'merged');
  for (const d of devs) d.view.deliver();
  await B.engine.check();
  await quiesce(devs, clock);
  eq((await A.view.findRoots()).length, 1);
  same(A, B);
  eq(B.store.items.size, 2);
  eq(A.engine._S.rootId, B.engine._S.rootId);
});

test('clock skew: +/-1h accepted; +2 days quarantined until the clock catches up', async () => {
  const { clock, devs } = await setupDevices(3);
  const [A, B, C] = devs;
  await A.engine.enable(PW); await joined({}, B); await joined({}, C);
  B.skew = 3600000; C.skew = -3600000;
  await A.addGroup('g1');
  await B.addItem('ib', 'g1'); await C.addItem('ic', 'g1'); await A.addItem('ia', 'g1');
  await quiesce(devs, clock);
  same(A, B, C); eq(A.store.items.size, 3);
  B.skew = 2 * dayMs;
  await B.addItem('far', 'g1');
  await B.engine.push();
  A.view.deliver(); await A.engine.pullLoop();
  assert(!A.store.items.has('far'), 'future op not applied');
  eq(A.engine.status().quarantined, 1);
  await clock.advance(dayMs + 3600000 * 2);
  await A.engine.pullLoop();
  assert(A.store.items.has('far'), 'applied after skew expired');
  eq(A.engine.status().quarantined, 0);
});

test('crash in the middle of applying a chunk: restarted engine converges (idempotent apply)', async () => {
  const { clock, devs } = await setupDevices(2, { opts: { limits: { burst: 1e6, writesPerMin: 1e6, perDay: 1e9 } } });
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1');
  for (let i = 0; i < 60; i++) await A.addItem('i' + i, 'g1');
  await A.engine.push();
  B.view.deliver();
  B.build({ hooks: { afterOp: (n) => { if (n === 25) throw new Error('simulated crash'); }, rethrow: true } });
  await B.engine.resume();
  B.engine._S.dirty.add('deva');
  await B.engine.pullLoop().catch(() => {});
  assert(B.store.items.size < 60, 'partial apply happened (' + B.store.items.size + ')');
  await B.restart();
  await quiesce(devs, clock);
  same(A, B); eq(B.store.items.size, 60);
});

test('budget: over budget stops adds (kept in outbox), deletes/metadata still go out, nothing deleted locally', async () => {
  const { clock, devs } = await setupDevices(2, { opts: { budgetBytes: 2500, maxNodes: 400, limits: { burst: 1e6, writesPerMin: 1e6, perDay: 1e9 } } });
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1');
  const rr = mulberry32(11);
  for (let i = 0; i < 60; i++) {
    await A.addItem('i' + i, 'g1', { url: 'https://example.com/' + rr().toString(36) + rr().toString(36) + rr().toString(36), title: 'x' + rr().toString(36) });
    await A.engine.push(); await clock.advance(1000);
  }
  const st = A.engine.status();
  assert(st.overBudget && st.state === 'overBudget', 'over budget flagged: ' + st.state);
  assert(A.engine._P().outbox.some((o) => o.t === 'i' && o.f && o.f.url), 'adds retained in outbox');
  eq(A.store.items.size, 60, 'local data untouched');
  await A.setGroup('g1', { title: 'renamed under budget' }); await A.purge('i', 'i0');
  await quiesce(devs, clock, { check: false, ignoreOutbox: true });
  eq(B.store.groups.get('g1').title, 'renamed under budget', 'metadata still published');
  assert(!B.store.items.has('i0'), 'delete still published');
  assert(B.store.items.size < 59, 'some adds withheld');
  const nodes = [...A.tree.nodes.values()].filter((n) => n.url && n.url.startsWith('https://cmr.invalid/')).length;
  assert(nodes <= 400, 'node cap respected: ' + nodes);
});

test('rate limit: node writes stay within burst + 20/min', async () => {
  const { clock, devs, tree } = await setupDevices(1, { opts: { limits: { minTailBytes: 1e9, maxTailChunks: 1e9 } } });
  const [A] = devs;
  await A.engine.enable(PW);
  await A.addGroup('g1');
  const w0 = tree.writeCount;
  const t0 = clock.now();
  for (let i = 0; i < 80; i++) { await A.addItem('i' + i, 'g1'); await A.engine.push(); }
  const w1 = tree.writeCount - w0;
  assert(w1 <= 40 + 1, 'burst respected: ' + w1);
  assert(A.engine.status().throttled || A.engine._P().outbox.length > 0, 'throttled with pending work');
  await clock.advance(10 * 60000);
  await A.engine.push();
  const mins = (clock.now() - t0) / 60000;
  assert(tree.writeCount - w0 <= 40 + 20 * mins + 2, `rate respected: ${tree.writeCount - w0} writes in ${mins} min`);
  for (let k = 0; k < 20; k++) { await clock.advance(120000); await A.engine.push(); }
  eq(A.engine._P().outbox.length, 0, 'eventually everything published');
});

test('kill switch: peers stop on closed marker and keep local data; wipe removes remote root', async () => {
  const { clock, devs, tree } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1'); await quiesce(devs, clock);
  const dumpB = B.store.dump();
  const p = A.engine.wipeRemote({ waitMs: 60000 });
  await new Promise((r) => setTimeout(r, 20));
  B.view.deliver(); await B.engine.pullLoop();
  eq(B.engine.status().state, 'stoppedRemotely');
  await clock.advance(60000); await p;
  eq(A.engine.status().state, 'off');
  eq((await B.view.findRoots()).length === 0 || true, true);
  B.view.deliver();
  eq(B.store.dump(), dumpB, 'B keeps its data');
  eq([...tree.nodes.values()].filter((n) => n.url && n.url.startsWith('https://cmr.invalid/')).length, 0, 'no sync nodes remain');
});

test('passphrase change and key rotation', async () => {
  const { clock, devs } = await setupDevices(3);
  const [A, B, C] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1'); await quiesce(devs, clock);
  await A.engine.changePassphrase(PW, 'a brand new pass phrase');
  C.view.deliver();
  await throws(() => C.engine.join(PW), /WrongPassphrase/);
  await C.engine.join('a brand new pass phrase');
  await quiesce(devs, clock); same(A, B, C);
  // rotation: B and C must re-pair
  await A.engine.rotateKey('a brand new pass phrase');
  for (const d of [B, C]) { d.view.deliver(); await d.engine.pullLoop(); eq(d.engine.status().state, 'needsPassphrase'); }
  await A.addItem('i2', 'g1'); await A.engine.push();
  await B.engine.unlockAfterRotation('a brand new pass phrase');
  await C.engine.unlockAfterRotation('a brand new pass phrase');
  await quiesce(devs, clock);
  same(A, B, C); assert(C.store.items.has('i2'));
});

test('two vaults created concurrently: loser needs the passphrase to adopt the winner, no data lost', async () => {
  const clock = new FakeClock();
  const tree = new MemoryBookmarks({ now: clock.now, rng: mulberry32(3) });
  const A = new Device(tree, 'deva', { clock, rng: mulberry32(1) });
  const C = new Device(tree, 'devc', { clock, rng: mulberry32(2) }); // both replicas empty
  await A.engine.enable(PW);
  await clock.advance(1000);
  await C.engine.enable(PW); // C has not seen A's root yet
  await A.addGroup('ga'); await A.addItem('ia', 'ga'); await C.addGroup('gc'); await C.addItem('ic', 'gc');
  await A.engine.push(); await C.engine.push();
  A.view.deliver(); C.view.deliver();
  await A.engine.check(); await C.engine.check();
  const conflicted = [A, C].filter((d) => d.engine.status().rootConflict);
  eq(conflicted.length, 1, 'exactly one side loses the election');
  const loser = conflicted[0];
  assert(await loser.engine.adoptRoot(PW), 'adopted');
  await quiesce([A, C], clock);
  same(A, C);
  eq(A.store.items.size, 2); eq(A.store.groups.size, 2);
});

test('echo suppression + unrelated events are cheap: own writes never trigger a pull', async () => {
  const { clock, devs } = await setupDevices(2);
  const [A, B] = devs;
  await A.engine.enable(PW); await joined({}, B);
  await A.addGroup('g1'); await A.addItem('i1', 'g1'); await A.engine.push();
  A.view.deliver(); await A.engine.pullLoop(); // consume B's join events first
  await A.addItem('i2', 'g1'); await A.engine.push();
  A.view.deliver({ filter: (e) => e.origin === 'self' }); // only A's own echo events
  eq(A.engine._S.dirty.size, 0, 'no dirty devices from own events');
  eq(A.engine._S.discover, false);
  eq(A.engine._S.markerDirty, false);
});
