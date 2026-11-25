// Toolbar popup (only used when the setting "When the icon is clicked" = popup). Reads the DB read-only; changes go to the
// service worker through runtime messages. No inline scripts.

const STR = {
  appName: 'Tabroost',
  statusLbl: 'สถานะ',
  recentTitle: 'ชุดแท็บล่าสุด',
  meter: (p) => `แรมว่าง ${p}%`,
  tabsN: (n) => `${n} แท็บ`,
  stashTab: 'เก็บแท็บนี้',
  stashWindow: 'เก็บทั้งหน้าต่างนี้',
  stashAll: 'เก็บทุกหน้าต่าง',
  includePinned: 'รวมแท็บที่ปักหมุดด้วย',
  openList: 'เปิดรายการที่เก็บไว้',
  dupNow: 'ปิดแท็บซ้ำตอนนี้',
  cleanAll: 'จัดระเบียบแท็บตอนนี้',
  refreshAll: 'รีเฟรชทุกแท็บในหน้าต่างนี้',
  refreshCancel: 'ยกเลิก',
  refreshText: (d, t) => `กำลังรีเฟรช ${d}/${t}`,
  refreshNone: 'ไม่มีแท็บที่ต้องรีเฟรช',
  refreshNoAccess: (n) => `แท็บที่เปิดอยู่ ${n} แท็บจะถูกข้าม เพราะยังไม่ได้อนุญาตให้ตรวจฟอร์มค้างก่อนรีเฟรช (ดูปุ่ม "อนุญาต" ด้านล่าง)`,
  refreshStarted: (n) => `เริ่มรีเฟรช ${n} แท็บแล้ว (ทำเบื้องหลัง)`,
  dupDone: (n) => (n ? `ปิดแท็บซ้ำแล้ว ${n} แท็บ` : 'ไม่พบแท็บซ้ำ'),
  audibleWarn: (n) => `มีแท็บที่กำลังเล่นเสียง ${n} แท็บ ถ้าเก็บ เสียงจะหยุด
เก็บต่อไหม?`,
  cleanNothing: 'ไม่มีอะไรต้องจัดระเบียบ',
  dlgOk: 'ตกลง', dlgCancel: 'ยกเลิก', dlgSave: 'เก็บแท็บ', dlgClean: 'จัดระเบียบแท็บ',
  cleanConfirm: (s) => `จัดระเบียบแท็บตอนนี้ จะทำดังนี้\n• ปิดแท็บที่ซ้ำกัน ${s.duplicates} แท็บ (เปิดกลับได้)\n• หน้าภายในของ Chrome: ปิดทิ้ง ${s.internalClose} แท็บ · เก็บไว้ในรายการแล้วปิด ${s.internalSave} แท็บ\n• พักแท็บที่ไม่ได้ใช้ ${s.idle} แท็บ (ยังอยู่ในแถบแท็บ กดแล้วจะโหลดใหม่)\n\nแท็บทั่วไปที่คุณใช้อยู่จะไม่ถูกปิด ต้องการทำต่อหรือไม่?`,
  cleanDone: (r) => `จัดระเบียบแล้ว: ปิดแท็บซ้ำ ${r.duplicates} · ปิดหน้าภายในของ Chrome ${r.internalClosed} · เก็บหน้าภายในไว้ในรายการ ${r.internalSaved}`,
  stLinks: 'แท็บที่เก็บไว้',
  stDisc: 'แท็บที่พักอยู่',
  stFree: 'แรมว่าง',
  pause: 'หยุดชั่วคราว',
  resume: 'ทำต่อ',
  stop: 'หยุดปิดแท็บ',
  saving: (d, t) => `กำลังบันทึกแท็บ ${d}/${t} ยังไม่มีแท็บถูกปิด`,
  closing: (c, t, s, slow, lvl) => `กำลังปิดแท็บ ${c}/${t}${lvl ? ` · แรม${lvl}` : ''}${s ? ` · ข้าม ${s}` : ''}${slow ? ' · ช้า… กำลังรอ Chrome ตอบ' : ''}`,
  paused: (c, t) => `หยุดปิดแท็บชั่วคราว ${c}/${t}`,
  started: (n) => `เก็บ ${n} แท็บแล้ว กำลังทยอยปิดแท็บทีละส่วน…`,
  nothing: 'ไม่มีแท็บที่เก็บได้ตอนนี้ (หน้าภายในของ Chrome หรือเว็บที่ยกเว้นไว้จะไม่ถูกเก็บ)',
  error: (e) => `ทำไม่สำเร็จ: ${STR.errs[e] || e}`,
  sleepTitle: 'แท็บที่กำลังหลับ', sleepFor: (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return 'หลับมา ' + (m < 1 ? 'ไม่ถึงนาที' : m < 60 ? m + ' นาที' : m < 1440 ? Math.round(m / 60) + ' ชม.' : Math.round(m / 1440) + ' วัน'); },
  protTitle: 'แท็บที่ยังไม่ถูกพัก เพราะมีเหตุผลเหล่านี้',
  protKeep: 'คุณสั่งไม่ให้พัก', protAudible: 'กำลังมีเสียง', protWhitelist: 'เว็บนี้อยู่ในรายการที่ไม่พัก', protPlaying: 'กำลังเล่นวิดีโอหรือเสียง (ปิดเสียงอยู่)',
  protPaused: (m) => `หยุดเล่นไว้ · เล่นล่าสุดเมื่อ ${m} นาทีก่อน`, protEnded: 'เล่นจบแล้ว รอพัก', protRecent: (m) => `เพิ่งเล่นเมื่อ ${m} นาทีก่อน`,
  protSplit: 'อีกฝั่งของ split view กำลังใช้อยู่', protAllow: 'ให้พักได้', protWlOff: 'เลิกยกเว้นเว็บนี้',
  errs: { 'db-unavailable': 'เปิดที่เก็บข้อมูลของส่วนขยายไม่ได้ จึงยังไม่ได้ปิดแท็บใดๆ ลองปิดแล้วเปิด Chrome ใหม่', 'stash-page': 'ไม่สามารถเก็บหน้ารายการนี้เองได้ ให้สลับไปแท็บอื่นแล้วลองใหม่', 'write-failed': 'บันทึกแท็บไม่สำเร็จ แท็บทั้งหมดยังเปิดอยู่ ไม่มีอะไรหาย ลองใหม่อีกครั้ง', busy: 'กำลังทำงานอื่นอยู่ รอสักครู่แล้วลองใหม่', 'no response': 'ส่วนขยายยังไม่ตอบ ลองใหม่อีกครั้งในอีกสักครู่' },
  levels: { healthy: 'ยังพอ', low: 'เริ่มน้อย จึงปิดช้าลง', critical: 'น้อย จึงปิดช้ามาก', severe: 'น้อยมาก จึงปิดช้าที่สุด' },
};

