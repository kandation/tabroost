// Demo data for the store screenshots. Everything is invented: plausible page titles on well-known public sites, no personal data.
// Site icons are drawn here (a coloured rounded square with a letter): no third-party logo is used and nothing is fetched from the web.

// host -> [letter, colour]
export const SITES = {
  'www.figma.com': ['F', '#a259ff'], 'github.com': ['G', '#24292f'], 'developer.mozilla.org': ['M', '#1f1f1f'], 'stackoverflow.com': ['S', '#f48024'],
  'web.dev': ['W', '#3367d6'], 'www.notion.so': ['N', '#111111'], 'linear.app': ['L', '#5e6ad2'], 'docs.google.com': ['D', '#4285f4'],
  'www.google.com': ['G', '#4285f4'], 'www.agoda.com': ['A', '#e2324a'], 'www.airbnb.com': ['A', '#ff5a5f'], 'www.tripadvisor.com': ['T', '#00aa6c'],
  'www.youtube.com': ['Y', '#e62117'], 'www.skyscanner.com': ['S', '#0770e3'], 'www.wongnai.com': ['W', '#2a9df4'], 'pantip.com': ['P', '#3c3963'],
  'en.wikipedia.org': ['W', '#54595d'], 'th.wikipedia.org': ['W', '#54595d'], 'medium.com': ['M', '#191919'], 'www.theverge.com': ['V', '#5200ff'],
  'news.ycombinator.com': ['Y', '#ff6600'], 'arxiv.org': ['X', '#b31b1b'], 'www.bbc.com': ['B', '#111111'], 'www.nytimes.com': ['T', '#222222'],
  'www.ikea.com': ['I', '#0058a3'], 'www.amazon.com': ['A', '#ff9900'], 'shopee.co.th': ['S', '#ee4d2d'], 'www.lazada.co.th': ['L', '#0f146d'],
  'www.uniqlo.com': ['U', '#e60012'], 'doc.rust-lang.org': ['R', '#b7410e'], 'www.coursera.org': ['C', '#0056d2'], 'www.freecodecamp.org': ['F', '#0a0a23'],
  'exercism.org': ['E', '#604fcd'], 'www.khanacademy.org': ['K', '#14bf96'], 'open.spotify.com': ['S', '#1db954'], 'www.netflix.com': ['N', '#e50914'],
  'mail.google.com': ['M', '#ea4335'], 'calendar.google.com': ['C', '#1a73e8'], 'www.reddit.com': ['R', '#ff4500'], 'www.canva.com': ['C', '#00c4cc'],
  'trello.com': ['T', '#0079bf'], 'slack.com': ['S', '#4a154b'], 'www.dropbox.com': ['D', '#0061ff'], 'www.imdb.com': ['I', '#d9a900'],
  'www.allrecipes.com': ['A', '#f15025'], 'cooking.nytimes.com': ['C', '#d0021b'], 'www.booking.com': ['B', '#003580'], 'www.duolingo.com': ['D', '#58cc02'],
  'www.sanook.com': ['S', '#e4002b'], 'www.thairath.co.th': ['T', '#0a8a3a'], 'meet.google.com': ['M', '#00897b'],
};
export const iconSvg = (host) => { const [l, c] = SITES[host] || [host.replace(/^www\./, '')[0].toUpperCase(), '#667788']; return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><!-- ${host} --><rect width="32" height="32" rx="8" fill="${c}"/><text x="16" y="23" font-family="Segoe UI,Arial,sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="#fff">${l}</text></svg>`; };

const H = 3600000; const D = 86400000;
const T = (lang, en, th) => (lang === 'th' ? th : en);

// The tab sets at the top of the list. items: [url, title, tabGroupIndex?]
export function featured(lang) {
  const t = (en, th) => T(lang, en, th);
  return [
    { title: t('Website redesign', 'รีดีไซน์เว็บไซต์'), emoji: '🎨', color: 'purple', cat: 'work', ago: 25 * 60000, starred: true,
      tabGroups: [{ title: t('Design', 'ดีไซน์'), color: 'purple' }, { title: t('Code', 'โค้ด'), color: 'blue' }],
      items: [
        ['https://www.figma.com/file/landing-v3', 'Landing page v3 – Figma', 0],
        ['https://www.figma.com/file/design-system', 'Design system · Components – Figma', 0],
        ['https://www.canva.com/design/hero', t('Hero illustration – Canva', 'ภาพประกอบหน้าแรก – Canva'), 0],
        ['https://github.com/acme/web/pull/218', 'Fix search index rebuild · Pull Request #218 · acme/web', 1],
        ['https://github.com/acme/web/issues', 'Issues · acme/web', 1],
        ['https://developer.mozilla.org/docs/Web/CSS/CSS_grid_layout', 'CSS grid layout - CSS | MDN', 1],
        ['https://stackoverflow.com/questions/24004791', 'How do I debounce a function in JavaScript? - Stack Overflow', 1],
        ['https://web.dev/articles/lcp', 'Largest Contentful Paint (LCP) | web.dev'],
        ['https://www.notion.so/launch-checklist', t('Launch checklist – Notion', 'เช็กลิสต์ก่อนเปิดตัว – Notion')],
      ] },
    { title: t('Chiang Mai', 'เชียงใหม่'), emoji: '✈️', color: 'green', cat: 'travel', ago: 3 * H, pinned: true,
      items: [
        ['https://www.google.com/maps/place/chiang-mai', t('Chiang Mai Old City - Google Maps', 'เมืองเก่าเชียงใหม่ - Google Maps')],
        ['https://www.agoda.com/city/chiang-mai', t('Hotels in Nimman, Chiang Mai | Agoda', 'โรงแรมย่านนิมมาน เชียงใหม่ | Agoda')],
        ['https://www.airbnb.com/s/chiang-mai', t('Chiang Mai · Stays · Airbnb', 'เชียงใหม่ · ที่พัก · Airbnb')],
        ['https://www.skyscanner.com/bkk-cnx', t('Cheap flights from Bangkok to Chiang Mai | Skyscanner', 'ตั๋วเครื่องบินกรุงเทพ–เชียงใหม่ราคาถูก | Skyscanner')],
        ['https://www.youtube.com/watch?v=cnx3days', t('3 Days in Chiang Mai: Complete Travel Guide - YouTube', 'เที่ยวเชียงใหม่ 3 วัน 2 คืน ฉบับจัดเต็ม - YouTube')],
        ['https://www.wongnai.com/listings/nimman-cafes', '10 ร้านกาแฟนิมมานที่ต้องไปสักครั้ง | Wongnai'],
        ['https://pantip.com/topic/42100001', 'รีวิวเที่ยวเชียงใหม่หน้าหนาว ขับรถขึ้นดอยอินทนนท์ - Pantip'],
        ['https://www.tripadvisor.com/chiang-mai-things-to-do', t('THE 15 BEST Things to Do in Chiang Mai - Tripadvisor', '15 ที่เที่ยวเชียงใหม่ที่ดีที่สุด - Tripadvisor')],
      ] },
    { title: t('Read later', 'อ่านทีหลัง'), emoji: '📚', color: 'orange', cat: 'reading', ago: 22 * H,
      items: [
        ['https://en.wikipedia.org/wiki/Circadian_rhythm', t('Circadian rhythm - Wikipedia', 'นาฬิกาชีวภาพ - วิกิพีเดีย')],
        ['https://www.theverge.com/tech/browser-memory', t('Why your browser eats so much memory - The Verge', 'ทำไมเบราว์เซอร์กินแรมเยอะ - The Verge')],
        ['https://news.ycombinator.com/item?id=41000001', 'Show HN: A tiny search engine that fits in a browser tab | Hacker News'],
        ['https://arxiv.org/abs/1706.03762', '[1706.03762] Attention Is All You Need'],
        ['https://medium.com/design/typography-on-the-web', t('A practical guide to typography on the web | Medium', 'คู่มือการใช้ตัวอักษรบนเว็บ | Medium')],
        ['https://www.bbc.com/future/article/sleep-science', t('The science of a good night’s sleep - BBC Future', 'วิทยาศาสตร์ของการนอนหลับที่ดี - BBC Future')],
      ] },
    { title: t('Learn Rust', 'เรียน Rust'), emoji: '🦀', color: 'red', cat: 'learning', ago: 2 * D + 4 * H,
      items: [
        ['https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', 'What is Ownership? - The Rust Programming Language'],
        ['https://exercism.org/tracks/rust', 'Rust on Exercism'],
        ['https://www.youtube.com/watch?v=rust101', t('Rust in 100 minutes: full beginner course - YouTube', 'สอน Rust ตั้งแต่เริ่มต้นใน 100 นาที - YouTube')],
        ['https://www.freecodecamp.org/news/rust-in-replit', 'Rust Programming Course for Beginners - freeCodeCamp'],
        ['https://www.coursera.org/learn/rust-fundamentals', 'Rust Fundamentals | Coursera'],
      ] },
    { title: t('Home office shopping', 'ของแต่งโต๊ะทำงาน'), emoji: '🛒', color: 'cyan', cat: 'shopping', ago: 3 * D + 2 * H,
      items: [
        ['https://www.ikea.com/p/desk-140x60', t('Standing desk 140x60 cm - IKEA', 'โต๊ะปรับระดับ 140x60 ซม. - IKEA')],
        ['https://shopee.co.th/monitor-arm', 'แขนจับจอมอนิเตอร์ ปรับระดับได้ | Shopee Thailand'],
        ['https://www.lazada.co.th/keyboard-75', 'คีย์บอร์ดไร้สาย 75% | Lazada.co.th'],
        ['https://www.amazon.com/dp/B0DESKLAMP', t('LED desk lamp with wireless charger : Amazon.com', 'โคมไฟตั้งโต๊ะ LED พร้อมแท่นชาร์จไร้สาย : Amazon.com')],
        ['https://www.uniqlo.com/th/fleece', t('Fleece full-zip jacket | UNIQLO', 'เสื้อแจ็กเก็ตฟลีซ | UNIQLO')],
      ] },
  ];
}
export const categories = (lang) => [
  { key: 'work', name: T(lang, 'Work', 'งาน'), color: 'purple' }, { key: 'travel', name: T(lang, 'Travel', 'ท่องเที่ยว'), color: 'green' },
  { key: 'reading', name: T(lang, 'Reading', 'อ่าน'), color: 'orange' }, { key: 'learning', name: T(lang, 'Learning', 'เรียนรู้'), color: 'red' },
  { key: 'shopping', name: T(lang, 'Shopping', 'ช้อปปิ้ง'), color: 'cyan' },
];

// Older bulk sets so the totals are realistic (3,420 saved tabs in all). Deterministic pseudo-random, titles built from word lists.
const W = {
  topic: ['Memory paging', 'Zettelkasten', 'Pomodoro Technique', 'Thai tea', 'Circadian rhythm', 'History of the web browser', 'Spaced repetition', 'Kanban', 'Bauhaus', 'Fermentation', 'Monsoon', 'Lanna architecture', 'Typography', 'Colour theory', 'Public-key cryptography', 'Bloom filter', 'B-tree', 'Trie', 'Garbage collection', 'Unicode', 'Thai script', 'Mekong', 'Doi Inthanon', 'Sourdough', 'Espresso', 'Marathon', 'Ukiyo-e', 'Tea ceremony', 'Light pollution', 'Tidal energy', 'Coral reef', 'Rice terrace', 'Night market', 'Bullet journal', 'Mind map', 'Fuzzy search', 'Inverted index', 'Tab (interface)', 'Sleep hygiene', 'Deep work'],
  how: ['debounce a function', 'cancel a fetch request', 'center a div', 'deep clone an object', 'sort an array of objects', 'parse a date string', 'read a file line by line', 'merge two branches', 'undo the last commit', 'format a number as currency', 'remove duplicates from a list', 'measure page load time', 'store data offline', 'detect dark mode', 'lazy-load images', 'write a unit test'],
  lang: ['JavaScript', 'TypeScript', 'Python', 'Rust', 'Go', 'CSS', 'SQL', 'Swift'],
  api: ['Array.prototype.flatMap()', 'IndexedDB API', 'Service Worker API', ':has()', 'Intl.DateTimeFormat', 'Web Crypto API', 'structuredClone()', 'Intersection Observer API', 'container queries', 'View Transitions API', 'Fetch API', 'Web Locks API', 'Popover API', 'CSS nesting', 'scroll-snap-type', 'AbortController', 'Navigator.storage', 'requestIdleCallback()'],
  verb: ['Fix', 'Add', 'Refactor', 'Speed up', 'Document', 'Remove', 'Test', 'Simplify'],
  thing: ['search index rebuild', 'dark theme tokens', 'empty state', 'keyboard shortcuts', 'import dialog', 'date formatting', 'settings page', 'drag and drop', 'onboarding tour', 'sync retry', 'cache warm-up', 'error toasts', 'tab group restore', 'export to CSV'],
  repo: ['web', 'api', 'tokens', 'docs', 'mobile'],
  vid: ['Lo-fi beats to focus', 'Pad kra pao in 10 minutes', 'Desk setup tour 2026', 'Beginner yoga, 20 minutes', 'How to fold a fitted sheet', 'Tokyo street food tour', 'Mechanical keyboard sound test', 'Learn Git in 15 minutes', 'Sharpen a kitchen knife', 'Night train across Thailand', 'Build a bookshelf from scratch', 'Morning stretch routine', 'Film photography for beginners', 'How noise cancelling works', 'CSS grid in 100 seconds', 'Make cold brew at home'],
  guide: ['deep work', 'calm software', 'writing clear commit messages', 'shipping a side project', 'naming things', 'remote meetings', 'keyboard-first interfaces', 'personal knowledge bases', 'reading more books', 'saying no', 'faster code review', 'small teams'],
  prod: ['USB-C hub 7-in-1', 'Noise cancelling headphones', 'Ergonomic mouse', '27-inch 4K monitor', 'Laptop stand, aluminium', 'Mechanical keyboard, 75%', 'Webcam 1080p', 'Portable SSD 1 TB', 'Desk mat, wool felt', 'LED desk lamp', 'Carry-on suitcase 20 inch', 'Running shoes', 'Insulated bottle 500 ml', 'Pour-over kettle', 'Bookcase, white 80x202 cm', 'Office chair with headrest'],
  place: ['Kyoto', 'Krabi', 'Chiang Rai', 'Hokkaido', 'Seoul', 'Da Nang', 'Phuket', 'Taipei', 'Lisbon', 'Hua Hin', 'Osaka', 'Bali'],
  doc: ['roadmap', 'meeting notes', 'budget', 'kickoff deck', 'retro', 'hiring plan', 'launch checklist', 'user interviews', 'pricing ideas', 'OKRs'],
  thRev: ['เที่ยวญี่ปุ่นด้วยตัวเอง 7 วัน', 'คอนโดใกล้รถไฟฟ้า', 'โน้ตบุ๊กทำงานเบา ๆ', 'หูฟังไร้สายตัดเสียงรบกวน', 'ร้านอาหารอร่อยย่านอารีย์', 'คอร์สเรียนภาษาอังกฤษออนไลน์', 'ที่พักเขาใหญ่วิวภูเขา', 'รองเท้าวิ่งมือใหม่', 'เก้าอี้ทำงานเพื่อสุขภาพ', 'บัตรเครดิตสายเที่ยว', 'เที่ยวน่านหน้าฝน', 'กล้องฟิล์มตัวแรก'],
  thHow: ['ออมเงินให้ได้แสนแรก', 'ทำต้มยำกุ้งน้ำข้น', 'จัดโต๊ะทำงานให้น่านั่ง', 'ยื่นภาษีออนไลน์', 'เลือกซื้อประกันสุขภาพ', 'ปลูกผักสวนครัวบนระเบียง', 'ฝึกวิ่ง 10 กิโลเมตร', 'อ่านหนังสือให้จบเล่ม', 'วางแผนเที่ยวเชียงรายสามวัน', 'ทำข้าวมันไก่ที่บ้าน'],
  thProd: ['กระเป๋าเดินทาง 24 นิ้ว', 'พัดลมตั้งโต๊ะไร้สาย', 'หม้อทอดไร้น้ำมัน 5 ลิตร', 'โคมไฟอ่านหนังสือ', 'ชั้นวางของเหล็ก 4 ชั้น', 'แก้วเก็บความเย็น', 'เสื่อโยคะกันลื่น', 'สายชาร์จ USB-C 2 เมตร'],
};
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const GEN = {
  work: [['github.com', (p) => p('verb') + ' ' + p('thing') + ' · Pull Request #' + p(900, 100) + ' · acme/' + p('repo')], ['github.com', (p) => 'Issue #' + p(900, 100) + ': ' + p('thing') + ' · acme/' + p('repo')], ['stackoverflow.com', (p) => 'How to ' + p('how') + ' in ' + p('lang') + '? - Stack Overflow'], ['developer.mozilla.org', (p) => p('api') + ' | MDN'], ['docs.google.com', (p) => 'Q' + p(4, 1) + ' ' + p('doc') + ' - Google Docs'], ['linear.app', (p) => 'WEB-' + p(900, 100) + ' ' + p('verb') + ' ' + p('thing') + ' – Linear'], ['www.notion.so', (p) => cap(p('doc')) + ' · ' + p('thing') + ' – Notion'], ['trello.com', (p) => cap(p('thing')) + ' | Trello'], ['www.figma.com', (p) => cap(p('thing')) + ' v' + p(6, 1) + ' – Figma'], ['web.dev', (p) => 'How to ' + p('how') + ' | web.dev']],
  reading: [['en.wikipedia.org', (p) => p('topic') + ' - Wikipedia'], ['medium.com', (p) => 'Notes on ' + p('guide') + ' | Medium'], ['medium.com', (p) => p('topic') + ': a practical guide | Medium'], ['www.theverge.com', (p) => 'The best ' + p('prod').toLowerCase() + ' of 2026 - The Verge'], ['news.ycombinator.com', (p) => 'Ask HN: How do you approach ' + p('guide') + '? | Hacker News'], ['news.ycombinator.com', (p) => 'Show HN: ' + p('topic') + ' in a single HTML file | Hacker News'], ['www.bbc.com', (p) => 'The hidden story of ' + p('topic').toLowerCase() + ' - BBC Future'], ['arxiv.org', (p) => '[2' + p(6, 1) + p(3, 10) + '.' + p(9000, 1000) + '] A survey of ' + p('topic').toLowerCase()], ['www.reddit.com', (p) => 'What is your take on ' + p('guide') + '? : r/productivity'], ['www.nytimes.com', (p) => '36 Hours in ' + p('place') + ' - The New York Times']],
  life: [['www.youtube.com', (p) => p('vid') + ' - YouTube'], ['www.allrecipes.com', (p) => ['Easy weeknight green curry', 'One-pan lemon chicken', 'Mango sticky rice', 'Crispy garlic tofu', 'Tom kha soup', 'Banana pancakes'][p(6, 0)] + ' (' + p(40, 15) + ' min) | Allrecipes'], ['www.imdb.com', (p) => 'Best ' + ['series', 'documentaries', 'comedies', 'thrillers'][p(4, 0)] + ' of ' + p(8, 2019) + ' - IMDb'], ['www.booking.com', (p) => 'Hotels in ' + p('place') + ' | Booking.com'], ['www.ikea.com', (p) => p('prod') + ' - IKEA'], ['www.amazon.com', (p) => p('prod') + ' : Amazon.com'], ['shopee.co.th', (p) => p('thProd') + ' | Shopee Thailand'], ['www.lazada.co.th', (p) => p('thProd') + ' | Lazada.co.th'], ['www.duolingo.com', (p) => ['Japanese', 'Korean', 'Spanish', 'French'][p(4, 0)] + ' - Unit ' + p(40, 1) + ' | Duolingo'], ['www.khanacademy.org', (p) => p('topic') + ' | Khan Academy'], ['pantip.com', (p) => 'รีวิว' + p('thRev') + ' - Pantip'], ['pantip.com', (p) => 'ขอคำแนะนำ วิธี' + p('thHow') + ' - Pantip'], ['www.sanook.com', (p) => 'วิธี' + p('thHow') + ' | Sanook'], ['th.wikipedia.org', (p) => ['ดอยอินทนนท์', 'ต้มยำ', 'แม่น้ำโขง', 'ล้านนา', 'ข้าวเหนียวมะม่วง', 'ตลาดน้ำ'][p(6, 0)] + ' - วิกิพีเดีย'], ['www.wongnai.com', (p) => 'ร้านเด็ด' + ['ย่านอารีย์', 'ย่านทองหล่อ', 'ในเชียงใหม่', 'ริมแม่น้ำ', 'ใกล้รถไฟฟ้า'][p(5, 0)] + ' ' + p(20, 5) + ' ร้าน | Wongnai'], ['www.tripadvisor.com', (p) => 'Things to do in ' + p('place') + ' - Tripadvisor']],
};
// One-off rows that make the search demos varied: "design" (typed with a typo) and "กาแฟ" (coffee).
const SPECIAL = [
  ['www.figma.com', 'Design tokens – Figma'], ['medium.com', 'Design tokens, explained simply | Medium'], ['www.youtube.com', 'Design systems in 20 minutes - YouTube'], ['en.wikipedia.org', 'The Design of Everyday Things - Wikipedia'],
  ['web.dev', 'Designing for dark mode | web.dev'], ['www.coursera.org', 'UX Design Fundamentals | Coursera'], ['www.notion.so', 'Design review notes – Notion'], ['github.com', 'Add design tokens · Pull Request #302 · acme/web'],
  ['www.reddit.com', 'Best design books for developers? : r/web_design'], ['www.canva.com', 'Poster design templates – Canva'], ['news.ycombinator.com', 'The design of a tiny database | Hacker News'], ['www.theverge.com', 'The design story behind foldable phones - The Verge'],
  ['www.youtube.com', 'วิธีดริปกาแฟที่บ้านสำหรับมือใหม่ - YouTube'], ['th.wikipedia.org', 'กาแฟ - วิกิพีเดีย'], ['pantip.com', 'รีวิวเครื่องชงกาแฟราคาไม่เกิน 5,000 บาท - Pantip'], ['shopee.co.th', 'เมล็ดกาแฟคั่วกลาง ดอยช้าง 250 กรัม | Shopee Thailand'],
  ['www.wongnai.com', 'คาเฟ่กาแฟสเปเชียลตี้ย่านอารีย์ | Wongnai'], ['www.sanook.com', 'ดื่มกาแฟวันละกี่แก้วถึงจะพอดี | Sanook'], ['www.lazada.co.th', 'เครื่องบดกาแฟมือหมุน | Lazada.co.th'], ['www.thairath.co.th', 'ราคากาแฟโลกพุ่ง กระทบร้านกาแฟไทย | ไทยรัฐ'],
];
const NAMES = {
  en: ['Sprint planning', 'Apartment hunt', 'Gift ideas', 'Conference talks', 'Thesis sources', 'Tax paperwork', 'Kyoto in spring', 'Recipes to try', 'Laptop research', 'Side project', 'Onboarding docs', 'Weekend reads', 'Bug triage', 'Podcast backlog', 'Marathon training', 'Portfolio refresh', 'Japanese practice', 'Kitchen makeover', 'Quarterly review', 'Movie night'],
  th: ['วางแผนสปรินต์', 'หาคอนโด', 'ไอเดียของขวัญ', 'ทอล์กงานสัมมนา', 'อ้างอิงวิทยานิพนธ์', 'เอกสารภาษี', 'เกียวโตหน้าซากุระ', 'สูตรอาหารน่าลอง', 'หาโน้ตบุ๊กใหม่', 'โปรเจกต์ส่วนตัว', 'เอกสารเริ่มงาน', 'อ่านวันหยุด', 'ไล่แก้บั๊ก', 'พอดแคสต์ค้างฟัง', 'ซ้อมวิ่งมาราธอน', 'ปรับพอร์ตโฟลิโอ', 'ฝึกภาษาญี่ปุ่น', 'แต่งครัวใหม่', 'สรุปงานไตรมาส', 'คืนดูหนัง'],
};
const EMO = ['🗂️', '🏠', '🎁', '🎤', '🎓', '🧾', '🌸', '🍜', '💻', '🚀', '📄', '☕', '🐞', '🎧', '🏃', '🖼️', '🗾', '🍳', '📊', '🎬'];
const CATOF = ['work', 'life', 'life', 'work', 'reading', 'work', 'life', 'life', 'reading', 'work', 'work', 'reading', 'work', 'life', 'life', 'work', 'life', 'life', 'work', 'life'];
const CATKEY = { work: 'work', reading: 'reading', life: null };
export function bulk(lang, total) {
  let seed = 20261124; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const p = (a, base) => (typeof a === 'number' ? base + Math.floor(rnd() * a) : W[a][Math.floor(rnd() * W[a].length)]);
  const used = new Set(); const out = []; let left = total; const N = 64;
  for (let i = 0; i < N; i++) {
    const kind = CATOF[i % 20]; const gens = GEN[kind];
    const r = rnd(); const size = r < 0.3 ? 4 + rnd() * 16 : r < 0.8 ? 25 + rnd() * 50 : 80 + rnd() * 90;
    let n = i === N - 1 ? left : Math.round(size); n = Math.max(3, Math.min(n, left - (N - 1 - i) * 3)); left -= n;
    const items = [];
    if (i < SPECIAL.length) { const [h, t] = SPECIAL[i]; items.push(['https://' + h + '/s/' + i, t]); }
    let guard = 0;
    while (items.length < n && guard++ < n * 40) {
      const [host, fn] = gens[Math.floor(rnd() * gens.length)]; let title = fn(p);
      for (let k = 0; k < 8 && used.has(title); k++) title = fn(p);
      if (used.has(title) && guard < n * 30) continue;
      used.add(title); items.push(['https://' + host + '/p/' + i + '-' + items.length, title]);
    }
    const named = i < 20 || rnd() < 0.5;
    out.push({ title: named ? NAMES[lang][i % 20] + (i >= 20 ? ' ' + (1 + Math.floor(i / 20)) : '') : '', emoji: named && rnd() < 0.7 ? EMO[i % 20] : '', color: named && rnd() < 0.5 ? ['blue', 'pink', 'yellow', 'grey', 'green', 'purple'][i % 6] : '', cat: CATKEY[kind], ago: (5 + i * 1.9) * D + Math.floor(rnd() * 8) * H, items });
  }
  return out;
}

// Real open tabs for the popup shot: [url, title, state]  state: 'sleep' | 'media' | 'form' | 'open'
export const liveTabs = (lang) => [
  ['https://open.spotify.com/playlist/focus', T(lang, 'Deep Focus · Playlist - Spotify', 'Deep Focus · เพลย์ลิสต์ - Spotify'), 'media'],
  ['https://www.youtube.com/watch?v=lofi', T(lang, 'Lo-fi beats to focus - YouTube', 'เพลง Lo-fi ฟังตอนทำงาน - YouTube'), 'media'],
  ['https://meet.google.com/abc-defg-hij', T(lang, 'Weekly design sync - Google Meet', 'ประชุมทีมประจำสัปดาห์ - Google Meet'), 'open'],
  ['https://docs.google.com/document/d/proposal', T(lang, 'Project proposal (draft) - Google Docs', 'ข้อเสนอโครงการ (ฉบับร่าง) - Google Docs'), 'form'],
  ['https://mail.google.com/mail/compose', T(lang, 'New message - Gmail', 'ข้อความใหม่ - Gmail'), 'form'],
  ['https://github.com/acme/web/pull/218', 'Fix search index rebuild · Pull Request #218 · acme/web', 'sleep'],
  ['https://www.figma.com/file/landing-v3', 'Landing page v3 – Figma', 'sleep'],
  ['https://en.wikipedia.org/wiki/Circadian_rhythm', T(lang, 'Circadian rhythm - Wikipedia', 'นาฬิกาชีวภาพ - วิกิพีเดีย'), 'sleep'],
  ['https://www.theverge.com/tech/browser-memory', T(lang, 'Why your browser eats so much memory - The Verge', 'ทำไมเบราว์เซอร์กินแรมเยอะ - The Verge'), 'sleep'],
  ['https://stackoverflow.com/questions/24004791', 'How do I debounce a function in JavaScript? - Stack Overflow', 'sleep'],
  ['https://www.agoda.com/city/chiang-mai', T(lang, 'Hotels in Nimman, Chiang Mai | Agoda', 'โรงแรมย่านนิมมาน เชียงใหม่ | Agoda'), 'sleep'],
  ['https://news.ycombinator.com/item?id=41000001', 'Show HN: A tiny search engine that fits in a browser tab | Hacker News', 'sleep'],
  ['https://www.ikea.com/p/desk-140x60', T(lang, 'Standing desk 140x60 cm - IKEA', 'โต๊ะปรับระดับ 140x60 ซม. - IKEA'), 'sleep'],
  ['https://www.notion.so/launch-checklist', T(lang, 'Launch checklist – Notion', 'เช็กลิสต์ก่อนเปิดตัว – Notion'), 'sleep'],
  ['https://www.reddit.com/r/chrome/top', 'What extension can you not live without? : r/chrome', 'sleep'],
  ['https://arxiv.org/abs/1706.03762', '[1706.03762] Attention Is All You Need', 'sleep'],
  ['https://www.airbnb.com/s/chiang-mai', T(lang, 'Chiang Mai · Stays · Airbnb', 'เชียงใหม่ · ที่พัก · Airbnb'), 'sleep'],
  ['https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', 'What is Ownership? - The Rust Programming Language', 'sleep'],
  ['https://calendar.google.com/calendar/week', T(lang, 'Google Calendar - Week of 23 November', 'Google ปฏิทิน - สัปดาห์ที่ 23 พฤศจิกายน'), 'open'],
];
export const allHosts = () => Object.keys(SITES);
