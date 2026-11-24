// The printed page of one tab set: a title block, then the tabs in order, split by window and Chrome tab group, each with its
// title, address and (optionally) a QR code. Built with textContent only (titles and addresses are page-controlled text).
// Layout rules live in stash.css (@media print); this module only creates the nodes.

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

/**
 * g: the tab set; items: [{url, title, w, ws, tg}] in order; opts: { urls, qr, split };
 * t: { meta(dateText, n, windows), windowN(n), tgUntitled, printedBy, qrSkipped }; tgDefs: Map tg index -> {title,color};
 * qr: null or (url) => svg string (throws when the address is too long).
 */
export function buildPrintSheet({ g, title, dateText, items, opts, t, tgDefs, qr }) {
  const sheet = el('div', 'printsheet');
  sheet.id = 'printSheet';
  const head = el('header', 'ps-head');
  head.append(el('h1', 'ps-title', title), el('p', 'ps-meta', t.meta(dateText, items.length, g.windowCount > 1 ? g.windowCount : 0)));
  if (g.note) head.append(el('p', 'ps-note', g.note));
  sheet.append(head);

  let list = el('ol', 'ps-list');
  sheet.append(list);
  let n = 0;
  let lastW = null;
  let lastTg = null;
  const heading = (cls, text, color) => {
    const h = el('div', cls, text);
    if (color) h.dataset.c = color;
    sheet.append(h);
    list = el('ol', 'ps-list');
    list.start = n + 1;
    sheet.append(list);
  };
  for (const it of items) {
    if (opts.split) {
      const w = it.w || 0;
      if (g.windowCount > 1 && w && w !== lastW) { heading('ps-win', t.windowN(w)); lastW = w; lastTg = null; }
      const tg = typeof it.tg === 'number' && it.tg >= 0 && tgDefs.has(it.tg) ? it.tg : -1;
      if (tg !== lastTg) {
        if (tg >= 0) { const d = tgDefs.get(tg); heading('ps-tg', d.title || t.tgUntitled, d.color || 'grey'); }
        else if (lastTg !== null && lastTg >= 0) heading('ps-tg none', t.tgNone);
        lastTg = tg;
      }
    }
    n++;
    const li = el('li', 'ps-item');
    const row = el('div', 'ps-row'); // the li stays a list item (it keeps its number), the row lays out text + QR
    li.append(row);
    const text = el('div', 'ps-text');
    text.append(el('div', 'ps-t', it.title || it.url));
    const host = hostOf(it.url);
    if (opts.urls) text.append(el('div', 'ps-u', it.url));
    else if (host) text.append(el('div', 'ps-u', host));
    row.append(text);
    if (opts.qr && qr) {
      const box = el('div', 'ps-qr');
      try { box.innerHTML = qr(it.url); } catch { box.textContent = t.qrSkipped; box.classList.add('skip'); } // innerHTML: the string is our own generated SVG, never page text
      row.append(box);
    }
    list.append(li);
  }
  sheet.append(el('footer', 'ps-foot', t.printedBy));
  return sheet;
}
