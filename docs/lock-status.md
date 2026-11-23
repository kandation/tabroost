# Password lock: integration status

Spec: `docs/spec-password-lock.md`. Core (pure, Node-tested): `lib/lock/*`, `node tests/lock/run.mjs` (47 tests).
Flag: the lock exists only after the user turns it on (`meta.lock` row in IndexedDB). With it off nothing runs: `db.setCodec(null)`,
no lock UI, no keys, no extra transactions.

## What is wired

| Spec step | State | Where |
|---|---|---|
| 1 Decoders that accept both formats | done | `lib/lockrt.js` (`codec`), hooks in every `lib/db.js` read helper, `db.decodeItems()` for `readRaw` readers, search worker (via db), snapshots, vault, settings. Legacy plaintext rows are accepted forever |
| 2 SW lock state | done | `lib/lockctl.js` + `handleLock()` in `sw.js`; messages below; session key `cmrKey` in `chrome.storage.session` (never `setAccessLevel`), keys imported non-extractable on each wake; lockout in `storage.local.lockFail`; `meta.lock` |
| 3 Lock screen | done | `lib/lockui.js`, `lock.css`; a locked page shows only the card; locking reloads the page (destroys DOM and decrypted caches) after telling the worker `{type:'lock'}` (it drops the index and closes) |
| 4 Encrypted write path (unlocked) | done | `db.js`: `appendItemsLock` (crypto before the transaction, seq check inside), `write()` gives lock-on transactions an `s.L` helper with a keep-alive `hold()` for crypto inside a transaction; `createGroup`, `updateGroup`, `moveItems`, `saveCategory`; trash / undo / recover move rows without re-encrypting; `t`/`tk` are no longer written |
| 5 Stash while locked (inbox) | done | `appendItemsLock` locked branch: ephemeral ECDH per batch, `ekeys` row + items + merged `inbox` row in one transaction; digest returned as `journal`; `verifyGroup(..., {journals})` reads the rows back; `lib/stash.js` passes the journals, tabs close only after that. Seal job (`lockctl.sealJob`, resumable, <= 2,000 rows per transaction) writes tokens, `siteIdx`, `sites`, then `aggOne()` rebuilds the encrypted group summary |
| 6 Search worker | done | keys by message `{type:'keys'}`, index in memory, progressive rebuild with progress, snapshot sealed with XK in <= 4 MB chunks (`lib/lock/snapcodec.js`); plaintext snapshots are deleted when the lock is on |
| 7 Snapshots, vault, journal, settings, menus | done with the deviations below | snapshots via the inbox (header counts/kind plain, banner while locked compares counts), vault copy sealed (`vault.js`), drain journal stores a salted hash instead of the URL (`lib/drainkey.js`), `excludeSites`/`whitelist`/`autoRulesText` sealed in `settings.sec` plus a match set for locked stashing (`lib/settings.js`), badge tooltip shows counts only, debug messages refused while the lock is on |
| 8 Migration / revert | done | `lockctl.migrateJob` / `revertJob` on `lib/lock/migrate.js`, adapter `lib/lockdb.js`; cancel = revert; survives a forced SW stop |
| 9 Recovery key, reset, lockout, auto-lock | done | recovery key shown once (print / copy, no download); `lock.resetErase`; alarm `lockcheck` every minute; `chrome.idle` locked state; lock when the last list page closes |
| 10 Settings card, popup, copy, docs | done | `lib/lockcard.js` (card "รหัสผ่านและความเป็นส่วนตัว"), `popup.js` locked box, `lib/lockstr.js` (TH) + `LOCK_EN` in `lib/i18n.js`, privacy policy / About / listing / README / SECURITY / CHANGELOG updated |

## Deviations from the spec (all deliberate, all documented to the user where it matters)

