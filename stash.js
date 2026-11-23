// List page (also the options page). Reads IndexedDB directly (read-only); every change goes through runtime
// messages to the service worker.
//
// The list is ONE virtual scroller: rows = [date bucket header | group header | item row]. Only the rows in the
// viewport (+ a little overscan) exist as DOM nodes, recycled from small pools and placed with translateY. Group
// headers come from the small `groups` store; item rows are fetched in positional pages (200) only for groups the
// user expanded, kept in a sparse LRU cache. Heights are fixed, so the total height and any scroll jump are
// computed from per-group counts without loading data.

const STR = {
  appName: 'Tabroost',
  searchPh: 'ค้นหาชื่อหรือลิงก์… (กด Esc เพื่อล้าง)',
  jumpLabel: 'ไปที่',
  jumpPh: 'ไปที่…',
  undoStash: 'เลิกเก็บครั้งล่าสุด', expTime: 'รวมข้อมูลเวลา (ใช้ล่าสุด เปิดเมื่อ) ในไฟล์ส่งออก', setNotHere: 'ไม่พบชุดนี้ในมุมมองตอนนี้ อาจถูกลบหรือถูกกรองไว้',
  openAll: 'เปิดทั้งหมด',
  exportImport: 'ส่งออก/นำเข้า',
  settings: 'ตั้งค่า',
  totals: (g, m, k, gb) => `${g} ชุดแท็บ · ${m} แท็บที่เก็บไว้ · พักอยู่ ${k} แท็บ (ประหยัดแรมประมาณ ${gb} GB)`,
  searchInfo: (n, ms) => `พบ ${n} รายการ`,
  searchCap: (n) => `แสดงแค่ ${n} รายการแรก พิมพ์คำค้นเพิ่มเพื่อให้เหลือน้อยลง`,
  searchShort: 'พิมพ์อย่างน้อย 2 ตัวอักษรเพื่อค้นหา',
  searchPaused: 'ตอนนี้กำลังปิดแท็บและแรมเหลือน้อย จึงหยุดค้นหาไว้ก่อน จะกลับมาใช้ได้เมื่อปิดเสร็จ',
  searchExact: (n, ms) => `พบ ${n} รายการ`,
  searchWithFuzzy: (n, f, ms) => `พบ ${n} รายการ (ตรงตัว ${n - f} · ใกล้เคียง ${f})`,
  searchSimilar: 'ผลที่ใกล้เคียง (เผื่อพิมพ์ผิดนิดหน่อย)',
  searchMore: 'แสดงเพิ่ม',
  searchFuzzyTip: 'ตรงโดยประมาณ',
  searchLoading: 'กำลังเตรียมการค้นหา… ตอนนี้ยังค้นหาได้ แต่อาจช้ากว่าปกติ',
  searchIndexing: (p) => `กำลังจัดทำตัวช่วยค้นหา ${p}% ตอนนี้ยังค้นหาได้ แต่อาจช้ากว่าปกติ`,
  searchIdxErr: (e) => `ตัวช่วยค้นหาใช้ไม่ได้ (${e}) จึงค้นหาแบบช้าลงแทน ลองกด “สร้างตัวช่วยค้นหาใหม่” ในหน้าตั้งค่า`,
  noMatchBuilding: 'ไม่พบรายการ (กำลังจัดทำตัวช่วยค้นหาอยู่ ผลอาจยังไม่ครบ ลองใหม่อีกสักครู่)',
  rebuildIndex: 'สร้างตัวช่วยค้นหาใหม่',
  indexInfo: (docs, mb, state) => `ตัวช่วยค้นหา: ${docs} แท็บ · ประมาณ ${mb} MB · ${state === 'ready' ? 'พร้อมใช้' : state === 'building' ? 'กำลังสร้าง' : state}`,
  lowMemHint: 'แรมเหลือน้อย จึงหยุดโหลดรายการไว้ก่อนระหว่างปิดแท็บ',
  sSetLook: 'ป้ายสีและอีโมจิของชุดแท็บ', sSetLookD: 'แถบสีและอีโมจิหน้าชื่อชุด ตั้งได้จากเมนู ⋯ ของแต่ละชุด', sPeek: 'ดูตัวอย่างเมื่อวางเมาส์บนชุดที่พับอยู่', sPeekD: 'แสดงชื่อ 5 แท็บแรก ไม่แสดงเมื่อเปิดรหัสผ่านและยังล็อกอยู่', sCover: 'ภาพปกจากไอคอนเว็บ', sCoverD: 'แสดงไอคอนเว็บ 4 อันหน้าชื่อชุด เฉพาะความหนาแน่นแบบสบายตา และเมื่อเห็นชื่อเว็บได้',
  mgLook: 'สีและอีโมจิ', lookNone: 'ไม่มีสี', lookEmoji: 'ตั้งอีโมจิ…', lookEmojiClear: 'เอาอีโมจิออก', promptEmoji: 'พิมพ์อีโมจิ 1 ตัว (เว้นว่างไว้เพื่อเอาออก)', lookNames: ['น้ำเงิน', 'แดง', 'ส้ม', 'เหลือง', 'เขียว', 'ฟ้าอมเขียว', 'ม่วง', 'ชมพู'],
  emptyTitle: 'ยังไม่มีแท็บที่เก็บไว้', emptySub: 'เก็บแท็บที่เปิดค้างไว้ แล้วเปิดกลับมาได้ทุกเมื่อ แรมจะว่างขึ้นทันที', emptyStash: 'เก็บแท็บตอนนี้', emptyImport: 'นำเข้าจากที่อื่น', emptyHint: 'หรือกด',
  empty: 'ยังไม่มีแท็บที่เก็บไว้ กดไอคอน Tabroost บนแถบเครื่องมือ (หรือ Alt+Shift+S) เพื่อเก็บแท็บของหน้าต่างนี้ไว้ในรายการ',
  noMatch: 'ไม่พบแท็บที่ตรงกับคำค้น ลองพิมพ์คำอื่น หรือพิมพ์ให้สั้นลง',
  tabsCount: (n) => `${n} แท็บ`,
  windowsBadge: (n) => `${n} หน้าต่าง`,
  windowN: (n) => `หน้าต่าง ${n}`,
  untitled: 'ตั้งชื่อชุดแท็บ…',
  groupTitleLabel: 'ชื่อชุดแท็บ',
  openGroup: 'เปิดทั้งหมด',
  openSession: 'เปิดชุดแท็บนี้',
  openOneWindow: 'เปิดในหน้าต่างเดียว',
  newWindow: 'หน้าต่างใหม่',
  star: 'ติดดาว',
  lock: 'ล็อก',
  del: 'ลบ',
  more: 'เพิ่มเติม',
  menuCopyGroup: 'คัดลอกชุดแท็บนี้เป็นข้อความ (รูปแบบ OneTab)',
  menuRefreshSession: 'รีเฟรชแท็บของชุดนี้ที่เปิดอยู่',
  expand: 'แสดงรายการ',
  collapse: 'ซ่อนรายการ',
  removeItem: 'ลบแท็บนี้ออกจากรายการ',
  confirmMany: (n) => `จะเปิด ${n} แท็บ อาจใช้เวลาสักครู่ ต้องการเปิดหรือไม่?`,
  confirmEmptyTrash: 'ลบทุกอย่างในถังขยะถาวร? ลบแล้วเอากลับมาไม่ได้',
  confirmPurge: 'ลบชุดแท็บนี้ถาวร? ลบแล้วเอากลับมาไม่ได้',
  deleted: 'ย้ายไปถังขยะแล้ว',
  undo: 'เลิกทำ',
  restoredToast: (n) => `เปิดแล้ว ${n} แท็บ`,
  restoreFailed: (n) => `เปิดไม่ได้ ${n} แท็บ แท็บเหล่านี้ยังอยู่ในรายการ ลองกดเปิดใหม่อีกครั้ง`,
  locked: 'ชุดแท็บนี้ถูกล็อกไว้ ต้องปลดล็อกก่อนจึงจะลบหรือแก้ไขได้',
  errorPrefix: 'ทำไม่สำเร็จ: ',
  busyRestore: 'ตอนนี้กำลังเปิดแท็บอีกชุดอยู่ รอให้เสร็จหรือกดหยุดก่อน แล้วลองใหม่',
  stashBusy: 'ชุดแท็บนี้ยังปิดแท็บไม่เสร็จ กดหยุดปิดแท็บก่อน แล้วจึงจะเลิกเก็บได้',
  bStar: 'ติดดาว',
  bToday: 'วันนี้',
  bYesterday: 'เมื่อวาน',
  bWeek: 'สัปดาห์นี้',
  bMonth: 'เดือนนี้',
  welcomeTitle: 'ยินดีต้อนรับสู่ Tabroost', aboutLink: 'เกี่ยวกับ · ความเป็นส่วนตัว · เครดิต',
  welcomeBody1: 'กดไอคอนส่วนขยาย (หรือ Alt+Shift+S) เพื่อเก็บแท็บทั้งหมดไว้เป็นรายการ ระบบจะบันทึกแท็บให้ครบก่อน แล้วค่อยๆ ปิดแท็บทีละส่วนตามแรมที่เหลือ',
  welcomeBody2: 'แท็บที่ไม่ได้ใช้นานจะถูก “พัก” ให้อัตโนมัติ แท็บที่พักยังอยู่ในแถบแท็บ แต่ไม่กินแรมจนกว่าจะกดเปิด ปรับได้ในหน้าตั้งค่า',
  welcomeBody3: 'ข้อมูลอยู่ในเครื่องของคุณเท่านั้น และมีสำเนาสำรองอีกชุดไว้ในส่วนขยายเอง ไม่มีการดาวน์โหลดไฟล์เอง ถ้าอยากเก็บไว้นอก Chrome ให้กด “ส่งออกทั้งหมดเป็นไฟล์” ในหน้าตั้งค่า ระวัง: ถ้าถอนการติดตั้งส่วนขยาย ข้อมูลทั้งหมดจะหายไป',
  gotIt: 'เข้าใจแล้ว',
  exportNdjson: 'ส่งออกทั้งหมดเป็นไฟล์',
  exportOneTab: 'ส่งออกเป็นข้อความ OneTab',
  copyOneTab: 'คัดลอกเป็นข้อความ OneTab',
  copied: 'คัดลอกแล้ว',
  copyFailed: 'คัดลอกไม่สำเร็จ ลองใหม่ หรือใช้ปุ่มส่งออกเป็นไฟล์แทน',
  copyTooBig: 'ข้อมูลเยอะเกินกว่าจะคัดลอกได้ ใช้ปุ่ม “ส่งออกทั้งหมดเป็นไฟล์” แทน',
  nothingToExport: 'ยังไม่มีแท็บให้ส่งออก',
  exporting: (n) => `กำลังสร้างไฟล์… ${n} แท็บ`,
  exported: (n) => `สร้างไฟล์แล้ว ${n} แท็บ`,
  importTitle: 'นำเข้า',
  importFile: 'เลือกไฟล์ (.ndjson / .gz / .json / .txt)',
  importPh: 'วางข้อความจาก OneTab (ลิงก์ | ชื่อ) หรือข้อความจากไฟล์สำรองของส่วนขยายนี้ที่นี่',
  importBtn: 'นำเข้า',
  importing: (n) => `กำลังนำเข้า… ${n} แท็บ`,
  importResult: (x, y, z) => `นำเข้าแล้ว ${x} แท็บ ใน ${y} ชุดแท็บ · ข้าม ${z} (ซ้ำหรือใช้ไม่ได้)`,
  sIconAction: 'เมื่อกดไอคอนบนแถบเครื่องมือ',
  iaStash: 'เก็บแท็บทันที (ไม่ถามก่อน)',
  iaPopup: 'เปิดหน้าต่างเล็กให้เลือกก่อน',
  sIconScope: 'ไอคอนและ Alt+Shift+S จะเก็บแท็บของ',
  isWindow: 'หน้าต่างนี้เท่านั้น',
  isAll: 'ทุกหน้าต่าง',
  sGrouping: 'ถ้าเก็บหลายหน้าต่างพร้อมกัน',
  sgWindow: 'แยกเป็นชุดแท็บละหน้าต่าง',
  sgSession: 'รวมทุกหน้าต่างเป็นชุดแท็บเดียว',
  ipTitle: 'หน้าภายในของ Chrome (เช่น chrome://settings)',
  ipHelp: 'หน้าพวกนี้บางหน้าเปิดกลับจากรายการไม่ได้ แนะนำให้เลือก “เก็บไว้ในรายการ” จะได้ไม่ลืมว่าเคยเปิดอะไร ส่วน “ปิดทิ้ง” จะปิดโดยไม่จำไว้ (หน้าแท็บใหม่และหน้าว่างจะปิดทิ้งเสมอ)',
  ipSave: 'เก็บไว้ในรายการ',
  ipClose: 'ปิดทิ้ง ไม่เก็บ',
  dupTitle: 'แท็บซ้ำ',
  sCloseDup: 'ปิดแท็บที่ซ้ำกัน',
  cdOff: 'ไม่ปิดให้',
  cdOnStash: 'เฉพาะตอนกดเก็บแท็บ',
  cdAuto: 'ปิดให้เองเงียบๆ เป็นระยะ',
  sDupMin: 'ตรวจแท็บซ้ำทุก',
  sDupUtm: 'ถือว่าเป็นหน้าเดียวกัน แม้ลิงก์ต่างกันแค่รหัสโฆษณา (utm_…)',
  sDupUtmD: 'เช่น example.com/a?utm_source=fb กับ example.com/a จะนับเป็นหน้าเดียวกัน ใช้ตอนตรวจแท็บซ้ำและตอนตัดลิงก์ซ้ำ',
  sDupUtmTip: 'utm_… คือส่วนท้ายลิงก์ที่ใช้นับว่าคนเข้ามาจากโฆษณาหรือโพสต์ไหน เนื้อหาหน้าเว็บเหมือนกัน ถ้าปิดไว้ จะนับว่าเป็นคนละลิงก์',
  dupNow: 'ปิดแท็บซ้ำตอนนี้',
  cleanAll: 'จัดระเบียบแท็บตอนนี้',
  dupCount: (n) => `ปิดแท็บซ้ำไปแล้ว ${n} แท็บ`,
  dupLogTitle: 'แท็บซ้ำที่ปิดไปล่าสุด (เปิดกลับได้)',
  dupOpen: 'เปิดกลับ',
  dupOpenAll: 'เปิดกลับทั้งหมด',
  dupClear: 'ล้างรายการนี้',
  dupDone: (n, b) => (n ? `ปิดแท็บซ้ำแล้ว ${n} แท็บ${b ? ` (ข้าม ${b} แท็บที่อาจมีข้อมูลที่ยังไม่ได้บันทึก)` : ''}` : 'ไม่พบแท็บซ้ำ'),
  cleanConfirm: (s) => `จัดระเบียบแท็บตอนนี้ จะทำดังนี้\n• ปิดแท็บที่ซ้ำกัน ${s.duplicates} แท็บ (เปิดกลับได้จากรายการ “แท็บซ้ำที่ปิดไปล่าสุด”)\n• หน้าภายในของ Chrome: ปิดทิ้ง ${s.internalClose} แท็บ · เก็บไว้ในรายการแล้วปิด ${s.internalSave} แท็บ\n• พักแท็บที่ไม่ได้ใช้ ${s.idle} แท็บ (ยังอยู่ในแถบแท็บ กดแล้วจะโหลดใหม่)\n\nแท็บทั่วไปที่คุณใช้อยู่จะไม่ถูกปิด ต้องการทำต่อหรือไม่?`,
  cleanNothing: 'ไม่มีอะไรต้องจัดระเบียบ',
  cleanDone: (r) => `จัดระเบียบแล้ว: ปิดแท็บซ้ำ ${r.duplicates} · ปิดหน้าภายในของ Chrome ${r.internalClosed} · เก็บหน้าภายในไว้ในรายการ ${r.internalSaved}`,
  suspendTitle: 'พักแท็บอัตโนมัติ',
  sAutoSuspend: 'พักแท็บที่ไม่ได้ใช้ให้อัตโนมัติ',
  sSuspendAfter: 'พักเมื่อไม่ได้ใช้นาน',
  sMediaProtect: 'ไม่พักแท็บที่กำลังเล่นเสียงหรือวิดีโอ', sMediaProtectD: 'ดูจากว่ากำลังเล่นอยู่จริงหรือไม่ ไม่ใช่ดูจากชื่อเว็บ แท็บ YouTube ที่หยุดเล่นอยู่ยังถูกพักตามปกติ',
  sMediaGrace: 'เวลาป้องกันหลังหยุดเล่น', sMediaGraceD: 'เผื่อกดหยุดไว้แล้วกลับมาดูต่อ ในช่วงนี้แท็บจะไม่ถูกพัก แนะนำ 30 นาที ถ้ามักพักนานๆ ให้เพิ่มเป็น 1–2 ชั่วโมง',
  sMediaEnded: 'พักแท็บที่เล่นจบแล้วหลัง', sMediaEndedD: 'เมื่อวิดีโอหรือเพลงเล่นจนจบ จะพักแท็บนี้ได้หลังผ่านเวลานี้ เลือก “ทันที” = พักได้เลย',
  sStartupDiscard: 'พักแท็บเบื้องหลัง 1 นาทีหลังเปิด Chrome',
  sStartupDiscardD: 'แท็บที่ยังไม่ได้ดูจะยังไม่โหลดจนกว่าจะกดเข้าไป ช่วยให้เปิด Chrome แล้วเครื่องไม่อืด',
  sWhitelist: 'เว็บที่ไม่ต้องพัก (บรรทัดละหนึ่งเว็บ)',
  sRestoreRemoves: 'เปิดแล้วเอาออกจากรายการ',
  sDedupe: 'ไม่เก็บแท็บซ้ำ',
  sDedupeD: 'ถ้าเปิดหน้าเดียวกันไว้ 3 แท็บ จะเก็บไว้แค่ 1 แท็บ',
  sKeepTabGroups: 'จำกลุ่มแท็บของ Chrome (กลุ่มที่มีสี)',
  sCloseOwnPages: 'ปิดหน้ารายการเก่าของส่วนขยายนี้ แล้วเปิดหน้ารายการใหม่เพียงหน้าเดียว',
  sShowFavicons: 'แสดงไอคอนเล็กของแต่ละเว็บหน้าชื่อแท็บ',
  econMode: 'โหมดประหยัดแรม',
  tgUntitled: '(ไม่มีชื่อ)',
  openAsTabGroup: 'เปิดกลับเป็นกลุ่มแท็บ', splitTip: 'เปิดคู่กันแบบแบ่งหน้าจอ',
  tgCollapsed: 'ย่ออยู่',
  sAutoStash: 'เก็บแท็บที่ไม่ได้ใช้นานให้อัตโนมัติ',
  sRestoreChunk: 'เปิดทีละกี่แท็บ',
  sRestoreMode: 'วิธีเปิดแท็บกลับ',
  rmAuto: 'อัตโนมัติ (แนะนำ)',
  rmSeq: 'ทีละแท็บ (เบา แต่ช้า)',
  rmFast: 'เป็นชุดๆ (เร็ว)',
  rmLoadAll: 'โหลดทุกแท็บเลย (กินแรมมาก)',
  rmWarn: 'แนะนำ “อัตโนมัติ” ซึ่งดูแรมที่เหลือแล้วปรับให้เอง “ทีละแท็บ” เบาเครื่องที่สุดแต่ช้า “เป็นชุดๆ” เร็วและยังพักแท็บทันที ส่วน “โหลดทุกแท็บเลย” จะโหลดทุกหน้าพร้อมกัน แท็บหนักๆ 100 แท็บอาจกินแรมหลาย GB จนเครื่องค้าง',
  sDiscardOnRestore: 'พักแท็บทันทีหลังเปิดกลับ (โหลดตอนกดดู)',
  sDiscardOnRestoreD: 'เช่น เปิดกลับ 100 แท็บ จะไม่โหลดพร้อมกันทั้งหมด แต่ละแท็บจะโหลดตอนคุณกดเข้าไปดู จึงประหยัดแรม',
  sRefreshRediscard: 'รีเฟรชแล้วพักแท็บต่อ (ได้หน้าใหม่ แรมไม่เพิ่ม)',
  sRefreshRediscardD: 'โหลดหน้าใหม่ให้ได้เนื้อหาล่าสุด พอโหลดเสร็จจะพักแท็บอีกครั้ง จึงไม่กินแรมค้างไว้',
  refreshAll: 'รีเฟรชทุกแท็บในหน้าต่างนี้',
  refreshText: (d, t, s, why) => (why === 'memory' ? `แรมเหลือน้อย จึงหยุดรีเฟรชชั่วคราว ${d}/${t}` : `กำลังรีเฟรช ${d}/${t}${s ? ` · ข้าม ${s}` : ''}`),
  refreshNone: 'ไม่มีแท็บที่ต้องรีเฟรช',
  refreshStarted: (n) => `เริ่มรีเฟรช ${n} แท็บแล้ว (ทำอยู่เบื้องหลัง ไม่รบกวนแท็บที่คุณใช้อยู่)`,
  refreshDone: (t, s, w) => `รีเฟรชแล้ว ${t - s} แท็บ${s ? ` · ข้าม ${s} แท็บ` + skipWhy(w, 'th') : ''}`,
  refreshNoAccess: (n) => `ข้าม ${n} แท็บที่เปิดอยู่ เพราะยังไม่ได้อนุญาตให้ตรวจฟอร์มค้างก่อนรีเฟรช (เปิดได้ในหน้าตั้งค่า)`,
  refreshCancel: 'ยกเลิก',
  // navigation / toolbar
  navAll: 'ทั้งหมด', navPinned: 'ปักหมุด', navStarred: 'ติดดาว', navPending: 'งานค้าง', navCats: 'หมวดหมู่', navUncat: 'ยังไม่จัดหมวด',
  navArchived: 'คลัง', navTrash: 'ถังขยะ', catAdd: 'เพิ่มหมวดหมู่', menu: 'เมนู', expandAll: 'ขยายทั้งหมด', collapseAll: 'ยุบทั้งหมด',
  flatBtn: 'ทุกแท็บรวมกัน', flatTip: 'ดูทุกแท็บจากทุกชุดรวมเป็นรายการเดียว', flatTipOn: 'กลับไปดูแยกเป็นชุดแท็บ', flatHead: 'เรียงทุกแท็บตาม',
  flatOpts: { 'stash:desc': 'วันที่เก็บ: ใหม่ไปเก่า', 'stash:asc': 'วันที่เก็บ: เก่าไปใหม่', 'title:asc': 'ชื่อ ก → ฮ', 'title:desc': 'ชื่อ ฮ → ก', 'site:asc': 'เว็บไซต์ A → Z', 'site:desc': 'เว็บไซต์ Z → A', 'visited:desc': 'เวลาที่เปิดดู: ล่าสุดก่อน', 'visited:asc': 'เวลาที่เปิดดู: เก่าสุดก่อน' },
  flatCount: (n) => `${n.toLocaleString('th-TH')} แท็บ`,
  viewBtn: 'เรียง / จัดกลุ่ม', filterBtn: 'ตัวกรอง',
  viewTitles: { snaps: 'กู้คืนแท็บที่หาย', all: 'ทั้งหมด', pinned: 'ปักหมุด', starred: 'ติดดาว', pending: 'งานค้าง', uncat: 'ยังไม่จัดหมวด', stale: 'ไม่ได้ใช้นาน', archived: 'คลัง', trash: 'ถังขยะ', settings: 'ตั้งค่า', dash: 'แดชบอร์ด' },
  // view menu
  vmSort: 'เรียงชุดแท็บตาม', vmGroup: 'จัดกลุ่มตาม', vmSlot: 'ช่วงเวลา', vmItems: 'เรียงแท็บในชุด', vmOther: 'อื่นๆ', vmStarredFirst: 'ติดดาวขึ้นก่อน', vmDensity: 'แถวกะทัดรัด',
  sorts: { created: 'วันที่เก็บ (ใหม่สุดก่อน)', createdAsc: 'วันที่เก็บ (เก่าสุดก่อน)', mtime: 'แก้ไขล่าสุด', lastRestored: 'เปิดกลับล่าสุด', lastUsed: 'ใช้ล่าสุด (ใช้ล่าสุดก่อน)', openedOld: 'เปิดแท็บไว้นานสุดก่อน', restoredMost: 'เปิดจากรายการบ่อยสุด', title: 'ชื่อ ก→ฮ / A→Z', count: 'จำนวนแท็บ (มากสุดก่อน)', sites: 'จำนวนเว็บไซต์', manual: 'เรียงเอง (ลากวาง)' },
  groupbys: { calendar: 'วันที่ (วันนี้ เมื่อวาน เดือนนี้)', slot: 'ช่วงเวลาที่เก็บซ้ำๆ (เช่น ทุกเช้าวันจันทร์)', site: 'เว็บไซต์', tabgroup: 'กลุ่มแท็บของ Chrome (กลุ่มสี)', count: 'จำนวนแท็บ', category: 'หมวดหมู่', idle: 'ไม่ได้ใช้มานานแค่ไหน', saved: 'เก็บมานานแค่ไหน', none: 'ไม่จัดกลุ่ม' },
  slots: { wdHour: 'วัน + ชั่วโมง', hour: 'ชั่วโมงของวัน', weekday: 'วันในสัปดาห์', dom: 'วันที่ของเดือน', partOfDay: 'ช่วงของวัน (เช้า บ่าย เย็น)' },
  itemSorts: { stash: 'ตามลำดับที่เก็บ', title: 'ชื่อ', site: 'เว็บไซต์', visited: 'เวลาที่เปิดดู', lastUsed: 'ใช้ล่าสุด', opened: 'เวลาที่เปิดแท็บ', idleMost: 'ไม่ได้ใช้ก่อนเก็บนานสุด', lifeMost: 'เปิดค้างนานสุด' },
  // filters
  fSites: 'เว็บไซต์', fSitesPh: 'พิมพ์ชื่อเว็บไซต์…', fCats: 'หมวดหมู่', fTgs: 'กลุ่มแท็บของ Chrome', fDates: 'ช่วงวันที่', fFlags: 'สถานะ', fClear: 'ล้างตัวกรอง',
  fBasisActive: 'ใช้งานล่าสุด', fDateToday: 'วันนี้', fDate7: '7 วันล่าสุด', fDate30: '30 วันล่าสุด', fDateYear: 'ปีนี้', fFrom: 'ตั้งแต่', fTo: 'ถึง',
  flags: { starred: 'ติดดาว', locked: 'ล็อก', pending: 'งานค้าง', archived: 'อยู่ในคลัง', pinned: 'ปักหมุด', named: 'ตั้งชื่อแล้ว', saved7: 'เก็บเกิน 7 วัน', unused30: 'ไม่ได้ใช้เกิน 30 วัน', open7: 'เปิดค้างเกิน 7 วัน' },
  filterCount: (n, m) => `พบ ${n} แท็บ ใน ${m} ชุดแท็บ`,
  indexing: (p) => `กำลังจัดระเบียบรายชื่อเว็บไซต์ ${p}% เรียงหรือกรองตามเว็บไซต์ได้เมื่อเสร็จ`,
  // group menu
  mgOpen: 'เปิด', palLabel: 'ค้นหาคำสั่งและชุดแท็บ', palPh: 'พิมพ์คำสั่งหรือชื่อชุดแท็บ…', palActions: 'คำสั่ง', palSets: 'ชุดแท็บ', palEmpty: 'ไม่พบ', palStash: 'เก็บทุกหน้าต่างตอนนี้', palSettings: 'ตั้งค่า', celebrate: (n, ram) => `เก็บ ${n} แท็บ · คืนแรมประมาณ ${ram}`, sCelebrate: 'แจ้งเมื่อเก็บแท็บจำนวนมาก (20 แท็บขึ้นไป)', mPrint: 'พิมพ์ชุดนี้ (ชื่อและลิงก์)', mgCopy: 'คัดลอก', mgEdit: 'แก้ไข', mgState: 'สถานะ', mgOrganise: 'จัดระเบียบ',
  mRestoreNew: 'เปิดในหน้าต่างใหม่', mRestoreHere: 'เปิดในหน้าต่างนี้', mRestoreIncog: 'เปิดในหน้าต่างไม่ระบุตัวตน', mAsTabGroup: 'เปิดเป็นกลุ่มแท็บ',
  cfUrlTitle: 'ลิงก์ | ชื่อ', cfTitleUrl: 'ชื่อ | ลิงก์', cfUrl: 'เฉพาะลิงก์', cfMarkdown: 'Markdown', cfRich: 'ข้อความมีลิงก์ (วางในเอกสารได้)',
  mRename: 'เปลี่ยนชื่อ', mNote: 'เพิ่มบันทึก', mDedupe: 'ลบแท็บซ้ำในชุดนี้', mImportHere: 'นำเข้าลิงก์มาไว้ในชุดนี้',
  mStar: 'ติดดาว', mLock: 'ล็อก (กันลบโดยไม่ตั้งใจ)', mPin: 'ปักหมุดไว้บนสุด', mPending: 'ทำเครื่องหมายเป็นงานค้าง', mArchive: 'ย้ายเข้าคลัง', mSync: 'ซิงค์ชุดนี้ไปเครื่องอื่น', mMoveCat: 'ย้ายไปหมวดหมู่…', mTrash: 'ย้ายไปถังขยะ',
  syncBtnOff: 'ซิงค์ชุดแท็บนี้ไปเครื่องอื่นเลย', syncBtnNone: 'ซิงค์ระหว่างเครื่อง (ยังไม่ได้เปิดใช้ กดเพื่อตั้งค่า)', syncBtnScope: 'ซิงค์อยู่แล้วตามขอบเขตที่ตั้งไว้ กดเพื่อดูสถานะ', syncBtnOn: 'ชุดแท็บนี้ซิงค์อยู่ กดเพื่อดูสถานะ',
  syncNeedEnable: 'ต้องเปิดซิงค์ระหว่างเครื่องก่อน (ตั้งรหัสผ่านสำหรับซิงค์) จึงจะส่งชุดแท็บไปเครื่องอื่นได้ ไปที่ ตั้งค่า > ซิงค์ระหว่างเครื่อง', syncStarted: 'กำลังส่งชุดแท็บนี้ไปเครื่องอื่น…',
  syncPopTitle: 'ซิงค์ชุดแท็บนี้', syncSt: { ok: 'ซิงค์แล้ว', busy: 'กำลังส่ง หรือรอคิว', bad: 'มีปัญหา', off: 'ยังไม่ซิงค์' }, syncByScope: 'ซิงค์อยู่แล้วตามขอบเขตที่ตั้งไว้', syncLast: (t) => 'ซิงค์ล่าสุด ' + t, syncNever: 'ยังไม่เคยซิงค์',
  syncStop: 'หยุดซิงค์ชุดนี้', syncForce: 'ส่งใหม่ทั้งชุด', syncPushNow: 'ซิงค์ตอนนี้',
  mOn: (x) => `${x} ✓`,
  promptRename: 'ชื่อชุดแท็บ', promptNote: 'บันทึกของชุดแท็บนี้', promptCat: 'ชื่อหมวดหมู่', promptImport: 'วางลิงก์ (บรรทัดละหนึ่งลิงก์ หรือข้อความรูปแบบ OneTab)',
  catRename: 'เปลี่ยนชื่อ', catColor: 'เปลี่ยนสี', catDelete: 'ลบหมวดหมู่', catNone: 'ไม่มีหมวดหมู่', catNew: 'สร้างหมวดหมู่ใหม่…',
  catMoveUp: 'ย้ายขึ้น', catMoveDown: 'ย้ายลง',
  catMoved: (name, pos, total) => `ย้าย “${name}” ไปลำดับที่ ${pos} จาก ${total}`,
  catReorderHint: 'ลากเพื่อเรียงลำดับ หรือกด Alt + ลูกศรขึ้น/ลง',
  catDeleted: 'ลบหมวดหมู่แล้ว ชุดแท็บในหมวดนี้ยังอยู่ครบ (ย้ายไปอยู่ใน “ยังไม่จัดหมวด”)', moved: (n) => `ย้าย ${n} ชุดแท็บแล้ว`,
  incogHint: 'ต้องเปิด “อนุญาตในโหมดไม่ระบุตัวตน” ให้ส่วนขยายนี้ก่อน ไปที่ chrome://extensions แล้วเลือกส่วนขยายนี้',
  dedupeDone: (n) => (n ? `ลบแท็บซ้ำ ${n} แท็บ` : 'ไม่มีแท็บซ้ำ'),
  importedN: (n) => `นำเข้าแล้ว ${n} แท็บ`,
  noteOf: (t) => `บันทึก: ${t}`,
  // settings sections / labels
  sLockNav: 'รหัสผ่านและความเป็นส่วนตัว',
  sAppearance: 'หน้าตา', sStoring: 'การเก็บแท็บ', sOpening: 'การเปิดแท็บกลับ', sOrganise: 'การจัดระเบียบ', sDeleted: 'ถังขยะและการลบ', sShortcuts: 'ปุ่มลัด', sSync: 'ซิงค์ระหว่างเครื่อง', sBackup: 'สำรองและนำเข้าข้อมูล',
  sLanguage: 'ภาษา', sDensity: 'ขนาดแถว', sUrlDisplay: 'การแสดงลิงก์', sUrlDisplayD: 'ใต้ชื่อแต่ละแท็บ', sHoverActions: 'ปุ่มบนแถว', sHoverActionsD: 'ปุ่มจัดการชุดแท็บ และปุ่ม × ลบแท็บ',
  sIncludePinned: 'เก็บแท็บที่ปักหมุดด้วย', sWarnAudible: 'ถามก่อนเก็บแท็บที่กำลังเล่นเสียง', sExcludeSites: 'เว็บที่ไม่ต้องเก็บ', sExcludeSitesD: 'บรรทัดละหนึ่งเว็บ เช่น mail.google.com แท็บของเว็บเหล่านี้จะถูกปล่อยเปิดไว้ ไม่ถูกเก็บ',
  sSingleRestore: 'เมื่อกดเปิดแท็บเดียว', sSingleRestoreD: 'กด Ctrl/Cmd ค้างไว้ = เปิดโดยไม่เอาออกจากรายการ',
  sGroupRestore: 'เมื่อเปิดทั้งชุดแท็บ', sTitleClick: 'เมื่อกดที่ชื่อชุดแท็บ', sDefaultExpand: 'ชุดแท็บที่ขยายไว้ตอนเปิดหน้านี้',
  sAutoRules: 'จัดหมวดหมู่อัตโนมัติ', sAutoRulesD: 'ใช้ตอนเก็บแท็บ (ปิดไว้ก่อน ต้องเปิดเอง)', sAutoRulesList: 'กฎการจัดหมวด', sAutoRulesListD: 'บรรทัดละหนึ่งกฎ เช่น github.com=งาน หมายถึง แท็บจาก github.com ไปอยู่หมวด “งาน” หรือ contains:youtube=ดูทีหลัง หมายถึง ลิงก์ที่มีคำว่า youtube ไปหมวด “ดูทีหลัง”',
  sCopyFormat: 'รูปแบบเมื่อคัดลอกลิงก์', sTrashDays: 'เก็บของที่ลบไว้นาน', sTrashDaysD: 'ครบกำหนดแล้วจะถูกลบถาวร', openTrash: 'เปิดถังขยะ',
  sShortcutsD: 'เปิดหรือปิดปุ่มลัดของหน้านี้ ส่วนปุ่มลัดของ Chrome ดูสถานะได้ด้านล่าง', sKbMaster: 'ใช้ปุ่มลัดในหน้านี้', sKbMasterD: 'ปุ่ม Esc ปิดเมนูและล้างคำค้นได้เสมอ', sKbSearch: 'ไปที่ช่องค้นหา', sKbPalette: 'เปิดรายการคำสั่ง', sKbUndo: 'เลิกทำการลบครั้งล่าสุด', sKbRename: 'เปลี่ยนชื่อชุดแท็บ', sKbSelect: 'เลือกแถวด้วยแป้นพิมพ์', sKbDelete: 'ลบแถวที่เลือก', sKbGlobal: 'ปุ่มลัดของ Chrome', sKbGlobalD: 'ดูได้อย่างเดียว ต้องเปลี่ยนปุ่มที่หน้าของ Chrome', kbNotSet: 'ยังไม่ตั้ง', sShortcutsBtn: 'ตั้งปุ่มลัดใน Chrome',
  sSyncD: 'ซิงค์ชุดแท็บไปยัง Chrome เครื่องอื่นที่ใช้บัญชี Google เดียวกัน โดยไม่ต้องมีเซิร์ฟเวอร์ ข้อมูลถูกเข้ารหัสก่อนส่งออกจากเครื่อง',
  sSyncD2: 'ข้อมูลที่ซิงค์เก็บเป็นบุ๊กมาร์กที่ไม่ได้ชี้ไปเว็บจริง จึงไม่ทำให้ไอคอนดาวของเว็บใดติดสี',
  oh: { hover: 'แสดงเมื่อเอาเมาส์ชี้', always: 'แสดงตลอด' },
  ud: { none: 'ไม่แสดง', domain: 'ชื่อเว็บ (เช่น github.com)', short: 'แบบย่อ', full: 'แบบเต็ม' },
  dens: { comfortable: 'สบายตา', compact: 'กะทัดรัด' },
  langs: { auto: 'อัตโนมัติ (ตามเบราว์เซอร์)', th: 'ไทย', en: 'English' },
  de: { all: 'ขยายทั้งหมด', newest: 'ขยายเฉพาะ 20 ชุดล่าสุด', none: 'ยุบทั้งหมด' },
  sr: { switch: 'เปิดแล้วสลับไปที่แท็บนั้นทันที', stay: 'เปิดไว้เบื้องหลัง คุณยังอยู่ที่หน้ารายการ' },
  gr: { auto: 'หน้าต่างใหม่ (ถ้าแท็บน้อยเปิดหน้าต่างนี้)', new: 'หน้าต่างใหม่เสมอ', current: 'หน้าต่างนี้' },
  tc: { edit: 'แก้ไขชื่อ', restore: 'เปิดชุดแท็บกลับ' },
  cf: { urlTitle: 'ลิงก์ | ชื่อ', titleUrl: 'ชื่อ | ลิงก์', url: 'เฉพาะลิงก์', markdown: 'Markdown', rich: 'ข้อความจัดรูปแบบ' },
  trashDaysOpts: (n) => (n === 0 ? 'ตลอดไป (ไม่ลบเอง)' : `${n} วัน`),
  trashNote: (d) => (d === 0 ? 'ของที่ลบจะอยู่ตลอดไปจนกว่าจะลบถาวรเอง' : `ของที่ลบจะถูกลบถาวรเองเมื่อครบ ${d} วัน`),
  trashItemsRow2: (when, n, from) => `${when} · แท็บที่ลบ ${n} แท็บ${from ? ' จาก “' + from + '”' : ''}`,
  restoreAllTrash: 'กู้คืนทั้งหมด',
  sTheme: 'โทนสี',
  off: 'ปิด',
  days: (n) => `${n} วัน`,
  themeAuto: 'ตามระบบ', themeTime: 'ตามเวลา (กลางวันสว่าง กลางคืนมืด)', sAccent: 'สีเน้น', accents: { blue: 'น้ำเงิน', teal: 'เขียวน้ำทะเล', green: 'เขียว', orange: 'ส้ม', pink: 'ชมพู', violet: 'ม่วง' },
  themeLight: 'สว่าง',
  themeDark: 'มืด',
  storageUsed: (mb, quota, persisted) => `พื้นที่ที่ใช้: ประมาณ ${mb} MB${quota ? ` จากที่ Chrome ให้ใช้ได้ ${quota} GB` : ''} · ${persisted ? 'Chrome จะไม่ลบข้อมูลนี้เอง' : 'Chrome อาจลบข้อมูลนี้ได้ถ้าพื้นที่ดิสก์ใกล้เต็ม'}`,
  vaultInfo: (g, when) => `สำเนาสำรองในเครื่อง: ${g} ชุดแท็บ${when ? ' · อัปเดตล่าสุด ' + when : ''}`,
  trashTitle: 'ถังขยะ',
  emptyTrash: 'ลบทุกอย่างในถังขยะถาวร',
  restore: 'กู้คืน',
  purge: 'ลบถาวร',
  trashGroupRow: (when, name, n) => `${when} · ${name} · ${n} แท็บ`,
  trashItemsRow: (when, n) => `${when} · แท็บที่ลบ ${n} แท็บ`,
  noTrash: 'ถังขยะว่างอยู่',
  sRestoreRemovesGroup: 'เปิดทั้งชุดแล้วเอาชุดนั้นออกจากรายการ', sRestoreRemovesD: 'ชุดที่เอาออกจะไปอยู่ในถังขยะ (แท็บ “เปิดแล้ว”) กู้คืนกลับมาได้ ข้อมูลไม่หาย',
  sRestoreRemovesItem: 'เปิดทีละแท็บแล้วเอาแท็บนั้นออกจากรายการ', sRestoreRemovesItemD: 'กด Ctrl/Cmd ค้างตอนคลิก = เปิดโดยเก็บแท็บไว้ในรายการเสมอ',
  mOpenKeep: 'เปิด (แท็บยังอยู่ในรายการ)', mOpenRemove: 'เปิด (แล้วเอาออกจากรายการ)',
  mNewKeep: 'เปิดในหน้าต่างใหม่ (แท็บยังอยู่ในรายการ)', mNewRemove: 'เปิดในหน้าต่างใหม่ (แล้วเอาออกจากรายการ)',
  mTgKeep: 'เปิดเป็นกลุ่มแท็บ (แท็บยังอยู่ในรายการ)', mTgRemove: 'เปิดเป็นกลุ่มแท็บ (แล้วเอาออกจากรายการ)',
  openMenuTip: 'ตัวเลือกการเปิด', itemOpenTip: 'คลิก: เปิดแท็บนี้ · Ctrl/Cmd+คลิก: เปิดโดยเก็บแท็บไว้ในรายการ',
  lockedKeeps: 'ชุดแท็บที่ล็อกไว้จะไม่ถูกเอาแท็บออกเมื่อเปิด',
  sTrashDaysDeleted: 'เก็บของที่ฉันลบไว้ในถังขยะนาน', sTrashDaysDeletedD: 'ชุดแท็บหรือแท็บที่คุณลบเอง จะถูกลบถาวรเมื่อครบเวลา แนะนำ 30 วัน (เผลอลบก็ยังกู้ทัน)',
  sTrashDaysOpened: 'เก็บแท็บที่เปิดแล้วถูกเอาออกไว้นาน', sTrashDaysOpenedD: 'แท็บที่หายจากรายการเพราะคุณเปิดไปแล้ว (กู้กลับเข้ารายการได้) แนะนำ 7 วัน',
  trashDaysOpts2: (n) => (n === 0 ? 'ไม่ลบเอง (เก็บตลอดไป)' : `${n} วัน`),
  trTabAll: 'ทั้งหมด', trTabDeleted: 'ที่ฉันลบ', trTabOpened: 'เปิดแล้ว',
  trRecover: 'กู้คืนเข้ารายการ', trOpenAgain: 'เปิดอีกครั้ง', trPurge: 'ลบถาวร', selectAll: 'เลือกทั้งหมด',
  trSelN: (n) => (n ? `เลือกแล้ว ${n} รายการ` : ''),
  trClearType: (label, c) => `ลบถาวรทั้งหมวด · ${label} (${c})`, trClearAll: (c) => `ลบถาวรทั้งหมด (${c})`,
  trClearNow: (label, c) => `ลบถาวรตอนนี้ · ${label} (${c})`,
  trExpires: (d) => (d <= 0 ? 'จะถูกลบถาวรภายในวันนี้' : `จะถูกลบถาวรใน ${d} วัน`), trNever: 'ไม่ลบเอง',
  trSession: (n) => `ชุดแท็บ · ${n} แท็บ`, trTabs: (n, from) => `${n} แท็บ${from ? ' จาก “' + from + '”' : ''}`,
  trBadgeDeleted: 'ฉันลบ', trBadgeOpened: 'เปิดแล้ว',
  trCounts: (s, t) => `${s} ชุดแท็บ · ${t} แท็บ`,
  trConfirmClear: (label, s, t) => `ลบถาวร “${label}”: ${s} ชุดแท็บ และ ${t} แท็บ ลบแล้วเอากลับมาไม่ได้ ต้องการลบหรือไม่?`,
  trConfirmClearAll: (s, t) => `ล้างถังขยะทั้งหมด: ${s} ชุดแท็บ และ ${t} แท็บ จะถูกลบถาวร เอากลับมาไม่ได้ ต้องการล้างหรือไม่?`,
  trConfirmPurge: (n) => `ลบถาวร ${n} รายการที่เลือก? ลบแล้วเอากลับมาไม่ได้`,
  trRecovered: (n) => `กู้คืน ${n} แท็บเข้ารายการแล้ว`, trEmpty: 'ยังไม่มีอะไรในหมวดนี้',
  flatPrep: (p) => `กำลังเตรียมการเรียง… ${p}%`,
  trShowTabs: 'ดูแท็บในรายการนี้', trHideTabs: 'ซ่อนรายการแท็บ', trRange: (a, b, n) => `แท็บที่ ${a}–${b} จาก ${n}`, trPrev: 'ก่อนหน้า', trNext: 'ถัดไป', trNoDetail: 'ไม่มีรายละเอียดแท็บให้แสดง',
  trMore: (n) => `…และอีก ${n} รายการ (ใช้ปุ่ม “ล้างหมวดนี้” หรือกู้คืนทีเดียวทั้งหมวด)`,
  trNote: (a, b) => `ที่ฉันลบ: ${a === 0 ? 'ไม่ลบเอง' : 'ลบถาวรเมื่อครบ ' + a + ' วัน'} · เปิดแล้ว: ${b === 0 ? 'ไม่ลบเอง' : 'ลบถาวรเมื่อครบ ' + b + ' วัน'} (เปลี่ยนได้ในหน้าตั้งค่า)`,
  dangerTitle: 'กู้ข้อมูลจากสำเนาสำรอง',
  dbReset: 'ล้างข้อมูลหลักแล้วกู้จากสำเนาสำรอง',
  dbResetPrompt: 'ใช้เมื่อรายการเสียหายหรือแสดงไม่ถูกต้อง จะล้างข้อมูลหลักแล้วกู้กลับจากสำเนาสำรอง (สำเนาสำรองไม่ถูกลบ)\n\nพิมพ์คำว่า RESET เพื่อยืนยัน',
  oneTabNote: 'นำเข้าจาก OneTab: ใน OneTab เลือก Import / Export แล้วคัดลอกข้อความ นำมาวางในช่องด้านบน แต่ละชุดคั่นด้วยบรรทัดว่าง',
  dbDown: (e) => `เปิดที่เก็บข้อมูลของส่วนขยายไม่ได้ จึงจะไม่ปิดแท็บใดๆ เพื่อความปลอดภัย ลองปิดแล้วเปิด Chrome ใหม่ หรือปิดแล้วเปิดส่วนขยายนี้อีกครั้ง (รายละเอียด: ${e})`,
  retry: 'ลองใหม่',
  vaultMissing: (n) => `พบว่ามี ${n} ชุดแท็บหายไปจากรายการ แต่ยังมีสำเนาสำรองอยู่`,
  vaultRecover: 'กู้คืนจากสำเนาสำรอง',
  vaultRecovered: (g, i) => `กู้คืนแล้ว ${g} ชุดแท็บ (${i} แท็บ)`,
  migError: (e) => `ย้ายข้อมูลจากเวอร์ชันเก่าไม่สำเร็จ (${e}) ข้อมูลเก่ายังอยู่ครบ ไม่หาย และจะลองใหม่ให้เมื่อเปิด Chrome ครั้งหน้า`,
  drainWriting: (d, t) => `กำลังบันทึกแท็บ ${d}/${t} ยังไม่มีแท็บถูกปิด`,
  drainText: (c, t, d, s, lvl, free) => `กำลังปิดแท็บ ${c}/${t} · แรม${lvl}${free == null ? '' : ` (ว่าง ${free}%)`}${s ? ` · ข้าม ${s}` : ''}`,
  drainPausedText: (c, t, why) => `หยุดปิดแท็บชั่วคราว (${why}) ${c}/${t}`,
  drainWhyUser: 'คุณกดหยุด',
  drainSlow: 'ช้า… กำลังรอ Chrome ตอบ',
  closeLeftovers: 'ปิดแท็บที่เหลือ',
  autoTitle: (g) => (g.windowCount > 1 ? `${g.windowCount} หน้าต่าง · ` : '') + `${g.count} แท็บ`,
  chipTabs: 'จำนวนแท็บ', chipWins: 'จำนวนหน้าต่าง', editTitle: 'เปลี่ยนชื่อ (F2)', stackTip: (hosts, n) => `เว็บไซต์หลัก: ${hosts}${n > 0 ? ` และอีก ${n}` : ''}`,
  // item sort split button
  isortTip: (label, dir) => `เรียงแท็บในชุดนี้: ${label} ${dir === 'asc' ? '↑' : '↓'} คลิกเพื่อสลับทิศทาง`,
  isortMenuTip: 'ตัวเลือกการเรียงแท็บในชุดนี้',
  isortDirHead: 'ทิศทาง', isortAsc: 'น้อย → มาก / ก → ฮ (↑)', isortDesc: 'มาก → น้อย / ฮ → ก (↓)',
  isortReset: 'กลับเป็นลำดับตอนเก็บ', isortAll: 'ใช้การเรียงนี้กับทุกชุดแท็บ',
  sessDirTip: (label, dir) => `เรียงชุดแท็บ: ${label} ${dir === 'up' ? '↑' : '↓'} คลิกเพื่อสลับทิศทาง`,
  // crash recovery
  navSnaps: 'กู้คืนแท็บที่หาย', snapTitle: 'กู้คืนแท็บที่หาย', rcTitle: 'แท็บที่เพิ่งปิดไป (จากประวัติของ Chrome เอง)', rcOpen: 'เปิดกลับ', rcBanner: (n) => `Chrome ยังจำสิ่งที่ปิดไปล่าสุดได้อีก ${n} รายการ`, rcWindow: (n) => `หน้าต่าง ${n} แท็บ`, snapNow: 'บันทึกตอนนี้',
  snapNote: 'ส่วนขยายจดไว้เป็นระยะว่าตอนนี้เปิดแท็บอะไรอยู่ (ใช้แรมและพื้นที่น้อยมาก) เผื่อ Chrome หรือเครื่องดับกะทันหัน คุณเลือกกู้คืนแท็บจากช่วงเวลาที่ผ่านมาได้ที่นี่',
  snapBanner: (n) => `Chrome ปิดกะทันหัน พบแท็บที่หายไป ${n} แท็บ กู้คืนได้`, snapView: 'ดูและกู้คืน', snapDismiss: 'ไม่ต้อง', snapDel: 'ลบ', snapEmpty: 'ยังไม่มีรายการที่จดไว้',
  snapSelAll: 'เลือกทั้งหมด', snapSelNone: 'ไม่เลือกเลย', snapShowAll: 'แสดงทุกแท็บที่จดไว้ (รวมที่ยังเปิดอยู่)', snapCancel: 'ปิด', snapGo: (n) => `กู้คืน ${n} แท็บ`,
  snapDegraded: '⚠ มีแท็บน้อยผิดปกติ (Chrome เพิ่งปิดกะทันหันหรือเปล่า?)',
  snapKind: { auto: 'จดอัตโนมัติ', 'pre-close': 'จดก่อนปิดแท็บ', manual: 'จดเอง' },
  snapDlgTitle: (ts) => `กู้คืนแท็บจากเวลา ${fmtDate(ts)}`, snapDlgSub: (m, t) => `ตอนนั้นมี ${t} แท็บ ตอนนี้ขาดไป ${m} แท็บ แท็บที่เลือกจะเปิดเบื้องหลังและถูกพักไว้ก่อน (ไม่กินแรมจนกว่าจะกดดู)`,
  snapRestoreTitle: 'กู้คืนแท็บที่หาย', snapQueued: 'เริ่มกู้คืนแล้ว (ทำเบื้องหลัง)',
  sAutoSnapshot: 'จดแท็บที่เปิดอยู่ไว้ เผื่อต้องกู้คืน', sAutoSnapshotD: 'ช่วยได้เมื่อ Chrome หรือเครื่องดับกะทันหัน ใช้แรมน้อยมาก', sSnapshotMin: 'จดทุก',
  leftoversDone: (c, l) => (l ? `ปิดได้ ${c} แท็บ · ยังเหลือ ${l} แท็บ (บางหน้าอาจถามก่อนปิด ให้กดยืนยันที่แท็บนั้น)` : `ปิดแท็บที่เหลือแล้ว ${c} แท็บ`),
  drainWhyStalled: 'Chrome ไม่ตอบสนอง',
  levels: { healthy: 'ยังพอ', low: 'เริ่มน้อย จึงปิดช้าลง', critical: 'น้อย จึงปิดช้ามาก', severe: 'น้อยมาก จึงปิดช้าที่สุด' },
  drainPause: 'หยุดชั่วคราว',
  drainResume: 'ทำต่อ',
  drainStop: 'หยุดปิดแท็บ (แท็บที่เก็บแล้วยังอยู่ในรายการ)',
  drainStopDrop: 'หยุด และเอาแท็บที่ยังไม่ได้ปิดออกจากรายการ',
  restartText: (n) => `ก่อนหน้านี้ Chrome ปิดแท็บยังไม่เสร็จ เหลืออีก ${n} แท็บที่เก็บไว้แล้วแต่ยังเปิดอยู่`,
  restartContinue: 'ปิดต่อ',
  restartLeave: 'ปล่อยให้เปิดไว้',
  drainDone: (c, s) => `ปิดแท็บแล้ว ${c} แท็บ${s ? ` · ข้าม ${s}` : ''}`,
  skippedList: (n) => `ข้าม ${n} แท็บที่ปิดไม่ได้หรือเปลี่ยนหน้าไปแล้ว แท็บเหล่านั้นยังเปิดอยู่ และเก็บไว้ในรายการแล้ว`,
  jobText: (d, t, why, interrupted) => (interrupted ? `การเปิดแท็บหยุดกลางคัน ${d}/${t} กด “เปิดรอบต่อไป” เพื่อทำต่อ` : why === 'memory' ? `แรมเหลือน้อย จึงหยุดเปิดแท็บชั่วคราว ${d}/${t}` : why === 'drain' ? `รอให้ปิดแท็บเสร็จก่อน ${d}/${t}` : `เปิดแล้ว ${d}/${t}`),
  jobContinue: 'เปิดรอบต่อไป',
  jobRunAll: 'เปิดที่เหลือทั้งหมด',
  jobStop: 'หยุด',
  errs: { notfound: 'ไม่พบรายการนี้แล้ว (อาจถูกลบหรือย้ายไปแล้ว) ลองรีเฟรชหน้านี้', nowindow: 'ไม่พบหน้าต่างที่จะทำงานด้วย ลองคลิกที่หน้าต่าง Chrome แล้วทำใหม่', gone: 'ชุดแท็บนี้ไม่อยู่ในรายการแล้ว ลองรีเฟรชหน้านี้', nothing: 'ไม่มีอะไรให้ทำ', 'db-unavailable': 'เปิดที่เก็บข้อมูลของส่วนขยายไม่ได้ จึงยังไม่ได้ปิดแท็บใดๆ ลองปิดแล้วเปิด Chrome ใหม่', 'stash-page': 'ไม่สามารถเก็บหน้ารายการนี้เองได้ ให้สลับไปแท็บอื่นแล้วลองใหม่', 'write-failed': 'บันทึกแท็บไม่สำเร็จ แท็บทั้งหมดยังเปิดอยู่ ไม่มีอะไรหาย ลองใหม่อีกครั้ง', nohost: 'ไม่พบชื่อเว็บของแท็บนี้ (อาจเป็นหน้าภายในของ Chrome)' },
  sCloseDupD: 'แท็บที่ถูกปิดไปจะอยู่ในรายการ “แท็บซ้ำที่ปิดไปล่าสุด” ด้านล่าง เปิดกลับได้ ไม่หาย',
  suspendIntro: 'พักแท็บ คือการทำให้แท็บยังอยู่ในแถบแท็บ แต่ไม่กินแรมจนกว่าจะกดเปิด (กดแล้วหน้าจะโหลดใหม่) ข้อมูลที่พิมพ์ค้างไว้ในแท็บอาจหาย แท็บที่กำลังเล่นเสียงหรือวิดีโอจะไม่ถูกพัก',
  sSuspendAfterD: 'เช่น เลือก 20 นาที = แท็บที่ไม่ได้แตะเลย 20 นาทีจะถูกพัก เหมาะกับคนส่วนใหญ่: 20–30 นาที ถ้าเปิดแท็บเยอะมากให้ลองสั้นลง',
  sWhitelistD: 'เช่น meet.google.com แท็บของเว็บเหล่านี้จะไม่ถูกพัก เหมาะกับเว็บที่ต้องเปิดค้างไว้ เช่น ประชุมออนไลน์',
  sKeepTabGroupsD: 'เปิดกลับมาแล้ว แท็บจะกลับไปอยู่ในกลุ่มสีเหมือนเดิม',
  sCloseOwnPagesD: 'กันไม่ให้มีหน้ารายการเปิดค้างอยู่หลายหน้า',
  econTip: 'แรมเหลือน้อย ส่วนขยายจึงทำงานเบาลงชั่วคราว (เช่น ไม่โหลดไอคอนเว็บ) เพื่อไม่ให้เครื่องอืด',
  sAutoStashD: 'เช่น เลือก 7 วัน = แท็บที่ไม่ได้แตะเลย 7 วันจะถูกเก็บเข้ารายการแล้วปิด เลือก “ปิด” ถ้าไม่ต้องการ',
  sRestoreChunkD: 'เปิดชุดใหญ่จะเปิดเป็นรอบๆ รอบละเท่านี้ แนะนำ 100',
  sIncludePinnedD: 'ปกติแท็บที่ปักหมุดไว้ใน Chrome จะถูกข้าม ไม่เก็บและไม่ปิด',
  sWarnAudibleD: 'ปิดอยู่: กดเก็บแล้วเก็บเลย เสียงจะหยุดทันที เปิดตัวเลือกนี้ถ้าอยากให้หน้าต่างเล็ก (popup) ถามก่อนเมื่อมีแท็บเล่นเสียงอยู่',
  sSnapshotMinD: 'แนะนำ 3 นาที ยิ่งถี่ ยิ่งกู้ได้ใกล้เวลาที่หายมากขึ้น',
  mins: (n) => (n >= 60 && n % 60 === 0 ? `${n / 60} ชั่วโมง` : `${n} นาที`),
  minsNow: 'ทันที',
  rec: ' · แนะนำ',
  sTimeDisplay: 'แสดงเวลาในรายการ', sTimeDisplayD: 'เวลาที่ไม่ได้ใช้แท็บ แสดงข้างแต่ละแท็บในรายการ', tdOpts: { none: 'ไม่แสดง', compact: 'ย่อ', full: 'เต็ม' },
  sDateCal: 'รูปแบบปี', calOpts: { auto: 'อัตโนมัติ (ไทย: พ.ศ.)', be: 'พ.ศ.', ce: 'ค.ศ.' },
  sPrivacy: 'สถิติและความเป็นส่วนตัว', sActTrack: 'เก็บสถิติการใช้งาน (ในเครื่องนี้เท่านั้น)', sActTrackD: 'ใช้บอกว่าแท็บไม่ได้ใช้มานานแค่ไหน และแสดงในแดชบอร์ด ข้อมูลอยู่ในเครื่องนี้เท่านั้น ไม่ส่งไปที่ไหน และไม่ซิงค์ไปเครื่องอื่น',
  sPrecise: 'บันทึกเวลาเปิดแท็บแบบแม่นยำ', sPreciseD: 'ใช้พลังงานเพิ่มเล็กน้อย: ทุกครั้งที่เปิดแท็บใหม่ ส่วนขยายจะตื่นขึ้นมาจดเวลา ถ้าปิดไว้ เวลาเปิดจะคลาดเคลื่อนได้ไม่เกินประมาณ 3 นาที',
  sRetention: 'เก็บสถิติไว้นาน', retOpts: { 90: '90 วัน', 180: '180 วัน', 400: '400 วัน · แนะนำ', 730: '2 ปี', 0: 'ไม่จำกัด' },
  sRamCal: 'ปรับค่าประมาณแรมจากการวัดจริง', sRamCalD: (mb, cal) => `ตอนนี้ใช้ประมาณ ${mb} MB ต่อแท็บ${cal ? ' (วัดจากเครื่องนี้)' : ' (ค่าตั้งต้น)'}`, ramResetBtn: 'รีเซ็ต',
  actPurgeBtn: 'ลบข้อมูลสถิติทั้งหมด', actExportBtn: 'ส่งออกสถิติ (JSON)',
  actKept: 'ยังเก็บไว้แม้ปิดสถิติ: เวลาที่เก็บแท็บ วันที่สร้างชุดแท็บ และเวลาที่เปิดชุดแท็บจากรายการครั้งล่าสุด',
  actNot: 'ไม่จดเมื่อปิดสถิติ: ใช้ล่าสุด เปิดเมื่อ สถิติการใช้ และแรมที่ประหยัดได้',
  actNever: 'ไม่เคยเก็บเลย: เนื้อหาในหน้าเว็บ ประวัติการท่องเว็บทั้งหมด เวลาที่ใช้ในแต่ละเว็บไซต์ และสิ่งที่พิมพ์ ไม่มีการส่งข้อมูลออกจากเครื่องนี้',
  actOffTitle: 'ลบข้อมูลสถิติที่เก็บไว้แล้วด้วยไหม', actOffBody: (c) => `ตอนนี้มีสถิติ ${c.days} วัน · ${c.events} เหตุการณ์ · แท็บที่มีข้อมูลเวลา ${c.tracked} แท็บ · แท็บที่กำลังจดเวลาอยู่ ${c.trackingNow} แท็บ`,
  actOffDel: 'ลบเลย', actOffKeep: 'เก็บไว้ แต่หยุดเก็บเพิ่ม', actOffCancel: 'ยกเลิก',
  actPurgeConfirm: 'ลบสถิติการใช้งานที่เก็บไว้ในเครื่องนี้ทั้งหมด? (เวลาใช้ล่าสุด เวลาเปิด สถิติรายวัน) ลบแล้วเอากลับมาไม่ได้', actPurging: (p) => `กำลังลบสถิติ… ${p}%`, actPurged: 'ลบสถิติแล้ว', actExported: 'ส่งออกสถิติแล้ว',
  actBanner: 'แอปเก็บสถิติการใช้งานไว้ในเครื่องนี้เท่านั้น · ปิดได้ในการตั้งค่า',
  actBannerOk: 'เข้าใจแล้ว', navDash: 'แดชบอร์ด', navAbout: 'เกี่ยวกับ', dashFail: 'เปิดแดชบอร์ดไม่สำเร็จ', seeMore: 'ดูเพิ่ม', seeLess: 'ย่อ', vmOtherSort: 'เรียงแบบอื่น', vmOtherGroup: 'จัดกลุ่มแบบอื่น', vmOtherIsort: 'เรียงแบบอื่น', catOthers: (n) => `หมวดอื่น (${n})`, foldMore: (n) => `อีก ${n} เรื่อง · ดูเพิ่ม`, mgOpenOther: 'เปิดแบบอื่น', mgMore: 'เพิ่มเติม', stSets: 'ชุดแท็บ', stTabs: 'แท็บที่เก็บไว้', stSleep: 'กำลังพัก', stRam: 'แรมที่ประหยัด', statTip: 'ดูสรุปทั้งหมดในแดชบอร์ด',
  tmUsed: (d) => `ใช้ล่าสุด ${d}ก่อน`, tmSaved: (d) => `เก็บมา ${d}`, tmOpenFor: (d) => `เปิดค้าง ${d}`, tmApproxTip: 'ประมาณ (อาจเปิดก่อนหน้านั้น)', tmNone: '—',
  chipLastUsed: (d) => `ใช้ล่าสุด ${d}ก่อน`, chipOpened: (n) => `เปิดแล้ว ${n} ครั้ง`,
  hcSaved: 'เก็บเมื่อ', hcLastUsed: 'ใช้ล่าสุด', hcOpened: 'เปิดเมื่อ', hcIdle: 'ไม่ได้ใช้ก่อนเก็บ', hcInList: 'อยู่ในรายการมา', hcCreated: 'สร้างเมื่อ', hcRange: 'ช่วงเวลาที่เปิดแท็บ',
  hcMedIdle: 'ไม่ได้ใช้ก่อนเก็บ (ค่ากลาง)', hcMedLife: 'เปิดค้างนาน (ค่ากลาง)', hcRestored: 'เปิดจากรายการ', hcTimes: (n) => `${n} ครั้ง`, hcLastRestored: 'เปิดจากรายการล่าสุด',
  navStale: 'ไม่ได้ใช้นาน', staleBanner: (n) => `มีประมาณ ${n} แท็บที่ไม่ได้ใช้เกิน 30 วัน`, staleView: 'ดู', staleHide: 'ซ่อน 7 วัน', staleBarOn: (n, m) => `${n} ชุดแท็บที่ไม่ได้ใช้เลยเกิน 30 วัน (${m} แท็บ)`, staleBarOff: (n, m) => `${n} ชุดแท็บที่เก็บไว้นานเกิน 90 วัน (${m} แท็บ)`,
  staleTrash: 'ย้ายไปถังขยะ', staleArchive: 'ย้ายเข้าคลัง', staleTrashConfirm: (n, m) => `ย้าย ${n} ชุดแท็บ (${m} แท็บ) ไปถังขยะ? เอากลับมาได้จากถังขยะ`, staleArchiveConfirm: (n, m) => `ย้าย ${n} ชุดแท็บ (${m} แท็บ) เข้าคลัง?`, staleNeedStats: 'เปิดสถิติการใช้งานเพื่อใช้ตัวกรองนี้',
  sBackupD: 'ส่งออกเก็บไว้เป็นไฟล์สำรองของคุณเอง หรือนำเข้าแท็บจาก OneTab และไฟล์สำรองเดิม แนะนำให้ส่งออกเก็บไว้เป็นระยะ',
  snapReasons: { empty: 'ตอนนี้ยังไม่มีแท็บที่เปิดอยู่ให้บันทึก', off: 'ปิดการจดแท็บอัตโนมัติอยู่', busy: 'กำลังปิดหรือเปิดแท็บอยู่ ลองใหม่เมื่อเสร็จ', ram: 'แรมเหลือน้อยมาก จึงยังไม่บันทึก ลองใหม่ภายหลัง', same: 'แท็บเหมือนครั้งก่อน ไม่ต้องบันทึกซ้ำ' },
};

