// Strings of about.html (Thai first, English second) and the privacy policy text. Wording follows tools/glossary.md.
// PURE module (no chrome.*, no DOM): the Node test imports it.
//
// The policy below is the same text as store-assets/listing/privacy-policy.html (the public page). tests/about-test.mjs compares the two
// section by section, so when you edit one, edit the other. {{DEVELOPER_NAME}}, {{ISSUES_URL}} and {{EFFECTIVE_DATE}} are filled from lib/aboutinfo.js.
// Inline marks inside a string: `code` and [text](https://link).

import { isSet, safeUrl } from './aboutinfo.js';

export const TH = {
  pageTitle: 'เกี่ยวกับ',
  title: 'เกี่ยวกับ · ความเป็นส่วนตัว · เครดิต', back: '← กลับไปการตั้งค่า', version: (v) => `รุ่น ${v}`,
  purpose: 'เก็บแท็บไว้ในรายการ และพักแท็บที่ไม่ได้ใช้เพื่อคืนแรม',
  toc: 'ในหน้านี้', tocPrivacy: 'ความเป็นส่วนตัว', tocWhere: 'ข้อมูลอยู่ที่ไหน', tocControl: 'สิ่งที่คุณทำได้', tocPolicy: 'นโยบายฉบับเต็ม', tocCredits: 'เครดิต', tocLicense: 'สัญญาอนุญาต', tocLinks: 'ลิงก์', tocKeys: 'ปุ่มลัด',
  privH: 'ความเป็นส่วนตัวของคุณ',
  privLead: 'ข้อมูลอยู่ในเครื่องนี้ ไม่มีเซิร์ฟเวอร์ ไม่มีบัญชี ไม่มีการวิเคราะห์การใช้งาน ไม่มีโฆษณา ผู้พัฒนาไม่ได้รับข้อมูลของคุณเลย',
  whereH: 'ข้อมูลของคุณอยู่ที่ไหน', colPlace: 'ที่เก็บ', colWhat: 'เก็บอะไร', colNow: 'ตอนนี้',
  rowIdb: 'IndexedDB ในเบราว์เซอร์นี้', rowIdbWhat: 'ชุดแท็บ แท็บ ถังขยะ ตัวช่วยค้นหา สถิติ (ถ้าเปิดไว้)',
  rowStore: 'ที่เก็บข้อมูลของส่วนขยาย', rowStoreWhat: 'การตั้งค่า สำเนาสำรอง บันทึกแท็บไว้กู้คืน',
  rowBm: 'บุ๊กมาร์กของเบราว์เซอร์', rowBmWhat: 'ข้อมูลซิงค์ที่เข้ารหัสแล้ว เฉพาะเมื่อคุณเปิดซิงค์ ปิดอยู่เป็นค่าเริ่มต้น', rowBmNow: 'ไม่ได้อ่านจากหน้านี้',
  rowNet: 'เซิร์ฟเวอร์ใด ๆ', rowNetWhat: 'ไม่มี Tabroost ไม่ส่งข้อมูลออกจากเครื่อง', rowNetNow: 'ไม่มี',
  nowIdb: (sets, tabs) => `${sets} ชุดแท็บ · ${tabs} แท็บ`, nowStore: (kb) => `ประมาณ ${kb}`, nowTotal: (mb, quota) => `รวมที่ใช้ ประมาณ ${mb} จาก ${quota} ที่เบราว์เซอร์ให้`, unknown: 'อ่านค่าไม่ได้', loading: 'กำลังอ่าน…',
  ctrlH: 'สิ่งที่คุณทำได้', ctrlOpen: 'เปิดการตั้งค่า',
  ctrlExport: 'ส่งออกข้อมูลของฉัน', ctrlExportD: 'ในการตั้งค่า ไปที่ “สำรองและนำเข้าข้อมูล” แล้วกด “ส่งออกทั้งหมดเป็นไฟล์”',
  ctrlStats: 'ลบข้อมูลสถิติ', ctrlStatsD: 'ในการตั้งค่า ไปที่ “สถิติและความเป็นส่วนตัว” แล้วกด “ลบข้อมูลสถิติทั้งหมด”',
  ctrlAll: 'ลบทุกอย่าง', ctrlAllD: 'ลบชุดแท็บทั้งหมดในรายการ แล้วล้างถังขยะ หรือถอนการติดตั้งส่วนขยาย ข้อมูลในเครื่องจะหายไปด้วย ถ้าเคยเปิดซิงค์ ให้ลบโฟลเดอร์ “Tabroost sync data - do not edit” ใน “Other bookmarks” ด้วย ลบแล้วเอากลับมาไม่ได้',
  policyH: 'นโยบายความเป็นส่วนตัวฉบับเต็ม', policyMeta: (d, dev, url) => `มีผลตั้งแต่ ${d}${dev ? ` · ผู้พัฒนา ${dev}` : ''}${url ? ` · ติดต่อ ${url}` : ''}`, inShort: 'สรุป',
  creditsH: 'เครดิตและสัญญาอนุญาต', creditsLead: 'ไม่มีโค้ดของบุคคลอื่นรวมอยู่ในส่วนขยาย รายการนี้คือสิ่งที่ส่วนขยายใช้หรืออิงอยู่ ฉบับเต็มอยู่ในไฟล์ THIRD-PARTY-NOTICES.md', noneItems: 'ไม่มีรายการ',
  mitH: 'สัญญาอนุญาตของ Tabroost (MIT)', mitLead: 'ซอร์สโค้ดของ Tabroost ใช้สัญญาอนุญาต MIT',
  linksH: 'ลิงก์', linkRepo: 'ซอร์สโค้ด', linkIssues: 'แจ้งปัญหา', linkPrivacy: 'นโยบายความเป็นส่วนตัว (หน้าเว็บ)', linkSupport: 'ช่วยเหลือ',
  notSet: 'ยังไม่ได้ตั้งค่า',
  keysH: 'ปุ่มลัด', keysNone: 'ยังไม่ได้ตั้ง', keysAction: 'เปิด Tabroost จากไอคอนส่วนขยาย', keysEdit: 'ตั้งหรือเปลี่ยนปุ่มลัด', keysFail: 'อ่านรายการปุ่มลัดไม่ได้', keysOpenFail: 'เปิดหน้าปุ่มลัดไม่ได้ ไปที่ chrome://extensions/shortcuts เอง',
  trademark: 'Tabroost เป็นโครงการอิสระ ไม่มีส่วนเกี่ยวข้องหรือได้รับการรับรองจาก Google “Chrome” และ “Google” เป็นเครื่องหมายการค้าของ Google LLC',
};

