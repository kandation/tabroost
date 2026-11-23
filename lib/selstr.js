// Strings of selection, drag and drop, box selection and item actions (Thai first, English overlay).
// Wording follows tools/glossary.md (tab set, tab, pin, star, to do, archive, trash).

// i18n-allow: Thai digits for the Thai table below; the English table does not use this helper
const th = (n) => Number(n).toLocaleString('th-TH');

export const TH = {
  tabsN: (n) => `${th(n)} แท็บ`, setsN: (n) => `${th(n)} ชุดแท็บ`,
  selTabs: (n) => `เลือก ${th(n)} แท็บ`, selSets: (n) => `เลือก ${th(n)} ชุดแท็บ`,
  announceSel: (n) => `เลือก ${th(n)} รายการ`, announceNone: 'ไม่ได้เลือกอะไร',
  mixedHint: 'เลือกได้ทีละแบบ: ชุดแท็บ หรือ แท็บ อย่างใดอย่างหนึ่ง',
  rangeBig: (n) => `เลือกได้ครั้งละไม่เกิน ${th(n)} รายการ`,
  bar: 'ทำกับที่เลือก', clear: 'ล้างการเลือก', open: 'เปิด', moveTo: 'ย้ายไป…', del: 'ลบ',
  copy: 'คัดลอก', copyTitle: 'คัดลอกชื่อ', copyUrl: 'คัดลอกลิงก์', copyBoth: 'คัดลอก ชื่อ | ลิงก์',
  copied: (n) => `คัดลอกแล้ว ${th(n)} รายการ`, copyFail: 'คัดลอกไม่ได้ ลองใหม่อีกครั้ง',
  star: 'ติดดาว', pin: 'ปักหมุด', todo: 'งานค้าง', archive: 'ย้ายเข้าคลัง', trash: 'ย้ายไปถังขยะ',
  newSet: 'ย้ายไปชุดใหม่', splitSet: 'แยกเป็นชุดใหม่', otherSet: 'ย้ายไปชุดอื่น…', toCat: 'ย้ายไปหมวดหมู่…',
  newInCat: 'ชุดใหม่ในหมวดนี้', pickSet: 'เลือกชุดแท็บ', pickSetPh: 'ค้นหาชุดแท็บ…', pickNone: 'ไม่พบชุดแท็บ',
  noCat: 'ยังไม่จัดหมวด', newCat: 'หมวดหมู่ใหม่…', catPrompt: 'ชื่อหมวดหมู่ใหม่',
  dropHere: 'วางที่นี่', dragHint: 'ลากไปวางที่แถบด้านซ้ายได้',
  dragSets: (n, t) => (n === 1 ? t : `${th(n)} ชุดแท็บ`), dragTabs: (n, t) => (n === 1 ? t : `${th(n)} แท็บ`),
  dragCancel: 'ยกเลิกการลากแล้ว',
  deleted: (n) => `ลบ ${th(n)} รายการแล้ว`, undo: 'เลิกทำ',
  moved: (n, to) => `ย้าย ${th(n)} แท็บไปที่ ${to} แล้ว`,
  movedNew: (n) => `ย้าย ${th(n)} แท็บไปชุดใหม่แล้ว`,
  newFrom: (n, what) => `สร้างชุดใหม่จาก ${th(n)} แท็บแล้ว${what}`,
  did: { pin: 'ปักหมุด', unpin: 'เลิกปักหมุด', star: 'ติดดาว', unstar: 'เอาดาวออก', pending: 'ใส่งานค้าง', unpending: 'เอางานค้างออก', archive: 'ย้ายเข้าคลัง', trash: 'ย้ายไปถังขยะ', cat: 'จัดหมวดหมู่', uncat: 'เอาหมวดหมู่ออก', reorder: 'เรียงลำดับใหม่' },
  setDone: (n, did) => `${did} ${th(n)} ชุดแท็บแล้ว`,
  sameSet: 'แท็บอยู่ในชุดนี้อยู่แล้ว', lockedSet: 'ชุดแท็บนี้ล็อกอยู่ ปลดล็อกก่อน',
  rowLabel: 'เลือกแถวนี้', listLabel: 'รายการที่เก็บไว้ (เลือกได้หลายรายการ)',
  kbHelp: 'เว้นวรรคเพื่อเลือก, Shift + ลูกศรเพื่อเลือกต่อ, Ctrl + A เลือกทั้งหมด, Delete เพื่อลบ',
  delTab: 'ลบแท็บนี้', delSel: (n) => `ลบ ${th(n)} แท็บที่เลือก`,
  moveFailed: 'ย้ายไม่สำเร็จ ลองใหม่อีกครั้ง',
  ghostSets: 'ชุดแท็บ',
};

