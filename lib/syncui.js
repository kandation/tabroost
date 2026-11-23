// Settings card "Sync between devices" + the small status dot. Built with createElement/textContent only (no innerHTML).
// mountSyncCard(root, { send, toast }) -> { refresh }   ; watchSyncStatus(cb) listens to BroadcastChannel 'cmr-sync'.

import { request as requestPerm } from './perms.js';

const T_TH = {
  needsPermission: 'ซิงค์หยุดไว้ เพราะ Chrome ยังไม่ได้อนุญาตให้ใช้บุ๊กมาร์ก (ข้อมูลในเครื่องยังอยู่ครบ)', grantBm: 'อนุญาตให้ใช้บุ๊กมาร์ก', permDenied: 'ยังไม่ได้อนุญาตให้ใช้บุ๊กมาร์ก จึงยังไม่เปิดซิงค์ ข้อมูลในเครื่องไม่เปลี่ยนแปลง', permWhy: 'ซิงค์ต้องใช้สิทธิ์บุ๊กมาร์กของ Chrome เพื่อวางข้อมูลที่เข้ารหัสไว้ในโฟลเดอร์ของ Tabroost เท่านั้น ไม่แตะบุ๊กมาร์กอื่นของคุณ ระบบจะขอสิทธิ์นี้ตอนกดเปิดซิงค์',
  title: 'ซิงค์ระหว่างเครื่อง',
  lockedNote: 'รหัสผ่านเปิดอยู่: ข้อมูลซิงค์ในเครื่องนี้ถูกเข้ารหัสไว้ด้วย ตอนล็อกอยู่ ซิงค์จะพักไว้ ไม่ส่งไม่รับอะไร พอปลดล็อกแล้วทำต่อเองและไม่มีอะไรหาย',
  rejoin: 'เปิดรหัสผ่านแล้ว เครื่องนี้ต้องจับคู่ซิงค์อีกครั้งหนึ่ง: กด “เข้าร่วมซิงค์ที่มีอยู่แล้ว” แล้วใส่รหัสผ่านซิงค์เดิม ข้อมูลในเครื่องและที่ซิงค์ไว้ไม่หาย',
  intro: 'ส่งชุดแท็บที่เก็บไว้ไปยัง Chrome เครื่องอื่นที่ลงชื่อเข้าใช้บัญชี Google เดียวกัน โดยไม่ต้องมีเซิร์ฟเวอร์ ใช้ระบบซิงค์บุ๊กมาร์กของ Chrome เป็นทางส่ง ดังนั้นต้องเปิดการซิงค์บุ๊กมาร์กใน Chrome และต่ออินเทอร์เน็ตไว้',
  fake: 'ข้อมูลที่ซิงค์จะถูกเก็บเป็นบุ๊กมาร์กในโฟลเดอร์ชื่อ “Tabroost sync” (อยู่ใต้ “บุ๊กมาร์กอื่นๆ”) กรุณาอย่าลบหรือแก้โฟลเดอร์นี้เอง บุ๊กมาร์กเหล่านี้ไม่ได้ชี้ไปเว็บจริง จึงไม่ทำให้ไอคอนดาวของเว็บใดติดสี',
  e2e: 'ข้อมูลถูกเข้ารหัสด้วยรหัสผ่านของคุณก่อนส่งออกจากเครื่อง Google และเครื่องอื่นอ่านไม่ได้ เราก็กู้รหัสผ่านให้ไม่ได้ ถ้าลืม ต้องตั้งค่าซิงค์ใหม่ (ชุดแท็บในเครื่องนี้ยังอยู่ครบ)',
  off: 'ปิดอยู่', idle: 'ซิงค์เรียบร้อย', pairing: 'กำลังเชื่อมต่อ…', bootstrapping: 'กำลังรับข้อมูลจากเครื่องอื่น…', syncing: 'กำลังซิงค์…',
  paused: 'หยุดชั่วคราว', overBudget: 'พื้นที่ซิงค์เต็ม (ส่งได้เท่าที่พอ) เลือกเพิ่มพื้นที่ หรือเลือกซิงค์ให้น้อยลง', needsPassphrase: 'ต้องใส่รหัสผ่านซิงค์อีกครั้ง', stoppedRemotely: 'ถูกปิดซิงค์จากเครื่องอื่น', error: 'มีปัญหา ลองกด “ซิงค์ตอนนี้”',
  enable: 'เปิดซิงค์ (ตั้งค่าครั้งแรก)', join: 'เข้าร่วมซิงค์ที่มีอยู่แล้ว', scope: 'จะซิงค์อะไรบ้าง', scopeRecent: 'ชุดแท็บที่ติดดาว และชุดที่เก็บในช่วงกี่วันล่าสุด (ตั้งตัวเลขด้านล่าง) — แนะนำ', scopeAll: 'ทุกชุดแท็บ (ใช้พื้นที่ซิงค์มากกว่า)', scopeFlag: 'เฉพาะชุดที่เลือกเอง (ที่เมนู ⋯ ของแต่ละชุด เลือก “ซิงค์ชุดนี้ไปเครื่องอื่น”)',
  days: 'ช่วงกี่วันล่าสุด (วัน)', budget: 'พื้นที่ซิงค์ที่ใช้ได้', usage: 'ใช้ไปแล้ว', devices: 'เครื่องที่เชื่อมอยู่', thisDevice: 'เครื่องนี้', lastSeen: 'ใช้ล่าสุด', remove: 'ถอดเครื่องออก', never: 'ยังไม่เคย',
  now: 'ซิงค์ตอนนี้', pause: 'หยุดซิงค์ชั่วคราว', resume: 'ทำต่อ', change: 'เปลี่ยนรหัสผ่าน', rotate: 'เปลี่ยนกุญแจเข้ารหัส', disable: 'ปิดซิงค์ในเครื่องนี้', wipe: 'ปิดและลบข้อมูลซิงค์ทั้งหมด…',
  pass: 'รหัสผ่านสำหรับซิงค์', pass2: 'พิมพ์รหัสผ่านอีกครั้ง', oldPass: 'รหัสผ่านเดิม', newPass: 'รหัสผ่านใหม่', deviceName: 'ตั้งชื่อเครื่องนี้ (เช่น โน้ตบุ๊กที่ทำงาน)', cancel: 'ยกเลิก', ok: 'ตกลง',
  mismatch: 'รหัสผ่านสองช่องไม่ตรงกัน ลองพิมพ์ใหม่', short: 'รหัสผ่านสั้นเกินไป ต้องมีอย่างน้อย 10 ตัวอักษร (ลองใช้ประโยคสั้นๆ ที่จำง่าย)', wrong: 'รหัสผ่านไม่ถูกต้อง ลองพิมพ์ใหม่อีกครั้ง', noVault: 'ยังไม่พบข้อมูลซิงค์ในบัญชีนี้ ให้เปิดซิงค์บนอีกเครื่องก่อน แล้วรอสักครู่ให้ Chrome ซิงค์บุ๊กมาร์กมาถึงเครื่องนี้ จากนั้นลองใหม่',
  exists: 'บัญชีนี้มีข้อมูลซิงค์อยู่แล้ว ให้กด “เข้าร่วมซิงค์ที่มีอยู่แล้ว” แทน',
  strengthLabel: 'ความแข็งแรงของรหัสผ่าน', s0: 'อ่อนมาก', s1: 'อ่อน', s2: 'พอใช้', s3: 'ดี', s4: 'แข็งแรง',
  warnPass: 'จดรหัสผ่านไว้ให้ดี ทุกเครื่องต้องใช้รหัสเดียวกัน และถ้าลืม กู้คืนไม่ได้',
  confirmWipe1: 'จะลบข้อมูลซิงค์ออกจากบัญชี Chrome ของคุณ ทุกเครื่อง และปิดการซิงค์ ลบแล้วเอากลับมาไม่ได้ ส่วนชุดแท็บที่เก็บไว้ในเครื่องนี้ยังอยู่ครบ',
  confirmWipe2: 'ฉันเข้าใจ ลบข้อมูลซิงค์ทั้งหมด', wiping: 'กำลังแจ้งเครื่องอื่นและลบข้อมูล… ใช้เวลาประมาณ 1 นาที', done: 'เรียบร้อย', pendingN: (n) => `รอส่ง ${n} รายการ`,
  scopeNote: 'ปรับขอบเขตแล้ว ข้อมูลที่ซิงค์ไปแล้วจะไม่ถูกลบ',
  fail: 'ทำไม่สำเร็จ: ',
  agoNow: 'เมื่อสักครู่', agoMin: (m) => `${m} นาทีที่แล้ว`, agoHr: (h) => `${h} ชั่วโมงที่แล้ว`, agoDay: (d) => `${d} วันที่แล้ว`,
};
const T = { ...T_TH };
const T_EN = {
  needsPermission: 'Sync is paused because Chrome has not allowed bookmarks yet (the data on this computer is all still here)', grantBm: 'Allow bookmarks', permDenied: 'Bookmarks were not allowed, so sync stays off. Nothing on this computer changed.', permWhy: 'Sync needs the Chrome bookmarks permission only to place encrypted data in Tabroost\'s own folder. It does not touch your other bookmarks. Chrome asks for it when you turn sync on.',
  title: 'Sync between devices',
  lockedNote: 'The password is on: the sync data on this computer is encrypted too. While locked, sync pauses (nothing is sent or received) and carries on by itself after you unlock, with nothing lost.',
  rejoin: 'The password is on, so this computer has to pair with sync once more: press "Join the sync that already exists" and enter your old sync passphrase. Nothing on this computer or in the synced copy is lost.',
  intro: 'Send your saved tab sets to other Chrome browsers signed in to the same Google account, with no server. It travels through Chrome\'s bookmark sync, so bookmark sync must be on in Chrome and you need an internet connection.',
  fake: 'Synced data is kept as bookmarks in a folder called "Tabroost sync" (under "Other bookmarks"). Please do not delete or edit this folder yourself. These bookmarks do not point to real websites, so no site\'s star turns on.',
  e2e: 'Your data is encrypted with your passphrase before it leaves this computer. Google and other devices cannot read it, and we cannot recover the passphrase for you. If you forget it, set sync up again (the tab sets on this computer stay).',
  off: 'Off', idle: 'Up to date', pairing: 'Connecting…', bootstrapping: 'Receiving data from another device…', syncing: 'Syncing…',
  paused: 'Paused', overBudget: 'Sync space is full (only what fits is sent). Allow more space or sync fewer tab sets.', needsPassphrase: 'Enter the sync passphrase again', stoppedRemotely: 'Sync was turned off from another device', error: 'Something went wrong. Try "Sync now".',
  enable: 'Turn on sync (first-time setup)', join: 'Join the sync that already exists', scope: 'What to sync', scopeRecent: 'Starred tab sets and sets saved in the last few days (set the number below). Recommended.', scopeAll: 'Every tab set (uses more sync space)', scopeFlag: 'Only the sets you pick (in each set\'s ⋯ menu choose "Sync this tab set")',
  days: 'Last how many days', budget: 'Sync space allowed', usage: 'Used', devices: 'Connected devices', thisDevice: 'This device', lastSeen: 'Last used', remove: 'Remove device', never: 'Never',
  now: 'Sync now', pause: 'Pause sync', resume: 'Resume', change: 'Change passphrase', rotate: 'Change the encryption key', disable: 'Turn off sync on this device', wipe: 'Turn off and delete all sync data…',
  pass: 'Sync passphrase', pass2: 'Type the passphrase again', oldPass: 'Current passphrase', newPass: 'New passphrase', deviceName: 'Name this device (for example, Work laptop)', cancel: 'Cancel', ok: 'OK',
  mismatch: 'The two passphrases do not match. Try again.', short: 'The passphrase is too short. Use at least 10 characters (a short sentence is easy to remember).', wrong: 'Wrong passphrase. Try again.', noVault: 'No sync data found in this account yet. Turn sync on from another device first, wait a moment for Chrome to bring the bookmarks over, then try again.',
  exists: 'This account already has sync data. Choose "Join the sync that already exists" instead.',
  strengthLabel: 'Passphrase strength', s0: 'Very weak', s1: 'Weak', s2: 'Fair', s3: 'Good', s4: 'Strong',
  warnPass: 'Keep the passphrase somewhere safe. Every device needs the same one, and it cannot be recovered if you forget it.',
  confirmWipe1: 'This deletes the sync data from your Chrome account on every device and turns sync off. It cannot be undone. The tab sets saved on this computer stay.',
  confirmWipe2: 'I understand, delete all sync data', wiping: 'Telling other devices and deleting the data… this takes about a minute', done: 'Done', pendingN: (n) => `${n} waiting to send`,
  scopeNote: 'Scope updated. Data that was already synced is not deleted.',
  fail: 'Could not do that: ',
  agoNow: 'just now', agoMin: (m) => `${m} min ago`, agoHr: (h) => `${h} h ago`, agoDay: (d) => `${d} d ago`,
};
/** Switches the sync card between Thai and English. Takes effect for cards mounted afterwards (the list page remounts it). */
export function setSyncLang(lang) { Object.assign(T, T_TH, lang === 'en' ? T_EN : {}); }
const STATE_KEY = { off: 'off', idle: 'idle', pairing: 'pairing', bootstrapping: 'bootstrapping', paused: 'paused', overBudget: 'overBudget', needsPassphrase: 'needsPassphrase', needsPermission: 'needsPermission', stoppedRemotely: 'stoppedRemotely' };

