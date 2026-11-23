# Tabroost

**English** | [ไทย](#ภาษาไทย)

Give your tabs a place to rest. Tabroost saves all your open tabs into a searchable list with one click, and puts idle tabs to sleep so your browser uses less memory. Everything stays on your device. No servers, no accounts, no analytics.

> Chrome Web Store: {{STORE_URL}}  (placeholder until the item is published)
> Website and policies: https://&lt;user&gt;.github.io/&lt;repo&gt;/

Screenshots: _add `store-assets/screenshots/*.png` here after they are taken (1280x800)._

<!-- screenshots go here: ![Save and list](store-assets/screenshots/1.png) -->

## Features

- Save every open tab (all windows) as a "tab set" and close them, closing gradually and watching free memory.
- Restore a tab or a whole set in small steps; restored tabs stay asleep until clicked, so there is no memory spike.
- Auto-sleep for idle tabs, skipping tabs that play media, have unsaved form input, or are on your allow list.
- Fuzzy search, sort, group, filter, categories, pin/star, Chrome tab groups kept.
- Trash with retention, crash-recovery snapshots, export/import (including text from other tab managers).
- Optional end-to-end-encrypted sync between devices through a dedicated bookmark folder.
- Thai and English UI, light and dark.
- Keyboard shortcuts of the list page can be turned on or off in Settings > Shortcuts, one by one. The same card shows the keys Chrome has assigned to the extension's global commands and links to Chrome's shortcut page, where they are changed.
- Optional password lock (off by default): encrypts your saved list on this computer with a password; auto-lock after idle time or when the screen locks.
- Local time/activity dashboard (can be turned off).

## Install

- From the Chrome Web Store: {{STORE_URL}}
- For development ("load unpacked"): clone this repo, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and select the repo folder. Use a separate, empty Chrome profile. Note that an unpacked copy has a different extension ID than the store version, so data does not carry over: export from one, import into the other.

## Permissions

Required at install: `tabs`, `tabGroups`, `storage`, `unlimitedStorage`, `alarms`, `contextMenus`, `scripting`, `favicon`, `system.memory`, `idle` (only used to lock the list when the computer locks its screen; it adds no install warning). Asked later, only when you use the feature (and you can take them back in Settings > "Permissions asked later"): access to pages (`<all_urls>`, so Tabroost can check for typed text or playing video before sleeping a tab; without it auto-sleep stays paused), `bookmarks` (optional sync) and `sessions` (Chrome's recently closed list). Details: `store-assets/listing/permissions-justification.md`.

## Privacy summary

No data leaves your device. Tabroost makes no network requests of its own, has no analytics or ads, and loads no remote code. Saved tabs (URL and title) are stored in IndexedDB and extension storage. Optional sync encrypts data (AES-GCM, key from your passphrase via PBKDF2-SHA256) and stores it in a bookmark folder named `Tabroost sync data - do not edit`, as bookmarks to fake `https://cmr.invalid/` addresses that cannot be opened. Local data is not encrypted at rest. Full policy: [site/privacy.html](site/privacy.html). The same text, plus credits and the licence, is on the extension's About page. Third-party code: none. What the code is based on and credits: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Build and package

No build step is needed to run it. To make the Chrome Web Store zip (Windows, Node 18+):

```
node tools/package.mjs        # writes dist/tabroost-<version>.zip and runs integrity checks
node tools/audit-repo.mjs     # before publishing the repo: looks for personal data, paths, secrets
```

Store submission documents are in `store-assets/listing/`. Steps to publish the repository are in `GITHUB-SETUP.md`.

## Tests

| Command | What it covers |
|---|---|
| `node tools/check-imports.mjs` | every import resolves to an existing file and export |
| `node tools/test-formats.mjs` | import/export text formats |
| `node tests/query-test.mjs` | sort, group and filter logic |
| `node tests/search-test.mjs` | search index and fuzzy matching |
| `node tests/snapshot-test.mjs` | crash-recovery snapshot logic |
| `node tests/sync/run.mjs` | sync core: crypto, merge, scenarios, property tests |
| `node tests/about-test.mjs` | About page strings, policy text matches the store policy, notices ship in the zip, no personal data |
| `node tools/check-notices.mjs` | THIRD-PARTY-NOTICES.md and the About page credits agree |
| `node tools/scan-forbidden.mjs` | no eval / new Function / remote scripts |
| `tests/ui/*` | browser UI tests that drive a real Chrome over DevTools |

The UI tests need an **isolated, throwaway Chrome profile** (own user-data-dir). Never point them at your real profile: they create and close tabs and write to bookmarks. They are not run in CI. The other tests are plain Node scripts without dependencies; CI runs them (see `.github/workflows/ci.yml`).

## Architecture (short)

- `sw.js` is the Manifest V3 service worker and the **single writer**: all changes to saved data go through it (messages from the popup and list page, commands, context menus, alarms). It is event-driven and keeps no state it cannot rebuild.
- Data lives in IndexedDB (`lib/db.js`: tab sets, tabs, trash, categories, snapshots, activity, sync bookkeeping). A second backup copy and settings use `chrome.storage.local` (`lib/vault.js`, `lib/settings.js`).
- `stash.html` / `stash.js` is the list page (options page, opened in a tab); `popup.*` is the optional popup; `dashboard.*` is the local statistics page.
- Search: `search-worker.js` holds an in-memory index (`lib/searchIndex.js`, `lib/searchNorm.js`) and answers queries from the list page via `lib/searchClient.js`; `sort-worker.js` sorts large lists off the main thread.
- Closing and restoring are paced by a queue/drain scheduler (`lib/queue.js`, `lib/drain.js`, `lib/gentle.js`, `lib/restore.js`, `lib/mem.js`) that looks at free memory and discards restored tabs as they commit.
- Auto-sleep and its protections (media, unsaved input, allow list): `lib/suspend.js`.
- Crash recovery: `lib/snapshot.js`.
- Sync core: `lib/sync/` (codec, crypto, hlc clock, merge, oplog, engine, bookmark transport) driven by `lib/synccontrol.js`; the engine is transport-agnostic and tested with an in-memory transport.
- More detail: `docs/` holds design specs for features in progress; `tools/glossary.md` is the UI word list.

## FAQ

**Is it a "RAM cleaner"?** No. It closes or sleeps tabs you choose, or that you let it sleep; the memory freed depends on the pages. It does not promise any number.
**Why access to all sites?** Only for a short on-demand check for unsaved input or playing media before sleeping a tab.
**Does it work with other tab managers?** It can import their exported text.
**What is the `cmr.invalid` bookmark folder?** Optional sync data, encrypted. See the privacy policy.
**I lost data after installing from the store.** The extension ID differs from an unpacked copy; use export and import.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).

---

<a id="ภาษาไทย"></a>
# Tabroost (ภาษาไทย)

ให้แท็บได้พัก ให้เครื่องได้หายใจ Tabroost เก็บทุกแท็บที่เปิดอยู่ไว้ในรายการที่ค้นหาได้ด้วยการกดครั้งเดียว และพักแท็บที่ไม่ได้ใช้เพื่อให้เบราว์เซอร์ใช้แรมน้อยลง ข้อมูลทั้งหมดอยู่ในเครื่องคุณ ไม่มีเซิร์ฟเวอร์ ไม่มีบัญชี ไม่มีการวิเคราะห์การใช้งาน

- Chrome Web Store: {{STORE_URL}} (ยังเป็นที่ว่างจนกว่าจะเผยแพร่)
- เว็บไซต์และนโยบาย: https://&lt;user&gt;.github.io/&lt;repo&gt;/

## ฟีเจอร์

- เก็บทุกแท็บจากทุกหน้าต่างเป็น "ชุดแท็บ" แล้วปิดแท็บ โดยค่อย ๆ ปิดและดูแรมที่เหลือ
- เปิดแท็บเดียวหรือทั้งชุดทีละน้อย แท็บอยู่ในสถานะพักจนกว่าจะคลิก แรมจึงไม่พุ่ง
- พักอัตโนมัติ ข้ามแท็บที่เล่นสื่อ มีข้อมูลฟอร์มยังไม่บันทึก หรืออยู่ในรายการที่กันไว้
- ค้นหา เรียง จัดกลุ่ม กรอง หมวดหมู่ ปักหมุด/ติดดาว เก็บกลุ่มแท็บของ Chrome
- ถังขยะ กู้คืนแท็บหลังล่ม ส่งออก/นำเข้า (รวมข้อความจากโปรแกรมจัดการแท็บอื่น)
- ซิงค์แบบเข้ารหัสปลายทางถึงปลายทาง (ตัวเลือก) ผ่านโฟลเดอร์บุ๊กมาร์กเฉพาะ
- ภาษาไทยและอังกฤษ ธีมสว่างและมืด
- เปิดหรือปิดปุ่มลัดของหน้ารายการได้ที่ ตั้งค่า > ปุ่มลัด ทีละปุ่ม การ์ดเดียวกันแสดงปุ่มที่ Chrome กำหนดให้คำสั่งของส่วนขยาย และมีปุ่มไปหน้าตั้งปุ่มลัดของ Chrome
- ล็อกด้วยรหัสผ่าน (ตัวเลือก ปิดอยู่เป็นค่าเริ่มต้น): เข้ารหัสรายการที่เก็บไว้ในเครื่อง ล็อกอัตโนมัติเมื่อไม่ได้ใช้หรือเมื่อล็อกหน้าจอ
- แดชบอร์ดเวลา/กิจกรรมในเครื่อง (ปิดได้)

## ติดตั้ง

- จาก Chrome Web Store: {{STORE_URL}}
- สำหรับพัฒนา: โคลน repo นี้ เปิด `chrome://extensions` เปิดโหมดนักพัฒนา กด **Load unpacked** แล้วเลือกโฟลเดอร์ ใช้โปรไฟล์ Chrome ว่างที่แยกต่างหาก ชุดที่โหลดจากโฟลเดอร์มี ID ต่างจากชุดในสโตร์ ข้อมูลจึงไม่ย้ายตามกัน ให้ส่งออกจากชุดหนึ่งแล้วนำเข้าอีกชุด

## ความเป็นส่วนตัวโดยสรุป

ไม่มีข้อมูลออกจากเครื่อง Tabroost ไม่ส่งคำขอเครือข่ายเอง ไม่มีการวิเคราะห์หรือโฆษณา และไม่โหลดโค้ดจากภายนอก แท็บที่เก็บ (URL และชื่อ) อยู่ใน IndexedDB และที่เก็บข้อมูลของส่วนขยาย การซิงค์ที่เป็นตัวเลือกเข้ารหัสข้อมูลแล้วเก็บในโฟลเดอร์บุ๊กมาร์ก `Tabroost sync data - do not edit` เป็นบุ๊กมาร์กไปที่ `https://cmr.invalid/` ที่เปิดไม่ได้ ข้อมูลในเครื่องไม่ได้เข้ารหัส นโยบายฉบับเต็ม: [site/privacy.html](site/privacy.html) ข้อความเดียวกัน พร้อมเครดิตและสัญญาอนุญาต อยู่ในหน้า “เกี่ยวกับ” ของส่วนขยาย โค้ดของบุคคลอื่นที่รวมมา: ไม่มี ดูเครดิตและสิ่งที่โค้ดอิงอยู่ที่ [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## สร้างไฟล์ zip และทดสอบ

```
node tools/package.mjs
node tools/audit-repo.mjs
```

คำสั่งทดสอบอยู่ในตารางด้านบน การทดสอบ UI ต้องใช้โปรไฟล์ Chrome แยกต่างหากที่ใช้แล้วทิ้งเท่านั้น ห้ามใช้โปรไฟล์จริง

## สัญญาอนุญาต

MIT ดูไฟล์ [LICENSE](LICENSE)
