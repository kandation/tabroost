// Screens for the OPTIONAL permissions (see lib/perms.js). Built with createElement/textContent only (no innerHTML). Thai + English live here
// (same pattern as dashstr.js / aboutstr.js) so the list page and the popup need almost no edits.
//
//   initPermsUi()        list page: fills #s-perms (settings card), #permSleepHint (Sleep card), #permBanner (top banner, dismissible once),
//                        #permWelcome (one calm line in the welcome box) and keeps them in sync with chrome.permissions.onAdded/onRemoved.
//   mountPopupHint(root) popup: one small notice with the grant button when auto-sleep is on but cannot run.
//   sessionsHint()       the small "turn on" row shown instead of the Chrome "recently closed" list.
//
// chrome.permissions.request() needs a user gesture, so every grant button calls it as the FIRST thing in its click handler.

import { has, request, remove, snapshot, NAMES } from './perms.js';
import { resolveLang } from './i18n.js';

const DISMISS_KEY = 'permBannerDismissed';

const TH = {
  title: 'สิทธิ์ที่ขอเพิ่ม',
  intro: 'Tabroost ขอสิทธิ์เหล่านี้ตอนที่คุณใช้ฟีเจอร์นั้นเท่านั้น ไม่ได้ขอตอนติดตั้ง ไม่อนุญาตก็ใช้ส่วนอื่นได้ปกติ และถอนคืนได้ทุกเมื่อ ข้อมูลที่เก็บไว้ไม่หายไม่ว่าจะเลือกแบบไหน',
  on: 'อนุญาตแล้ว', off: 'ยังไม่อนุญาต', grant: 'อนุญาต', revoke: 'ถอนสิทธิ์',
  host: 'ตรวจฟอร์มและวิดีโอก่อนพักแท็บ',
  hostWhy: 'ก่อนพักแท็บ Tabroost ดูแค่ว่าหน้านั้นมีข้อความที่พิมพ์ค้างอยู่ หรือกำลังเล่นวิดีโอหรือเสียงอยู่หรือไม่ ถ้ามีจะไม่พักแท็บนั้น ไม่อ่านเนื้อหาหน้า และไม่ส่งอะไรออกไป ถ้าไม่อนุญาต การพักแท็บอัตโนมัติจะหยุดไว้ก่อน เพื่อไม่ให้ข้อความที่พิมพ์ค้างหาย',
  bookmarks: 'ซิงค์ระหว่างเครื่อง (บุ๊กมาร์ก)',
  bookmarksWhy: 'ใช้เฉพาะตอนเปิดซิงค์ เพื่อวางข้อมูลที่เข้ารหัสไว้ในโฟลเดอร์ของ Tabroost ไม่อ่านหรือแก้บุ๊กมาร์กอื่นของคุณ ถ้าถอนสิทธิ์ ซิงค์จะหยุดไว้ ข้อมูลในเครื่องยังอยู่ครบ',
  sessions: 'แท็บที่ Chrome เพิ่งปิด',
  sessionsWhy: 'ใช้อ่านรายการ “เพิ่งปิด” ของ Chrome เพื่อให้เปิดแท็บที่หายกลับมาได้ อ่านเมื่อคุณเปิดหน้ากู้คืนเท่านั้น',
  grantHost: 'อนุญาตให้ตรวจฟอร์มและวิดีโอก่อนพักแท็บ',
  hintOn: 'พักแท็บอัตโนมัติหยุดอยู่ เพราะยังไม่ได้อนุญาตให้ตรวจฟอร์มและวิดีโอก่อนพัก แท็บของคุณยังไม่ถูกพักจนกว่าจะอนุญาต (กันข้อความที่พิมพ์ค้างหาย)',
  hintOff: 'ถ้าเปิดพักแท็บอัตโนมัติ Tabroost ต้องได้รับอนุญาตให้ตรวจฟอร์มและวิดีโอก่อนพักแท็บ เพื่อไม่ให้ข้อความที่พิมพ์ค้างหาย',
  hintOk: 'ตรวจฟอร์มและวิดีโอก่อนพักแท็บ: อนุญาตแล้ว',
  denied: 'ยังไม่ได้อนุญาต ทุกอย่างยังเหมือนเดิม',
  dismiss: 'ปิดข้อความนี้',
  welcome: 'หมายเหตุ: การพักแท็บอัตโนมัติจะทำงานเมื่อคุณอนุญาตให้ Tabroost ตรวจฟอร์มและวิดีโอก่อนพักแท็บ (ขอทีหลังได้ที่ ตั้งค่า > สิทธิ์ที่ขอเพิ่ม) ถ้าไม่อนุญาต แท็บจะไม่ถูกพัก',
  rcOff: 'ยังไม่ได้เปิดรายการ “แท็บที่ Chrome เพิ่งปิด” เปิดเพื่อดูแท็บที่เพิ่งปิดไป (ไม่เปิดก็ใช้ส่วนอื่นได้)',
  rcBtn: 'เปิดใช้',
  revoked: 'ถอนสิทธิ์แล้ว ข้อมูลที่เก็บไว้ไม่ได้ถูกลบ',
};
const EN = {
  title: 'Permissions asked later',
  intro: 'Tabroost asks for these only when you use the feature that needs them, not at install. Say no and everything else still works. You can take any of them back at any time. Your saved tabs are never deleted either way.',
  on: 'Allowed', off: 'Not allowed', grant: 'Allow', revoke: 'Take back',
  host: 'Check forms and video before sleeping a tab',
  hostWhy: 'Before sleeping a tab, Tabroost only checks whether the page has typed text that was not saved, or is playing video or sound. If so, the tab is left awake. It does not read the page and sends nothing out. If you do not allow it, automatic sleep stays paused so typed text can never be lost.',
  bookmarks: 'Sync between devices (bookmarks)',
  bookmarksWhy: 'Used only when sync is on, to keep encrypted data in Tabroost’s own bookmark folder. It does not read or change your other bookmarks. If you take it back, sync pauses and your data on this computer stays complete.',
  sessions: 'Tabs Chrome just closed',
  sessionsWhy: 'Reads Chrome’s “recently closed” list so a lost tab can be reopened. It is read only when you open the recovery screen.',
  grantHost: 'Allow checking forms and video before sleeping a tab',
  hintOn: 'Automatic sleep is paused because checking forms and video before sleeping is not allowed yet. Your tabs are not put to sleep until you allow it (this protects text you typed).',
  hintOff: 'If you turn on automatic sleep, Tabroost needs permission to check forms and video before sleeping a tab, so typed text is never lost.',
  hintOk: 'Checking forms and video before sleeping a tab: allowed',
  denied: 'Not allowed. Nothing has changed.',
  dismiss: 'Dismiss',
  welcome: 'Note: automatic sleep starts working once you allow Tabroost to check forms and video before sleeping a tab (you can do this later in Settings > Permissions asked later). Without it, tabs are not put to sleep.',
  rcOff: 'The “tabs Chrome just closed” list is not turned on. Turn it on to see tabs you just closed (everything else works without it).',
  rcBtn: 'Turn on',
  revoked: 'Permission taken back. Your saved data was not deleted.',
};

