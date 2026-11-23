// Adaptive limits probe for a bookmarks transport: finds (a) the longest URL that is accepted AND read
// back unchanged, (b) title truncation, (c) listChildren timing at various node counts.
// A local probe result may only LOWER or confirm the default part size; the sync ceiling stays at the
// conservative default until a peer confirms it (head.probeOk), see engine.js.
import { DEFAULT_PART_SIZE, MIN_PART_SIZE, NODE_HOST } from './codec.js';

const PREFIX = NODE_HOST + 'p#';

async function roundTrips(transport, folderId, url, title) {
  let id = null;
  try {
    id = await transport.createNode(folderId, url, title);
    const kids = await transport.listChildren(folderId);
    const n = kids.find((k) => k.id === id);
    return { ok: !!n && n.url === url, title: n ? n.title : null };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    if (id) { try { await transport.removeNode(id); } catch { /* ignore */ } }
  }
}

export async function probeLimits(transport, opts = {}) {
  const maxUrl = opts.maxUrl ?? 2 * 1024 * 1024;
  const counts = opts.timingCounts ?? [500, 1500, 5000];
  const now = opts.now ?? (() => performance.now());
  const other = await transport.getOtherRootId();
  const folder = await transport.createFolder(other, 'cmr-probe');
  const result = { maxUrlLen: 0, firstFailLen: null, titleLen: {}, timings: {}, errors: [] };
  try {
    // 1) URL length: exponential then binary search (accepted + unchanged readback)
    const mk = (len) => PREFIX + 'A'.repeat(Math.max(0, len - PREFIX.length));
    let lo = 1024, hi = null;
    let r = await roundTrips(transport, folder, mk(lo));
    if (!r.ok) { result.firstFailLen = lo; result.errors.push(r.error || 'readback mismatch at 1KB'); } else {
      let len = lo;
      while (len < maxUrl) {
        const next = Math.min(maxUrl, len * 2);
        r = await roundTrips(transport, folder, mk(next));
        if (r.ok) { lo = next; len = next; } else { hi = next; result.firstFailLen = next; if (r.error) result.errors.push(r.error); break; }
      }
      if (hi !== null) {
        while (hi - lo > 1024) {
          const mid = Math.floor((lo + hi) / 2);
          r = await roundTrips(transport, folder, mk(mid));
          if (r.ok) lo = mid; else hi = mid;
        }
      }
      result.maxUrlLen = lo;
    }
    // 2) title truncation
    for (const tl of [255, 1024, 4096]) {
      const rr = await roundTrips(transport, folder, mk(2048), 'T'.repeat(tl));
      result.titleLen[tl] = rr.title === null ? null : rr.title.length;
    }
    // 3) listChildren timing at N nodes (small urls)
    let have = 0;
    for (const n of counts) {
      if (opts.skipTimings) break;
      for (; have < n; have++) await transport.createNode(folder, mk(64) + have);
      const t0 = now();
      const kids = await transport.listChildren(folder);
      result.timings[n] = { ms: Math.round((now() - t0) * 10) / 10, seen: kids.length };
    }
  } finally {
    try { await transport.removeTree(folder); } catch (e) { result.errors.push('cleanup: ' + e); }
  }
  // conservative: never raise above the default; never below the minimum
  result.recommendedPartSize = Math.max(MIN_PART_SIZE, Math.min(DEFAULT_PART_SIZE, Math.floor((result.maxUrlLen || 0) * 0.5)));
  if (!result.maxUrlLen) result.recommendedPartSize = MIN_PART_SIZE;
  return result;
}