- **Group summary (`agg`) and host names.** `agg` (top sites) is inside the encrypted group payload as specified, but it is rebuilt by the SW (`lockctl.aggOne`, ~1.5 s after a write) instead of inside every item transaction. Groups carry a plain boolean `aggDirty` until then. `siteIdx.site` / `items.site` are blind tokens; `sites` rows `{site: token, e:{host}}` map them back.
- **Favicons.** While the lock is on the favicon cache is not stored at all (the page asks Chrome's `_favicon` again each time) and `cmr-fav` is emptied when the lock is turned on. The spec's encrypted atlas keyed by host token was not built.
- **Sync (now compatible with the lock).** `lib/syncseal.js` + `lib/synccontrol.js` + `lib/syncstore.js`: with the lock on, the engine state in `sykv` and the last-synced copies (`sy.ve`) are sealed under DK; the sync key (DEK) is kept as raw bytes inside a sealed blob (`dekraw`; the engine now creates it extractable, `dekExtractable`). Group / item writes of remote changes go through the lock encoders (`s.L`); rows that cannot be decoded are never written back or sent. While LOCKED the controller stands still (no engine, no timers, no reads or writes of sync state; only the plain boolean `syncFlag` in `storage.local` so locked stashes still mark `meta.syncDirty`); `onLockChange` restarts it from the saved state after unlock and `onSealed` scans groups that were still in the inbox. Turning the lock on seals the existing state (`sealAtRest`; a key made before the lock cannot be exported, so that device pairs again with "join", nothing else is lost); turning it off releases it first (`unsealAtRest`). Tests: `tests/sync/lock-sync.mjs`, `[sync + lock]` in `tests/lock/run.mjs`. NOT run in Chrome: the IndexedDB bindings (`syncstore.js` with `s.L`, `sealAtRest` / `eachSyRow`) are verified by reading only.
- **Drain journal.** URL replaced by a salted 53-bit hash (drift detection only; not reversible, but a known URL can be confirmed). Records disappear when the drain ends. The spec allowed "seq refs only or encrypted".
- **Duplicate-close log** (`dupLog`) is not kept while the lock is on (only the counter).
- **Per-item usage numbers (`d`)** are inside the item ciphertext. "Delete usage data" removes the activity rows and set summaries but cannot clear `d` inside ciphertext without decrypting (not done while the lock is on). The weekly per-site activity rows (`w:` in the `activity` store) still use host names as keys (not encrypted).
- **Pattern rules** (`contains:` auto rules, non-host excludes) do not apply while locked (as specified); host rules do (hash match set).
- `trash` / `move` on a group that still has unsealed inbox rows return `busy` until the seal job finished.
- `__cmr` (page debug object with the in-memory list state) still exists in an unlocked page; it is gone with the reload that locking does.
- `LOCKED_OK` in `sw.js` is an allow-list of messages that work while locked (stash, snapshot, drain controls, stats, settings that are not rule lists, `lock.*`); everything else answers `{error:'locked'}`.

## Messages (page <-> SW)

`lock.status` (also returns `slots`: id / kind / name / public WebAuthn parameters, never a wrapper), `lock.enable {password, withRecovery}`, `lock.unlock {password | recoveryKey + newPassword | backupPassword | slot:{id, prf}}`, `lock.lockNow`,
`lock.slotAddPassword {password, backup}`, `lock.slotAddPrf {password, name, cid, psalt, prf}`, `lock.slotRemove {password, id}`,
`lock.changePassword {old,new}`, `lock.newRecovery {password}`, `lock.removeRecovery {password}`, `lock.disable {password}`,
`lock.cancelMigration`, `lock.resetErase {confirm}`, `lock.setPolicy {idleMin,onScreenLock,onPageClose}`, `lock.touch`.
Broadcasts on the `cmr` BroadcastChannel: `lock.state`, `lock.progress`, `seal.progress`.

## New storage keys / db fields

- IndexedDB `cmr` v8: stores `ekeys {kid}`, `inbox {g}`, `sites {site}`; `meta` rows `lock` and `cur:<job>` (job cursors).
- Item rows: `k`, `e` (and blind `site`, `uh` tokens); `t`, `tk`, `url`, `title`, ... are no longer stored. Group rows: `k`, `e`, `aggDirty`.
- `chrome.storage.session.cmrKey`; `chrome.storage.local`: `lockFail`, `lockPolicy`, `lockJob`, `drainSalt`, `settings.sec` / `exH` / `wlH`.
- New permission: `idle`. New alarm: `lockcheck`.

## Measured (one Chrome, fresh profile, this machine; medians)

| Measure | Result | Budget |
|---|---|---|
| Lock OFF, stash 500 / 4,000 items (same page-level script, pre-lock build from the packaged zip vs this tree, run twice each) | pre-lock 50-89 ms / 429-458 ms; this tree 47-59 ms / 401-447 ms: no regression | no regression |
| Lock ON, unlocked, stash 500 / 4,000 | 65 ms / 466 ms in one run; 65 ms / 667 ms in a second run while the search worker re-indexed at the same time (+54% at 4,000: over the +30% figure under contention) | <= +30% |
| Lock ON, **locked** (inbox), stash 500 / 4,000 | run 1: 67 ms / 425 ms vs OFF baseline 50 ms / 437 ms (+34% at 500 = 17 ms absolute, -3% at 4,000); run 2: 58 ms / 405 ms vs baseline 63 ms / 432 ms (-8% / -6%) | 500: <= 0.39 s; 4,000: <= 1.3x |
| Unlock (PBKDF2 600k + key import), 10 runs, two sessions | 90-115 ms, median 96-104 ms | to first page <= 1.2 s |
| Seal, 13,500 items in 6 groups after the locked stashes | 4.1 s total (about 1.2 s per 4,000) | 4,000 <= 2 s |
| Migration of 21k items with a forced service-worker stop at 4,000 | finished in 15 s (the stop and restart included); 3k items: 1.9 s; counts and decoded content identical | 300k <= 90 s (not run at that size) |
| Disable (revert) of 21k items | 9 s; items, groups, categories, trash, siteIdx and settings compare byte-identical (canonical JSON hash) to the state before the lock was turned on | byte-identical |
| Search ready after unlock (worker rebuild, 40,500 docs) | within the first poll (< 3 s) | 300k <= 3 s |
| Search worker from the sealed snapshot after a restart (1,930 docs) | 746 ms to ready + first search | |
| Lockout | 3 free tries, then 2 s, 4 s, 8 s; failure count and until-time survive a browser restart; a refused attempt does not count | schedule |
| Tampering | one flipped byte in an item: that row reads "รายการเสียหาย", neighbours fine, no crash | |
| Auto-lock | idle (clock moved), closing the list page: locked, `storage.session` has no `cmrKey`, the page shows only the lock screen with no rows, no search worker left | |
| Locked stash through the real service worker (24 real tabs, one on an excluded host) | 24 saved in 87 ms, tabs closed only after the digest check, the excluded tab stayed open, all 24 found after unlock + seal | zero loss |
| Leak scan after a locked stash, browser restart and unlock (grep of the whole profile for 12 URLs) | 0 hits in the extension's storage (IndexedDB, Local Extension Settings); hits only in Chrome's own History / Sessions / Top Sites | zero |
| Leak scan right after migrating a seeded profile | 3 of 55 needles still found: one host name in an IndexedDB LevelDB file and the two old site-rule hosts in the extension's chrome.storage LevelDB: pre-migration remnants (see below) | zero except documented remnants |

## Not verified / known limits

- UI regressions (popover, scroll, filter, selection-dnd) were run with the lock **off**. The lock-on list page was checked by
  screenshots and database-level reads, not by the full UI suites.
- The leak scan greps raw bytes. LevelDB table files are Snappy-compressed, so text inside `.ldb` blocks is not found by a byte grep;
  the WAL (`.log`) is. A negative result is therefore weaker than for a decompressing scan. Chrome's own files (History, Sessions,
  Top Sites) contain the URLs of tabs that were open; that is outside the extension.
