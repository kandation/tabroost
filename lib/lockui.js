// Password lock UI shared by the list page and the popup: the lock gate + lock screen, the idle touch, and (via lockcard.js)
// the settings card. Built with createElement / textContent only (no innerHTML). With the lock OFF gate() costs one
// IndexedDB read and returns at once: no DOM, no listeners except the bus subscription.
import * as lockrt from './lockrt.js';
import * as bus from './bus.js';
import { getSettings } from './settings.js';
import { resolveLang, LOCK_EN } from './i18n.js';
import { LOCK_TH } from './lockstr.js';
import { shouldSendTouch } from './lock/policy.js';
import { eraseFlow } from './lockarchui.js';
import * as lockpk from './lockpk.js';

export const lang = { cur: 'th' };
export const strings = () => (lang.cur === 'en' ? { ...LOCK_TH, ...LOCK_EN } : LOCK_TH);

export const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || { ok: false, error: 'nosw' }); }); } catch { resolve({ ok: false, error: 'nosw' }); }
});

export const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

const fmtWait = (ms) => { const s = Math.max(1, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ICON = 'M7 10V7a5 5 0 0 1 10 0v3h1.5A1.5 1.5 0 0 1 20 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-8A1.5 1.5 0 0 1 5.5 10H7Zm2 0h6V7a3 3 0 0 0-6 0v3Zm3 3.5a1.75 1.75 0 0 0-.75 3.33V18.5h1.5v-1.67A1.75 1.75 0 0 0 12 13.5Z';
function lockIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '40'); s.setAttribute('height', '40'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON); p.setAttribute('fill', 'currentColor'); p.setAttribute('fill-rule', 'evenodd');
  s.append(p);
  return s;
}

let screenEl = null;
let onUnlockedCb = null;
let progressCb = null;
let liveStatus = null;
let touchHooked = false;
let lastTouch = 0;
let reloadGuard = false;

/** The page keeps the session alive while the user works: a touch at most once a minute (spec §2). */
function hookTouch() {
  if (touchHooked) return;
  touchHooked = true;
  const t = () => {
    if (!lockrt.enabled() || lockrt.isLocked()) return;
    const now = Date.now();
    if (!shouldSendTouch(lastTouch, now)) return;
    lastTouch = now;
    send({ type: 'lock.touch' });
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'scroll']) window.addEventListener(ev, t, { passive: true, capture: true });
}

/**
 * Entry point of a page. Resolves when the page may load data: lock off, or unlocked (maybe after the lock screen).
 * `onLockedAgain()` is called when the page gets locked while it shows data (default: reload into the lock screen,
 * which destroys the DOM and every decrypted cache; `beforeLock` lets the page tell its worker first).
 */
export async function gate({ beforeLock, language } = {}) {
  const st = await lockrt.init({ useSession: true });
  if (st.enabled) {
    let pref = language;
    if (!pref) { try { pref = (await getSettings()).language; } catch { pref = 'th'; } }
    lang.cur = resolveLang(pref);
    lockrt.setLang(lang.cur);
  }
  bus.on(async (m) => {
    if (!m) return;
    if (m.type === 'lock.state') {
      const was = lockrt.isLocked();
      await lockrt.refresh();
      if (lockrt.enabled()) hookTouch();
      if (lockrt.isLocked() && !was && !screenEl) { // locked elsewhere while this page shows data: drop everything
        if (reloadGuard) return;
        reloadGuard = true;
        try { if (beforeLock) await beforeLock(); } catch { /* ignore */ }
        location.reload();
      } else if (!lockrt.isLocked() && screenEl && onUnlockedCb) { // unlocked in another page
        onUnlockedCb();
      }
    } else if ((m.type === 'lock.progress' || m.type === 'seal.progress') && progressCb) progressCb(m);
  });
  if (!st.enabled) return { enabled: false };
  hookTouch();
  if (!st.locked) return { enabled: true };
  await showLockScreen();
  return { enabled: true, unlockedHere: true };
}

function setLockedClass(on) { document.documentElement.classList.toggle('lk-on', !!on); }