export const EN = {
  pageTitle: 'About',
  title: 'About · Privacy · Credits', back: '← Back to settings', version: (v) => `Version ${v}`,
  purpose: 'Save tabs to a list and sleep idle tabs to free RAM.',
  toc: 'On this page', tocPrivacy: 'Privacy', tocWhere: 'Where your data is', tocControl: 'What you can do', tocPolicy: 'Full policy', tocCredits: 'Credits', tocLicense: 'Licence', tocLinks: 'Links', tocKeys: 'Shortcuts',
  privH: 'Your privacy',
  privLead: 'Your data stays on this computer. No servers, no accounts, no analytics, no ads. The developer never receives your data.',
  whereH: 'Where your data is', colPlace: 'Place', colWhat: 'What is kept', colNow: 'Right now',
  rowIdb: 'IndexedDB in this browser', rowIdbWhat: 'Tab sets, tabs, trash, search helper, statistics (if on)',
  rowStore: 'Extension storage', rowStoreWhat: 'Settings, backup copy, recovery notes of open tabs',
  rowBm: 'Browser bookmarks', rowBmWhat: 'Encrypted sync data, only if you turn sync on. It is off by default', rowBmNow: 'Not read from this page',
  rowNet: 'Any server', rowNetWhat: 'None. Tabroost sends nothing out of your computer', rowNetNow: 'None',
  nowIdb: (sets, tabs) => `${sets} tab ${sets === 1 ? 'set' : 'sets'} · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'}`, nowStore: (kb) => `about ${kb}`, nowTotal: (mb, quota) => `Total used: about ${mb} of ${quota} the browser allows`, unknown: 'Could not read', loading: 'Reading…',
  ctrlH: 'What you can do', ctrlOpen: 'Open settings',
  ctrlExport: 'Export my data', ctrlExportD: 'In settings, go to “Backup and import” and press “Export all as a file”.',
  ctrlStats: 'Delete statistics', ctrlStatsD: 'In settings, go to “Statistics and privacy” and press “Delete all statistics”.',
  ctrlAll: 'Delete everything', ctrlAllD: 'Delete every tab set in the list, then empty the trash. Or remove the extension: its local data goes with it. If you ever turned sync on, also delete the folder “Tabroost sync data - do not edit” under “Other bookmarks”. Deleted data cannot be brought back.',
  policyH: 'Full privacy policy', policyMeta: (d, dev, url) => `Effective ${d}${dev ? ` · Developer ${dev}` : ''}${url ? ` · Contact ${url}` : ''}`, inShort: 'In short',
  creditsH: 'Credits and licences', creditsLead: 'No third-party code is inside the extension. This is what it uses or is based on. The full text is in THIRD-PARTY-NOTICES.md.', noneItems: 'No items',
  mitH: 'Tabroost licence (MIT)', mitLead: 'The Tabroost source code is under the MIT licence.',
  linksH: 'Links', linkRepo: 'Source code', linkIssues: 'Report a problem', linkPrivacy: 'Privacy policy (web page)', linkSupport: 'Support',
  notSet: 'Not set yet',
  keysH: 'Keyboard shortcuts', keysNone: 'Not set', keysAction: 'Open Tabroost from the toolbar icon', keysEdit: 'Set or change shortcuts', keysFail: 'Could not read the shortcut list', keysOpenFail: 'Could not open the shortcuts page. Go to chrome://extensions/shortcuts yourself.',
  trademark: 'Tabroost is an independent project and is not affiliated with or endorsed by Google. "Chrome" and "Google" are trademarks of Google LLC.',
};

