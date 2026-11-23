// Encrypted archive file of a locked / unlocked database ("keep the old data before erasing, import it later").
// Pure (WebCrypto only): serialisation, header check, opening with the OLD password or recovery key, decoding rows.
//
// The file is the database exactly as it sits on disk while the lock is on: the item / group / category / trash payloads are
// ciphertext, `meta.lock` (the password + recovery wrappers of the master key) and the inbox batch keys (`ekeys`) travel with it.
// So the file opens only with the old password or the old recovery key, and nothing readable (titles, links, group names) is in it.
// Fields the app keeps readable on disk anyway (counts, timestamps, star / lock flags, blind site tokens) stay readable.
//
// Format: UTF-8 text, one JSON object per line.
//   line 1   {"tabroost":"archive","v":1,"ts":<ms>,"lock":<meta.lock row>}
//   rows     {"s":"<store>","r":<row>}        stores in this order: ekeys, sites, categories, groups, items, trash
//   last     {"end":true,"counts":{...}}      a file without it was cut short and is refused
// Uint8Array values are written as {"$b":"<base64>"}.
import { b64enc, b64dec } from './bytes.js';
import { unlockWithPassword, unlockWithRecovery, unlockWithBackupPassword, unlockWithSlot } from './keys.js';
import { makeBatchResolver } from './inbox.js';
import { decodeItem, decodeGroup, decodeCategory, decodeSiteRow } from './rec.js';

export const FORMAT = 'tabroost-archive';
export const VERSION = 1;
/** store -> keyPath used to page through it (the page reads them in this order) */
export const STORES = [['ekeys', 'kid'], ['sites', 'site'], ['categories', 'id'], ['groups', 'id'], ['items', ['g', 'seq']], ['trash', 'tid']];

const replacer = (_k, v) => (v instanceof Uint8Array ? { $b: b64enc(v) } : v);
const reviver = (_k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' && Object.keys(v).length === 1 ? b64dec(v.$b) : v);
/** revive a row that went through JSON (e.g. a runtime message) */
export const revive = (row) => JSON.parse(JSON.stringify(row), reviver);

export const headerLine = (lockRow, ts = Date.now()) => JSON.stringify({ tabroost: 'archive', v: VERSION, ts, lock: lockRow }, replacer);
export const rowLine = (store, row) => JSON.stringify({ s: store, r: row }, replacer);
export const endLine = (counts) => JSON.stringify({ end: true, counts });

export class ArchiveFormatError extends Error { constructor(m) { super('not a Tabroost archive: ' + m); this.name = 'ArchiveFormatError'; } }

/** Parse + check the first line. Returns {ts, lock} (lock = meta row with Uint8Array fields). */
export function parseHeader(line) {
  let o;
  try { o = JSON.parse(line, reviver); } catch { throw new ArchiveFormatError('unreadable header'); }
  if (!o || o.tabroost !== 'archive') throw new ArchiveFormatError('wrong file type');
  if (o.v !== VERSION) throw new ArchiveFormatError('version ' + o.v);
  const l = o.lock;
  if (!l || !l.pw || !l.pw.salt || !(l.pub instanceof Uint8Array) || !(l.priv && l.priv.ct) || !l.check) throw new ArchiveFormatError('no lock record');
  return { ts: o.ts, lock: l };
}

/** One row line -> {store, row} or {end, counts}. */
export function parseLine(line) {
  const o = JSON.parse(line, reviver);
  if (o && o.end === true) return { end: true, counts: o.counts || {} };
  if (!o || typeof o.s !== 'string' || !o.r) throw new ArchiveFormatError('bad row');
  return { store: o.s, row: o.r };
}

/**
 * Open the archive with the OLD password or the OLD recovery key (never counts against the live lock's lockout: the file is
 * an offline copy). Throws the lock's own errors (WrongPasswordError, WrongRecoveryKeyError, RecoveryFormatError,
 * NoRecoveryKeyError, PubTamperedError, LockMetaError). Returns a decoder.
 */
export async function openArchive(lockRow, { password, recoveryKey, backupPassword, slot, lang = 'th' } = {}) {
  // slot = { id, prf: Uint8Array(32) } (passkey); backupPassword = the second password. Both are wrappers of the same master key.
  const r = recoveryKey != null && String(recoveryKey).trim() !== ''
    ? await unlockWithRecovery(lockRow, String(recoveryKey))
    : backupPassword != null && String(backupPassword) !== ''
      ? await unlockWithBackupPassword(lockRow, String(backupPassword))
      : slot && slot.id
        ? await unlockWithSlot(lockRow, String(slot.id), slot.prf)
        : await unlockWithPassword(lockRow, String(password || ''));
  const keys = r.keys;
  const ekeys = new Map();
  const reader = keys.reader(makeBatchResolver(keys.sk, async (kid) => ekeys.get(kid) || null), lang);
  return {
    addEkeys(rows) { for (const x of rows) if (x && Number.isInteger(x.kid)) ekeys.set(x.kid, x); },
    group: (row) => decodeGroup(row, reader),
    item: (row) => decodeItem(row, reader),
    category: (row) => decodeCategory(row, reader),
    site: (row) => decodeSiteRow(row, reader),
  };
}
