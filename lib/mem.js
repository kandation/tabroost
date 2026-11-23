// Free-RAM ratio and level mapping (shared by drain and restore).

import { DRAIN_LEVELS } from './constants.js';

let stub = null;
/** Test hook: a number (ratio) or null. */
export function setMemStub(v) { stub = v == null ? null : v; }

/** availableCapacity / capacity, or null when unknown. */
export async function freeRatio() {
  if (stub != null) return stub;
  try {
    const m = await chrome.system.memory.getInfo();
    return m.capacity > 0 ? m.availableCapacity / m.capacity : null;
  } catch {
    return null;
  }
}

/** Index into DRAIN_LEVELS. Unknown ratio is treated as "low". */
export function levelIndexFor(ratio) {
  if (ratio == null) return 1;
  for (let i = 0; i < DRAIN_LEVELS.length; i++) if (ratio >= DRAIN_LEVELS[i].min) return i;
  return DRAIN_LEVELS.length - 1;
}