export const EN = {
  tabsN: (n) => `${n} tab${n === 1 ? '' : 's'}`, setsN: (n) => `${n} tab set${n === 1 ? '' : 's'}`,
  selTabs: (n) => `${n} tab${n === 1 ? '' : 's'} selected`, selSets: (n) => `${n} tab set${n === 1 ? '' : 's'} selected`,
  announceSel: (n) => `${n} selected`, announceNone: 'Nothing selected',
  mixedHint: 'Select either tab sets or tabs, not both',
  rangeBig: (n) => `You can select up to ${n} items at a time`,
  bar: 'Actions for the selection', clear: 'Clear selection', open: 'Open', moveTo: 'Move to…', del: 'Delete',
  copy: 'Copy', copyTitle: 'Copy title', copyUrl: 'Copy link', copyBoth: 'Copy title | link',
  copied: (n) => `Copied ${n} item${n === 1 ? '' : 's'}`, copyFail: 'Could not copy. Try again.',
  star: 'Star', pin: 'Pin', todo: 'To do', archive: 'Move to archive', trash: 'Move to trash',
  newSet: 'Move to a new tab set', splitSet: 'Split into a new tab set', otherSet: 'Move to another tab set…', toCat: 'Move to category…',
  newInCat: 'New tab set in this category', pickSet: 'Choose a tab set', pickSetPh: 'Search tab sets…', pickNone: 'No tab set found',
  noCat: 'No category', newCat: 'New category…', catPrompt: 'Name of the new category',
  dropHere: 'Drop here', dragHint: 'Drag onto the sidebar on the left',
  dragSets: (n, t) => (n === 1 ? t : `${n} tab sets`), dragTabs: (n, t) => (n === 1 ? t : `${n} tabs`),
  dragCancel: 'Drag cancelled',
  deleted: (n) => `Deleted ${n} item${n === 1 ? '' : 's'}`, undo: 'Undo',
  moved: (n, to) => `Moved ${n} tab${n === 1 ? '' : 's'} to ${to}`,
  movedNew: (n) => `Moved ${n} tab${n === 1 ? '' : 's'} to a new tab set`,
  newFrom: (n, what) => `Made a new tab set from ${n} tab${n === 1 ? '' : 's'} and ${what}`,
  did: { pin: 'pinned', unpin: 'unpinned', star: 'starred', unstar: 'unstarred', pending: 'marked as to do', unpending: 'removed from to do', archive: 'moved to archive', trash: 'moved to trash', cat: 'put in the category', uncat: 'removed from its category', reorder: 'reordered' },
  setDone: (n, did) => `${n} tab set${n === 1 ? '' : 's'} ${did}`,
  sameSet: 'The tabs are already in this tab set', lockedSet: 'This tab set is locked. Unlock it first.',
  rowLabel: 'Select this row', listLabel: 'Saved list (select several items)',
  kbHelp: 'Space to select, Shift + arrow keys to extend, Ctrl + A for all, Delete to remove',
  delTab: 'Delete this tab', delSel: (n) => `Delete the ${n} selected tab${n === 1 ? '' : 's'}`,
  moveFailed: 'Could not move. Try again.',
  ghostSets: 'tab sets',
};

export const strings = (lang) => (lang === 'en' ? EN : TH);