import {
  DEFAULTS, CONFIRM_MANY, PAGE_ROWS, SEARCH_CAP, SEARCH_MIN, MB_PER_TAB_EST, APPEND_CHUNK,
} from './lib/constants.js';
import {
  classifyUrl, hostOf, fmtDate, fmtStamp, ndjsonHeader, ndjsonGroup, ndjsonItem, oneTabLine, parseNdjsonLine,
  parseOneTab, readLines, validateImportJson,
} from './lib/formats.js';
import * as db from './lib/db.js';
import { getSettings } from './lib/settings.js';
import * as bus from './lib/bus.js';
import { connectSearch } from './lib/searchClient.js';
import { createFavicons, avatarOf } from './lib/favicons.js';
import * as Q from './lib/query.js';
import { createFlat, PAGE as FLAT_PAGE } from './lib/flat.js';
import { gate as lockGate } from './lib/lockui.js';
import * as lockrt from './lib/lockrt.js';
import { mountLockCard } from './lib/lockcard.js';
import { initSelUi } from './lib/selui.js';
import { applyLanguage } from './lib/i18n.js';
import { createPopovers } from './lib/popover.js';
import { mountFilterPanel, rangeLabel } from './lib/filterpanel.js';
import { openPalette } from './lib/palette.js';
import { mountSyncCard, watchSyncStatus, stateLabel, stateTone, setSyncLang } from './lib/syncui.js';
import { initPermsUi, sessionsHint } from './lib/permsui.js';
import { gunzipJson, diffTabs } from './lib/snapfmt.js';
import { fmtAgo } from './lib/time.js';
import { itemToken, relabel, groupChips, itemCard, groupCard } from './lib/rowtime.js';
import { startTicker } from './lib/ticker.js';
import { createHoverCard } from './lib/hovercard.js';
import { applyThemeSettings } from './lib/theme.js';

const $ = (sel) => document.querySelector(sel);

// per-host icon cache (see lib/favicons.js): one icon per host, only for rows in view, never while flinging
// hidden advanced setting favMode ('atlas' | 'img'; mirrored in localStorage so the factory can read it before settings load)
const FAV_MODE = (() => { try { const m = localStorage.getItem('cmrFavModeDev') || localStorage.getItem('cmrFavMode'); return m === 'img' || m === 'atlas' ? m : 'atlas'; } catch { return 'atlas'; } })();
const favs = createFavicons({ onReady: (host) => refreshFavHost(host), mode: FAV_MODE });

// ---------- geometry (fixed heights => O(log n) layout from counts alone) ----------
const DENS = { comfortable: { bucket: 40, group: 56, item: 38, sub: 30 }, compact: { bucket: 36, group: 48, item: 30, sub: 26 } };
const H = { ...DENS.comfortable }; // mirrors --h-* in tokens.css
const RUNS_MAX = 60000; // groups with tab groups and more items than this are listed flat (no sub-headers)
const OVERSCAN = 160; // px of rows kept above/below the viewport
const CACHE_MAX = 4000; // item records kept in memory (sparse LRU)
const POOL_KEEP = { bucket: 2, group: 3, item: 12, sub: 4, note: 2 }; // idle nodes kept per kind (they still count as DOM)

