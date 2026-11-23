// Gentle, memory-aware bulk tab closing for tabs that need no drain record (duplicates, data-less internal pages).

import { DRAIN_LEVELS } from './constants.js';
import { freeRatio, levelIndexFor } from './mem.js';

/** Closes tabs in chunks sized by free RAM (same table as the drain). Returns how many were closed. */
export async function closeTabsGently(ids) {
  const list = [...ids];
  let closed = 0;
  for (let i = 0; i < list.length;) {
    const L = DRAIN_LEVELS[levelIndexFor(await freeRatio())];
    const part = list.slice(i, i + L.remove);
    i += part.length;
    try {
      await chrome.tabs.remove(part);
      closed += part.length;
    } catch {
      for (const id of part) {
        try { await chrome.tabs.remove(id); closed++; } catch { /* already gone */ }
      }
    }
    if (i < list.length) await new Promise((r) => setTimeout(r, L.delay));
  }
  return closed;
}
