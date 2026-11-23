// Settings card "Password and privacy" (spec section 6). createElement / textContent only. The recovery key is shown once, kept
// only in this closure while visible, never written anywhere, and offered for printing or manual copy (no file download).
import { el, send, strings } from './lockui.js';
import * as bus from './bus.js';
import { passwordStrength } from './lock/kdf.js';
import { eraseFlow, importForm } from './lockarchui.js';
import * as lockpk from './lockpk.js';

const IDLE = [[5, 'idle5'], [15, 'idle15'], [30, 'idle30'], [60, 'idle60'], ['browser', 'idleBrowser']];
const errText = (T, r) => {
  const c = r && r.error;
  if (c === 'wrong') return T.wrongPw;
  if (c === 'wait') return T.waitMsg(`${Math.floor(Math.ceil((r.waitMs || 1000) / 1000) / 60)}:${String(Math.ceil((r.waitMs || 1000) / 1000) % 60).padStart(2, '0')}`);
  if (c === 'tooShort') return T.tooShort;
  if (c === 'locked') return T.stLocked;
  if (c === 'same') return T.bkSame;
  if (c === 'exists') return T.bkExists;
  if (c === 'max') return T.pkMax;
  return T.failed;
};

export function mountLockCard(root, { toast = () => {} } = {}) {
  let st = null;
  let flow = null; // 'enable' | 'change' | 'rec' | 'disable' | 'erase' | { key } while the recovery key is shown
  let keyShown = null;
  let prog = null;
  const paint = () => { root.replaceChildren(...build()); };

  function build() {
    const T = strings();
    const out = [el('h2', {}, T.cardTitle), el('p', { class: 'muted' }, T.cardIntro), el('p', { class: 'muted' }, T.cardHonest), el('p', { class: 'muted', id: 'lkSyncNote' }, T.syncLockCard)];
    if (!st) return out;
    const on = st.enabled;
    const label = !on ? T.stOff : st.state === 'migrating' ? T.stMigrating : st.state === 'reverting' ? T.stReverting : st.locked ? T.stLocked : T.stOn;
    out.push(el('div', { class: 'lkc-row' }, el('span', { class: 'lkc-state', 'data-on': on ? '1' : '0' }, label)));
    if (keyShown) { out.push(...recoveryPanel(T)); return out; }
    if (on && st.job && (st.job.total || prog)) out.push(progressRow(T));
    if (!on) {
      out.push(...(flow === 'enable' ? enableForm(T) : [el('button', { class: 'btn primary', onclick: () => { flow = 'enable'; paint(); } }, T.enableBtn)]));
      out.push(flow === 'import' ? el('div', { class: 'lkc-form' }, ...importFormFn(T)) : el('div', { class: 'lkc-row' }, el('button', { class: 'btn', id: 'lkImportOpen', onclick: () => { flow = 'import'; paint(); } }, T.archImportBtn)));
      return out;
    }
    if (st.state === 'reverting') return out;
    out.push(el('div', { class: 'lkc-row' }, el('button', { class: 'btn', onclick: async () => { await send({ type: 'lock.lockNow' }); } }, T.lockNow)));
    const idle = el('select', { id: 'lkIdle', 'aria-label': T.autoLock });
    for (const [v, k] of IDLE) { const o = el('option', { value: String(v) }, T[k]); if (String(st.policy.idleMin) === String(v)) o.selected = true; idle.append(o); }
    idle.addEventListener('change', async () => { const v = idle.value === 'browser' ? 'browser' : Number(idle.value); await send({ type: 'lock.setPolicy', idleMin: v }); refresh(); });
    const cb = (key, text) => {
      const i = el('input', { type: 'checkbox', id: 'lk-' + key }); i.checked = !!st.policy[key];
      i.addEventListener('change', async () => { await send({ type: 'lock.setPolicy', [key]: i.checked }); refresh(); });
      return el('label', { class: 'row', for: 'lk-' + key }, i, ' ', text);
    };
    out.push(el('div', { class: 'lkc-row' }, el('label', { for: 'lkIdle' }, T.autoLock), idle), el('div', { class: 'lkc-row' }, cb('onScreenLock', T.onScreenLock)), el('div', { class: 'lkc-row' }, cb('onPageClose', T.onPageClose)));
    if (st.locked) { out.push(el('p', { class: 'lkc-msg' }, T.stLocked)); return out; }
    for (const [name, title, fn] of [['change', T.changePw, changeForm], ['rec', T.newRec, recForm], ['disable', T.disable, disableForm], ['import', T.archImportBtn, importFormFn], ['erase', T.eraseAll, eraseForm]]) {
      out.push(flow === name ? el('div', { class: 'lkc-form' }, ...fn(T)) : el('div', { class: 'lkc-row' }, el('button', { class: 'btn', onclick: () => { flow = name; paint(); } }, title)));
    }
    out.push(...slotsSection(T));
    out.push(el('p', { class: 'muted' }, T.lockNote), el('p', { class: 'muted' }, T.patternNote), el('p', { class: 'muted' }, T.exportNote));
    return out;
  }

  const msgEl = () => el('p', { class: 'lkc-msg', role: 'status', 'aria-live': 'polite' });
  const cancelBtn = (T) => el('button', { type: 'button', class: 'btn', onclick: () => { flow = null; paint(); } }, T.cancel);

  function meter(inp) {
    const m = el('div', { class: 'lkc-meter', role: 'img', 'data-l': 'tooShort' }, el('i'));
    const t = el('span', { class: 'lkc-msg', 'aria-live': 'polite' });
    const upd = () => {
      const T = strings(); const s = passwordStrength(inp.value);
      m.dataset.l = s.level; t.textContent = `${T.strength}: ${{ tooShort: T.sTooShort, weak: T.sWeak, fair: T.sFair, strong: T.sStrong }[s.level]}`;
      m.setAttribute('aria-label', t.textContent);
    };
    inp.addEventListener('input', upd);
    return { m, t, upd };
  }

  function enableForm(T) {
    const p1 = el('input', { type: 'password', id: 'lkE1', autocomplete: 'new-password' });
    const p2 = el('input', { type: 'password', id: 'lkE2', autocomplete: 'new-password' });
    const ack = el('input', { type: 'checkbox', id: 'lkAck' });
    const wr = el('input', { type: 'checkbox', id: 'lkWr', checked: true });
    const msg = msgEl();
    const go = el('button', { type: 'submit', class: 'btn primary' }, T.enableBtn);
    const mt = meter(p1);
    const f = el('form', { class: 'lkc-form' },
      el('label', { for: 'lkE1' }, T.pw1), p1, mt.m, mt.t,
      el('label', { for: 'lkE2' }, T.pw2), p2,
      el('p', { class: 'lkc-warn' }, T.noRecWarn),
      el('label', { class: 'row', for: 'lkAck' }, ack, ' ', T.ackNoRec),
      el('label', { class: 'row', for: 'lkWr' }, wr, ' ', T.withRec),
      el('p', { class: 'muted' }, T.enableConfirm), msg,
      el('div', { class: 'lkc-row' }, go, cancelBtn(T)));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) { msg.textContent = T.mismatch; msg.className = 'lkc-msg bad'; p2.focus(); return; }
      if (!passwordStrength(p1.value).ok) { msg.textContent = T.tooShort; msg.className = 'lkc-msg bad'; p1.focus(); return; }
      if (!ack.checked) { msg.textContent = T.ackNoRec; msg.className = 'lkc-msg bad'; ack.focus(); return; }
      go.disabled = true; msg.className = 'lkc-msg'; msg.textContent = T.enabling;
      const pw = p1.value; const wrv = wr.checked;
      let r = await send({ type: 'lock.enable', password: pw, withRecovery: wrv });
      p1.value = p2.value = '';
      if (r && r.ok && !r.error) { keyShown = r.recoveryKey || null; flow = null; await refresh(); return; }
      go.disabled = false; msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    });
    return [f];
  }

  function recoveryPanel(T) {
    const text = keyShown;
    const parts = text.split('-');
    const pre = el('div', { class: 'lkc-key', 'aria-label': T.recShowTitle }, el('div', {}, parts.slice(0, 4).join('-')), el('div', {}, parts.slice(4).join('-')));
    const copied = msgEl();
    const copy = el('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(text); copied.textContent = T.recCopied; } catch { copied.textContent = T.failed; } } }, T.recCopy);
    const print = el('button', { class: 'btn', onclick: () => {
      const box = el('div', { id: 'lkPrint' }, el('h1', {}, 'Tabroost'), el('p', {}, T.recShowTitle), el('pre', {}, [parts.slice(0, 4).join('-'), parts.slice(4).join('-')].join('\n')));
      document.body.append(box);
      const done = () => { box.remove(); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
    } }, T.recPrint);
    const saved = el('button', { class: 'btn primary', onclick: () => { if (confirm(T.recSavedAsk)) { keyShown = null; paint(); } } }, T.recSaved);
    return [el('div', { class: 'lkc-form' }, el('h3', {}, T.recShowTitle), el('p', { class: 'lkc-warn' }, T.recShowHelp), pre, el('div', { class: 'lkc-row' }, copy, print, saved), copied)];
  }

  // ----- other ways to unlock: backup password, passkeys (lib/lockpk.js). Every change asks the current password. -----
  function slotsSection(T) {
    const slots = st.slots || [];
    const bkSlot = slots.find((s) => s.kind === 'pw');
    const pks = slots.filter((s) => s.kind === 'prf');
    const open = (title, name, id) => el('button', { class: 'btn', id, onclick: () => { flow = name; paint(); } }, title);
    const out = [el('h3', {}, T.slotsTitle), el('p', { class: 'muted' }, T.slotsHelp)];
    out.push(el('div', { class: 'lkc-row', id: 'lkBkRow' }, el('strong', {}, T.bkTitle), ' ', el('span', { class: 'muted' }, bkSlot ? T.bkSet : T.bkNone)));
    if (flow === 'bkAdd') out.push(el('div', { class: 'lkc-form' }, ...bkAddForm(T)));
    else if (flow === 'bkRm' && bkSlot) out.push(el('div', { class: 'lkc-form' }, ...slotRemoveForm(T, bkSlot.id, T.bkRemoveHelp, T.bkRemove, T.bkRemoved)));
    else out.push(el('div', { class: 'lkc-row' }, bkSlot ? open(T.bkRemove, 'bkRm', 'lkBkRmOpen') : open(T.bkAdd, 'bkAdd', 'lkBkAddOpen')));
    out.push(el('div', { class: 'lkc-row', id: 'lkPkRow' }, el('strong', {}, T.pkTitle), ' ', el('span', { class: 'muted', id: 'lkPkCount' }, pks.length ? String(pks.length) : T.pkNone)));
    for (const p of pks) {
      const key = 'pkRm:' + p.id;
      if (flow === key) out.push(el('div', { class: 'lkc-form' }, ...slotRemoveForm(T, p.id, '', T.pkRemove + ': ' + (p.name || T.pkDefaultName), T.pkRemoved)));
      else out.push(el('div', { class: 'lkc-row', 'data-slot': p.id }, el('span', {}, p.name || T.pkDefaultName), el('button', { class: 'btn', onclick: () => { flow = key; paint(); } }, T.pkRemove)));
    }
    if (flow === 'pkAdd') out.push(el('div', { class: 'lkc-form' }, ...pkAddForm(T)));
    else if (lockpk.supported() && pks.length < 3) out.push(el('div', { class: 'lkc-row' }, open(T.pkAdd, 'pkAdd', 'lkPkAddOpen')));
    out.push(el('p', { class: 'muted' }, T.pkHelp));
    return out;
  }
  function bkAddForm(T) {
    const c = el('input', { type: 'password', id: 'lkB0', autocomplete: 'current-password' });
    const n1 = el('input', { type: 'password', id: 'lkB1', autocomplete: 'new-password' });
    const n2 = el('input', { type: 'password', id: 'lkB2', autocomplete: 'new-password' });
    const msg = msgEl();
    const mt = meter(n1);
    const go = el('button', { class: 'btn primary', id: 'lkBkGo2', onclick: async () => {
      if (n1.value !== n2.value) { msg.className = 'lkc-msg bad'; msg.textContent = T.mismatch; return; }
      if (!passwordStrength(n1.value).ok) { msg.className = 'lkc-msg bad'; msg.textContent = T.tooShort; return; }
      go.disabled = true;
      const r = await send({ type: 'lock.slotAddPassword', password: c.value, backup: n1.value });
      go.disabled = false; c.value = n1.value = n2.value = '';
      if (r && r.ok && !r.error) { flow = null; toast(T.bkSaved); await refresh(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, T.bkGo);
    return [el('p', { class: 'muted' }, T.bkHelp), el('label', { for: 'lkB0' }, T.confirmPw), c, el('label', { for: 'lkB1' }, T.bkLabel), n1, mt.m, mt.t, el('label', { for: 'lkB2' }, T.bkLabel2), n2, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }
  function slotRemoveForm(T, id, help, title, doneText) {
    const c = el('input', { type: 'password', id: 'lkRm0', autocomplete: 'current-password' });
    const msg = msgEl();
    const go = el('button', { class: 'btn danger', id: 'lkRmGo', onclick: async () => {
      go.disabled = true;
      const r = await send({ type: 'lock.slotRemove', password: c.value, id });
      go.disabled = false; c.value = '';
      if (r && r.ok && !r.error) { flow = null; toast(doneText); await refresh(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, title);
    return [help ? el('p', { class: 'muted' }, help) : null, el('label', { for: 'lkRm0' }, T.confirmPw), c, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }
  function pkAddForm(T) {
    const c = el('input', { type: 'password', id: 'lkP0', autocomplete: 'current-password' });
    const nm = el('input', { type: 'text', id: 'lkP1', autocomplete: 'off', maxlength: '60' });
    const msg = msgEl();
    const go = el('button', { class: 'btn primary', id: 'lkPkGo', onclick: async () => {
      if (!c.value) { msg.className = 'lkc-msg bad'; msg.textContent = T.pwLabel; c.focus(); return; }
      go.disabled = true; msg.className = 'lkc-msg'; msg.textContent = T.pkWorking;
      const k = await lockpk.createPasskey();
      if (k.error) { go.disabled = false; msg.className = 'lkc-msg bad'; msg.textContent = k.error === 'cancel' ? T.pkCancel : k.error === 'nosupport' ? T.pkNoSupport : k.error === 'noprf' ? T.pkNoPrf : T.pkFail; return; }
      const r = await send({ type: 'lock.slotAddPrf', password: c.value, name: nm.value.trim() || T.pkDefaultName, cid: k.cid, psalt: k.psalt, prf: k.prf });
      go.disabled = false; c.value = ''; k.prf = '';
      if (r && r.ok && !r.error) { flow = null; toast(T.pkAdded); await refresh(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, T.pkGo);
    return [el('label', { for: 'lkP0' }, T.confirmPw), c, el('label', { for: 'lkP1' }, T.pkName), nm, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }

  function progressRow(T) {
    const j = prog || st.job;
    const d = j.done || 0; const t = Math.max(1, j.total || 1);
    const pct = Math.min(100, Math.round((d / t) * 100));
    const bar = el('div', { class: 'lkc-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, el('i', { style: `width:${pct}%` }));
    const txt = j.kind === 'revert' ? T.releasing(d, t) : j.kind === 'seal' ? T.sealing(d, t) : T.protecting(d, t);
    const kids = [el('p', { class: 'lkc-msg', role: 'status', 'aria-live': 'polite' }, txt), bar];
    if (st.state === 'migrating') kids.push(el('button', { class: 'btn', onclick: async () => { await send({ type: 'lock.cancelMigration' }); refresh(); } }, T.cancelMig));
    return el('div', {}, ...kids);
  }

  function changeForm(T) {
    const o = el('input', { type: 'password', id: 'lkC0', autocomplete: 'current-password' });
    const n1 = el('input', { type: 'password', id: 'lkC1', autocomplete: 'new-password' });
    const n2 = el('input', { type: 'password', id: 'lkC2', autocomplete: 'new-password' });
    const msg = msgEl();
    const mt = meter(n1);
    const go = el('button', { class: 'btn primary', onclick: async () => {
      if (n1.value !== n2.value) { msg.className = 'lkc-msg bad'; msg.textContent = T.mismatch; return; }
      go.disabled = true;
      const r = await send({ type: 'lock.changePassword', old: o.value, new: n1.value });
      go.disabled = false; o.value = n1.value = n2.value = '';
      if (r && r.ok && !r.error) { flow = null; toast(T.changed); await refresh(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, T.changeBtn);
    return [el('label', { for: 'lkC0' }, T.oldPw), o, el('label', { for: 'lkC1' }, T.newPw), n1, mt.m, mt.t, el('label', { for: 'lkC2' }, T.newPw2), n2, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }
  function recForm(T) {
    const p = el('input', { type: 'password', id: 'lkR0', autocomplete: 'current-password' });
    const msg = msgEl();
    const go = el('button', { class: 'btn primary', onclick: async () => {
      go.disabled = true;
      const r = await send({ type: 'lock.newRecovery', password: p.value });
      p.value = ''; go.disabled = false;
      if (r && r.ok && r.recoveryKey) { keyShown = r.recoveryKey; flow = null; paint(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, T.newRecBtn);
    return [el('p', { class: 'muted' }, T.newRecHelp), el('label', { for: 'lkR0' }, T.pwLabel), p, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }
  function disableForm(T) {
    const p = el('input', { type: 'password', id: 'lkD0', autocomplete: 'current-password' });
    const msg = msgEl();
    const go = el('button', { class: 'btn danger', onclick: async () => {
      go.disabled = true;
      const r = await send({ type: 'lock.disable', password: p.value });
      p.value = ''; go.disabled = false;
      if (r && r.ok && !r.error) { flow = null; await refresh(); return; }
      msg.className = 'lkc-msg bad'; msg.textContent = errText(T, r);
    } }, T.disableBtn);
    return [el('p', { class: 'muted' }, T.disableHelp), el('label', { for: 'lkD0' }, T.pwLabel), p, msg, el('div', { class: 'lkc-row' }, go, cancelBtn(T))];
  }
  function eraseForm(T) { // backup choice + typed confirmation (lib/lockarchui.js)
    return [el('p', { class: 'muted' }, T.eraseAllHelp), ...eraseFlow({ T, el, send, id: 'lkX', cls: { msg: 'lkc-msg', btn: 'btn', primary: 'btn primary', danger: 'btn danger', muted: 'muted' } }), el('div', { class: 'lkc-row' }, cancelBtn(T))];
  }
  function importFormFn(T) { // old encrypted backup file -> new tab sets
    return [...importForm({ T, el, send, cls: { msg: 'lkc-msg', primary: 'btn primary', muted: 'muted' }, onDone: () => { document.dispatchEvent(new CustomEvent('cmr-imported')); } }), el('div', { class: 'lkc-row' }, cancelBtn(T))];
  }

  async function refresh() {
    const r = await send({ type: 'lock.status' });
    if (r && r.ok) { st = r; if (!r.job) prog = null; if (!keyShown) paint(); else paint(); }
  }
  bus.on((m) => {
    if (!m) return;
    if (m.type === 'lock.state') { st = m; prog = m.job || null; paint(); }
    else if (m.type === 'lock.progress' || m.type === 'seal.progress') { prog = { kind: m.kind, done: m.done, total: m.total }; if (st) { st.job = st.job || prog; } paint(); }
  });
  refresh();
  return { refresh };
}
