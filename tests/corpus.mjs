// Seeded synthetic corpus (mixed Thai / English / mixed titles + urls) for the search tests and benchmarks.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EN_BASE = ('the of and to in is you that it he was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much before go good new write our used me man too any day same right look think also around another came come work three word must because does part even place well such here take why things help put years different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house don world going want school important until form food keep children feet land side without boy once animals life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen didn car morning added inside body dog family easy cut front fast area price build story phone mobile video music movie game github youtube google amazon facebook twitter reddit stackoverflow wikipedia netflix spotify linkedin docker kubernetes python javascript typescript rust golang database server client browser extension tutorial documentation review shopping travel hotel flight recipe weather news sports finance market stock crypto').split(/\s+/);

const TH_BASE = 'ค้นหา แท็บ ข่าว กีฬา เพลง หนัง ละคร ร้านอาหาร ท่องเที่ยว โรงแรม สั่งซื้อ ราคา โปรโมชั่น ลดราคา สินค้า มือถือ คอมพิวเตอร์ โน้ตบุ๊ก เกม ออนไลน์ เรียน มหาวิทยาลัย โรงเรียน การบ้าน สอบ คะแนน ข้อสอบ งาน สมัคร บริษัท เงินเดือน ภาษี ธนาคาร บัญชี โอนเงิน กองทุน หุ้น ทอง น้ำมัน อากาศ ฝน พายุ น้ำท่วม จราจร รถไฟ เครื่องบิน ตั๋ว แผนที่ ร้านกาแฟ ขนม ผลไม้ ผัก หมู ไก่ ปลา กุ้ง ข้าว ก๋วยเตี๋ยว ส้มตำ ต้มยำ แกง ผัด ทอด ย่าง สุขภาพ ออกกำลังกาย โรงพยาบาล หมอ ยา วัคซีน ไข้หวัด โควิด ความรัก ครอบครัว เพื่อน เด็ก ผู้ใหญ่ คนชรา สัตว์เลี้ยง สุนัข แมว นก ต้นไม้ ดอกไม้ สวน บ้าน คอนโด เช่า ซื้อ ขาย ที่ดิน รถยนต์ มอเตอร์ไซค์ ประกัน ซ่อม ช่าง ไฟฟ้า น้ำประปา อินเทอร์เน็ต แอพ โปรแกรม ภาษา อังกฤษ ญี่ปุ่น เกาหลี จีน ประวัติศาสตร์ วิทยาศาสตร์ คณิตศาสตร์ ศิลปะ ดนตรี ภาพยนตร์ นิยาย การ์ตูน ซีรีส์ ไลฟ์สไตล์ แฟชั่น ความงาม เสื้อผ้า รองเท้า กระเป๋า นาฬิกา'.split(/\s+/);

const HOSTS = ['youtube.com', 'github.com', 'google.com', 'facebook.com', 'twitter.com', 'reddit.com', 'stackoverflow.com', 'wikipedia.org', 'netflix.com', 'amazon.com', 'pantip.com', 'sanook.com', 'kapook.com', 'thairath.co.th', 'lazada.co.th', 'shopee.co.th', 'medium.com', 'notion.so', 'figma.com', 'docs.google.com', 'drive.google.com', 'mail.google.com', 'claude.ai', 'chatgpt.com', 'colab.research.google.com', 'arxiv.org', 'npmjs.com', 'developer.mozilla.org', 'news.ycombinator.com', 'linkedin.com'];

function pseudoWord(r) {
  const C = 'bcdfghjklmnprstvwz';
  const V = 'aeiou';
  let w = '';
  const syl = 2 + Math.floor(r() * 3);
  for (let i = 0; i < syl; i++) w += C[Math.floor(r() * C.length)] + V[Math.floor(r() * V.length)] + (r() < 0.3 ? C[Math.floor(r() * C.length)] : '');
  return w;
}

export function makeVocab(r, n = 2000) {
  const en = EN_BASE.slice();
  while (en.length < n) en.push(pseudoWord(r));
  return { en, th: TH_BASE };
}

const pick = (r, a) => a[Math.floor(r() * a.length)];

export function makeDoc(r, vocab, i) {
  const kind = r();
  const words = 3 + Math.floor(r() * 8);
  const parts = [];
  for (let k = 0; k < words; k++) {
    if (kind < 0.4) parts.push(pick(r, vocab.th));
    else if (kind < 0.8) parts.push(pick(r, vocab.en));
    else parts.push(r() < 0.5 ? pick(r, vocab.th) : pick(r, vocab.en));
  }
  let title = kind < 0.4 ? parts.join('') : parts.join(' ');
  if (kind < 0.4 && r() < 0.5) title = parts.slice(0, 2).join('') + ' ' + parts.slice(2).join('');
  if (r() < 0.2) title += ' - ' + pick(r, ['YouTube', 'GitHub', 'Google', 'Facebook', 'Wikipedia']);
  if (r() < 0.01) title += ' 😀';
  if (r() < 0.005) title += ' ' + 'long '.repeat(500);
  const host = pick(r, HOSTS);
  const segs = [];
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) segs.push(pick(r, vocab.en));
  let url = `https://${r() < 0.4 ? 'www.' : ''}${host}/${segs.join('/')}`;
  if (r() < 0.5) url += `?id=${Math.floor(r() * 1e9).toString(36)}&q=${pick(r, vocab.en)}`;
  if (r() < 0.2) url += `&session=${Math.floor(r() * 1e16).toString(16)}${Math.floor(r() * 1e16).toString(16)}`;
  if (r() < 0.05) url = `https://${host}/dup/same-page`; // 5% duplicate urls
  return { title, url, ts: 1.7e12 - Math.floor(r() * 3e10) + i };
}

export function* makeCorpus(n, seed = 1) {
  const r = rng(seed);
  const vocab = makeVocab(rng(seed + 99));
  for (let i = 0; i < n; i++) yield makeDoc(r, vocab, i);
}
