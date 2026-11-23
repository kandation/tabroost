// Unit tests: tiered snapshot retention, degraded detection and banner candidate choice (crash sequences with fake snapshot sets).
import { planAutoTrim, isDegraded, bannerCandidates, HOUR, DAY } from '../lib/snapfmt.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
let n = 0;
const mk = (ageMs, tabCount, extra = {}) => ({ id: 's' + String(NOW - ageMs).padStart(15, '0') + (n++), ts: NOW - ageMs, tabCount, kind: 'auto', ...extra });

// 1. steady state: a snapshot every 3 min for 10 days => bounded and tiered
{
  let list = [];
  for (let t = 10 * DAY; t >= 0; t -= 3 * 60000) {
    const s = mk(t, 100 + Math.floor(t / DAY));
    list.push(s);
    const drop = new Set(planAutoTrim(list, s.ts));
    list = list.filter((x) => !drop.has(x.id));
  }
  ok(list.length <= 36, 'bounded total <= 36 got ' + list.length);
  ok(list.length >= 25, 'hourly+daily tiers are populated got ' + list.length);
  const newest5 = [...list].sort((a, b) => b.ts - a.ts).slice(0, 5);
  ok(newest5.every((s, i) => i === 0 || newest5[i - 1].ts - s.ts <= 3 * 60000 + 1), 'newest 5 are consecutive');
  ok(!list.some((s) => NOW - s.ts > 7 * DAY), 'nothing older than 7 days');
  const hours = new Set(list.filter((s) => NOW - s.ts <= DAY).map((s) => Math.floor(s.ts / HOUR)));
  ok(hours.size >= 23, 'one per hour for 24h got ' + hours.size);
}
// 2. crash: 300 tabs for hours, then 3 restarts with 4 tabs: degraded must not evict the fuller ones
{
  let list = [];
  for (let m = 240; m > 0; m -= 3) list.push(mk(m * 60000, 300));
  for (let i = 0; i < 12; i++) { // 12 degraded snapshots right after the crash
    const t = 3 * 60000 - i * 1000;
    const deg = isDegraded(4 + (i % 2), list.filter((s) => !s.degraded));
    ok(deg, 'degraded detected');
    list.push(mk(Math.max(0, t) , 4 + (i % 2), { degraded: true }));
    const drop = new Set(planAutoTrim(list, NOW - Math.max(0, t)));
    list = list.filter((x) => !drop.has(x.id));
  }
  const good = list.filter((s) => !s.degraded);
  ok(good.length >= 5 && good.every((s) => s.tabCount === 300), 'fuller snapshots survive: ' + good.length);
  ok(list.filter((s) => s.degraded).length <= 3, 'degraded bounded to 3');
  ok(Math.max(...list.map((s) => s.tabCount)) === 300, 'best one kept');
}
// 3. degraded rule edges
ok(!isDegraded(100, [{ tabCount: 120 }]), 'small dip is fine');
ok(!isDegraded(3, [{ tabCount: 7 }]), 'drop <= 5 is not degraded');
ok(isDegraded(10, [{ tabCount: 100 }]), '10 of 100 degraded');
ok(!isDegraded(10, []), 'no history -> not degraded');
// 4. banner candidates: newest degraded + fuller older one
{
  const full = mk(2 * HOUR, 200), deg = mk(60000, 5, { degraded: true }), pre = mk(30000, 300, { kind: 'pre-close' });
  const c = bannerCandidates([deg, full, pre], { now: NOW });
  ok(c.length === 2 && c[0].id === deg.id && c[1].id === full.id, 'newest + fullest, pre-close ignored');
  ok(bannerCandidates([deg, full], { now: NOW, lastStashAt: NOW - HOUR }).length === 1 && bannerCandidates([deg, full], { now: NOW, lastStashAt: NOW - HOUR })[0].id === deg.id, 'deliberate stash after fuller snapshot excludes it');
  ok(bannerCandidates([deg, full], { now: NOW, snapAck: deg.id }).length === 0, 'ack hides snapshots up to the acked id');
  ok(bannerCandidates([mk(25 * HOUR, 300)], { now: NOW }).length === 0, '>24h old is not offered');
}
console.log(fails ? `snapshot-test: ${fails} FAILED` : 'snapshot-test: all passed');
process.exit(fails ? 1 : 0);