import * as db from './lib/db.js';
import * as bus from './lib/bus.js';
import { getSettings } from './lib/settings.js';
import { initTheme } from './lib/theme.js';
import { mountPopupHint } from './lib/permsui.js';
import * as lockrt from './lib/lockrt.js';
import { LOCK_TH } from './lib/lockstr.js';
import { LOCK_EN, resolveLang } from './lib/i18n.js';
import { POP_EN } from './lib/popstr.js';
import { askConfirm } from './lib/dialogs.js';
const askGo = (message, title) => askConfirm({ title, message, okLabel: STR.dlgOk, cancelLabel: STR.dlgCancel });

initTheme();

const $ = (s) => document.querySelector(s);

// inline 1.5px-stroke icons (no external requests); each button opts in with data-icon
const ICONS = {
  layers: 'M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4', tab: 'M4 8a2 2 0 012-2h4l2 2h6a2 2 0 012 2v7a2 2 0 01-2 2H6a2 2 0 01-2-2V8z',
  window: 'M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM3 9h18', dedupe: 'M4 4h11v11H4zM9 20h9a2 2 0 002-2V9M8 8l3 3M11 8l-3 3',
  broom: 'M14 4l6 6M12 8l4 4M4 20l7-7 3 3-7 7H4zM9 13l2 2', refresh: 'M20 12a8 8 0 11-2.6-5.9M20 4v5h-5',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5', pause: 'M9 5v14M15 5v14', play: 'M8 5l11 7-11 7z', stop: 'M6 6h12v12H6z',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z',
};
function iconEl(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(ns, 'svg');
  sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('width', '16'); sv.setAttribute('height', '16'); sv.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.open); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  sv.appendChild(path);
  return sv;
}
function addIcons() {
  for (const b of document.querySelectorAll('button[data-icon]')) {
    const lab = b.textContent;
    b.textContent = '';
    b.append(iconEl(b.dataset.icon), Object.assign(document.createElement('span'), { textContent: lab }));
  }
}

