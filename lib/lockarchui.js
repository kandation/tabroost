// UI pieces of the encrypted archive (lock screen "erase everything" + settings card "import"). createElement / textContent only.
//   eraseFlow()  : the erase flow with the backup choice. The erase button needs BOTH the typed confirmation AND an explicit
//                  choice: either the backup file was made and its save link pressed, or the "erase without a backup" box is ticked.
//   importForm() : pick a .tabroost file, enter the old password or recovery key, add its tab sets to the list.
// The download is a normal <a download> link the user presses (never started by script).
import { buildArchive, importFile } from './lockarchive.js';

const mb = (n) => Math.max(0.1, Math.round(n / 104857.6) / 10);

/** cls: {msg, btn, danger, primary, muted} class names of the host page (lock screen vs settings card). */
export function eraseFlow({ T, el, send, cls, id = 'lk' }) {
  let saved = false;
  const mk = el('button', { type: 'button', class: cls.btn, id: id + 'Mk' }, T.archMake);
  const st = el('p', { class: cls.msg, role: 'status', 'aria-live': 'polite', id: id + 'MkMsg' });
  const linkBox = el('div', { class: 'lk-archlink' });
  const skip = el('input', { type: 'checkbox', id: id + 'Skip' });
  const word = el('input', { id: id + 'Word', type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const em = el('p', { class: cls.msg, role: 'status', 'aria-live': 'polite' });
  const go = el('button', { type: 'button', class: cls.danger, id: id + 'Go', disabled: true }, T.eraseBtn);
  const ready = () => word.value.trim() === T.eraseWord && (saved || skip.checked);
  const sync = () => { go.disabled = !ready(); };
  word.addEventListener('input', sync);
  skip.addEventListener('change', sync);
  mk.addEventListener('click', async () => {
    mk.disabled = true; saved = false; sync(); linkBox.replaceChildren(); st.textContent = T.archMaking(0);
    let r;
    try { r = await buildArchive({ onProgress: (p) => { st.textContent = T.archMaking(p.n); } }); } catch { r = { error: 'fail' }; }
    mk.disabled = false;
    if (r.error) { st.textContent = r.error === 'plain' ? T.archPlain : r.error === 'nolock' ? T.archNoLock : T.archFail; return; }
    const a = el('a', { class: cls.primary, href: URL.createObjectURL(r.blob), download: r.name, id: id + 'Dl' }, T.archSave);
    a.addEventListener('click', () => { saved = true; st.textContent = T.archSaved; sync(); });
    linkBox.replaceChildren(a);
    st.textContent = T.archReady(r.name, mb(r.blob.size));
  });
  go.addEventListener('click', async () => {
    if (!ready()) { em.textContent = T.archNeed; return; }
    go.disabled = true; em.textContent = T.erasing;
    const r = await send({ type: 'lock.resetErase', confirm: word.value.trim() });
    if (r && r.ok) { location.reload(); return; }
    em.textContent = T.failed; sync();
  });
  return [
    el('p', {}, T.eraseWarn), el('p', { class: cls.muted }, T.eraseSyncNote),
    el('h3', {}, T.archTitle), el('p', { class: cls.muted }, T.archHelp), mk, st, linkBox,
    el('label', { class: 'row', for: id + 'Skip' }, skip, ' ', T.archSkip),
    el('label', { for: id + 'Word' }, T.eraseType), word, em, go,
  ];
}

const ERR = (T, c) => (c === 'wrong' ? T.archErrWrong : c === 'noSlot' ? T.noSlot : c === 'pkCancel' ? T.pkCancel : c === 'pkNoSupport' ? T.pkNoSupport : c === 'pkFail' ? T.pkFail : c === 'format' ? T.archErrFormat : c === 'locked' ? T.archErrLocked : c === 'badFormat' ? T.recBad : c === 'noRecovery' ? T.noRec : c === 'tampered' ? T.tampered : c === 'damaged' ? T.damaged : T.failed);

/** @returns nodes (the host adds its own cancel button) */
export function importForm({ T, el, send, cls, onDone }) {
  const file = el('input', { type: 'file', id: 'arFile', accept: '.tabroost,application/octet-stream' });
  const kind = el('select', { id: 'arKind', 'aria-label': T.archOldSecret }, el('option', { value: 'pw' }, T.archOldPw), el('option', { value: 'rec' }, T.archOldRec), el('option', { value: 'bk' }, T.archOldBk), el('option', { value: 'pk' }, T.archOldPk));
  const secret = el('input', { id: 'arSecret', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  kind.addEventListener('change', () => { secret.type = kind.value === 'rec' ? 'text' : 'password'; secret.disabled = kind.value === 'pk'; });
  const msg = el('p', { class: cls.msg, role: 'status', 'aria-live': 'polite', id: 'arMsg' });
  const go = el('button', { type: 'button', class: cls.primary, id: 'arGo' }, T.archGo);
  go.addEventListener('click', async () => {
    const f = file.files && file.files[0];
    if (!f) { msg.textContent = T.archPickFile; return; }
    go.disabled = true; msg.textContent = T.archImporting(0, 0);
    let r;
    try { r = await importFile(f, { kind: kind.value, secret: secret.value, send, onProgress: (g, i) => { msg.textContent = T.archImporting(g, i); } }); } catch { r = { error: 'failed' }; }
    secret.value = '';
    go.disabled = false;
    if (r && r.ok) { msg.textContent = T.archDone(r.groups, r.items, r.damaged) + (r.complete === false ? ' · ' + T.archErrCut : ''); if (onDone) onDone(r); return; }
    msg.textContent = ERR(T, r && r.error);
  });
  return [el('p', { class: cls.muted }, T.archImportHelp), el('label', { for: 'arFile' }, T.archFile), file, el('label', { for: 'arSecret' }, T.archOldSecret), kind, secret, msg, go];
}