- Offline copies bypass the lockout delay. Older plaintext stays in unused LevelDB space after turning the lock on until Chrome compacts.
- Rollback of a record to an older valid ciphertext is not detected.
- OS screen-lock locking was not exercised end to end (the decision function is unit-tested; Chrome cannot be told to report `locked` here).
- Migration of 300k / 1M items (budgets 90 s / 5 min) was not run in Chrome; the pure core was measured in Node (see `tests/lock/run.mjs`).


## Encrypted archive (reset flow)

Lock screen / settings "erase everything": before erasing the user can make an ENCRYPTED backup file (`lib/lockarchive.js` builds it from the rows on disk, `lib/lock/archive.js` is the format: header = `meta.lock`, then `ekeys, sites, categories, groups, items, trash` as ciphertext). It opens only with the old password or recovery key. The erase button needs the typed word AND either the saved file link pressed or the explicit "erase without a backup" tick. Import (settings card, lock off or unlocked): `lock.archive.begin/rows/end/abort` -> `lib/lockarchimp.js` adds the old tab sets as NEW groups through the normal write path (current keys); the old trash is kept in the file but not copied. Limits: a stash made between the file and the erase is not in the file; the file includes the readable fields the database always has (counts, times, flags, site tokens). Tested in Node only (`[archive]` in `tests/lock/run.mjs`); the page / service-worker glue was not run in Chrome.

