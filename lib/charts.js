// Tiny chart helpers for the dashboard: plain DOM / SVG / CSS, no libraries, colours from tokens (light + dark), every chart has
// role="img" + an aria-label summary and a visually hidden table twin with a "view as table" toggle. Text only (textContent): no innerHTML.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

export const PALETTE = ['var(--c-blue)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-pink)', 'var(--c-purple)', 'var(--c-red)', 'var(--c-grey)', 'var(--c-cyan, #12a4af)', 'var(--c-orange, #e8710a)'];

/** wraps a chart with its table twin + toggle. headers: [string], rows: [[...]], S: {asTable, asChart} */
export function figure(chart, aria, headers, rows, S) {
  const fig = el('figure', 'chart');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', aria);
  const tbl = el('table', 'ctable');
  tbl.hidden = true;
  const thead = el('thead'); const trh = el('tr');
  for (const h of headers) trh.appendChild(el('th', '', h));
  thead.appendChild(trh); tbl.appendChild(thead);
  const tb = el('tbody');
  for (const r of rows) { const tr = el('tr'); r.forEach((c, i) => tr.appendChild(el(i ? 'td' : 'th', i ? 'num' : '', String(c)))); tb.appendChild(tr); }
  tbl.appendChild(tb);
  const btn = el('button', 'linkbtn', S.asTable);
  btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    const on = tbl.hidden;
    tbl.hidden = !on; chart.hidden = on;
    btn.textContent = on ? S.asChart : S.asTable;
    btn.setAttribute('aria-pressed', String(on));
  });
  fig.append(chart, tbl, btn);
  return fig;
}

/** vertical bars: data [{label, value, tip?}] */
export function bar(data, { S, aria, height = 120, fmt = (v) => String(v), labelEvery = 0 }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const c = el('div', 'bars');
  c.style.height = height + 'px';
  data.forEach((d, i) => {
    const col = el('div', 'bcol');
    const b = el('i', 'bar');
    b.style.height = Math.max(d.value > 0 ? 2 : 0, (d.value / max) * 100) + '%';
    col.title = (d.tip || d.label) + ': ' + fmt(d.value);
    col.appendChild(b);
    if (labelEvery && i % labelEvery === 0) { const l = el('span', 'blabel', d.label); col.appendChild(l); }
    c.appendChild(col);
  });
  return figure(c, aria, ['', ''], data.map((d) => [d.tip || d.label, fmt(d.value)]), S);
}

/** horizontal bars: rows [{label, value, icon?(node), extra?(node|string)}] */
export function hbar(rows, { S, aria, fmt = (v) => String(v), color = 'var(--accent)' }) {
  const max = Math.max(1, ...rows.map((d) => d.value));
  const c = el('div', 'hbars');
  for (const d of rows) {
    const r = el('div', 'hrow');
    if (d.icon) r.appendChild(d.icon);
    r.appendChild(el('span', 'hl', d.label));
    const track = el('span', 'htrack'); const fill = el('i', 'hfill');
    fill.style.width = Math.max(2, (d.value / max) * 100) + '%'; fill.style.background = color;
    track.appendChild(fill); r.appendChild(track);
    r.appendChild(el('span', 'hv', fmt(d.value)));
    if (d.extra != null) r.appendChild(typeof d.extra === 'string' ? el('span', 'hx', d.extra) : d.extra);
    c.appendChild(r);
  }
  return figure(c, aria, ['', ''], rows.map((d) => [d.label, fmt(d.value)]), S);
}

/** donut: slices [{label, value, color?}] (stroke-dasharray on a circle with circumference 100) */
export function donut(slices, { S, aria, total = null }) {
  const sum = slices.reduce((a, s) => a + s.value, 0) || 1;
  const wrap = el('div', 'donutwrap');
  const svg = sv('svg', { viewBox: '0 0 42 42', class: 'donut' });
  svg.appendChild(sv('circle', { cx: 21, cy: 21, r: 15.9155, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 6 }));
  let off = 25;
  slices.forEach((s, i) => {
    const pct = (s.value / sum) * 100;
    if (pct <= 0) return;
    const c = sv('circle', { cx: 21, cy: 21, r: 15.9155, fill: 'none', stroke: s.color || PALETTE[i % PALETTE.length], 'stroke-width': 6, 'stroke-dasharray': `${pct} ${100 - pct}`, 'stroke-dashoffset': String(off) });
    const t = sv('title', {}); t.textContent = `${s.label}: ${s.value}`; c.appendChild(t);
    svg.appendChild(c);
    off -= pct;
  });
  const mid = sv('text', { x: 21, y: 23, 'text-anchor': 'middle', class: 'donutn' });
  mid.textContent = String(total != null ? total : sum);
  svg.appendChild(mid);
  const legend = el('ul', 'legend');
  slices.forEach((s, i) => { const li = el('li'); const sw = el('i', 'sw'); sw.style.background = s.color || PALETTE[i % PALETTE.length]; li.append(sw, el('span', 'lt', s.label), el('span', 'lv', String(s.value))); legend.appendChild(li); });
  wrap.append(svg, legend);
  return figure(wrap, aria, ['', ''], slices.map((s) => [s.label, s.value]), S);
}

/** 7 x 24 heat map: m[d][h] counts; labels: weekday short names (Sunday first) */
export function heat(m, { S, aria, wdShort, hourLabel }) {
  let max = 0;
  for (const r of m) for (const v of r) if (v > max) max = v;
  const c = el('div', 'heat');
  c.style.gridTemplateColumns = 'auto repeat(24, minmax(0, 1fr))';
  c.appendChild(el('span', 'hcorner'));
  for (let h = 0; h < 24; h++) c.appendChild(el('span', 'hhead', h % 6 === 0 ? String(h) : ''));
  const rows = [];
  for (let d = 0; d < 7; d++) {
    c.appendChild(el('span', 'hwd', wdShort[d]));
    for (let h = 0; h < 24; h++) {
      const v = m[d][h];
      const lvl = !v ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999));
      const cell = el('span', 'hcell l' + lvl);
      cell.title = `${wdShort[d]} ${hourLabel(h)}: ${v}`;
      c.appendChild(cell);
    }
    rows.push([wdShort[d], m[d].reduce((a, b) => a + b, 0)]);
  }
  return figure(c, aria, ['', ''], rows, S);
}

/** one stacked horizontal bar: parts [{label, value, color?}] */
export function stack(parts, { S, aria }) {
  const sum = parts.reduce((a, p) => a + p.value, 0) || 1;
  const wrap = el('div', 'stackwrap');
  const track = el('div', 'stackbar');
  const legend = el('ul', 'legend');
  parts.forEach((p, i) => {
    const col = p.color || PALETTE[i % PALETTE.length];
    if (p.value > 0) { const seg = el("i", "sg"); seg.style.flex = String(p.value); seg.style.background = col; seg.title = `${p.label}: ${p.value}`; track.appendChild(seg); }
    const li = el('li'); const sw = el('i', 'sw'); sw.style.background = col; li.append(sw, el('span', 'lt', p.label), el('span', 'lv', String(p.value))); legend.appendChild(li);
  });
  wrap.append(track, legend);
  return figure(wrap, aria, ['', ''], parts.map((p) => [p.label, p.value]), S);
}