export const POLICY_NOTE = {
  th: 'Tabroost เป็นโครงการอิสระ ไม่มีส่วนเกี่ยวข้องหรือได้รับการรับรองจาก Google',
  en: 'Tabroost is an independent project and is not affiliated with or endorsed by Google.',
};

// ---------------------------------------------------------------------------------------------------------------------
// Privacy policy (same text as store-assets/listing/privacy-policy.html)
// ---------------------------------------------------------------------------------------------------------------------
export const POLICY_EN = {
  summary: "Tabroost keeps your data on your device. It has no servers, no accounts, no analytics and no ads. We do not collect, sell or share your data, and the developer never receives it.",
  sections: [
    { h: "What data Tabroost handles", b: [
      [
        "The address (URL) and title of tabs you choose to save, plus notes, categories, pin/star flags and the Chrome tab group name and color of those tabs.",
        "Short recovery notes of your open tabs, written every few minutes, so tabs can be recovered after a crash.",
        "Your settings (for example the sleep timer, protected sites, language, theme).",
        "Optional local usage statistics (for example when a saved tab was last used and daily counters). You can turn them off in settings.",
        "The free-memory value reported by the browser, used only to pace closing and opening tabs. It is not stored.",
      ],
      "Tabroost does not ask for your name, email, location, payment details or any account.",
    ] },
    { h: "Where the data is stored", b: [
      "All of the above is stored locally in your browser (IndexedDB and chrome.storage of the extension). It is not sent to the developer or to any third party. Tabroost makes no network requests of its own. Site icons come from the browser's own favicon cache.",
    ] },
    { h: "Checking tabs before sleeping them", b: [
      "If you enable auto-sleep, Tabroost runs a short function bundled in the extension inside a tab that is about to be put to sleep. It checks only two things: whether the page has form input that was not saved, and whether media is playing. The answer is yes or no, is used on the spot, and page content is not read out, stored or sent. This is why the extension asks for access to all websites.",
    ] },
    { h: "Optional sync between your devices", b: [
      "Sync is off by default. If you turn it on, you choose a passphrase. Tabroost encrypts your tab sets, categories and (unless you switch off “Sync settings too”) your settings on your device (AES-GCM with a 256-bit key protected by a key derived from your passphrase using PBKDF2-SHA256) and writes the encrypted data into your browser's bookmarks, in a folder named `Tabroost sync data - do not edit` under \"Other bookmarks\".",
      "The entries in that folder are bookmarks to addresses that start with `https://cmr.invalid/`. The `.invalid` domain is reserved and can never be opened. The \"bookmarks\" only carry encrypted text so that the browser's own bookmark sync (if you use Chrome sync) can move it to your other devices. They are not real websites, and Tabroost never contacts them. Please do not edit, move or delete this folder while sync is on.",
      "The developer has no access to this data. Your passphrase is never stored or sent. If you forget it, the synced data cannot be recovered, but the list on each device is not affected. If you use browser sync, the encrypted bookmarks are handled by your browser vendor under its own policy.",
    ] },
    { h: "No analytics, ads, sale or transfer", b: [
      "Tabroost does not include analytics, advertising, tracking or crash-reporting tools. We do not sell your data. We do not transfer or share it with third parties, except as the browser's own sync does when you turn it on (see section 4). We do not use data to decide credit or lending, and we do not use it for anything other than the extension's single purpose: managing your tabs and reducing memory use.",
    ] },
    { h: "Limited Use", b: [
      "The use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements. Data is used only to provide and improve the user-facing features described here, is not transferred except as stated, is not used for personalized or other advertising, and is not read by humans.",
    ] },
    { h: "Security", b: [
      "No code is loaded from outside the extension. Synced data is end-to-end encrypted as described above. By default, data stored locally is not encrypted by Tabroost; it is protected by your operating system account and browser profile, and anyone who can use your browser profile can read your saved list. You can turn on a password lock in Settings (off by default). With it on, Tabroost encrypts the saved list on this computer: tab titles and links, sites, notes, tab set names, the trash, the saved copies used to recover lost tabs, the backup copy, and your site rules. The password is never stored or sent anywhere. The lock protects against someone using your unlocked computer and against someone who copies your browser profile folder or disk. It does not hide when a set was saved, how many tabs it has or that it exists, and it does not help against malware running on your computer while you are unlocked. Someone holding a copy of the files can try passwords much faster than the waiting time inside the app allows, so use a long password. If you forget the password, you can open the list with the recovery key, or with a backup password or a passkey (or security key) that you set up in Settings. If you have none of these, the list cannot be opened again (saving tabs still works). A passkey stays in your device or key; Tabroost keeps only its public id and a random value, never a secret, and nothing is sent anywhere. Older data may stay in unused disk space until Chrome cleans up its files. Keep your device secure. The lock and sync work together: synced data stays encrypted in the sync folder with your sync passphrase, the lock key protects the data on this computer, and sync pauses while the list is locked and carries on after you unlock. Before you erase everything after losing a password, you can save an encrypted backup file (.tabroost) that opens only with the old password, recovery key, backup password or passkey and can be imported again later.",
    ] },
    { h: "Your controls", b: [
      [
        "Export all your data to a file at any time, and import it again.",
        "Delete items, empty the trash, or delete everything from the list page. Deleted items wait in the trash for the number of days you choose, then are removed.",
        "Turn off statistics, favicons, crash-recovery notes, auto-sleep and sync in settings.",
        "Uninstalling the extension removes its local data. Delete the sync folder from your bookmarks to remove encrypted sync data.",
      ],
    ] },
    { h: "Retention", b: [
      "Data stays until you delete it. Trash items are purged after the retention days in settings. Daily statistics are kept for the number of days in settings (default 400 days) or until you turn them off.",
    ] },
    { h: "Children", b: [
      "Tabroost is a general-purpose tool and is not directed at children under 13. It does not knowingly collect personal information from anyone.",
    ] },
    { h: "Changes to this policy", b: [
      "If this policy changes, the new version will be posted at this address with a new effective date. Material changes will also be noted in the extension's release notes.",
    ] },
    { h: "Contact", b: [
      "For privacy questions, support or any request, open an issue on the project's GitHub page ([Issues]({{ISSUES_URL}})). Please do not post private data there.",
    ] },
  ],
};

