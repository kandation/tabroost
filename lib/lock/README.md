# lib/lock : pure core of the password lock / encryption at rest

Pure ES modules (WebCrypto only; no `chrome.*`, no IDB, no network). Spec: `docs/spec-password-lock.md`.
Run the tests: `node tests/lock/run.mjs` (Node 22, ~45 s, no dependencies).

| File | Role |
|---|---|
| `kdf.js` | PBKDF2 KEK (600k default), HKDF helpers, recovery key (Crockford Base32, 56 chars, 24-bit checksum), strength meter |
| `rec.js` | encode/decode of every record type, AAD, padding, blind tokens, legacy detection, `mapSlices` batching, sentinel on damage |
| `keys.js` | `setupLock`, `meta.lock` shape, unlock (password / recovery / backup password / passkey slot), change password, new recovery key, extra unlock slots (`meta.slots`), session adapter, `LockSession` |
| `inbox.js` | per-batch ephemeral ECDH batch key, `encryptBatchWhileLocked` (public key only), digest verify, `makeBatchResolver` |
| `seal.js` | `sealStep` / `runSeal` / `gcEkeys` (inbox rows -> DK rows + tokens, duplicates to trash) |
| `migrate.js` | `migrateStep` / `runMigration` (`mode:'migrate'` = encMigrate, `mode:'revert'` = encRevert), `totalRows` |
| `policy.js` | lockout schedule + state machine, `decideLock`, touch throttle |
| `jobutil.js` | store-adapter contract, key ordering, `deepEqual`, `canon` |
| `strings.js` | TH/EN sentinels only (`รายการเสียหาย`, ...) |
| `bytes.js` | byte helpers (re-exports `lib/sync/bytes.js`, read-only reuse) |

`tests/lock/fakestore.js` is an in-memory fake of the adapter with atomic txs and crash injection.

## Integration contract (what the integrator must implement)

### 1. IDB `cmr` (additive version bump, no index change)
* new store `ekeys` keyPath `kid` (integer >= 1; allocate monotonically, e.g. `max+1` inside the same tx, never reuse);
  row = `{kid, epk:Uint8Array(65), salt:Uint8Array(16), ts, keep?}`.
* new store `inbox` keyPath `g`; row = `{g, kids:[kid,...]}` = "group g has unsealed rows". The stash tx must `put` it
  (merging `kids`) in the SAME transaction as the `ekeys` row and the item rows (see `lockedStash` in `tests/lock/helpers.mjs`).
* `meta` store: row `{k:'lock', v:1, state, pub, pw, rec, priv, pubMac, check}` from `setupLock().meta` (Uint8Array fields are
  structured-clone safe). It is the only record whose `k` is a string: never pass it through `rec.js` decoders.
* Existing records: add `k` (number) + `e` (Uint8Array) only through `rec.js`; records without `k` stay legal forever.
  `t`, `tk` are no longer written for encrypted items (indexes `byTk`/`byT` stay valid: sparse / plaintext `ts`).
* Store/keyPath names assumed by seal/migrate (rename in `migrate.js` plans if they differ): `items [g,seq]`, `trash tid`,
  `groups id`, `categories id`, `sites site`, `siteIdx [site,g]`, `snapshots id`, `vault id` (rows `{id, data}` plain,
  `{id,k,e:base64}` encrypted), `settings name` (rows `{name,value}`), `favicons site` (cmr-fav), `search id` (dropped on migrate).
  Stores that live in `storage.local` or other DBs need their own adapter binding of `scan/get/tx` (same interface).

### 2. Store adapter (`jobutil.js` header, bind to IndexedDB)
`scan(name,{after,upTo,limit<=2000})`, `get`, `count`, `getCursor(job)`, `tx(async tx => ...)` with `tx.get/scan/put/del/setCursor`.
Cursor rows live in the same tx as the chunk (use the existing `jobs` store or a `meta` row `cursor:<job>`).
Never `await` crypto inside `tx`: read, run crypto, then open the write tx (the steppers already do this and use a
per-row compare-and-swap on the read value, re-reading rows that changed meanwhile).

