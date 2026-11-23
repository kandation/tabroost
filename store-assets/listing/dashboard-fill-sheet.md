# Tabroost: Chrome Web Store dashboard fill sheet

One sheet, in the dashboard's own order. Each field's text is in its own block: copy the block and paste it into the field. Texts are copied unchanged from the source files in `store-assets/listing/`; only dashboard answers (checkboxes, visibility, file paths) are written here. Dashboard labels change over time, so match the idea if a label differs. The contact email is entered by the owner in the dashboard account settings; it is not part of this sheet.

---

## 1. Package

Upload this file (Add new item, or Package > Upload new package):

```
dist\tabroost-1.0.0.zip
```

Version in the zip: 1.0.0 (MV3, minimum Chrome 121).

---

## 2. Store listing

### 2.1 Default language: English

**Name** (max 75)

```
Tabroost
```

**Summary** (max 132)

```
Save all your open tabs to a searchable list, and put idle tabs to sleep to use less memory. Everything stays on your device.
```

**Description** (max 16,000)

```
Tabroost helps you manage tabs and use less memory. Save everything you have open into a searchable list with one click, close the tabs, and bring them back whenever you want.

WHAT IT DOES

Save all open tabs
Click the toolbar icon (or press Alt+Shift+S). Tabroost saves the tabs from all your windows as one "tab set", then closes them. If you have a lot of tabs, it closes them gradually and watches your free memory so the browser does not freeze.

Open them again without a memory spike
Open one tab or a whole tab set from the list. Tabs are opened in small steps and stay asleep until you click them, so restoring 100 tabs does not load 100 pages at once.

Put idle tabs to sleep
Optional auto-sleep puts tabs you have not used for a while to sleep. A sleeping tab stays in the tab bar and reloads when you click it. It is off for tabs that are playing audio or video, tabs with form input you have not saved, and sites on your allow list (video-call sites are on it by default).

Find things fast
Fuzzy search, sort, group and filter. Keyboard shortcuts on the list page can be switched on or off one by one in Settings. Pin, star, add categories, and keep Chrome tab groups: tab groups are saved and restored with their names and colors.

Do not lose work
Deleted items wait in a trash for a set number of days. Tabroost also keeps recovery notes of your open tabs every few minutes, so you can recover lost tabs after a crash. You can export everything to a file, and import lists from other tab managers.

HOW IT PROTECTS YOUR TABS AND DATA

- Your saved tabs are stored in this browser (IndexedDB and extension storage), not on a server.
- Tabroost has no servers, no account, no analytics, no ads and makes no network requests of its own. It does not download or run remote code.
- Before sleeping a tab, a short script checks the page for unsaved form input or playing media. It only reads that yes/no answer on your device. It does not read or store page content.

OPTIONAL: SYNC BETWEEN YOUR DEVICES

If you turn it on, Tabroost encrypts your tab sets with a passphrase you choose and stores the encrypted data in your browser's own bookmarks, in a folder named "Tabroost sync data - do not edit" under Other bookmarks. Chrome's own sync (if you use it) carries the bookmarks to your other devices. The entries look like bookmarks to https://cmr.invalid/..., which is a reserved address that cannot open anything; they only hold encrypted data. Do not edit or move this folder. Your passphrase is never stored or sent. If you forget it, the synced data cannot be recovered, but your local list is not affected. Sync is off by default.

PRIVACY

Tabroost keeps the URLs and titles of tabs you choose to save, your settings, and (optionally) local usage statistics, on your device only. Nothing is sold, shared or sent to the developer. The statistics can be switched off. You can export or delete your data at any time. Full policy: see the privacy policy link on this page.

OPTIONAL: PASSWORD LOCK

Off by default. If you turn it on, Tabroost encrypts your saved list on this computer (titles, links, notes, the trash and the backup copy) with your password, and locks itself after idle time or when your screen locks. It protects against someone at your computer and against someone copying the browser profile folder. It does not hide when sets were saved or how many tabs they hold. If you forget the password, you can open the list with the recovery key, or with a backup password or a passkey you set up in Settings. If you have none of these, the list cannot be opened again; saving tabs still works. The lock and sync work together: synced data stays encrypted in the sync folder with your sync passphrase, the lock key protects the data on this computer, and sync pauses while the list is locked and carries on after you unlock. Before you erase everything after losing a password, you can save an encrypted backup file (.tabroost) that opens only with the old password, recovery key, backup password or passkey and can be imported again later.

DASHBOARD

- A local dashboard of how you use tabs over time (off by default, can be turned off any time)

WHY THESE PERMISSIONS

tabs and tabGroups: read and close your open tabs, and save/restore tab groups.
storage and unlimitedStorage: keep your saved list and settings on your device.
alarms: run auto-sleep and crash-recovery notes on a timer.
contextMenus: right-click menu items to save a tab.
scripting and (optional) access to sites: run the short check for unsaved input or playing media before sleeping a tab. Asked only when you press "Allow checking forms and video"; without it, auto-sleep stays paused. Nothing else.
favicon: show site icons in your list from the browser's own cache.
system.memory: read free memory to pace closing and restoring tabs.
bookmarks (optional, asked when you turn on sync): only for the optional encrypted sync folder.
sessions (optional, asked when you press "Turn on" in recovery): show Chrome's recently closed tabs in the recovery list.

HOW TO START

1. Install Tabroost and pin it to the toolbar.
2. Open a few tabs and click the Tabroost icon. They are saved and closed.
3. Open the list from the icon, then click a tab or tab set to open it again.
4. Open Settings in the list page to set auto-sleep, trash time, language (Thai or English) and optional sync.

Tabroost is an independent project. It is not affiliated with or endorsed by Google or any other tab manager.
```

