// node tests/sync/run.mjs [filter]   (env SYNC_RUNS=N to change the property-run count)
import { registry } from './t.mjs';
import './crypto-tests.mjs';
import './scenarios.mjs';
import './property.mjs';
import './lock-sync.mjs';

const filter = process.argv[2];
let pass = 0, fail = 0;
const failures = [];
for (const t of registry) {
  if (filter && !t.name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    await t.fn();
    pass++;
    console.log(`  ok   ${t.name} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    failures.push([t.name, e]);
    console.log(`  FAIL ${t.name}\n       ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