### 3. db.js write-path hooks
* Unlocked, lock enabled: `rec.encodeItem(item, keys.writer(), {normUrl})` for items, `encodeGroup`, `encodeCategory`, trash rows
  (`encodeTrashRow`), `encodeSiteRow`/`tokenizeSiteIdx` for site indexes, `encodeFavicon(row, keys.xWriter())`, `encodeJob`,
  `encodeSetting`, `encodeVault`. Pass the SAME url normaliser db.js uses for dedup (`normUrl`).
* Locked: `inbox.encryptBatchWhileLocked({pub: meta.lock.pub, kid, items})` -> write `ekey`, `records`, and the `inbox` row in one tx;
  store `journal` (`{g, seqFrom, seqTo, count, digest, kid}`); read the rows back, `inbox.verifyDigest(rows, count, digest)`;
  close tabs only if `ok`. Snapshots always: `inbox.encryptSnapshotViaInbox`.
* Locked mode cannot apply pattern excludes or autoRules; use `rec.matchHashes(publicSalt, host)` against the stored match set.
* Readers (page, popup, search worker): `await session.ensure(meta)` -> `keys.reader(inbox.makeBatchResolver(keys.sk, kid => idbGet('ekeys', kid)))`
  -> `decryptItems(rows, reader)`. Decoders never throw on damage (row comes back `{corrupt:true, title:'รายการเสียหาย', url:''}`); a
  `LockedError` means "no key": show the lock screen. Anything unclear = treat as locked.
* `t`/`tk` come from the worker after decoding (`deriveSearch` injected into migrate for revert).

### 4. SW messages (spec §7) mapped to this API
`lock.enable` -> `setupLock` (+ `LockSession.unlocked`, start `runMigration`), `lock.unlock` -> check `policy.canAttempt`, then
`unlockWithPassword` or `unlockWithRecovery` (`RecoveryFormatError.countsAsFailure === false`: do not call `onFailure`;
`WrongPasswordError`/`WrongRecoveryKeyError` do), persist `{n,until}` in `storage.local.lockFail`, on success `onSuccess()`;
recovery unlock returns `needsNewPassword` and the UI must call `completeRecoveryUnlock(meta, mk, newPassword)` before the session
is saved; `lock.changePassword` -> `changePassword`; `lock.newRecovery` -> `newRecoveryKey`; `lock.lockNow` / alarms /
idle -> `LockSession.lock()` then broadcast `lock.state`; `lock.touch` -> `session.touch()` (pages throttle with `shouldSendTouch`);
`lock.disable` -> verify password, `runSeal`, `runMigration({mode:'revert'})`, delete `meta.lock` + `ekeys`;
`lock.setPolicy` -> persist; every minute `chrome.alarms` -> `decideLock({unlocked, now, lastTouch, idleMin, ...})`.
After unlock: run `runSeal` (progress -> `seal.progress`), then resume any paused `encMigrate`.
PBKDF2 and the failure counter run only in the SW; wipe password variables after use.

### 5. Session key adapter
`adapter = {get, set, remove}` over `chrome.storage.session`
(`get: async k => (await chrome.storage.session.get(k))[k]`). Key name `cmrKey` = `{mk:b64, unlockedAt, lastTouch}`.
Never call `setAccessLevel`. On every wake/page load call `LockSession.ensure(meta)` (imports DK/HK/XK/PKEY/SK non-extractable,
about 1 ms). Pass `keys.dk` / `keys.xk` CryptoKeys to the SharedWorker with `postMessage` (non-extractable keys are cloneable).
Nothing key-related goes to IDB, `storage.local` or `localStorage`.

### 6. Manifest
Add permission `"idle"` (for `chrome.idle.onStateChanged === 'locked'`). `alarms` and `storage` are already needed.

### 7. Settings cached secrets
`excludeSites`, `whitelist`, `autoRules`: `encodeSetting` (`isSensitiveSetting` callback in migrate env); sync passphrase cache and sync
local caches: `encodeBlob('sy:<id>', obj, writer)`.

## Known limitations (also in the spec)
* Plaintext-by-design fields (`ts`, `tg`, `w`, `del`, `g`, `seq`, counts) are not authenticated; `g`/`seq`/`k` are (via AAD).
* No rollback detection of a record to an older valid ciphertext.
* Blind tokens leak equality/counts of sites and URLs.
* Offline copies bypass the lockout delay; only PBKDF2 (600k) and password quality protect against offline guessing.