**Category**

```
Productivity
```

(If the dashboard lists sub-areas, pick the closest to "Workflow & Planning" or "Tools".)

**Language**

```
English
```

**Homepage URL** (if asked)

```
https://github.com/kandation/tabroost
```

**Support URL** (if asked)

```
https://kandation.github.io/tabroost/support.html
```

### 2.2 Second language: Thai (Add language > Thai)

**Name** (max 75)

```
Tabroost
```

**Summary** (max 132)

```
เก็บแท็บทั้งหมดไว้ในรายการที่ค้นหาได้ และพักแท็บที่ไม่ได้ใช้เพื่อใช้แรมน้อยลง ข้อมูลอยู่ในเครื่องคุณ
```

**Description** (max 16,000)

```
Tabroost ช่วยจัดการแท็บและใช้แรมน้อยลง กดครั้งเดียวเพื่อเก็บทุกแท็บที่เปิดอยู่ไว้ในรายการที่ค้นหาได้ แล้วปิดแท็บเหล่านั้น เปิดกลับมาเมื่อไหร่ก็ได้

ทำอะไรได้บ้าง

เก็บทุกแท็บที่เปิดอยู่
กดไอคอนบนแถบเครื่องมือ (หรือกด Alt+Shift+S) Tabroost จะเก็บแท็บจากทุกหน้าต่างเป็น "ชุดแท็บ" หนึ่งชุด แล้วปิดแท็บ ถ้ามีแท็บเยอะ จะค่อย ๆ ปิดและดูแรมที่เหลือไปด้วย เบราว์เซอร์จะได้ไม่ค้าง

เปิดกลับโดยแรมไม่พุ่ง
เปิดแท็บเดียวหรือทั้งชุดแท็บจากรายการ แท็บจะถูกเปิดทีละน้อยและอยู่ในสถานะพักจนกว่าคุณจะคลิก การเปิดกลับ 100 แท็บจึงไม่โหลด 100 หน้าพร้อมกัน

พักแท็บที่ไม่ได้ใช้
เปิดใช้การพักอัตโนมัติได้ (เป็นตัวเลือก) แท็บที่ไม่ได้ใช้มาสักพักจะถูกพัก ยังอยู่บนแถบแท็บ และโหลดใหม่เมื่อคุณคลิก จะไม่พักแท็บที่กำลังเล่นเสียงหรือวิดีโอ แท็บที่มีข้อมูลในฟอร์มที่ยังไม่ได้บันทึก และเว็บไซต์ในรายการที่คุณกันไว้ (ค่าเริ่มต้นกันเว็บประชุมวิดีโอไว้ให้)

ค้นหาได้เร็ว
ค้นหาแบบยืดหยุ่น เรียง จัดกลุ่ม และกรอง เปิดหรือปิดปุ่มลัดของหน้ารายการทีละปุ่มได้ในตั้งค่า ปักหมุด ติดดาว ใส่หมวดหมู่ และเก็บกลุ่มแท็บของ Chrome ไว้พร้อมชื่อและสี

งานไม่หาย
ของที่ลบจะรออยู่ในถังขยะตามจำนวนวันที่ตั้งไว้ Tabroost จดแท็บที่เปิดอยู่ไว้ทุกไม่กี่นาที เพื่อกู้คืนแท็บที่หายหลังเบราว์เซอร์ล่ม ส่งออกทุกอย่างเป็นไฟล์ได้ และนำเข้ารายการจากโปรแกรมจัดการแท็บอื่นได้

ปกป้องแท็บและข้อมูลของคุณอย่างไร

- แท็บที่เก็บไว้อยู่ในเบราว์เซอร์นี้ (IndexedDB และที่เก็บข้อมูลของส่วนขยาย) ไม่ได้อยู่บนเซิร์ฟเวอร์
- Tabroost ไม่มีเซิร์ฟเวอร์ ไม่ต้องสมัครบัญชี ไม่มีการวิเคราะห์การใช้งาน ไม่มีโฆษณา และไม่ส่งคำขอเครือข่ายเอง ไม่ดาวน์โหลดหรือรันโค้ดจากภายนอก
- ก่อนพักแท็บ จะมีสคริปต์สั้น ๆ ตรวจว่าหน้านั้นมีข้อมูลในฟอร์มที่ยังไม่ได้บันทึกหรือกำลังเล่นสื่ออยู่หรือไม่ ได้คำตอบแค่ใช่/ไม่ใช่บนเครื่องคุณ ไม่อ่านหรือเก็บเนื้อหาของหน้า

ตัวเลือก: ซิงค์ระหว่างเครื่อง

ถ้าเปิดใช้ Tabroost จะเข้ารหัสชุดแท็บด้วยรหัสผ่านที่คุณตั้ง แล้วเก็บข้อมูลที่เข้ารหัสไว้ในบุ๊กมาร์กของเบราว์เซอร์ ในโฟลเดอร์ชื่อ "Tabroost sync data - do not edit" ใต้ Other bookmarks ถ้าคุณใช้การซิงค์ของ Chrome อยู่ บุ๊กมาร์กจะไปถึงเครื่องอื่นของคุณเอง รายการเหล่านี้หน้าตาเหมือนบุ๊กมาร์กไปที่ https://cmr.invalid/... ซึ่งเป็นที่อยู่สงวนที่เปิดอะไรไม่ได้ ใช้เก็บข้อมูลที่เข้ารหัสเท่านั้น อย่าแก้หรือย้ายโฟลเดอร์นี้ รหัสผ่านไม่ถูกเก็บและไม่ถูกส่งออกไปไหน ถ้าลืมรหัสผ่าน ข้อมูลที่ซิงค์จะกู้ไม่ได้ แต่รายการในเครื่องไม่ได้รับผลกระทบ การซิงค์ปิดอยู่เป็นค่าเริ่มต้น

ความเป็นส่วนตัว

Tabroost เก็บ URL และชื่อของแท็บที่คุณเลือกเก็บ การตั้งค่า และ (ถ้าเปิด) สถิติการใช้งานในเครื่อง ไว้ในเครื่องของคุณเท่านั้น ไม่มีการขาย แบ่งปัน หรือส่งให้ผู้พัฒนา ปิดสถิติได้ ส่งออกหรือลบข้อมูลได้ทุกเมื่อ อ่านนโยบายฉบับเต็มได้จากลิงก์นโยบายความเป็นส่วนตัวในหน้านี้

ตัวเลือก: ล็อกด้วยรหัสผ่าน

ปิดอยู่เป็นค่าเริ่มต้น ถ้าเปิด Tabroost จะเข้ารหัสรายการที่เก็บไว้ในเครื่อง (ชื่อหน้า ลิงก์ โน้ต ถังขยะ และสำเนาสำรอง) ด้วยรหัสผ่านของคุณ และล็อกเองเมื่อไม่ได้ใช้หรือเมื่อล็อกหน้าจอ กันได้ทั้งคนที่นั่งหน้าเครื่องและคนที่ก๊อปโฟลเดอร์โปรไฟล์ แต่ไม่ซ่อนเวลาที่เก็บหรือจำนวนแท็บ ถ้าลืมรหัสผ่าน เปิดรายการด้วยรหัสกู้คืน หรือด้วยรหัสผ่านสำรองหรือพาสคีย์ (หรือกุญแจความปลอดภัย) ที่ตั้งไว้ในการตั้งค่าได้ ถ้าไม่มีสักอย่าง จะเปิดรายการไม่ได้อีก (แต่ยังเก็บแท็บได้) พาสคีย์อยู่ในอุปกรณ์หรือกุญแจของคุณ Tabroost เก็บแค่รหัสอ้างอิงสาธารณะกับค่าสุ่ม ไม่เก็บความลับ และไม่ส่งอะไรไปไหน ล็อกกับซิงค์ใช้ร่วมกันได้ ข้อมูลในโฟลเดอร์ซิงค์ยังเข้ารหัสด้วยรหัสผ่านซิงค์ ส่วนกุญแจของล็อกปกป้องข้อมูลในเครื่องนี้ ซิงค์จะหยุดพักตอนล็อกและทำงานต่อหลังปลดล็อก ก่อนลบทุกอย่างเพราะลืมรหัสผ่าน คุณบันทึกไฟล์สำรองที่เข้ารหัส (.tabroost) ไว้ได้ ไฟล์นี้เปิดได้ด้วยรหัสผ่านเดิม รหัสกู้คืน รหัสผ่านสำรอง หรือพาสคีย์ของตอนนั้นเท่านั้น และนำเข้ากลับมาทีหลังได้

แดชบอร์ด

- แดชบอร์ดในเครื่องที่แสดงการใช้แท็บตามเวลา (ปิดได้)

ทำไมต้องขอสิทธิ์เหล่านี้

tabs และ tabGroups: อ่านและปิดแท็บที่เปิดอยู่ และเก็บ/เปิดกลุ่มแท็บกลับ
storage และ unlimitedStorage: เก็บรายการและการตั้งค่าไว้ในเครื่อง
alarms: ตั้งเวลาพักอัตโนมัติและจดแท็บไว้กู้คืน
contextMenus: เมนูคลิกขวาสำหรับเก็บแท็บ
scripting และการเข้าถึงเว็บไซต์ (ขอทีหลัง): รันสคริปต์สั้น ๆ ตรวจข้อมูลฟอร์มที่ยังไม่บันทึกหรือสื่อที่กำลังเล่น ก่อนพักแท็บ ขอเฉพาะตอนกด “อนุญาตให้ตรวจฟอร์มและวิดีโอ” ถ้าไม่อนุญาต การพักอัตโนมัติจะหยุดไว้ ไม่ทำอย่างอื่น
favicon: แสดงไอคอนเว็บในรายการจากแคชของเบราว์เซอร์เอง
system.memory: อ่านแรมที่เหลือเพื่อปรับจังหวะการปิดและเปิดแท็บ
bookmarks (ขอทีหลัง ตอนเปิดซิงค์): ใช้กับโฟลเดอร์ซิงค์ที่เข้ารหัสซึ่งเป็นตัวเลือกเท่านั้น
sessions (ขอทีหลัง ตอนกด “เปิดใช้” ในหน้ากู้คืน): แสดงแท็บที่เพิ่งปิดของ Chrome ในรายการกู้คืน

เริ่มใช้งาน

1. ติดตั้ง Tabroost แล้วปักไว้บนแถบเครื่องมือ
2. เปิดแท็บสักสองสามแท็บ แล้วกดไอคอน Tabroost แท็บจะถูกเก็บและปิด
3. เปิดรายการจากไอคอน แล้วคลิกแท็บหรือชุดแท็บเพื่อเปิดกลับ
4. ไปที่ "การตั้งค่า" ในหน้ารายการ เพื่อตั้งการพักอัตโนมัติ ระยะเวลาถังขยะ ภาษา (ไทยหรืออังกฤษ) และการซิงค์แบบเลือกได้

Tabroost เป็นโครงการอิสระ ไม่มีส่วนเกี่ยวข้องหรือได้รับการรับรองจาก Google หรือโปรแกรมจัดการแท็บอื่นใด
```

