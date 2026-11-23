// Facts shown on the About page (about.html): who made it, where to write, and the credits.
// The developer fills in INFO before publishing. A value that is empty (or still contains "TODO" or "{{") is shown as "ยังไม่ได้ตั้งค่า" / "Not set yet".
// PURE module (no chrome.*): the Node test imports it.

export const INFO = {
  DEVELOPER_NAME: '', // TODO: your name or studio, as it should appear in the policy and the MIT line
  CONTACT_EMAIL: '', // TODO: a public contact address for privacy questions
  EFFECTIVE_DATE: '', // TODO: the date the privacy policy takes effect, for example 2026-12-01
  REPO_URL: '', // TODO: https://github.com/<you>/<repo>
  ISSUES_URL: '', // TODO: https://github.com/<you>/<repo>/issues
  PRIVACY_URL: '', // TODO: the public privacy policy page (the store listing needs the same address)
  SUPPORT_URL: '', // TODO: the public support page
};
export const COPYRIGHT_YEAR = '2026';

export const isSet = (v) => typeof v === 'string' && v.trim() !== '' && !/TODO|\{\{|\}\}/.test(v);
/** Only https links are ever rendered as links. */
export const safeUrl = (v) => (isSet(v) && /^https:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : '');

// ---- MIT licence text of this project (same words as the LICENSE file; the holder line is filled from INFO) ----
export const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// ---- Credits: a structured copy of THIRD-PARTY-NOTICES.md -------------------------------------------------------------
// ONE source of truth is THIRD-PARTY-NOTICES.md (it ships in the zip, as the licences ask). This array is the hand-kept copy that the page
// renders offline. When you change the markdown, change this array too, then run:  node tools/check-notices.mjs
// (it fails when a section, a file name or a link appears in one and not the other). Each item: k = short name (must appear in the markdown),
// th / en = one plain sentence, url = optional list of links (each must appear in the markdown).
export const NOTICES = [
  {
    id: 'A', title: { th: 'โค้ดของบุคคลอื่นที่รวมอยู่ในส่วนขยาย', en: 'Third-party code inside the extension' },
    intro: {
      th: 'ไม่มี โค้ด CSS และ HTML ทั้งหมดในส่วนขยายเขียนขึ้นสำหรับโครงการนี้ ไม่มีไลบรารี ไม่มีไฟล์ที่ย่อขนาด ไม่มีโค้ดที่คัดลอกมา และไม่โหลดอะไรจากอินเทอร์เน็ต',
      en: 'None. All JavaScript, CSS and HTML in the extension was written for this project. No library, no minified file, no copied snippet, and nothing is loaded from the web.',
    },
    items: [],
  },
  {
    id: 'B', title: { th: 'API และบริการของแพลตฟอร์มที่ใช้', en: 'Platform APIs and services used' },
    intro: {
      th: 'ของเหล่านี้มากับ Chrome และเบราว์เซอร์ Tabroost เรียกใช้ผ่านช่องทางสาธารณะ ไม่ได้คัดลอกโค้ดของเขามา',
      en: 'These come with Chrome and the browser. Tabroost calls them through their public interfaces. None of their code is copied.',
    },
    items: [
      { k: 'Chrome extension APIs', th: 'เก็บ พัก และเปิดแท็บ การตั้งค่า ปุ่มลัด เมนู ค่าแรมที่เหลือ โฟลเดอร์ซิงค์ที่เข้ารหัส', en: 'Saving, sleeping and reopening tabs, settings, shortcuts, menus, free memory, the encrypted sync folder.' },
      { k: '_favicon', th: 'ไอคอนเว็บ Chrome ให้จากแคชไอคอนในเครื่อง Tabroost ไม่ดึงไอคอนจากอินเทอร์เน็ต', en: 'Site icons. Chrome serves them from its own local icon cache. Tabroost does not fetch icons from the web.' },
      { k: 'IndexedDB', th: 'รายการที่เก็บไว้ ถังขยะ ตัวช่วยค้นหา สถิติ', en: 'The saved list, trash, search helper and statistics.' },
      { k: 'Web Crypto', th: 'AES-GCM, PBKDF2-SHA256, HKDF, HMAC, ECDH และ SHA-256 สำหรับซิงค์และการล็อก ไม่มีโค้ดเข้ารหัสของเราเอง', en: 'AES-GCM, PBKDF2-SHA256, HKDF, HMAC, ECDH and SHA-256 for sync and the lock feature. No cipher code of our own.' },
      { k: 'Compression Streams', th: 'บีบอัดแบบ gzip และ deflate สำหรับบันทึกกู้คืน สำเนาสำรอง และข้อมูลซิงค์', en: 'gzip and deflate for recovery notes, the backup copy and sync data.' },
      { k: 'Intl.Segmenter', th: 'ตัดคำไทยสำหรับค้นหา, Intl.Collator เรียงลำดับ, Intl.DateTimeFormat แสดงวันที่', en: 'Thai word boundaries for search; Intl.Collator for sorting; Intl.DateTimeFormat for dates.' },
    ],
  },
  {
    id: 'C', title: { th: 'อัลกอริทึม ข้อกำหนด และบทความที่โค้ดอิงอยู่', en: 'Algorithms, specifications and papers the code is based on' },
    intro: {
      th: 'โค้ดเขียนเองสำหรับโครงการนี้ รายการนี้บอกว่าแนวคิดและข้อกำหนดสาธารณะใดที่ทำตาม',
      en: 'The code was written for this project. This lists the ideas and public specifications it follows.',
    },
    items: [
      { k: 'lib/sync/hlc.js', th: 'นาฬิกาตรรกะแบบผสม (Hybrid Logical Clock) ของ Kulkarni และคณะ ปี 2014', en: 'Hybrid logical clock, Kulkarni et al., 2014.', url: ['https://cse.buffalo.edu/tech-reports/2014-04.pdf'] },
      { k: 'lib/sync/merge.js', th: 'การรวมแบบ “ผู้เขียนล่าสุดชนะ” ระดับฟิลด์ (last-writer-wins) จากงานของ Shapiro และคณะ ปี 2011', en: 'Field-level last-writer-wins merge, from Shapiro et al., 2011.', url: ['https://inria.hal.science/inria-00555588'] },
      { k: 'lib/searchIndex.js', th: 'ระยะแก้ไขแบบ optimal string alignment (Damerau-Levenshtein แบบจำกัด) สำหรับค้นหาแม้พิมพ์ผิด', en: 'Optimal string alignment distance (restricted Damerau-Levenshtein) for typo-tolerant search.', url: ['https://en.wikipedia.org/wiki/Damerau%E2%80%93Levenshtein_distance'] },
      { k: 'lib/searchNorm.js', th: 'ดัชนีกลับด้าน (inverted index) และตัวกรองแบบสามตัวอักษรสำหรับภาษาไทย เป็นเทคนิคในตำราทั่วไป ไม่ได้คัดลอกโค้ด', en: 'Inverted index and a three-letter pre-filter for Thai. Textbook techniques, no code copied.' },
      { k: 'lib/lock/kdf.js', th: 'ตัวอักษร Crockford Base32 สำหรับรหัสกู้คืน ส่วนตัวตรวจ 3 ไบต์เป็นของโครงการนี้เอง', en: 'Crockford Base32 alphabet for the recovery key. The 3-byte check is this project’s own.', url: ['https://www.crockford.com/base32.html'] },
      { k: 'lib/sync/crypto.js', th: 'PBKDF2 (RFC 8018), HKDF (RFC 5869), HMAC (RFC 2104), AES-GCM (NIST SP 800-38D), SHA-256 (FIPS 180-4) จำนวนรอบ 600,000 สอดคล้องกับคำแนะนำของ OWASP', en: 'PBKDF2 (RFC 8018), HKDF (RFC 5869), HMAC (RFC 2104), AES-GCM (NIST SP 800-38D), SHA-256 (FIPS 180-4). 600,000 rounds is in line with OWASP guidance.', url: ['https://www.rfc-editor.org/rfc/rfc8018', 'https://www.rfc-editor.org/rfc/rfc5869', 'https://csrc.nist.gov/pubs/sp/800/38/d/final', 'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html'] },
      { k: 'lib/firstseen.js', th: 'แฮช FNV-1a 32 บิต (อัลกอริทึมสาธารณะของ Fowler, Noll และ Vo)', en: 'FNV-1a 32-bit hash (public algorithm by Fowler, Noll and Vo).', url: ['http://www.isthe.com/chongo/tech/comp/fnv/'] },
      { k: 'lib/formats.js', th: 'อ่านและเขียนข้อความรูปแบบเดียวกับ OneTab (บรรทัดละลิงก์) ใช้เฉพาะรูปแบบข้อความ ไม่ได้ใช้โค้ดของ OneTab', en: 'Reads and writes the OneTab text layout (one link per line). Only the text layout; no OneTab code.' },
      { k: 'tools/make-icons.mjs', th: 'CRC-32 และส่วนข้อมูลของไฟล์ PNG (เครื่องมือพัฒนา ไม่อยู่ในไฟล์ติดตั้ง)', en: 'CRC-32 and chunk layout of PNG files (development tool, not in the shipped zip).', url: ['https://www.w3.org/TR/png/'] },
    ],
  },
  {
    id: 'D', title: { th: 'ข้อมูลที่อิงจากรายการสาธารณะ', en: 'Data derived from public lists' },
    intro: {
      th: 'lib/site.js มีชุดส่วนท้ายโดเมนหลายระดับ 109 รายการ (เช่น co.th, co.uk, github.io) เขียนด้วยมือจากความรู้ทั่วไป ไม่ได้ดาวน์โหลดหรือคัดลอกไฟล์ Public Suffix List ใช้เดาว่าที่อยู่เว็บเป็น “เว็บไซต์” ไหน ไม่จำเป็นต้องให้เครดิตตามกฎหมาย แต่เราให้เครดิตเพราะแนวคิดและหลายรายการมาจากงานของโครงการนั้น รายการของเราเล็กและไม่ครบ ถ้าส่วนท้ายใดไม่อยู่ในรายการ ชื่อเว็บไซต์ที่แสดงอาจไม่ตรง',
      en: 'lib/site.js has 109 multi-label domain endings (for example co.th, co.uk, github.io), typed by hand from general knowledge. The Public Suffix List file was not downloaded or copied. It is used to guess the "site" of a web address. No credit is legally required for it, but we give one because the idea and many entries come from that project’s work. Our set is small and incomplete. For an ending that is not in it, the site name shown may be wrong.',
    },
    items: [
      { k: 'Public Suffix List', th: 'สัญญาอนุญาต Mozilla Public License 2.0', en: 'Licensed under the Mozilla Public License 2.0.', url: ['https://publicsuffix.org/', 'https://www.mozilla.org/MPL/2.0/'] },
    ],
  },
  {
    id: 'E', title: { th: 'ฟอนต์ ไอคอน และรูปภาพ', en: 'Fonts, icons and images' },
    intro: {
      th: 'ไม่มีฟอนต์ที่รวมมาด้วย สไตล์ชีตเพียงระบุชื่อฟอนต์ เบราว์เซอร์ใช้ฟอนต์ที่ติดตั้งในเครื่องคุณอยู่แล้ว สัญญาอนุญาตของฟอนต์เหล่านั้นเป็นของผู้ผลิต',
      en: 'No fonts are bundled. The stylesheets only name fonts, and the browser uses the ones already installed on your computer. The licences of those fonts belong to their makers.',
    },
    items: [
      { k: 'Leelawadee UI', th: 'ชื่อฟอนต์ที่อ้างถึง: Leelawadee UI, Noto Sans Thai, Sarabun, Segoe UI, Roboto, Tahoma, Consolas และฟอนต์ระบบ', en: 'Fonts named: Leelawadee UI, Noto Sans Thai, Sarabun, Segoe UI, Roboto, Tahoma, Consolas and the system fonts.' },
      { k: 'Interface icons', th: 'ไอคอนในหน้าจอเป็นเส้น SVG ที่วาดสำหรับโครงการนี้ ไม่มีชุดไอคอนสำเร็จรูป', en: 'Interface icons are SVG paths drawn for this project. No icon set is bundled.' },
      { k: 'Extension icon and logo', th: 'ไอคอนและโลโก้วาดเป็น SVG สำหรับโครงการนี้ แล้วแปลงเป็น PNG ไม่มีภาพสต็อก ไม่มีข้อความฟอนต์ ไม่มีงานของผู้อื่น', en: 'Drawn as SVG for this project and turned into PNG. No stock art, no font text, no one else’s artwork.' },
    ],
  },
  {
    id: 'F', title: { th: 'เครื่องหมายการค้า', en: 'Trademarks' },
    intro: {
      th: '“Chrome”, “Chromium”, “Google” และ “Chrome Web Store” เป็นเครื่องหมายการค้าของ Google LLC Tabroost เป็นโครงการอิสระ ไม่มีส่วนเกี่ยวข้อง ไม่ได้รับการสนับสนุน และไม่ได้รับการรับรองจาก Google “OneTab” และชื่อผลิตภัณฑ์อื่นเป็นของเจ้าของเหล่านั้น ใช้เพื่อบอกรูปแบบไฟล์ที่อ่านหรือเขียนได้เท่านั้น',
      en: '"Chrome", "Chromium", "Google" and "Chrome Web Store" are trademarks of Google LLC. Tabroost is an independent project. It is not affiliated with, sponsored by or endorsed by Google. "OneTab" and other product names belong to their owners and appear only to say which file format can be read or written.',
    },
    items: [],
  },
  {
    id: 'G', title: { th: 'แนวทางการออกแบบ', en: 'Design' },
    intro: {
      th: 'หน้าตา (การ์ด แถบด้านข้าง ธีมสว่างและมืด) ทำตามรูปแบบทั่วไปของหน้าตั้งค่าส่วนขยายและเว็บแอป ไม่ได้คัดลอกสไตล์ชีต เลย์เอาต์ หรืองานภาพของผลิตภัณฑ์อื่น',
      en: 'The look (cards, a left sidebar, light and dark themes) follows common patterns of extension and web app settings pages. No other product’s stylesheet, layout files or artwork was copied.',
    },
    items: [],
  },
];
