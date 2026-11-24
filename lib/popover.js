// ONE popover manager for every menu / popover of the page.
//
// Rules (they are what the regression test in tests/ui/popover-regression.mjs checks):
//  - at most one popover is open; opening another closes the current one first;
//  - closes on: outside pointerdown (capture phase: works over the virtual list, sticky headers, everything), Esc (focus returns to the
//    trigger), a second click on the trigger (toggle), scroll of anything outside the popover, window blur / resize, an explicit close()
//    (route change) and when another popover opens;
//  - rendered in the browser TOP LAYER (Popover API, popover="manual"), so the list's `contain`/`transform` rows can never trap or
//    cover it and there is no z-index war; no overlay element is needed (the optional `scrim` is only a dimmer for the phone sheet
//    and is hidden whenever nothing is open => no invisible click-blockers);
//  - viewport-aware placement (below the trigger, flipped above when there is more room, shifted inside the edges); a bottom sheet on phones.

const NARROW = '(max-width: 767px)';

export function createPopovers({ scrim = null, onClose = null } = {}) {
  let cur = null; // {el, trigger, onClose}
  let listening = false;

  const isTop = (el) => { try { return el.matches(':popover-open'); } catch { return false; } };

  // Anchor for a popover whose trigger is missing, detached or hidden (keyboard / palette / virtualised row that was re-rendered):
  // the last pointer position when it is fresh (< 4 s), else the upper third of the viewport. Never the top-left corner.
  let lastPt = null;
  if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { lastPt = { x: e.clientX, y: e.clientY, t: performance.now() }; }, true);
  function anchorRect(trigger) {
    if (trigger && trigger.isConnected && trigger.getBoundingClientRect) {
      const r = trigger.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r;
    }
    const p = lastPt && performance.now() - lastPt.t < 4000 ? lastPt : { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) };
    return { left: p.x, right: p.x, top: p.y, bottom: p.y, width: 0, height: 0 };
  }
  function place(el, trigger, at) {
    const narrow = window.matchMedia(NARROW).matches;
    el.classList.toggle('sheet', narrow);
    if (scrim) scrim.hidden = !narrow;
    if (narrow) { el.style.top = ''; el.style.left = ''; el.style.maxHeight = ''; return; }
    el.style.maxHeight = '';
    el.style.top = '0px';
    el.style.left = '0px';
    const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 } : anchorRect(trigger); // opts.at = a context menu opening at the pointer
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.scrollHeight + 2;
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    let top;
    let maxH;
    if (below >= Math.min(h, 360) || below >= above) { top = r.bottom + 6; maxH = below; } else { maxH = above; top = Math.max(8, r.top - 6 - Math.min(h, maxH)); }
    el.style.maxHeight = Math.max(160, maxH) + 'px';
    el.style.top = top + 'px';
    let left = at ? (at.x + w > vw - 8 ? at.x - w : at.x) : r.right - w;
    if (left < 8) left = r.left;
    el.style.left = Math.max(8, Math.min(vw - w - 8, left)) + 'px';
  }

  function focusFirst(el) {
    const t = el.querySelector('[data-autofocus]') || el.querySelector('input[type="text"]') || el.querySelector('[aria-checked="true"]') || el.querySelector('[role^="menuitem"]:not([aria-disabled="true"])');
    if (t) t.focus({ preventScroll: true });
  }

  // ----- global listeners (installed only while something is open) -----
  const onPointerDown = (e) => {
    if (!cur) return;
    const t = e.target;
    if (cur.el.contains(t)) return; // inside the popover
    if (cur.trigger && cur.trigger.contains(t)) return; // the trigger's own click toggles (see open())
    close({ restoreFocus: false });
  };
  const onKeyDown = (e) => {
    if (!cur || e.key !== 'Escape') return;
    if (cur.el._escape && cur.el._escape()) { e.preventDefault(); e.stopPropagation(); return; } // a submenu closes first
    e.preventDefault();
    e.stopPropagation();
    close({ restoreFocus: true });
  };
  let quietUntil = 0; // programmatic re-layout of the list (a sort choice made inside the menu) must not close the menu
  const onScroll = (e) => {
    if (!cur || performance.now() < quietUntil) return;
    if (e.target && e.target.nodeType === 1 && cur.el.contains(e.target)) return; // scrolling inside the popover itself
    close({ restoreFocus: false });
  };
  const onWindow = () => { if (cur) close({ restoreFocus: false }); };

  function listen(on) {
    if (on === listening) return;
    listening = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointerdown', onPointerDown, true);
    document[f]('keydown', onKeyDown, true);
    document[f]('scroll', onScroll, true);
    window[f]('blur', onWindow);
    window[f]('resize', onWindow);
  }

  /**
   * Opens `el` for `trigger`. Opening the same popover from the same trigger again TOGGLES it closed (returns false) unless
   * opts.keep is set (used when the content is rebuilt in place). Returns true when the popover is open afterwards.
   */
  function open(el, trigger, opts = {}) {
    if (cur && cur.el === el && cur.trigger === trigger) {
      if (opts.keep) { place(el, trigger, cur.at); return true; }
      close({ restoreFocus: false });
      return false;
    }
    if (cur) close({ restoreFocus: false });
    cur = { el, trigger, at: opts.at || null, onClose: opts.onClose || null };
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    el.hidden = false;
    try { if (!isTop(el)) el.showPopover(); } catch { /* already open / unsupported: still visible through [hidden] */ }
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    place(el, trigger, cur.at);
    listen(true);
    if (opts.focus !== false) focusFirst(el);
    return true;
  }

  function close({ restoreFocus = false } = {}) {
    if (!cur) { if (scrim) scrim.hidden = true; return; }
    const { el, trigger, onClose: cb } = cur;
    cur = null;
    listen(false);
    try { if (isTop(el)) el.hidePopover(); } catch { /* ignore */ }
    el.hidden = true;
    if (scrim) scrim.hidden = true;
    if (trigger) { trigger.removeAttribute('aria-expanded'); if (restoreFocus && trigger.focus && document.contains(trigger)) trigger.focus({ preventScroll: true }); }
    if (cb) { try { cb(); } catch { /* ignore */ } }
    if (onClose) { try { onClose(el); } catch { /* ignore */ } }
  }

  return {
    open,
    close,
    quiet(ms = 400) { quietUntil = performance.now() + ms; },
    reposition() { if (cur) place(cur.el, cur.trigger, cur.at); },
    isOpen: (el) => !!cur && (!el || cur.el === el),
    get current() { return cur; },
    focusFirst,
  };
}
