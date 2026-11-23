// Seeded randomized convergence tests: random ops on 2-3 devices with faults, compaction, restarts.
import { test, assert, eq } from './t.mjs';
import { setupDevices, quiesce, round, mulberry32, oracle } from './harness.mjs';
import { parseNodeUrl } from '../../lib/sync/codec.js';

const PW = 'property test pass phrase';
export const RUNS = Number(process.env.SYNC_RUNS || 500);

export async function runSeed(seed) {
  const r = mulberry32(seed * 7919 + 13);
  const nDev = 2 + Math.floor(r() * 2);
  const s = await setupDevices(nDev, {
    seed,
    opts: { limits: { maxTailChunks: 3, minTailBytes: 0, burst: 1e9, writesPerMin: 1e9, perDay: 1e12 }, partSize: r() < 0.3 ? 2048 : undefined },
  });
  const { clock, devs, tree, allOps } = s;
  globalThis.__lastRun = { devs, allOps, tree };
  const [A] = devs;
  await A.engine.enable(PW);
  for (let i = 1; i < nDev; i++) { devs[i].view.deliver(); await devs[i].engine.join(PW); }
  let nextId = 1;
  const purgedG = new Set(), purgedI = new Set();
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const steps = 50 + Math.floor(r() * 50);
  for (let step = 0; step < steps; step++) {
    const d = pick(devs);
    const x = r();
    await clock.advance(Math.floor(r() * 3000));
    const groups = [...d.store.groups.keys()];
    const items = [...d.store.items.keys()];
    if (x < 0.10 || !groups.length) { const g = 'g' + nextId++; await d.addGroup(g, { title: 'G' + g, windowCount: 1 + Math.floor(r() * 3) }); }
    else if (x < 0.38) {
      const g = pick(groups); const iid = 'i' + nextId++;
      const noise = r() < 0.05 ? 'x'.repeat(3000 + Math.floor(r() * 4000)) : '';
      await d.addItem(iid, g, { url: 'https://h' + Math.floor(r() * 30) + '.test/' + iid + noise, title: 'T ' + iid + (r() < 0.2 ? ' ทดสอบ' : ''), tg: r() < 0.3 ? Math.floor(r() * 3) : undefined });
    } else if (x < 0.52) {
      const g = pick(groups);
      const f = pick([{ title: 'R' + Math.floor(r() * 99) }, { starred: r() < 0.5 }, { locked: r() < 0.5 }, { ord: r() * 1000 }, { del: r() < 0.5 ? d.engine.status().lastSync + 1 + Math.floor(r() * 100) : null }, { tabGroups: [{ i: 0, title: 'x' + Math.floor(r() * 9), color: 'red' }] }]);
      await d.setGroup(g, f);
    } else if (x < 0.57 && items.length) { await d.setItem(pick(items), { title: 'E' + Math.floor(r() * 999) }); }
    else if (x < 0.62 && items.length && groups.length) { await d.setItem(pick(items), { g: pick(groups) }); }
    else if (x < 0.65 && items.length) { const iid = pick(items); purgedI.add(iid); await d.purge('i', iid); }
    else if (x < 0.66 && groups.length) { const g = pick(groups); purgedG.add(g); await d.purge('g', g); }
    else if (x < 0.78) { try { await d.engine.push(); } catch { /* ignore */ } }
    else if (x < 0.90) {
      d.view.deliver({ shuffle: r() < 0.6, dup: r() < 0.3 ? 0.4 : 0, dropEvent: r() < 0.2 ? 0.3 : 0, limit: r() < 0.4 ? 1 + Math.floor(r() * 8) : undefined, rng: r,
        filter: r() < 0.25 ? ((e) => { const p = e.node && e.node.url && parseNodeUrl(e.node.url); return !(p && p.kind === 'c' && p.part > 1); }) : undefined });
    } else if (x < 0.96) { await d.engine.pullLoop(); }
    else if (x < 0.985) { await d.engine.check(); }
    else { await d.restart(); }
  }
  // faults off, converge
  await quiesce(devs, clock, { maxRounds: 80 });
  const dumps = devs.map((d) => d.store.dump());
  for (let i = 1; i < dumps.length; i++) eq(dumps[i], dumps[0], `seed ${seed}: device ${i} diverged`);
  const orc = await oracle(allOps);
  eq(dumps[0], orc.dump(), `seed ${seed}: state differs from oracle replay of all ops`);
  // purge stays purged on every device
  for (const d of devs) {
    for (const g of purgedG) assert(!d.store.groups.has(g), `seed ${seed}: purged group ${g} resurrected on ${d.id}`);
    for (const i of purgedI) assert(!d.store.items.has(i), `seed ${seed}: purged item ${i} resurrected on ${d.id}`);
  }
  // budgets: every node url within part size; chunk node count sane
  for (const n of tree.nodes.values()) if (n.url && n.url.startsWith('https://cmr.invalid/')) assert(n.url.length <= 6144 + 80, `seed ${seed}: oversized node ${n.url.length}`);
  // idempotency: forget cursors on one device, re-read everything -> identical state
  const d0 = devs[devs.length - 1];
  const before = d0.store.dump();
  d0.engine._P().cursor = {};
  for (const id of d0.engine._S.devFolderOf.keys()) if (id !== d0.id) d0.engine._S.dirty.add(id);
  await d0.engine.pullLoop();
  eq(d0.store.dump(), before, `seed ${seed}: re-applying everything changed state`);
  return { ops: allOps.length, items: JSON.parse(dumps[0]).i.length };
}

test(`property: ${RUNS} seeded runs converge to the oracle (faults, compaction, restarts, purges)`, async () => {
  let totalOps = 0, restarts = 0;
  const t0 = Date.now();
  for (let seed = 1; seed <= RUNS; seed++) {
    try { const res = await runSeed(seed); totalOps += res.ops; } catch (e) { e.message = `[seed ${seed}] ` + e.message; throw e; }
  }
  void restarts;
  console.log(`    ${RUNS} runs, ${totalOps} ops total, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}, { slow: true });
