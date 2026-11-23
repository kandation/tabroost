// Dashboard VIEW inside stash.html (lazy-loaded on first open with dynamic import; the list's first paint never pays for it). Does NOT load the list page's virtual list or any item: it reads the small `groups` store once (G), the `activity`
// day rows (D), siteIdx / trash / snapshots lazily, and renders each card only when it scrolls into view (IntersectionObserver).
// Refresh: the SW broadcasts (changed / activity:changed / settings) -> 1500 ms debounce -> only the rendered cards re-run.

import * as db from './lib/db.js';
import { getSettings } from './lib/settings.js';
import * as bus from './lib/bus.js';
import { resolveLang } from './lib/i18n.js';
import { TH, EN } from './lib/dashstr.js';
import { fmtAbs, fmtAgo, calendarName, dayKey, weekKey } from './lib/time.js';
import { bar, hbar, donut, heat, stack } from './lib/charts.js';
import { stateLabel } from './lib/syncui.js';

const t0 = performance.now();
let root = null; // the #dashView element of stash.html
let ctx = null; // { settings, groups(), toast(text) } from the page
let visible = false;
const $ = (s) => root.querySelector(s);
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const DAY = 86400000;
const nf = new Intl.NumberFormat('en-US');
const send = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => res(r || {})); } catch { res({}); } });

let settings = {};
let lang = 'th';
let S = TH;
let G = [];
let on = true; // activityTracking
let D = null; // day rows (Map key -> row), loaded once per refresh
let cal = 'auto';
const cache = {}; // lazy shared promises: sites, trash, snaps, cats

const fmtMB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const dkOf = (ms) => 'd:' + dayKey(ms);
function parseDk(k) { const n = Number(k.slice(2)); return new Date(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100); }

async function loadD() {
  if (!on) { D = new Map(); return; }
  const rows = await db.actRowsFrom(dkOf(Date.now() - 400 * DAY), 'd:\uffff');
  D = new Map(rows.map((r) => [r.k, r]));
}
const lastDays = (n) => { const out = []; const base = new Date(); base.setHours(12, 0, 0, 0); for (let i = n - 1; i >= 0; i--) out.push(dkOf(base.getTime() - i * DAY)); return out; };
const sum = (keys, f) => keys.reduce((a, k) => a + ((D.get(k) && D.get(k)[f]) || 0), 0);

const lazy = (name, fn) => cache[name] || (cache[name] = fn());

// ---------- helpers for card bodies ----------
function offBox() {
  const b = mk('div', 'empty');
  b.append(mk('span', '', S.offTitle));
  const btn = mk('button', 'btn', S.offBtn);
  btn.type = 'button';
  btn.addEventListener('click', async () => { await send({ type: 'saveSettings', patch: { activityTracking: true } }); });
  b.appendChild(btn);
  return b;
}
function emptyBox(text) {
  const b = mk('div', 'empty');
  b.appendChild(mk('span', '', text || S.emptyTitle));
  const a = mk('a', 'btn primary', S.emptyStash); a.href = '#list';
  b.appendChild(a);
  return b;
}
const avatar = (host) => { let h = 0; for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360; const a = mk('span', 'fav', (host[0] || '?').toUpperCase()); a.style.background = `hsl(${h} 45% 40%)`; return a; };

