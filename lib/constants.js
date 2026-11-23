// Defaults, storage key names and limits.

export const DEFAULTS = {
  autoSuspend: true,
  suspendAfterMin: 20,
  lowMemThresholdMin: 5,
  lowMemRatio: 0.15,
  startupDiscard: true,
  whitelist: ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'discord.com'],
  restoreRemovesGroup: true, // opening a whole session removes its entries from the list (they go to the trash, type 'opened')
  restoreRemovesItem: true, // opening ONE tab removes its entry (Ctrl/Cmd+click always keeps it)
  dedupeOnStash: true,
  autoStashDays: 0, // 0 = off; options 0,3,7,14,30
  restoreChunk: 100, // tabs opened per restore step
  restoreMode: 'auto', // how tabs are opened: 'auto' (adaptive to free RAM) | 'sequential' (lightest) | 'fast' (batches, still frozen) | 'loadAll' (no discard)
  discardOnRestore: true, // freeze each restored tab as soon as its url is committed (it reloads when the user clicks it)
  refreshRediscard: true, // refresh-all: freeze each tab again after it finished loading
  stashGrouping: 'session', // multi-window stash: 'window' = one group per window, 'session' = one group for all
  iconScope: 'all', // what the toolbar icon stashes: 'window' (this window) or 'all'
  iconClickAction: 'stash', // 'stash' = stash immediately, 'popup' = open popup.html
  // internal pages: 'keep' = never touched, 'save' = save the URL and close, 'close' = close unsaved (only newtab/downloads/extensions)
  internalPages: 'save', // chrome://, about:, devtools, other extensions' pages: 'save' (save the URL, then close) | 'close' (close without saving). New-tab/blank pages are always closed unsaved.
  closeDuplicates: 'off', // 'off' | 'onStash' | 'auto' (silent duplicate closing is opt-in)
  dupAutoMinutes: 30,
  dupIgnoreUtm: false,
  theme: 'auto',
  language: 'auto', // 'auto' (default: follows the browser language, Thai or English) | 'th' | 'en'
  density: 'comfortable', // 'comfortable' | 'compact'
  urlDisplay: 'domain', // 'none' | 'domain' | 'short' | 'full'
  hoverActions: 'hover', // row buttons: 'hover' | 'always'
  defaultExpand: 'all', // sessions expanded when the page opens: 'all' | 'newest' | 'none'
  trashDaysDeleted: 30, // sessions / tabs the user deleted are purged after this many days (0 = never)
  trashDaysOpened: 7, // entries removed by opening them are purged after this many days (0 = never)
  copyFormat: 'urlTitle', // 'urlTitle' | 'titleUrl' | 'url' | 'markdown' | 'rich'
  singleRestore: 'switch', // clicking ONE saved tab: 'switch' (go to it) | 'stay' (open in the background)
  groupRestore: 'auto', // opening a whole session: 'auto' | 'new' (always a new window) | 'current'
  titleClick: 'edit', // clicking a session title: 'edit' | 'restore'
  autoRulesOn: false, // opt-in: file new sessions into categories by site (rules below)
  autoRulesText: '', // one rule per line: "github.com=Work" or "contains:youtube=Later"
  includePinned: false, // stash pinned tabs too
  warnAudibleStash: false, // opt-in: the popup asks before saving tabs that are playing sound
  excludeSites: [], // hosts that are never stashed (their tabs stay open)
  autoSnapshot: true, // remember the open tabs for crash recovery (one cheap alarm, no tab listeners)
  snapshotMinutes: 3, // 1 | 3 | 5 | 10
  closeOwnPages: true, // a stash also closes the old list pages of this extension, then ONE fresh list page opens
  showFavicons: true, // per-host favicon cache in the list page (off = no icon requests at all)
  favMode: 'auto', // advanced/hidden: favicon storage in the list page, 'auto' | 'atlas' (one shared sprite sheet) | 'img' (one <img> per row); applies after reloading the page
  mediaProtect: true, // never auto-suspend tabs that play audio/video (by playback state, not by site)
  mediaGraceMin: 30, // minutes after the last playback during which a tab stays protected (5 | 15 | 30 | 60 | 120)
  mediaEndedMin: 5, // finished (ended) media tabs become eligible again after this many minutes (0 | 5 | 15 | 30)
  keepTabGroups: true, // stash tabs together with their Chrome tab groups and restore them as groups
  timeDisplay: 'compact', // time in the list: 'none' | 'compact' | 'full'
  dateCalendar: 'auto', // 'auto' (Thai UI: Buddhist era, English UI: Gregorian) | 'be' | 'ce'
  activityTracking: true, // local-only usage stats (last used / opened time / activity counters). All data stays on this device.
  preciseOpenTime: false, // opt-in: wake the service worker on every new tab to record its exact opening time
  retentionDays: 400, // days of daily stats kept (0 = unlimited)
  ramCalibrate: true, // measure the real RAM freed per tab to tune the estimate
  sessionCover: true, // favicon mosaic on tab set rows
  shortcutsOn: true, // master switch for the in-page keyboard shortcuts of the list page (Esc always works)
  kbSearch: true, // '/' focuses the search box
  kbPalette: true, // Ctrl/Cmd+K opens the command palette
  kbUndo: true, // Ctrl/Cmd+Z undoes the last delete
  kbRename: true, // F2 renames a tab set
  kbSelect: true, // Space, arrows, Ctrl/Cmd+A and Enter on rows
  kbDelete: true, // Delete / Backspace removes the selected rows
  peekOnHover: true, // preview the first tabs of a collapsed tab set on hover
  celebrate: true, // toast after saving 20+ tabs
  setLook: true, // colour label + emoji on tab set rows
  accent: 'blue', // accent colour name
};