const S = {
  meta: null,
  settings: { ...DEFAULTS },
  groups: [], // rows of the list: sessions (or, group-by tab group, per-section views of them with vk/vsel/vcount)
  ugroups: [], // the same sessions, each once (totals)
  drain: null,
  job: null,
  discarded: 0,
  trash: { groups: [], items: [] },
  query: '',
  searchCtl: null,
  searchTimer: null,
  toastAction: null,
  toastTimer: null,
  syncTimer: null,
  statsTimer: null,
  changed: new Set(),
  dirtyWhileEditing: false,
  dbOk: true,
  initialExpandDone: false,
  menuGid: null,
  allGroups: [], // every non-writing group; S.groups = the filtered + sorted + grouped view of it
  nav: { kind: 'all', cat: null },
  filters: Q.emptyFilters(),
  vs: { ...Q.DEFAULT_VIEW },
  cats: [],
  siteMap: null,
  siteMapLoading: false,
  view: 'list', // 'list' | 'trash' | 'settings'
  seen: new Set(),
  snaps: [],
  snap: null,
  lang: null,
  indexing: null,
  gById: new Map(),
  allowedIds: new Set(),
};

const V = {
  mode: 'groups', // 'groups' | 'search'
  exp: new Set(), // expanded group ids
  tops: new Float64Array(1), // tops[i] = y of group block i; tops[n] = total height
  bucketAt: [], // label or null (a section header precedes group i)
  labels: [], // section labels from lib/query.js partition()
  sorted: new Map(), // gid -> {sig, rows} custom item order (per-session sort)
  sorting: new Set(),
  idxOf: new Map(),
  vIdx: new Map(), // view key (vk or gid) -> block index (a session can appear in several tab-group sections)
  total: 0,
  jump: [], // [{label, idx, n}]
  runs: new Map(), // gid -> {count, segs:[{tg,n,y,itemStart,ws,w}], height} (only groups that own tab groups)
  tgDefs: new Map(), // gid -> {list, map} lookup of g.tabGroups by index
  cache: new Map(), // gid -> Map(pageIdx -> {rows, used})
  pending: new Set(),
  cachedRecords: 0,
  tick: 0,
  live: new Map(), // key -> node
  free: { bucket: [], group: [], item: [], sub: [], note: [] },
  hits: [], // legacy name kept for tests: the virtual rows of the search view (see V.srows)
  srows: [], // search view rows: {t:'hit', rec, fuzzy, hl, v} | {t:'sep'} | {t:'more'}
  raf: 0,
  favTimer: 0,
  favResume: 0,
  lastT: 0,
  lastSt: 0,
  scrollTop: 0,
  fl: null, // flat view: {obj, sig, cache: Map(page -> {rows, used}), stale, pending, cached}
  writeCtr: 0, // bumped on every data change (invalidates the flat list and its checkpoints)
};
globalThis.__cmr = { S, V, timing: {}, fn: { layout, schedule, relayout, ensureRuns, update, applyView, recompute, expandAll, navTo, setView, buildFilterMenu, ensureSiteMap, loadData }, fav: favs, Q };

const scroller = $('#scroller');
const spacer = $('#spacer');

// ---------- static strings ----------
function applyStrings() {
  for (const el of document.querySelectorAll('[data-s]')) el.textContent = STR[el.dataset.s];
  for (const el of document.querySelectorAll('[data-st]')) el.title = STR[el.dataset.st];
  for (const el of document.querySelectorAll('[data-sp]')) el.placeholder = STR[el.dataset.sp];
  for (const el of document.querySelectorAll('[data-sa]')) el.setAttribute('aria-label', STR[el.dataset.sa]);
  const fill = (sel, opts) => {
    const s = $(sel);
    if (!s) return;
    s.textContent = '';
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = label;
      s.appendChild(o);
    }
  };
  fill('#selMediaGrace', [5, 15, 30, 60, 120].map((n) => [n, STR.mins(n) + (n === 30 ? STR.rec : '')]));
  fill('#selMediaEnded', [0, 5, 15, 30].map((n) => [n, n === 0 ? STR.minsNow : STR.mins(n)]));
  fill('#selSuspendAfter', [5, 10, 20, 30, 60, 120].map((n) => [n, STR.mins(n) + (n === 20 ? STR.rec : '')]));
  fill('#selAutoStash', [0, 3, 7, 14, 30].map((n) => [n, n === 0 ? STR.off : STR.days(n)]));
  fill('#selRestoreChunk', [25, 50, 100, 200].map((n) => [n, STR.tabsCount(n) + (n === 100 ? STR.rec : '')]));
  fill('#selRestoreMode', [['auto', STR.rmAuto], ['sequential', STR.rmSeq], ['fast', STR.rmFast], ['loadAll', STR.rmLoadAll]]);
  fill('#selTimeDisplay', ['none', 'compact', 'full'].map((k) => [k, STR.tdOpts[k]]));
  fill('#selDateCal', ['auto', 'be', 'ce'].map((k) => [k, STR.calOpts[k]]));
  fill('#selRetention', [90, 180, 400, 730, 0].map((k) => [k, STR.retOpts[k]]));
  fill('#selLanguage', ['auto', 'th', 'en'].map((k) => [k, STR.langs[k]]));
  fill('#selDensity', ['comfortable', 'compact'].map((k) => [k, STR.dens[k]]));
  fill('#selUrlDisplay', ['none', 'domain', 'short', 'full'].map((k) => [k, STR.ud[k]]));
  fill('#selHoverActions', ['hover', 'always'].map((k) => [k, STR.oh[k]]));
  fill('#selDefaultExpand', ['all', 'newest', 'none'].map((k) => [k, STR.de[k]]));
  fill('#selSingleRestore', ['switch', 'stay'].map((k) => [k, STR.sr[k]]));
  fill('#selGroupRestore', ['auto', 'new', 'current'].map((k) => [k, STR.gr[k]]));
  fill('#selTitleClick', ['edit', 'restore'].map((k) => [k, STR.tc[k]]));
  fill('#selCopyFormat', ['urlTitle', 'titleUrl', 'url', 'markdown', 'rich'].map((k) => [k, STR.cf[k]]));
  fill('#selTrashDaysDeleted', [1, 3, 7, 14, 30, 90, 0].map((n) => [n, STR.trashDaysOpts2(n) + (n === 30 ? STR.rec : '')]));
  fill('#selTrashDaysOpened', [1, 3, 7, 14, 30, 90, 0].map((n) => [n, STR.trashDaysOpts2(n) + (n === 7 ? STR.rec : '')]));
  fill('#selSnapshotMin', [1, 3, 5, 10].map((n) => [n, STR.mins(n) + (n === 3 ? STR.rec : '')]));
  fill('#selTheme', [['auto', STR.themeAuto], ['light', STR.themeLight], ['dark', STR.themeDark], ['time', STR.themeTime]]);
  fill('#selAccent', ['blue', 'teal', 'green', 'orange', 'pink', 'violet'].map((k) => [k, STR.accents[k]]));
  fill('#selIconAction', [['stash', STR.iaStash], ['popup', STR.iaPopup]]);
  fill('#selIconScope', [['window', STR.isWindow], ['all', STR.isAll]]);
  fill('#selGrouping', [['window', STR.sgWindow], ['session', STR.sgSession]]);
  fill('#selCloseDup', [['off', STR.cdOff], ['onStash', STR.cdOnStash], ['auto', STR.cdAuto]]);
  fill('#selDupMin', [10, 30, 60, 120].map((n) => [n, STR.mins(n)]));
  fill('#selInternal', [['save', STR.ipSave], ['close', STR.ipClose]]);
}

// ---------- sync status (dot in the sidebar footer; the card lives in settings) ----------
const SYNC = { enabled: false, scope: null, tone: 'off', last: 0 };
let syncCard = null;
let lockCard = null;
function paintSyncDot(st) {
  SYNC.enabled = !!(st && st.enabled);
  SYNC.scope = (st && st.scope) || null;
  const tone = stateTone(st);
  SYNC.last = (st && st.lastSync) || 0;
  if (tone !== SYNC.tone) { SYNC.tone = tone; for (const [, nd] of V.live) nd._sig = null; schedule(); }
  const d = $('#syncDot');
  if (!d) return;
  const row = $('#syncRow');
  row.hidden = !SYNC.enabled; // off: nothing to show in the sidebar
  d.dataset.tone = stateTone(st);
  $('#syncLbl').textContent = stateLabel(st);
  row.title = 'ซิงค์: ' + stateLabel(st);
  row.setAttribute('aria-label', row.title);
}
watchSyncStatus(paintSyncDot);
setTimeout(() => { chrome.runtime.sendMessage({ type: 'sync/getStatus' }).then((r) => r && r.ok && paintSyncDot(r.status)).catch(() => {}); }, 600);

// ---------- messaging / toast ----------
async function send(msg) {
  try {
    const r = await chrome.runtime.sendMessage(msg);
    return r || { ok: false, error: 'no response' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function toast(text, actionLabel, onAction, ms = 6000) {
  $('#toastText').textContent = text;
  const b = $('#toastAction');
  b.hidden = !actionLabel;
  b.textContent = actionLabel || '';
  S.toastAction = onAction || null;
  $('#toast').hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { $('#toast').hidden = true; S.toastAction = null; }, ms);
}
const toastError = (r) => {
  if (r && r.error === 'locked') return toast(STR.locked);
  if (r && r.error === 'busy') return toast(STR.busyRestore);
  if (r && r.error === 'draining') return toast(STR.stashBusy);
  return toast(STR.errorPrefix + (r && r.error ? (STR.errs[r.error] || r.error) : '?'));
};

const lowMem = () => !!(S.drain && !S.drain.paused && S.drain.level && S.drain.level !== 'healthy');

// ---------- data ----------
async function loadData() {
  const [meta, settings, groups, cats] = await Promise.all([db.getMeta(), getSettings(), db.listGroups(), db.listCategories()]);
  S.meta = meta;
  S.settings = settings;
  S.cats = cats;
  S.allGroups = groups.filter((g) => g.phase !== 'writing');
  recompute();
}

async function refreshStats() {
  const r = await send({ type: 'stats' });
  if (r.ok) S.discarded = r.discarded;
  renderTotals();
}

async function refreshStorage() {
  let mb = '0.0';
  let quota = '';
  let persisted = false;
  try {
    const e = await navigator.storage.estimate();
    mb = (e.usage / 1048576).toFixed(1);
    quota = e.quota ? (e.quota / 1073741824).toFixed(0) : '';
  } catch { /* ignore */ }
  try {
    persisted = await navigator.storage.persisted();
    if (!persisted) persisted = await navigator.storage.persist();
  } catch { /* ignore */ }
  $('#storageInfo').textContent = STR.storageUsed(mb, quota, persisted);
  const v = await send({ type: 'vault:info' });
  if (v.ok) $('#vaultInfo').textContent = STR.vaultInfo(v.groups, v.at ? fmtDate(v.at) : '');
}

/** Reasons loaded tabs were skipped by "refresh all", in plain words: ' (กำลังกรอกฟอร์ม / เล่นสื่อ / ยังไม่ได้อนุญาต)'. */
function skipWhy(w, lang) {
  if (!w) return '';
  const en = lang === 'en';
  const parts = [];
  if (w.form) parts.push(en ? 'typing in a form' : 'กำลังกรอกฟอร์ม');
  if (w.media) parts.push(en ? 'playing media' : 'เล่นสื่ออยู่');
  if (w.access) parts.push(en ? 'access not allowed yet' : 'ยังไม่ได้อนุญาต');
  return parts.length ? ' (' + parts.join(en ? ' / ' : ' / ') + ')' : '';
}
/** Friendly first-run empty state: small tab-card illustration, one sentence, the primary action, import, and the shortcut. Built once per language. */
function renderEmptyState(box) {
  if (box.dataset.rich === (S.lang || 'th')) return;
  box.dataset.rich = S.lang || 'th';
  box.textContent = '';
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 120 84'); s.setAttribute('width', '120'); s.setAttribute('height', '84'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'esvg');
  const r = (x, y, w, h, c, rx = 6, o = 1) => { const e = document.createElementNS(ns, 'rect'); e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('width', w); e.setAttribute('height', h); e.setAttribute('rx', rx); e.setAttribute('class', c); if (o !== 1) e.setAttribute('opacity', o); s.appendChild(e); };
  r(26, 6, 68, 52, 'e-back', 8, 0.5); r(18, 16, 84, 52, 'e-mid', 8, 0.75); r(10, 26, 100, 52, 'e-front', 8);
  r(20, 36, 10, 10, 'e-dot', 3); r(36, 37, 46, 4, 'e-line', 2); r(36, 45, 30, 4, 'e-line2', 2); r(20, 56, 10, 10, 'e-dot', 3); r(36, 57, 54, 4, 'e-line', 2); r(36, 65, 24, 4, 'e-line2', 2);
  const t = mk('p', 'etitle'); t.textContent = STR.emptyTitle;
  const sub = mk('p', 'esub'); sub.textContent = STR.emptySub;
  const row = mk('div', 'erow');
  const go = mk('button', 'btn primary'); go.type = 'button'; go.textContent = STR.emptyStash;
  go.addEventListener('click', async () => { const rr = await send({ type: 'stashNow', scope: 'all' }); if (rr && rr.error) toastError(rr); });
  const imp = mk('button', 'btn'); imp.type = 'button'; imp.textContent = STR.emptyImport;
  imp.addEventListener('click', () => { setView('settings'); requestAnimationFrame(() => { const b = $('#s-backup'); if (b) b.scrollIntoView({ block: 'start' }); }); });
  row.append(go, imp);
  const hint = mk('p', 'ehint'); hint.append(STR.emptyHint + ' ');
  const k = mk('kbd'); k.textContent = 'Alt+Shift+S'; hint.append(k);
  box.append(s, t, sub, row, hint);
}
function applyTheme() {
  applyThemeSettings(S.settings); // shared with popup / about (lib/theme.js)
}

// ---------- tiny DOM helpers ----------
const hostCache = new Map();
function hostFor(url) {
  let h = hostCache.get(url);
  if (h === undefined) { h = hostOf(url); hostCache.set(url, h); if (hostCache.size > 5000) hostCache.clear(); }
  return h;
}

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function actBtn(act, text, cls, label) {
  const b = mk('button', cls || '', text);
  b.type = 'button';
  b.dataset.act = act;
  if (label) b.setAttribute('aria-label', label);
  return b;
}

// ---------- layout: section headers (lib/query.js) + prefix sums ----------
const isOpen = (g) => V.exp.has(g.id);

// ---------- tab groups inside a stash group ----------
function tgDefOf(g, i) {
  const list = g && g.tabGroups;
  if (!list || !Number.isInteger(i) || i < 0) return null;
  let c = V.tgDefs.get(g.id);
  if (!c || c.list !== list) { c = { list, map: new Map(list.map((x) => [x.i, x])) }; V.tgDefs.set(g.id, c); }
  return c.map.get(i) || null;
}

const needRuns = (g) => !!(g.tabGroups && g.tabGroups.length) && g.count > 0 && g.count <= RUNS_MAX;
/** Valid runs for the group's current item count, or null (flat list). */
const baseRuns = (g) => {
  if (sortActive(g)) return null; // sub-headers are hidden while a custom item order is active
  const r = V.runs.get(g.id);
  return r && r.count === g.count ? r : null;
};
const viewCache = new WeakMap();
/** Group-by tab group: a view (copy of a session with vsel = run indexes) only shows its own runs, positions stay absolute. */
function viewRuns(g, base) {
  const key = H.item + '|' + H.sub;
  const c = viewCache.get(g);
  if (c && c.base === base && c.key === key) return c.r;
  const segs = [];
  let y = 0;
  for (const si of g.vsel) {
    const b = base.segs[si];
    if (!b) continue;
    segs.push({ ...b, y, si });
    y += (b.tg >= 0 ? H.sub : 0) + b.n * H.item;
  }
  const r = { count: base.count, segs, height: y };
  viewCache.set(g, { base, key, r });
  return r;
}
const runsOf = (g) => {
  const b = baseRuns(g);
  return b && g.vsel ? viewRuns(g, b) : b;
};

/** Scans the group once (batched) so sub-header rows can be placed without loading item pages. */
async function ensureRuns(g) {
  if (!g) return;
  if (!needRuns(g)) { V.runs.delete(g.id); return; }
  const cur = V.runs.get(g.id);
  if (cur && cur.count === g.count) return;
  if (lowMem()) return;
  const valid = new Set(g.tabGroups.map((x) => x.i));
  const t0 = performance.now();
  const { segs, total } = await db.scanTgRuns(g.id, valid);
  let y = 0;
  let ip = 0;
  for (const s of segs) {
    s.y = y;
    s.itemStart = ip;
    y += (s.tg >= 0 ? H.sub : 0) + s.n * H.item;
    ip += s.n;
  }
  V.runs.set(g.id, { count: total, segs, height: y });
  globalThis.__cmr.timing.runsMs = Math.round(performance.now() - t0);
}

const bodyHeight = (g) => {
  const r = runsOf(g);
  return r ? r.height : g.count * H.item;
};
const blockHeight = (g, i) => (V.bucketAt[i] ? H.bucket : 0) + H.group + (isOpen(g) ? bodyHeight(g) : 0);

/** Index of the segment containing y (pixels from the first row of the group body). */
function findSeg(segs, y) {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].y <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function layout() {
  if (V.mode !== 'search') V.mode = S.vs.flat ? 'flat' : 'groups';
  if (V.mode === 'flat') flatEnsure();
  const gs = S.groups;
  const n = gs.length;
  const tops = new Float64Array(n + 1);
  V.bucketAt = V.labels && V.labels.length === n ? V.labels : new Array(n).fill(null);
  V.idxOf = new Map();
  V.vIdx = new Map();
  V.jump = [];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const g = gs[i];
    const b = V.bucketAt[i];
    if (b) V.jump.push({ label: b, idx: i, n: 0 });
    if (V.jump.length) V.jump[V.jump.length - 1].n++;
    if (g.vk) V.vIdx.set(g.vk, i); else V.vIdx.set(g.id, i);
    if (!V.idxOf.has(g.id)) V.idxOf.set(g.id, i);
    tops[i] = y;
    y += blockHeight(g, i);
  }
  tops[n] = y;
  V.tops = tops;
  V.total = V.mode === 'search' ? V.srows.length * H.item : V.mode === 'flat' ? (V.fl ? V.fl.obj.total : 0) * H.item : y;
  spacer.style.height = V.total + 'px';
  const empty = $('#emptyMsg');
  empty.hidden = !((V.mode === 'groups' || V.mode === 'flat') ? (V.mode === 'flat' ? (n === 0 || (V.fl && V.fl.obj.total === 0 && V.fl.settled)) : n === 0) && S.view === 'list' : false);
  if ((V.mode === 'groups' || V.mode === 'flat') && !empty.hidden) { if (S.allGroups.length) { delete empty.dataset.rich; empty.textContent = STR.noMatch; } else renderEmptyState(empty); }
}

/** index of the group whose block contains y */
function locate(y) {
  const n = S.groups.length;
  if (!n) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (V.tops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function rowsGroups(y0, y1) {
  const out = [];
  const n = S.groups.length;
  if (!n) return out;
  for (let i = locate(y0); i < n && V.tops[i] < y1; i++) {
    const g = S.groups[i];
    let y = V.tops[i];
    if (V.bucketAt[i]) { out.push({ key: 'b:' + i, kind: 'bucket', top: y, label: V.bucketAt[i] }); y += H.bucket; }
    out.push({ key: 'g:' + (g.vk || g.id), kind: 'group', top: y, g });
    y += H.group;
    if (isOpen(g) && g.count > 0) {
      wantRuns(g);
      const runs = runsOf(g);
      if (!runs) {
        const first = Math.max(0, Math.floor((y0 - y) / H.item));
        const last = Math.min(g.count - 1, Math.ceil((y1 - y) / H.item));
        for (let p = first; p <= last; p++) {
          out.push({ key: `i:${g.id}:${p}`, kind: 'item', top: y + p * H.item, g, gid: g.id, pos: p, last: p === g.count - 1 });
        }
      } else {
        const segs = runs.segs;
        for (let si = findSeg(segs, y0 - y); si < segs.length; si++) {
          const sg = segs[si];
          const sy = y + sg.y;
          if (sy >= y1) break;
          let iy = sy;
          if (sg.tg >= 0) {
            out.push({ key: `s:${g.id}:${sg.si != null ? sg.si : si}`, kind: 'sub', top: sy, g, seg: sg });
            iy += H.sub;
          }
          const first = Math.max(0, Math.floor((y0 - iy) / H.item));
          const last = Math.min(sg.n - 1, Math.ceil((y1 - iy) / H.item));
          for (let q = first; q <= last; q++) {
            const pos = sg.itemStart + q;
            out.push({ key: `i:${g.id}:${pos}`, kind: 'item', top: iy + q * H.item, g, gid: g.id, pos, last: pos === g.count - 1, tgFirst: q === 0 && sg.tg >= 0, inTg: sg.tg >= 0 });
          }
        }
      }
    }
  }
  return out;
}

// ---------- flat "all tabs" view ----------
function flatSig() {
  let h = 0;
  for (const g of S.groups) h = (Math.imul(h, 31) + g.count + g.id.charCodeAt(g.id.length - 1)) | 0;
  return [S.vs.flatSort || 'stash', S.vs.flatDir || 'desc', S.filters.sites.join(','), S.groups.length, h, V.writeCtr, S.siteMap ? 1 : 0, S.vs.density || ''].join('|');
}

/** Items that live in sessions the list does NOT show (archived / filtered out / trashed): 0 means raw index positions are exact. */
function flatExcluded() {
  let n = 0;
  for (const g of S.allGroups) if (!S.allowedIds.has(g.id)) n += g.count || 0;
  for (const g of (S.trash && S.trash.groups) || []) n += (g.count || 0);
  return n;
}

function flatEnsure() {
  const sig = flatSig();
  if (V.fl && V.fl.sig === sig) return;
  const old = V.fl;
  if (old) old.obj.stop();
  const obj = createFlat({ sort: S.vs.flatSort || 'stash', dir: S.vs.flatDir || 'desc', groups: S.groups, sites: S.filters.sites, siteMap: S.siteMap, excluded: flatExcluded() });
  const stale = old ? new Map([...(old.stale || []), ...old.cache]) : null; // keep showing the old rows until the new pages arrive (no flash on every write)
  const fl = { obj, sig, cache: new Map(), stale, pending: new Set(), cached: 0, settled: false };
  obj.onProgress = (f) => { if (V.fl === fl) { fl.prog = f; renderSearchInfoFlat(); } };
  obj.onTotal = () => { if (V.fl === fl) { spacer.style.height = obj.total * H.item + 'px'; V.total = obj.total * H.item; schedule(); renderSearchInfoFlat(); } };
  V.fl = fl;
  obj.init().then(() => { fl.settled = true; if (V.fl === fl) { globalThis.__cmr.timing.flatInitMs = Math.round(performance.now() - fl.t0); layout(); } }).catch(() => { fl.settled = true; });
  fl.t0 = performance.now();
  renderSearchInfoFlat();
}

function renderSearchInfoFlat() {
  if (SRCH.cur || S.view !== 'list' || V.mode !== 'flat') return;
  const info = $('#searchInfo');
  const p = V.fl && V.fl.prog;
  if (p != null && p < 1 && V.fl.obj.mode === 'walk') { info.hidden = false; info.textContent = STR.flatPrep(Math.floor(p * 100)); return; }
  info.hidden = true;
}

function flatRecAt(i) {
  const fl = V.fl;
  if (!fl) return null;
  const pg = Math.floor(i / FLAT_PAGE);
  const e = fl.cache.get(pg);
  if (e) { e.used = V.tick; return e.rows[i - pg * FLAT_PAGE] || null; }
  flatLoad(fl, pg);
  const st = fl.stale && fl.stale.get(pg);
  return st ? st.rows[i - pg * FLAT_PAGE] || null : null;
}

async function flatLoad(fl, pg) {
  if (fl.pending.has(pg) || fl.pending.size >= 3 || lowMem()) return;
  fl.pending.add(pg);
  const t0 = performance.now();
  try {
    const rows = await fl.obj.page(pg);
    if (V.fl !== fl) return;
    fl.cache.set(pg, { rows, used: V.tick });
    fl.cached += rows.length;
    if (fl.cached > CACHE_MAX) {
      const all = [...fl.cache].sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of all) { if (fl.cached <= CACHE_MAX * 0.8) break; if (v.used >= V.tick - 1) continue; fl.cache.delete(k); fl.cached -= v.rows.length; }
    }
    globalThis.__cmr.timing.flatPageMs = Math.round(performance.now() - t0);
    if (!globalThis.__cmr.timing.flatFirstRowsMs) globalThis.__cmr.timing.flatFirstRowsMs = Math.round(performance.now());
    if (fl.stale && !fl.staleTimer) fl.staleTimer = setTimeout(() => { fl.stale = null; }, 1500);
    for (const [, n] of V.live) if (n._kind === 'item' && n._skel) n._sig = null;
    schedule();
  } catch { /* retried on the next frame */ } finally {
    fl.pending.delete(pg);
  }
}

function rowsFlat(y0, y1) {
  const out = [];
  const fl = V.fl;
  if (!fl) return out;
  const total = fl.obj.total;
  const first = Math.max(0, Math.floor(y0 / H.item));
  const last = Math.min(total - 1, Math.ceil(y1 / H.item));
  for (let i = first; i <= last; i++) {
    const rec = flatRecAt(i);
    out.push({ key: 'f:' + i, kind: 'item', top: i * H.item, g: rec ? S.gById.get(rec.g) : null, gid: rec ? rec.g : '', pos: i, rec, flat: true, last: false });
  }
  return out;
}

function rowsSearch(y0, y1) {
  const out = [];
  const first = Math.max(0, Math.floor(y0 / H.item));
  const last = Math.min(V.srows.length - 1, Math.ceil(y1 / H.item));
  for (let i = first; i <= last; i++) {
    const h = V.srows[i];
    if (h.t === 'hit') {
      const rec = h.rec;
      const g = S.groups[V.idxOf.get(rec.g)];
      out.push({ key: 'h:' + rec.g + ':' + rec.seq, kind: 'item', top: i * H.item, g, gid: rec.g, pos: i, rec, hit: h, search: true, last: false });
    } else out.push({ key: 'x:' + h.t + i, kind: 'note', top: i * H.item, note: h });
  }
  return out;
}

// ---------- paged item cache ----------
function recAt(gid, pos) {
  const gi = V.idxOf.get(gid);
  const g0 = gi != null ? S.groups[gi] : null;
  if (g0 && sortActive(g0)) {
    const so = V.sorted.get(gid);
    if (so && so.sig === sortSig(g0)) return so.rows[pos] || null;
    ensureSorted(g0);
    return null;
  }
  const pg = Math.floor(pos / PAGE_ROWS);
  const m = V.cache.get(gid);
  const e = m && m.get(pg);
  if (e) { e.used = V.tick; return e.rows[pos - pg * PAGE_ROWS] || null; }
  ensurePage(gid, pg);
  return null;
}

async function ensurePage(gid, pg) {
  const key = gid + ':' + pg;
  if (V.pending.has(key) || lowMem()) return;
  const m0 = V.cache.get(gid);
  if (m0 && m0.has(pg)) return;
  V.pending.add(key);
  try {
    const rows = await db.getItemsByPos(gid, pg * PAGE_ROWS, PAGE_ROWS);
    if (!V.exp.has(gid)) return;
    let m = V.cache.get(gid);
    if (!m) { m = new Map(); V.cache.set(gid, m); }
    if (m.has(pg)) return;
    m.set(pg, { rows, used: V.tick });
    V.cachedRecords += rows.length;
    evict();
    if (!globalThis.__cmr.timing.firstRowsMs) globalThis.__cmr.timing.firstRowsMs = Math.round(performance.now());
    for (const [, n] of V.live) if (n._kind === 'item' && n._gid === gid && n._skel) n._sig = null;
    schedule();
  } catch { /* retried on next scroll */ } finally {
    V.pending.delete(key);
  }
}

function evict() {
  if (V.cachedRecords <= CACHE_MAX) return;
  const pages = [];
  for (const [gid, m] of V.cache) for (const [pg, e] of m) pages.push({ gid, pg, e });
  pages.sort((a, b) => a.e.used - b.e.used);
  for (const p of pages) {
    if (V.cachedRecords <= CACHE_MAX * 0.8) break;
    if (p.e.used >= V.tick - 1) continue; // visible right now
    V.cache.get(p.gid).delete(p.pg);
    V.cachedRecords -= p.e.rows.length;
  }
}

function dropCache(gids) {
  const list = gids === 'all' ? [...V.cache.keys()] : gids;
  for (const gid of list) {
    const m = V.cache.get(gid);
    if (!m) continue;
    for (const e of m.values()) V.cachedRecords -= e.rows.length;
    V.cache.delete(gid);
  }
}

// ---------- row nodes (pooled) ----------
function buildBucket() {
  const n = mk('div', 'vrow bucket');
  n.setAttribute('role', 'presentation');
  n._label = mk('span', 'blabel');
  n.appendChild(n._label);
  return n;
}

/** Icon button of the shared button system (see "button system" in stash.css). */
function ibtn(act, icon, cls, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ib' + (cls ? ' ' + cls : '');
  b.dataset.act = act;
  b.appendChild(ICON(icon));
  if (label) { b.setAttribute('aria-label', label); b.title = label; }
  return b;
}

/** Small muted metadata chip (22px tall, 6px radius): icon + text. */
function chip(icon, cls) {
  const c = mk('span', 'chip6' + (cls ? ' ' + cls : ''));
  c.appendChild(ICON(icon));
  c._t = mk('span', 'ct');
  c.appendChild(c._t);
  return c;
}

/**
 * Session header row, one fixed grid: [chevron 28] [title area, flexible] [meta cluster, fixed columns] [actions, right].
 * The title is plain text (an <input> only while renaming); the host list is a favicon stack; every action is a 32px icon button.
 */
function buildGroupRow() {
  const n = mk('div', 'vrow ghead');
  n.setAttribute('role', 'listitem');
  n.draggable = false; // (the drag is pointer based: lib/dnd.js)
  n._toggle = ibtn('toggle', 'expand', 'toggle', STR.expand);
  // title area
  n._tarea = mk('div', 'gtarea');
  n._tt = mk('span', 'gt');
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'gtitle';
  title.hidden = true;
  title.placeholder = STR.untitled;
  title.setAttribute('aria-label', STR.groupTitleLabel);
  n._title = title;
  n._ind = mk('span', 'gind');
  n._cat = mk('span', 'chip6 gcat');
  n._edit = ibtn('editTitle', 'edit', 'sm hov', STR.editTitle);
  n._tarea.append(n._tt, title, n._ind, n._cat, n._edit);
  n._mos = mk('span', 'gmos'); // favicon mosaic cover (setting sessionCover, comfortable density only)
  n._mos.setAttribute('aria-hidden', 'true');
  n._mos.hidden = true;
  n._mosf = [];
  for (let i = 0; i < 4; i++) {
    const f = mk('span', 'fs');
    f._av = mk('span', 'av');
    f.append(f._av);
    if (!favs.atlas) { const img = document.createElement('img'); img.width = 16; img.height = 16; img.alt = ''; img.decoding = 'async'; f._img = img; f.append(img); } else f.classList.add('at');
    n._mos.appendChild(f);
    n._mosf.push(f);
  }
  n._tarea.prepend(n._mos);
  // meta cluster (fixed columns => rows align across sessions)
  n._meta = mk('div', 'gmeta');
  n._stack = mk('span', 'gstack');
  n._fs = [];
  for (let i = 0; i < 4; i++) {
    const f = mk('span', 'fs');
    f._av = mk('span', 'av');
    f.append(f._av);
    if (!favs.atlas) { const img = document.createElement('img'); img.width = 16; img.height = 16; img.alt = ''; img.decoding = 'async'; f._img = img; f.append(img); } else f.classList.add('at');
    n._stack.appendChild(f);
    n._fs.push(f);
  }
  n._more2 = mk('span', 'fsn');
  n._stack.appendChild(n._more2);
  n._cnt = chip('tab', 'c-cnt');
  n._wins = chip('window', 'c-win');
  n._date = chip('clock', 'c-date');
  n._date.dataset.hc = 'g';
  n._xc = mk('span', 'gxc'); // extra time chips (last used / opened N times)
  n._tarea.appendChild(n._xc);
  n._meta.append(n._stack, n._cnt, n._wins, n._date);
  // actions: one grouped toolbar of identical 32px ghost buttons
  n._acts = mk('div', 'acts');
  n._open = document.createElement('button');
  n._open.type = 'button';
  n._open.className = 'tb tonal';
  n._open.dataset.act = 'openGroup';
  n._openL = mk('span', 'tl');
  n._open.append(ICON('open'), n._openL);
  n._openChev = document.createElement('button');
  n._openChev.type = 'button';
  n._openChev.className = 'tb tonal chev';
  n._openChev.dataset.act = 'openMenu';
  n._openChev.setAttribute('aria-haspopup', 'menu');
  n._openChev.title = STR.openMenuTip;
  n._openChev.setAttribute('aria-label', STR.openMenuTip);
  n._openChev.appendChild(ICON('expand'));
  n._openBox = mk('span', 'openbox');
  n._openBox.setAttribute('role', 'group');
  n._openBox.append(n._open, n._openChev);
  n._sortMain = document.createElement('button');
  n._sortMain.type = 'button';
  n._sortMain.dataset.act = 'itemSortMain';
  n._sortChev = document.createElement('button');
  n._sortChev.type = 'button';
  n._sortChev.dataset.act = 'itemSortMenu';
  n._sortChev.appendChild(ICON('expand'));
  n._sortBox = mk('span', 'pill');
  n._sortBox.setAttribute('role', 'group');
  n._sortBox.append(n._sortMain, n._sortChev);
  n._star = ibtn('star', 'star', 'star', STR.star);
  n._lock = ibtn('lock', 'lock', '', STR.lock);
  n._del = ibtn('delGroup', 'trash', 'danger', STR.del);
  n._sync = ibtn('syncGroup', 'cloud', 'sync', STR.syncBtnOff);
  n._sdot = mk('span', 'sdot');
  n._sdot.setAttribute('aria-hidden', 'true');
  n._sync.appendChild(n._sdot);
  n._sync.setAttribute('aria-haspopup', 'menu');
  n._more = ibtn('more', 'dots', '', STR.more);
  n._more.setAttribute('aria-haspopup', 'menu');
  n._acts.append(n._openBox, n._sortBox, n._star, n._lock, n._sync, n._del, n._more);
  n.append(n._toggle, n._tarea, n._meta, n._acts);
  return n;
}

function paintGroupChips(n, g) {
  const box = n._xc;
  box.textContent = '';
  for (const c of groupChips(g, Date.now(), S.settings.timeDisplay || 'compact', S.lang || 'th', STR)) {
    const s = mk('span', 'chip6 gx', c.text);
    if (c.t) { s.dataset.t = String(c.t); s.dataset.k = 'a2'; }
    box.appendChild(s);
  }
}

function shortDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hm = d.toLocaleTimeString(Q.L.locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (ts >= sod) return `${STR.bToday} ${hm}`;
  if (ts >= sod - 86400000) return `${STR.bYesterday} ${hm}`;
  return d.toLocaleDateString(Q.L.locale, { day: 'numeric', month: 'short' }) + (d.getFullYear() !== now.getFullYear() ? ' ' + String(d.getFullYear()).slice(-2) : '');
}

/** Favicon stack of the session's top hosts (icons come from the shared per-host cache; letters while unknown). */
function paintStack(n, g) {
  const top = (g.agg && g.agg.top) || [];
  const hosts = top.slice(0, 4).map((x) => x[0]);
  n._stackHosts = hosts;
  for (let i = 0; i < 4; i++) {
    const f = n._fs[i];
    const h = hosts[i];
    f.hidden = !h;
    if (!h) continue;
    const a = avatarOf(h);
    f._av.textContent = a.ch;
    f._av.dataset.h = String(a.hue);
    if (favs.atlas) { const c = favsOn() ? favs.cellFor(h, 'https://' + h + '/') : -1; if (c >= 0) { if (f._fc !== c) { f._fc = c; favs.cellStyle(f, c); } f.classList.add('has'); } else { f._fc = -1; f.classList.remove('has'); } continue; }
    const u = favsOn() ? favs.iconFor(h, 'https://' + h + '/') : null;
    if (u) { if (f._u !== u) { f._u = u; f._img.src = u; } f.classList.add('has'); } else f.classList.remove('has');
  }
  const extra = (g.agg ? g.agg.nSites : 0) - hosts.length;
  n._more2.textContent = extra > 0 ? '+' + extra : '';
  n._stack.title = hosts.length ? STR.stackTip(top.slice(0, 5).map((x) => x[0]).join(', '), Math.max(0, (g.agg.nSites || 0) - Math.min(5, top.length))) : '';
  n._stack.setAttribute('aria-label', n._stack.title);
}

/** Favicon mosaic cover: 2x2 of the top hosts. Off (and hidden) unless the setting is on, the density is comfortable and the hosts are readable (never while locked). */
function paintMosaic(n, g) {
  const top = (g.agg && g.agg.top) || [];
  const on = S.settings.sessionCover !== false && document.documentElement.dataset.density !== 'compact' && top.length > 0 && !(lockrt.enabled() && lockrt.isLocked());
  n._mos.hidden = !on;
  if (!on) return;
  for (let i = 0; i < 4; i++) {
    const f = n._mosf[i];
    const h = top[i] && top[i][0];
    f.classList.toggle('empty', !h);
    if (!h) { f.classList.remove('has'); continue; }
    const a = avatarOf(h);
    f._av.textContent = a.ch;
    f._av.dataset.h = String(a.hue);
    if (favs.atlas) { const c = favsOn() ? favs.cellFor(h, 'https://' + h + '/') : -1; if (c >= 0) { if (f._fc !== c) { f._fc = c; favs.cellStyle(f, c); } f.classList.add('has'); } else { f._fc = -1; f.classList.remove('has'); } continue; }
    const u = favsOn() ? favs.iconFor(h, 'https://' + h + '/') : null;
    if (u) { if (f._u !== u) { f._u = u; f._img.src = u; } f.classList.add('has'); } else f.classList.remove('has');
  }
}

function beginEdit(row) {
  if (!row || !row._title) return;
  const g = groupOf(row.dataset.g);
  if (!g || g.locked) return;
  row.classList.add('editing');
  row._tt.hidden = true;
  row._title.hidden = false;
  row._title.value = g.title || '';
  row._title.dataset.orig = g.title || '';
  row._title.focus();
  row._title.select();
}
function endEdit(row) {
  if (!row || !row._title) return;
  row.classList.remove('editing');
  row._title.hidden = true;
  row._tt.hidden = false;
}

function buildItemRow() {
  const n = mk('div', 'vrow item');
  n.setAttribute('role', 'listitem');
  let img = null;
  if (!favs.atlas) { img = document.createElement('img'); img.width = 16; img.height = 16; img.alt = ''; img.decoding = 'async'; n._img = img; }
  n._av = mk('span', 'av');
  n._fb = mk('span', 'fav');
  n._fb.append(n._av);
  if (img) n._fb.append(img); else n._fb.classList.add('at');
  n._a = mk('a', 'ilink');
  n._host = mk('span', 'host');
  n._x = actBtn('delItem', '×', 'x', STR.removeItem);
  n._dot = mk('span', 'tgdot');
  n._dot.style.visibility = 'hidden';
  n._sess = mk('span', 'sess');
  n._tm = mk('span', 'itm'); // time token (minute ticker updates it in place)
  n._sv = actBtn('openSplit', '', 'svb', STR.splitTip); n._sv.title = STR.splitTip; n._sv.hidden = true; n._sv.append(ICON('split')); n._hw = mk('span', 'hostw'); n._hw.append(n._sv, n._host); // split view badge sits in the meta cell, left of the host: the favicon stays clear
  n.dataset.hc = 'i';
  n.append(n._dot, n._fb, n._a, n._hw, n._sess, n._tm, n._x); if (selUi) selUi.decorateItemRow(n); // (the "≈ similar match" badge is a CSS ::after on the .fz class: no extra node)
  return n;
}

function buildNoteRow() {
  const n = mk('div', 'vrow note');
  n.setAttribute('role', 'presentation');
  n._label = mk('span', 'nlabel');
  n._btn = actBtn('searchMore', STR.searchMore);
  n.append(n._label, n._btn);
  return n;
}

function buildSubRow() {
  const n = mk('div', 'vrow sub');
  n.setAttribute('role', 'listitem');
  n._dot = mk('span', 'tgdot big');
  n._title = mk('span', 'subtitle');
  n._count = mk('span', 'subcount');
  n._open = actBtn('openTg', STR.openAsTabGroup);
  n.append(n._dot, n._title, n._count, n._open);
  return n;
}

const BUILD = { bucket: buildBucket, group: buildGroupRow, item: buildItemRow, sub: buildSubRow, note: buildNoteRow };

function acquire(kind) {
  const f = V.free[kind];
  let n = f.pop();
  if (!n) {
    n = BUILD[kind]();
    n._kind = kind;
    spacer.appendChild(n);
  }
  n.hidden = false;
  return n;
}

function release(n) {
  n.hidden = true;
  n._key = null;
  n._sig = null;
  const f = V.free[n._kind];
  if (f.length >= POOL_KEEP[n._kind]) n.remove(); else f.push(n);
}

function fillBucket(n, r) {
  if (n._sig === r.label) return;
  n._sig = r.label;
  n._label.textContent = r.label;
}

function fillGroup(n, r) {
  const g = r.g;
  const open = isOpen(g);
  const multi = g.windowCount > 1;
  const cat = g.cat ? catById(g.cat) : null;
  const sst = groupSyncState(g);
  const sig = [sst, g.id, g.vk, g.vcount, g.title, g.count, g.starred, g.locked, g.pinned, g.archived, g.pending, g.cat, cat && cat.name, cat && cat.color, g.note, open, g.phase, g.windowCount, g.agg && g.agg.top && g.agg.top.map((x) => x[0]).join(','), g.agg && g.agg.nSites, g.createdAt, g.rc, g.tm && g.tm.luMax, S.settings.timeDisplay, S.settings.dateCalendar, S.settings.titleClick, S.lang, sortSig(g), g.color, g.emoji, S.settings.setLook, S.settings.sessionCover, document.documentElement.dataset.density, !!(g.agg && g.agg.top && g.agg.top.length)].join('|');
  if (n._sig === sig) return;
  n._sig = sig;
  n.dataset.g = g.id;
  if (g.vk) n.dataset.vk = g.vk; else delete n.dataset.vk;
  n.dataset.kind = 'group';
  n.className = 'vrow ghead' + (open ? ' open' : '') + (g.starred ? ' starred' : '') + (g.pinned ? ' pinned' : '') + (g.archived ? ' archived' : '') + (g.locked ? ' locked' : '') + (g.phase === 'draining' ? ' draining' : '') + (n.classList.contains('editing') ? ' editing' : '');
  n._toggle.setAttribute('aria-label', open ? STR.collapse : STR.expand);
  n._toggle.title = open ? STR.collapse : STR.expand;
  n._toggle.setAttribute('aria-expanded', String(open));
  // title: plain text; untitled sessions show a muted automatic title
  const named = !!(g.title && g.title.trim());
  const look = S.settings.setLook !== false;
  n._tt.textContent = (look && g.emoji ? g.emoji + ' ' : '') + (named ? g.title : STR.autoTitle(g));
  if (look && g.color) n.dataset.col = String(g.color); else delete n.dataset.col;
  n._tt.classList.toggle('auto', !named);
  n._tt.title = g.note ? STR.noteOf(g.note) : (named ? g.title : '');
  if (document.activeElement !== n._title) { n._title.value = g.title || ''; n._title.dataset.orig = g.title || ''; }
  n._edit.hidden = !!g.locked || S.settings.titleClick === 'restore';
  // indicators next to the title: pin / pending, category
  n._ind.textContent = '';
  if (g.pinned) { const i = ICON('pin'); i.setAttribute('class', 'mi ind-pin'); n._ind.appendChild(i); }
  if (g.pending) { const i = ICON('clock'); i.setAttribute('class', 'mi'); n._ind.appendChild(i); }
  n._ind.hidden = !(g.pinned || g.pending);
  n._cat.hidden = !cat;
  if (cat) { n._cat.textContent = cat.name; n._cat.dataset.c = cat.color; }
  // meta
  paintStack(n, g);
  paintMosaic(n, g);
  n._cnt._t.textContent = g.vcount != null ? g.vcount + '/' + g.count : String(g.count);
  n._cnt.title = n._cnt.dataset.tip = STR.chipTabs + ': ' + (g.vcount != null ? g.vcount + '/' + g.count : g.count);
  n._wins.style.visibility = multi ? '' : 'hidden';
  n._wins._t.textContent = multi ? String(g.windowCount) : '';
  n._wins.title = multi ? STR.chipWins + ': ' + g.windowCount : '';
  n._date._t.textContent = fmtAgo(Date.now() - g.createdAt, S.lang || 'th');
  n._date._t.dataset.t = String(g.createdAt);
  n._date._t.dataset.k = 'a';
  n._date.removeAttribute('title');
  n._gobj = g;
  paintGroupChips(n, g);
  // actions
  const es = effSort(g);
  n._sortMain.textContent = '';
  n._sortMain.append(ICON(ISORT_ICON[es.key] || 'rows'), ICON(es.dir === 'desc' ? 'arrow-down' : 'arrow-up', 'arr'));
  n._sortBox.classList.toggle('on', sortActive(g));
  n._sortMain.title = STR.isortTip(STR.itemSorts[es.key], es.dir);
  n._sortMain.setAttribute('aria-label', n._sortMain.title);
  n._sortChev.title = STR.isortMenuTip;
  n._sortChev.setAttribute('aria-label', STR.isortMenuTip);
  n._openL.textContent = multi ? STR.openSession : STR.openGroup;
  n._open.title = multi ? STR.openSession : STR.openGroup;
  n._open.dataset.act = multi ? 'openSession' : 'openGroup';
  n._star.replaceChildren(ICON(g.starred ? 'star-fill' : 'star'));
  n._star.setAttribute('aria-pressed', String(!!g.starred));
  n._star.classList.toggle('keep', !!g.starred);
  n._lock.setAttribute('aria-pressed', String(!!g.locked));
  n._lock.classList.toggle('keep', !!g.locked);
  n._lock.replaceChildren(ICON('lock'));
  n._lock.title = n._lock.ariaLabel = STR.lock;
  n._del.disabled = !!g.locked;
  const lab = !SYNC.enabled ? STR.syncBtnNone : sst === 'off' ? STR.syncBtnOff : g.sync ? STR.syncBtnOn : STR.syncBtnScope;
  n._sync.title = lab + (SYNC.enabled ? ' · ' + STR.syncSt[sst] : '');
  n._sync.setAttribute('aria-label', n._sync.title);
  n._sdot.dataset.tone = sst;
  n._sync.classList.toggle('keep', sst !== 'off');
}

/** Cloud state of one session: 'off' (not synced / sync not enabled) | 'ok' | 'busy' (sending / queued) | 'bad'. */
function groupSyncState(g) {
  if (!SYNC.enabled) return 'off';
  const sc = SYNC.scope || { mode: 'recent', days: 30 };
  const inScope = g.phase === 'committed' && (sc.mode === 'all' || (sc.mode === 'flagged' ? g.sync === true : !!g.starred || g.sync === true || Date.now() - g.createdAt <= (sc.days || 30) * 86400000));
  if (!inScope) return 'off';
  if (SYNC.tone === 'bad') return 'bad';
  if (SYNC.tone === 'busy' || (S.meta && (S.meta.syncDirty || []).includes(g.id))) return 'busy';
  return 'ok';
}

function fillItem(n, r) {
  const rec = r.flat ? r.rec : (r.rec || recAt(r.gid, r.pos));
  const tdef = rec && rec.tg != null ? tgDefOf(r.g, rec.tg) : null;
  const sig = rec ? rec.g + ':' + rec.seq + (r.last ? 'L' : '') + (r.tgFirst ? 'F' : '') + (r.inTg ? 'T' : '') + (tdef ? tdef.color : '') + (r.hit ? '#' + r.hit.v : '') + (r.flat ? '|' + (r.g ? (r.g.title || '') + r.g.createdAt : '') : '') : 'skel' + (r.flat ? 'f' : '') + (r.last ? 'L' : '') + (r.inTg ? 'T' : '');
  if (n._sig === sig) return;
  n._sig = sig;
  n._gid = r.gid;
  n._skel = !rec;
  const g = r.g;
  const locked = !!(g && g.locked);
  if (!rec) {
    n.className = 'vrow item skel' + (r.last ? ' last' : '') + (r.inTg ? ' intg' : '') + (r.flat ? ' fl' : '');
    n._sess.textContent = '';
    n._dot.style.visibility = 'hidden';
    n._sv.hidden = true;
    delete n.dataset.seq;
    n.dataset.g = r.gid;
    n._a.textContent = '·';
    n._a.removeAttribute('href');
    n._host.textContent = '·';
    n._fh = null;
    n._frec = null;
    return;
  }
  const wstart = !r.search && !r.flat && rec.ws && g && g.windowCount > 1 && !r.tgFirst; // a tab-group header carries the window label
  n.className = 'vrow item' + (r.last ? ' last' : '') + (wstart ? ' wstart' : '') + (r.inTg ? ' intg' : '') + (r.hit && r.hit.fuzzy ? ' fz' : '') + (r.flat ? ' fl' : '');
  n._sess.textContent = r.flat && g ? (g.title && g.title.trim() ? g.title : fmtDate(g.createdAt)) : '';
  n._dot.style.visibility = tdef ? '' : 'hidden';
  n._sv.hidden = !(rec.sv >= 0);
  if (tdef) n._dot.dataset.c = tdef.color;
  if (wstart) n.dataset.wl = STR.windowN(rec.w); else delete n.dataset.wl;
  n.dataset.g = rec.g;
  n.dataset.seq = String(rec.seq);
  const hit = r.hit;
  if (hit && hit.hl) setMarked(n._a, rec.title || rec.url, rec.title ? hit.hl.title : hit.hl.url, 0);
  else n._a.textContent = rec.title || rec.url;
  if (classifyUrl(rec.url) === 'save') n._a.setAttribute('href', rec.url); else n._a.removeAttribute('href');
  n._a.title = rec.url + '\n' + STR.itemOpenTip;
  let label = '';
  if (r.search && g) label = (g.title || fmtDate(g.createdAt)) + ' · ';
  if (hit && hit.hl && hit.hl.url.length) {
    // search rows show the url without its scheme so highlights inside the url are visible
    const shown = rec.url.replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/i, '');
    setMarked(n._host, label + shown, hit.hl.url, label.length - (rec.url.length - shown.length));
  } else { n._host.textContent = label + urlShown(rec.url); n._host.hidden = S.settings.urlDisplay === 'none' && !label; }
  n._x.hidden = locked;
  n._url = rec.url;
  n._frec = rec;
  n._g = g || null;
  paintItemTime(n, rec);
  paintFav(n, rec);
}

/** Time token at the right edge of an item row (timeDisplay: none | compact | full). Updated in place by the minute ticker. */
function paintItemTime(n, rec) {
  const tk = itemToken(rec, Date.now(), S.settings.timeDisplay || 'compact', S.lang || 'th', STR);
  const el = n._tm;
  el.classList.toggle('off', !tk);
  if (!tk) { el.textContent = ''; delete el.dataset.t; return; }
  el.textContent = tk.text;
  el.dataset.t = String(tk.t);
  el.dataset.k = tk.k;
  el.classList.toggle('lt', !!tk.light);
  el.classList.toggle('fl', tk.k === 'f');
  if (tk.k === 'f') { el.dataset.l = tk.light ? '1' : '0'; el.dataset.o = String(tk.ref2 || 0); el.dataset.p = tk.ap ? '1' : '0'; }
}

/** Icon of a row: one shared blob url per host (cache hit) or a coloured letter avatar while unknown / for misses. */
/** What is written next to a tab title: the host (default), a shortened url, the full url or nothing. */
function urlShown(url) {
  const mode = S.settings.urlDisplay;
  if (mode === 'none') return '';
  if (mode === 'full') return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (mode === 'short') { const t = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); return t.length > 48 ? t.slice(0, 47) + '…' : t; }
  return hostFor(url);
}

