// gzip helpers shared by the service worker (writes snapshots) and the list page (reads them).

export async function gzipJson(obj) {
  const blob = new Blob([JSON.stringify(obj)]);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Multiset diff of a snapshot's tabs against the urls open right now: returns the snapshot tabs that are NOT open. */
export function diffTabs(snapTabs, openUrls) {
  const counts = new Map();
  for (const u of openUrls) counts.set(u, (counts.get(u) || 0) + 1);
  const missing = [];
  for (const t of snapTabs) {
    const c = counts.get(t.url) || 0;
    if (c > 0) counts.set(t.url, c - 1); else missing.push(t);
  }
  return missing;
}

export async function gunzipJson(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// ---------- tiered retention + degraded detection (pure; unit-tested in tests/snapshot-test.mjs) ----------
export const HOUR = 3600000;
export const DAY = 86400000;
export const KEEP_RECENT = 5; // newest good auto snapshots, always kept
export const KEEP_HOURLY_MS = 24 * HOUR; // + the fullest one per hour for 24 h
export const KEEP_DAILY_MS = 7 * DAY; // + the fullest one per day for 7 days
export const KEEP_DEGRADED = 3; // newest degraded ones (stored, but never counted against / evicting good ones)
export const DEGRADE_RATIO = 0.5;
export const DEGRADE_DROP = 5;

/** A snapshot is "degraded" when it has far fewer tabs than the best recent one (a crash / partial session restore). */
export function isDegraded(tabCount, recent) {
  let best = 0;
  for (const s of recent) if (s.tabCount > best) best = s.tabCount;
  return tabCount < best * DEGRADE_RATIO && best - tabCount > DEGRADE_DROP;
}

/**
 * list = metadata of the AUTO snapshots ({id, ts, tabCount, degraded?}). Returns the ids to delete.
 * Keep: newest 5 good + fullest good per hour (24 h) + fullest good per day (7 d) + newest 3 degraded (24 h).
 * Total <= 5 + 24 + 7 + 3 = 39 (and in practice far fewer because identical tab sets are not re-written).
 */
export function planAutoTrim(list, now = Date.now()) {
  const keep = new Set();
  const sorted = [...list].sort((a, b) => b.ts - a.ts);
  const good = sorted.filter((s) => !s.degraded);
  good.slice(0, KEEP_RECENT).forEach((s) => keep.add(s.id));
  const hour = new Map();
  const day = new Map();
  for (const s of good) {
    const age = now - s.ts;
    const tier = age <= KEEP_HOURLY_MS ? hour : age <= KEEP_DAILY_MS ? day : null;
    if (!tier) continue;
    const k = Math.floor(s.ts / (tier === hour ? HOUR : DAY));
    const cur = tier.get(k);
    if (!cur || s.tabCount > cur.tabCount) tier.set(k, s); // sorted newest first => ties keep the newest
  }
  for (const s of hour.values()) keep.add(s.id);
  for (const s of day.values()) keep.add(s.id);
  sorted.filter((s) => s.degraded && now - s.ts <= KEEP_HOURLY_MS).slice(0, KEEP_DEGRADED).forEach((s) => keep.add(s.id));
  return sorted.filter((s) => !keep.has(s.id)).map((s) => s.id);
}

/**
 * Banner candidates: snapshots (not pre-close) of the last 24 h that were taken AFTER the last deliberate close / stash and are not
 * dismissed. Returns [newest, fullest] (unique) so a crash followed by a partial session restore still offers the missing tabs.
 */
export function bannerCandidates(list, { now = Date.now(), lastStashAt = 0, lastCleanClose = 0, snapAck = '' } = {}) {
  const floor = Math.max(lastStashAt || 0, lastCleanClose || 0, now - DAY);
  const c = list.filter((s) => s.kind !== 'pre-close' && s.ts > floor && !(snapAck && s.id <= snapAck)).sort((a, b) => b.ts - a.ts);
  if (!c.length) return [];
  let full = c[0];
  for (const s of c) if (s.tabCount > full.tabCount) full = s;
  return full === c[0] ? [c[0]] : [c[0], full];
}
