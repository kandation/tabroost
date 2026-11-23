# Store screenshots and promo art

All files are PNG, 24-bit RGB, no alpha channel. The pictures are designed compositions built from real captures of the extension, filled with invented demo data (no personal data, no real browsing history).

## Upload order

English is the default listing language, so upload the `en/` set as the default screenshots. The Chrome Web Store lets each listing language have its own screenshot set: upload the `th/` set under the Thai (ไทย) locale of the listing. Keep the same order in both.

| # | File (in `en/` and `th/`) | Size | Headline (EN) | Headline (TH) |
|---|---|---|---|---|
| 1 | `01-save-every-tab.png` | 1280x800 | Save every tab in one click. | เก็บทุกแท็บ ในคลิกเดียว |
| 2 | `02-find-any-tab.png` | 1280x800 | Find any tab in a blink. | หาแท็บไหนก็เจอ ในพริบตา |
| 3 | `03-idle-tabs-sleep.png` | 1280x800 | Idle tabs fall asleep on their own. | แท็บที่ไม่ได้ใช้ พักเองอัตโนมัติ |
| 4 | `04-private-by-design.png` | 1280x800 | Private by design. | เป็นส่วนตัว ตั้งแต่ออกแบบ |
| 5 | `05-organise-your-way.png` | 1280x800 | Organise it your way. | จัดระเบียบได้ตามใจ |

### Text on each picture and suggested caption

1. **Save every tab**
   - EN line: A hundred open tabs become one tidy list, and your browser can breathe again.
   - TH line: แท็บนับร้อยกลายเป็นรายการเดียวที่เป็นระเบียบ เบราว์เซอร์กลับมาเบาอีกครั้ง
   - EN caption: Save every open tab with one click. They go into one tidy list and the browser gets lighter.
   - TH caption: เก็บทุกแท็บที่เปิดอยู่ด้วยการกดครั้งเดียว แท็บไปอยู่ในรายการเดียวที่เป็นระเบียบ เบราว์เซอร์เบาลง
2. **Find any tab**
   - EN line: Typo-tolerant search across thousands of saved tabs, in English and Thai.
   - TH line: พิมพ์ผิดนิดหน่อยก็ยังเจอ ค้นได้ทั้งไทยและอังกฤษ จากแท็บที่เก็บไว้หลายพันรายการ
   - EN caption: Instant search across thousands of saved tabs. It forgives typos and understands Thai.
   - TH caption: ค้นหาแท็บที่เก็บไว้หลายพันรายการได้ทันที พิมพ์ผิดเล็กน้อยก็ยังเจอ และเข้าใจภาษาไทย
3. **Idle tabs sleep**
   - EN line: Playing music or holding an unsaved form? Those tabs stay awake.
   - TH line: แท็บที่เล่นเพลงอยู่ หรือมีฟอร์มที่ยังไม่บันทึก จะไม่ถูกพัก
   - EN caption: Idle tabs go to sleep automatically. Tabs playing media, unsaved forms and sites you protect stay awake.
   - TH caption: แท็บที่ไม่ได้ใช้จะพักเองอัตโนมัติ ส่วนแท็บที่เล่นสื่ออยู่ มีฟอร์มที่ยังไม่บันทึก หรือเว็บที่คุณกันไว้ จะไม่ถูกพัก
4. **Private by design**
   - EN line: Password lock and encrypted sync. No account, no servers, no tracking.
   - TH line: ล็อกด้วยรหัสผ่าน ซิงค์แบบเข้ารหัส ไม่มีบัญชี ไม่มีเซิร์ฟเวอร์ ไม่มีการติดตาม
   - EN caption: Optional password lock and passphrase-encrypted sync. No account, no servers, no analytics.
   - TH caption: ล็อกด้วยรหัสผ่านและซิงค์แบบเข้ารหัสด้วยวลีรหัสผ่าน (เลือกเปิดได้) ไม่มีบัญชี ไม่มีเซิร์ฟเวอร์ ไม่มีการเก็บสถิติ
5. **Organise your way**
   - EN line: Tab sets, categories, drag and drop. Reopen any set as tab groups, and see it all on a dashboard.
   - TH line: ชุดแท็บ หมวดหมู่ ลากแล้ววาง เปิดกลับเป็นกลุ่มแท็บ และดูภาพรวมทั้งหมดในแดชบอร์ด
   - EN caption: Tab sets, categories and drag and drop. Reopen a set as Chrome tab groups. A local dashboard shows your habits.
   - TH caption: ชุดแท็บ หมวดหมู่ และลากแล้ววาง เปิดชุดแท็บกลับเป็นกลุ่มแท็บของ Chrome มีแดชบอร์ดในเครื่องแสดงพฤติกรรมการใช้งาน

The captions match the list in `../listing/listing-en.md` and `listing-th.md` in spirit; use them wherever a caption is asked for (the description, the site, social posts).

## Promo art (`../promo/`)

| File | Size | Use |
|---|---|---|
| `small-tile-440x280-en.png` / `-th.png` | 440x280 | Small promo tile (English is the default; Thai under the Thai locale) |
| `marquee-1400x560-en.png` / `-th.png` | 1400x560 | Marquee promo tile |
| `github-social-1280x640.png` | 1280x640 | GitHub repository social preview (Settings, Social preview) |

Taglines: "Give your tabs a place to rest." / "ให้แท็บได้พัก ให้เครื่องได้หายใจ".

## What is real and what is drawn

- Real captures: the list, search results, the toolbar popup, the settings cards, the dashboard cards, the lock screen and the drag in progress. They are crops of the running extension at 2x pixel density.
- Demo data: every tab title, tab set, category and number is invented (`../tools/demo-data.mjs`). Site names are well-known public sites; their icons are drawn letter tiles, not the sites' logos. The usage history behind the dashboard charts is generated.
- Drawn: backgrounds, headlines, chips, the mouse pointer, the moon and stars, and the crowded "before" tab strip in picture 1 (86 tabs is an illustration, not a measurement).
- Small helps during capture, none of them in the shipped extension: optional permissions are granted in a scratch copy of the manifest so no permission banner shows; notice banners are hidden; the "RAM saved" tile gets a slightly smaller font so its value is not cut off; per-row icons (`favMode: 'img'`) are used; the "asleep for" times in the popup are seeded.

## Regenerate

Needs Node 22 and Chrome. One Chrome runs at a time, in a scratch profile under `CMR_TEST_ROOT` (or the system temp folder), and is killed and deleted afterwards.

```
node store-assets/tools/shots-capture.mjs all     # raw captures -> store-assets/screenshots/raw/{en,th}/ (about 4 minutes per language)
node store-assets/tools/shots-compose.mjs all     # final art    -> store-assets/screenshots/{en,th}/ and store-assets/promo/
```

`shots-compose.mjs` accepts `en` or `th`, `--only=1,3` and `--no-promo`. `SHOTS_TOTAL=400` makes a quick trial capture with fewer tabs. Fonts used: Prompt and IBM Plex Sans Thai (installed on the machine; fallbacks Leelawadee UI and Segoe UI). Nothing is loaded from the web.

`raw/` holds the unedited captures and `rects.json` (element positions used for cropping). It is an intermediate; do not upload it.
