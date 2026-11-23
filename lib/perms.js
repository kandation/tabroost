// Optional permissions (requested at run time, never at install). Pure helpers: every function takes the `chrome` object so the
// guard logic can be tested with a fake. Nothing here throws; a missing API or a rejected call reads as "not granted".
//
//   host      -> optional_host_permissions ["<all_urls>"]  (lets the sleep check look at a page for typed text / playing video)
//   bookmarks -> optional_permissions ["bookmarks"]        (cross-device sync)
//   sessions  -> optional_permissions ["sessions"]         (Chrome's "recently closed" list)

export const OPTIONAL = {
  host: { origins: ['<all_urls>'] },
  bookmarks: { permissions: ['bookmarks'] },
  sessions: { permissions: ['sessions'] },
};
export const NAMES = Object.keys(OPTIONAL);

const pick = (name) => OPTIONAL[name] || null;

/** True when the permission is granted right now. */
export async function has(name, api = globalThis.chrome) {
  const p = pick(name);
  try {
    if (!p || !api || !api.permissions || !api.permissions.contains) return false;
    return !!(await api.permissions.contains(p));
  } catch { return false; }
}

export const hasHost = (api) => has('host', api);

/** Must be called straight from a click handler (user gesture), before any other await. Resolves true/false, never throws. */
export function request(name, api = globalThis.chrome) {
  const p = pick(name);
  try {
    if (!p || !api || !api.permissions || !api.permissions.request) return Promise.resolve(false);
    return Promise.resolve(api.permissions.request(p)).then((r) => !!r, () => false);
  } catch { return Promise.resolve(false); }
}

/** Takes the permission away again (never touches saved data). */
export async function remove(name, api = globalThis.chrome) {
  const p = pick(name);
  try {
    if (!p || !api || !api.permissions || !api.permissions.remove) return false;
    return !!(await api.permissions.remove(p));
  } catch { return false; }
}

/** Reads all three in one go: {host, bookmarks, sessions}. */
export async function snapshot(api = globalThis.chrome) {
  const out = {};
  for (const n of NAMES) out[n] = await has(n, api);
  return out;
}

/** Which of our names does a chrome.permissions onAdded/onRemoved payload touch? */
export function namesIn(payload) {
  const out = [];
  const perms = (payload && payload.permissions) || [];
  const origins = (payload && payload.origins) || [];
  if (perms.includes('bookmarks')) out.push('bookmarks');
  if (perms.includes('sessions')) out.push('sessions');
  if (origins.some((o) => o === '<all_urls>' || o === '*://*/*' || o === 'http://*/*' || o === 'https://*/*')) out.push('host');
  return out;
}

/** The chrome.bookmarks / chrome.sessions object only when the permission is really there. */
export const bookmarksApi = (api = globalThis.chrome) => (api && api.bookmarks && typeof api.bookmarks.getChildren === 'function' ? api.bookmarks : null);
export const sessionsApi = (api = globalThis.chrome) => (api && api.sessions && typeof api.sessions.getRecentlyClosed === 'function' ? api.sessions : null);

/** True when an executeScript failure just means "no access to this page" (permission not granted / restricted page). */
export function isAccessError(e) {
  return /cannot access|cannot be scripted|extension manifest must request permission|permission/i.test(String((e && e.message) || e || ''));
}