let lang = 'th';
const L = () => (lang === 'en' ? EN : TH);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

async function readLang() {
  try { const r = await chrome.storage.local.get('settings'); lang = resolveLang(r.settings && r.settings.language ? r.settings.language : 'th'); } catch { lang = 'th'; }
}
async function autoSuspendOn() {
  try { const r = await chrome.storage.local.get('settings'); return !(r.settings && r.settings.autoSuspend === false); } catch { return true; }
}

let toastFn = () => {};
const redraws = new Set();
function redrawAll() { for (const f of redraws) { try { f(); } catch { /* ignore */ } } }

/** Grant button: request() is the first call in the handler (user gesture). */
function grantBtn(name, label, extra) {
  return h('button', { type: 'button', class: 'btn primary', 'data-perm': name, text: label, onclick: () => {
    request(name).then((ok) => { if (!ok) toastFn(L().denied); redrawAll(); if (extra) extra(ok); });
  } });
}

function permRow(name, granted) {
  const T = L();
  const st = h('span', { class: granted ? 'muted' : 'muted', 'data-perm-state': granted ? 'on' : 'off', text: granted ? '✓ ' + T.on : T.off });
  const btn = granted
    ? h('button', { type: 'button', class: 'btn', 'data-perm-revoke': name, text: T.revoke, onclick: () => { remove(name).then((ok) => { if (ok) toastFn(T.revoked); redrawAll(); }); } })
    : grantBtn(name, T.grant);
  return h('div', { class: 'srow permrow', 'data-perm-row': name },
    h('span', { class: 'sl' }, h('b', { text: T[name] }), h('small', { text: T[name + 'Why'] })),
    h('span', { class: 'row' }, st, btn));
}