**Language**

```
Thai (ไทย)
```

Category is set once for the item (Productivity, as above).

---

## 3. Graphic assets

All files are PNG, no alpha.

**Store icon 128x128**

```
icons\icon128.png
```

**Screenshots, English (default language), 1280x800, upload in this order**

```
1  store-assets\screenshots\en\01-save-every-tab.png
2  store-assets\screenshots\en\02-find-any-tab.png
3  store-assets\screenshots\en\03-idle-tabs-sleep.png
4  store-assets\screenshots\en\04-private-by-design.png
5  store-assets\screenshots\en\05-organise-your-way.png
```

**Screenshots, Thai (upload under the Thai language), 1280x800**

```
1  store-assets\screenshots\th\01-save-every-tab.png
2  store-assets\screenshots\th\02-find-any-tab.png
3  store-assets\screenshots\th\03-idle-tabs-sleep.png
4  store-assets\screenshots\th\04-private-by-design.png
5  store-assets\screenshots\th\05-organise-your-way.png
```

**Small promo tile 440x280**

```
EN: store-assets\promo\small-tile-440x280-en.png
TH: store-assets\promo\small-tile-440x280-th.png
```

**Marquee promo tile 1400x560**

```
EN: store-assets\promo\marquee-1400x560-en.png
TH: store-assets\promo\marquee-1400x560-th.png
```

