// "Colour and emoji" dialog of a tab set: pastel colour swatches on top, then an emoji panel with a "frequently used" tab and
// one tab per kind of emoji (like the emoji panel of the operating system). Choices apply at once; nothing has to be typed.
import { CATS, START } from './emojidata.js';
import { sendPref } from './prefs.js';

const RECENT_KEY = 'cmr.emojiRecent';
const RECENT_MAX = 24;
const COLS = ['blue', 'red', 'orange', 'yellow', 'green', 'cyan', 'purple', 'pink'];

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function loadRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (Array.isArray(a)) return a.filter((x) => typeof x === 'string' && x.length <= 12).slice(0, RECENT_MAX);
  } catch { /* storage may be unavailable */ }
  return [];
}
function saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* ignore */ } sendPref('emoji', list.slice(0, RECENT_MAX)); }

/**
 * g: the tab set ({id, color, emoji}); t: strings (lookTitle, lookColour, lookNone, lookNames[], emoFreq, emoCats{}, lookEmojiClear, lookDone);
 * apply({color?, emoji?}): saves a choice (resolves when stored); onClose(): called when the dialog is gone.
 */
export function openLookDialog({ g, t, apply, onClose }) {
  const dlg = el('dialog', 'look-dlg');
  dlg.setAttribute('aria-label', t.lookTitle);
  const cur = { color: g.color || 0, emoji: g.emoji || '' };
  let recent = loadRecent();

  const head = el('div', 'ld-h');
  const prev = el('span', 'ld-prev');
  head.append(prev, el('h2', 'ld-t', t.lookTitle));
  const paintPrev = () => { prev.textContent = cur.emoji || '·'; prev.dataset.col = cur.color ? String(cur.color) : ''; };

  // ----- colours -----
  const colBox = el('div', 'ld-sec');
  colBox.append(el('div', 'ld-lab', t.lookColour));
  const sw = el('div', 'ld-sw');
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', t.lookColour);
  const swBtns = [];
  for (let i = 0; i <= COLS.length; i++) {
    const b = el('button', 'ld-c');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.c = String(i);
    b.title = i ? t.lookNames[i - 1] : t.lookNone;
    b.setAttribute('aria-label', b.title);
    if (i) b.style.setProperty('--ldc', `var(--pc-${i})`), b.style.setProperty('--lde', `var(--pc-edge-${i})`); else b.classList.add('none');
    b.addEventListener('click', async () => { cur.color = i; paintSw(); paintPrev(); await apply({ color: i || null }); });
    swBtns.push(b);
    sw.append(b);
  }
  const paintSw = () => { for (const b of swBtns) { const on = Number(b.dataset.c) === (cur.color || 0); b.setAttribute('aria-checked', String(on)); b.classList.toggle('on', on); } };
  colBox.append(sw);

  // ----- emoji -----
  const emBox = el('div', 'ld-sec ld-em');
  emBox.append(el('div', 'ld-lab', t.lookEmoji));
  const tabs = el('div', 'ld-tabs');
  tabs.setAttribute('role', 'tablist');
  const grid = el('div', 'ld-grid');
  grid.setAttribute('role', 'listbox');
  const all = [{ id: 'freq', icon: '🕘', name: t.emoFreq }, ...CATS.map((c) => ({ id: c.id, icon: c.icon, name: t.emoCats[c.id] || c.id }))];
  let tab = 'freq';
  const listOf = (id) => (id === 'freq' ? (recent.length ? recent : START) : (CATS.find((c) => c.id === id) || { list: [] }).list);
  const paintGrid = () => {
    grid.textContent = '';
    for (const e of listOf(tab)) {
      const b = el('button', 'ld-e', e);
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(e === cur.emoji));
      if (e === cur.emoji) b.classList.add('on');
      b.addEventListener('click', async () => {
        cur.emoji = e;
        recent = [e, ...recent.filter((x) => x !== e)].slice(0, RECENT_MAX);
        saveRecent(recent);
        paintPrev();
        paintGrid();
        await apply({ emoji: e });
      });
      grid.append(b);
    }
  };
  const tabBtns = [];
  for (const c of all) {
    const b = el('button', 'ld-tab', c.icon);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.dataset.id = c.id;
    b.addEventListener('click', () => { tab = c.id; paintTabs(); paintGrid(); });
    tabBtns.push(b);
    tabs.append(b);
  }
  const paintTabs = () => { for (const b of tabBtns) { const on = b.dataset.id === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); } tabName.textContent = (all.find((x) => x.id === tab) || {}).name || ''; };
  const tabName = el('div', 'ld-tabname');
  emBox.append(tabs, tabName, grid);

  // ----- footer -----
  const foot = el('div', 'ld-f');
  const clear = el('button', 'btn ld-clear', t.lookEmojiClear);
  clear.type = 'button';
  clear.addEventListener('click', async () => { cur.emoji = ''; paintPrev(); paintGrid(); await apply({ emoji: '' }); });
  const done = el('button', 'btn primary', t.lookDone);
  done.type = 'button';
  done.addEventListener('click', () => dlg.close());
  foot.append(clear, done);

  dlg.append(head, colBox, emBox, foot);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  document.body.appendChild(dlg);
  paintSw(); paintPrev(); paintTabs(); paintGrid();
  dlg.showModal();
  done.focus();
  return dlg;
}
