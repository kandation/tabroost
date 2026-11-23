// Pure policy logic: brute-force lockout and auto-lock decisions (spec §2 "Auto-lock", §4 "Brute-force delay").
// No chrome.*, no clocks: every function takes `now` so it is table-testable. The SW persists the state object in
// storage.local.lockFail and binds chrome.alarms / chrome.idle to these functions.

export const FREE_FAILURES = 3;
export const MAX_DELAY_MS = 15 * 60 * 1000;

/** Delay after the n-th consecutive failure: none for n <= 3, then 2^(n-3) seconds, capped at 15 min. */
export function lockoutDelayMs(n) {
  if (!(n > FREE_FAILURES)) return 0;
  const exp = Math.min(n - FREE_FAILURES, 30); // avoid float blow-up; cap reached long before
  return Math.min(2 ** exp * 1000, MAX_DELAY_MS);
}

export const initialFailState = () => ({ n: 0, until: 0 });

/** Sanitize persisted state. A clock set backwards must not lock the user out for more than the max delay. */
export function normalizeFail(state, now) {
  const n = Number.isInteger(state && state.n) && state.n > 0 ? state.n : 0;
  let until = Number.isFinite(state && state.until) ? state.until : 0;
  if (until > now + MAX_DELAY_MS) until = now + MAX_DELAY_MS;
  return { n, until };
}

/** The SW refuses `unlock` before `until`. waitMs drives the UI countdown. */
export function canAttempt(state, now) {
  const s = normalizeFail(state, now);
  return s.until > now ? { allowed: false, waitMs: s.until - now } : { allowed: true, waitMs: 0 };
}

/**
 * Record a failed password / wrong-key attempt. Typos caught by the recovery-key checksum
 * (RecoveryFormatError.countsAsFailure === false) must NOT be passed here.
 * Failures made while locked out never happen (the attempt is refused first), so n only grows on real tries.
 */
export function onFailure(state, now) {
  const s = normalizeFail(state, now);
  const n = s.n + 1;
  const d = lockoutDelayMs(n);
  return { n, until: d ? now + d : 0 };
}
/** A successful unlock (password OR recovery key) clears the counter. Disable / reset-erase also clear it. */
export const onSuccess = () => initialFailState();

// ---------- auto-lock ----------
export const IDLE_CHOICES = [5, 15, 30, 60, 'browser']; // 'browser' = only when the browser closes (session storage dies)
export const DEFAULT_IDLE_MIN = 15;
export const TOUCH_THROTTLE_MS = 60 * 1000;

/** Pages send lock.touch at most once a minute. */
export const shouldSendTouch = (lastSentAt, now) => !lastSentAt || now - lastSentAt >= TOUCH_THROTTLE_MS;

/**
 * One decision function for every trigger:
 *   { unlocked, now, lastTouch, idleMin (number | 'browser' | null), osLocked, pageClosed,
 *     onScreenLock (default true), onPageClose (default false) }
 * -> { lock: boolean, reason: null | 'idle' | 'os-lock' | 'page-close' | 'clock' }
 * Fail-safe: a lastTouch far in the future (clock changed) locks instead of staying open forever.
 */
export function decideLock(i) {
  const none = { lock: false, reason: null };
  if (!i.unlocked) return none;
  if (i.osLocked && i.onScreenLock !== false) return { lock: true, reason: 'os-lock' };
  if (i.pageClosed && i.onPageClose === true) return { lock: true, reason: 'page-close' };
  if (typeof i.idleMin === 'number' && i.idleMin > 0) {
    if (!Number.isFinite(i.lastTouch) || i.lastTouch > i.now + 2 * TOUCH_THROTTLE_MS) return { lock: true, reason: 'clock' };
    if (i.now - i.lastTouch >= i.idleMin * 60 * 1000) return { lock: true, reason: 'idle' };
  }
  return none;
}