function paintFav(n, rec) {
  if (!favsOn()) { n._fb.hidden = true; return; }
  n._fb.hidden = false;
  const host = hostFor(rec.url) || '';
  if (n._fh !== host) {
    n._fh = host;
    const a = avatarOf(host);
    n._av.textContent = a.ch;
    n._av.dataset.h = String(a.hue);
    n._fu = null;
  }
  if (favs.atlas) {
    const c = host ? favs.cellFor(host, rec.url) : -1;
    if (c >= 0) { if (n._fc !== c) { n._fc = c; favs.cellStyle(n._fb, c); } n._fb.classList.add('has'); } else { n._fc = -1; n._fb.classList.remove('has'); }
    return;
  }
  const u = host ? favs.iconFor(host, rec.url) : null;
  if (u) {
    if (n._fu !== u) { n._fu = u; n._img.src = u; }
    n._fb.classList.add('has');
  } else {
    n._fb.classList.remove('has');
    n._fu = null;
  }
}

const favsOn = () => S.settings.showFavicons !== false;

function refreshFavHost(host) {
  if (host == null) { // atlas exported / loaded from the cache: repaint every live row once
    for (const n of V.live.values()) {
      if (n._kind === 'item' && n._frec) paintFav(n, n._frec);
      else if (n._kind === 'group' && n._stackHosts) { const g = groupOf(n.dataset.g); if (g) paintStack(n, g); }
    }
    return;
  }
  for (const n of V.live.values()) {
    if (n._kind === 'item' && n._fh === host && n._frec) paintFav(n, n._frec);
    else if (n._kind === 'group' && n._stackHosts && n._stackHosts.includes(host)) { const g = groupOf(n.dataset.g); if (g) paintStack(n, g); }
  }
}

