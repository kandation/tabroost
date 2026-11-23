// Minute ticker for the list page: ONE timer aligned to the minute (page side only, never in a service worker), paused while the page is hidden.
// It only touches the elements it is given (the rendered rows), and only sets textContent when the label really changed, so nothing re-renders
// and nothing shifts (the tokens use tabular numbers and a reserved min-width).

import { msToNextMinute } from './time.js';

export function startTicker(getEls, relabel, extra) {
  let timer = 0;
  function tick() {
    const now = Date.now();
    for (const el of getEls()) {
      const txt = relabel(el, now);
      if (txt != null && el.textContent !== txt) el.textContent = txt;
    }
    if (extra) { try { extra(now); } catch { /* ignore */ } }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; if (document.hidden) return; tick(); schedule(); }, msToNextMinute(Date.now()));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); schedule(); } });
  schedule();
  return { tick };
}
