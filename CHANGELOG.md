# Changelog

Format follows Keep a Changelog. Versions follow the `version` field in manifest.json.

## [1.0.1] - {{EFFECTIVE_DATE}}

### Added
- Tab sets: merge all windows of a set into one, and dissolve Chrome tab groups (one group or all), both with undo; windows of a set are separated by a labelled row of empty space.
- Archive like mail: a one-click archive button on every set; archived sets leave the main list, and a search hit inside one says so.
- Right-click menu replacing the browser's own on tab and set rows (big Copy tile, then an icon list); Shift+right-click keeps the browser menu.
- QR code for any link (right-click a tab), with copy image / save PNG. Generated on this device by lib/qr.js; no network.
- Printing a set: options dialog (full links, split by window and tab group, QR code per link) and a new A4 layout. Fixes a blank printout caused by the password-lock print rule.
- Set colour: pastel fill over the whole header (light and dark tuned); emoji replaces the favicon mosaic; a colour and emoji dialog with a "frequently used" tab and one tab per kind of emoji (no typing).
- Undo history for list management (toolbar button and Ctrl+Z); saving tabs is not part of it.
- Settings: a search box, and an icon on every card and side link.
- Sidebar categories show a folder icon (drop targets stay visible when the sidebar is icon-only).
- Box selection can start from anywhere empty in the main pane; text selection is off outside fields.
- The copy button sits in front of the favicon next to the delete button; row columns re-aligned.
- Rewritten set menu (toggle tiles for pin / star / archive / lock, grouped items, no nested "more" submenu).
- Settings > Shortcuts: a master switch for the keyboard shortcuts of the list page, one switch per shortcut (search `/`, command palette Ctrl/Cmd+K, undo Ctrl/Cmd+Z, rename F2, keyboard selection, Delete), and a read-only list of Chrome's global commands with their assigned keys and a button that opens chrome://extensions/shortcuts. Keys cannot be remapped here; Esc always works.
- Optional password lock (off by default). Encrypts titles, links, sites, notes, set names, the trash, crash-recovery copies, the vault copy and site rules on this computer. Tabs can still be saved while locked (encrypted to a public key, tabs close only after the saved copy is verified); they are sorted into the list after the next unlock. Auto-lock (idle time, screen lock, closing the list page), recovery key, change password, turn off (restores readable data), erase everything.
- New permission `idle` (no install warning), used only to lock when the screen locks.
- Database version 8: empty stores `ekeys`, `inbox`, `sites` (used only while the lock is on).
- Password lock and sync now work together: with the lock on, the sync state and the last-synced copies are sealed on this computer, sync pauses while locked and resumes by itself after unlock, and groups stashed while locked are published once they are sealed. The synced data stays encrypted in the sync folder with the sync passphrase.
- Encrypted backup file (.tabroost) before "erase everything" on the lock screen and in settings: the erase button needs the typed word and either the pressed save link or an explicit "erase without a backup" tick. The file opens only with the old password or recovery key. Settings > Password lock > import adds its tab sets back as new groups.
- Tests: tests/ui/lock-sync-archive.mjs (real Chrome: lock + sync + locked stash + erase + import).
- Two more ways to unlock the password lock if you forget the password: a backup password and a passkey / security key (WebAuthn PRF), both set up in Settings while unlocked. They wrap the same key as the recovery key, keep working after you change the main password, share the wrong-attempt delay, and are removed by "erase everything". A backup file also opens with them. Findings: docs/webauthn-prf-findings.md. Tests: tests/lock/run.mjs (unlock slots), tests/ui/lock-slot.mjs.

- Backup file format 3 (Settings > Backup and import): the export now holds everything except secrets and caches: every tab set (also archived and deleted ones) with note, colour, emoji, pinned / starred / to-do / locked state, categories, the trash (recoverable tabs), all settings including the site lists, the saved list view, print options and recent emoji. Older files (format 2, format 1 JSON, OneTab text) still import. The settings page lists what is and is not in the file.
- Importing a backup merges: a tab set that already exists (same id) only gets the tabs it is missing, categories with the same id or name are reused, a trash row already present is not added twice, nothing is removed or replaced. A tick box restores the settings and preferences from the file. Input is checked strictly (sizes capped, settings go through the same sanitiser as the settings page, unknown fields ignored).
- Sync protocol 2: categories and the rest of what you set on a tab set (pinned, to-do, archived, note, colour, emoji, category, window starts) now sync; devices on the older version keep working and simply skip them. After the upgrade each device reads the others' logs once so nothing is missed.
- New setting "Sync settings too" (Settings > Sync between devices, on by default): settings, the saved list view, site lists, print options and recent emoji sync one setting at a time (the later change wins). Device-specific settings (keyboard shortcuts, memory thresholds, restore speed, crash recovery, usage statistics), the sync set-up and the password lock never sync. Off = nothing sent, incoming values ignored; on again = this device's values are sent and the others are read again. The card also lists what syncs.
- Tests: tests/sync/prefs-sync.mjs (categories, new fields, settings toggle on / off / echo, hostile input), tests/ui/backup-roundtrip.mjs (export, wipe, import, merge, old formats, untrusted file), tests/ui/sync-kinds.mjs (two devices on the real database and bookmarks).

## [1.0.0] - {{EFFECTIVE_DATE}}

First public release.

### Added
- One-click save of all open tabs (all windows) as a "tab set", with memory-aware gradual closing.
- Restore of a tab or whole tab set in small steps; restored tabs stay asleep until clicked.
- Auto-sleep of idle tabs, with protection for tabs playing media, tabs with unsaved form input, and a site allow list.
- Fuzzy search, sort, group, filter, categories, pin/star, Chrome tab group preservation.
- Chrome split view (two tabs side by side): saved as a pair, reopened as a split view (also from snapshots), and never put to sleep next to a busy partner pane.
- Trash with retention, crash-recovery snapshots of open tabs, export/import (including text from other tab managers).
- Optional end-to-end-encrypted sync between devices through a dedicated bookmark folder.
- Thai and English interface, light/dark theme.
- Page access (to check for typed text or playing media before sleeping a tab), `bookmarks` (sync) and `sessions` (recently closed) are optional permissions asked at run time, not at install. Without page access auto-sleep stays paused. Store text comes from `_locales` (en, th).

