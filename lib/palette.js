// Command palette (Ctrl+K / Cmd+K): quick actions + tab-set title search. A native <dialog> (focus trap, Esc closes), combobox + listbox
// semantics (aria-activedescendant), arrow keys / Enter. Built with createElement / textContent only. Nothing is read until it opens.
// openPalette({ actions: [{label, run}], sets: [{id, title, count}], t: {label, placeholder, actionsH, setsH, empty}, onSet(id) })

const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKC');

export function openPalette({ actions = [], sets = [], t, onSet }) {
  if (document.getElementById('cmdPalette')) return;
  const prevFocus = document.activeElement;
  const dlg = document.createElement('dialog');
  dlg.id = 'cmdPalette'; dlg.className = 'palette';
  dlg.setAttribute('aria-label', t.label);
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'pal-in'; input.placeholder = t.placeholder; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'palList'); input.setAttribute('aria-label', t.label);
  const list = document.createElement('div');
  list.id = 'palList'; list.className = 'pal-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', t.label);
  dlg.append(input, list);
  document.body.appendChild(dlg);

  let rows = []; let cur = 0;
  function close() { try { dlg.close(); } catch { /* ignore */ } dlg.remove(); try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* ignore */ } }
  const pick = (r) => { close(); try { if (r.run) r.run(); else if (onSet) onSet(r.id); } catch { /* ignore */ } };
  const mark = () => {
    list.querySelectorAll('.pal-o').forEach((o) => {
      const on = o.id === 'palO' + cur;
      o.classList.toggle('on', on); o.setAttribute('aria-selected', String(on));
      if (on) { input.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); }
    });
  };
  const paint = () => {
    list.textContent = '';
    rows.forEach((r, i) => {
      if (r.head) { const h = document.createElement('div'); h.className = 'pal-h'; h.setAttribute('role', 'presentation'); h.textContent = r.head; list.appendChild(h); return; }
      const o = document.createElement('div');
      o.className = 'pal-o' + (i === cur ? ' on' : ''); o.id = 'palO' + i; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(i === cur));
      const a = document.createElement('span'); a.className = 'pal-t'; a.textContent = r.label; o.appendChild(a);
      if (r.hint) { const b = document.createElement('span'); b.className = 'pal-s'; b.textContent = r.hint; o.appendChild(b); }
      o.addEventListener('mousemove', () => { if (cur !== i) { cur = i; mark(); } });
      o.addEventListener('click', () => pick(r));
      list.appendChild(o);
    });
    if (!rows.some((r) => !r.head)) { const e = document.createElement('div'); e.className = 'pal-e'; e.textContent = t.empty; list.appendChild(e); }
    if (rows[cur] && !rows[cur].head) input.setAttribute('aria-activedescendant', 'palO' + cur); else input.removeAttribute('aria-activedescendant');
  };
  const build = () => {
    const q = norm(input.value.trim());
    const acts = actions.filter((a) => !q || norm(a.label).includes(q));
    const ss = q ? sets.filter((s) => norm(s.title).includes(q)).slice(0, 8) : [];
    rows = [];
    if (acts.length) rows.push({ head: t.actionsH }, ...acts);
    if (ss.length) rows.push({ head: t.setsH }, ...ss.map((s) => ({ id: s.id, label: s.title, hint: String(s.count) })));
    cur = rows.findIndex((r) => !r.head); if (cur < 0) cur = 0;
    paint();
  };
  const step = (d) => { let i = cur; for (let k = 0; k < rows.length; k++) { i = (i + d + rows.length) % rows.length; if (!rows[i].head) break; } cur = i; mark(); };
  input.addEventListener('input', build);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[cur]; if (r && !r.head) pick(r); }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  build();
  dlg.showModal();
  input.focus();
}
