// Page side of the encrypted archive (lib/lock/archive.js has the file format): build the file from the database rows exactly as
// they sit on disk. Works while locked (no key is needed: rows are copied, never decoded). A row that is still plain text
// (the lock was just turned on and the migration is not finished) stops the export: the file must never contain plain text.
import * as db from './db.js';
import { headerLine, rowLine, endLine, STORES, parseHeader } from './lock/archive.js';
import { slotsOf } from './lock/keys.js';
import { assertSlots } from './lockpk.js';

const PAGE = 1000;
const keyOf = (row, kp) => (Array.isArray(kp) ? kp.map((k) => row[k]) : row[kp]);
const isPlain = (store, r) => (store === 'trash' ? (r.items || []).some((i) => i.e === undefined) : store === 'ekeys' ? false : r.e === undefined);

export const archiveName = (d = new Date()) => `tabroost-archive-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.tabroost`;

/** @returns {Promise<{blob, counts, name} | {error:'nolock'|'plain', n?:number}>} */
export async function buildArchive({ onProgress } = {}) {
  const lockRow = await db.getLockRow();
  if (!lockRow) return { error: 'nolock' };
  const parts = [headerLine(lockRow) + '\n'];
  const counts = {};
  let plain = 0;
  for (const [store, kp] of STORES) {
    let after = null;
    let n = 0;
    for (;;) {
      const rows = await db.readRaw([store], (s) => db.req(s[store].getAll(after == null ? null : IDBKeyRange.lowerBound(after, true), PAGE)));
      if (!rows.length) break;
      for (const r of rows) if (isPlain(store, r)) plain++;
      if (plain) return { error: 'plain', n: plain };
      parts.push(rows.map((r) => rowLine(store, r)).join('\n') + '\n');
      n += rows.length;
      after = keyOf(rows[rows.length - 1], kp);
      if (onProgress) onProgress({ store, n });
      if (rows.length < PAGE) break;
    }
    counts[store] = n;
  }
  parts.push(endLine(counts) + '\n');
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), counts, name: archiveName() };
}


/**
 * Read a .tabroost file and hand it to the service worker in batches (lib/lockarchimp.js). `send` = runtime message helper.
 * kind: 'pw' | 'rec' | 'bk' (backup password) | 'pk' (passkey: the browser asks for it, secret is unused). Returns {ok, complete, groups, items, damaged} or {error}.
 */
export async function importFile(file, { kind, secret, send, onProgress } = {}) {
  const reader = file.stream().getReader();
  const dec = new TextDecoder();
  let rest = '';
  let header = null;
  let batch = [];
  let bytes = 0;
  const bail = async (error) => { try { await send({ type: 'lock.archive.abort' }); } catch { /* ignore */ } return { error }; };
  const flush = async () => {
    if (!batch.length) return null;
    const r = await send({ type: 'lock.archive.rows', lines: batch });
    batch = []; bytes = 0;
    if (!r || !r.ok) return r || { error: 'failed' };
    if (onProgress) onProgress(r.groups, r.items);
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    rest += done ? dec.decode() : dec.decode(value, { stream: true });
    const parts = rest.split('\n');
    rest = done ? '' : parts.pop();
    for (const line of parts) {
      if (!line) continue;
      if (header === null) {
        header = line;
        const msg = { type: 'lock.archive.begin', header, [kind === 'rec' ? 'recoveryKey' : kind === 'bk' ? 'backupPassword' : 'password']: secret };
        if (kind === 'pk') {
          let list = [];
          try { list = slotsOf(parseHeader(header).lock).filter((s) => s.kind === 'prf'); } catch { return bail('format'); }
          if (!list.length) return bail('noSlot');
          const a = await assertSlots(list);
          if (a.error) return bail(a.error === 'cancel' ? 'pkCancel' : a.error === 'nosupport' ? 'pkNoSupport' : 'pkFail');
          delete msg.password; msg.slot = { id: a.id, prf: a.prf };
        }
        const r = await send(msg);
        if (!r || !r.ok) return bail((r && r.error) || 'failed');
        continue;
      }
      batch.push(line); bytes += line.length;
      if (bytes > 3000000 || batch.length >= 2000) { const bad = await flush(); if (bad) return bail(bad.error || 'failed'); }
    }
    if (done) break;
  }
  if (header === null) return bail('format');
  const bad = await flush();
  if (bad) return bail(bad.error || 'failed');
  return send({ type: 'lock.archive.end' });
}
