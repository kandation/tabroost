# Third-party notices

Tabroost is released under the MIT License (see `LICENSE`). This file says what other people's work the extension uses, depends on or is based on. It was written after reading every file that ships in the extension zip. If something here is wrong or missing, please open an issue.

สรุปภาษาไทย: Tabroost ไม่มีโค้ดของบุคคลอื่นรวมอยู่ในตัวส่วนขยาย ไม่มีฟอนต์ ไม่มีชุดไอคอน และไม่โหลดอะไรจากอินเทอร์เน็ต ส่วนขยายใช้ API ของ Chrome และเบราว์เซอร์ และอิงแนวคิดจากเอกสารสาธารณะที่ระบุด้านล่าง

Keep this file and the copy shown on the in-app About page (`about.html`, data in `lib/aboutinfo.js`) in step. `node tools/check-notices.mjs` checks that they match.

## A. Bundled third-party code

**None.**

- No library, framework, minified file or copied snippet is included in the extension. All JavaScript, CSS and HTML in the zip was written for this project.
- `package.json` has no dependencies. Nothing is loaded from a CDN or any other web address. The extension makes no network requests of its own.
- The development tools in `tools/`, `tests/`, `store-assets/tools/` and `bench/` use only Node.js built-in modules (and, for rendering pictures, an installed Chrome). They are not part of the zip.
- `fullpage-screenshot/` is a separate small extension kept in the same working folder. It is not part of the Tabroost zip and is not covered here.

## B. Platform APIs and services used

These are provided by Chrome or the browser. They are used through their public interfaces. No code from them is copied into Tabroost.

| What | Used for |
|---|---|
| Chrome extension APIs: `tabs`, `tabGroups`, `storage`, `alarms`, `contextMenus`, `scripting`, `system.memory`, `idle`, `bookmarks`, `sessions`, `commands`, `runtime`, `i18n` | Saving, sleeping and reopening tabs, settings, keyboard shortcuts, menus, free-memory reading, the encrypted sync folder |
| Chrome `_favicon` service (the `favicon` permission) | Site icons. Chrome serves them from its own local icon cache. Tabroost does not fetch icons from the web |
| IndexedDB | The saved list, trash, search helper, statistics |
| Web Crypto (`crypto.subtle`) | AES-GCM, PBKDF2-SHA256, HKDF, HMAC, ECDH and SHA-256 for sync and the lock feature. Tabroost does not ship its own cipher code |
| Compression Streams (`CompressionStream`, `DecompressionStream`) | gzip and deflate for recovery notes, the second copy and sync data |
| `Intl.Segmenter`, `Intl.Collator`, `Intl.DateTimeFormat` | Thai word boundaries for search, sorting, dates |
| Web Workers, `navigator.storage` | Search and sort off the main thread, storage size and persistence |

"Chrome", "Chromium" and "Chrome Web Store" belong to Google LLC. See section F.

## C. Algorithms, specifications and papers the code is based on

The code was written for this project. These are the ideas and public specifications it follows.

| Where | What | Source |
|---|---|---|
| `lib/sync/hlc.js` | Hybrid logical clock (wall time plus a counter, as a fixed-width string) | Kulkarni, Demirbas, Madappa, Avva, Leone. "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases". 2014. https://cse.buffalo.edu/tech-reports/2014-04.pdf |
| `lib/sync/merge.js` | Field-level last-writer-wins merge | Shapiro, Preguica, Baquero, Zawirski. "A comprehensive study of Convergent and Commutative Replicated Data Types". INRIA RR-7506, 2011. https://inria.hal.science/inria-00555588 |
| `lib/searchIndex.js` | Optimal string alignment distance, bounded by a small limit, for typo-tolerant search. This is the restricted form of Damerau-Levenshtein distance | Levenshtein 1966, Damerau 1964. https://en.wikipedia.org/wiki/Damerau%E2%80%93Levenshtein_distance |
| `lib/searchIndex.js`, `lib/searchNorm.js` | Inverted index, delta and variable-length integer lists, trigram pre-filter for Thai | Standard textbook techniques. No code copied |
| `lib/lock/kdf.js` | Crockford Base32 alphabet for the recovery key (no I, L, O, U). The 3-byte checksum is this project's own: the first 3 bytes of SHA-256 | https://www.crockford.com/base32.html |
| `lib/lock/`, `lib/sync/crypto.js` | PBKDF2 (RFC 8018), HKDF (RFC 5869), HMAC (RFC 2104), AES-GCM (NIST SP 800-38D), SHA-256 (FIPS 180-4). The 600,000 iteration count is in line with the OWASP Password Storage Cheat Sheet | https://www.rfc-editor.org/rfc/rfc8018 , https://www.rfc-editor.org/rfc/rfc5869 , https://csrc.nist.gov/pubs/sp/800/38/d/final , https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html |
| `lib/firstseen.js` | FNV-1a 32-bit hash (public algorithm by Fowler, Noll and Vo) | http://www.isthe.com/chongo/tech/comp/fnv/ |
| `lib/formats.js` | Import and export of the plain text format used by OneTab (`address | title` lines, blank line between sets). Only the text layout is read and written. No OneTab code was used | Observed format. OneTab is a product of its own owners |
| `tools/make-icons.mjs` (development only) | CRC-32 and zlib chunks of the PNG file format | https://www.w3.org/TR/png/ |

## D. Data derived from public lists

`lib/site.js` has a hand-typed set of 109 multi-label domain endings (for example `co.th`, `co.uk`, `github.io`). It is used to guess the "site" of a web address, so that `shop.example.co.th` and `www.example.co.th` count as one site.

- The set was written by hand from general knowledge. The Public Suffix List file was not downloaded, copied or converted.
- The idea is the same as the Public Suffix List (https://publicsuffix.org/), and many entries are also in it. That list is licensed under the Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/).
- No attribution is legally required for a short list of facts that was not copied from that file. We credit the project anyway, because the idea and many entries come from its work.
- The set is small and incomplete. It is not a replacement for the real list. A suffix that is not in it is treated as a plain two-label domain, so the site name can be wrong for it. That affects only the site names shown and grouped in the app.

No other data set, word list, dictionary or translation memory is included. The Thai and English text of the interface was written for this project.

## E. Fonts, icons and images

- **Fonts: none are bundled.** The stylesheets only name fonts, and the browser uses the ones already installed on the computer: Leelawadee UI, Noto Sans Thai, Sarabun, Segoe UI, Roboto, Tahoma, Consolas, and the system default (`system-ui`, `ui-monospace`). If a name is not installed the browser moves to the next. The licences of those fonts belong to their makers and do not pass to Tabroost.
- **Interface icons** are inline SVG paths in `stash.html`, drawn for this project. No icon set is bundled.
- **Extension icon and logo** (`icons/`): drawn as SVG for this project (`store-assets/svg/a-sleepy-*.svg`, made by `store-assets/tools/gen-svg.mjs`) and turned into PNG with a headless Chrome (`store-assets/tools/render.mjs`). They contain no stock art, no font text and no third-party artwork.
- **Store images** in `store-assets/` are made from the same SVG sources and are not part of the zip.

## F. Trademarks

"Chrome", "Chromium", "Google" and "Chrome Web Store" are trademarks of Google LLC. Tabroost is an independent project. It is not affiliated with, sponsored by or endorsed by Google. "OneTab" and other product names are the property of their owners. They appear only to say which file format can be read or written. All other names are the property of their owners.

## G. Design

The look (cards, a left sidebar with views, light and dark themes) follows common patterns of browser extension and web app settings pages. No other product's stylesheet, layout files or artwork was copied.