// Bump when defaults change on purpose: settings.js then rewrites the keys listed in its migration ONCE.
export const SETTINGS_VERSION = 4;

export const KEYS = {
  SETTINGS: 'settings',
  SNAP_BANNER: 'snapBanner',
  DUP_LOG: 'dupLog',
  DUP_TOTAL: 'dupTotal',
  // vault (second copy) lives in chrome.storage.local
  VAULT_INDEX: 'vault:index',
  VAULT_PREFIX: 'vault:',
  // legacy (v1) keys, only read by migrate.js
  LEGACY_META: 'meta',
  LEGACY_TRASH: 'trash',
  LEGACY_GROUP_PREFIX: 'g:',
  LEGACY_BACKUP_PREFIX: 'bak:',
  // chrome.storage.session
  S_AUDIBLE: 'audible', // tabId -> last time the tab was audible / playing media (survives SW restarts)
  S_OVERRIDE: 'tabOverride', // tabId -> 'keep' | 'allow' | 'now'
  S_PROTECT: 'tabProtect', // last sweep: tabId -> {r: reason, t}
  S_SWEEPSTAT: 'sweepStat', // last sweep: {reason: null | 'noHostAccess', t}
  S_LINKCOUNT: 'linkCount',
  S_BSESS: 'bsess',
  S_BOOTED: 'booted',
};

// ---- database ----
export const DB_NAME = 'cmr';
export const DB_VERSION = 8; // v2: + ixlog (search index change log); v3: + categories, siteIdx; v4: + snapshots (crash-recovery tab snapshots); v5: + sy / syiid / sykv (cross-device sync bookkeeping); v6: + sparse indexes on items (byT ts, bySite [site,g], byTk tk) for the flat all-items view; v7: + activity (local usage stats); v8: + ekeys / inbox / sites (password lock: batch keys, groups with unsealed rows, token -> host rows; empty while the lock is off)
export const IXLOG_CAP = 5000; // change-log entries kept (older ones are dropped and the index rebuilds)
export const SEARCH_DB = 'cmr-search'; // snapshots of the in-memory search index (owned by search-worker.js)
export const APPEND_CHUNK = 1000; // items per write transaction
export const MAX_URL = 65536; // longer urls are never saved (their tab stays open)
export const MAX_TITLE = 1024;