// ---------- cards ----------
const CARDS = [
  { id: 'overview', span: 2, h: 150, tags: ['groups'], render(b) {
    const tabs = G.reduce((a, g) => a + g.count, 0);
    const kv = mk('div', 'kv');
    const add = (k, v, id) => { const d = mk('div'); d.append(mk('div', 'k', k)); const vv = mk('div', 'v', v); if (id) vv.id = id; d.appendChild(vv); kv.appendChild(d); };
    add(S.ovTabs, nf.format(tabs)); add(S.ovSets, nf.format(G.length)); add(S.ovSites, '…', 'ovSites'); add(S.ovStore, '…', 'ovStore');
    const dates = G.map((g) => g.createdAt);
    add(S.ovOldest, dates.length ? fmtAbs(Math.min(...dates), lang, calendarName(cal), true) : '—');
    add(S.ovNewest, dates.length ? fmtAbs(Math.max(...dates), lang, calendarName(cal), true) : '—');
    b.appendChild(kv);
    navigator.storage.estimate().then((e) => { const x = $('#ovStore'); if (x) x.textContent = fmtBytes(e.usage || 0); }).catch(() => {});
    lazy('sites', loadSites).then((m) => { const x = $('#ovSites'); if (x) x.textContent = nf.format(m.size); });
  } },
  { id: 'ram', span: 2, h: 150, tags: ['activity'], star: true, async render(b) {
    const info = (await send({ type: 'ram:info' })) || {};
    const mb = info.mb || 100;
    const k = lastDays(7);
    const today = D.get(dkOf(Date.now())); const ramToday = today ? today.ram || 0 : 0;
    const all = [...D.values()].reduce((a, r) => a + (r.ram || 0), 0);
    const kv = mk('div', 'kv');
    for (const [l, v] of [[S.ramToday, ramToday], [S.ram7, sum(k, 'ram')], [S.ramAll, all]]) { const d = mk('div'); d.append(mk('div', 'k', l)); const vv = mk('div', 'v', '~' + fmtMB(v)); vv.title = S.ramTip(Math.round(v / mb), mb); d.appendChild(vv); kv.appendChild(d); }
    b.append(kv, mk('p', 'note', S.ramNote + ' · ' + mb + ' MB/' + (lang === 'en' ? 'tab' : 'แท็บ')));
  } },
  { id: 'timeline', span: 2, h: 230, tags: ['activity'], star: true, render(b) {
    const box = mk('div'); const seg = mk('div', 'seg');
    let range = 30;
    const draw = () => {
      box.textContent = '';
      let keys = lastDays(range); let data;
      if (range > 90) {
        const weeks = new Map();
        for (const k of keys) { const w = weekKey(parseDk(k).getTime()); weeks.set(w, (weeks.get(w) || 0) + ((D.get(k) && D.get(k).s) || 0)); }
        data = [...weeks].map(([l, v]) => ({ label: l, value: v, tip: l }));
      } else data = keys.map((k) => ({ label: k.slice(8), value: (D.get(k) && D.get(k).s) || 0, tip: fmtAbs(parseDk(k).getTime(), lang, calendarName(cal), true) }));
      box.appendChild(bar(data, { S, aria: S.cTimeline + ' · ' + S.range(range) + (range > 90 ? ' · ' + S.perWeek : ''), height: 140, fmt: (v) => S.tabsN(v), labelEvery: Math.ceil(data.length / 8) }));
    };
    for (const r of [30, 90, 365]) { const x = mk('button', '', S.range(r)); x.type = 'button'; x.setAttribute('aria-pressed', String(r === range)); x.addEventListener('click', () => { range = r; for (const y of seg.children) y.setAttribute('aria-pressed', String(y === x)); draw(); }); seg.appendChild(x); }
    b.append(seg, box); draw();
  } },
  { id: 'heat', span: 2, h: 230, tags: ['activity'], star: true, render(b) {
    const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let any = false;
    for (const k of lastDays(90)) { const r = D.get(k); if (r && r.h) { const wd = parseDk(k).getDay(); r.h.forEach((v, h) => { m[wd][h] += v; if (v) any = true; }); } }
    if (!any) { b.appendChild(mk('p', 'note', S.emptyTitle)); return; }
    const tot = m.map((r) => r.reduce((a, c) => a + c, 0));
    b.appendChild(heat(m, { S, aria: S.cHeat, wdShort: S.wdS, hourLabel: S.hourN }));
    let streak = 0; const keys = lastDays(400).reverse();
    for (let i = 0; i < keys.length; i++) { const v = (D.get(keys[i]) && D.get(keys[i]).s) || 0; if (v > 0) streak++; else if (i === 0) continue; else break; }
    b.appendChild(mk('p', 'note', S.busiest(S.wd[tot.indexOf(Math.max(...tot))]) + ' · ' + S.streak(streak)));
  } },
  { id: 'top', span: 2, h: 300, tags: ['groups', 'activity'], async render(b) {
    const sites = await lazy('sites', loadSites);
    const rows = [...sites].sort((a, c) => c[1] - a[1]).slice(0, 10);
    if (!rows.length) { b.appendChild(emptyBox()); return; }
    let trend = new Map();
    if (on) {
      const wr = await db.actRowsFrom('w:', 'w:\uffff');
      const cur = weekKey(Date.now()); const prev = wr.filter((r) => r.k !== 'w:' + cur).slice(-4); const now = wr.find((r) => r.k === 'w:' + cur);
      for (const [h] of rows) { const avg = prev.length ? prev.reduce((a, r) => a + ((r.hosts && r.hosts[h]) || 0), 0) / prev.length : 0; const c = now && now.hosts ? now.hosts[h] || 0 : 0; if (avg || c) trend.set(h, c > avg * 1.25 ? 1 : c < avg * 0.75 ? -1 : 0); }
    }
    b.appendChild(hbar(rows.map(([h, n]) => { const t = trend.get(h); const x = mk('span', 'hx' + (t > 0 ? ' up' : t < 0 ? ' down' : ''), t > 0 ? '▲' : t < 0 ? '▼' : ''); if (t != null) x.title = t > 0 ? S.trendUp : t < 0 ? S.trendDown : S.trendFlat; return { label: h, value: n, icon: avatar(h), extra: x }; }), { S, aria: S.cTop }));
  } },
  { id: 'cats', span: 1, h: 240, tags: ['groups'], async render(b) {
    const cats = await lazy('cats', () => db.listCategories());
    const by = new Map();
    for (const g of G) by.set(g.cat || '', (by.get(g.cat || '') || 0) + g.count);
    const COL = { grey: 'var(--c-grey)', blue: 'var(--c-blue)', red: 'var(--c-red)', yellow: 'var(--c-yellow)', green: 'var(--c-green)', pink: 'var(--c-pink)', purple: 'var(--c-purple)', cyan: 'var(--c-cyan, #12a4af)', orange: 'var(--c-orange, #e8710a)' };
    const slices = [];
    for (const [id, n] of by) { const c = cats.find((x) => x.id === id); slices.push({ label: c ? c.name : S.noCat, value: n, color: c ? COL[c.color] : 'var(--muted)' }); }
    slices.sort((x, y) => y.value - x.value);
    if (!slices.length) { b.appendChild(emptyBox()); return; }
    b.appendChild(donut(slices.slice(0, 8), { S, aria: S.cCats, total: G.length }));
  } },
  { id: 'sizes', span: 1, h: 240, tags: ['groups'], render(b) {
    const cuts = [1, 5, 20, 50, 100]; const v = new Array(6).fill(0);
    for (const g of G) { let i = cuts.findIndex((c) => g.count <= c); if (i < 0) i = 5; v[i]++; }
    b.appendChild(hbar(v.map((n, i) => ({ label: S.sizeB[i], value: n })), { S, aria: S.cSizes }));
  } },
  { id: 'stale', span: 2, h: 300, tags: ['groups', 'activity'], render(b) {
    const cnt = new Array(6).fill(0); const now = Date.now();
    const bi = (ms) => { const d = ms / DAY; return d < 1 ? 0 : d < 7 ? 1 : d < 30 ? 2 : d < 90 ? 3 : 4; };
    for (const g of G) { if (g.archived) continue; const i = on ? (g.tm && g.tm.luMax ? bi(now - g.tm.luMax * 60000) : 5) : bi(now - g.createdAt); cnt[i] += g.count; }
    b.appendChild(stack(cnt.map((v, i) => ({ label: S.buckets[i], value: v, color: i === 5 ? 'var(--muted)' : ['var(--ok)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-orange, #e8710a)', 'var(--danger)'][i] })), { S, aria: S.cStale }));
    if (!on) b.appendChild(mk('p', 'note', S.staleBy));
    const a = mk('a', 'btn', S.staleOpen); a.href = '#stale'; b.appendChild(a);
    if (on) {
      const hi = new Array(8).fill(0); const hl = new Array(8).fill(0);
      for (const r of D.values()) { if (r.hi) r.hi.forEach((v, i) => { hi[i] += v; }); if (r.hl) r.hl.forEach((v, i) => { hl[i] += v; }); }
      if (hi.some(Boolean)) { b.appendChild(mk('h2', '', S.cIdle)); b.appendChild(bar(hi.map((v, i) => ({ label: S.hBuckets[i], value: v })), { S, aria: S.cIdle, height: 70, labelEvery: 0 })); }
      if (hl.some(Boolean)) { b.appendChild(mk('h2', '', S.cLife)); b.appendChild(bar(hl.map((v, i) => ({ label: S.hBuckets[i], value: v })), { S, aria: S.cLife, height: 70, labelEvery: 0 })); }
    }
  } },
  { id: 'dup', span: 2, h: 260, tags: ['groups'], async render(b) {
    const cs = await send({ type: 'cleanSummary' });
    const top = mk('div', 'row');
    top.appendChild(mk('span', 'big', String(cs.duplicates || 0)));
    top.appendChild(mk('span', 'note', S.dupNow(cs.duplicates || 0)));
    const btn = mk('button', 'btn', S.dupClean); btn.type = 'button'; btn.disabled = !cs.duplicates;
    btn.addEventListener('click', async () => { await send({ type: 'closeDuplicatesNow' }); toast(S.done); refresh(['groups']); });
    top.appendChild(btn); b.appendChild(top);
    b.appendChild(mk('h2', '', S.biggest));
    const ul = mk('ul', 'list');
    for (const g of [...G].sort((x, y) => y.count - x.count).slice(0, 5)) {
      const li = mk('li'); li.append(mk('span', 't', g.title || fmtAbs(g.createdAt, lang, calendarName(cal), true)), mk('span', 'w', S.tabsN(g.count)));
      const a = mk('a', 'lk', S.openIt); a.href = '#g=' + encodeURIComponent(g.id); li.appendChild(a); ul.appendChild(li);
    }
    b.appendChild(ul);
  } },
  { id: 'recent', span: 2, h: 260, tags: ['activity', 'groups'], star: true, async render(b) {
    const rows = (await db.actRowsFrom('e:', 'e:\uffff')).slice(-20).reverse();
    if (!rows.length) { b.appendChild(mk('p', 'note', S.emptyTitle)); return; }
    const ul = mk('ul', 'list');
    const gm = new Map(G.map((g) => [g.id, g]));
    let ls = null; try { ls = (await db.getMeta()).lastStash || null; } catch { /* ignore */ }
    let undoShown = false; // only the newest save can be undone, and only while the app itself still offers it (meta.lastStash + the set still exists)
    for (const r of rows) {
      const li = mk('li'); const f = S.ev[r.type] || (() => r.type);
      const g = r.gid ? gm.get(r.gid) : null;
      li.append(mk('span', 't', f(r.n) + (r.gid ? ' · ' + (g ? (g.title || fmtAbs(g.createdAt, lang, calendarName(cal), true)) : S.goneSet) : '')), mk('span', 'w', fmtAgo(Date.now() - r.t, lang)));
      if (g) { const a = mk('a', 'lk', S.openIt); a.href = '#g=' + encodeURIComponent(g.id); li.appendChild(a); }
      if (!undoShown && r.type === 'stash' && g && ls && ls.groupId === g.id) {
        undoShown = true;
        const u = mk('button', 'btn sm', S.undoIt); u.type = 'button';
        u.addEventListener('click', async () => { u.disabled = true; const x = await send({ type: 'undoLastStash' }); if (x && !x.error) { toast(S.done); refresh(['groups', 'activity']); } else { toast(S.undoGone); refresh(['groups']); } });
        li.appendChild(u);
      }
      ul.appendChild(li);
    }
    b.appendChild(ul);
  } },
  { id: 'trash', span: 2, h: 190, tags: ['trash', 'groups'], async render(b) {
    const tr = await db.listTrash();
    const del = tr.groups.filter((g) => g.delReason !== 'opened').length + tr.items.filter((e) => e.delReason !== 'opened').length;
    const opened = tr.groups.filter((g) => g.delReason === 'opened').length + tr.items.filter((e) => e.delReason === 'opened').length;
    const snaps = await db.snapList();
    const kv = mk('div', 'kv');
    const add = (k, v) => { const d = mk('div'); d.append(mk('div', 'k', k), mk('div', 'v', v)); kv.appendChild(d); };
    add(S.trashDeleted, S.trashN(del)); add(S.trashOpened, S.trashN(opened));
    add(S.snapLast, snaps.length ? fmtAgo(Date.now() - snaps[0].ts, lang) + ' · ' + S.snapCount(snaps.length) : S.snapNone);
    b.appendChild(kv);
    const a = mk('a', 'btn', S.snapRestore); a.href = '#list'; b.appendChild(a);
  } },
  { id: 'live', span: 2, h: 170, tags: ['live'], async render(b) {
    const lv = (await send({ type: 'dash:live' })) || {};
    const kv = mk('div', 'kv');
    const add = (k, v) => { const d = mk('div'); d.append(mk('div', 'k', k), mk('div', 'v', v)); kv.appendChild(d); };
    add(S.lvOpen, nf.format(lv.open || 0)); add(S.lvSleep, nf.format(lv.sleeping || 0)); add(S.lvMedia, nf.format(lv.media || 0)); add(S.lvRam, lv.ratio != null ? Math.round(lv.ratio * 100) + '% · ' + fmtMB((lv.freeBytes || 0) / 1048576) : '—');
    b.appendChild(kv);
  } },
  { id: 'syncs', span: 2, h: 130, tags: ['groups', 'live'], async render(b) {
    const lk = await send({ type: 'lock.status' });
    if (lk && lk.enabled) { b.append(mk('p', 'note', S.syncLocked)); return; }
    const r = await send({ type: 'sync/getStatus' });
    const st = r && r.ok ? r.status : null;
    if (!st || !st.enabled) { b.appendChild(mk('p', 'note', S.syncOff)); const a = mk('a', 'btn', S.qSet); a.href = '#settings'; b.appendChild(a); return; }
    const kv = mk('div', 'kv');
    const add = (k, v) => { const d = mk('div'); d.append(mk('div', 'k', k), mk('div', 'v', v)); kv.appendChild(d); };
    add(S.syncState, stateLabel(st)); add(S.syncLast, st.lastSync ? fmtAgo(Date.now() - st.lastSync, lang) : '—'); add(S.syncPending, nf.format(st.pending || 0)); add(S.syncDevices, nf.format((st.devices || []).length));
    b.appendChild(kv);
  } },
  { id: 'day', span: 2, h: 190, tags: ['groups'], render(b) {
    const now = new Date(); const dom = now.getDate();
    const hits = G.filter((g) => { const d = new Date(g.createdAt); return d.getDate() === dom && now.getTime() - g.createdAt > 25 * DAY; }).sort((x, y) => y.createdAt - x.createdAt).slice(0, 6);
    if (!hits.length) { b.appendChild(mk('p', 'note', S.dayNone)); return; }
    const ul = mk('ul', 'list');
    for (const g of hits) {
      const months = Math.round((now.getTime() - g.createdAt) / (30.4 * DAY));
      const li = mk('li'); li.append(mk('span', 't', g.title || fmtAbs(g.createdAt, lang, calendarName(cal), true)), mk('span', 'w', months >= 12 ? S.yearsAgo(Math.round(months / 12)) : S.monthsAgo(months)));
      ul.appendChild(li);
    }
    b.appendChild(ul);
  } },
  { id: 'quick', span: 4, h: 100, tags: [], render(b) {
    const row = mk('div', 'row');
    const act = (label, fn, primary) => { const x = mk('button', 'btn' + (primary ? ' primary' : ''), label); x.type = 'button'; x.addEventListener('click', fn); row.appendChild(x); };
    act(S.qStash, async () => { await send({ type: 'stashNow', scope: 'all' }); toast(S.done); }, true);
    act(S.qDup, async () => { await send({ type: 'closeDuplicatesNow' }); toast(S.done); });
    const a = mk('a', 'btn', S.qSet); a.href = '#settings'; row.appendChild(a);
    b.appendChild(row);
  } },
];
const TITLES = { overview: 'cOverview', ram: 'cRam', timeline: 'cTimeline', heat: 'cHeat', top: 'cTop', cats: 'cCats', sizes: 'cSizes', stale: 'cStale', dup: 'cDup', recent: 'cRecent', trash: 'cTrash', live: 'cLive', syncs: 'cSync', day: 'cDay', quick: 'cQuick' };