/** text with <mark> ranges (built from text nodes: never innerHTML). `shift` is added to every range offset. */
function setMarked(el, text, ranges, shift) {
  el.textContent = '';
  let pos = 0;
  for (const [a0, b0] of ranges) {
    const a = Math.max(pos, Math.min(text.length, a0 + shift));
    const b = Math.max(a, Math.min(text.length, b0 + shift));
    if (b <= a) continue;
    if (a > pos) el.appendChild(document.createTextNode(text.slice(pos, a)));
    el.appendChild(mk('mark', '', text.slice(a, b)));
    pos = b;
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  if (!el.firstChild) el.textContent = text;
}

function fillNote(n, r) {
  const t = r.note.t;
  const sig = t + (r.note.v || '');
  if (n._sig === sig) return;
  n._sig = sig;
  n.className = 'vrow note ' + t;
  n._label.textContent = t === 'sep' ? STR.searchSimilar : '';
  n._btn.hidden = t !== 'more';
}

function fillSub(n, r) {
  const g = r.g;
  const sg = r.seg;
  const def = tgDefOf(g, sg.tg) || { title: '', color: 'grey', collapsed: false };
  const wl = sg.ws && g.windowCount > 1 ? STR.windowN(sg.w) : '';
  const sig = [g.id, sg.tg, sg.n, def.title, def.color, def.collapsed, wl].join('|');
  if (n._sig === sig) return;
  n._sig = sig;
  n.dataset.g = g.id;
  n.dataset.tg = String(sg.tg);
  n.dataset.n = String(sg.n);
  n.className = 'vrow sub' + (wl ? ' wstart' : '');
  if (wl) n.dataset.wl = wl; else delete n.dataset.wl;
  n.dataset.c = def.color;
  n._dot.dataset.c = def.color;
  n._title.textContent = def.title || STR.tgUntitled;
  n._count.textContent = STR.tabsCount(sg.n) + (def.collapsed ? ' · ' + STR.tgCollapsed : '');
}

function fillRow(n, r) {
  n.dataset.kind = r.kind;
  if (r.kind === 'bucket') fillBucket(n, r);
  else if (r.kind === 'sub') fillSub(n, r);
  else if (r.kind === 'group') fillGroup(n, r);
  else if (r.kind === 'note') fillNote(n, r);
  else fillItem(n, r);
  if (selUi) selUi.paintRow(n);
}

/** Hosts of the rows currently in view -> the loader (it drops queued/in-flight hosts that scrolled away). */
function updateFavVisible() {
  if (!favsOn()) return;
  const hosts = new Set();
  for (const n of V.live.values()) {
    if (n._kind === 'group' && n._stackHosts) { for (const h of n._stackHosts) hosts.add(h); continue; }
    if (n._kind !== 'item' || !n._fh) continue; // (live rows are exactly the viewport +- overscan)
    hosts.add(n._fh);
    if (!favs.known(n._fh) && n._frec) paintFav(n, n._frec); // (re)queue unknown hosts: no-op when already queued / loading
  }
  favs.setVisible(hosts);
}

/** Memory guard: letters only (no icon requests, small cache) when RAM is low or the page's heap is large. */
async function checkEconomy() {
  let low = false;
  try {
    const m = await chrome.system.memory.getInfo();
    const ratio = m.availableCapacity / m.capacity;
    low = favs.isDegraded() ? ratio < 0.15 : ratio < 0.10;
  } catch { /* ignore */ }
  try { if (performance.memory && performance.memory.usedJSHeapSize > 300 * 1048576) low = true; } catch { /* ignore */ }
  low = low || lowMem();
  if (low !== favs.isDegraded()) {
    favs.setDegraded(low);
    const b = $('#econ');
    if (b) b.hidden = !low;
    if (!low) for (const n of V.live.values()) if (n._kind === 'item' && n._frec) paintFav(n, n._frec);
  }
}

function focusedRow() {
  const a = document.activeElement;
  if (!a || a === document.body || !spacer.contains(a)) return null;
  return a.closest('.vrow');
}

// ---------- the render pass (one per animation frame) ----------
function schedule() {
  if (!V.raf) V.raf = requestAnimationFrame(update);
}

function update() {
  V.raf = 0;
  V.tick++;
  const st = scroller.scrollTop;
  const ch = scroller.clientHeight;
  V.scrollTop = st;
  const y0 = Math.max(0, st - OVERSCAN);
  const y1 = st + ch + OVERSCAN;
  const rows = V.mode === 'search' ? rowsSearch(y0, y1) : V.mode === 'flat' ? rowsFlat(y0, y1) : rowsGroups(y0, y1);
  const want = new Set();
  for (const r of rows) want.add(r.key);
  const keep = focusedRow();
  for (const [k, n] of V.live) {
    if (!want.has(k) && (n !== keep || (n._top >= y0 - 120 && n._top <= y1))) { release(n); V.live.delete(k); } // a focused row is only kept while scrolled out of the window; one inside it that is no longer wanted is stale (deleted by drag/delete) and would sit there as a lone row
  }
  for (const r of rows) {
    let n = V.live.get(r.key);
    if (!n) {
      n = acquire(r.kind);
      n._key = r.key;
      n._sig = null;
      V.live.set(r.key, n);
    }
    fillRow(n, r);
    if (n._top !== r.top) { n.style.transform = `translateY(${r.top}px)`; n._top = r.top; }
  }
  updateSticky(st);
  // fling detection: pause icon loads while the list moves faster than 1.5 viewports per 100 ms, resume 120 ms after it settles
  const now = performance.now();
  if (V.lastT) {
    const dt = now - V.lastT;
    if (dt > 0 && (Math.abs(st - V.lastSt) / dt) * 100 > ch * 1.5) {
      favs.setPaused(true);
      clearTimeout(V.favResume);
      V.favResume = setTimeout(() => favs.setPaused(false), 120);
    }
  }
  V.lastT = now;
  V.lastSt = st;
  updateFavVisible();
}

// ---------- sticky current-group header ----------
const stickyEl = $('#sticky');
const sticky = {
  toggle: actBtn('toggle', '▾', 'toggle', STR.collapse),
  title: mk('span', 'stitle'),
  count: mk('span', 'scount'),
  open: actBtn('openGroup', STR.openGroup),
  gid: null,
  sig: '',
};
stickyEl.append(sticky.toggle, sticky.title, sticky.count, sticky.open);

function updateSticky(st) {
  let g = null;
  if (V.mode === 'groups' && S.groups.length) {
    const i = locate(st);
    const cand = S.groups[i];
    const itemsStart = V.tops[i] + (V.bucketAt[i] ? H.bucket : 0) + H.group;
    if (isOpen(cand) && cand.count > 0 && st > itemsStart - 1 && st < V.tops[i + 1] - H.item) g = cand;
  }
  if (!g) { if (!stickyEl.hidden) stickyEl.hidden = true; sticky.gid = null; return; }
  const sig = [g.id, g.title, g.count, g.windowCount].join('|');
  if (sig !== sticky.sig) {
    sticky.sig = sig;
    sticky.title.textContent = g.title || fmtDate(g.createdAt);
    sticky.count.textContent = (g.windowCount > 1 ? STR.windowsBadge(g.windowCount) + ' · ' : '') + STR.tabsCount(g.count);
    sticky.open.textContent = g.windowCount > 1 ? STR.openSession : STR.openGroup;
    sticky.open.dataset.act = g.windowCount > 1 ? 'openSession' : 'openGroup';
  }
  stickyEl.dataset.g = g.id;
  sticky.gid = g.id;
  stickyEl.style.right = scroller.offsetWidth - scroller.clientWidth + 'px';
  if (stickyEl.hidden) stickyEl.hidden = false;
}

// ---------- layout changes with scroll anchoring ----------
function captureAnchor() {
  if (V.mode !== 'groups' || !S.groups.length) return null;
  const st = scroller.scrollTop;
  const i = locate(st);
  return { gid: S.groups[i].id, off: st - V.tops[i] };
}

function restoreAnchor(a) {
  if (!a) return;
  const i = V.idxOf.get(a.gid);
  if (i === undefined) return;
  const max = Math.max(V.tops[i], V.tops[i + 1] - 1);
  scroller.scrollTop = Math.min(max, V.tops[i] + a.off);
}

function relayout(anchor = captureAnchor()) {
  layout();
  restoreAnchor(anchor);
  schedule();
}

async function toggleGroup(gid, vk) {
  if (!V.exp.has(gid)) {
    if (lowMem()) return toast(STR.lowMemHint);
    try { await ensureRuns(groupOf(gid)); } catch { /* flat list */ }
  }
  const i = V.vIdx.has(vk || gid) ? V.vIdx.get(vk || gid) : V.idxOf.get(gid);
  if (i === undefined) return null;
  // keep the group header where it is on screen while its rows appear/disappear
  const headerOff = Math.max(0, V.tops[i] + (V.bucketAt[i] ? H.bucket : 0) - scroller.scrollTop);
  if (V.exp.has(gid)) {
    V.exp.delete(gid);
    dropCache([gid]);
  } else {
    if (lowMem()) return toast(STR.lowMemHint);
    V.exp.add(gid);
    ensurePage(gid, 0); // start the first page fetch right away (do not wait for the next frame)
  }
  layout();
  const j = V.vIdx.has(vk || gid) ? V.vIdx.get(vk || gid) : V.idxOf.get(gid);
  scroller.scrollTop = Math.max(0, V.tops[j] + (V.bucketAt[j] ? H.bucket : 0) - headerOff);
  for (const [, n] of V.live) if (n._kind === 'group' && n.dataset.g === gid) n._sig = null;
  schedule();
  return null;
}

// ---------- header / panels ----------
function renderTotals() {
  let m = 0;
  for (const g of S.ugroups) m += g.count;
  const gb = ((S.discarded * MB_PER_TAB_EST) / 1024).toFixed(1);
  $('#totals').textContent = STR.totals(S.ugroups.length, m, S.discarded, gb);
  const nf = new Intl.NumberFormat('en-US');
  const mb = S.discarded * MB_PER_TAB_EST;
  $('#stSets').textContent = nf.format(S.ugroups.length);
  $('#stTabs').textContent = nf.format(m);
  $('#stSleep').textContent = nf.format(S.discarded);
  $('#stRam').textContent = mb > 0 ? '≈' + (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB') : '—';
  for (const el of document.querySelectorAll('.sidefoot .navi')) { const l = el.querySelector('.nl'); if (l) el.title = l.textContent; } // rail width: icon + tooltip
}

/** Big save (20+ tabs, setting `celebrate`): one toast with the count and the RAM given back; the numbers count up unless motion is reduced. */
function celebrateCheck() {
  const ls = S.meta && S.meta.lastStash;
  if (!ls || !ls.at || ls.at <= (S.celebAt || 0)) return;
  S.celebAt = ls.at;
  if (!S.settings.celebrate || Date.now() - ls.at > 20000) return;
  const gids = ls.groupIds && ls.groupIds.length ? ls.groupIds : [ls.groupId];
  const n = gids.reduce((a, id) => { const g = groupOf(id); return a + (g ? g.count : 0); }, 0);
  if (n < 20) return;
  const ram = (k) => { const mb = k * MB_PER_TAB_EST; return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'; };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { toast(STR.celebrate(n, ram(n)), null, null, 6000); return; }
  const t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / 700); const k = Math.round(n * (1 - (1 - p) * (1 - p))); toast(STR.celebrate(k, ram(k)), null, null, 6000); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

function renderUndoBtn() {
  const ls = S.meta && S.meta.lastStash;
  celebrateCheck();
  $('#btnUndoStash').hidden = !(ls && S.groups.some((g) => g.id === ls.groupId));
}

function setBanner(id, text, buttons) {
  const el = $(id);
  el.textContent = '';
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.appendChild(document.createTextNode(text));
  for (const [act, label] of buttons || []) el.appendChild(actBtn(act, label));
}

// Long notices never grow without bound and never get their own scrollbar: past ~3 lines they are clamped with a 'ดูเพิ่ม' toggle.
function fitBanners() {
  const P = $('#panels');
  P.classList.remove('tight', 'foldon');
  for (const c of P.querySelectorAll(':scope > .folded')) c.classList.remove('folded');
  const old = P.querySelector(':scope > .foldbar'); if (old) old.remove();
  fitBannerPass(3);
  if (P.offsetHeight > innerHeight * 0.45) { P.classList.add('tight'); fitBannerPass(1); } // too many notices at once: one line each, so the list below always keeps room
  if (P.offsetHeight > innerHeight * 0.45) { // still too tall: show the first two, fold the rest behind one 'ดูเพิ่ม' row
    const vis = [...P.children].filter((c) => !c.hidden);
    if (vis.length > 2) {
      const expanded = P.classList.contains('expanded');
      const bar = actBtn('foldToggle', expanded ? STR.seeLess : STR.foldMore(vis.length - 2), 'foldbar');
      bar.setAttribute('aria-expanded', String(expanded));
      if (!expanded) { for (const c of vis.slice(2)) c.classList.add('folded'); P.classList.add('foldon'); }
      P.insertBefore(bar, vis[2]);
    }
  }
}
function fitBannerPass(maxLines) {
  for (const el of document.querySelectorAll('#panels .banner')) {
    const tg = el.querySelector(':scope > .bmore');
    if (el.hidden) { if (tg) tg.remove(); continue; }
    let bt = el.querySelector(':scope > .bt');
    if (!bt) {
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!tn) continue;
      bt = mk('span', 'bt'); el.insertBefore(bt, tn); bt.appendChild(tn);
    }
    el.classList.remove('clamp');
    const long = bt.getBoundingClientRect().height > maxLines * parseFloat(getComputedStyle(bt).lineHeight || '20') + 2;
    const open = el.classList.contains('open');
    el.classList.toggle('clamp', long && !open);
    if (long) {
      if (!tg) { const b = actBtn('bannerMore', open ? STR.seeLess : STR.seeMore, 'bmore'); b.setAttribute('aria-expanded', String(open)); el.appendChild(b); }
      else { tg.textContent = open ? STR.seeLess : STR.seeMore; tg.setAttribute('aria-expanded', String(open)); }
    } else if (tg) tg.remove();
  }
}
function renderBanners() {
  const m = S.meta || {};
  setBanner('#bannerVault', m.vaultMissing > 0 ? STR.vaultMissing(m.vaultMissing) : '', [['vaultRebuild', STR.vaultRecover]]);
  const err = m.migration && m.migration.error;
  setBanner('#bannerMig', err ? STR.migError(err) : '');
}

function renderDrain() {
  const d = S.drain;
  const panel = $('#drainPanel');
  const rp = $('#restartPanel');
  rp.hidden = !(d && d.needsConfirm);
  if (d && d.needsConfirm) $('#restartText').textContent = STR.restartText(Math.max(0, d.total - d.closed - d.skipped));
  if (!d || d.needsConfirm) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.toggle('slow', !!(d.level && d.level !== 'healthy'));
  if (d.phase === 'writing') {
    $('#drainText').textContent = STR.drainWriting(d.done, d.total);
    $('#drainBar').style.width = (d.total ? Math.round((d.done / d.total) * 100) : 0) + '%';
    $('#btnDrainPause').hidden = true;
    $('#btnDrainResume').hidden = true;
    return;
  }
  const why = d.paused === 'stalled' ? STR.drainWhyStalled : STR.drainWhyUser;
  const slow = !d.paused && d.lastProgressAt && Date.now() - d.lastProgressAt > 10000;
  $('#drainText').textContent = (d.paused
    ? STR.drainPausedText(d.closed, d.total, why)
    : STR.drainText(d.closed, d.total, d.discarded, d.skipped, STR.levels[d.level] || d.level || '', d.free == null ? null : d.free)) + (slow ? ' · ' + STR.drainSlow : '');
  $('#drainBar').style.width = (d.total ? Math.round(((d.closed + d.skipped) / d.total) * 100) : 0) + '%';
  $('#btnDrainPause').hidden = !!d.paused;
  $('#btnDrainResume').hidden = !d.paused;
}

function renderRefresh() {
  const j = S.refresh;
  const panel = $('#refreshPanel');
  if (!j) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#refreshText').textContent = STR.refreshText(j.done, j.total, j.skipped, j.paused);
  $('#refreshBar').style.width = (j.total ? Math.round((j.done / j.total) * 100) : 0) + '%';
}

function renderJob() {
  const j = S.job;
  const panel = $('#jobPanel');
  if (!j) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#jobText').textContent = STR.jobText(j.done, j.total, j.paused, j.interrupted);
  $('#jobBar').style.width = (j.total ? Math.round((j.done / j.total) * 100) : 0) + '%';
}

async function openActOffDialog() {
  let c = { days: 0, events: 0, tracked: 0, trackingNow: 0 };
  try { const r = await send({ type: 'act:stats' }); if (r && r.ok !== false) c = { ...c, ...r }; } catch { /* ignore */ }
  $('#actDlgBody').textContent = STR.actOffBody(c);
  $('#actDialog').hidden = false;
}
async function runActPurge() {
  const p = $('#actPurgeProg');
  p.hidden = false; p.textContent = STR.actPurging(0);
  await send({ type: 'act:purge' });
}
async function renderRamInfo() {
  try { const r = await send({ type: 'ram:info' }); $('#ramCalInfo').textContent = STR.sRamCalD(r.mb, r.calibrated); } catch { /* ignore */ }
}
async function exportActivity() {
  const r = await send({ type: 'act:export' });
  if (!r || r.ok === false) return toast(STR.errorPrefix + ((r && r.error) || ''));
  const { ok: _ok, ...data } = r;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'clean-my-ram-stats-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return toast(STR.actExported);
}

function renderSettings() {
  for (const el of document.querySelectorAll('[data-k]')) {
    if (el === document.activeElement) continue;
    const k = el.dataset.k;
    const v = S.settings[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (k === 'whitelist' || k === 'excludeSites') el.value = (v || []).join('\n');
    else el.value = String(v);
  }
  renderRamInfo();
  syncKbList();
}

async function renderDupLog() {
  let log = [];
  let total = 0;
  try {
    const r = await chrome.storage.local.get(['dupLog', 'dupTotal']);
    log = r.dupLog || [];
    total = r.dupTotal || 0;
  } catch { /* ignore */ }
  $('#dupCount').textContent = STR.dupCount(total);
  const box = $('#dupLog');
  box.textContent = '';
  if (!log.length) return;
  box.appendChild(mk('div', 'muted', STR.dupLogTitle));
  log.slice(0, 20).forEach((e, i) => {
    const row = mk('div', 'r');
    row.appendChild(mk('span', '', (e.title || e.url).slice(0, 90)));
    const b = actBtn('dupOpen', STR.dupOpen);
    b.dataset.i = String(i);
    row.appendChild(b);
    box.appendChild(row);
  });
  const foot = mk('div', 'row');
  foot.append(actBtn('dupOpenAll', STR.dupOpenAll), actBtn('dupClear', STR.dupClear, 'del'));
  box.appendChild(foot);
}

const TRASH_DAY = 86400000;
S.trashTab = 'all';
S.trashSel = new Set();
S.trashRows = new Map();
S.trashExp = new Map(); // trash row key -> page index of its open tab list (100 tabs per page)
const TR_PAGE = 100;

const trashDaysFor = (reason) => (reason === 'opened' ? S.settings.trashDaysOpened : S.settings.trashDaysDeleted);

/** Rows of the trash page: one per deleted session / emptied shell, and one per (type, source session) for loose tabs. */
function buildTrashRows(tr) {
  const rows = [];
  const reasonOf = (x) => (x && x.delReason === 'opened' ? 'opened' : 'deleted');
  const shells = new Map();
  for (const g of tr.groups) {
    const reason = reasonOf(g);
    const row = { key: 'g:' + g.id, kind: 'session', reason, gid: g.id, tids: [], n: g.count, title: g.title || STR.untitled.replace('…', ''), deletedAt: g.deletedAt, preview: '', gcount: g.count || 0 };
    rows.push(row);
    if (reason === 'opened') shells.set(g.id, row);
  }
  const loose = new Map();
  for (const e of tr.items) {
    const reason = reasonOf(e);
    const n = e.n || (e.items ? e.items.length : 0);
    const sh = reason === 'opened' ? shells.get(e.g) : null;
    let row = sh;
    if (!row) {
      const k = 't:' + reason + ':' + e.g;
      row = loose.get(k);
      if (!row) {
        const src = tr.groups.find((x) => x.id === e.g) || S.groups.find((x) => x.id === e.g);
        row = { key: k, kind: 'tabs', reason, gid: null, from: src ? (src.title || '') : '', tids: [], n: 0, title: '', deletedAt: e.deletedAt, preview: '' };
        loose.set(k, row); rows.push(row);
      }
    }
    row.tids.push(e.tid);
    if (e.items && e.items.length) (row.mem || (row.mem = [])).push(...e.items);
    if (row.kind === 'tabs' || sh) row.n += (row.kind === 'session' ? n : n);
    row.deletedAt = row.kind === 'session' ? row.deletedAt : Math.min(row.deletedAt, e.deletedAt);
    if (!row.preview && e.items && e.items.length) row.preview = e.items.slice(0, 3).map((x) => x.title || x.url).join(' · ');
  }
  rows.sort((a, b) => b.deletedAt - a.deletedAt);
  return rows;
}

function trashCounts(rows, reason) {
  let sessions = 0; let tabs = 0;
  for (const r of rows) {
    if (reason && r.reason !== reason) continue;
    if (r.kind === 'session') sessions++;
    tabs += r.n;
  }
  return { sessions, tabs };
}

function selectedTrashRows() { return [...S.trashSel].map((k) => S.trashRows.get(k)).filter(Boolean); }
function rowsOf(btn) { const r = S.trashRows.get(btn.closest('.trrow') ? btn.closest('.trrow').dataset.k : ''); return r ? [r] : []; }

/** One page (<= 100) of the tabs inside a trash row: the session's own records (read from the database by position), then loose records kept in the trash. */
async function trashRowPage(r, start, n) {
  const out = [];
  const gc = r.kind === 'session' ? r.gcount || 0 : 0;
  if (start < gc) out.push(...await db.getItemsByPos(r.gid, start, Math.min(n, gc - start)));
  if (out.length < n && r.mem) out.push(...r.mem.slice(Math.max(0, start - gc), Math.max(0, start - gc) + n - out.length));
  return out;
}

async function fillTrashDetail(det, r, page) {
  const first = page * TR_PAGE;
  const total = r.n;
  let rows = [];
  try { rows = await trashRowPage(r, first, TR_PAGE); } catch { rows = []; }
  det.textContent = '';
  const list = mk('div', 'trlist-in');
  list.setAttribute('role', 'list');
  if (!rows.length) list.appendChild(mk('div', 'trit muted', STR.trNoDetail));
  for (const it of rows) {
    const line = mk('div', 'trit');
    line.setAttribute('role', 'listitem');
    const host = hostFor(it.url || '');
    line.append(mk('span', 'trit-t', it.title || it.url || ''), mk('span', 'trit-h muted', host || ''));
    line.title = it.url || '';
    list.appendChild(line);
  }
  det.appendChild(list);
  if (total > TR_PAGE) {
    const bar = mk('div', 'trpager');
    const prev = actBtn('trPage', '‹ ' + STR.trPrev); prev.dataset.d = '-1'; prev.disabled = page <= 0;
    const next = actBtn('trPage', STR.trNext + ' ›'); next.dataset.d = '1'; next.disabled = first + TR_PAGE >= total;
    bar.append(prev, mk('span', 'muted', STR.trRange(first + 1, Math.min(total, first + TR_PAGE), total)), next);
    det.appendChild(bar);
  }
}

function toggleTrashDetail(btn) {
  const row = btn.closest('.trrow');
  const r = row && S.trashRows.get(row.dataset.k);
  if (!r) return;
  const det = row.querySelector('.trdetail');
  const open = !S.trashExp.has(r.key);
  if (open) S.trashExp.set(r.key, 0); else S.trashExp.delete(r.key);
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '▾' : '▸';
  btn.title = btn.getAttribute('aria-label') + '';
  det.hidden = !open;
  if (open) fillTrashDetail(det, r, 0); else det.textContent = '';
}

function pageTrashDetail(btn) {
  const row = btn.closest('.trrow');
  const r = row && S.trashRows.get(row.dataset.k);
  if (!r) return;
  const p = Math.max(0, (S.trashExp.get(r.key) || 0) + Number(btn.dataset.d));
  S.trashExp.set(r.key, p);
  fillTrashDetail(row.querySelector('.trdetail'), r, p);
}

function trashBulkBtns() {
  const n = S.trashSel.size;
  $('#trashSelN').textContent = STR.trSelN(n);
  for (const id of ['bulkRecover', 'bulkOpen', 'bulkPurge']) $('#' + id).disabled = !n;
}

async function renderTrash() {
  S.trash = await db.listTrash();
  const all = buildTrashRows(S.trash);
  S.trashRows = new Map(all.map((r) => [r.key, r]));
  for (const k of [...S.trashSel]) if (!S.trashRows.has(k)) S.trashSel.delete(k);
  const tab = S.trashTab || 'all';
  const rows = all.filter((r) => tab === 'all' || r.reason === tab);
  const cAll = trashCounts(all, ''); const cDel = trashCounts(all, 'deleted'); const cOpen = trashCounts(all, 'opened');
  const setTab = (id, label, c, on) => { const b = $('#' + id); b.textContent = `${label} (${c.tabs})`; b.setAttribute('aria-selected', String(on)); b.classList.toggle('on', on); };
  setTab('tabAll', STR.trTabAll, cAll, tab === 'all');
  setTab('tabDeleted', STR.trTabDeleted, cDel, tab === 'deleted');
  setTab('tabOpened', STR.trTabOpened, cOpen, tab === 'opened');
  const cur = tab === 'all' ? cAll : tab === 'deleted' ? cDel : cOpen;
  const clr = $('#btnClearType');
  clr.textContent = tab === 'all' ? STR.trClearAll(STR.trCounts(cur.sessions, cur.tabs)) : STR.trClearType(tab === 'opened' ? STR.trTabOpened : STR.trTabDeleted, STR.trCounts(cur.sessions, cur.tabs));
  clr.dataset.reason = tab === 'all' ? '' : tab;
  clr.disabled = !rows.length;
  $('#bulkRecover').textContent = STR.trRecover; $('#bulkOpen').textContent = STR.trOpenAgain; $('#bulkPurge').textContent = STR.trPurge;
  const sa = $('#trashAll');
  sa.checked = rows.length > 0 && rows.every((r) => S.trashSel.has(r.key));
  const tl = $('#trashList');
  tl.textContent = '';
  if (!rows.length) tl.appendChild(mk('div', 'muted', STR.trEmpty));
  const now = Date.now();
  const LIM = 300;
  for (const r of rows.slice(0, LIM)) {
    const row = mk('div', 'trrow');
    row.dataset.k = r.key;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'trcb'; cb.checked = S.trashSel.has(r.key);
    cb.setAttribute('aria-label', r.title || r.from || '');
    const main = mk('div', 'trmain');
    const head = mk('div', 'trhead');
    const badge = mk('span', 'trbadge ' + r.reason, r.reason === 'opened' ? STR.trBadgeOpened : STR.trBadgeDeleted);
    const xb = actBtn('trExpand', '▸', 'trexp');
    xb.setAttribute('aria-label', STR.trShowTabs); xb.title = STR.trShowTabs; xb.setAttribute('aria-expanded', 'false');
    if (!(r.n > 0)) xb.hidden = true;
    head.append(xb, badge, mk('span', 'trtitle', r.kind === 'session' ? r.title : STR.trTabs(r.n, r.from)));
    const days = trashDaysFor(r.reason);
    const left = days > 0 ? Math.ceil((r.deletedAt + days * TRASH_DAY - now) / TRASH_DAY) : null;
    const meta = [fmtDate(r.deletedAt)];
    if (r.kind === 'session') meta.push(STR.trSession(r.n));
    meta.push(left == null ? STR.trNever : STR.trExpires(left));
    main.append(head, mk('div', 'trmeta muted', meta.join(' · ')));
    if (r.preview) main.appendChild(mk('div', 'trprev muted', r.preview));
    const det = mk('div', 'trdetail');
    det.hidden = true;
    main.appendChild(det);
    if (S.trashExp.has(r.key) && r.n > 0) { det.hidden = false; xb.setAttribute('aria-expanded', 'true'); xb.textContent = '▾'; fillTrashDetail(det, r, S.trashExp.get(r.key)); }
    const acts = mk('div', 'tracts');
    const b1 = actBtn('trashRecover', STR.trRecover); b1.classList.add('primary');
    acts.append(b1, actBtn('trashOpen', STR.trOpenAgain), actBtn('trashPurge', STR.trPurge, 'del'));
    row.append(cb, main, acts);
    tl.appendChild(row);
  }
  if (rows.length > LIM) tl.appendChild(mk('div', 'muted', STR.trMore(rows.length - LIM)));
  trashBulkBtns();
  syncClearButtons(all);
}

/** Settings page 'ล้างตอนนี้' buttons carry the exact counts. */
function syncClearButtons(all) {
  const d = trashCounts(all, 'deleted'); const o = trashCounts(all, 'opened');
  const bd = $('#btnClearDeleted'); const bo = $('#btnClearOpened');
  if (bd) { bd.textContent = STR.trClearNow(STR.trTabDeleted, STR.trCounts(d.sessions, d.tabs)); bd.disabled = !(d.sessions || d.tabs); }
  if (bo) { bo.textContent = STR.trClearNow(STR.trTabOpened, STR.trCounts(o.sessions, o.tabs)); bo.disabled = !(o.sessions || o.tabs); }
}

async function trashClearType(reason) {
  const all = buildTrashRows(await db.listTrash());
  const c = trashCounts(all, reason);
  if (!c.sessions && !c.tabs) return null;
  const msg = reason ? STR.trConfirmClear(reason === 'opened' ? STR.trTabOpened : STR.trTabDeleted, c.sessions, c.tabs) : STR.trConfirmClearAll(c.sessions, c.tabs);
  if (!confirm(msg)) return null;
  const r = await send(reason ? { type: 'trashEmptyType', reason } : { type: 'emptyTrash' });
  if (!r.ok) return toastError(r);
  S.trashSel = new Set();
  return renderTrash();
}

async function trashDo(what, rows) {
  if (!rows.length) return null;
  const gids = rows.filter((r) => r.gid).map((r) => r.gid);
  const tids = rows.flatMap((r) => r.tids);
  if (what === 'purge') {
    const tabs = rows.reduce((a, r) => a + r.n, 0);
    if (!confirm(STR.trConfirmPurge(rows.length) + (tabs ? ` (${tabs} แท็บ)` : ''))) return null;
    const r = await send({ type: 'trashPurge', gids, tids });
    if (!r.ok) return toastError(r);
  } else if (what === 'recover') {
    const r = await send({ type: 'trashRecover', gids, tids });
    if (!r.ok) return toastError(r);
    toast(STR.trRecovered(r.recovered || 0), null, null, 3000);
  } else if (what === 'open') {
    const n = rows.reduce((a, r) => a + r.n, 0);
    if (n > CONFIRM_MANY && !confirm(STR.confirmMany(n))) return null;
    const r = await send({ type: 'trashOpen', gids, tids });
    if (!r.ok) return toastError(r);
    if (r.failed) toast(STR.restoreFailed(r.failed));
    return null;
  }
  S.trashSel = new Set();
  return renderTrash();
}

function renderChrome() {
  applyTheme();
  renderTotals();
  renderUndoBtn();
  renderBanners();
  renderDrain();
  renderJob();
  renderRefresh();
  renderSettings();
  if (S.view === 'settings') { refreshStorage(); renderDupLog(); }
  if (S.view === 'trash') renderTrashView();
  renderNav();
  renderViewTitle();
}

// ---------- incremental sync after data changes ----------
async function syncGroups() {
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('gtitle')) { S.dirtyWhileEditing = true; return; }
  const changed = S.changed;
  S.changed = new Set();
  const anchor = captureAnchor();
  await loadData();
  const present = new Set(S.groups.map((g) => g.id));
  for (const gid of [...V.exp]) if (!present.has(gid)) V.exp.delete(gid);
  for (const gid of [...V.cache.keys()]) if (!present.has(gid)) dropCache([gid]);
  if (changed.has('all')) dropCache('all'); else dropCache([...changed]);
  for (const gid of [...V.runs.keys()]) if (!present.has(gid) || changed.has('all') || changed.has(gid)) V.runs.delete(gid);
  for (const [, n] of V.live) n._sig = null;
  if (!S.initialExpandDone && S.allGroups.length) await initialExpand();
  // sessions that appeared since the last refresh follow the default-expand setting
  if (S.settings.defaultExpand === 'all') for (const g of S.allGroups) if (!S.seen.has(g.id)) { S.seen.add(g.id); if (g.count > 0) V.exp.add(g.id); }
  S.trashLoaded = false;
  loadTrashCounts();
  relayout(anchor);
  renderChrome();
  if (S.query) runSearch();
}

function scheduleSync(groups) {
  V.writeCtr++;
  if (groups === 'all' || !groups) S.changed.add('all');
  else for (const g of groups) S.changed.add(g);
  clearTimeout(S.syncTimer);
  S.syncTimer = setTimeout(async () => {
    try { await syncGroups(); } catch { /* ignore */ }
    refreshStats();
  }, 150);
}

async function initialExpand() {
  S.initialExpandDone = true;
  applyDefaultExpand();
}

async function loadTrashCounts() {
  try { S.trash = await db.listTrash(); renderNav(); syncClearButtons(buildTrashRows(S.trash)); } catch { /* ignore */ }
}

// ---------- search (results are virtual rows too; the work happens in search-worker.js) ----------
// The worker streams {rows} batches for the current request id: exact matches first, then (after a short idle) the
// typo-tolerant ones behind a separator row. Rows are only ever APPENDED, so the order never jumps while typing/scrolling.
const SRCH = { client: null, id: 0, cur: null, status: { state: 'init', progress: 0, docs: 0 }, v: 0, timer: 0, rafPending: false };
globalThis.__cmr.SRCH = SRCH;

function searchInfoText() {
  const st = SRCH.status;
  if (st.state === 'building') return STR.searchIndexing(st.progress || 0);
  if (st.state === 'loading' || st.state === 'init') return STR.searchLoading;
  if (st.state === 'error') return STR.searchIdxErr(st.error || '?');
  return '';
}

function connectSearchWorker() {
  SRCH.connectAt = Math.round(performance.now());
  SRCH.client = connectSearch(onSearchMessage);
  const k = lockrt.getKeys();
  if (k) SRCH.client.post({ type: 'keys', keys: { dk: k.dk, xk: k.xk, hk: k.hk, sk: k.sk } }); // lock on: the worker decrypts with the page's non-extractable keys
}

function onSearchMessage(m) {
  if (!m) return;
  if (m.type === 'status') {
    const was = SRCH.status.state;
    SRCH.status = m;
    if (m.state === 'ready' && !SRCH.readyAt) SRCH.readyAt = Math.round(performance.now());
    const info = $('#indexInfo');
    if (info) info.textContent = STR.indexInfo(m.docs || 0, m.approxMB || 0, m.state);
    if (SRCH.cur && was !== 'ready' && m.state === 'ready' && SRCH.cur.mode === 'scan') startSearch(SRCH.cur.q); // upgrade scan results to indexed ones
    else if (SRCH.cur) renderSearchInfo();
    return;
  }
  if (m.type === 'ackLog') { send({ type: 'ixlogTrim', upto: m.upto }); return; }
  const cur = SRCH.cur;
  if (!cur || m.id !== cur.id) return;
  if (m.type === 'rows') {
    beginResults(cur);
    if (m.phase === 'fuzzy' && !cur.sep) { cur.sep = true; V.srows.push({ t: 'sep' }); }
    const mrows = S.vs.flat ? m.rows.filter((r) => S.allowedIds.has(r.g)) : m.rows; // flat view: nav / filters apply to search too
    for (const r of mrows) V.srows.push({ t: 'hit', rec: r, fuzzy: r.fuzzy, hl: r.hl, v: ++SRCH.v });
    cur.hits += mrows.length;
    if (mrows.some((r) => r.fuzzy)) cur.fuzzy += mrows.length;
    if (!cur.firstMs) { cur.firstMs = Math.round(performance.now() - cur.t0); globalThis.__cmr.timing.searchFirstMs = cur.firstMs; }
    searchLayoutSoon();
  } else if (m.type === 'end') {
    beginResults(cur);
    cur.ms = m.ms;
    cur.mode = m.mode;
    cur.ended = true;
    cur.hasMore = !!m.hasMore;
    cur.exactCount = m.exactCount;
    cur.fuzzyCount = m.fuzzyCount;
    globalThis.__cmr.timing.searchTotalMs = Math.round(performance.now() - cur.t0);
    V.srows = V.srows.filter((r) => r.t !== 'more');
    if (cur.hasMore) V.srows.push({ t: 'more' });
    searchLayoutSoon();
    renderSearchInfo();
  } else if (m.type === 'error') {
    cur.ended = true;
    renderSearchInfo(m.message);
  }
}

function beginResults(cur) {
  if (cur.started) return;
  if (selUi) selUi.clear();
  cur.started = true;
  if (V.mode !== 'search') V.savedScroll = scroller.scrollTop;
  V.mode = 'search';
  V.srows = [];
  V.hits = V.srows;
  scroller.scrollTop = 0;
  for (const [k, n] of V.live) { release(n); V.live.delete(k); }
}

function searchLayoutSoon() {
  if (SRCH.rafPending) return;
  SRCH.rafPending = true;
  requestAnimationFrame(() => {
    SRCH.rafPending = false;
    if (V.mode !== 'search') return;
    layout();
    $('#emptyMsg').hidden = V.srows.length > 0;
    schedule();
    renderSearchInfo();
  });
}

function renderSearchInfo(err) {
  const cur = SRCH.cur;
  const info = $('#searchInfo');
  if (!cur) { info.hidden = true; return; }
  info.hidden = false;
  const extra = searchInfoText();
  let text;
  if (err) text = STR.errorPrefix + err;
  else if (!cur.started) text = extra || '…';
  else if (!cur.hits && cur.ended) {
    text = SRCH.status.state === 'building' ? STR.noMatchBuilding : STR.noMatch;
    $('#emptyMsg').hidden = false;
    $('#emptyMsg').textContent = text;
  } else {
    const fz = cur.fuzzy || 0;
    text = fz ? STR.searchWithFuzzy(cur.hits, fz, cur.ms == null ? Math.round(performance.now() - cur.t0) : cur.ms) : STR.searchExact(cur.hits, cur.ms == null ? Math.round(performance.now() - cur.t0) : cur.ms);
    if (!cur.ended) text += ' …';
    if (extra) text += ' · ' + extra;
  }
  info.textContent = text;
}

function leaveSearch() {
  if (SRCH.cur) { SRCH.client && SRCH.client.post({ type: 'cancel', id: SRCH.cur.id }); SRCH.cur = null; }
  $('#searchInfo').hidden = true;
  if (V.mode !== 'search') return;
  if (selUi) selUi.clear();
  V.mode = S.vs.flat ? 'flat' : 'groups';
  V.srows = [];
  V.hits = V.srows;
  for (const [k, n] of V.live) { release(n); V.live.delete(k); }
  layout();
  scroller.scrollTop = V.savedScroll || 0;
  schedule();
}

function startSearch(q) {
  if (!SRCH.client) return;
  if (SRCH.cur) SRCH.client.post({ type: 'cancel', id: SRCH.cur.id });
  const id = ++SRCH.id;
  SRCH.cur = { id, q, t0: performance.now(), started: false, ended: false, hits: 0, fuzzy: 0, sep: false, hasMore: false, mode: 'index', ms: null, firstMs: 0 };
  SRCH.client.post({ type: 'search', id, q, limit: 200 });
  renderSearchInfo();
}

function runSearch() {
  clearTimeout(S.searchTimer);
  const q = $('#search').value.trim();
  S.query = q;
  const info = $('#searchInfo');
  if (!q) { leaveSearch(); return; }
  if (q.length < SEARCH_MIN) { leaveSearch(); info.hidden = false; info.textContent = STR.searchShort; return; }
  if (lowMem()) { info.hidden = false; info.textContent = STR.searchPaused; return; }
  startSearch(q);
}

function onSearchInput() {
  clearTimeout(S.searchTimer);
  // instant when the index is ready (the worker cancels the previous request); a short debounce while it scans
  if (SRCH.status.state === 'ready') runSearch();
  else S.searchTimer = setTimeout(runSearch, 120);
}

function searchMore() {
  const cur = SRCH.cur;
  if (!cur || !cur.hasMore) return;
  cur.hasMore = false;
  cur.ended = false;
  V.srows = V.srows.filter((r) => r.t !== 'more');
  SRCH.client.post({ type: 'more', id: cur.id, limit: 200 });
  searchLayoutSoon();
}

// ↑/↓ move between result links (Enter on a focused link opens it through the normal click handler)
function moveResultFocus(dir) {
  const a = document.activeElement;
  const row = a && a.closest && a.closest('.vrow.item');
  if (!row) return false;
  let i = -1;
  const rows = V.srows;
  for (let k = 0; k < rows.length; k++) { const h = rows[k]; if (h.t === 'hit' && h.rec.g === row.dataset.g && String(h.rec.seq) === row.dataset.seq) { i = k; break; } }
  if (i < 0) return false;
  let j = i + dir;
  while (j >= 0 && j < rows.length && rows[j].t !== 'hit') j += dir;
  if (j < 0 || j >= rows.length) return true;
  const want = j * H.item;
  if (want < scroller.scrollTop) scroller.scrollTop = want;
  else if (want + H.item > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = want + H.item - scroller.clientHeight;
  update();
  const h = rows[j].rec;
  const n = V.live.get('h:' + h.g + ':' + h.seq);
  if (n && n._a) n._a.focus();
  return true;
}


// ---------- organisation UI: navigation, view / filter menus, categories, session menu, trash + settings views ----------
const NAV_KINDS = ['all', 'pinned', 'starred', 'pending', 'uncat', 'stale', 'archived'];
const CAT_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
// ONE popover manager: single open menu, outside pointerdown / Esc / trigger re-click / scroll / blur / resize close it, top-layer rendering
const PM = createPopovers({ scrim: $('#menuScrim') });
const closeMenus = () => PM.close();
const openMenu = () => (PM.current ? PM.current.el : null);
const catById = (id) => S.cats.find((c) => c.id === id) || null;

function setDensity(name) {
  const d = DENS[name] || DENS.comfortable;
  Object.assign(H, d);
  document.documentElement.dataset.density = name === 'compact' ? 'compact' : 'comfortable';
}

function applySettingsToUi() {
  const st = S.settings;
  applyTheme();
  setDensity(st.density);
  $('#shell').dataset.hover = st.hoverActions === 'always' ? 'always' : 'hover';
  try { const fm = st.favMode === 'img' || st.favMode === 'atlas' ? st.favMode : ''; if (fm) localStorage.setItem('cmrFavMode', fm); else localStorage.removeItem('cmrFavMode'); } catch { /* ignore */ }
  favs.setEnabled(favsOn());
  const lang = applyLanguage(STR, Q.L, st.language);
  if (S.lang !== lang) { S.lang = lang; setSyncLang(lang); applyStrings(); if (syncCard) { syncCard = null; const sy = $('#s-sync'); if (sy) { sy.textContent = ''; if (S.view === 'settings') syncCard = mountSyncCard(sy, { send, toast }); } } }
}

// ----- recompute: nav -> filters -> sort -> group-by -----
function recompute() {
  if (selUi) selUi.clear(); // selection keys are positions: any recompute may shift them
  const ctx = Q.makeCtx(S.cats);
  ctx.siteMap = S.siteMap;
  if (S.vs.groupBy === 'tabgroup' && !S.vs.flat) { ctx.tgRuns = (g) => { const b = baseRuns(g); return b ? b.segs : null; }; tgScanKick(); }
  if (S.filters.sites.length && !S.siteMap) ensureSiteMap();
  const filtered = Q.filterGroups(S.allGroups, S.nav, S.filters, ctx);
  const part = Q.partition(filtered, S.vs, ctx);
  S.groups = part.groups;
  V.labels = part.labels;
  S.gById = new Map(S.allGroups.map((g) => [g.id, g]));
  S.allowedIds = new Set(S.groups.map((g) => g.id));
  const seen = new Set();
  S.ugroups = [];
  for (const g of S.groups) if (!seen.has(g.id)) { seen.add(g.id); S.ugroups.push(g.vk ? S.gById.get(g.id) || g : g); }
}

async function ensureSiteMap() {
  if (S.siteMap || S.siteMapLoading) return;
  S.siteMapLoading = true;
  try {
    const rows = await db.listSiteIdx();
    const m = new Map();
    for (const r of rows) { let x = m.get(r.site); if (!x) { x = new Map(); m.set(r.site, x); } x.set(r.g, r.n); }
    S.siteMap = m;
    if (S.filters.sites.length || !$('#filterMenu').hidden) applyView();
  } catch { /* retried at the next filter use */ } finally { S.siteMapLoading = false; }
}

function renderFlatBtn() {
  const b = $('#btnFlat');
  if (!b) return;
  b.setAttribute('aria-pressed', String(!!S.vs.flat));
  b.classList.toggle('on', !!S.vs.flat);
  b.title = S.vs.flat ? STR.flatTipOn : STR.flatTip;
  b.setAttribute('aria-label', b.title);
  const sp = $('#btnSortDir');
  if (sp) sp.classList.toggle('flatmode', !!S.vs.flat);
}

function applyView() {
  const anchor = captureAnchor();
  recompute();
  relayout(anchor);
  renderNav();
  renderChips();
  renderViewTitle();
  renderStaleBanner();
  renderSortBtn();
  renderFlatBtn();
  if (filterPanel && !$('#filterMenu').hidden) filterPanel.render(); // live facet counts while the panel is open
}

function renderViewTitle() {
  const t = S.view === 'dash' ? STR.viewTitles.dash : S.view === 'snaps' ? STR.viewTitles.snaps : S.view === 'settings' ? STR.viewTitles.settings : S.view === 'trash' ? STR.viewTitles.trash : S.nav.kind === 'cat' ? ((catById(S.nav.cat) || {}).name || STR.navCats) : STR.viewTitles[S.nav.kind] || STR.viewTitles.all;
  $('#viewTitle').textContent = t;
  document.title = t + ' · ' + STR.appName;
}

// ----- dashboard view: lazy, same page and sidebar (dashboard.js / dashboard.css load on first open only) -----
let dash = null; let dashLoading = null;
function ensureDash() {
  if (dash) return Promise.resolve(dash);
  if (dashLoading) return dashLoading;
  dashLoading = (async () => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'dashboard.css'; document.head.appendChild(l);
    const m = await import('./dashboard.js');
    await m.mount($('#dashView'), { settings: S.settings, groups: () => S.allGroups, toast: (t) => toast(t) });
    dash = m;
    return m;
  })().catch((e) => { dashLoading = null; throw e; });
  return dashLoading;
}
function setHash(h) { try { if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h); } catch { /* ignore */ } }
/** Ctrl+K: quick actions + search of tab-set titles (lib/palette.js). Not offered while the password lock screen is up. */
function openCommandPalette() {
  if (lockrt.enabled() && lockrt.isLocked()) return;
  const actions = [
    { label: STR.navAll, run: () => navTo('all') }, { label: STR.navPinned, run: () => navTo('pinned') }, { label: STR.navStarred, run: () => navTo('starred') },
    { label: STR.navPending, run: () => navTo('pending') }, { label: STR.navStale, run: () => navTo('stale') }, { label: STR.navArchived, run: () => navTo('archived') },
    { label: STR.navTrash, run: () => navTo('trash') }, { label: STR.navSnaps, run: () => setView('snaps') }, { label: STR.navDash, run: () => setView('dash') },
    { label: STR.palSettings, run: () => setView('settings') }, { label: STR.navAbout, run: () => { location.href = 'about.html'; } },
    { label: STR.expandAll, run: () => { navTo('all'); expandAll(true); } }, { label: STR.collapseAll, run: () => { navTo('all'); expandAll(false); } },
    { label: STR.palStash, run: async () => { const r = await send({ type: 'stashNow', scope: 'all' }); if (r && r.error) toastError(r); } },
  ].filter((a) => a.label);
  openPalette({ actions, sets: S.ugroups.map((g) => ({ id: g.id, title: g.title && g.title.trim() ? g.title : fmtDate(g.createdAt), count: g.count })), t: { label: STR.palLabel, placeholder: STR.palPh, actionsH: STR.palActions, setsH: STR.palSets, empty: STR.palEmpty }, onSet: (id) => { location.hash = '#g=' + encodeURIComponent(id); } });
}

/** Dashboard links ('#g=<id>'): show the All view, expand that tab set and scroll to it. */
async function openSet(gid) {
  navTo('all');
  await new Promise((r) => requestAnimationFrame(r));
  if (!V.idxOf.has(gid)) { toast(STR.setNotHere); return; }
  if (!V.exp.has(gid)) await toggleGroup(gid);
  const i = V.idxOf.get(gid);
  if (i !== undefined) scroller.scrollTop = V.tops[i];
}
function route() {
  const h = location.hash.replace('#', '');
  if (h === 'dashboard') { if (S.view !== 'dash') setView('dash'); } else if (h === 'settings') { if (S.view !== 'settings') setView('settings'); } else if (h === 'stale') navTo('stale'); else if (h.startsWith('g=')) openSet(decodeURIComponent(h.slice(2)));
  else if (h === 'snaps') setView('snaps'); else if (h === 'trash') navTo('trash');
  else if (h === 'list' && S.view !== 'list') navTo(S.nav.kind, S.nav.cat);
}

function setView(v) {
  const prev = S.view;
  if (prev === 'list' && v !== 'list') S.listTop = scroller.scrollTop; // the list keeps its scroll position while another view is open
  if (prev === 'dash' && v !== 'dash' && dash) dash.hide();
  S.view = v;
  $('#dashView').hidden = v !== 'dash';
  setHash(v === 'dash' ? '#dashboard' : v === 'settings' ? '#settings' : v === 'snaps' ? '#snaps' : v === 'trash' ? '#trash' : '');
  $('#vwrap').hidden = v !== 'list';
  $('#trashView').hidden = v !== 'trash';
  $('#settingsView').hidden = v !== 'settings';
  $('#snapView').hidden = v !== 'snaps';
  for (const id of ['.tools', '.searchbox']) { const e = $('.topbar ' + id); if (e) e.style.visibility = v === 'list' ? '' : 'hidden'; }
  closeMenus();
  $('#shell').classList.remove('side-open');
  $('#scrim').hidden = true;
  renderViewTitle();
  renderNav();
  renderStaleBanner();
  renderActBanner();
  if (v === 'trash') renderTrash();
  if (v === 'snaps') renderSnapView();
  if (v === 'dash') { const t0 = performance.now(); ensureDash().then((m) => { if (S.view === 'dash') { m.show(); requestAnimationFrame(() => { globalThis.__cmr.timing.dashOpenMs = Math.round(performance.now() - t0); }); } }).catch(() => toast(STR.dashFail)); }
  if (v === 'settings') { renderSettings(); refreshStorage(); renderDupLog(); renderCommands(); if (!lockCard) lockCard = mountLockCard($('#s-lock'), { toast: (t) => toast(t) }); else lockCard.refresh(); if (!syncCard) syncCard = mountSyncCard($('#s-sync'), { send, toast }); else syncCard.refresh(); }
  if (v === 'list') { relayout(); schedule(); if (prev !== 'list' && S.listTop) scroller.scrollTop = S.listTop; }
}

function navTo(kind, cat) {
  const same = S.view !== 'list' && kind === S.nav.kind && (cat || null) === (S.nav.cat || null); // coming back to the list we left: keep its scroll position
  S.nav = { kind: kind === 'trash' ? S.nav.kind : kind, cat: cat || null };
  if (kind === 'trash') { setView('trash'); return; }
  S.view = 'list';
  setView('list');
  applyView();
  if (!same) scroller.scrollTop = 0;
}

async function loadCats() { S.cats = await db.listCategories(); }

// ----- sidebar -----
function navCounts() {
  const c = { all: 0, pinned: 0, starred: 0, pending: 0, uncat: 0, stale: 0, archived: 0, trash: (S.trash.groups.length + S.trash.items.length) };
  const per = new Map();
  for (const g of S.allGroups) {
    if (g.archived) { c.archived++; continue; }
    c.all++;
    if (g.pinned) c.pinned++;
    if (g.starred) c.starred++;
    if (g.pending) c.pending++;
    if (Q.isStaleGroup(g)) c.stale++;
    if (!g.cat) c.uncat++; else per.set(g.cat, (per.get(g.cat) || 0) + 1);
  }
  return { c, per };
}

function renderNav() {
  const { c, per } = navCounts();
  for (const el of document.querySelectorAll('[data-nc]')) { const n = c[el.dataset.nc]; el.textContent = n ? String(n) : ''; }
  const box = $('#catList');
  const fa = document.activeElement;
  const focusCat = fa && box.contains(fa) && fa.dataset ? fa.dataset.cat : null; // keep keyboard focus across re-renders
  box.textContent = '';
  for (const cat of S.cats) {
    const b = mk('button', 'navi');
    b.type = 'button';
    b.dataset.act = 'navTo';
    b.dataset.nav = 'cat';
    b.dataset.cat = cat.id;
    const dot = mk('span', 'dot');
    dot.dataset.c = cat.color;
    b.append(dot, mk('span', 'nl', cat.name), mk('span', 'nc', per.get(cat.id) ? String(per.get(cat.id)) : ''));
    b.dataset.menuCat = cat.id;
    box.appendChild(b);
    if (focusCat === cat.id) b.focus();
  }
  for (const el of document.querySelectorAll('.nav .navi, .sidefoot .navi')) {
    const k = el.dataset.nav;
    const on = S.view === 'trash' ? k === 'trash' : S.view === 'dash' ? el.dataset.view === 'dash' : S.view === 'snaps' ? el.dataset.view === 'snaps' : S.view === 'settings' ? el.dataset.view === 'settings' : (k === S.nav.kind && (k !== 'cat' || el.dataset.cat === S.nav.cat));
    el.classList.toggle('on', !!on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  }
}

// ----- chips (active filters) -----
function renderChips() {
  const f = S.filters;
  const box = $('#chips');
  box.textContent = '';
  const add = (label, fn) => {
    const c = mk('span', 'chip', label);
    const x = mk('button', '', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'remove');
    x.addEventListener('click', () => { fn(); applyView(); });
    c.appendChild(x);
    box.appendChild(c);
  };
  for (const s of f.sites) add(s, () => { f.sites = f.sites.filter((x) => x !== s); });
  for (const id of f.cats) add((id ? (catById(id) || {}).name : STR.navUncat) || id, () => { f.cats = f.cats.filter((x) => x !== id); });
  for (const k of f.tgs) add(k, () => { f.tgs = f.tgs.filter((x) => x !== k); });
  if (f.dateFrom || f.dateTo) add(rangeLabel(f.dateFrom, f.dateTo, S.lang || 'th', S.settings.dateCalendar) + (f.dateBasis === 'active' ? ' · ' + STR.fBasisActive : ''), () => { f.dateFrom = null; f.dateTo = null; });
  for (const k of Object.keys(f.flags)) if (f.flags[k]) add(STR.flags[k], () => { f.flags[k] = false; });
  box.hidden = !box.childElementCount;
  { const nf = f.sites.length + f.cats.length + f.tgs.length + (f.dateFrom || f.dateTo ? 1 : 0) + Object.values(f.flags).filter(Boolean).length; const bf = $('#btnFilter'); bf.classList.toggle('on', nf > 0); let bd = bf.querySelector('.fbadge'); if (nf && !bd) { bd = mk('span', 'fbadge'); bf.appendChild(bd); } if (bd) { if (nf) bd.textContent = String(nf); else bd.remove(); } bf.setAttribute('aria-label', nf ? `${STR.filterBtn} (${nf})` : STR.filterBtn); }
  if (!box.hidden) {
    let n = 0;
    for (const g of S.ugroups) n += g.count;
    const info = $('#searchInfo');
    if (!S.query) { info.hidden = false; info.textContent = STR.filterCount(n, S.ugroups.length); }
  } else if (!S.query) $('#searchInfo').hidden = true;
}

// ----- shared menu building blocks: solid popovers, inline-SVG icons (sprite in stash.html), roles + aria-checked -----
const SVGNS = 'http://www.w3.org/2000/svg';
function ICON(name, cls) {
  const sv = document.createElementNS(SVGNS, 'svg');
  sv.setAttribute('class', 'mi' + (cls ? ' ' + cls : ''));
  sv.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  sv.appendChild(u);
  return sv;
}

/** One menu entry. role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox' (the latter two carry aria-checked). */
function menuItem({ act, label, icon = 'dot', role = 'menuitem', checked = false, danger = false, disabled = false, hint = '', data = null }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mitem' + (danger ? ' danger' : '');
  b.setAttribute('role', role);
  if (role !== 'menuitem') b.setAttribute('aria-checked', String(!!checked));
  if (disabled) { b.setAttribute('aria-disabled', 'true'); if (hint) b.title = hint; }
  b.tabIndex = -1;
  if (act) b.dataset.act = act;
  if (data) Object.assign(b.dataset, data);
  b.appendChild(ICON(icon));
  b.appendChild(mk('span', 'ml', label));
  if (checked) b.appendChild(ICON('check', 'chk'));
  return b;
}

function menuHead(menu, title, first, icon) {
  if (!first) menu.appendChild(mk('div', 'msep'));
  const h = mk('div', 'mgroup');
  if (icon) h.appendChild(ICON(icon));
  h.appendChild(document.createTextNode(title));
  h.setAttribute('role', 'presentation');
  menu.appendChild(h);
}

// ----- submenus: a parent row + a child container inside the SAME popover element (one popover, so outside click / Esc / scroll close everything).
// Wide: flyout to the side (flips when it would clip), hover opens after 120 ms and closes after 250 ms (the pointer can cross other rows on its way).
// Narrow (bottom sheet): expands in place (accordion). Keyboard: Right opens, Left / Esc close only the submenu.
const SUB_OPEN_MS = 120;
const SUB_CLOSE_MS = 250;
let subTimer = 0;
const isNarrow = () => window.matchMedia('(max-width: 767px)').matches;
function menuSub(menu, { label, icon, items, hint }) {
  menu.classList.add('hasSub');
  const p = menuItem({ act: 'subToggle', label, icon });
  p.classList.add('msp'); // (not 'sub': that is the tab-group sub-header row of the list)
  p.setAttribute('aria-haspopup', 'menu');
  p.setAttribute('aria-expanded', 'false');
  p.appendChild(ICON('expand', 'subchev'));
  const box = mk('div', 'msub');
  box.setAttribute('role', 'menu');
  box.setAttribute('aria-label', label);
  box.hidden = true;
  for (const it of items) box.appendChild(it);
  if (hint) { const h = mk('span', 'subhint', hint); p.insertBefore(h, p.querySelector('.subchev')); }
  menu.append(p, box);
  return p;
}
const subOf = (p) => (p.nextElementSibling && p.nextElementSibling.classList.contains('msub') ? p.nextElementSibling : null);
function subClose(p) {
  const b = subOf(p);
  if (!b || b.hidden) return;
  b.hidden = true;
  p.setAttribute('aria-expanded', 'false');
  b.style.left = '';
  b.style.top = '';
}
function subCloseAll(menu, except) { for (const p of menu.querySelectorAll('.mitem.msp')) if (p !== except) subClose(p); }
function subOpen(p, focusFirst) {
  const menu = p.closest('.menu');
  const b = subOf(p);
  if (!b || p.getAttribute('aria-disabled') === 'true') return;
  subCloseAll(menu, p);
  b.hidden = false;
  p.setAttribute('aria-expanded', 'true');
  if (!isNarrow()) {
    b.style.top = Math.max(-6, p.offsetTop - 7) + 'px';
    b.style.left = (menu.clientWidth - 6) + 'px';
    const r = b.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) b.style.left = (-b.offsetWidth + 6) + 'px'; // flip to the other side
    const r2 = b.getBoundingClientRect();
    if (r2.bottom > window.innerHeight - 8) b.style.top = (parseFloat(b.style.top) - (r2.bottom - window.innerHeight + 8)) + 'px';
  }
  if (focusFirst) { const f = b.querySelector('[role^="menuitem"]:not([aria-disabled="true"])'); if (f) f.focus({ preventScroll: true }); }
}
function toggleSub(p, byKeyboard) {
  if (p.getAttribute('aria-expanded') === 'true') subClose(p); else subOpen(p, byKeyboard);
}
/** Esc closes only an open submenu (popover.js asks the menu element first) */
function subEscape(menu) {
  const open = [...menu.querySelectorAll('.msub:not([hidden])')];
  if (!open.length) return false;
  const p = open[open.length - 1].previousElementSibling;
  subClose(p);
  p.focus({ preventScroll: true });
  return true;
}
function menuPointer(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  if (isNarrow()) return;
  const menu = e.currentTarget;
  const it = e.target.closest('.mitem, .msub');
  if (!it) return;
  clearTimeout(subTimer);
  if (it.classList.contains('msub') || it.closest('.msub')) return; // inside a flyout: it stays open
  if (it.classList.contains('msp')) subTimer = setTimeout(() => subOpen(it, false), SUB_OPEN_MS);
  else if (menu.querySelector('.msub:not([hidden])')) subTimer = setTimeout(() => subCloseAll(menu), SUB_CLOSE_MS);
}
function menuPointerLeave(e) {
  const menu = e.currentTarget;
  clearTimeout(subTimer);
  if (!isNarrow() && menu.querySelector('.msub:not([hidden])')) subTimer = setTimeout(() => subCloseAll(menu), SUB_CLOSE_MS * 2);
}
for (const id of ['moreMenu', 'viewMenu', 'itemSortMenu', 'catMenu']) { const mm = $('#' + id); mm.addEventListener('pointerover', menuPointer); mm.addEventListener('pointerleave', menuPointerLeave); mm._escape = () => subEscape(mm); }

function refocusMenu(menu, key) {
  const el = [...menu.querySelectorAll('.mitem')].find((x) => x.dataset.k === key.k && (key.v === undefined || x.dataset.v === key.v));
  if (!el) return;
  const box = el.closest('.msub');
  if (box && box.hidden) subOpen(box.previousElementSibling, false); // the choice lives in a submenu: reopen it so focus is not lost
  el.focus({ preventScroll: true });
}

function focusMenu(menu) {
  const t = menu.querySelector('input[type="text"]') || menu.querySelector('[aria-checked="true"]') || menu.querySelector('[role^="menuitem"]:not([aria-disabled="true"])');
  if (t) t.focus({ preventScroll: true });
}

/** Opens `menu` for `btn` through the popover manager (toggles closed when the same trigger is used again; opts.keep = rebuild in place). */
function anchorMenu(menu, btn, opts) {
  S.menuTrigger = btn;
  return PM.open(menu, btn, opts);
}

let typeBuf = '';
let typeTimer = 0;
/** Keyboard model for every open menu: ↑/↓/Home/End move, Enter/Space activate, Esc closes (focus returns), letters type-ahead. */
function menuKeydown(e) {
  const menu = openMenu();
  if (!menu) return;
  const typing = e.target && e.target.tagName === 'INPUT';
  const fa = document.activeElement;
  const inSub = fa && fa.closest ? fa.closest('.msub') : null;
  if (inSub && e.key === 'ArrowLeft') { e.preventDefault(); subEscape(menu); return; }
  if (fa && fa.classList && fa.classList.contains('msp') && (e.key === 'ArrowRight' || (e.key === 'ArrowLeft' && fa.getAttribute('aria-expanded') === 'true'))) { e.preventDefault(); if (e.key === 'ArrowRight') subOpen(fa, true); else subClose(fa); return; }
  const scope = inSub || menu;
  const items = [...scope.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')].filter((x) => inSub || !x.closest('.msub'));
  if (!items.length) return;
  const i = items.indexOf(fa);
  if (e.key === 'ArrowDown' || (e.key === 'ArrowUp' && !typing)) {
    e.preventDefault();
    const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[n].focus();
  } else if (e.key === 'Home' && !typing) { e.preventDefault(); items[0].focus(); } else if (e.key === 'End' && !typing) { e.preventDefault(); items[items.length - 1].focus(); } else if (e.key.length === 1 && !typing && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    typeBuf += e.key.toLowerCase();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => { typeBuf = ''; }, 700);
    const hit = items.find((x) => (x.textContent || '').trim().toLowerCase().startsWith(typeBuf));
    if (hit) { e.preventDefault(); hit.focus(); }
  }
}

const SORT_ICONS = { lastUsed: 'clock', openedOld: 'clock', restoredMost: 'refresh', created: 'calendar', createdAsc: 'calendar', mtime: 'edit', lastRestored: 'refresh', title: 'sort', count: 'hash', sites: 'globe', manual: 'rows' };
const GROUP_ICONS = { idle: 'clock', saved: 'calendar', calendar: 'calendar', slot: 'clock', site: 'globe', tabgroup: 'layers', count: 'hash', category: 'folder', none: 'rows' };
const ITEMSORT_ICONS = { lastUsed: 'clock', opened: 'clock', idleMost: 'clock', lifeMost: 'clock', stash: 'rows', title: 'sort', site: 'globe', visited: 'clock' };

const TOP_SORTS = ['created', 'lastUsed', 'mtime', 'title', 'count'];
const TOP_GROUPS = ['calendar', 'site', 'category', 'none'];
const TOP_ISORTS = ['stash', 'title', 'site', 'lastUsed'];
/** A radio group with a short top level: the usual choices as rows, everything else in ONE submenu (its row shows the current choice when that one is inside). */
function radioShort(menu, { title, icon, first, act = 'vmSet', group, cur, all, top, labels, icons, other }) {
  menuHead(menu, title, first, icon);
  const row = (k) => menuItem({ act, label: labels[k], icon: icons[k] || 'dot', role: 'menuitemradio', checked: cur === k, data: { k: group, v: k } });
  for (const k of all.filter((x) => top.includes(x))) menu.appendChild(row(k));
  const rest = all.filter((x) => !top.includes(x));
  if (rest.length) menuSub(menu, { label: other, icon: 'expand', items: rest.map(row), hint: rest.includes(cur) ? labels[cur] : '' });
}

function buildViewMenu() {
  const m = $('#viewMenu');
  m.textContent = '';
  m.classList.remove('hasSub');
  const vs = S.vs;
  if (vs.flat) {
    menuHead(m, STR.flatHead, true, 'rows');
    const cur = (vs.flatSort || 'stash') + ':' + (vs.flatDir || 'desc');
    const keys = Object.keys(STR.flatOpts);
    const top = keys.slice(0, 5);
    const frow = (o) => menuItem({ act: 'vmFlat', label: STR.flatOpts[o], icon: ITEMSORT_ICONS[o.split(':')[0]], role: 'menuitemradio', checked: cur === o, data: { k: 'flat', v: o } });
    for (const o of top) m.appendChild(frow(o));
    if (keys.length > top.length) menuSub(m, { label: STR.vmOtherSort, icon: 'expand', items: keys.slice(5).map(frow), hint: keys.slice(5).includes(cur) ? STR.flatOpts[cur] : '' });
    m.appendChild(mk('div', 'msep'));
    m.appendChild(menuItem({ act: 'vmToggle', label: STR.vmDensity, icon: 'rows', role: 'menuitemcheckbox', checked: S.settings.density === 'compact', data: { k: 'density' } }));
    return;
  }
  radioShort(m, { title: STR.vmSort, icon: 'sort', first: true, group: 'sort', cur: vs.sort, all: Q.SORTS, top: TOP_SORTS, labels: STR.sorts, icons: SORT_ICONS, other: STR.vmOtherSort });
  radioShort(m, { title: STR.vmGroup, icon: 'layers', group: 'groupBy', cur: vs.groupBy, all: Q.GROUPBYS, top: TOP_GROUPS, labels: STR.groupbys, icons: GROUP_ICONS, other: STR.vmOtherGroup });
  m.appendChild(mk('div', 'msep'));
  m.appendChild(menuItem({ act: 'vmToggle', label: STR.vmStarredFirst, icon: 'star', role: 'menuitemcheckbox', checked: vs.starredFirst, data: { k: 'starredFirst' } }));
  m.appendChild(menuItem({ act: 'vmToggle', label: STR.vmDensity, icon: 'rows', role: 'menuitemcheckbox', checked: S.settings.density === 'compact', data: { k: 'density' } }));
  // rarely used: the slot mode (only with "by time slot"), the order of tabs inside every session, jump to a date section
  const more = [];
  if (vs.groupBy === 'slot') for (const k of Q.SLOT_MODES) more.push(menuItem({ act: 'vmSet', label: STR.slots[k], icon: 'clock', role: 'menuitemradio', checked: vs.slotMode === k, data: { k: 'slotMode', v: k } }));
  menuSub(m, { label: STR.vmItems, icon: 'rows', hint: STR.itemSorts[vs.itemSort] || '', items: Q.ITEM_SORTS.map((k) => menuItem({ act: 'vmSet', label: STR.itemSorts[k], icon: ITEMSORT_ICONS[k], role: 'menuitemradio', checked: vs.itemSort === k, data: { k: 'itemSort', v: k } })).concat([mk('div', 'msep'), menuItem({ act: 'isortAllGlobal', label: STR.isortAll, icon: 'rows' })]) });
  if (more.length) menuSub(m, { label: STR.vmSlot, icon: 'clock', hint: STR.slots[vs.slotMode] || '', items: more });
  if (V.jump.length > 1) menuSub(m, { label: STR.jumpLabel, icon: 'calendar', items: V.jump.slice(0, 40).map((j) => menuItem({ act: 'jumpTo', label: `${j.label} (${j.n})`, icon: 'calendar', data: { idx: String(j.idx) } })) });
}

function saveView() { send({ type: 'saveView', view: S.vs }); }

// ----- filter menu -----
// ----- filter panel (lib/filterpanel.js): all the UI lives there; this file only feeds it data and applies changes -----
let filterPanel = null;
function hostIcon(host) {
  const f = mk('span', 'fi');
  const av = mk('span', 'av'); const a = avatarOf(host); av.textContent = a.ch; av.dataset.h = String(a.hue);
  f.append(av);
  if (favsOn()) {
    if (favs.atlas) { f.classList.add('at'); const c = favs.cellFor(host, 'https://' + host + '/'); if (c >= 0) { favs.cellStyle(f, c); f.classList.add('has'); } }
    else { const u = favs.iconFor(host, 'https://' + host + '/'); if (u) { const img = document.createElement('img'); img.width = 16; img.height = 16; img.alt = ''; img.src = u; f.append(img); f.classList.add('has'); } }
  }
  return f;
}
function facetsForPanel() {
  const ctx = Q.makeCtx(S.cats);
  ctx.siteMap = S.siteMap;
  const fa = Q.facetCounts(S.allGroups, S.nav, S.filters, ctx);
  fa.siteMapReady = !!S.siteMap;
  return fa;
}
function buildFilterMenu(fresh) {
  const m = $('#filterMenu');
  if (!filterPanel) {
    filterPanel = mountFilterPanel(m, {
      lang: () => S.lang || 'th',
      calendar: () => S.settings.dateCalendar,
      filters: () => S.filters,
      patch: (fn) => { fn(S.filters); applyView(); },
      facets: facetsForPanel,
      cats: () => S.cats,
      summary: () => { let n = 0; for (const g of S.ugroups) n += g.count; return { tabs: n, sets: S.ugroups.length }; },
      hostIcon,
      flagLabels: STR.flags,
      hasTm: () => S.allGroups.some((g) => g.tm),
      close: () => PM.close({ restoreFocus: true }),
      clearAll: () => { S.filters = Q.emptyFilters(); applyView(); },
    });
  }
  if (fresh) filterPanel.reset();
  filterPanel.render();
}

// ----- categories -----
async function catAddPrompt() {
  const name = prompt(STR.promptCat, '');
  if (!name || !name.trim()) return null;
  const r = await send({ type: 'catSave', cat: { name: name.trim() } });
  if (!r.ok) { toastError(r); return null; }
  await loadCats();
  renderNav();
  return r.cat;
}

// ----- reorder categories: drag in the sidebar, Alt+Up/Down, or the menu. The order is applied at once, then saved. -----
function say(text) {
  let el = $('#srLive');
  if (!el) { el = mk('div', 'sr-only'); el.id = 'srLive'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

async function commitCatOrder(ids, movedId) {
  const by = new Map(S.cats.map((c) => [c.id, c]));
  const next = ids.map((id) => by.get(id)).filter(Boolean);
  if (next.length !== S.cats.length || next.every((c, i) => c === S.cats[i])) return;
  next.forEach((c, i) => { c.ord = i; });
  S.cats = next;
  renderNav();
  applyView();
  const moved = movedId && by.get(movedId);
  if (moved) say(STR.catMoved(moved.name, next.indexOf(moved) + 1, next.length));
  const r = await send({ type: 'catReorder', ids });
  if (!r.ok) { toastError(r); await loadCats(); renderNav(); applyView(); }
}

function moveCat(id, delta, refocus) {
  const ids = S.cats.map((c) => c.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  const p = commitCatOrder(ids, id);
  if (refocus) { const b = document.querySelector(`#catList .navi[data-cat="${CSS.escape(id)}"]`); if (b) b.focus(); }
  return p;
}

function initCatReorder() {
  const box = $('#catList');
  if (!box) return;
  let d = null;
  const clear = () => {
    document.body.classList.remove('cat-reordering');
    for (const e of box.querySelectorAll('.cat-drag,.ins-before,.ins-after')) { e.classList.remove('cat-drag', 'ins-before', 'ins-after'); e.style.transform = ''; }
  };
  const targetIndex = (y) => {
    const others = [...box.querySelectorAll('.navi')].filter((b) => b !== d.b);
    let k = 0;
    for (const b of others) { const r = b.getBoundingClientRect(); if (y > r.top + r.height / 2) k++; }
    return { others, k };
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const b = e.target.closest('.navi[data-menu-cat]');
    if (b) d = { b, id: b.dataset.menuCat, y0: e.clientY, on: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!d) return;
    if (!d.on) {
      if (Math.abs(e.clientY - d.y0) < 6) return;
      d.on = true;
      document.body.classList.add('cat-reordering');
      d.b.classList.add('cat-drag');
      say(STR.catReorderHint);
    }
    d.b.style.transform = `translateY(${e.clientY - d.y0}px)`;
    const { others, k } = targetIndex(e.clientY);
    for (const o of others) o.classList.remove('ins-before', 'ins-after');
    if (k < others.length) others[k].classList.add('ins-before'); else if (others.length) others[others.length - 1].classList.add('ins-after');
    d.k = k;
  });
  window.addEventListener('pointerup', () => {
    if (!d) return;
    const cur = d;
    d = null;
    if (!cur.on) return;
    const ids = S.cats.map((c) => c.id).filter((x) => x !== cur.id);
    ids.splice(cur.k == null ? ids.length : cur.k, 0, cur.id);
    clear();
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    box.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => box.removeEventListener('click', stop, true), 0);
    commitCatOrder(ids, cur.id);
  });
  window.addEventListener('keydown', (e) => { if (d && d.on && e.key === 'Escape') { d = null; clear(); } }, true);
  box.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const b = e.target.closest && e.target.closest('.navi[data-menu-cat]');
    if (!b) return;
    e.preventDefault();
    moveCat(b.dataset.menuCat, e.key === 'ArrowUp' ? -1 : 1, true);
  });
}