export const POLICY_TH = {
  summary: "Tabroost เก็บข้อมูลไว้ในเครื่องของคุณ ไม่มีเซิร์ฟเวอร์ ไม่มีบัญชี ไม่มีการวิเคราะห์การใช้งาน และไม่มีโฆษณา เราไม่เก็บรวบรวม ขาย หรือแบ่งปันข้อมูลของคุณ และผู้พัฒนาไม่ได้รับข้อมูลนั้น",
  sections: [
    { h: "Tabroost จัดการข้อมูลอะไรบ้าง", b: [
      [
        "ที่อยู่ (URL) และชื่อของแท็บที่คุณเลือกเก็บ รวมถึงบันทึกย่อ หมวดหมู่ ธงปักหมุด/ติดดาว และชื่อกับสีของกลุ่มแท็บ Chrome ของแท็บเหล่านั้น",
        "บันทึกสั้น ๆ ของแท็บที่เปิดอยู่ ซึ่งจดทุกไม่กี่นาที เพื่อกู้คืนแท็บหลังเบราว์เซอร์ล่ม",
        "การตั้งค่าของคุณ (เช่น เวลาพักแท็บ เว็บไซต์ที่กันไว้ ภาษา ธีม)",
        "สถิติการใช้งานในเครื่องที่เป็นตัวเลือก (เช่น เวลาที่ใช้แท็บที่เก็บไว้ล่าสุด และตัวนับรายวัน) ปิดได้ในการตั้งค่า",
        "ค่าแรมที่เหลือที่เบราว์เซอร์รายงาน ใช้เพื่อปรับจังหวะการปิดและเปิดแท็บเท่านั้น และไม่ถูกเก็บ",
      ],
      "Tabroost ไม่ขอชื่อ อีเมล ตำแหน่งที่อยู่ ข้อมูลการชำระเงิน หรือบัญชีใด ๆ",
    ] },
    { h: "ข้อมูลถูกเก็บที่ไหน", b: [
      "ข้อมูลทั้งหมดข้างต้นเก็บในเครื่องของคุณ ภายในเบราว์เซอร์ (IndexedDB และ chrome.storage ของส่วนขยาย) ไม่ถูกส่งให้ผู้พัฒนาหรือบุคคลที่สาม Tabroost ไม่ส่งคำขอเครือข่ายเอง ไอคอนเว็บมาจากแคชไอคอนของเบราว์เซอร์เอง",
    ] },
    { h: "การตรวจแท็บก่อนพัก", b: [
      "ถ้าคุณเปิดการพักอัตโนมัติ Tabroost จะรันฟังก์ชันสั้น ๆ ที่มากับส่วนขยายในแท็บที่กำลังจะถูกพัก ฟังก์ชันตรวจแค่สองอย่าง คือ หน้านั้นมีข้อมูลในฟอร์มที่ยังไม่บันทึกหรือไม่ และกำลังเล่นสื่ออยู่หรือไม่ คำตอบเป็นใช่หรือไม่ใช่ ใช้ทันที ไม่อ่านออกมา ไม่เก็บ และไม่ส่งเนื้อหาของหน้า นี่คือเหตุผลที่ส่วนขยายขอสิทธิ์เข้าถึงทุกเว็บไซต์",
    ] },
    { h: "ซิงค์ระหว่างเครื่อง (ตัวเลือก)", b: [
      "ปิดอยู่เป็นค่าเริ่มต้น ถ้าเปิด คุณตั้งรหัสผ่านเอง Tabroost จะเข้ารหัสชุดแท็บ หมวดหมู่ และการตั้งค่า (ถ้าคุณไม่ปิดตัวเลือก “ซิงค์การตั้งค่าด้วย”) ในเครื่องของคุณ (AES-GCM คีย์ 256 บิตที่ป้องกันด้วยคีย์ที่สร้างจากรหัสผ่านด้วย PBKDF2-SHA256) แล้วเขียนข้อมูลที่เข้ารหัสลงในบุ๊กมาร์กของเบราว์เซอร์ ในโฟลเดอร์ชื่อ `Tabroost sync data - do not edit` ภายใต้ \"Other bookmarks\"",
      "รายการในโฟลเดอร์นั้นคือบุ๊กมาร์กที่ชี้ไปยังที่อยู่ขึ้นต้นด้วย `https://cmr.invalid/` โดเมน `.invalid` เป็นโดเมนสงวนที่เปิดไม่ได้ \"บุ๊กมาร์ก\" เหล่านี้เก็บแค่ข้อความที่เข้ารหัส เพื่อให้การซิงค์บุ๊กมาร์กของเบราว์เซอร์ (ถ้าคุณใช้ Chrome sync) พาไปยังเครื่องอื่นของคุณได้ ไม่ใช่เว็บไซต์จริง และ Tabroost ไม่เคยติดต่อที่อยู่เหล่านั้น โปรดอย่าแก้ ย้าย หรือลบโฟลเดอร์นี้ขณะเปิดซิงค์",
      "ผู้พัฒนาเข้าถึงข้อมูลนี้ไม่ได้ รหัสผ่านไม่ถูกเก็บและไม่ถูกส่ง ถ้าลืมรหัสผ่าน ข้อมูลที่ซิงค์จะกู้ไม่ได้ แต่รายการในแต่ละเครื่องไม่ได้รับผลกระทบ ถ้าคุณใช้การซิงค์ของเบราว์เซอร์ บุ๊กมาร์กที่เข้ารหัสจะอยู่ในการดูแลของผู้ให้บริการเบราว์เซอร์ตามนโยบายของเขา",
    ] },
    { h: "ไม่มีการวิเคราะห์ โฆษณา การขาย หรือการโอนข้อมูล", b: [
      "Tabroost ไม่มีเครื่องมือวิเคราะห์ โฆษณา ติดตาม หรือรายงานข้อขัดข้อง เราไม่ขายข้อมูลของคุณ ไม่โอนหรือแบ่งปันให้บุคคลที่สาม ยกเว้นสิ่งที่การซิงค์ของเบราว์เซอร์ทำเองเมื่อคุณเปิด (ดูข้อ 4) เราไม่ใช้ข้อมูลเพื่อตัดสินเครดิตหรือการให้กู้ และไม่ใช้เพื่อสิ่งอื่นนอกจากวัตถุประสงค์เดียวของส่วนขยาย คือจัดการแท็บและลดการใช้แรม",
    ] },
    { h: "การใช้อย่างจำกัด (Limited Use)", b: [
      "การใช้ข้อมูลที่ได้รับจาก Chrome API เป็นไปตาม [นโยบายข้อมูลผู้ใช้ของ Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/limited-use) รวมถึงข้อกำหนด Limited Use ข้อมูลถูกใช้เพื่อให้บริการฟีเจอร์ที่ผู้ใช้เห็นตามที่อธิบายไว้เท่านั้น ไม่ถูกโอนนอกจากที่ระบุ ไม่ถูกใช้เพื่อโฆษณาแบบเจาะจงหรือแบบอื่น และไม่มีมนุษย์อ่านข้อมูลนั้น",
    ] },
    { h: "ความปลอดภัย", b: [
      "ไม่มีการโหลดโค้ดจากภายนอกส่วนขยาย ข้อมูลที่ซิงค์เข้ารหัสตลอดทางตามที่อธิบายข้างต้น โดยปกติข้อมูลที่เก็บในเครื่อง Tabroost ไม่ได้เข้ารหัส ข้อมูลถูกปกป้องด้วยบัญชีระบบปฏิบัติการและโปรไฟล์เบราว์เซอร์ของคุณ ผู้ที่ใช้โปรไฟล์เบราว์เซอร์ของคุณได้ก็อ่านรายการที่เก็บไว้ได้ คุณเปิดรหัสผ่านได้ในการตั้งค่า (ปิดอยู่เป็นค่าเริ่มต้น) เมื่อเปิด Tabroost จะเข้ารหัสรายการที่เก็บไว้ในเครื่องนี้ ทั้งชื่อหน้าและลิงก์ เว็บไซต์ โน้ต ชื่อชุดแท็บ ถังขยะ ชุดสำรองที่ใช้กู้แท็บที่หายไป สำเนาสำรอง และกฎเกี่ยวกับเว็บไซต์ของคุณ รหัสผ่านไม่ถูกเก็บและไม่ถูกส่งไปไหน ล็อกนี้กันได้เฉพาะคนที่ใช้เครื่องที่ปลดล็อกอยู่ และคนที่ก๊อปโฟลเดอร์โปรไฟล์หรือดิสก์ไป แต่ไม่ซ่อนเวลาที่เก็บ จำนวนแท็บ หรือการมีอยู่ของชุดแท็บ และไม่ช่วยถ้ามีโปรแกรมร้ายทำงานในเครื่องตอนที่ปลดล็อกอยู่ คนที่ถือสำเนาไฟล์ลองเดารหัสผ่านได้เร็วกว่าเวลารอในแอปมาก จึงควรตั้งรหัสผ่านยาวๆ ถ้าลืมรหัสผ่าน เปิดรายการด้วยรหัสกู้คืน หรือด้วยรหัสผ่านสำรองหรือพาสคีย์ (หรือกุญแจความปลอดภัย) ที่ตั้งไว้ในการตั้งค่าได้ ถ้าไม่มีสักอย่าง จะเปิดรายการไม่ได้อีก (แต่ยังเก็บแท็บได้) พาสคีย์อยู่ในอุปกรณ์หรือกุญแจของคุณ Tabroost เก็บแค่รหัสอ้างอิงสาธารณะกับค่าสุ่ม ไม่เก็บความลับ และไม่ส่งอะไรไปไหน ข้อมูลเก่าอาจค้างในพื้นที่ว่างของดิสก์อยู่พักหนึ่งจนกว่า Chrome จะเก็บกวาดไฟล์ ควรรักษาความปลอดภัยของอุปกรณ์ด้วย ล็อกกับซิงค์ใช้ร่วมกันได้ ข้อมูลในโฟลเดอร์ซิงค์ยังเข้ารหัสด้วยรหัสผ่านซิงค์ ส่วนกุญแจของล็อกปกป้องข้อมูลในเครื่องนี้ ซิงค์จะหยุดพักตอนล็อกและทำงานต่อหลังปลดล็อก ก่อนลบทุกอย่างเพราะลืมรหัสผ่าน คุณบันทึกไฟล์สำรองที่เข้ารหัส (.tabroost) ไว้ได้ ไฟล์นี้เปิดได้ด้วยรหัสผ่านเดิม รหัสกู้คืน รหัสผ่านสำรอง หรือพาสคีย์ของตอนนั้นเท่านั้น และนำเข้ากลับมาทีหลังได้",
    ] },
    { h: "สิ่งที่คุณควบคุมได้", b: [
      [
        "ส่งออกข้อมูลทั้งหมดเป็นไฟล์ได้ทุกเมื่อ และนำเข้ากลับมาได้",
        "ลบรายการ ล้างถังขยะ หรือลบทั้งหมดได้จากหน้ารายการ ของที่ลบจะรออยู่ในถังขยะตามจำนวนวันที่คุณเลือก แล้วถูกลบถาวร",
        "ปิดสถิติ ไอคอนเว็บ การจดแท็บไว้กู้คืน การพักอัตโนมัติ และการซิงค์ได้ในการตั้งค่า",
        "ถอนการติดตั้งส่วนขยายจะลบข้อมูลในเครื่อง ลบโฟลเดอร์ซิงค์ออกจากบุ๊กมาร์กเพื่อลบข้อมูลซิงค์ที่เข้ารหัส",
      ],
    ] },
    { h: "ระยะเวลาเก็บข้อมูล", b: [
      "ข้อมูลอยู่จนกว่าคุณจะลบ ของในถังขยะถูกลบตามจำนวนวันในการตั้งค่า สถิติรายวันเก็บตามจำนวนวันในการตั้งค่า (ค่าเริ่มต้น 400 วัน) หรือจนกว่าคุณจะปิดสถิติ",
    ] },
    { h: "เด็ก", b: [
      "Tabroost เป็นเครื่องมือทั่วไปและไม่ได้มุ่งเป้าไปที่เด็กอายุต่ำกว่า 13 ปี และไม่เก็บข้อมูลส่วนบุคคลของใครโดยเจตนา",
    ] },
    { h: "การเปลี่ยนแปลงนโยบาย", b: [
      "ถ้านโยบายเปลี่ยน เราจะประกาศฉบับใหม่ที่ที่อยู่นี้พร้อมวันที่มีผลใหม่ การเปลี่ยนที่สำคัญจะระบุในบันทึกการออกรุ่นของส่วนขยายด้วย",
    ] },
    { h: "ติดต่อ", b: [
      "หากมีคำถามเรื่องความเป็นส่วนตัว ต้องการความช่วยเหลือ หรือมีคำขอใด ๆ ให้เปิด issue ที่หน้า GitHub ของโครงการ ([Issues]({{ISSUES_URL}})) โปรดอย่าโพสต์ข้อมูลส่วนตัวที่นั่น",
    ] },
  ],
};


