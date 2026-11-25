// Page side of the mirrored preferences. The print options and the recently used emoji are kept in this page's localStorage (read
// synchronously by the dialogs). The service worker cannot read localStorage, so every change is copied to chrome.storage.local 'prefs'
// (message 'prefs:set'); that copy is what the backup file, "sync settings too" and the other devices see. When the copy changes
// without us (sync brought a newer value) the 'prefs' bus event calls pullPrefs(), which writes it back into localStorage.
import { cleanPrint, cleanEmojiRecent } from './sync/prefs.js';

export const PREF_LS = { print: 'cmr.printOpts', emoji: 'cmr.emojiRecent' };
const CLEAN = { print: cleanPrint, emoji: cleanEmojiRecent };

export function readLocalPref(name) {
  try { const raw = localStorage.getItem(PREF_LS[name]); return raw == null ? undefined : CLEAN[name](JSON.parse(raw)); } catch { return undefined; }
}
export function writeLocalPref(name, value) {
  try { localStorage.setItem(PREF_LS[name], JSON.stringify(CLEAN[name](value))); } catch { /* storage unavailable */ }
}
/** A preference changed on this page: keep the service worker's copy current (fire and forget). */
export function sendPref(name, value) {
  try { Promise.resolve(chrome.runtime.sendMessage({ type: 'prefs:set', name, value })).catch(() => {}); } catch { /* no runtime */ }
}
/**
 * Make localStorage agree with the service worker's copy. A value that exists only here (set before this feature existed) is sent up once.
 * Returns true when something in localStorage changed.
 */
export async function pullPrefs() {
  let remote = {};
  try { const r = (await chrome.storage.local.get('prefs')).prefs; if (r && typeof r === 'object') remote = r; } catch { return false; }
  let changed = false;
  for (const name of Object.keys(PREF_LS)) {
    const mine = readLocalPref(name);
    if (remote[name] !== undefined) {
      const theirs = CLEAN[name](remote[name]);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) { writeLocalPref(name, theirs); changed = true; }
    } else if (mine !== undefined) sendPref(name, mine);
  }
  return changed;
}