export function stateLabel(st) {
  if (!st || !st.enabled) return T.off;
  if (st.error && st.state !== 'idle') return T.error;
  return T[STATE_KEY[st.state] || 'syncing'] || T.syncing;
}
export function stateTone(st) {
  if (!st || !st.enabled) return 'off';
  if (['stoppedRemotely', 'needsPassphrase'].includes(st.state) || (st.error && st.state !== 'idle')) return 'bad';
  if (['overBudget', 'paused', 'needsPermission'].includes(st.state)) return 'warn';
  if (['pairing', 'bootstrapping', 'syncing'].includes(st.state) || st.pending > 0) return 'busy';
  return 'ok';
}

export function watchSyncStatus(cb) {
  try { const ch = new BroadcastChannel('cmr-sync'); ch.onmessage = (e) => cb(e.data); return () => ch.close(); } catch { return () => {}; }
}

export function passStrength(p) {
  let s = 0;
  if (p.length >= 10) s++;
  if (p.length >= 14) s++;
  if (/[a-z]/.test(p) && /[A-Z0-9]/.test(p)) s++;
  if (/\s/.test(p) && p.split(/\s+/).length >= 3) s++; // passphrase of several words
  if (/[^a-zA-Z0-9\s]/.test(p) || p.length >= 20) s++;
  return Math.min(4, s > 0 && p.length < 10 ? 0 : s);
}

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtAgo = (ts) => {
  if (!ts) return T.never;
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return T.agoNow;
  if (m < 60) return T.agoMin(m);
  if (m < 1440) return T.agoHr(Math.round(m / 60));
  return T.agoDay(Math.round(m / 1440));
};