// ---- limits / timings ----
export const MB_PER_TAB_EST = 80;
export const RESTORE_CONCURRENCY = 3;
export const RESTORE_DISCARD_TIMEOUT_MS = 8000;
export const PROBE_TIMEOUT_MS = 2000;
export const AUDIBLE_GRACE_MS = 300000;
export const TRASH_DAYS = 30;
export const PURGE_CHUNK = 2000; // items per purge / bulk-trash transaction
export const TRASH_DAY_OPTS = [1, 3, 7, 14, 30, 90, 0]; // 0 = never
export const CONFIRM_MANY = 50; // page asks before opening more tabs than this
export const PAGE_ROWS = 200; // item rows loaded per page
export const AUTO_LOAD_MAX = 2000; // rows auto-loaded on scroll before showing a button
export const GROUPS_PER_PAGE = 50;
export const SEARCH_CAP = 500;
export const SEARCH_MIN = 2;

export const STASH_PAGE = 'stash.html';

// ---- memory-aware drain ----
// ratio = availableCapacity / capacity. Level is the first whose `min` is <= ratio.
export const DRAIN_LEVELS = [
  { name: 'healthy', min: 0.25, discard: 40, remove: 80, delay: 150 },
  { name: 'low', min: 0.12, discard: 15, remove: 30, delay: 600 },
  { name: 'critical', min: 0.05, discard: 4, remove: 10, delay: 2000 },
  { name: 'severe', min: 0, discard: 2, remove: 5, delay: 4000 },
];
export const DRAIN_CALL_TIMEOUT_MS = 15000;
export const DRAIN_BACKOFF_MS = [5000, 15000, 30000, 60000];
export const DRAIN_STALL_AFTER = 5; // consecutive timeouts before pausing as "stalled"
export const RECONCILE_EVERY = 500; // removals between full reconciliations

export const ALARMS = {
  SWEEP: 'sweep',
  DAILY: 'daily',
  STARTUP: 'startup',
  VAULT: 'vault',
  VAULT_SOON: 'vault-soon',
  DRAIN: 'drain',
  DUP: 'dup',
  SNAPSHOT: 'snapshot',
  SNAPCHECK: 'snapcheck',
  SYNC_CHECK: 'sync-check', // hourly consistency check
  SYNC_RETRY: 'sync-retry', // one-shot retry after a failed push/pull
  PURGE: 'purge', // trash retention, every 6 h (+ at startup)
  LOCK: 'lockcheck', // password lock: idle auto-lock check, every minute while unlocked
};
export const DUP_LOG_MAX = 200;

// Service-worker side strings (the page's strings live in STR at the top of stash.js).
export const STR_SW = {
  menuOpen: 'เปิดรายการที่เก็บไว้',
  menuTab: 'เก็บแท็บนี้',
  menuOthers: 'เก็บแท็บอื่นทั้งหมด (ยกเว้นแท็บนี้)',
  menuRight: 'เก็บแท็บที่อยู่ทางขวา',
  menuAll: 'เก็บทุกหน้าต่าง',
  menuWhitelist: 'ไม่พักแท็บของเว็บนี้เลย (กดอีกครั้งเพื่อยกเลิก)',
  defaultTitle: 'Tabroost – คลิกเพื่อเก็บแท็บ (Click to save tabs)',
  errorTitle: 'Tabroost: เก็บแท็บไม่สำเร็จ แท็บทั้งหมดยังเปิดอยู่ ไม่มีอะไรถูกปิด ลองใหม่อีกครั้ง',
  badgeTitle: (n, m, gb) => `Tabroost · พักแท็บอยู่ ${n} แท็บ · เก็บไว้ ${m} แท็บ · ประหยัดแรมประมาณ ${gb} GB`,
  drainTitle: (c, t, free, level) => `Tabroost — กำลังปิดแท็บ ${c}/${t} · ${level === 'healthy' ? 'แรมยังพอ' : `แรมเหลือ ${free}% (ปิดช้าลง)`}`,
  drainPaused: 'Tabroost — หยุดปิดแท็บไว้ชั่วคราว',
  windowTitle: (k, n) => `หน้าต่าง ${k} · ${n} แท็บ`,
  menuAllOne: 'เก็บทุกหน้าต่าง',
  menuKeepTab: 'ไม่พักแท็บนี้ชั่วคราว (กดอีกครั้งเพื่อยกเลิก)',
  menuSuspendNow: 'พักแท็บนี้เดี๋ยวนี้',
  newCategory: 'หมวดหมู่ใหม่',
};