async function loadSites() {
  const rows = await db.listSiteIdx();
  const m = new Map();
  for (const r of rows) m.set(r.site, (m.get(r.site) || 0) + r.n);
  return m;
}

function toast(t) { if (ctx && ctx.toast) ctx.toast(t); }

// ---------- rendering ----------
const nodes = new Map(); // id -> {card, body, done}
async function renderCard(c) {
  const n = nodes.get(c.id);
  if (!n) return;
  const body = mk('div', 'body');
  body.style.display = 'contents';
  if (c.star && !on) body.appendChild(offBox());
  else { try { await c.render(body); } catch (e) { body.appendChild(mk('p', 'note', String(e && e.message || e))); } }
  n.card.classList.remove('skel');
  const old = n.card.querySelector('.body');
  if (old) old.replaceWith(body); else n.card.appendChild(body);
  n.done = true;
}
function build() {
  const grid = $('#dgrid');
  grid.textContent = '';
  const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); renderCard(CARDS.find((c) => c.id === e.target.dataset.id)); } }, { rootMargin: '200px' });
  for (const c of CARDS) {
    const card = mk('section', 'card skel'); card.dataset.id = c.id; card.dataset.span = String(c.span); card.style.setProperty('--h', c.h + 'px');
    card.setAttribute('aria-label', S[TITLES[c.id]]);
    card.appendChild(mk('h2', '', S[TITLES[c.id]]));
    card.appendChild(mk('div', 'body'));
    grid.appendChild(card);
    nodes.set(c.id, { card, done: false });
    if (c.id === 'overview') renderCard(c); else io.observe(card);
  }
}
let timer = 0; const pending = new Set(); const dirty = new Set();
function refresh(tags) {
  if (!visible) { for (const t of tags) dirty.add(t); return; } // hidden: remember, refresh when shown again
  for (const t of tags) pending.add(t);
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const tg = new Set(pending); pending.clear();
    try { G = await db.listGroups(); if (tg.has('activity')) await loadD(); } catch { return; }
    for (const k of Object.keys(cache)) if (tg.has('groups') || tg.has('trash')) delete cache[k];
    for (const c of CARDS) { const n = nodes.get(c.id); if (n && n.done && c.tags.some((t) => tg.has(t))) renderCard(c); }
  }, 1500);
}