function dialog(title, body, { okLabel = T.ok, onOk, danger = false } = {}) {
  const dlg = el('dialog', { class: 'syncdlg' });
  const err = el('p', { class: 'syncerr', role: 'alert' });
  const ok = el('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary'), text: okLabel });
  const cancel = el('button', { type: 'button', class: 'btn', text: T.cancel, onclick: () => dlg.close() });
  ok.addEventListener('click', async () => {
    ok.disabled = true; err.textContent = '';
    try { const r = await onOk(dlg); if (r !== false) dlg.close(); } catch (e) { err.textContent = String((e && e.message) || e); } finally { ok.disabled = false; }
  });
  dlg.append(el('h3', { text: title }), ...[].concat(body), err, el('div', { class: 'row end' }, cancel, ok));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, ok, err };
}
const field = (label, type, id) => { const i = el('input', { type, id, autocomplete: type === 'password' ? 'new-password' : 'off', spellcheck: 'false' }); return { i, row: el('label', { class: 'srow stack' }, el('span', { class: 'sl', text: label }), i) }; };

function strengthMeter(input) {
  const bar = el('div', { class: 'pwbar' }, el('i'));
  const txt = el('span', { class: 'muted' });
  const upd = () => { const s = passStrength(input.value); bar.firstChild.style.width = (input.value ? (s + 1) * 20 : 0) + '%'; bar.dataset.s = String(s); txt.textContent = input.value ? `${T.strengthLabel}: ${T['s' + s]}` : ''; };
  input.addEventListener('input', upd); upd();
  return el('div', { class: 'pwrow' }, bar, txt);
}