async function renderProtected() {
  const r = await send({ type: 'protectedTabs' });
  const box = $('#protList');
  box.textContent = '';
  const list = (r.ok && r.tabs) || [];
  $('#protBox').hidden = !list.length;
  const why = (t) => ({ keep: STR.protKeep, audible: STR.protAudible, whitelist: STR.protWhitelist, 'media-playing': STR.protPlaying, 'media-paused': STR.protPaused(t.mins), 'media-ended': STR.protEnded, 'recent-audio': STR.protRecent(t.mins), 'split-partner': STR.protSplit }[t.kind] || t.kind);
  for (const t of list.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'prot';
    const main = document.createElement('div');
    main.className = 'pm';
    const ti = document.createElement('span'); ti.className = 'pt'; ti.textContent = t.title; ti.title = t.title;
    const re = document.createElement('span'); re.className = 'pr'; re.textContent = why(t);
    main.append(ti, re);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pb';
    b.dataset.act = 'unprotect'; b.dataset.tab = String(t.id); b.dataset.mode = t.kind === 'keep' ? 'clear' : t.kind === 'whitelist' ? 'whitelistOff' : 'allow'; b.dataset.host = t.host || '';
    b.title = t.kind === 'whitelist' ? STR.protWlOff : STR.protAllow;
    b.textContent = t.kind === 'whitelist' ? STR.protWlOff : STR.protAllow;
    if (t.kind === 'split-partner') row.append(main); else row.append(main, b); // nothing to allow on this tab: its partner decides
    box.appendChild(row);
  }
}
async function renderSleeping() {
  const r = await send({ type: 'sleepingTabs' });
  const box = $('#sleepList');
  box.textContent = '';
  const list = (r && r.tabs) || [];
  $('#sleepBox').hidden = !list.length;
  const now = Date.now();
  for (const t of list) {
    const row = document.createElement('div'); row.className = 'prot';
    const main = document.createElement('div'); main.className = 'pm';
    const ti = document.createElement('span'); ti.className = 'pt'; ti.textContent = t.title; ti.title = t.title;
    const re = document.createElement('span'); re.className = 'pr'; re.textContent = STR.sleepFor(now - t.z);
    main.append(ti, re); row.append(main); box.appendChild(row);
  }
}
let drain = null;