function showCatMenu(btn, cid) {
  const m = $('#catMenu');
  m.textContent = '';
  S.catMenuId = cid;
  const ci = S.cats.findIndex((c) => c.id === cid);
  m.classList.remove('hasSub');
  m.appendChild(menuItem({ act: 'catRename', label: STR.catRename, icon: 'edit' }));
  m.appendChild(menuItem({ act: 'catColor', label: STR.catColor, icon: 'palette' }));
  menuSub(m, { label: STR.mgMore, icon: 'dots', items: [
    menuItem({ act: 'catMoveUp', label: STR.catMoveUp, icon: 'arrow-up', disabled: ci <= 0 }),
    menuItem({ act: 'catMoveDown', label: STR.catMoveDown, icon: 'arrow-down', disabled: ci < 0 || ci >= S.cats.length - 1 }),
  ] });
  m.appendChild(mk('div', 'msep'));
  m.appendChild(menuItem({ act: 'catDelete', label: STR.catDelete, icon: 'trash', danger: true }));
  anchorMenu(m, btn);
}

function showMoveCatMenu(btn, gids) {
  const m = $('#catMenu');
  m.textContent = '';
  S.moveGids = gids;
  const one = gids.length === 1 ? groupOf(gids[0]) : null;
  m.classList.remove('hasSub');
  const crow = (c) => menuItem({ act: 'moveToCat', label: c.name, icon: 'folder', role: 'menuitemradio', checked: !!one && one.cat === c.id, data: { cat: c.id, c: c.color } });
  const TOPC = 6; // the first six categories (and the current one) stay at the top level; a long list goes into one submenu
  const topC = S.cats.filter((c, i) => i < TOPC || (!!one && one.cat === c.id));
  for (const c of topC) m.appendChild(crow(c));
  const restC = S.cats.filter((c) => !topC.includes(c));
  if (restC.length) menuSub(m, { label: STR.catOthers(restC.length), icon: 'expand', items: restC.map(crow) });
  m.appendChild(menuItem({ act: 'moveToCat', label: STR.catNone, icon: 'close', role: 'menuitemradio', checked: !!one && !one.cat, data: { cat: '' } }));
  m.appendChild(mk('div', 'msep'));
  m.appendChild(menuItem({ act: 'moveToNewCat', label: STR.catNew, icon: 'plus' }));
  anchorMenu(m, btn);
}

// ----- lazy tab-group runs for expanded groups -----
const runQueue = new Set();
let runBusy = false;
let relayoutTimer = 0;
function relayoutSoon() {
  if (relayoutTimer) return;
  relayoutTimer = setTimeout(() => { relayoutTimer = 0; relayout(); }, 80);
}
let tgScanBusy = false;
/** Group-by tab group needs the run layout of every session that owns tab groups: scan them in the background, then re-split once. */
async function tgScanKick() {
  if (tgScanBusy) return;
  tgScanBusy = true;
  try {
    let did = 0;
    for (const g of S.allGroups.slice()) {
      if (S.vs.groupBy !== 'tabgroup') break;
      if (!needRuns(g) || baseRuns(g)) continue;
      try { await ensureRuns(g); } catch { continue; }
      if (baseRuns(g)) did++;
      if (did && did % 40 === 0) { applyView(); await new Promise((r) => setTimeout(r, 0)); }
    }
    if (did && S.vs.groupBy === 'tabgroup') applyView();
  } finally { tgScanBusy = false; }
}
function wantRuns(g) {
  if (!needRuns(g) || sortActive(g) || runsOf(g) || runQueue.has(g.id) || lowMem()) return;
  runQueue.add(g.id);
  pumpRuns();
}
async function pumpRuns() {
  if (runBusy) return;
  runBusy = true;
  try {
    while (runQueue.size) {
      const gid = runQueue.values().next().value;
      runQueue.delete(gid);
      const g = groupOf(gid);
      if (!g || !V.exp.has(gid)) continue;
      try { await ensureRuns(g); relayoutSoon(); } catch { /* flat list */ }
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally { runBusy = false; }
}

// ----- expand / collapse -----
function loadExpState() {
  try { return JSON.parse(localStorage.getItem('cmr.exp') || '{}'); } catch { return {}; }
}
function saveExpState() {
  try {
    const o = {};
    let n = 0;
    for (const g of S.allGroups) { if (n >= 5000) break; if (!V.exp.has(g.id)) { o[g.id] = 0; n++; } }
    localStorage.setItem('cmr.exp', JSON.stringify(o));
  } catch { /* storage unavailable */ }
}
function applyDefaultExpand() {
  const mode = S.settings.defaultExpand;
  const saved = loadExpState(); // ids the user collapsed explicitly
  const byNew = S.allGroups.slice().sort((a, b) => b.createdAt - a.createdAt);
  V.exp = new Set();
  const list = mode === 'none' ? [] : mode === 'newest' ? byNew.slice(0, 20) : byNew;
  for (const g of list) if (!(g.id in saved) && g.count > 0) V.exp.add(g.id);
  for (const g of S.allGroups) S.seen.add(g.id);
}
function expandAll(on) {
  V.exp = new Set();
  if (on) for (const g of S.groups) if (g.count > 0) V.exp.add(g.id);
  dropCache('all');
  for (const [, n] of V.live) n._sig = null;
  saveExpState();
  relayout();
}

// ----- direct cloud button of the session header -----
async function syncGroupClick(btn, gid) {
  const g = groupOf(gid);
  if (!g) return null;
  if (!SYNC.enabled) {
    toast(STR.syncNeedEnable, null, null, 4500);
    setView('settings');
    setTimeout(() => { const c = $('#s-sync'); if (c) c.scrollIntoView({ block: 'start' }); }, 80);
    return null;
  }
  const st = groupSyncState(g);
  if (st === 'off') {
    const r = await send({ type: 'setFlag', groupId: gid, flag: 'sync', value: true });
    if (!r.ok) return toastError(r);
    toast(STR.syncStarted, null, null, 2500);
    send({ type: 'sync/now' });
    return null;
  }
  const m = $('#moreMenu');
  if (PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return null; }
  S.menuGid = gid;
  m.textContent = '';
  menuHead(m, STR.syncPopTitle, true, 'cloud');
  m.appendChild(mk('div', 'mnote', STR.syncSt[st] + ' · ' + (SYNC.last ? STR.syncLast(new Date(SYNC.last).toLocaleString(Q.L.locale, { dateStyle: 'short', timeStyle: 'short' })) : STR.syncNever)));
  if (!g.sync) {
    m.appendChild(mk('div', 'mnote', STR.syncByScope));
    m.appendChild(menuItem({ act: 'mSyncForce', label: STR.syncForce, icon: 'cloud' }));
  } else {
    m.appendChild(menuItem({ act: 'mSyncPush', label: STR.syncPushNow, icon: 'refresh' }));
    m.appendChild(menuItem({ act: 'mSyncStop', label: STR.syncStop, icon: 'close', danger: true }));
  }
  anchorMenu(m, btn);
  return null;
}

// ----- session ⋯ menu -----
function groupFlag(g, k) { return !!g[k]; }

function showMore(btn, gid) {
  const m = $('#moreMenu');
  if (PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return; }
  const g = groupOf(gid);
  S.menuGid = gid;
  m.textContent = '';
  if (!g) return;
  // short top level (8 rows, never scrolls); the open variants live in the chevron of the restore button, rarely used things sit in the submenus
  m.classList.remove('hasSub');
  const item = (o) => m.appendChild(menuItem(o));
  const mi = menuItem;
  item({ act: 'mRename', label: STR.mRename, icon: 'edit', disabled: g.locked, hint: STR.locked });
  item({ act: 'mMoveCat', label: STR.mMoveCat, icon: 'folder' });
  item({ act: 'mPin', label: STR.mPin, icon: 'pin', role: 'menuitemcheckbox', checked: !!g.pinned });
  item({ act: 'mArchive', label: STR.mArchive, icon: 'box', role: 'menuitemcheckbox', checked: !!g.archived });
  item({ act: 'printGroup', label: STR.mPrint, icon: 'rows' });
  menuSub(m, { label: STR.mgCopy, icon: 'copy', items: [['urlTitle', STR.cfUrlTitle], ['titleUrl', STR.cfTitleUrl], ['url', STR.cfUrl], ['markdown', STR.cfMarkdown], ['rich', STR.cfRich]].map(([fmt, label]) => mi({ act: 'copyGroup', label, icon: fmt === 'url' ? 'link' : 'copy', data: { fmt } })) });
  let lookItems = []; // colour + emoji live inside the ⋯ more submenu (the top level stays short)
  if (S.settings.setLook !== false) {
    lookItems = STR.lookNames.map((nm, i) => {
      const it = mi({ act: 'mLook', label: nm, icon: 'palette', role: 'menuitemradio', checked: g.color === i + 1, data: { c: i + 1 } });
      const sw = mk('span', 'lsw'); sw.style.background = 'var(--c-' + ['blue', 'red', 'orange', 'yellow', 'green', 'cyan', 'purple', 'pink'][i] + ')';
      const sv = it.querySelector('svg'); if (sv) sv.replaceWith(sw);
      return it;
    });
    lookItems.push(mi({ act: 'mLook', label: STR.lookNone, icon: 'close', role: 'menuitemradio', checked: !g.color, data: { c: 0 } }));
    lookItems.push(mi({ act: 'mEmoji', label: STR.lookEmoji, icon: 'star' }));
    if (g.emoji) lookItems.push(mi({ act: 'mEmojiClear', label: STR.lookEmojiClear, icon: 'close' }));
  }
  menuSub(m, { label: STR.mgOpenOther, icon: 'open', items: [
    mi({ act: 'mRestoreIncog', label: STR.mRestoreIncog, icon: 'incog', disabled: S.incogAllowed === false, hint: STR.incogHint }),
    mi({ act: 'refreshSession', label: STR.menuRefreshSession, icon: 'refresh' }),
  ] });
  const more = [
    mi({ act: 'mNote', label: STR.mNote, icon: 'note' }),
    ...lookItems,
    mi({ act: 'mDedupe', label: STR.mDedupe, icon: 'dedupe', disabled: g.locked, hint: STR.locked }),
    mi({ act: 'mImportHere', label: STR.mImportHere, icon: 'import' }),
    mi({ act: 'mPending', label: STR.mPending, icon: 'clock', role: 'menuitemcheckbox', checked: !!g.pending }),
    mi({ act: 'mStar', label: STR.mStar, icon: 'star', role: 'menuitemcheckbox', checked: !!g.starred }),
    mi({ act: 'mLock', label: STR.mLock, icon: 'lock', role: 'menuitemcheckbox', checked: !!g.locked }),
  ];
  if (SYNC.enabled) more.push(mi({ act: 'mSync', label: STR.mSync, icon: 'cloud', role: 'menuitemcheckbox', checked: !!g.sync || (SYNC.scope && SYNC.scope.mode === 'all') }));
  menuSub(m, { label: STR.mgMore, icon: 'dots', items: more });
  m.appendChild(mk('div', 'msep'));
  item({ act: 'mTrash', label: STR.mTrash, icon: 'trash', danger: true, disabled: g.locked, hint: STR.locked });
  anchorMenu(m, btn);
}

/** The open choices, each with an explicit keep / remove variant (locked sessions never remove). */
function addOpenItems(m, g) {
  const item = (o) => m.appendChild(menuItem(o));
  const lk = !!g.locked;
  const tip = lk ? STR.lockedKeeps : '';
  item({ act: 'mOpenKeep', label: STR.mOpenKeep, icon: 'open' });
  item({ act: 'mOpenRemove', label: STR.mOpenRemove, icon: 'trash', disabled: lk, hint: tip });
  item({ act: 'mNewKeep', label: STR.mNewKeep, icon: 'window' });
  item({ act: 'mNewRemove', label: STR.mNewRemove, icon: 'trash', disabled: lk, hint: tip });
  item({ act: 'mTgKeep', label: STR.mTgKeep, icon: 'layers' });
  item({ act: 'mTgRemove', label: STR.mTgRemove, icon: 'trash', disabled: lk, hint: tip });
}

function showOpenMenu(btn, gid) {
  const m = $('#moreMenu');
  if (PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return; }
  const g = groupOf(gid);
  S.menuGid = gid;
  m.textContent = '';
  if (!g) return;
  addOpenItems(m, g);
  anchorMenu(m, btn);
}

async function allItemsOf(gid, max = 50000) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = await db.getItemsPage(gid, after, 1000);
    if (!page.length) break;
    for (const it of page) out.push(it);
    after = page[page.length - 1].seq;
    if (page.length < 1000 || out.length >= max) break;
  }
  return out;
}

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function copyGroup(gid, fmt) {
  const g = groupOf(gid);
  if (!g) return;
  if (g.count > 20000) return toast(STR.copyTooBig);
  const f = fmt || S.settings.copyFormat || 'urlTitle';
  const items = await allItemsOf(gid);
  const line = (it) => {
    const t = it.title || it.url;
    if (f === 'titleUrl') return `${t} | ${it.url}`;
    if (f === 'url') return it.url;
    if (f === 'markdown') return `[${t.replace(/[[\]]/g, '')}](${it.url})`;
    return `${it.url} | ${t}`;
  };
  const text = items.map(f === 'rich' ? (it) => it.url : line).join('\n');
  try {
    if (f === 'rich' && window.ClipboardItem) {
      const html = items.map((it) => `<a href="${escHtml(it.url)}">${escHtml(it.title || it.url)}</a>`).join('<br>');
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    } else await navigator.clipboard.writeText(text);
    toast(STR.copied, null, null, 2500);
  } catch { toast(STR.copyFailed, null, null, 2500); }
}