export function showLockScreen() {
  return new Promise((resolve) => {
    const T = strings();
    setLockedClass(true);
    const pw = el('input', { id: 'lkPw', type: 'password', autocomplete: 'current-password', spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': 'lkMsg', required: true });
    const show = el('button', { type: 'button', class: 'lk-eye', 'aria-pressed': 'false', 'aria-label': T.showPw, title: T.showPw });
    show.append(eyeIcon());
    show.addEventListener('click', () => { const on = pw.type === 'password'; pw.type = on ? 'text' : 'password'; show.setAttribute('aria-pressed', String(on)); show.setAttribute('aria-label', on ? T.hidePw : T.showPw); show.title = show.getAttribute('aria-label'); pw.focus(); });
    const msg = el('p', { id: 'lkMsg', class: 'lk-msg', role: 'status', 'aria-live': 'polite' });
    const count = el('span', { class: 'lk-count', 'aria-hidden': 'true' });
    const go = el('button', { type: 'submit', class: 'lk-go' }, T.unlockBtn);
    const prog = el('p', { class: 'lk-prog', role: 'status', 'aria-live': 'polite', hidden: true });
    const banner = el('p', { class: 'lk-banner', hidden: true });
    const forgotBtn = el('button', { type: 'button', class: 'lk-link' }, T.forgot);
    const main = el('form', { class: 'lk-main', autocomplete: 'on' },
      el('label', { for: 'lkPw' }, T.pwLabel),
      el('div', { class: 'lk-field' }, pw, show),
      el('div', { class: 'lk-feedback' }, msg, count),
      go);
    const alt = el('div', { class: 'lk-alt', hidden: true });
    const card = el('div', { class: 'lk-card' },
      el('div', { class: 'lk-icon' }, lockIcon()),
      el('h1', { id: 'lkTitle' }, T.lockedTitle),
      el('p', { class: 'lk-sub' }, T.lockedSub),
      banner, main, el('p', { class: 'lk-links' }, forgotBtn), alt,
      el('p', { class: 'lk-hint' }, T.stashStill), prog);
    screenEl = el('div', { id: 'lockScreen', class: 'lk-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lkTitle' }, card);
    document.body.append(screenEl);
    let timer = 0;
    let busy = false;

    const done = () => {
      clearInterval(timer);
      pw.value = '';
      if (screenEl) screenEl.remove();
      screenEl = null; onUnlockedCb = null; progressCb = null; liveStatus = null;
      setLockedClass(false);
      resolve();
    };
    onUnlockedCb = done;

    const startCount = (until) => {
      clearInterval(timer);
      const tick = () => {
        const left = until - Date.now();
        if (left <= 0) { clearInterval(timer); count.textContent = ''; msg.textContent = ''; msg.classList.remove('lk-sr'); go.disabled = false; pw.disabled = false; pw.focus(); return false; }
        count.textContent = T.retryIn(fmtWait(left)); // visible countdown (aria-hidden); screen readers get the static sentence once
        return true;
      };
      go.disabled = true;
      msg.textContent = T.waitMsg(fmtWait(until - Date.now()));
      msg.classList.add('lk-sr');
      if (tick()) timer = setInterval(tick, 1000);
    };

    const showError = (r) => {
      go.disabled = false;
      const code = r && r.error;
      if (code === 'wait' || (code === 'wrong' && r.failUntil && r.failUntil > Date.now())) { if (code === 'wrong') msg.textContent = T.wrongPw; startCount(r.failUntil || Date.now() + (r.waitMs || 1000)); return; }
      msg.textContent = code === 'wrong' ? T.wrongPw : code === 'tampered' ? T.tampered : code === 'damaged' ? T.damaged : T.failed;
      pw.focus(); pw.select();
    };

    main.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || !pw.value) return;
      busy = true; go.disabled = true; go.textContent = T.unlocking; msg.textContent = ''; msg.classList.remove('lk-sr');
      const r = await send({ type: 'lock.unlock', password: pw.value });
      busy = false; go.textContent = T.unlockBtn;
      if (r && r.ok && r.ok === true && !r.error) { await lockrt.refresh(); done(); return; }
      pw.value = '';
      showError(r);
    });

    forgotBtn.addEventListener('click', () => openForgot(alt, main, forgotBtn, T, done));

    // state: countdown from a previous failure (survives restarts), recovery banner, paused job
    (async () => {
      const st = await send({ type: 'lock.status' });
      if (st && st.failUntil && st.failUntil > Date.now()) startCount(st.failUntil);
      if (st && st.job && st.job.total) prog.hidden = false, paintProg(prog, st.job, T);
      try {
        const b = (await chrome.storage.local.get('snapBanner')).snapBanner;
        if (b && b.missing > 0) { banner.hidden = false; banner.textContent = T.recoverBanner(b.missing); }
      } catch { /* no banner */ }
      progressCb = (m) => { prog.hidden = false; paintProg(prog, m, T); };
      liveStatus = st;
      pw.focus();
    })();
    queueMicrotask(() => pw.focus());
  });
}

