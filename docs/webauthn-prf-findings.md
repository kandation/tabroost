# WebAuthn PRF as a second unlock method: findings

Question: can a passkey or security key unlock the password lock for a user who forgot the password? A TOTP / authenticator-app code cannot (it proves a moment, it is not key material and cannot decrypt anything), so it was ruled out. The WebAuthn PRF extension (CTAP hmac-secret) gives a deterministic secret per credential and salt, which can be a key-encryption key for the master key, the same way the recovery key wrapper works.

## Result: works, shipped (as a slot next to the backup password)

Tested 2026-11-23 in branded Chrome 158.0.8127.36 (Windows 11), extension loaded through CDP `Extensions.loadUnpacked`, page `chrome-extension://<id>/...`, with a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`: ctap2 / ctap2_1, usb, resident key, user verification, `hasPrf: true`, `hasHmacSecret: true`, automatic presence simulation).

| Check | Observed |
|---|---|
| WebAuthn from an extension page | `isSecureContext` is true and `navigator.credentials` exists on a `chrome-extension://` page; no manifest permission is needed |
| Relying party id | Omit `rp.id`: the browser uses the extension id (the page host). No `rpId` / origin trick is needed |
| Create with `extensions: { prf: {} }` | Succeeds; `getClientExtensionResults()` returns `{ prf: { enabled: true } }` |
| Assert with `prf.eval.first = salt` (32 bytes) | Returns a 32-byte result |
| Determinism | Same credential + same salt gives the same bytes on every call; another salt gives different bytes |
| Two credentials, `prf.evalByCredential` | Works when the map keys (base64url, no padding) are exactly the credentials in `allowCredentials`; a key that is not in `allowCredentials` throws `SyntaxError` (so `lib/lockpk.js` builds both from the same list) |
| `rawId` of the assertion | Identifies which credential answered, so the right slot is picked |
| Service worker | No document, so WebAuthn is not available there: all WebAuthn calls run in an extension page and only the PRF output (base64) goes to the SW in one runtime message |
| End to end | Settings card creates the passkey (two prompts: create, then a first assertion to read the PRF output, because not every authenticator returns it during create), the lock screen unlocks with it, stashed titles decrypt, the archive imports with it (`tests/ui/lock-slot.mjs`, 52 checks) |

## Design that follows

`meta.lock.slots[]` entries wrap the SAME master key as the main password and the recovery key (so nothing is re-encrypted, and a main password change leaves them valid):

- `{ id, kind:'prf', name, ts, cid, psalt, iv, ct }`; KEK = HKDF-SHA256(PRF output, info = `cmr-prf-slot-v1|<id>`); AES-GCM, AAD `cmr|mk|slot|prf|<id>` (a wrapper cannot be moved to another slot).
- Stored: credential id, 32-byte random salt, name, wrapper. Not stored: the PRF output, any password.
- Up to 3 passkeys; the same credential cannot be added twice. Add / remove needs the unlocked list and the current password; wrong attempts use the one shared lockout counter.
- The challenge is random and never verified: there is no server. The security comes from the PRF secret, not from checking the assertion signature.

## Limits and what was NOT verified

- **Only a virtual authenticator was exercised.** Real hardware (YubiKey and other FIDO2 keys with hmac-secret, Windows Hello, Google Password Manager / iCloud passkeys, hybrid phone passkeys) is unverified here. Support differs: platform authenticators may not offer PRF on some OS versions, and a passkey synced by a password manager only works if that provider returns PRF. The code reports `noprf` ("this passkey cannot be used to unlock") instead of failing silently, and the backup password is the dependable fallback.
- `userVerification: 'preferred'` is used. A key without a PIN then unlocks by possession alone; that is the user's choice of authenticator. Requiring verification would make keys without PIN unusable.
- The credential is bound to the extension id. The unpacked copy and the Chrome Web Store copy have different ids, so a passkey must be added again after moving to the store copy. Archives made earlier open with the passkey only inside the same id.
- A lost or reset authenticator makes that slot useless; the password and recovery key still work. Removing a slot deletes its wrapper from the profile, but an older copy of the profile still contains it.
- Popup pages were not tested: the browser dialog can close a popup, so the passkey button lives on the list page's lock screen and in the settings card only.
- Not tested: Firefox / other browsers (the extension is Chrome only), `hints` / `transports` filtering, discoverable-credential autofill.

## Fallback that ships alongside: backup password

Because PRF support depends on the user's device, a second password slot (`kind:'pw'`: own salt, 600k PBKDF2) ships too. It is as strong as its own password: the lock is as strong as the weaker of main and backup password.
