// Our own question dialogs, used instead of the browser's window.prompt / confirm / alert (those look foreign and cannot be styled).
//   askText({ title, label, message, value, multiline, placeholder, okLabel, cancelLabel, validate }) -> Promise<string | null>
//   askConfirm({ title, message, okLabel, cancelLabel, danger })                                       -> Promise<boolean>
// Cancel (Esc, the Cancel button, a click on the backdrop) resolves null / false, exactly like the native dialogs did.
// Enter submits a one-line field, Ctrl+Enter (or Cmd+Enter) submits a multi-line one. Every text goes in through textContent.
// Styles: lib/dialogs.css (linked by stash.html and popup.html). The callers pass translated labels from their own STR table.

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let uid = 0;

function open({ title, message, label, field, okLabel, cancelLabel, danger, validate, getValue }) {
  return new Promise((resolve) => {
    const id = ++uid;
    const dlg = el('dialog', 'cmd-dlg' + (danger ? ' danger' : ''));
    dlg.setAttribute('aria-label', title || message || label || '');
    let result = null;

    const head = el('div', 'cmd-h');
    const h = el('h2', 'cmd-t', title || '');
    head.append(h);
    const body = el('div', 'cmd-b');
    if (message) body.append(el('p', 'cmd-msg', message));
    if (label && field) { const lab = el('label', 'cmd-lab', label); lab.htmlFor = `cmdIn${id}`; body.append(lab); }
    if (field) { field.id = `cmdIn${id}`; field.classList.add('cmd-in'); body.append(field); }

    const foot = el('div', 'cmd-f');
    const cancel = el('button', 'btn cmd-cancel', cancelLabel || 'Cancel'); cancel.type = 'button';
    const ok = el('button', 'btn primary cmd-ok' + (danger ? ' danger' : ''), okLabel || 'OK'); ok.type = 'button';
    foot.append(cancel, ok);
    if (title) dlg.append(head);
    dlg.append(body, foot);

    const allowed = () => !validate || !!validate(getValue ? getValue() : '');
    const sync = () => { ok.disabled = !allowed(); };
    const finish = (v) => { result = v; dlg.close(); };
    const submit = () => { if (!allowed()) return; finish(getValue ? getValue() : true); };

    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', submit);
    // backdrop click cancels, but only when the press also started on the backdrop (not a text selection dragged out of the field)
    let downOnBackdrop = false;
    dlg.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg && downOnBackdrop) finish(null); });
    dlg.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the page's own shortcuts must not react while a question is open
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return;
      const multi = field && field.tagName === 'TEXTAREA';
      if (e.target === cancel) return; // Enter on Cancel presses Cancel
      if (multi && !(e.ctrlKey || e.metaKey)) return; // plain Enter is a new line
      e.preventDefault();
      submit();
    });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    if (field) field.addEventListener('input', sync);

    document.body.appendChild(dlg);
    sync();
    dlg.showModal();
    if (field) { field.focus(); try { field.select(); } catch { /* not selectable */ } } else ok.focus();
  });
}

export function askText({ title = '', label = '', message = '', value = '', multiline = false, placeholder = '', okLabel, cancelLabel, validate } = {}) {
  const f = multiline ? el('textarea') : el('input');
  if (multiline) f.rows = 7; else f.type = 'text';
  f.value = value == null ? '' : String(value);
  if (placeholder) f.placeholder = placeholder;
  f.spellcheck = false;
  f.autocomplete = 'off';
  return open({ title, message, label, field: f, okLabel, cancelLabel, validate, getValue: () => f.value });
}

export function askConfirm({ title = '', message = '', okLabel, cancelLabel, danger = false } = {}) {
  return open({ title, message, okLabel, cancelLabel, danger }).then((v) => v === true);
}