async function send(msg) {
  try { return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: 'no response' }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function renderDrain() {
  const box = $('#drain');
  if (!drain || drain.needsConfirm) { box.hidden = true; return; }
  box.hidden = false;
  if (drain.phase === 'writing') {
    $('#drainText').textContent = STR.saving(drain.done, drain.total);
    $('#drainBar').style.width = (drain.total ? Math.round((drain.done / drain.total) * 100) : 0) + '%';
    $('#btnPause').hidden = true;
    $('#btnResume').hidden = true;
    return;
  }
  $('#drainText').textContent = drain.paused ? STR.paused(drain.closed, drain.total) : STR.closing(drain.closed, drain.total, drain.skipped, drain.lastProgressAt && Date.now() - drain.lastProgressAt > 10000, STR.levels[drain.level]);
  $('#drainBar').style.width = (drain.total ? Math.round(((drain.closed + drain.skipped) / drain.total) * 100) : 0) + '%';
  $('#btnPause').hidden = !!drain.paused;
  $('#btnResume').hidden = !drain.paused;
}

async function renderRecent() {
  if (lockrt.isLocked()) { $('#recentBox').hidden = true; return; } // locked: titles are not shown
  try {
    const groups = (await db.listGroups()).filter((g) => g.phase === 'committed' && !g.archived).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
    const box = $('#recent');
    box.textContent = '';
    for (const g of groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.act = 'openList';
      const t = document.createElement('span');
      t.className = 'rt';
      t.textContent = g.title || new Date(g.createdAt).toLocaleString(numLocale, { dateStyle: 'medium', timeStyle: 'short' });
      const c = document.createElement('span');
      c.className = 'rc';
      c.textContent = STR.tabsN(g.count);
      b.append(t, c);
      box.appendChild(b);
    }
    $('#recentBox').hidden = !groups.length;
  } catch { /* db unavailable */ }
}

async function renderStats() {
  renderRecent();
  try {
    const groups = await db.listGroups();
    let n = 0;
    for (const g of groups) if (g.phase !== 'writing') n += g.count;
    $('#stLinks').textContent = n.toLocaleString(numLocale);
  } catch { $('#stLinks').textContent = '–'; }
  try { $('#stDisc').textContent = String((await chrome.tabs.query({ discarded: true })).length); } catch { /* ignore */ }
  try {
    const m = await chrome.system.memory.getInfo();
    const pct = m.capacity ? Math.round((m.availableCapacity / m.capacity) * 100) : null;
    $('#stFree').textContent = pct == null ? '–' : pct + '%';
    if (pct != null) { $('#meterTxt').textContent = STR.meter(pct); const f = $('#meterFill'); f.style.width = (100 - pct) + '%'; f.className = 'mf' + (pct < 12 ? ' crit' : pct < 25 ? ' low' : ''); }
  } catch { $('#stFree').textContent = '–'; }
}

async function currentWindowId() {
  try { return (await chrome.windows.getCurrent()).id; } catch { return undefined; }
}

/** Playing tabs inside what is about to be stashed (the icon click cannot ask; this popup can). */
async function audibleInScope(scope, includePinned) {
  try {
    const q = { audible: true };
    if (scope !== 'all') q.windowId = await currentWindowId();
    if (scope === 'tab') q.active = true;
    return (await chrome.tabs.query(q)).filter((t) => !t.incognito && (includePinned || !t.pinned)).length;
  } catch { return 0; }
}

async function stash(scope) {
  let warn = false;
  try { warn = !!(await getSettings()).warnAudibleStash; } catch { /* default: no warning */ }
  const aud = warn ? await audibleInScope(scope, $('#chkPinned').checked) : 0;
  if (aud && !(await askGo(STR.audibleWarn(aud), STR.dlgSave))) return;
  const btns = document.querySelectorAll('button[data-act^="stash"]');
  for (const b of btns) b.disabled = true;
  $('#msg').textContent = '';
  const r = await send({ type: 'stashNow', scope, includePinned: $('#chkPinned').checked, windowId: await currentWindowId() });
  for (const b of btns) b.disabled = false;
  if (!r.ok) { $('#msg').textContent = STR.error(r.error); return; }
  $('#msg').textContent = r.stashed ? STR.started(r.stashed) : STR.nothing;
  renderStats();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'stashTab': return stash('tab');
    case 'stashWindow': return stash('window');
    case 'stashAll': return stash('all');
    case 'dupNow': { const r = await send({ type: 'closeDuplicatesNow' }); $('#msg').textContent = r.ok ? STR.dupDone(r.closed) : STR.error(r.error); renderStats(); return null; }
    case 'cleanAll': {
      const s = await send({ type: 'cleanSummary' });
      if (!s.ok) { $('#msg').textContent = STR.error(s.error); return null; }
      if (!s.duplicates && !s.internalClose && !s.internalSave && !s.idle) { $('#msg').textContent = STR.cleanNothing; return null; }
      if (!(await askGo(STR.cleanConfirm(s), STR.dlgClean))) return null;
      const r = await send({ type: 'cleanAll', windowId: await currentWindowId() });
      $('#msg').textContent = r.ok ? STR.cleanDone(r) : STR.error(r.error);
      renderStats();
      return null;
    }
    case 'refreshAll': {
      const r = await send({ type: 'refreshAll', scope: 'window', windowId: await currentWindowId() });
      $('#msg').textContent = r.ok ? (r.total ? STR.refreshStarted(r.total) + (r.noAccess ? ' · ' + STR.refreshNoAccess(r.loaded) : '') : STR.refreshNone) : STR.error(r.error);
      return null;
    }
    case 'refreshCancel': return send({ type: 'refreshCancel' });
    case 'unprotect': { await send({ type: 'protectSet', tabId: Number(b.dataset.tab), mode: b.dataset.mode, host: b.dataset.host }); return renderProtected(); }
    case 'openList': await send({ type: 'openList', windowId: await currentWindowId() }); window.close(); return;
    case 'pause': return send({ type: 'drain:pause' });
    case 'resume': return send({ type: 'drain:resume' });
    case 'stop': return send({ type: 'drain:stop', dropRemaining: false });
    default: return null;
  }
});

