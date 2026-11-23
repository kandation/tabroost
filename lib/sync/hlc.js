// Hybrid logical clock. An HLC value is a fixed-width string so plain string
// comparison orders values: base36(wallMs, 9) + base36(counter, 4).
export const MAX_FUTURE_MS = 24 * 3600 * 1000;

export function formatHlc(wall, counter) {
  return wall.toString(36).padStart(9, '0') + counter.toString(36).padStart(4, '0');
}

export function parseHlc(h) {
  return { wall: parseInt(h.slice(0, 9), 36), counter: parseInt(h.slice(9), 36) };
}

export function compareHlc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Field version key: HLC plus device id as a tie-break. */
export const fieldKey = (h, dev) => h + '|' + dev;

/** True if the op's wall clock is more than `maxFuture` ahead of `nowMs`. */
export function isFuture(h, nowMs, maxFuture = MAX_FUTURE_MS) {
  return parseHlc(h).wall > nowMs + maxFuture;
}

export class Hlc {
  /** @param {() => number} nowFn wall clock in ms; @param {string} [initial] persisted last value */
  constructor(nowFn, initial) {
    this.nowFn = nowFn;
    const p = initial ? parseHlc(initial) : { wall: 0, counter: 0 };
    this.wall = p.wall;
    this.counter = p.counter;
  }
  /** Next value for a local event. */
  tick() {
    const now = this.nowFn();
    if (now > this.wall) { this.wall = now; this.counter = 0; } else { this.counter++; }
    return formatHlc(this.wall, this.counter);
  }
  /** Observe a remote value (call only for accepted, non-future ops). */
  observe(h) {
    const r = parseHlc(h);
    const now = this.nowFn();
    const w = Math.max(this.wall, r.wall, now);
    if (w === this.wall && w === r.wall) this.counter = Math.max(this.counter, r.counter) + 1;
    else if (w === this.wall) this.counter++;
    else if (w === r.wall) this.counter = r.counter + 1;
    else this.counter = 0;
    this.wall = w;
    return formatHlc(this.wall, this.counter);
  }
  last() { return formatHlc(this.wall, this.counter); }
}