## Chrome verification of sync + archive (2026-11-23)

`node tests/ui/lock-sync-archive.mjs` (real Chrome, scratch manifest with the optional permissions required): the service worker loads without errors; lock on + sync on; unlocked and locked (inbox) stashes; sync stands still while locked and resumes after unlock with the locked groups published; no plain titles / URLs in IndexedDB, `storage.local` or the sync bookmark folder; lock-screen erase flow (typed word plus pressed save link or the explicit tick); the `.tabroost` file has no plain text; import with the old password and with the recovery key adds new groups; wrong secrets refused. Not covered: the saved file landing on disk (Chrome cancels every blob download in this automated setup, a plain .txt too), a second device joining, raw LevelDB byte scan after the sync run.

## Second unlock methods: backup password and passkey (2026-11-23)

Users who forget the password get two more ways in, besides the recovery key. Both are extra wrappers (`meta.lock.slots`) of the SAME master key, like the recovery wrapper, so no data is re-encrypted and a change of the main password, a new recovery key or a recovery unlock leaves them valid (those only replace `pw` / `rec`). TOTP codes were rejected: a one-time code cannot be a key.

- **Backup password** (`kind:'pw'`, one at most): own PBKDF2 salt and iteration count (600k), AES-GCM wrapper with AAD `cmr|mk|slot|pw|<id>`. Must differ from the main password and meet the same length rule.
- **Passkey / security key** (`kind:'prf'`, up to 3): WebAuthn PRF extension. The page (`lib/lockpk.js`, extension page only, never the SW) creates a credential, then asks it for the PRF output of a random 32-byte salt stored in the slot; HKDF of that output is the key-encryption key. Stored in the profile: credential id, salt, name, wrapper. The PRF output exists only in memory for one message. Findings and limits: `docs/webauthn-prf-findings.md`.
- **Rules**: adding / removing a slot needs the list unlocked AND the current password (main or backup), with the normal lockout; the lock screen offers both under "Forgot password?"; wrong backup password / wrong passkey secret / wrong main password share ONE failure counter and one delay schedule. The backup password also counts as "current password" for change password, new recovery key and turn-off, so someone who forgot only the main password can set a new one.
- **Erase everything** deletes `meta.lock` with the database, so every slot goes with it; a new lock starts with none. Turning the lock off deletes `meta.lock` too.
- **Encrypted archive**: the header carries `meta.lock` including the slots as they were at export, so a file opens with the old backup password or the old passkey too (import form: old password / old recovery key / old backup password / old passkey). A slot removed later is still in older files; that is inherent to an offline copy.
- **Not covered**: removing a slot deletes its wrapper from the profile but not from a copy of the profile made earlier. The lock is as strong as the weaker of the main and the backup password. A passkey is bound to the extension id (unpacked copy and Web Store copy differ).
- Code: `lib/lock/keys.js` (slots), `lib/lockctl.js` (`withAuth`, `slotAdd*`, `slotRemove`, unlock kinds), `lib/lockpk.js`, `lib/lockui.js` (lock screen), `lib/lockcard.js` (settings card), `lib/lockarchive.js` / `lockarchimp.js` / `lock/archive.js` (import). Strings: `lib/lockstr.js` + `LOCK_EN`.
- Tests: `tests/lock/run.mjs` section "[unlock slots]" (8 tests: same master key, refusals, survives password change / new recovery / recovery unlock, removal, wrapper bound to its id, limits, archive); `node tests/ui/lock-slot.mjs` (real Chrome with a CDP virtual authenticator that has PRF: card flows, lock screen with both methods, shared lockout, 2 passkeys through `evalByCredential`, erase clears the slots, archive import with backup password and passkey, no plain text in IndexedDB / storage.local).
