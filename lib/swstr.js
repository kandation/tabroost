// Service-worker side texts (context menus, toolbar tooltips, default names made at run time).
// Thai lives in STR_SW (lib/constants.js); this file holds the English twin and the language lookup.
// The language comes from the same setting as the pages (settings.language: 'auto' | 'th' | 'en').
import { STR_SW, KEYS } from './constants.js';
import { resolveLang } from './i18n.js';

const plural = (n, one, many) => (n === 1 ? one : many);

export const STR_SW_EN = {
  menuOpen: 'Open the saved list',
  menuTab: 'Save this tab',
  menuOthers: 'Save all other tabs (except this one)',
  menuRight: 'Save the tabs to the right',
  menuAll: 'Save all windows',
  menuWhitelist: 'Never sleep tabs of this site (click again to undo)',
  defaultTitle: 'Tabroost: click to save tabs',
  errorTitle: 'Tabroost: could not save the tabs. All your tabs are still open and nothing was closed. Try again.',
  badgeTitle: (n, m, gb) => `Tabroost · ${n} sleeping ${plural(n, 'tab', 'tabs')} · ${m} saved ${plural(m, 'tab', 'tabs')} · about ${gb} GB of RAM saved`,
  drainTitle: (c, t, free, level) => `Tabroost: closing tabs ${c}/${t} · ${level === 'healthy' ? 'enough RAM' : `${free}% RAM left (closing slower)`}`,
  drainPaused: 'Tabroost: closing tabs is paused for now',
  windowTitle: (k, n) => `Window ${k} · ${n} ${plural(n, 'tab', 'tabs')}`,
  menuAllOne: 'Save all windows',
  menuKeepTab: 'Do not sleep this tab for now (click again to undo)',
  menuSuspendNow: 'Sleep this tab now',
  newCategory: 'New category',
};

/** The language in use ('th' | 'en'), from the saved setting. Never throws. */
export async function swLang() {
  let pref = 'th';
  try { const r = await chrome.storage.local.get(KEYS.SETTINGS); pref = (r[KEYS.SETTINGS] && r[KEYS.SETTINGS].language) || 'th'; } catch { /* default */ }
  return resolveLang(pref);
}

/** Service-worker strings in the language in use. Missing English keys fall back to Thai. */
export async function swStr() {
  return (await swLang()) === 'en' ? { ...STR_SW, ...STR_SW_EN } : STR_SW;
}