/** Print view of one tab set: a plain sheet of titles + links (the @media print rules hide everything else). Built with textContent only. */
async function printGroup(gid) {
  const g = groupOf(gid);
  if (!g) return;
  if (g.count > 20000) return toast(STR.copyTooBig);
  const items = await allItemsOf(gid);
  let sheet = $('#printSheet');
  if (sheet) sheet.remove();
  sheet = mk('div', 'printsheet'); sheet.id = 'printSheet';
  sheet.append(mk('h1', '', g.title && g.title.trim() ? g.title : fmtDate(g.createdAt)), mk('p', 'pmeta', fmtDate(g.createdAt) + ' · ' + items.length));
  const ol = mk('ol');
  for (const it of items) { const li = mk('li'); li.append(mk('span', 'pt', it.title || it.url), mk('span', 'pu', it.url)); ol.appendChild(li); }
  sheet.appendChild(ol);
  document.body.appendChild(sheet);
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); const s = $('#printSheet'); if (s) s.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

async function importHere(gid) {
  const text = prompt(STR.promptImport, '');
  if (!text || !text.trim()) return;
  const p = parseOneTab(text);
  const items = [];
  for (const gr of p.groups) for (const it of gr.items) items.push({ url: it.url, title: it.title });
  if (!items.length) return toast(STR.nothingToExport, null, null, 2500);
  for (let i = 0; i < items.length; i += 1000) {
    const r = await send({ type: 'import:items', gid, items: items.slice(i, i + 1000) });
    if (!r.ok) return toastError(r);
  }
  toast(STR.importedN(items.length), null, null, 3000);
}

async function menuAction(act) {
  const gid = S.menuGid;
  const g = groupOf(gid);
  const menu = $('#moreMenu');
  const btn = document.querySelector(`.vrow[data-g="${gid}"] [data-act="more"]`) || menu;
  closeMenus();
  if (!g) return null;
  switch (act) {
    case 'mOpenKeep': return doRestoreGroup(gid, { here: true, remove: false });
    case 'mOpenRemove': return doRestoreGroup(gid, { here: true, remove: true });
    case 'mNewKeep': return doRestoreGroup(gid, { newWindow: true, remove: false });
    case 'mNewRemove': return doRestoreGroup(gid, { newWindow: true, remove: true });
    case 'mTgKeep': return doRestoreGroup(gid, { here: true, asTabGroup: true, remove: false });
    case 'mTgRemove': return doRestoreGroup(gid, { here: true, asTabGroup: true, remove: true });
    case 'mRestoreIncog': {
      let ok = false;
      try { ok = await chrome.extension.isAllowedIncognitoAccess(); } catch { ok = false; }
      if (!ok) return toast(STR.incogHint, null, null, 6000);
      return doRestoreGroup(gid, { incognito: true });
    }
    case 'mRename': { const t = prompt(STR.promptRename, g.title || ''); if (t == null) return null; const r = await send({ type: 'renameGroup', groupId: gid, title: t }); return r.ok ? null : toastError(r); }
    case 'mNote': { const t = prompt(STR.promptNote, g.note || ''); if (t == null) return null; const r = await send({ type: 'groupNote', groupId: gid, note: t }); return r.ok ? null : toastError(r); }
    case 'mDedupe': {
      const r = await send({ type: 'dedupeGroup', groupId: gid });
      if (!r.ok) return toastError(r);
      if (r.n && r.undo) toast(STR.dedupeDone(r.n), STR.undo, async () => { const u = await send(r.undo); if (!u.ok) toastError(u); }, 10000); else toast(STR.dedupeDone(0), null, null, 2500);
      return null;
    }
    case 'mImportHere': return importHere(gid);
    case 'mStar': return send({ type: 'setFlag', groupId: gid, flag: 'starred', value: !g.starred });
    case 'mLock': return send({ type: 'setFlag', groupId: gid, flag: 'locked', value: !g.locked });
    case 'mPin': return send({ type: 'setFlag', groupId: gid, flag: 'pinned', value: !g.pinned });
    case 'mPending': return send({ type: 'setFlag', groupId: gid, flag: 'pending', value: !g.pending });
    case 'mSyncStop': { const r = await send({ type: 'setFlag', groupId: gid, flag: 'sync', value: false }); return r.ok ? null : toastError(r); }
    case 'mSyncForce': case 'mSyncPush': {
      if (act === 'mSyncForce') { const r = await send({ type: 'setFlag', groupId: gid, flag: 'sync', value: true }); if (!r.ok) return toastError(r); }
      toast(STR.syncStarted, null, null, 2500);
      return send({ type: 'sync/now' });
    }
    case 'mSync': return send({ type: 'setFlag', groupId: gid, flag: 'sync', value: !g.sync });
    case 'mArchive': return send({ type: 'setFlag', groupId: gid, flag: 'archived', value: !g.archived });
    case 'mMoveCat': showMoveCatMenu(btn, [gid]); return null;
    case 'mTrash': return doDelete({ type: 'deleteGroup', groupId: gid });
    default: return null;
  }
}

// ----- trash view -----
async function renderTrashView() {
  await renderTrash();
  $('#trashNote').textContent = STR.trNote(S.settings.trashDaysDeleted, S.settings.trashDaysOpened);
}

const kbOn = (name) => S.settings.shortcutsOn !== false && S.settings[name] !== false;
function syncKbList() { const off = S.settings.shortcutsOn === false; for (const el of document.querySelectorAll('#kbList input')) el.disabled = off; }
async function renderCommands() {
  syncKbList();
  const tb = $('#cmdTable');
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch { /* shown empty */ }
  tb.textContent = '';
  for (const c of cmds) {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    const kb = document.createElement('kbd');
    kb.textContent = c.shortcut || STR.kbNotSet;
    a.appendChild(kb);
    const nm = mk('td', '', c.description || c.name);
    nm.title = c.name;
    tr.append(a, nm);
    tb.appendChild(tr);
  }
}

// ---------- per-session item sort (split button in each session header) ----------
// The virtual list reads items in positional pages from the database (stash order). A different order needs the session's rows in
// memory: they are loaded once, ordered (main thread up to 3,000 rows, sort-worker.js beyond that, skeleton rows meanwhile) and
// then served from that array. Tab-group sub-headers are hidden while a custom order is active.
const ISORT_ICON = { lastUsed: 'clock', opened: 'clock', idleMost: 'clock', lifeMost: 'clock', stash: 'rows', title: 'sort', site: 'globe', visited: 'clock' };
const DEFAULT_DIR = { lastUsed: 'desc', opened: 'desc', idleMost: 'desc', lifeMost: 'desc', stash: 'asc', title: 'asc', site: 'asc', visited: 'desc' };
const sortCollator = new Intl.Collator(['th', 'en'], { sensitivity: 'base', numeric: true });
let isortState = null; // gid -> [key, dir]  (this session only; capped, persisted in localStorage like the expand state)
let sortWorker = null;
let sortReq = 0;
const sortWaiters = new Map();

function isortLoad() {
  if (isortState) return isortState;
  try { isortState = new Map(Object.entries(JSON.parse(localStorage.getItem('cmr.isort') || '{}'))); } catch { isortState = new Map(); }
  return isortState;
}
function isortSave() {
  try {
    const o = {};
    for (const [k, v] of [...isortLoad()].slice(-2000)) o[k] = v;
    localStorage.setItem('cmr.isort', JSON.stringify(o));
  } catch { /* storage unavailable */ }
}
function effSort(g) {
  const own = isortLoad().get(g.id);
  if (own) return { key: own[0], dir: own[1], own: true };
  return { key: S.vs.itemSort || 'stash', dir: S.vs.itemDir || DEFAULT_DIR[S.vs.itemSort || 'stash'], own: false };
}
function sortActive(g) { const e = effSort(g); return !(e.key === 'stash' && e.dir === 'asc'); }
const sortSig = (g) => { const e = effSort(g); return `${e.key}:${e.dir}:${g.count}:${g.mtime || 0}`; };

function sortInWorker(keys, dir, numeric) {
  if (!sortWorker) {
    sortWorker = new Worker('sort-worker.js');
    sortWorker.onmessage = (e) => { const w = sortWaiters.get(e.data.id); if (w) { sortWaiters.delete(e.data.id); w(e.data.order); } };
  }
  const id = ++sortReq;
  return new Promise((resolve) => { sortWaiters.set(id, resolve); sortWorker.postMessage({ id, keys, dir, numeric }); });
}

const TIME_SORTS = new Set(['lastUsed', 'opened', 'idleMost', 'lifeMost']);
async function ensureSorted(g) {
  const sig = sortSig(g);
  const tag = g.id + '|' + sig;
  if (V.sorting.has(tag)) return;
  V.sorting.add(tag);
  try {
    const rows = await allItemsOf(g.id, 200000);
    const e = effSort(g);
    let order;
    if (e.key === 'stash') order = rows.map((_, i) => rows.length - 1 - i);
    else {
      const numeric = e.key === 'visited' || TIME_SORTS.has(e.key);
      const keys = rows.map((r) => (e.key === 'visited' ? (r.ts || 0) : TIME_SORTS.has(e.key) ? Q.itemTimeKey(r, e.key) : e.key === 'site' ? (r.site || hostFor(r.url)) : (r.title || r.url)));
      if (rows.length > 3000) order = await sortInWorker(keys, e.dir, numeric);
      else {
        const sign = e.dir === 'desc' ? -1 : 1;
        order = rows.map((_, i) => i);
        order.sort((a, b) => sign * (numeric ? keys[a] - keys[b] : sortCollator.compare(keys[a], keys[b])) || a - b);
      }
    }
    const cur = groupOf(g.id);
    if (!cur || sortSig(cur) !== sig) return; // the choice changed while loading
    V.sorted.set(g.id, { sig, rows: Array.from(order, (i) => rows[i]) });
    for (const [, n] of V.live) if (n._kind === 'item' && n._gid === g.id) n._sig = null;
    schedule();
  } catch { /* retried on the next frame that needs it */ } finally { V.sorting.delete(tag); }
}

function setItemSort(gid, key, dir) {
  const st = isortLoad();
  if (key === 'stash' && dir === 'asc' && !(S.vs.itemSort && S.vs.itemSort !== 'stash')) st.delete(gid); else st.set(gid, [key, dir]);
  isortSave();
  V.sorted.delete(gid);
  dropCache([gid]);
  for (const [, n] of V.live) if (n._gid === gid || n.dataset.g === gid) n._sig = null;
  relayout();
}

function showItemSortMenu(btn, gid, keep) {
  const g = groupOf(gid);
  if (!g) return;
  const m = $('#itemSortMenu');
  if (!keep && PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return; }
  const e = effSort(g);
  S.isortGid = gid;
  m.textContent = '';
  m.classList.remove('hasSub');
  menuHead(m, STR.vmItems, true, 'sort');
  const srow = (k) => menuItem({ act: 'isortSet', label: STR.itemSorts[k], icon: ISORT_ICON[k], role: 'menuitemradio', checked: e.key === k, data: { key: k, k: 'isort', v: k } });
  for (const k of Q.ITEM_SORTS.filter((x) => TOP_ISORTS.includes(x))) m.appendChild(srow(k));
  const rest = Q.ITEM_SORTS.filter((x) => !TOP_ISORTS.includes(x));
  menuSub(m, { label: STR.vmOtherIsort, icon: 'expand', items: rest.map(srow), hint: rest.includes(e.key) ? STR.itemSorts[e.key] : '' });
  menuHead(m, STR.isortDirHead, false, 'arrow-up');
  m.appendChild(menuItem({ act: 'isortSet', label: STR.isortAsc, icon: 'arrow-up', role: 'menuitemradio', checked: e.dir === 'asc', data: { dir: 'asc' } }));
  m.appendChild(menuItem({ act: 'isortSet', label: STR.isortDesc, icon: 'arrow-down', role: 'menuitemradio', checked: e.dir === 'desc', data: { dir: 'desc' } }));
  m.appendChild(mk('div', 'msep'));
  m.appendChild(menuItem({ act: 'isortReset', label: STR.isortReset, icon: 'refresh', disabled: !sortActive(g), hint: '' }));
  m.appendChild(menuItem({ act: 'isortAll', label: STR.isortAll, icon: 'rows' }));
  anchorMenu(m, btn, { keep: !!keep });
}

// top bar: direction of the current SESSION order (the chevron next to it opens the full menu)
const DEF_ARROW = { created: 'down', createdAsc: 'up', mtime: 'down', lastRestored: 'down', title: 'up', count: 'down', sites: 'down', manual: 'up' };
function renderSortBtn() {
  const b = $('#btnSortDir');
  if (!b) return;
  const base = DEF_ARROW[S.vs.sort] || 'down';
  const arrow = S.vs.sortRev ? (base === 'down' ? 'up' : 'down') : base;
  b.textContent = '';
  b.appendChild(ICON(SORT_ICONS[S.vs.sort] || 'sort'));
  b.appendChild(ICON('arrow-' + arrow, 'arr'));
  const tip = STR.sessDirTip(STR.sorts[S.vs.sort], arrow);
  b.title = tip;
  b.setAttribute('aria-label', tip);
  const nonDefault = S.vs.sort !== 'created' || !!S.vs.sortRev || S.vs.groupBy !== 'calendar' || S.vs.itemSort !== 'stash' || !!S.vs.starredFirst;
  $('#sessSplit').classList.toggle('on', nonDefault);
}

// ---------- crash-recovery snapshots: banner, history view, restore dialog ----------
/** "about N tabs unused for 30+ days" banner on the All view (estimate from the per-set quartiles), and the bulk bar of the stale view */
function staleTargets() {
  const cut = Date.now() / 60000 - Q.STALE_DAYS * 1440;
  const anyTm = S.allGroups.some((g) => g.tm);
  const all = S.allGroups.filter((g) => !g.archived && g.deletedAt == null && !g.locked && (g.tm && g.tm.luMax ? g.tm.luMax < cut : (!anyTm || !g.tm) && g.createdAt < Date.now() - Q.STALE_OFF_DAYS * 86400000));
  return { groups: all, tabs: all.reduce((a, g) => a + g.count, 0), hasTm: anyTm };
}
function renderStaleBanner() {
  const el = $('#bannerStale');
  if (!el) return;
  el.textContent = '';
  if (S.view !== 'list') { el.hidden = true; return; }
  if (S.nav.kind === 'stale') {
    const t = staleTargets();
    if (!t.groups.length) { el.hidden = true; return; }
    el.hidden = false;
    el.appendChild(document.createTextNode((t.hasTm ? STR.staleBarOn : STR.staleBarOff)(t.groups.length, t.tabs)));
    el.append(actBtn('staleTrash', STR.staleTrash, 'danger'), actBtn('staleArchive', STR.staleArchive));
    return;
  }
  let hide = 0;
  try { hide = Number(localStorage.getItem('cmrStaleHide') || 0); } catch { /* ignore */ }
  if (S.nav.kind !== 'all' || Date.now() < hide) { el.hidden = true; return; }
  const est = Q.staleEstimate(S.allGroups);
  if (est.n < 50) { el.hidden = true; return; }
  el.hidden = false;
  el.appendChild(document.createTextNode(STR.staleBanner((est.approx ? '~' : '') + est.n)));
  el.append(actBtn('staleView', STR.staleView), actBtn('staleHide', STR.staleHide));
}
async function staleBulk(kind) {
  const t = staleTargets();
  if (!t.groups.length) return;
  if (!confirm((kind === 'trash' ? STR.staleTrashConfirm : STR.staleArchiveConfirm)(t.groups.length, t.tabs))) return;
  for (const g of t.groups) await send(kind === 'trash' ? { type: 'deleteGroup', groupId: g.id } : { type: 'setFlag', groupId: g.id, flag: 'archived', value: true });
}

/** one-time notice that usage stats stay on this device (dismissible; shown only while tracking is on) */
function renderActBanner() {
  const el = $('#bannerAct');
  if (!el) return;
  let seen = false;
  try { seen = localStorage.getItem('cmrActSeen') === '1'; } catch { /* ignore */ }
  el.textContent = '';
  el.hidden = seen || S.settings.activityTracking === false || S.view !== 'list';
  if (el.hidden) return;
  el.appendChild(document.createTextNode(STR.actBanner));
  el.appendChild(actBtn('actBannerOk', STR.actBannerOk));
  el.appendChild(actBtn('actBannerSet', STR.sPrivacy));
}

function renderSnapBanner(b) {
  const el = $('#bannerSnap');
  el.textContent = '';
  if (!b) { el.hidden = true; return; }
  el.hidden = false;
  el.appendChild(document.createTextNode(STR.snapBanner(b.missing) + (b.recent ? ` · ${STR.rcBanner(b.recent)}` : '')));
  const v = actBtn('snapOpen', STR.snapView);
  v.dataset.id = b.id;
  el.appendChild(v);
  const d = actBtn('snapDismiss', STR.snapDismiss);
  d.dataset.id = b.id;
  el.appendChild(d);
}

async function checkSnap() {
  const r = await send({ type: 'snapCheck' });
  renderSnapBanner(r.ok ? r.banner : null);
}

async function loadSnapCount() {
  try { S.snaps = await db.snapList(); } catch { S.snaps = []; }
  const el = document.querySelector('[data-nc="snaps"]');
  if (el) el.textContent = S.snaps.length ? String(S.snaps.length) : '';
}

async function renderSnapView() {
  await loadSnapCount();
  const box = $('#snapList');
  box.textContent = '';
  if (!S.snaps.length) box.appendChild(mk('div', 'muted', STR.snapEmpty));
  for (const s of S.snaps) {
    const row = mk('div', 'r');
    row.appendChild(mk('span', '', `${fmtDate(s.ts)} · ${STR.tabsCount(s.tabCount)} · ${STR.windowsBadge(s.windowCount)} · ${STR.snapKind[s.kind] || s.kind}${s.degraded ? ' · ' + STR.snapDegraded : ''} · ${Math.max(1, Math.round(s.bytes / 1024))} KB`));
    const box2 = mk('span');
    const b1 = actBtn('snapOpen', STR.snapView);
    b1.dataset.id = s.id;
    const b2 = actBtn('snapDelete', STR.snapDel, 'del');
    b2.dataset.id = s.id;
    box2.append(b1, b2);
    row.appendChild(box2);
    box.appendChild(row);
  }
  // extra source: Chrome's own recently-closed list
  const rc = await send({ type: 'recentlyClosed', max: 25 });
  if (rc.ok && rc.perm === false) { box.appendChild(mk('h3', 'rchead', STR.rcTitle)); box.appendChild(sessionsHint()); } // optional permission not granted
  if (rc.ok && rc.list && rc.list.length) {
    box.appendChild(mk('h3', 'rchead', STR.rcTitle));
    for (const r of rc.list) {
      const row = mk('div', 'r');
      row.appendChild(mk('span', '', `${fmtDate(r.ts)} · ${r.win ? STR.rcWindow(r.n) + ' · ' : ''}${r.title}`));
      const b = actBtn('rcOpen', STR.rcOpen);
      b.dataset.sid = String(r.sid);
      row.appendChild(b);
      box.appendChild(row);
    }
  }
}

async function openSnapDialog(id) {
  const rec = await db.snapGet(id);
  if (!rec) return toast(STR.snapEmpty, null, null, 2500);
  const body = await gunzipJson(rec.gz);
  const open = (await chrome.tabs.query({})).filter((t) => !t.incognito).map((t) => t.pendingUrl || t.url || '');
  const missing = new Set(diffTabs(body.tabs, open));
  S.snap = { id, ts: rec.ts, body, missing, sel: new Set(), showAll: false };
  body.tabs.forEach((t, i) => { if (missing.has(t)) S.snap.sel.add(i); });
  $('#snapShowAll').checked = false;
  renderSnapDialog();
  $('#snapDialog').hidden = false;
}

function renderSnapDialog() {
  const sn = S.snap;
  if (!sn) return;
  $('#snapDlgTitle').textContent = STR.snapDlgTitle(sn.ts);
  $('#snapDlgSub').textContent = STR.snapDlgSub(sn.missing.size, sn.body.tabs.length);
  const box = $('#snapDlgList');
  box.textContent = '';
  let curW = -1;
  let curTg = -2;
  sn.body.tabs.forEach((t, i) => {
    const isMissing = sn.missing.has(t);
    if (!sn.showAll && !isMissing) return;
    if (t.w !== curW) { curW = t.w; curTg = -2; box.appendChild(mk('div', 'sgh', STR.windowN(t.w))); }
    const tg = t.tg == null ? -1 : t.tg;
    if (tg !== curTg) {
      curTg = tg;
      if (tg >= 0) { const d = sn.body.groups[tg] || {}; const h = mk('div', 'sgh', '● ' + (d.title || STR.tgUntitled)); h.dataset.c = d.color || 'grey'; h.style.color = 'var(--tgc)'; box.appendChild(h); }
    }
    const lab = document.createElement('label');
    if (!isMissing) lab.className = 'present';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.i = String(i);
    cb.checked = sn.sel.has(i);
    lab.append(cb, mk('span', 't', t.title || t.url), mk('span', 'u', hostFor(t.url) || t.url));
    box.appendChild(lab);
  });
  const go = $('#snapGo');
  go.textContent = STR.snapGo(sn.sel.size);
  go.disabled = !sn.sel.size;
}

// ---------- actions ----------
const groupOf = (gid) => S.groups.find((g) => g.id === gid);

async function doRestoreGroup(gid, { newWindow = false, session = false, here = false, incognito = false, asTabGroup = false, remove } = {}) {
  const g = groupOf(gid);
  const n = g ? g.count : 0;
  if (n > CONFIRM_MANY && !confirm(STR.confirmMany(n))) return;
  const r = await send({ type: 'restoreGroup', groupId: gid, newWindow, session, here, incognito, asTabGroup, ...(typeof remove === 'boolean' ? { remove } : {}) });
  if (!r.ok) return toastError(r);
  if (r.failed) toast(STR.restoreFailed(r.failed));
  else if (r.restored > 1) toast(STR.restoredToast(r.restored), null, null, 3000);
}

async function doDelete(msg) {
  const r = await send(msg);
  if (!r.ok) return toastError(r);
  if (r.undo) {
    toast(STR.deleted, STR.undo, async () => {
      const u = await send(r.undo);
      if (!u.ok) toastError(u);
    }, 10000);
  }
}

function keyOf(row) {
  return row.dataset.g + ':' + row.dataset.seq;
}

async function onClick(e) {
  const menu = $('#moreMenu');

  const a = e.target.closest('a.ilink');
  if (a) {
    if (e.button === 0 && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const row = a.closest('.vrow');
      if (row && row.dataset.seq) {
        // Ctrl/Cmd+click = open and KEEP the entry (a per-action override of the setting); a plain click follows the setting
        const keep = e.ctrlKey || e.metaKey;
        const r = await send({ type: 'restoreItems', keys: [keyOf(row)], newWindow: false, ...(keep ? { remove: false } : {}) });
        if (!r.ok) toastError(r);
      }
    }
    return null;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return null;
  if (btn.getAttribute('aria-disabled') === 'true') { if (btn.title) toast(btn.title, null, null, 2500); return null; }
  const host = btn.closest('[data-g]');
  const gid = btn.dataset.g || (host ? host.dataset.g : null);
  const grp = gid ? groupOf(gid) : null;
  switch (btn.dataset.act) {
    case 'toggle': return toggleGroup(gid, host ? host.dataset.vk : '');
    case 'openGroup': return doRestoreGroup(gid);
    case 'openSession': return doRestoreGroup(gid, { session: true });
    case 'openGroupWin': return doRestoreGroup(gid, { newWindow: true });
    case 'openMenu': showOpenMenu(btn, gid); return null;
    case 'syncGroup': return syncGroupClick(btn, gid);
    case 'trashTab': S.trashTab = btn.dataset.tab; S.trashSel = new Set(); return renderTrash();
    case 'trashClearType': return trashClearType(btn.dataset.reason || '');
    case 'trashRecoverSel': return trashDo('recover', selectedTrashRows());
    case 'trashOpenSel': return trashDo('open', selectedTrashRows());
    case 'trashPurgeSel': return trashDo('purge', selectedTrashRows());
    case 'trExpand': toggleTrashDetail(btn); return null;
    case 'trPage': pageTrashDetail(btn); return null;
    case 'trashRecover': return trashDo('recover', rowsOf(btn));
    case 'trashOpen': return trashDo('open', rowsOf(btn));
    case 'trashPurge': return trashDo('purge', rowsOf(btn));
    case 'openSplit': {
      const row = btn.closest('.vrow');
      if (!row || !row.dataset.seq) return null;
      const r = await send({ type: 'restoreSplit', key: keyOf(row) });
      if (!r.ok) toastError(r);
      return null;
    }
    case 'openTg': {
      const n = Number((host && host.dataset.n) || 0);
      if (n > CONFIRM_MANY && !confirm(STR.confirmMany(n))) return null;
      const r = await send({ type: 'restoreTabGroup', groupId: gid, tg: Number(host && host.dataset.tg) });
      if (!r.ok) return toastError(r);
      if (r.failed) toast(STR.restoreFailed(r.failed));
      return null;
    }
    case 'more': showMore(btn, gid); return null;
    case 'copyGroup': closeMenus(); return copyGroup(S.menuGid, btn.dataset.fmt);
    case 'printGroup': closeMenus(); return printGroup(S.menuGid);
    case 'refreshSession': {
      closeMenus();
      const r = await send({ type: 'refreshAll', scope: 'session', gid: S.menuGid });
      if (!r.ok) return toastError(r);
      return toast(r.total ? STR.refreshStarted(r.total) + (r.noAccess ? ' · ' + STR.refreshNoAccess(r.loaded) : '') : STR.refreshNone, null, null, 5000);
    }
    case 'refreshWindow': {
      const r = await send({ type: 'refreshAll', scope: 'window' });
      if (!r.ok) return toastError(r);
      return toast(r.total ? STR.refreshStarted(r.total) + (r.noAccess ? ' · ' + STR.refreshNoAccess(r.loaded) : '') : STR.refreshNone, null, null, 5000);
    }
    case 'refreshCancel': return send({ type: 'refreshCancel' });
    case 'star': {
      const r = await send({ type: 'setFlag', groupId: gid, flag: 'starred', value: !(grp && grp.starred) });
      return r.ok ? null : toastError(r);
    }
    case 'lock': {
      const r = await send({ type: 'setFlag', groupId: gid, flag: 'locked', value: !(grp && grp.locked) });
      return r.ok ? null : toastError(r);
    }
    case 'delGroup': return doDelete({ type: 'deleteGroup', groupId: gid });
    case 'delItem': {
      const row = btn.closest('.vrow');
      if (selUi && selUi.actions.deleteIfSelected(row)) return null; // a selected row deletes the whole selection
      return doDelete({ type: 'deleteItems', groupId: row.dataset.g, seqs: [Number(row.dataset.seq)] });
    }
    case 'openAll': {
      let n = 0;
      for (const g of S.ugroups) n += g.count;
      if (!n) return null;
      if (n > CONFIRM_MANY && !confirm(STR.confirmMany(n))) return null;
      const r = await send({ type: 'restoreOpenAll' });
      return r.ok ? null : toastError(r);
    }
    case 'undoStash': {
      const ls = S.meta.lastStash;
      const g = ls && groupOf(ls.groupId);
      if (!g) return null;
      const n = (ls.groupIds || [ls.groupId]).reduce((a, id) => a + ((groupOf(id) || {}).count || 0), 0);
      if (n > CONFIRM_MANY && !confirm(STR.confirmMany(n))) return null;
      const r = await send({ type: 'undoLastStash' });
      return r.ok ? null : toastError(r);
    }
    case 'closeWelcome': $('#welcome').hidden = true; return null;
    case 'foldToggle': { $('#panels').classList.toggle('expanded'); fitBanners(); return null; }
    case 'bannerMore': { const b = btn.closest('.banner'); if (b) { b.classList.toggle('open'); fitBanners(); } return null; }
    case 'closeMenus': closeMenus(); return null;
    case 'editTitle': beginEdit(btn.closest('.vrow')); return null;
    case 'itemSortMain': {
      const e = effSort(grp);
      if (e.key === 'stash' && e.dir === 'asc') setItemSort(gid, 'title', 'asc'); else setItemSort(gid, e.key, e.dir === 'asc' ? 'desc' : 'asc');
      return null;
    }
    case 'itemSortMenu': showItemSortMenu(btn, gid); return null;
    case 'isortSet': {
      PM.quiet();
      const g = groupOf(S.isortGid);
      if (!g) return null;
      const e = effSort(g);
      const key = btn.dataset.key || e.key;
      const dir = btn.dataset.dir || (btn.dataset.key ? DEFAULT_DIR[btn.dataset.key] : e.dir);
      setItemSort(g.id, key, dir);
      showItemSortMenu(S.menuTrigger, g.id, true);
      if (btn.dataset.k) refocusMenu($('#itemSortMenu'), { k: 'isort', v: btn.dataset.v });
      return null;
    }
    case 'isortAllGlobal': { isortLoad().clear(); isortSave(); V.sorted.clear(); dropCache('all'); for (const [, n] of V.live) n._sig = null; closeMenus(); relayout(); toast(STR.isortAll + ' ✓', null, null, 2000); return null; }
    case 'isortReset': { const st = isortLoad(); st.delete(S.isortGid); isortSave(); V.sorted.delete(S.isortGid); dropCache([S.isortGid]); closeMenus(); relayout(); return null; }
    case 'isortAll': {
      const g = groupOf(S.isortGid);
      if (g) { const e = effSort(g); S.vs.itemSort = e.key; S.vs.itemDir = e.dir; saveView(); }
      isortLoad().clear(); isortSave(); V.sorted.clear(); dropCache('all'); for (const [, n] of V.live) n._sig = null; closeMenus(); relayout(); return null;
    }
    case 'sessDirToggle': if (S.vs.flat) { S.vs.flatDir = S.vs.flatDir === 'asc' ? 'desc' : 'asc'; saveView(); applyView(); scroller.scrollTop = 0; return null; } S.vs.sortRev = !S.vs.sortRev; saveView(); applyView(); return null;
    case 'snapNow': { const r = await send({ type: 'snapNow' }); await renderSnapView(); return r.ok ? toast(r.saved ? STR.snapNow + ' ✓' : (STR.snapReasons[r.reason] || r.reason || ''), null, null, 3500) : toastError(r); }
    case 'rcOpen': try { if (!chrome.sessions) return null; await chrome.sessions.restore(btn.dataset.sid); } catch (e) { toast(String((e && e.message) || e), null, null, 3000); } return null;
    case 'snapOpen': return openSnapDialog(btn.dataset.id);
    case 'snapDismiss': { await send({ type: 'snapDismiss', id: btn.dataset.id }); renderSnapBanner(null); return null; }
    case 'snapDelete': { await send({ type: 'snapDelete', id: btn.dataset.id }); return null; }
    case 'snapClose': $('#snapDialog').hidden = true; S.snap = null; return null;
    case 'staleView': navTo('stale'); return null;
    case 'actBannerOk': try { localStorage.setItem('cmrActSeen', '1'); } catch { /* ignore */ } renderActBanner(); return null;
    case 'actBannerSet': try { localStorage.setItem('cmrActSeen', '1'); } catch { /* ignore */ } renderActBanner(); setView('settings'); return null;
    case 'staleHide': try { localStorage.setItem('cmrStaleHide', String(Date.now() + 7 * 86400000)); } catch { /* ignore */ } renderStaleBanner(); return null;
    case 'staleTrash': await staleBulk('trash'); return null;
    case 'staleArchive': await staleBulk('archive'); return null;
    case 'actOffDel': $('#actDialog').hidden = true; await send({ type: 'saveSettings', patch: { activityTracking: false } }); runActPurge(); return null;
    case 'actOffKeep': $('#actDialog').hidden = true; await send({ type: 'saveSettings', patch: { activityTracking: false } }); return null;
    case 'actOffCancel': $('#actDialog').hidden = true; renderSettings(); return null;
    case 'actPurgeAll': if (confirm(STR.actPurgeConfirm)) runActPurge(); return null;
    case 'ramReset': await send({ type: 'ram:reset' }); renderRamInfo(); return null;
    case 'actExport': return exportActivity();
    case 'snapAll': if (S.snap) { S.snap.body.tabs.forEach((t, i) => { if (S.snap.showAll || S.snap.missing.has(t)) S.snap.sel.add(i); }); renderSnapDialog(); } return null;
    case 'snapNone': if (S.snap) { S.snap.sel.clear(); renderSnapDialog(); } return null;
    case 'snapGo': {
      const sn = S.snap;
      if (!sn || !sn.sel.size) return null;
      const items = [...sn.sel].sort((a, b) => a - b).map((i) => sn.body.tabs[i]);
      const r = await send({ type: 'snapRestore', items, groups: sn.body.groups, windows: sn.body.windows, title: STR.snapRestoreTitle, dismiss: sn.id });
      $('#snapDialog').hidden = true;
      S.snap = null;
      renderSnapBanner(null);
      return r.ok ? toast(STR.snapQueued, null, null, 4000) : toastError(r);
    }
    case 'navTo': navTo(btn.dataset.nav, btn.dataset.cat); return null;
    case 'syncOpen': setView('settings'); requestAnimationFrame(() => { const c = $('#s-sync'); if (c) c.scrollIntoView({ block: 'start' }); }); return null;
    case 'nav': if (btn.dataset.view === 'settings') setView('settings'); else if (btn.dataset.view === 'snaps') setView('snaps'); else if (btn.dataset.view === 'dash') setView('dash'); else if (btn.dataset.view === 'trash') navTo('trash'); return null;
    case 'toggleSide': $('#shell').classList.toggle('side-open'); $('#scrim').hidden = !$('#shell').classList.contains('side-open'); return null;
    case 'openAbout': location.href = 'about.html'; return null;
    case 'closeSide': $('#shell').classList.remove('side-open'); $('#scrim').hidden = true; return null;
    case 'catAdd': return catAddPrompt();
    case 'viewMenu': { const m = $('#viewMenu'); if (PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return null; } buildViewMenu(); anchorMenu(m, btn); return null; }
    case 'filterMenu': { const m = $('#filterMenu'); if (PM.isOpen(m) && PM.current.trigger === btn) { PM.close(); return null; } ensureSiteMap(); buildFilterMenu(true); anchorMenu(m, btn); return null; }
    case 'vmSet': {
      PM.quiet();
      const key = { k: btn.dataset.k, v: btn.dataset.v };
      S.vs[key.k] = key.v;
      if (key.k === 'itemSort') { S.vs.itemDir = DEFAULT_DIR[key.v] || 'asc'; V.sorted.clear(); dropCache('all'); for (const [, n] of V.live) n._sig = null; }
      if (key.k === 'sort') S.vs.sortRev = false;
      saveView(); applyView(); buildViewMenu();
      refocusMenu($('#viewMenu'), key); // keep the keyboard position after the rebuild
      return null;
    }
    case 'flatToggle': {
      S.vs.flat = !S.vs.flat;
      saveView();
      for (const [k, n] of V.live) { release(n); V.live.delete(k); }
      applyView();
      scroller.scrollTop = 0;
      if (S.query) runSearch();
      return null;
    }
    case 'vmFlat': {
      PM.quiet();
      const [a, b] = String(btn.dataset.v).split(':');
      S.vs.flatSort = a;
      S.vs.flatDir = b;
      saveView();
      applyView();
      scroller.scrollTop = 0;
      buildViewMenu();
      refocusMenu($('#viewMenu'), { k: 'flat', v: btn.dataset.v });
      return null;
    }
    case 'vmToggle': {
      PM.quiet();
      const key = { k: btn.dataset.k };
      if (key.k === 'density') await send({ type: 'saveSettings', patch: { density: S.settings.density === 'compact' ? 'comfortable' : 'compact' } });
      else { S.vs.starredFirst = !S.vs.starredFirst; saveView(); applyView(); }
      buildViewMenu();
      refocusMenu($('#viewMenu'), key);
      return null;
    }
    case 'jumpTo': { const idx = Number(btn.dataset.idx); if (!Number.isNaN(idx) && V.tops[idx] != null) scroller.scrollTop = V.tops[idx]; closeMenus(); return null; }
    case 'expandAll': expandAll(true); return null;
    case 'collapseAll': expandAll(false); return null;
    case 'pin': { const r = await send({ type: 'setFlag', groupId: gid, flag: 'pinned', value: !(grp && grp.pinned) }); return r.ok ? null : toastError(r); }
    case 'subToggle': toggleSub(btn, e.detail === 0); return null;
    case 'mRestoreNew': case 'mRestoreHere': case 'mRestoreIncog': case 'mAsTabGroup': case 'mRename': case 'mNote': case 'mDedupe': case 'mImportHere':
    case 'mSyncStop': case 'mSyncForce': case 'mSyncPush': case 'mStar': case 'mLock': case 'mPin': case 'mPending': case 'mArchive': case 'mMoveCat': case 'mTrash':
      return menuAction(btn.dataset.act);
    case 'mLook': { closeMenus(); const c = Number(btn.dataset.c) || 0; const r = await send({ type: 'groupLook', groupId: S.menuGid, color: c || null }); return r.ok ? null : toastError(r); }
    case 'mEmoji': { closeMenus(); const g0 = groupOf(S.menuGid); const t = prompt(STR.promptEmoji, (g0 && g0.emoji) || ''); if (t == null) return null; const r = await send({ type: 'groupLook', groupId: S.menuGid, emoji: t.trim() }); return r.ok ? null : toastError(r); }
    case 'mEmojiClear': { closeMenus(); const r = await send({ type: 'groupLook', groupId: S.menuGid, emoji: '' }); return r.ok ? null : toastError(r); }
    case 'moveToCat': {
      closeMenus();
      const r = await send({ type: 'groupsSetCat', gids: S.moveGids || [], cat: btn.dataset.cat || null });
      if (r.ok) toast(STR.moved(r.n || 0), null, null, 2500); else toastError(r);
      return null;
    }
    case 'moveToNewCat': {
      closeMenus();
      const c = await catAddPrompt();
      if (c) { const r = await send({ type: 'groupsSetCat', gids: S.moveGids || [], cat: c.id }); if (!r.ok) toastError(r); }
      return null;
    }
    case 'catRename': {
      closeMenus();
      const c = catById(S.catMenuId);
      const name = c && prompt(STR.promptCat, c.name);
      if (!name || !name.trim()) return null;
      await send({ type: 'catSave', cat: { id: c.id, name: name.trim() } }); await loadCats(); applyView(); return null;
    }
    case 'catMoveUp': case 'catMoveDown': { closeMenus(); moveCat(S.catMenuId, btn.dataset.act === 'catMoveUp' ? -1 : 1); return null; }
    case 'catColor': {
      closeMenus();
      const c = catById(S.catMenuId);
      if (!c) return null;
      const next = CAT_COLORS[(CAT_COLORS.indexOf(c.color) + 1) % CAT_COLORS.length];
      await send({ type: 'catSave', cat: { id: c.id, color: next } }); await loadCats(); applyView(); return null;
    }
    case 'catDelete': {
      closeMenus();
      const c = catById(S.catMenuId);
      if (!c) return null;
      if (S.nav.kind === 'cat' && S.nav.cat === c.id) S.nav = { kind: 'all', cat: null };
      const r = await send({ type: 'catDelete', id: c.id });
      await loadCats(); applyView();
      if (r.ok) toast(STR.catDeleted, null, null, 3500); else toastError(r);
      return null;
    }
    case 'openShortcuts': { try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); } catch { toast('chrome://extensions/shortcuts', null, null, 4000); } return null; }
    case 'searchMore': searchMore(); return null;
    case 'rebuildIndex':
      if (SRCH.client) SRCH.client.post({ type: 'rebuild' });
      toast(STR.searchIndexing(0), null, null, 2500);
      return null;
    case 'toastAction': {
      const fn = S.toastAction;
      $('#toast').hidden = true;
      S.toastAction = null;
      return fn ? fn() : null;
    }
    case 'exportNdjson': return exportNdjson();
    case 'exportOneTab': return exportOneTab();
    case 'copyOneTab': return copyOneTab();
    case 'importText': return doImportText($('#importText').value);
    case 'undeleteGroup': { const r = await send({ type: 'undeleteGroup', groupId: gid }); return r.ok ? null : toastError(r); }
    case 'purgeGroup': {
      if (!confirm(STR.confirmPurge)) return null;
      const r = await send({ type: 'purgeGroup', groupId: gid });
      return r.ok ? null : toastError(r);
    }
    case 'undoTrash': { const r = await send({ type: 'undoTrash', tid: btn.dataset.t }); return r.ok ? null : toastError(r); }
    case 'emptyTrash': {
      if (!(S.trash.groups.length || S.trash.items.length) || !confirm(STR.confirmEmptyTrash)) return null;
      const r = await send({ type: 'emptyTrash' });
      return r.ok ? null : toastError(r);
    }
    case 'drainPause': return send({ type: 'drain:pause' });
    case 'drainResume': return send({ type: 'drain:resume' });
    case 'drainStop': return send({ type: 'drain:stop', dropRemaining: false });
    case 'drainStopDrop': return send({ type: 'drain:stop', dropRemaining: true });
    case 'drainContinueRestart': return send({ type: 'drain:continueAfterRestart' });
    case 'jobContinue': { const r = await send({ type: 'restoreContinue' }); return r.ok ? null : toastError(r); }
    case 'jobRunAll': return send({ type: 'restoreRunAll' });
    case 'jobStop': return send({ type: 'restoreStop' });
    case 'vaultRebuild': {
      const r = await send({ type: 'vault:rebuild' });
      return r.ok ? toast(STR.vaultRecovered(r.groups, r.items)) : toastError(r);
    }
    case 'dbReset': {
      if (prompt(STR.dbResetPrompt) !== 'RESET') return null;
      const r = await send({ type: 'dbReset', confirm: 'RESET' });
      if (!r.ok) return toastError(r);
      await send({ type: 'vault:rebuild' });
      location.reload();
      return null;
    }
    case 'retryDb': location.reload(); return null;
    case 'dupNow': {
      const r = await send({ type: 'closeDuplicatesNow' });
      return r.ok ? toast(STR.dupDone(r.closed, r.skippedBusy)) : toastError(r);
    }
    case 'cleanAll': return runCleanAll();
    case 'dupOpen': { const r = await send({ type: 'dupLogRestore', indexes: [Number(btn.dataset.i)] }); return r.ok ? null : toastError(r); }
    case 'dupOpenAll': { const r = await send({ type: 'dupLogRestore', indexes: 'all' }); return r.ok ? null : toastError(r); }
    case 'dupClear': { const r = await send({ type: 'dupLogClear' }); return r.ok ? null : toastError(r); }
    default: return null;
  }
}

