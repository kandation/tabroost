// Shared theme / accent for ALL extension pages (list, popup, about). One place that maps settings.theme ('auto' | 'light' | 'dark' | 'time')
// and settings.accent to <html data-theme / data-accent>, and mirrors the choice into localStorage so /themeboot.js can apply it before first paint.
import { KEYS } from './constants.js';
let tm = 0;
export function resolveTheme(t) {
  if (t === 'time') { const h = new Date().getHours(); return h >= 7 && h < 18 ? 'light' : 'dark'; } // 'time' = light by day, dark at night
  return t === 'light' || t === 'dark' ? t : null;
}
export function applyThemeSettings(st) {
  const root = document.documentElement; const theme = (st && st.theme) || 'auto'; const ac = st && st.accent;
  const t = resolveTheme(theme);
  if (t) root.dataset.theme = t; else delete root.dataset.theme;
  if (ac && ac !== 'blue') root.dataset.accent = ac; else delete root.dataset.accent;
  try { localStorage.setItem('cmr.theme', JSON.stringify({ t: theme, a: ac || 'blue' })); } catch { /* private window etc. */ }
  clearTimeout(tm);
  if (theme === 'time') tm = setTimeout(() => applyThemeSettings(st), 10 * 60000); // re-checked every 10 minutes
}
// Popup / about: read the settings once, apply, and follow later changes made on another page.
export async function initTheme() {
  try {
    const r = await chrome.storage.local.get(KEYS.SETTINGS);
    applyThemeSettings(r[KEYS.SETTINGS] || {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[KEYS.SETTINGS]) applyThemeSettings(ch[KEYS.SETTINGS].newValue || {}); });
  } catch { /* opened outside the extension */ }
}