function paintProg(p, job, T) {
  const kind = job.kind;
  p.textContent = kind === 'seal' ? T.sealing(job.done || 0, job.total || 0) : kind === 'revert' ? T.releasing(job.done || 0, job.total || 0) : T.protecting(job.done || 0, job.total || 0);
}

function eyeIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 5C6.5 5 2.7 9 1.5 12c1.2 3 5 7 10.5 7s9.3-4 10.5-7c-1.2-3-5-7-10.5-7Zm0 11.5A4.5 4.5 0 1 1 12 7.500a4.500 4.500 0 0 1 0 9Zm0-2a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z');
  p.setAttribute('fill', 'currentColor');
  s.append(p);
  return s;
}

function openForgot(alt, main, forgotBtn, T, done) {
  main.hidden = true; forgotBtn.hidden = true; alt.hidden = false;
  alt.replaceChildren();
  const key = el('input', { id: 'lkRec', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'XXXXXXX-XXXXXXX-…', required: true });
  const n1 = el('input', { id: 'lkNew1', type: 'password', autocomplete: 'new-password', required: true });
  const n2 = el('input', { id: 'lkNew2', type: 'password', autocomplete: 'new-password', required: true });
  const msg = el('p', { class: 'lk-msg', role: 'status', 'aria-live': 'polite' });
  const go = el('button', { type: 'submit', class: 'lk-go' }, T.recBtn);
  const form = el('form', { class: 'lk-main' },
    el('h2', {}, T.recTitle), el('p', { class: 'lk-sub' }, T.recHelp),
    el('label', { for: 'lkRec' }, T.recLabel), key,
    el('label', { for: 'lkNew1' }, T.newPw), n1,
    el('label', { for: 'lkNew2' }, T.newPw2), n2,
    msg, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (n1.value !== n2.value) { msg.textContent = T.mismatch; n2.focus(); return; }
    if ([...n1.value].length < 8) { msg.textContent = T.tooShort; n1.focus(); return; }
    go.disabled = true; msg.textContent = T.unlocking;
    const r = await send({ type: 'lock.unlock', recoveryKey: key.value, newPassword: n1.value });
    go.disabled = false;
    if (r && r.ok && !r.error) { n1.value = n2.value = key.value = ''; await lockrt.refresh(); done(); return; }
    const c = r && r.error;
    msg.textContent = c === 'badFormat' ? T.recBad : c === 'wrong' ? T.recWrong : c === 'noRecovery' ? T.noRec : c === 'wait' ? T.waitMsg(fmtWait(r.waitMs || 1000)) : c === 'tampered' ? T.tampered : T.failed;
    key.focus();
  });
  // second unlock methods (set up in the settings card): backup password, passkey. Shown only when the lock has such a slot.
  const slotRow = el('p', { class: 'lk-links', hidden: true });
  const slotMsg = el('p', { class: 'lk-msg', role: 'status', 'aria-live': 'polite', id: 'lkSlotMsg' });
  const bk = el('input', { id: 'lkBk', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', required: true });
  const bkGo = el('button', { type: 'submit', class: 'lk-go', id: 'lkBkGo' }, T.bkUnlockBtn);
  const bkMsg = el('p', { class: 'lk-msg', role: 'status', 'aria-live': 'polite', id: 'lkBkMsg' });
  const bkForm = el('form', { class: 'lk-main', hidden: true }, el('h2', {}, T.bkUnlockTitle), el('label', { for: 'lkBk' }, T.bkUnlockLabel), bk, bkMsg, bkGo);
  const slotErr = (r, wrong) => { const c = r && r.error; return c === 'wrong' ? wrong : c === 'wait' ? T.waitMsg(fmtWait(r.waitMs || 1000)) : c === 'noSlot' ? T.noSlot : c === 'tampered' ? T.tampered : c === 'damaged' ? T.damaged : T.failed; };
  bkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!bk.value) return;
    bkGo.disabled = true; bkMsg.textContent = T.unlocking;
    const r = await send({ type: 'lock.unlock', backupPassword: bk.value });
    bkGo.disabled = false; bk.value = '';
    if (r && r.ok && !r.error) { await lockrt.refresh(); done(); return; }
    bkMsg.textContent = slotErr(r, T.bkWrong); bk.focus();
  });
  const bkBtn = el('button', { type: 'button', class: 'lk-link', id: 'lkBkOpen' }, T.bkUnlockLink);
  bkBtn.addEventListener('click', () => { form.hidden = true; bkForm.hidden = false; slotMsg.textContent = ''; bk.focus(); });
  const pkBtn = el('button', { type: 'button', class: 'lk-link', id: 'lkPkOpen' }, T.pkUnlockLink);
  let pkBusy = false;
  pkBtn.addEventListener('click', async () => {
    if (pkBusy) return;
    pkBusy = true; pkBtn.disabled = true; form.hidden = false; bkForm.hidden = true; slotMsg.textContent = T.pkWorking;
    try {
      const st = await send({ type: 'lock.status' });
      const list = ((st && st.slots) || []).filter((s) => s.kind === 'prf');
      const a = await lockpk.assertSlots(list);
      if (a.error) { slotMsg.textContent = a.error === 'cancel' ? T.pkCancel : a.error === 'nosupport' ? T.pkNoSupport : a.error === 'noprf' ? T.pkNoPrf : T.pkFail; return; }
      const r = await send({ type: 'lock.unlock', slot: { id: a.id, prf: a.prf } });
      if (r && r.ok && !r.error) { await lockrt.refresh(); done(); return; }
      slotMsg.textContent = slotErr(r, T.pkWrong);
    } finally { pkBusy = false; pkBtn.disabled = false; }
  });
  (async () => {
    const st = await send({ type: 'lock.status' });
    const slots = (st && st.slots) || [];
    if (slots.some((s) => s.kind === 'pw')) slotRow.append(bkBtn);
    if (slots.some((s) => s.kind === 'prf') && lockpk.supported()) slotRow.append(pkBtn);
    slotRow.hidden = !slotRow.childNodes.length;
  })();
  const back = el('button', { type: 'button', class: 'lk-link' }, T.backToPw);
  back.addEventListener('click', () => { alt.hidden = true; main.hidden = false; forgotBtn.hidden = false; form.hidden = false; bkForm.hidden = true; const p = document.getElementById('lkPw'); if (p) p.focus(); });
  // erase flow: an encrypted backup file can be made first (lib/lockarchui.js); the typed confirmation stays
  const eraseBox = el('div', { class: 'lk-erase', hidden: true });
  eraseBox.append(...eraseFlow({ T, el, send, id: 'lk', cls: { msg: 'lk-msg', btn: 'lk-go', primary: 'lk-go', danger: 'lk-danger', muted: 'lk-sub' } }));
  const eraseOpen = el('button', { type: 'button', class: 'lk-link' }, T.eraseOpen);
  eraseOpen.addEventListener('click', () => { eraseBox.hidden = !eraseBox.hidden; const w = document.getElementById('lkWord'); if (!eraseBox.hidden && w) w.focus(); });
  alt.append(slotRow, slotMsg, bkForm, form, el('p', { class: 'lk-links' }, back), el('h3', {}, T.noRecTitle), el('p', { class: 'lk-links' }, eraseOpen), eraseBox);
  key.focus();
}

export { liveStatus };