async function runCleanAll() {
  const s = await send({ type: 'cleanSummary' });
  if (!s.ok) return toastError(s);
  if (!s.duplicates && !s.internalClose && !s.internalSave && !s.idle) return toast(STR.cleanNothing);
  if (!confirm(STR.cleanConfirm(s))) return null;
  const r = await send({ type: 'cleanAll' });
  return r.ok ? toast(STR.cleanDone(r)) : toastError(r);
}

async function commitTitle(input) {
  const row = input.closest('[data-g]');
  if (!row || input.value === input.dataset.orig) return;
  const r = await send({ type: 'renameGroup', groupId: row.dataset.g, title: input.value });
  if (r.ok) input.dataset.orig = input.value.trim();
  else toastError(r);
}

// ---------- export (manual only: an <a download> clicked from a user click handler) ----------
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function buildBlob(kind) {
  const wt = kind === 'ndjson' && !!($('#expTime') && $('#expTime').checked);
  let blob = new Blob([]);
  let buf = [];
  let n = 0;
  let firstGroup = true;
  const flush = () => { if (buf.length) { blob = new Blob([blob, buf.join('\n') + '\n']); buf = []; } };
  if (kind === 'ndjson') buf.push(ndjsonHeader(Date.now()));
  await db.iterateExport(
    (g) => {
      if (kind === 'ndjson') buf.push(ndjsonGroup(g, wt));
      else { if (!firstGroup) buf.push(''); firstGroup = false; }
    },
    (g, items) => {
      for (const it of items) buf.push(kind === 'ndjson' ? ndjsonItem(g.id, it, wt) : oneTabLine(it));
      n += items.length;
      if (buf.length >= 2000) { flush(); $('#exportStatus').textContent = STR.exporting(n); }
    },
  );
  flush();
  return { blob, n };
}

const totalLinks = () => S.ugroups.reduce((a, g) => a + g.count, 0);

async function exportNdjson() {
  if (!totalLinks()) return toast(STR.nothingToExport);
  let { blob, n } = await buildBlob('ndjson');
  let name = `tabroost-export-${fmtStamp(Date.now())}.cmr.ndjson`;
  if (n > 20000) {
    blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    name += '.gz';
  }
  saveBlob(blob, name);
  $('#exportStatus').textContent = STR.exported(n);
  return null;
}

async function exportOneTab() {
  if (!totalLinks()) return toast(STR.nothingToExport);
  const { blob, n } = await buildBlob('onetab');
  saveBlob(blob, `onetab-${fmtStamp(Date.now())}.txt`);
  $('#exportStatus').textContent = STR.exported(n);
  return null;
}

async function copyOneTab() {
  if (!totalLinks()) return toast(STR.nothingToExport);
  if (totalLinks() > 20000) return toast(STR.copyTooBig);
  const { blob } = await buildBlob('onetab');
  const text = await blob.text();
  try {
    await navigator.clipboard.writeText(text);
    toast(STR.copied, null, null, 2500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? STR.copied : STR.copyFailed, null, null, 2500);
  }
  return null;
}

// ---------- import (streamed to the service worker in batches) ----------
class Importer {
  constructor(onProgress) {
    this.gids = [];
    this.batch = [];
    this.cur = null;
    this.seen = new Set();
    this.added = 0;
    this.skipped = 0;
    this.onProgress = onProgress;
  }

  async startGroup(meta) {
    await this.endGroup();
    const r = await send({ type: 'import:group', meta });
    if (!r.ok) throw new Error(r.error);
    this.cur = r.gid;
    this.gids.push(r.gid);
    this.seen = new Set();
  }

  async add(it) {
    if (!this.cur) await this.startGroup({});
    if (!it || typeof it.url !== 'string' || (it.sv == null && this.seen.has(it.url))) { this.skipped++; return; } // (the two panes of a split view are never collapsed)
    this.seen.add(it.url);
    this.batch.push({ url: it.url, title: it.title, ts: it.ts, w: it.w, ws: it.ws, tg: it.tg, sv: it.sv });
    if (this.batch.length >= APPEND_CHUNK) await this.flush();
  }

  async flush() {
    if (!this.batch.length || !this.cur) return;
    const items = this.batch;
    this.batch = [];
    const r = await send({ type: 'import:items', gid: this.cur, items });
    if (!r.ok) throw new Error(r.error);
    this.added += r.added;
    this.skipped += r.skipped;
    if (this.onProgress) this.onProgress(this.added);
  }

  async endGroup() {
    await this.flush();
    this.cur = null;
  }

  async finish() {
    await this.endGroup();
    const r = await send({ type: 'import:end', gids: this.gids });
    if (!r.ok) throw new Error(r.error);
    return { added: this.added, groups: r.groups, skipped: this.skipped };
  }

  async abort() {
    await send({ type: 'import:abort', gids: this.gids });
  }
}

async function importLines(lines) {
  const status = $('#importStatus');
  const imp = new Importer((n) => { status.textContent = STR.importing(n); });
  try {
    let mode = null;
    const rest = [];
    let curGroupOpen = false;
    for await (const line of lines) {
      if (mode === null) {
        if (!line.trim()) continue;
        const o = parseNdjsonLine(line);
        if (o && o.type === 'header') mode = 'ndjson';
        else if (/^\s*[{[]/.test(line)) { mode = 'json'; rest.push(line); } else { mode = 'onetab'; rest.push(line); }
        continue;
      }
      if (mode === 'ndjson') {
        const o = parseNdjsonLine(line);
        if (!o) continue;
        if (o.type === 'group') {
          await imp.startGroup({ title: o.title, starred: o.starred, locked: o.locked, createdAt: o.createdAt, windowCount: o.windowCount, tabGroups: o.tabGroups, color: o.color, emoji: o.emoji });
          curGroupOpen = true;
        } else if (o.type === 'item') {
          if (!curGroupOpen) { await imp.startGroup({}); curGroupOpen = true; }
          await imp.add(o);
        }
      } else rest.push(line);
    }
    if (mode === 'json') {
      let v = { ok: false };
      try { v = validateImportJson(JSON.parse(rest.join('\n'))); } catch { /* not valid */ }
      if (!v.ok) throw new Error('อ่านไฟล์ไม่ได้ ไฟล์อาจเสียหาย หรือไม่ใช่ไฟล์ที่ส่งออกจากส่วนขยายนี้หรือ OneTab');
      imp.skipped += v.skipped;
      for (const g of v.groups) {
        await imp.startGroup({ title: g.title, starred: g.starred, locked: g.locked, tabGroups: g.tabGroups, color: g.color, emoji: g.emoji });
        for (const it of g.items) await imp.add(it);
      }
    } else if (mode === 'onetab') {
      const p = parseOneTab(rest.join('\n'));
      imp.skipped += p.skipped;
      for (const g of p.groups) {
        await imp.startGroup({});
        for (const it of g.items) await imp.add(it);
      }
    }
    const r = await imp.finish();
    const msg = STR.importResult(r.added, r.groups, r.skipped);
    status.textContent = msg;
    toast(msg);
    return r;
  } catch (e) {
    try { await imp.abort(); } catch { /* ignore */ }
    status.textContent = STR.errorPrefix + (e && e.message);
    toast(STR.errorPrefix + (e && e.message));
    return null;
  }
}

async function doImportText(text) {
  if (!String(text || '').trim()) return;
  const stream = new Blob([text]).stream().pipeThrough(new TextDecoderStream());
  const r = await importLines(readLines(stream));
  if (r && r.added) $('#importText').value = '';
}

async function doImportFile(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream();
  if (head[0] === 0x1f && head[1] === 0x8b) stream = stream.pipeThrough(new DecompressionStream('gzip'));
  await importLines(readLines(stream.pipeThrough(new TextDecoderStream())));
}

// ---------- bus events ----------
function onBus(m) {
  if (!m || typeof m !== 'object') return;
  if (dash) dash.onBus(m);
  if (m.type === 'lock.state' && SRCH.client) lockrt.refresh().then(() => { const k = lockrt.enabled() && !lockrt.isLocked() ? lockrt.getKeys() : null; if (k) SRCH.client.post({ type: 'keys', keys: { dk: k.dk, xk: k.xk, hk: k.hk, sk: k.sk } }); }).catch(() => {}); // lock turned on / unlocked elsewhere: the search worker needs the keys
  if (m.type === 'changed') { scheduleSync(m.groups); if (S.view === 'trash' || S.view === 'settings') { clearTimeout(S._trT); S._trT = setTimeout(() => { if (S.view === 'trash') renderTrash(); else loadTrashCounts().then(() => renderTrash().catch(() => {})).catch(() => {}); }, 300); } }
  else if (m.type === 'act:purgeProgress') { const p = $('#actPurgeProg'); if (p) { p.hidden = false; const pct = m.phase === 'done' ? 100 : Math.min(99, Math.round((m.done / m.total) * 100)); p.textContent = m.phase === 'done' ? STR.actPurged : STR.actPurging(pct); } }
  else if (m.type === 'settings') { getSettings().then((s) => { S.settings = s; if (dash) dash.remount(s).then(() => { if (S.view === 'dash') dash.show(); }).catch(() => {}); applySettingsToUi(); renderSettings(); for (const [, n] of V.live) n._sig = null; applyView(); if (S.view === 'trash') renderTrashView(); }); }
  else if (m.type === 'snapbanner') renderSnapBanner(m.banner);
  else if (m.type === 'snapshots') { if (S.view === 'snaps') renderSnapView(); else loadSnapCount(); }
  else if (m.type === 'migr') { S.indexing = m.remaining > 0 ? Math.round(((m.total - m.remaining) / Math.max(1, m.total)) * 100) : null; const info = $('#searchInfo'); if (S.indexing != null && !S.query) { info.hidden = false; info.textContent = STR.indexing(S.indexing); } else if (!S.query && !S.filtersActiveLine) info.hidden = true; if (S.indexing == null) loadData().then(() => applyView()); }
  else if (m.type === 'reload') location.reload();
  else if (m.type === 'duplog') { if (S.view === 'settings') renderDupLog(); }
  else if (m.type === 'dberror') setBanner('#banner', STR.dbDown(m.error), [['retryDb', STR.retry]]);
  else if (m.type === 'progress') {
    if (m.op === 'stash') {
      if (m.finished) {
        S.drain = null;
        renderDrain();
        if (m.skipped) toast(STR.drainDone(m.closed, m.skipped), STR.closeLeftovers, async () => { const r = await send({ type: 'closeLeftovers' }); if (r.ok) toast(STR.leftoversDone(r.closed, r.left), null, null, 5000); else toastError(r); }, 20000);
        else toast(STR.drainDone(m.closed, m.skipped));
        const sk = $('#drainSkipped');
        sk.hidden = !m.skipped;
        if (m.skipped) sk.textContent = STR.skippedList(m.skipped);
        refreshStats();
        scheduleSync('all');
      } else if (m.phase === 'writing') {
        S.drain = { phase: 'writing', done: m.done, total: m.total };
        renderDrain();
      } else {
        const wasLow = lowMem();
        S.drain = { ...m };
        renderDrain();
        if (wasLow && !lowMem()) { for (const [, n] of V.live) n._sig = null; schedule(); }
      }
    } else if (m.op === 'refresh') {
      S.refresh = m.finished ? null : m.job;
      renderRefresh();
      if (m.finished) toast(m.cancelled ? STR.refreshCancel : STR.refreshDone(m.total || 0, m.skipped || 0, m.why), null, null, 3500);
    } else if (m.op === 'restore') {
      S.job = m.finished ? null : m.job;
      renderJob();
    }
  }
}

// ---------- wiring ----------
// ---------- selection / drag and drop / box selection / bulk actions (lib/selui.js) ----------
let selUi = null;
async function resolveKeys(keys) {
  const by = new Map(); const flat = []; const hits = [];
  for (const k of keys) {
    if (k[0] === 'i') { const [, gid, pos] = k.split(':'); if (!by.has(gid)) by.set(gid, []); by.get(gid).push(+pos); } else if (k[0] === 'f') flat.push(+k.slice(2));
    else if (k[0] === 'h') hits.push(k);
  }
  const res = new Map();
  const put = (k, rec) => { if (rec) res.set(k, { gid: rec.g, seq: rec.seq, url: rec.url, title: rec.title }); };
  for (const [gid, ps] of by) {
    const g = groupOf(gid);
    if (g && sortActive(g)) {
      let so = null;
      for (let i = 0; i < 30 && !so; i++) { await ensureSorted(g); const c = V.sorted.get(gid); if (c && c.sig === sortSig(g)) so = c; else await new Promise((r) => setTimeout(r, 100)); }
      for (const p of ps) put(`i:${gid}:${p}`, so && so.rows[p]);
      continue;
    }
    ps.sort((a, b) => a - b);
    for (let i = 0; i < ps.length;) { // runs of at most 2000 positions per read
      const lo = ps[i]; let j = i;
      while (j + 1 < ps.length && ps[j + 1] - lo < 2000) j++;
      const rows = await db.getItemsByPos(gid, lo, ps[j] - lo + 1);
      for (let q = i; q <= j; q++) put(`i:${gid}:${ps[q]}`, rows[ps[q] - lo]);
      i = j + 1;
    }
  }
  if (flat.length && V.fl) {
    const pages = new Map();
    for (const i of flat) { const pg = Math.floor(i / FLAT_PAGE); if (!pages.has(pg)) pages.set(pg, await V.fl.obj.page(pg)); put('f:' + i, pages.get(pg)[i - pg * FLAT_PAGE]); }
  }
  if (hits.length) {
    const m = new Map();
    for (const h of V.srows) if (h.t === 'hit') m.set('h:' + h.rec.g + ':' + h.rec.seq, h.rec);
    for (const k of hits) put(k, m.get(k));
  }
  return keys.map((k) => res.get(k)).filter(Boolean);
}
function initSelection() {
  selUi = initSelUi({
    scroller, spacer, S, V, H, isOpen, groupOf, send, toast, toastError, ICON, actBtn, STR, catAddPrompt, doRestoreGroup, allItemsOf, fmtDate, say,
    menuOpen: () => !!openMenu(), resolveKeys, kbOn,
    srcGids: (keys) => [...new Set(keys.filter((k) => k[0] === 'i').map((k) => k.split(':')[1]))],
    rowsIn: (y0, y1) => (V.mode === 'search' ? rowsSearch(y0, y1) : V.mode === 'flat' ? rowsFlat(y0, y1) : rowsGroups(y0, y1)),
  });
  globalThis.__cmr.sel = selUi; globalThis.__cmr.H = H;
}

function wire() {
  initSelection();
  document.addEventListener('click', onClick);
  $('#trashList').addEventListener('change', (e) => {
    const cb = e.target.closest('.trcb');
    if (!cb) return;
    const k = cb.closest('.trrow').dataset.k;
    if (cb.checked) S.trashSel.add(k); else S.trashSel.delete(k);
    trashBulkBtns();
  });
  $('#trashAll').addEventListener('change', (e) => {
    const tab = S.trashTab || 'all';
    for (const r of S.trashRows.values()) if (tab === 'all' || r.reason === tab) { if (e.target.checked) S.trashSel.add(r.key); else S.trashSel.delete(r.key); }
    for (const cb of document.querySelectorAll('#trashList .trcb')) cb.checked = e.target.checked;
    trashBulkBtns();
  });
  scroller.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(scroller);
  scroller.addEventListener('focusout', (e) => {
    if (e.target.classList && e.target.classList.contains('gtitle')) {
      commitTitle(e.target);
      endEdit(e.target.closest('.vrow'));
      if (S.dirtyWhileEditing) { S.dirtyWhileEditing = false; scheduleSync(null); }
      schedule();
    }
  });
  scroller.addEventListener('keydown', (e) => {
    if (e.target.classList && e.target.classList.contains('gtitle')) {
      if (e.key === 'Enter') e.target.blur();
      else if (e.key === 'Escape') { e.target.value = e.target.dataset.orig; e.target.blur(); }
    }
  });
  const search = $('#search');
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; clearTimeout(S.searchTimer); runSearch(); }
    else if (e.key === 'ArrowDown' && V.mode === 'search') {
      const first = V.srows.findIndex((r) => r.t === 'hit');
      if (first >= 0) {
        e.preventDefault();
        scroller.scrollTop = 0;
        update();
        const h = V.srows[first].rec;
        const n = V.live.get('h:' + h.g + ':' + h.seq);
        if (n && n._a) n._a.focus();
      }
    }
  });
  scroller.addEventListener('keydown', (e) => {
    if (V.mode !== 'search') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (moveResultFocus(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault(); }
    else if (e.key === 'Escape') { search.value = ''; runSearch(); search.focus(); }
  });
  // time tokens: minute ticker (visible rows only) + hover card
  startTicker(() => scroller.querySelectorAll('[data-t]'), (el, now) => {
    if (el.dataset.k === 'a2') { const t = Number(el.dataset.t); const d = relabel({ dataset: { t: String(t), k: 'u' } }, now, S.lang || 'th', STR); return d == null ? null : STR.chipLastUsed(d); }
    return relabel(el, now, S.lang || 'th', STR);
  });
  createHoverCard({
    root: scroller,
    rowsFor: (t) => {
      const now = Date.now();
      if (t.dataset.hc === 'g') { const h = t.closest('.ghead'); return h && h._gobj ? groupCard(h._gobj, now, S.lang || 'th', S.settings.dateCalendar, STR) : null; }
      const rec = t._frec;
      return rec && !t._skel ? itemCard(rec, t._g, now, S.lang || 'th', S.settings.dateCalendar, STR) : null;
    },
  });
  createHoverCard({ // peek: the first 5 titles of a collapsed set (an IDB range of 5 items, decoded by the page; never while locked)
    root: scroller, id: 'peekcard', cls: 'peek', selector: '.ghead:not(.open)[data-g]', skip: '[data-hc], button, input, a', delay: 400,
    enabled: () => S.settings.peekOnHover !== false && !(lockrt.enabled() && lockrt.isLocked()),
    rowsFor: async (t) => {
      const g = groupOf(t.dataset.g);
      if (!g || !g.count) return null;
      const rows = await db.getItemsPage(g.id, 0, 5);
      return rows.map((r, i) => ({ label: String(i + 1), value: r.title || r.url || '' }));
    },
  });
  $('#panelSettings').addEventListener('change', (e) => {
    const el = e.target;
    const k = el.dataset && el.dataset.k;
    if (!k) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (k === 'whitelist' || k === 'excludeSites') v = el.value.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if ('num' in el.dataset) v = Number(el.value);
    else v = el.value;
    const patch = { [k]: v };
    if (k === 'activityTracking' && !v) { el.checked = true; openActOffDialog(); return; } // ask first: delete the data already collected?
    if (k === 'closeDuplicates' && v !== 'off') patch.dedupeOnStash = true; // 'onStash' = the stash-time duplicate filter
    send({ type: 'saveSettings', patch }).then((r) => { if (!r.ok) toastError(r); });
  });
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { await doImportFile(f); } catch (err) { toast(STR.errorPrefix + (err && err.message)); }
    e.target.value = '';
  });
  $('#snapDlgList').addEventListener('change', (e) => {
    const i = Number(e.target.dataset && e.target.dataset.i);
    if (Number.isNaN(i) || !S.snap) return;
    if (e.target.checked) S.snap.sel.add(i); else S.snap.sel.delete(i);
    const go = $('#snapGo');
    go.textContent = STR.snapGo(S.snap.sel.size);
    go.disabled = !S.snap.sel.size;
  });
  $('#snapShowAll').addEventListener('change', (e) => { if (S.snap) { S.snap.showAll = e.target.checked; renderSnapDialog(); } });
  // drag a session onto a category in the sidebar
  scroller.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.ghead');
    if (!row) return;
    e.dataTransfer.setData('text/cmr-group', row.dataset.g);
    e.dataTransfer.effectAllowed = 'move';
  });
  const navEl = $('#nav');
  navEl.addEventListener('dragover', (e) => { const t = e.target.closest('.navi'); if (t && (t.dataset.nav === 'cat' || t.dataset.nav === 'uncat' || t.dataset.nav === 'archived') && e.dataTransfer.types.includes('text/cmr-group')) { e.preventDefault(); t.classList.add('drop'); } });
  navEl.addEventListener('dragleave', (e) => { const t = e.target.closest('.navi'); if (t) t.classList.remove('drop'); });
  navEl.addEventListener('drop', async (e) => {
    const t = e.target.closest('.navi');
    if (!t) return;
    t.classList.remove('drop');
    const gid = e.dataTransfer.getData('text/cmr-group');
    if (!gid) return;
    e.preventDefault();
    if (t.dataset.nav === 'archived') { await send({ type: 'setFlag', groupId: gid, flag: 'archived', value: true }); return; }
    const r = await send({ type: 'groupsSetCat', gids: [gid], cat: t.dataset.nav === 'cat' ? t.dataset.cat : null });
    if (r.ok) toast(STR.moved(r.n || 1), null, null, 2000);
  });
  navEl.addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.navi[data-menu-cat]');
    if (!t) return;
    e.preventDefault();
    showCatMenu(t, t.dataset.menuCat);
  });
  initCatReorder();
  // a title click can restore instead of rename (setting); double-click / F2 / the pencil rename inline
  scroller.addEventListener('click', (e) => {
    if (S.settings.titleClick !== 'restore') return;
    const t = e.target.closest && e.target.closest('.gt');
    const row = t && t.closest('[data-g]');
    if (row) doRestoreGroup(row.dataset.g);
  });
  scroller.addEventListener('dblclick', (e) => {
    const t = e.target.closest && e.target.closest('.gt');
    if (t && S.settings.titleClick !== 'restore') beginEdit(t.closest('.vrow'));
  });
  scroller.addEventListener('keydown', (e) => { // context-menu key / Shift+F10 on a set header opens its ⋯ menu next to the row
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    const row = e.target.closest && e.target.closest('.ghead');
    const vr = row && row.closest('[data-g]');
    if (!vr) return;
    e.preventDefault();
    showMore(vr.querySelector('[data-act="more"]') || row, vr.dataset.g);
  });
  scroller.addEventListener('keydown', (e) => {
    if (e.key !== 'F2' || !kbOn('kbRename')) return;
    const row = e.target.closest && e.target.closest('.ghead');
    if (row) { e.preventDefault(); beginEdit(row); }
  });
  document.addEventListener('keydown', menuKeydown, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !openMenu()) closeMenus();
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === '/' && !typing && S.view === 'list' && kbOn('kbSearch')) { e.preventDefault(); $('#search').focus(); }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && kbOn('kbPalette')) { e.preventDefault(); openCommandPalette(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && S.toastAction && kbOn('kbUndo')) { e.preventDefault(); const fn = S.toastAction; $('#toast').hidden = true; S.toastAction = null; fn(); }
  });
  bus.on(onBus);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.discarded !== undefined) { clearTimeout(S.statsTimer); S.statsTimer = setTimeout(refreshStats, 800); }
  });
  chrome.tabs.onRemoved.addListener(() => { clearTimeout(S.statsTimer); S.statsTimer = setTimeout(refreshStats, 800); });
}

async function init() {
  const t0 = performance.now();
  await lockGate({ beforeLock: () => { try { SRCH.client && SRCH.client.post({ type: 'lock' }); } catch { /* ignore */ } } }); // password lock: resolves at once when it is off; shows the lock screen (and nothing else) while locked
  try { const r = await chrome.storage.local.get('view'); if (r.view) S.vs = { ...Q.DEFAULT_VIEW, ...r.view }; } catch { /* defaults */ }
  applyStrings();
  wire();
  connectSearchWorker();
  initPermsUi({ toast: (t) => toast(t) }).catch(() => {});
  if (new URLSearchParams(location.search).get('welcome') === '1') $('#welcome').hidden = false;
  try {
    await db.openDB();
    await loadData();
  } catch (e) {
    S.dbOk = false;
    setBanner('#banner', STR.dbDown((e && e.name) || String(e)), [['retryDb', STR.retry]]);
    for (const b of document.querySelectorAll('#btnOpenAll, #btnUndoStash')) b.disabled = true;
    return;
  }
  favs.setEnabled(favsOn());
  setInterval(checkEconomy, 10000);
  setInterval(() => { if (S.drain && S.drain.lastProgressAt) renderDrain(); }, 2000); // refreshes the "waiting for Chrome" hint // (timer of the page itself, not of the service worker)
  applySettingsToUi();
  recompute();
  loadTrashCounts();
  try { S.incogAllowed = await chrome.extension.isAllowedIncognitoAccess(); } catch { S.incogAllowed = false; }
  loadSnapCount();
  checkSnap();
  renderSortBtn();
  S.drain = S.meta.drain ? { ...S.meta.drain } : null;
  S.job = S.meta.job ? { ...S.meta.job } : null;
  S.refresh = S.meta.refresh ? { total: S.meta.refresh.ids.length, done: S.meta.refresh.done, skipped: S.meta.refresh.skipped || 0 } : null;
  await initialExpand();
  layout();
  renderChrome();
  schedule();
  route();
  window.addEventListener('hashchange', route);
  { let t = 0; const mo = new MutationObserver(() => { if (t) return; t = requestAnimationFrame(() => { t = 0; mo.disconnect(); try { fitBanners(); } finally { mo.observe($('#panels'), mo.opts); } relayoutSoon(); }); }); mo.opts = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] }; mo.observe($('#panels'), mo.opts); window.addEventListener('resize', fitBanners); }
  renderActBanner();
  requestAnimationFrame(() => { globalThis.__cmr.timing.headerPaintMs = Math.round(performance.now() - t0); });
  refreshStats();
  refreshStorage();
}

init();