function applySettings(s) {
  settings = s;
  lang = resolveLang(settings.language);
  S = lang === 'en' ? { ...TH, ...EN } : TH;
  cal = settings.dateCalendar;
  on = settings.activityTracking !== false;
}

/** Builds the view once. c = { settings, groups(): shared group summaries of the page, toast(text), reload() } */
export async function mount(el, c) {
  root = el; ctx = c;
  applySettings(c.settings);
  root.textContent = '';
  root.appendChild(mk('p', 'dsub', S.sub));
  const grid = mk('div', 'dgrid'); grid.id = 'dgrid'; grid.setAttribute('aria-live', 'polite');
  root.appendChild(grid);
  G = c.groups().slice();
  await loadD();
  build();
  requestAnimationFrame(() => { globalThis.__dash = { firstPaintMs: Math.round(performance.now() - t0), groups: G.length }; });
}
export function show() { visible = true; if (dirty.size) { const t = [...dirty]; dirty.clear(); refresh(t); } }
export function hide() { visible = false; }
/** the page's broadcast channel (stash.js forwards every message) */
export function onBus(m) {
  if (!root || !m) return;
  if (m.type === 'changed') refresh(['groups', 'trash', 'live']);
  else if (m.type === 'activity:changed') refresh(['activity', 'live']);
}
/** settings changed (language, tracking, calendar): rebuild from scratch */
export async function remount(s) { nodes.clear(); for (const k of Object.keys(cache)) delete cache[k]; await mount(root, { ...ctx, settings: s }); }
