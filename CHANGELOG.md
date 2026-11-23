# Changelog

Format follows Keep a Changelog. Versions follow the `version` field in manifest.json.

## [Unreleased]

### Added
- Settings > Shortcuts: a master switch for the keyboard shortcuts of the list page, one switch per shortcut (search `/`, command palette Ctrl/Cmd+K, undo Ctrl/Cmd+Z, rename F2, keyboard selection, Delete), and a read-only list of Chrome's global commands with their assigned keys and a button that opens chrome://extensions/shortcuts. Keys cannot be remapped here; Esc always works.
- Optional password lock (off by default). Encrypts titles, links, sites, notes, set names, the trash, crash-recovery copies, the vault copy and site rules on this computer. Tabs can still be saved while locked (encrypted to a public key, tabs close only after the saved copy is verified); they are sorted into the list after the next unlock. Auto-lock (idle time, screen lock, closing the list page), recovery key, change password, turn off (restores readable data), erase everything.
- New permission `idle` (no install warning), used only to lock when the screen locks.
- Database version 8: empty stores `ekeys`, `inbox`, `sites` (used only while the lock is on).
- Password lock and sync now work together: with the lock on, the sync state and the last-synced copies are sealed on this computer, sync pauses while locked and resumes by itself after unlock, and groups stashed while locked are published once they are sealed. The synced data stays encrypted in the sync folder with the sync passphrase.
- Encrypted backup file (.tabroost) before "erase everything" on the lock screen and in settings: the erase button needs the typed word and either the pressed save link or an explicit "erase without a backup" tick. The file opens only with the old password or recovery key. Settings > Password lock > import adds its tab sets back as new groups.
- Tests: tests/ui/lock-sync-archive.mjs (real Chrome: lock + sync + locked stash + erase + import).
- Two more ways to unlock the password lock if you forget the password: a backup password and a passkey / security key (WebAuthn PRF), both set up in Settings while unlocked. They wrap the same key as the recovery key, keep working after you change the main password, share the wrong-attempt delay, and are removed by "erase everything". A backup file also opens with them. Findings: docs/webauthn-prf-findings.md. Tests: tests/lock/run.mjs (unlock slots), tests/ui/lock-slot.mjs.

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