Do not upload `screenshots\raw\` (intermediate captures) or `promo\github-social-1280x640.png` (GitHub only).

---

## 4. Privacy tab

### 4.1 Single purpose description

```
Tabroost manages browser tabs and reduces memory use. It saves open tabs into a searchable local list and closes them, reopens them later without loading everything at once, and puts idle tabs to sleep.
```

### 4.2 Permission justifications (required permissions)

**tabs**

```
Tabroost reads the URL, title, window, group and pinned/audible state of open tabs so it can save them into the user's list, close them, restore them, find duplicates, and decide which idle tabs may be put to sleep. This is the core feature. The data stays on the user's device and is never sent anywhere.
```

**tabGroups**

```
Used to read the name, color and membership of Chrome tab groups when saving tabs, and to recreate those groups when the user reopens a saved tab set. If the user turns off "keep tab groups", it is not used.
```

**storage**

```
Stores the user's settings and small state (for example the list of protected sites, the sleep timer and a second backup copy of the saved list) in chrome.storage on the user's device.
```

**unlimitedStorage**

```
A saved list can contain thousands of tabs (URLs, titles, notes, recovery snapshots) in IndexedDB. Without this permission the browser's default quota could silently fail on large lists and the user would lose saved tabs. Nothing is uploaded.
```

**alarms**

```
Schedules the periodic jobs in the Manifest V3 service worker: checking for idle tabs to sleep, writing the crash-recovery note of open tabs every few minutes, purging expired trash items, and the optional sync timer. No alarms run for tracking.
```

**contextMenus**

```
Adds right-click menu items on the toolbar icon (open the list, save this tab, save other tabs, save tabs to the right, save all windows, protect this site) and on a page (keep this tab awake, put this tab to sleep now), so the user can act without opening the popup.
```

**scripting**

```
Used only for the short check before a tab is put to sleep (chrome.scripting.executeScript with a function bundled in the extension, never remote code): is there a form field with input that was not saved, and is media currently playing. If either is true, or if the check cannot run, the tab is not put to sleep. The permission by itself gives no access to any site: it only works on sites the user has allowed through the optional "check forms and video before sleeping a tab" permission, and it fails harmlessly everywhere else. The result is used on the spot; page content is not read out, stored or sent.
```

**favicon**

```
Shows each saved page's site icon in the list using the browser's own favicon cache (chrome-extension://.../_favicon/). It does not contact the sites. The user can turn icons off in settings.
```

**idle**

```
Used by the optional password lock only: when the operating system locks the screen, Tabroost can lock the saved list too (a setting, on by default once the lock is turned on). It reads no activity and no page content; it only receives the "locked" state change. The permission produces no install-time warning.
```

**system.memory**

```
Reads the amount of free memory so Tabroost can pace closing and restoring: it closes or opens tabs in smaller steps when memory is low, which keeps the browser from freezing. The value is used locally and not stored or sent.
```

### 4.3 Host permission and optional permissions

The manifest has `optional_host_permissions: ["<all_urls>"]` and `optional_permissions: ["bookmarks", "sessions"]`. If the dashboard shows a field for each, use these; if it shows one host-permission field, use the first.

**Host permission (<all_urls>, optional, asked at run time)**

```
Requested only when the user presses "Allow checking forms and video before sleeping a tab". Needed only so the scripting check can run on whichever site is open when a tab is about to be put to sleep, to avoid losing text the user typed and to avoid stopping playing video. Tabroost has no content scripts, does not run on pages at load, does not read or modify page content, and makes no network requests to those sites. The script runs only on demand, only on tabs being considered for sleep, and only if auto-sleep is enabled. If the permission is not granted, or a page cannot be checked (for example a restricted page), the tab is left awake: auto-sleep simply stays paused and the settings page, the popup and a dismissible banner say so and offer the button.
```

**bookmarks (optional)**

```
Requested only when the user presses "Turn on sync" for the optional encrypted sync feature, which is off by default. Tabroost then creates one folder named "Tabroost sync data - do not edit" under Other bookmarks and stores AES-GCM-encrypted data in bookmark entries with the reserved address https://cmr.invalid/... (a non-resolving address). Chrome's own bookmark sync can then carry it to the user's other devices. Tabroost only touches that folder and never reads, changes or deletes the user's real bookmarks. If the user declines or later removes the permission, sync stays off or pauses, and all saved tabs on the device stay untouched.
```

**sessions (optional)**

```
Requested only when the user presses "Turn on" next to "Tabs Chrome just closed" in the crash-recovery screen. It reads Chrome's "recently closed" list so lost tabs can be shown next to Tabroost's own recovery notes and restored. It is read on demand when the user opens that screen. Without it, that one list is hidden and Tabroost's own recovery notes still work.
```

### 4.4 Remote code

Question "Are you using remote code?": answer **No**. Justification, if a field is shown:

```
No. All code is bundled in the extension package. There are no remote scripts, no eval or new Function, and no remotely hosted libraries. The scripting function that checks tabs is part of the package.
```

### 4.5 Data usage (what user data is collected or handled)

Answers from `privacy-practices.md`:

| Category | Answer |
|---|---|
| Personally identifiable information | leave unticked |
| Health information | leave unticked |
| Financial and payment information | leave unticked |
| Authentication information | leave unticked |
| Personal communications | leave unticked |
| Location | leave unticked |
| **Web history** | **TICK** |
| **User activity** | **TICK** |
| Website content | leave unticked |

Justification for Web history (if a field is shown):

```
Tabroost saves the URL and title of tabs the user chooses to save, so it can show them in the user's list and reopen them later. It also keeps short recovery notes of the open tabs so tabs can be recovered after a crash. This data is stored only on the user's device (IndexedDB and chrome.storage), is not transmitted to the developer or any third party, and can be exported or deleted by the user at any time.
```

Justification for User activity (if a field is shown):

```
Optional local statistics (for example when a saved tab was last used and daily counters) are used to show the user a dashboard and to sort the list. They are stored only on the device, are never sent anywhere, and can be switched off in settings.
```

### 4.6 Certifications (tick all three)

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

### 4.7 Privacy policy URL

```
https://kandation.github.io/tabroost/privacy.html
```

---

## 5. Distribution

| Field | Answer |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |
| Publishing mode | Owner's choice: publish automatically after approval, or defer and press Publish yourself |

---

## 6. Test instructions (for reviewers)

No login or account is needed. Paste:

```
No account or login is needed. The extension works fully offline and has no server.

SETUP
1. Install Tabroost. Pin it from the puzzle-piece menu.
2. Open 6-10 ordinary tabs (for example wikipedia.org, example.com, news pages). Put two of them in a Chrome tab group (right-click a tab > Add tab to new group).

A. SAVE AND RESTORE (core feature)
1. Click the Tabroost toolbar icon (or press Alt+Shift+S). The tabs from all windows are saved and closed, and the saved list opens in a tab.
2. In the list you will see one "tab set" with your tabs. Try the search box at the top (type part of a title), the sort/filter buttons, pin and star icons.
3. Click one saved tab: it opens again. Click "Open all" on the tab set: tabs reopen gradually and are asleep (greyed) until you click them. Tab groups are recreated with their names and colors.
4. Delete a tab set: it moves to Trash (left menu). Restore it from Trash.

B. AUTO-SLEEP AND PROTECTION (needs the optional permission; it is not granted at install)
0. Tabroost asks for page access only when needed. Open Settings (left menu) > "Permissions asked later" (or the Sleep card) and press "Allow checking forms and video before sleeping a tab", then accept Chrome's prompt. Until you do, auto-sleep is paused on purpose (no tab is ever slept without the check) and the page says so. You can take the permission back with the "Take back" button in the same card.
1. Open Settings (left menu). Auto-sleep is on by default with a 20 minute idle time. For a quick test set the idle time to the smallest option, or right-click on any web page and choose the Tabroost item "put this tab to sleep now".
2. Open a page with a text box (for example any site with a search box). Type some text without submitting, switch to another tab, then use the same right-click action on the first tab: it is NOT put to sleep because of unsaved input. This is the only reason the extension has access to all websites: a short built-in function checks for unsaved form input or playing media before a tab is slept.
3. Open any video/audio page, start playback, switch tab: the playing tab is not slept.

C. CRASH RECOVERY
Settings has a "Recover lost tabs" list (left menu: clock icon). It shows recovery notes of open tabs that Tabroost writes every few minutes. Chrome's own recently closed tabs appear there after pressing "Turn on" (optional sessions permission).

D. EXPORT AND DELETE
Settings > Export/Import: export to a file. Trash > empty to delete for good.

E. OPTIONAL ENCRYPTED SYNC (off by default; needs two browser profiles to see devices syncing)
Sync stores encrypted data in a bookmark folder that Chrome's own bookmark sync can carry to other devices. A reviewer can verify it with a single profile:
1. Settings > Sync between devices > Turn on. Chrome first asks to allow the optional bookmarks permission (needed only for this feature; "No" keeps sync off and changes nothing). Choose any passphrase (write it down; it cannot be recovered).
2. Open the bookmark manager (chrome://bookmarks). Under "Other bookmarks" there is a folder "Tabroost sync data - do not edit". Its entries are bookmarks to https://cmr.invalid/... which is a reserved, non-resolving address and only holds encrypted text. Nothing is contacted.
3. Optional two-device check: open a second Chrome profile signed in to the same Google account with bookmark sync on (or copy the folder through bookmark export/import), install Tabroost there, turn on Sync with the same passphrase. Tab sets saved on the first profile appear in the second. Without the passphrase the data stays unreadable.
4. Turn sync off in Settings to remove the folder.

F. STATISTICS DASHBOARD (local)
Left menu > the dashboard entry opens a local page. All numbers come from data in this browser. It can be turned off in Settings, which stops collecting.

NOTES
- The language follows the browser language (Thai or English) and can be switched in Settings > Language.
- Tabroost makes no network requests of its own. Site icons come from the browser's favicon cache.
- Tab pages on chrome:// cannot be inspected by extensions; Tabroost saves their URLs only if "internal pages" is set to save.
```

---

## 7. Last checks before "Submit for review"

- The privacy policy URL opens (no 404).
- Contact email entered and verified in the dashboard account settings (owner only).
- Trader / non-trader status declared (EU).
- Name search done (see `pre-submission-checklist.md`).

---

## Character counts

Counted with node (`[...string].length`). Limits: name 75, summary 132, description 16,000. The 1,000 limit for justification boxes is a cautious guide, not a verified dashboard limit.

| Field | Characters | Limit |
|---|---|---|
| EN name | 8 | 75 |
| EN summary | 125 | 132 |
| EN description | 5494 | 16000 |
| TH name | 8 | 75 |
| TH summary | 100 | 132 |
| TH description | 4736 | 16000 |
| Single purpose | 202 | 1000 |
| perm tabs | 305 | 1000 |
| perm tabGroups | 207 | 1000 |
| perm storage | 184 | 1000 |
| perm unlimitedStorage | 242 | 1000 |
| perm alarms | 245 | 1000 |
| perm contextMenus | 267 | 1000 |
| perm scripting | 609 | 1000 |
| perm favicon | 191 | 1000 |
| perm idle | 311 | 1000 |
| perm system.memory | 225 | 1000 |
| host permission | 766 | 1000 |
| bookmarks | 644 | 1000 |
| sessions | 365 | 1000 |
| remote code | 201 | 1000 |
| Web history | 410 | 1000 |
| User activity | 247 | 1000 |
| Test instructions | 4167 | none stated |

No text was shortened; every field is copied unchanged from its source file.