bus.on((m) => {
  if (m && m.type === 'progress' && m.op === 'refresh') {
    const box = $('#refresh');
    if (m.finished || !m.job) { box.hidden = true; return; }
    box.hidden = false;
    $('#refreshText').textContent = STR.refreshText(m.job.done, m.job.total);
    $('#refreshBar').style.width = (m.job.total ? Math.round((m.job.done / m.job.total) * 100) : 0) + '%';
    return;
  }
  if (!m || m.type !== 'progress' || m.op !== 'stash') return;
  if (m.finished) { drain = null; renderDrain(); renderStats(); return; }
  drain = m.phase === 'writing' ? { phase: 'writing', done: m.done, total: m.total } : { ...m };
  renderDrain();
});

// password lock: locked = counts + an unlock button; the stash buttons keep working (they never need the key)
async function lockState() {
  try {
    const st = await lockrt.init({ useSession: true });
    if (!st.enabled) return;
    let L = LOCK_TH;
    try { if (resolveLang((await getSettings()).language) === 'en') L = { ...LOCK_TH, ...LOCK_EN }; } catch { /* Thai */ }
    const box = $('#lockBox');
    if (!st.locked) { box.hidden = true; return; }
    const groups = await db.listGroups();
    let n = 0;
    for (const g of groups) if (g.phase !== 'writing') n += g.count;
    $('#lockTxt').textContent = L.popLocked(n);
    const b = $('#lockBtn');
    b.textContent = L.popUnlock;
    b.onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('stash.html') }).then(() => window.close()).catch(() => {}); };
    box.hidden = false;
  } catch { /* db unavailable */ }
}
bus.on((m) => { if (m && m.type === 'lock.state') { lockrt.refresh().then(() => { lockState(); renderStats(); }).catch(() => {}); } });

let numLocale = 'th-TH'; // i18n-allow: default (Thai) locale for dates and numbers; switched to en-US in init() when the language is English
async function init() {
  try { if (resolveLang((await getSettings()).language) === 'en') { Object.assign(STR, POP_EN); document.documentElement.lang = 'en'; numLocale = 'en-US'; } } catch { /* Thai */ }
  for (const el of document.querySelectorAll('[data-s]')) el.textContent = STR[el.dataset.s];
  const stl = document.querySelector('.stats'); if (stl) stl.setAttribute('aria-label', STR.statusLbl);
  await lockState();
  try {
    const meta = await db.getMeta();
    drain = meta.drain && !meta.drain.needsConfirm ? { ...meta.drain } : null;
  } catch { /* db unavailable: buttons will report it */ }
  addIcons();
  renderDrain();
  renderStats();
  renderProtected();
  renderSleeping();
  mountPopupHint($('#permHint')).catch(() => {});
}

init();
