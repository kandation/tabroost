# Security policy

## Supported versions

Only the latest release on the Chrome Web Store (and the `main` branch) receives fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's "Report a vulnerability" (private security advisory) on the Security tab of this repository, or email {{CONTACT_EMAIL}}. Include the version, steps to reproduce, and the impact. You should get a first reply within about 7 days (best effort; this is a small project). We will credit you in the release notes if you wish.

## Threat model (summary)

- Tabroost has no server and makes no network requests of its own. There is no remote code.
- Local data (saved tabs, notes, settings, statistics) is stored in IndexedDB and chrome.storage and is **not encrypted by Tabroost**. It is protected only by your operating system account and browser profile. Anyone with access to your unlocked profile, or malware running as you, can read it. An optional password lock (Settings, off by default) encrypts the saved list; see the lock notes below.
- Optional sync data is encrypted on your device before it is written to bookmarks: AES-GCM with a 256-bit data key, wrapped by a key derived from your passphrase (PBKDF2-SHA256). A weak passphrase can be guessed offline by someone who obtains the encrypted bookmark data (for example from your browser account). Use a long passphrase. A forgotten passphrase cannot be recovered. Metadata visible to someone with the bookmarks (item count, sizes, timing) is not hidden.
- The extension needs access to all sites only for an on-demand check (unsaved form input, playing media) before sleeping a tab; it does not read or store page content.
- Out of scope: attacks needing a malicious browser, a compromised OS, or other extensions that already have bookmark or tab access.

## Disclosure

We aim to fix confirmed issues quickly and to publish a fixed release before details are made public.

## Password lock (optional, off by default)

- What it covers: someone using your unlocked computer, and someone who copies the browser profile folder or reads disk backups. Titles, links, sites, notes, set names, the trash, crash-recovery copies, the backup (vault) copy, favicons, site rules and the search index snapshot are encrypted with keys derived from your password (PBKDF2-SHA256, 600,000 iterations; AES-GCM; ECDH P-256 for saving while locked). The unlocked key lives only in `chrome.storage.session` (memory) and is gone when the browser closes or the extension reloads.
- What it does not cover: malware or a debugger attached while you are unlocked; someone who can change the extension's code in your profile; undetected rollback of a record to an older valid copy. Some metadata stays readable: when a set was saved, how many tabs it has, how many sites, the size of items (padded to 32 bytes), and which items share a site (blind tokens, not host names).
- Offline guessing ignores the in-app waiting time after wrong passwords (3 free tries, then 2, 4, 8 ... seconds up to 15 minutes). Use a long password. A forgotten password with no recovery key, backup password or passkey cannot be recovered.
- A backup password is a second wrapper of the same master key: the lock is as strong as the weaker of the two passwords, so choose a long one. A passkey wrapper is as strong as the authenticator that holds the PRF secret. Removing a slot deletes its wrapper from the profile, but a copy of the profile made earlier still contains it.
- Old plaintext may remain in unused disk space (LevelDB files) after you turn the lock on, until Chrome compacts its files.
- Details and tests: `docs/spec-password-lock.md`, `docs/lock-status.md`.