// ---------------------------------------------------------------------------------------------------------------------
// helpers (pure)
// ---------------------------------------------------------------------------------------------------------------------

/** Replaces {{NAME}} with the value from info. A value that is not filled in becomes `unset` (never the raw braces). */
export function fill(str, info, unset) {
  return String(str).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (isSet(info && info[k]) ? String(info[k]).trim() : unset));
}

/** Splits one string into parts: {t:'text'|'code'|'a', s, u?}. Only https and mailto links become 'a'; anything else stays plain text. */
export function inlineParts(str) {
  const out = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const s = String(str);
  let last = 0; let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', s: s.slice(last, m.index) });
    if (m[1] != null) out.push({ t: 'code', s: m[1] });
    else if (safeUrl(m[3]) || /^mailto:[^\s@"'<>]+@[^\s@"'<>.]+\.[^\s@"'<>]+$/.test(m[3])) out.push({ t: 'a', s: m[2], u: m[3] });
    else out.push({ t: 'text', s: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: 'text', s: s.slice(last) });
  return out;
}

/** The whole policy of one language as plain data with the placeholders resolved (what the page shows, minus the DOM). */
export function renderPolicy(lang, info) {
  const th = lang === 'th';
  const P = th ? POLICY_TH : POLICY_EN;
  const S = th ? TH : EN;
  const unset = S.notSet;
  // A link target that is not set leaves just the link text (never "Not set yet" inside the brackets).
  const f = (x) => fill(String(x).replace(/\]\(\{\{([A-Z_]+)\}\}\)/g, (m, k) => `](${safeUrl(info && info[k]) || 'x'})`), info, unset);
  const opt = (k) => (isSet(info && info[k]) ? String(info[k]).trim() : '');
  return {
    meta: S.policyMeta(f('{{EFFECTIVE_DATE}}'), opt('DEVELOPER_NAME'), safeUrl(info && info.ISSUES_URL)),
    summary: f(P.summary),
    sections: P.sections.map((s, i) => ({ n: i + 1, h: f(s.h), b: s.b.map((x) => (Array.isArray(x) ? x.map(f) : f(x))) })),
    note: POLICY_NOTE[th ? 'th' : 'en'],
  };
}