export function mountSyncCard(root, { send, toast }) {
  let st = null;
  let scopeDraft = null;
  let lockOn = false;
  const host = el('div', { class: 'syncbody' });
  root.replaceChildren(el('h2', { text: T.title }), el('p', { class: 'muted', text: T.intro }), host, el('p', { class: 'muted', text: T.fake }), el('p', { class: 'muted', text: T.e2e }));

  const call = async (msg, ok) => {
    const r = await send(msg);
    if (!r.ok) { const e = String(r.error || ''); toast(/wrong passphrase/i.test(e) ? T.wrong : /no-vault/.test(e) ? T.noVault : /vault-exists/.test(e) ? T.exists : e ? T.fail + e : T.error); return r; }
    if (ok) toast(ok);
    return r;
  };
  const readScope = () => scopeDraft || (st && st.scope) || { mode: 'recent', days: 30 };

  function scopeBlock(onChange) {
    const sc = readScope();
    const mk = (mode, label) => el('label', { class: 'srow' }, el('span', { class: 'sl', text: label }), el('input', { type: 'radio', name: 'syncscope', value: mode, checked: sc.mode === mode, onchange: () => { scopeDraft = { ...readScope(), mode }; onChange(); } }));
    const days = el('input', { type: 'number', min: '1', max: '365', value: String(sc.days || 30), class: 'num', 'aria-label': T.days, onchange: (e) => { scopeDraft = { ...readScope(), days: Math.max(1, Math.min(365, Number(e.target.value) || 30)) }; onChange(); } });
    return el('div', { class: 'syncscope' }, el('h3', { text: T.scope }), mk('recent', T.scopeRecent), el('div', { class: 'srow' }, el('span', { class: 'sl muted', text: T.days }), days), mk('all', T.scopeAll), mk('flagged', T.scopeFlag));
  }

  function enableDialog(join) {
    const p1 = field(T.pass, 'password', 'syncPass1');
    const p2 = join ? null : field(T.pass2, 'password', 'syncPass2');
    const name = field(T.deviceName, 'text', 'syncName');
    name.i.value = (st && st.deviceName) || '';
    const body = [p1.row, join ? null : strengthMeter(p1.i), p2 && p2.row, name.row, join ? null : el('p', { class: 'muted', text: T.warnPass }), scopeBlock(() => {})];
    dialog(join ? T.join : T.enable, body, {
      okLabel: join ? T.join : T.enable,
      onOk: async () => {
        const pw = p1.i.value;
        if (!join) { if (pw.length < 10) throw new Error(T.short); if (pw !== p2.i.value) throw new Error(T.mismatch); }
        if (!(await requestPerm('bookmarks'))) throw new Error(T.permDenied); // first await in the click handler: the user gesture is still valid
        const r = await send({ type: join ? 'sync/join' : 'sync/enable', passphrase: pw, deviceName: name.i.value.trim(), scope: readScope(), budgetMB: (st && st.budgetMB) || 4 });
        if (!r.ok) { const e = String(r.error || ''); throw new Error(/wrong passphrase/i.test(e) ? T.wrong : /no-vault/.test(e) ? T.noVault : /vault-exists/.test(e) ? T.exists : (T.fail + e)); }
        scopeDraft = null; await refresh();
        return true;
      },
    });
  }

  function changeDialog() {
    const a = field(T.oldPass, 'password', 'sOld'); const b = field(T.newPass, 'password', 'sNew1'); const c = field(T.pass2, 'password', 'sNew2');
    dialog(T.change, [a.row, b.row, strengthMeter(b.i), c.row], {
      onOk: async () => {
        if (b.i.value.length < 10) throw new Error(T.short);
        if (b.i.value !== c.i.value) throw new Error(T.mismatch);
        const r = await send({ type: 'sync/changePassphrase', oldPass: a.i.value, newPass: b.i.value });
        if (!r.ok) throw new Error(/wrong passphrase/i.test(String(r.error)) ? T.wrong : String(r.error));
        toast(T.done);
      },
    });
  }

  function rotateDialog() {
    const f = field(T.pass, 'password', 'sRot');
    dialog(T.rotate, [f.row], { onOk: async () => { const r = await send({ type: 'sync/rotateKey', passphrase: f.i.value }); if (!r.ok) throw new Error(/wrong passphrase/i.test(String(r.error)) ? T.wrong : String(r.error)); toast(T.done); } });
  }

  function wipeDialog() {
    const chk = el('input', { type: 'checkbox', id: 'syncWipeOk' });
    const d = dialog(T.wipe.replace('…', ''), [el('p', { text: T.confirmWipe1 }), el('label', { class: 'srow' }, el('span', { class: 'sl', text: T.confirmWipe2 }), chk)], {
      danger: true, okLabel: T.wipe.replace('…', ''),
      onOk: async () => {
        if (!chk.checked) throw new Error(T.confirmWipe2);
        d.err.textContent = T.wiping;
        const r = await send({ type: 'sync/wipeRemote' });
        if (!r.ok) throw new Error(String(r.error));
        await refresh();
        toast(T.done);
      },
    });
    d.ok.disabled = true; // armed only after the box is ticked (second step)
    chk.addEventListener('change', () => { d.ok.disabled = !chk.checked; });
  }

  function render() {
    const on = !!(st && st.enabled);
    const tone = stateTone(st);
    const head = el('div', { class: 'row syncstate' }, el('span', { class: 'sdot', 'data-tone': tone, 'aria-hidden': 'true' }), el('b', { id: 'syncStateText', text: stateLabel(st) }),
      on && st.pending ? el('span', { class: 'muted', text: T.pendingN(st.pending) }) : null,
      on && st.lastSync ? el('span', { class: 'muted', text: fmtAgo(st.lastSync) }) : null);
    const kids = [head];
    if (on && st.needsPermission) kids.push(el('div', { class: 'row' }, el('span', { class: 'muted', text: T.needsPermission }), el('button', { type: 'button', class: 'btn primary', id: 'syncGrant', text: T.grantBm, onclick: async () => { if (await requestPerm('bookmarks')) { await refresh(); } else toast(T.permDenied); } })));
    if (lockOn) kids.push(el('p', { class: 'muted', id: 'syncLockNote', text: T.lockedNote }));
    if (!on && st && st.rejoin) kids.push(el('p', { class: 'muted', id: 'syncRejoin', text: T.rejoin }));
    if (!on) kids.push(el('p', { class: 'muted', text: T.permWhy }));
    if (!on) {
      kids.push(el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn primary', id: 'syncEnable', text: T.enable, onclick: () => enableDialog(false) }), el('button', { type: 'button', class: 'btn', id: 'syncJoin', text: T.join, onclick: () => enableDialog(true) })));
      kids.push(scopeBlock(render));
    } else {
      // usage vs budget
      const budget = (st.budgetMB || 4) * 1048576;
      const used = st.usedBytes || 0;
      const pct = Math.min(100, Math.round((used / budget) * 100));
      const bud = el('select', { id: 'syncBudget', 'aria-label': T.budget, onchange: async (e) => { await call({ type: 'sync/setBudget', budgetMB: Number(e.target.value) }); await refresh(); } },
        ...[4, 8].map((n) => el('option', { value: String(n), text: n + ' MB', selected: n === (st.budgetMB || 4) })));
      kids.push(el('div', { class: 'syncuse' }, el('div', { class: 'row' }, el('span', { class: 'sl', text: `${T.usage} ${fmtBytes(used)} / ${st.budgetMB || 4} MB (${pct}%)` }), bud), el('div', { class: 'pwbar use', 'data-s': pct > 90 ? '0' : '4' }, Object.assign(el('i'), { style: `width:${pct}%` }))));
      kids.push(scopeBlock(async () => { const r = await call({ type: 'sync/setScope', scope: readScope() }, T.scopeNote); if (r.ok) { scopeDraft = null; await refresh(); } }));
      // devices
      const list = el('div', { class: 'syncdevs' }, el('h3', { text: T.devices }));
      for (const d of st.devices || []) {
        const me = d.id === st.deviceId;
        list.append(el('div', { class: 'srow' }, el('span', { class: 'sl' }, el('b', { text: d.name || d.id }), el('span', { class: 'muted', text: me ? ` · ${T.thisDevice}` : ` · ${T.lastSeen} ${fmtAgo(d.lastSeen)}` })),
          me ? null : el('button', { type: 'button', class: 'btn danger', text: T.remove, onclick: async () => { await call({ type: 'sync/removeDevice', id: d.id, force: true }, T.done); refresh(); } })));
      }
      kids.push(list);
      kids.push(el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn', id: 'syncNow', text: T.now, onclick: async () => { await call({ type: 'sync/now' }); refresh(); } }),
        el('button', { type: 'button', class: 'btn', id: 'syncPause', text: st.state === 'paused' ? T.resume : T.pause, onclick: async () => { await call({ type: st.state === 'paused' ? 'sync/resume' : 'sync/pause' }); refresh(); } }),
        el('button', { type: 'button', class: 'btn', text: T.change, onclick: changeDialog }),
        el('button', { type: 'button', class: 'btn', text: T.rotate, onclick: rotateDialog })));
      kids.push(el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn', id: 'syncDisable', text: T.disable, onclick: async () => { await call({ type: 'sync/disableLocal' }, T.done); refresh(); } }),
        el('button', { type: 'button', class: 'btn danger', id: 'syncWipe', text: T.wipe, onclick: wipeDialog })));
    }
    host.replaceChildren(...kids);
  }

  async function refresh() {
    const r = await send({ type: 'sync/getStatus' });
    st = r.ok ? r.status : null;
    try { const l = await send({ type: 'lock.status' }); lockOn = !!(l && l.enabled); } catch { lockOn = false; }
    render();
    return st;
  }
  watchSyncStatus((s) => { st = { ...(st || {}), ...s }; if (document.getElementById('s-sync') && !document.querySelector('dialog.syncdlg[open]')) render(); });
  refresh();
  return { refresh, status: () => st };
}
