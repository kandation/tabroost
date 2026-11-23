// The filter panel (toolbar "ตัวกรอง"): header with a live summary, collapsible sections (date range, websites, categories,
// tab groups, status) and a sticky footer. It knows nothing about the page: stash.js passes in the filters, the facet counts and a
// few callbacks (see mountFilterPanel). All DOM is built with createElement/textContent (no innerHTML with data).
// Layout rule: ONE scroller (.fbody); everything else is normal flow. The calendar is built in here (no native date inputs):
// Monday-first month grid, Thai/English names, พ.ศ./ค.ศ. from the page setting, fully keyboard driven.
import * as Q from './query.js';
import { localeFor, calendarName } from './time.js';
import { TH, EN } from './filterstr.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function icon(name, cls) {
  const sv = document.createElementNS(SVGNS, 'svg');
  sv.setAttribute('class', 'mi' + (cls ? ' ' + cls : ''));
  sv.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  sv.appendChild(u);
  return sv;
}
const pad = (n) => String(n).padStart(2, '0');

// ---------- pure date helpers (also used by stash.js for the chip under the search box) ----------
/** Buddhist-era years? ('auto' follows the UI language: Thai -> พ.ศ.) */
export const useBE = (lang, cal) => cal === 'be' || (cal !== 'ce' && lang !== 'en');
/** dd/mm/yyyy in the chosen era */
export const fmtField = (ts, be) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear() + (be ? 543 : 0)}`; };
/** '' -> null (empty); a valid day -> [y, m, d] (m 0-based); anything else -> undefined. Years >= 2400 are read as พ.ศ.; two digits as 20xx. */
export function parseField(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2,4})$/.exec(s);
  if (!m) return undefined;
  let y = Number(m[3]);
  if (y >= 2400) y -= 543; else if (y < 100) y += 2000;
  const mo = Number(m[2]) - 1;
  const d = Number(m[1]);
  const t = new Date(y, mo, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo || t.getDate() !== d) return undefined;
  return [y, mo, d];
}
/** Readable range: "12 พ.ย. – 23 พ.ย. 2569". `toExcl` is the exclusive end (midnight after the last day). */
export function rangeLabel(from, toExcl, lang, cal, T) {
  const loc = localeFor(lang, calendarName(cal));
  const dm = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' });
  const dmy = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' });
  const t = T || (lang === 'en' ? EN : TH);
  if (from && toExcl) {
    const last = Q.addDays(toExcl, -1);
    if (Q.dayStart(from) === Q.dayStart(last)) return dmy.format(new Date(from));
    const sameYear = new Date(from).getFullYear() === new Date(last).getFullYear();
    return `${(sameYear ? dm : dmy).format(new Date(from))} – ${dmy.format(new Date(last))}`;
  }
  if (from) return t.since(dmy.format(new Date(from)));
  if (toExcl) return t.until(dmy.format(new Date(Q.addDays(toExcl, -1))));
  return '';
}

const FLAG_ICONS = { starred: 'star', locked: 'lock', pending: 'clock', pinned: 'pin', archived: 'box', named: 'edit', saved7: 'calendar', unused30: 'moon', open7: 'tab' };
const PRESETS = [['all', 'pAll'], ['today', 'pToday'], ['7d', 'p7'], ['30d', 'p30'], ['90d', 'p90'], ['year', 'pYear'], ['custom', 'pCustom']];
const TOP_SITES = 8;
const PAGE_ROWS = 40;

/**
 * deps: { lang(), calendar(), filters() -> live filter object, patch(fn) (mutates the filters, re-applies the list, re-renders),
 *         facets() -> {sites:[[host,n]], cats:Map, tgs:[[key,n]], flags:{}, siteMapReady}, cats() -> [{id,name,color}],
 *         summary() -> {tabs, sets}, hostIcon(host) -> Node, flagLabels, hasTm(), close(), clearAll() }
 */
export function mountFilterPanel(root, deps) {
  const st = { open: { date: true, sites: true, cats: true, tgs: true, status: true }, q: '', all: false, shown: PAGE_ROWS, custom: false, cal: null, calMonth: null, calFocus: 0, err: '', fromTxt: null, toTxt: null };
  const T = () => (deps.lang() === 'en' ? EN : TH);
  const be = () => useBE(deps.lang(), deps.calendar());

  root.textContent = '';
  root.classList.add('fpop');
  root.setAttribute('role', 'dialog');

  // ----- skeleton -----
  const head = mk('div', 'fhead');
  const titleRow = mk('div', 'ftitle');
  const title = mk('span');
  const xb = mk('button', 'icon sm fclose');
  xb.type = 'button'; xb.dataset.fk = 'close'; xb.appendChild(icon('close'));
  xb.addEventListener('click', () => deps.close());
  titleRow.append(title, xb);
  const sum = mk('div', 'fsum');
  sum.setAttribute('role', 'status'); sum.setAttribute('aria-live', 'polite');
  head.append(titleRow, sum);
  const body = mk('div', 'fbody');
  const foot = mk('div', 'ffoot');
  const clearBtn = mk('button', 'fbtn'); clearBtn.type = 'button'; clearBtn.dataset.fk = 'clear';
  const showBtn = mk('button', 'fbtn primary'); showBtn.type = 'button'; showBtn.dataset.fk = 'show';
  clearBtn.addEventListener('click', () => { st.custom = false; st.cal = null; st.err = ''; st.fromTxt = st.toTxt = null; st.q = ''; if (siteInput) siteInput.value = ''; deps.clearAll(); });
  showBtn.addEventListener('click', () => deps.close());
  foot.append(clearBtn, showBtn);
  root.append(head, body, foot);

  function section(id, iconName) {
    const el = mk('section', 'fsec');
    const h = mk('button', 'fsh'); h.type = 'button'; h.dataset.fk = 'h-' + id;
    const lab = mk('span', 'fshl');
    const meta = mk('span', 'fsm');
    h.append(icon(iconName), lab, meta, icon('expand', 'fchev'));
    const b = mk('div', 'fsb');
    const bid = 'fsb-' + id;
    b.id = bid; h.setAttribute('aria-controls', bid);
    h.addEventListener('click', () => { st.open[id] = !st.open[id]; paintOpen(id); });
    el.append(h, b);
    return { id, el, h, lab, meta, b };
  }
  const S = { date: section('date', 'calendar'), sites: section('sites', 'globe'), cats: section('cats', 'folder'), tgs: section('tgs', 'layers'), status: section('status', 'star') };
  body.append(S.date.el, S.sites.el, S.cats.el, S.tgs.el, S.status.el);
  function paintOpen(id) { const s = S[id]; const o = !!st.open[id]; s.h.setAttribute('aria-expanded', String(o)); s.b.hidden = !o; s.el.classList.toggle('closed', !o); }

  const pill = (n) => { const p = mk('span', 'fpill', String(n)); return p; };
  const setMeta = (s, sel, total) => { s.meta.textContent = ''; if (sel) { s.meta.appendChild(pill(sel)); s.meta.classList.add('on'); } else { s.meta.classList.remove('on'); if (total != null) s.meta.textContent = Number(total).toLocaleString(deps.lang() === 'en' ? 'en-US' : 'th-TH'); } };

  /** Re-render something while keeping scroll position and keyboard focus. */
  function keep(fn) {
    const a = document.activeElement;
    const fk = a && root.contains(a) ? a.getAttribute('data-fk') : null;
    const sc = body.scrollTop;
    fn();
    body.scrollTop = sc;
    if (fk) { const n = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (n && n !== document.activeElement && !n.disabled) n.focus({ preventScroll: true }); }
  }

  const chip = (key, label, { on, count, iconNode, disabled, title: tip, fk, onClick, role = 'checkbox' }) => {
    const b = mk('button', 'fchip');
    b.type = 'button'; b.setAttribute('role', role); b.setAttribute('aria-checked', String(!!on)); b.dataset.fk = fk;
    if (iconNode) b.appendChild(iconNode);
    b.appendChild(mk('span', 'fcl', label));
    if (count != null) b.appendChild(mk('span', 'fcn', Number(count).toLocaleString(deps.lang() === 'en' ? 'en-US' : 'th-TH')));
    if (on) b.appendChild(icon('check', 'fck'));
    if (disabled) { b.setAttribute('aria-disabled', 'true'); b.classList.add('dim'); if (tip) b.title = tip; } else b.addEventListener('click', onClick);
    return b;
  };

  // ================= date range =================
  const f = () => deps.filters();
  function curPreset() { const p = Q.presetOf(f()); return st.custom ? 'custom' : p; }
  function applyRange(from, to) {
    if (from != null && to != null && from >= to) { st.err = T().errOrder; return false; }
    st.err = ''; st.fromTxt = st.toTxt = null;
    deps.patch((x) => { x.dateFrom = from; x.dateTo = to; });
    return true;
  }
  function openCal(which) {
    if (st.cal === which) { st.cal = null; renderDate(); return; }
    st.cal = which;
    const cur = which === 'from' ? f().dateFrom : (f().dateTo ? Q.addDays(f().dateTo, -1) : null);
    const base = cur || Date.now();
    st.calFocus = Q.dayStart(base);
    const d = new Date(st.calFocus);
    st.calMonth = { y: d.getFullYear(), m: d.getMonth() };
    renderDate();
    const n = root.querySelector('.cday[tabindex="0"]'); if (n) n.focus({ preventScroll: true });
  }
  function commitText(which, text) {
    const v = parseField(text);
    const cur = f();
    if (v === undefined) { st.err = T().errFormat; if (which === 'from') st.fromTxt = text; else st.toTxt = text; renderDate(); return; }
    const from = which === 'from' ? (v ? new Date(v[0], v[1], v[2]).getTime() : null) : cur.dateFrom;
    const to = which === 'to' ? (v ? new Date(v[0], v[1], v[2] + 1).getTime() : null) : cur.dateTo;
    if (which === 'from') st.fromTxt = text; else st.toTxt = text;
    if (!applyRange(from, to)) renderDate();
  }
  function pickDay(ts) {
    const v = new Date(ts);
    const cur = f();
    const from = st.cal === 'from' ? new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime() : cur.dateFrom;
    const to = st.cal === 'to' ? new Date(v.getFullYear(), v.getMonth(), v.getDate() + 1).getTime() : cur.dateTo;
    const which = st.cal;
    st.cal = null;
    if (which === 'from') st.fromTxt = null; else st.toTxt = null;
    if (!applyRange(from, to)) renderDate();
    const n = root.querySelector(`[data-fk="d-${which}"]`); if (n) n.focus({ preventScroll: true });
  }
  function clearDay() {
    const which = st.cal; st.cal = null;
    const cur = f();
    applyRange(which === 'from' ? null : cur.dateFrom, which === 'to' ? null : cur.dateTo);
    renderDate();
  }

  function renderCal(box) {
    const t = T();
    const loc = localeFor(deps.lang(), 'gregory');
    const { y, m } = st.calMonth;
    const monthName = new Intl.DateTimeFormat(loc, { month: 'long' }).format(new Date(2026, m, 1));
    const yearTxt = String(y + (be() ? 543 : 0));
    const cal = mk('div', 'cal');
    const hd = mk('div', 'calhd');
    const mkNav = (dir, label, fk) => { const b = mk('button', 'icon sm calnav'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.dataset.fk = fk; b.appendChild(icon('expand', dir < 0 ? 'prev' : 'next')); b.addEventListener('click', () => { shiftMonth(dir); }); return b; };
    const lbl = mk('div', 'callbl', `${monthName} ${yearTxt}`); lbl.setAttribute('aria-live', 'polite');
    hd.append(mkNav(-1, t.calPrev, 'c-prev'), lbl, mkNav(1, t.calNext, 'c-next'));
    cal.appendChild(hd);
    const grid = mk('div', 'calgrid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', `${monthName} ${yearTxt}`);
    const wk = mk('div', 'calrow'); wk.setAttribute('role', 'row');
    const wdf = new Intl.DateTimeFormat(loc, { weekday: 'short' });
    for (let i = 0; i < 7; i++) { const c = mk('div', 'calwd', wdf.format(new Date(2024, 0, 1 + i)).replace('.', '')); c.setAttribute('role', 'columnheader'); wk.appendChild(c); }
    grid.appendChild(wk);
    const first = new Date(y, m, 1);
    const off = (first.getDay() + 6) % 7; // Monday first
    const today = Q.dayStart(Date.now());
    const cur = f();
    const lo = cur.dateFrom;
    const hi = cur.dateTo ? Q.addDays(cur.dateTo, -1) : null;
    const lf = new Intl.DateTimeFormat(loc, { dateStyle: 'full' });
    let tabbable = null;
    const cells = [];
    for (let w = 0; w < 6; w++) {
      const row = mk('div', 'calrow'); row.setAttribute('role', 'row');
      for (let d = 0; d < 7; d++) {
        const dt = new Date(y, m, 1 - off + w * 7 + d);
        const ts = dt.getTime();
        const b = mk('button', 'cday', String(dt.getDate()));
        b.type = 'button'; b.setAttribute('role', 'gridcell'); b.tabIndex = -1; b.dataset.ts = String(ts);
        b.setAttribute('aria-label', lf.format(dt));
        if (dt.getMonth() !== m) b.classList.add('out');
        if (ts === today) b.classList.add('today');
        const isSel = (lo && ts === Q.dayStart(lo)) || (hi && ts === Q.dayStart(hi));
        if (isSel) b.classList.add('sel');
        if (lo && hi && ts > Q.dayStart(lo) && ts < Q.dayStart(hi)) b.classList.add('inr');
        b.setAttribute('aria-selected', String(!!isSel));
        if (ts === st.calFocus && dt.getMonth() === m) tabbable = b;
        b.addEventListener('click', () => pickDay(ts));
        cells.push(b);
        row.appendChild(b);
      }
      grid.appendChild(row);
    }
    if (!tabbable) tabbable = cells.find((c) => !c.classList.contains('out')) || cells[0];
    tabbable.tabIndex = 0;
    grid.addEventListener('keydown', (e) => {
      const k = e.key;
      const cur2 = Number(document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.ts : st.calFocus) || st.calFocus;
      let next = null;
      if (k === 'ArrowLeft') next = Q.addDays(cur2, -1);
      else if (k === 'ArrowRight') next = Q.addDays(cur2, 1);
      else if (k === 'ArrowUp') next = Q.addDays(cur2, -7);
      else if (k === 'ArrowDown') next = Q.addDays(cur2, 7);
      else if (k === 'Home') next = Q.addDays(cur2, -((new Date(cur2).getDay() + 6) % 7));
      else if (k === 'End') next = Q.addDays(cur2, 6 - ((new Date(cur2).getDay() + 6) % 7));
      else if (k === 'PageUp' || k === 'PageDown') { const d = new Date(cur2); const dir = k === 'PageUp' ? -1 : 1; const n = new Date(d.getFullYear() + (e.shiftKey ? dir : 0), d.getMonth() + (e.shiftKey ? 0 : dir), 1); const last = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate(); next = new Date(n.getFullYear(), n.getMonth(), Math.min(d.getDate(), last)).getTime(); }
      if (next == null) return;
      e.preventDefault(); e.stopPropagation();
      st.calFocus = next;
      const nd = new Date(next);
      st.calMonth = { y: nd.getFullYear(), m: nd.getMonth() };
      keep(() => renderDate());
      const n = root.querySelector('.cday[tabindex="0"]'); if (n) n.focus({ preventScroll: true });
    });
    cal.appendChild(grid);
    const ft = mk('div', 'calft');
    const b1 = mk('button', 'fbtn sm', t.calToday); b1.type = 'button'; b1.dataset.fk = 'c-today'; b1.addEventListener('click', () => pickDay(today));
    const b2 = mk('button', 'fbtn sm', t.calClear); b2.type = 'button'; b2.dataset.fk = 'c-clear'; b2.addEventListener('click', clearDay);
    const b3 = mk('button', 'fbtn sm', t.calClose); b3.type = 'button'; b3.dataset.fk = 'c-close'; b3.addEventListener('click', () => { const w = st.cal; st.cal = null; renderDate(); const n = root.querySelector(`[data-fk="d-${w}"]`); if (n) n.focus({ preventScroll: true }); });
    ft.append(b1, b2, b3);
    cal.appendChild(ft);
    box.appendChild(cal);
  }
  function shiftMonth(dir) {
    const d = new Date(st.calMonth.y, st.calMonth.m + dir, 1);
    st.calMonth = { y: d.getFullYear(), m: d.getMonth() };
    const dd = new Date(st.calFocus);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    st.calFocus = new Date(d.getFullYear(), d.getMonth(), Math.min(dd.getDate(), last)).getTime();
    keep(() => renderDate());
  }

  function renderDate() {
    const t = T();
    const s = S.date;
    s.lab.textContent = t.secDate;
    const cur = f();
    const p = curPreset();
    const active = !!(cur.dateFrom || cur.dateTo);
    setMeta(s, active ? 1 : 0, null);
    s.b.textContent = '';
    const seg = mk('div', 'fseg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', t.secDate);
    for (const [id, key] of PRESETS) {
      const b = mk('button', 'fseg-b', t[key]); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(p === id)); b.dataset.fk = 'p-' + id;
      if (p === id) b.setAttribute('data-autofocus', '');
      b.addEventListener('click', () => {
        st.err = ''; st.fromTxt = st.toTxt = null; st.cal = null;
        if (id === 'custom') { st.custom = true; renderDate(); const n = root.querySelector('[data-fk="d-from"]'); if (n) n.focus({ preventScroll: true }); return; }
        st.custom = false;
        const r = Q.presetRange(id);
        applyRange(r.from, r.to);
      });
      seg.appendChild(b);
    }
    s.b.appendChild(seg);
    if (p === 'custom') {
      const row = mk('div', 'dfields');
      for (const which of ['from', 'to']) {
        const fld = mk('div', 'dfield');
        const lab = mk('label', 'dlab', which === 'from' ? t.from : t.to);
        const id = 'fd-' + which;
        lab.htmlFor = id;
        const wrap = mk('div', 'dwrap');
        const inp = mk('input', 'dinp'); inp.type = 'text'; inp.id = id; inp.dataset.fk = 'd-' + which; inp.placeholder = t.ph; inp.autocomplete = 'off'; inp.inputMode = 'numeric'; inp.maxLength = 12;
        const ts = which === 'from' ? cur.dateFrom : (cur.dateTo ? Q.addDays(cur.dateTo, -1) : null);
        const typed = which === 'from' ? st.fromTxt : st.toTxt;
        inp.value = typed != null ? typed : (ts ? fmtField(ts, be()) : '');
        if (st.err && typed != null) inp.setAttribute('aria-invalid', 'true');
        inp.addEventListener('change', () => commitText(which, inp.value));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(which, inp.value); } else if (e.key === 'ArrowDown') { e.preventDefault(); openCal(which); } });
        const cb = mk('button', 'icon sm dcal'); cb.type = 'button'; cb.dataset.fk = 'dc-' + which; cb.setAttribute('aria-label', `${t.pickDate}: ${which === 'from' ? t.from : t.to}`); cb.title = t.pickDate; cb.setAttribute('aria-expanded', String(st.cal === which)); cb.appendChild(icon('calendar'));
        cb.addEventListener('click', () => openCal(which));
        wrap.append(inp, cb);
        fld.append(lab, wrap);
        row.appendChild(fld);
      }
      s.b.appendChild(row);
      const err = mk('div', 'derr', st.err); err.setAttribute('role', 'alert'); err.hidden = !st.err;
      s.b.appendChild(err);
      if (st.cal) { const box = mk('div', 'calbox'); renderCal(box); s.b.appendChild(box); }
    }
    if (active) {
      const rc = mk('div', 'drange');
      rc.appendChild(mk('span', 'drl', rangeLabel(cur.dateFrom, cur.dateTo, deps.lang(), deps.calendar(), t)));
      const x = mk('button', 'icon sm'); x.type = 'button'; x.dataset.fk = 'r-clear'; x.setAttribute('aria-label', t.clearRange); x.title = t.clearRange; x.appendChild(icon('close'));
      x.addEventListener('click', () => { st.custom = false; st.cal = null; st.err = ''; st.fromTxt = st.toTxt = null; applyRange(null, null); });
      rc.appendChild(x);
      s.b.appendChild(rc);
    }
    // which date the range is compared with
    const bs = mk('div', 'dbasis');
    bs.appendChild(mk('span', 'dblab', t.basis));
    const sg = mk('div', 'fseg small'); sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', t.basis);
    const hasTm = deps.hasTm();
    for (const [id, key] of [['saved', 'basisSaved'], ['active', 'basisActive']]) {
      const b = mk('button', 'fseg-b', t[key]); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.fk = 'b-' + id;
      const on = (cur.dateBasis || 'saved') === id;
      b.setAttribute('aria-checked', String(on));
      if (id === 'active' && !hasTm) { b.setAttribute('aria-disabled', 'true'); b.classList.add('dim'); b.title = t.basisOff; } else b.addEventListener('click', () => deps.patch((x) => { x.dateBasis = id; }));
      sg.appendChild(b);
    }
    bs.appendChild(sg);
    s.b.appendChild(bs);
    if (!hasTm) s.b.appendChild(mk('div', 'fhint', t.basisOff));
    paintOpen('date');
  }

  // ================= websites =================
  let siteInput = null;
  let siteBox = null;
  function ensureSiteShell() {
    if (siteInput) return;
    const t = T();
    const row = mk('div', 'fsearch');
    row.appendChild(icon('search'));
    siteInput = mk('input'); siteInput.type = 'search'; siteInput.dataset.fk = 'site-q'; siteInput.autocomplete = 'off';
    siteInput.addEventListener('input', () => { st.q = siteInput.value; st.shown = PAGE_ROWS; keep(() => renderSites(true)); });
    row.appendChild(siteInput);
    siteBox = mk('div', 'fsites');
    S.sites.b.append(row, siteBox);
    S.sites.search = row;
    void t;
  }
  function hostChip(host, n, on) {
    return chip(host, host, { on, count: n, iconNode: deps.hostIcon(host), fk: 's-' + host, onClick: () => deps.patch((x) => { const i = x.sites.indexOf(host); if (i >= 0) x.sites.splice(i, 1); else x.sites.push(host); }) });
  }
  function hostRow(host, n, on) {
    const b = mk('button', 'frowitem'); b.type = 'button'; b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(on)); b.dataset.fk = 's-' + host;
    const bx = mk('span', 'fbox'); if (on) bx.appendChild(icon('check'));
    b.append(bx, deps.hostIcon(host), mk('span', 'fcl', host), mk('span', 'fcn', Number(n).toLocaleString(deps.lang() === 'en' ? 'en-US' : 'th-TH')));
    b.addEventListener('click', () => deps.patch((x) => { const i = x.sites.indexOf(host); if (i >= 0) x.sites.splice(i, 1); else x.sites.push(host); }));
    return b;
  }
  function renderSites(fromInput) {
    const t = T();
    const s = S.sites;
    s.lab.textContent = t.secSites;
    ensureSiteShell();
    siteInput.placeholder = t.sitesPh;
    siteInput.setAttribute('aria-label', t.sitesPh);
    const fa = deps.facets();
    const sel = f().sites;
    const have = new Set(fa.sites.map(([h]) => h));
    const all = fa.sites.concat(sel.filter((h) => !have.has(h)).map((h) => [h, 0]));
    setMeta(s, sel.length, fa.siteMapReady ? all.length : null);
    siteBox.textContent = '';
    if (!fa.siteMapReady) { siteBox.appendChild(mk('div', 'fhint', t.sitesWait)); paintOpen('sites'); return; }
    const q = st.q.trim().toLowerCase();
    const selSet = new Set(sel);
    if (q || st.all) {
      const list = q ? all.filter(([h]) => h.includes(q)) : all;
      if (!list.length) siteBox.appendChild(mk('div', 'fhint', t.sitesNone));
      const lst = mk('div', 'flist');
      for (const [h, n] of list.slice(0, st.shown)) lst.appendChild(hostRow(h, n, selSet.has(h)));
      siteBox.appendChild(lst);
      if (list.length > st.shown) { const mb = mk('button', 'flink', t.moreRows(list.length - st.shown)); mb.type = 'button'; mb.dataset.fk = 's-more'; mb.addEventListener('click', () => { st.shown += PAGE_ROWS; keep(() => renderSites()); }); siteBox.appendChild(mb); }
    } else {
      const top = all.slice(0, TOP_SITES);
      const topSet = new Set(top.map(([h]) => h));
      const shown = sel.filter((h) => !topSet.has(h)).map((h) => [h, (all.find(([x]) => x === h) || [h, 0])[1]]).concat(top);
      const wrap = mk('div', 'fchips');
      for (const [h, n] of shown) wrap.appendChild(hostChip(h, n, selSet.has(h)));
      siteBox.appendChild(wrap);
      if (!shown.length) siteBox.appendChild(mk('div', 'fhint', t.sitesNone));
    }
    if (!q && all.length > TOP_SITES) {
      const tb = mk('button', 'flink', st.all ? t.seeTop : t.seeAll(all.length)); tb.type = 'button'; tb.dataset.fk = 's-toggle'; tb.setAttribute('aria-expanded', String(st.all));
      tb.addEventListener('click', () => { st.all = !st.all; st.shown = PAGE_ROWS; keep(() => renderSites()); });
      siteBox.appendChild(tb);
    }
    paintOpen('sites');
  }

  // ================= categories / tab groups / status =================
  function renderCats() {
    const t = T();
    const s = S.cats;
    s.lab.textContent = t.secCats;
    const fa = deps.facets();
    const sel = f().cats;
    const items = [];
    for (const c of deps.cats()) { const n = fa.cats.get(c.id) || 0; if (n > 0 || sel.includes(c.id)) items.push({ id: c.id, name: c.name, color: c.color, n }); }
    const un = fa.cats.get('') || 0;
    if (un > 0 || sel.includes('')) items.push({ id: '', name: t.uncat, color: null, n: un });
    setMeta(s, sel.length, items.length);
    s.b.textContent = '';
    const wrap = mk('div', 'fchips');
    for (const c of items) {
      const dot = mk('span', 'dot'); dot.setAttribute('aria-hidden', 'true'); if (c.color) dot.dataset.c = c.color;
      wrap.appendChild(chip('c' + c.id, c.name, { on: sel.includes(c.id), count: c.n, iconNode: dot, fk: 'c-' + (c.id || 'none'), onClick: () => deps.patch((x) => { const i = x.cats.indexOf(c.id); if (i >= 0) x.cats.splice(i, 1); else x.cats.push(c.id); }) }));
    }
    s.b.appendChild(wrap);
    if (!items.length) s.b.appendChild(mk('div', 'fhint', t.catsNone));
    paintOpen('cats');
  }
  function renderTgs() {
    const t = T();
    const s = S.tgs;
    s.lab.textContent = t.secTgs;
    const fa = deps.facets();
    const sel = f().tgs;
    const have = new Set(fa.tgs.map(([k]) => k));
    const items = fa.tgs.concat(sel.filter((k) => !have.has(k)).map((k) => [k, 0]));
    setMeta(s, sel.length, items.length);
    s.b.textContent = '';
    const wrap = mk('div', 'fchips');
    for (const [k, n] of items.slice(0, 40)) wrap.appendChild(chip('t' + k, k, { on: sel.includes(k), count: n, fk: 't-' + k, onClick: () => deps.patch((x) => { const i = x.tgs.indexOf(k); if (i >= 0) x.tgs.splice(i, 1); else x.tgs.push(k); }) }));
    s.b.appendChild(wrap);
    if (!items.length) s.b.appendChild(mk('div', 'fhint', t.tgsNone));
    paintOpen('tgs');
  }
  function renderStatus() {
    const t = T();
    const s = S.status;
    s.lab.textContent = t.secStatus;
    const fa = deps.facets();
    const fl = f().flags;
    const hasTm = deps.hasTm();
    const nSel = Object.values(fl).filter(Boolean).length;
    setMeta(s, nSel, null);
    s.b.textContent = '';
    const wrap = mk('div', 'fchips');
    for (const k of Q.FLAG_KEYS) {
      const needTm = k === 'unused30' || k === 'open7';
      const n = (fa.flags && fa.flags[k]) || 0;
      const on = !!fl[k];
      const off = !on && ((needTm && !hasTm) || n === 0);
      wrap.appendChild(chip('f' + k, deps.flagLabels[k], { on, count: needTm && !hasTm ? null : n, iconNode: icon(FLAG_ICONS[k], 'fico'), disabled: off, title: needTm && !hasTm ? t.statNeedStats : t.statNone, fk: 'f-' + k, onClick: () => deps.patch((x) => { x.flags[k] = !x.flags[k]; }) }));
    }
    s.b.appendChild(wrap);
    paintOpen('status');
  }

  function renderFrame() {
    const t = T();
    title.textContent = t.title;
    root.setAttribute('aria-label', t.title);
    xb.setAttribute('aria-label', t.close); xb.title = t.close;
    clearBtn.textContent = t.clear; showBtn.textContent = t.show;
    clearBtn.disabled = !Q.filtersActive(f());
    const sm = deps.summary();
    sum.textContent = sm.tabs ? t.summary(sm.tabs, sm.sets) : t.summaryNone;
    sum.classList.toggle('none', !sm.tabs);
  }

  /** Full render (open, or when the filters / data changed). */
  function render() {
    keep(() => { renderFrame(); renderDate(); renderSites(); renderCats(); renderTgs(); renderStatus(); });
  }
  /** Fresh state each time the panel is opened. */
  function reset() { st.q = ''; st.all = false; st.shown = PAGE_ROWS; st.cal = null; st.err = ''; st.fromTxt = st.toTxt = null; st.custom = false; if (siteInput) siteInput.value = ''; }
  root._escape = () => { if (!st.cal) return false; const w = st.cal; st.cal = null; keep(() => renderDate()); const n = root.querySelector(`[data-fk="d-${w}"]`) || root.querySelector(`[data-fk="dc-${w}"]`); if (n) n.focus({ preventScroll: true }); return true; };
  return { render, reset };
}
