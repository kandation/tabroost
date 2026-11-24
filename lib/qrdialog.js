// QR code dialog of one link: a large code to scan with a phone, the title and address under it, and buttons to copy the picture
// or save it as a PNG. The code is generated on this device (lib/qr.js); nothing is sent anywhere.

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** t: { qrTitle, qrCopy, qrSave, qrCopied, qrFailed, qrTooLong, qrDone } ; toast(text) shows a message. */
export async function openQrDialog({ url, title, t, toast }) {
  let qr;
  try { qr = await import('./qr.js'); } catch { toast(t.qrFailed); return null; }
  let matrix;
  try { matrix = qr.qrMatrix(url, { ecc: 'M' }); } catch { toast(t.qrTooLong); return null; }

  const dlg = el('dialog', 'look-dlg qr-dlg');
  dlg.setAttribute('aria-label', t.qrTitle);
  const head = el('div', 'ld-h');
  head.append(el('h2', 'ld-t', t.qrTitle));
  const body = el('div', 'qd-body');
  const pic = el('div', 'qd-pic');
  pic.innerHTML = qr.qrSvg(matrix, { margin: 2 }); // our own generated SVG string, never page text
  const name = el('div', 'qd-name', title || url);
  const addr = el('div', 'qd-url', url);
  body.append(pic, name, addr);

  const png = () => new Promise((resolve) => {
    const c = document.createElement('canvas');
    qr.qrCanvas(matrix, c, { scale: 10, margin: 3 });
    c.toBlob((b) => resolve(b), 'image/png');
  });
  const foot = el('div', 'ld-f');
  const copy = el('button', 'btn', t.qrCopy); copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { const b = await png(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast(t.qrCopied); } catch { toast(t.qrFailed); }
  });
  const save = el('button', 'btn', t.qrSave); save.type = 'button';
  save.addEventListener('click', async () => {
    try {
      const b = await png();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = 'qr-' + (new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '') || 'link') + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch { toast(t.qrFailed); }
  });
  const done = el('button', 'btn primary', t.qrDone); done.type = 'button';
  done.addEventListener('click', () => dlg.close());
  const right = el('span', 'qd-right');
  right.append(save, done);
  foot.append(copy, right);

  dlg.append(head, body, foot);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  done.focus();
  return dlg;
}