async function drawCard(root) {
  const T = L();
  const s = await snapshot();
  const nav = document.querySelector('#navPerms');
  if (nav) nav.textContent = T.title;
  root.replaceChildren(h('h2', { text: T.title }), h('p', { class: 'muted', text: T.intro }), ...NAMES.map((n) => permRow(n, s[n])));
}

async function drawHint(root) {
  const T = L();
  const [on, ok] = await Promise.all([autoSuspendOn(), has('host')]);
  if (ok) { root.hidden = false; root.replaceChildren(h('p', { class: 'muted', 'data-perm-hint': 'ok', text: T.hintOk })); return; }
  root.hidden = false;
  root.replaceChildren(
    h('p', { class: 'muted', 'data-perm-hint': on ? 'paused' : 'needed', text: on ? T.hintOn : T.hintOff }),
    h('div', { class: 'row' }, grantBtn('host', T.grantHost)));
}

async function drawBanner(root) {
  const T = L();
  let dismissed = false;
  try { dismissed = !!(await chrome.storage.local.get(DISMISS_KEY))[DISMISS_KEY]; } catch { /* show */ }
  const [on, ok] = await Promise.all([autoSuspendOn(), has('host')]);
  if (ok || !on || dismissed) { root.hidden = true; root.replaceChildren(); return; }
  root.hidden = false;
  root.replaceChildren(
    h('span', { text: T.hintOn + ' ' }),
    grantBtn('host', T.grantHost),
    h('button', { type: 'button', class: 'btn', 'data-perm-dismiss': '1', text: T.dismiss, onclick: () => { chrome.storage.local.set({ [DISMISS_KEY]: Date.now() }).catch(() => {}); root.hidden = true; root.replaceChildren(); } }));
}

function drawWelcome(root) { root.textContent = L().welcome; }

/** Small row for the "recently closed" area when the sessions permission is missing. */
export function sessionsHint() {
  const T = L();
  const box = h('div', { class: 'r permhint', 'data-perm-hint': 'sessions' }, h('span', { class: 'muted', text: T.rcOff }));
  box.append(h('button', { type: 'button', class: 'btn primary', text: T.rcBtn, onclick: () => { request('sessions').then((ok) => { if (ok) { box.replaceChildren(h('span', { class: 'muted', text: '✓ ' + T.on })); redrawAll(); } else toastFn(T.denied); }); } }));
  return box;
}

function watch() {
  try {
    chrome.permissions.onAdded.addListener(redrawAll);
    chrome.permissions.onRemoved.addListener(redrawAll);
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) readLang().then(redrawAll); });
  } catch { /* not an extension page */ }
}

export async function initPermsUi({ toast } = {}) {
  if (toast) toastFn = toast;
  await readLang();
  const targets = [['#s-perms', drawCard], ['#permSleepHint', drawHint], ['#permBanner', drawBanner]];
  for (const [sel, fn] of targets) {
    const el = document.querySelector(sel);
    if (el) { const f = () => fn(el); redraws.add(f); f(); }
  }
  const w = document.querySelector('#permWelcome');
  if (w) { const f = () => drawWelcome(w); redraws.add(f); f(); }
  watch();
}

export async function mountPopupHint(root) {
  await readLang();
  const f = async () => {
    const [on, ok] = await Promise.all([autoSuspendOn(), has('host')]);
    if (ok || !on) { root.hidden = true; root.replaceChildren(); return; }
    root.hidden = false;
    root.replaceChildren(h('div', { class: 'muted', 'data-perm-hint': 'paused', text: L().hintOn }), grantBtn('host', L().grantHost));
  };
  redraws.add(f);
  await f();
  watch();
}
