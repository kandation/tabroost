// Captures the RAW UI screenshots for the store art: launches ONE Chrome with a scratch copy of the extension (optional permissions made
// required so no permission banner shows), fills it with the invented demo data from demo-data.mjs and saves PNGs to
// store-assets/screenshots/raw/<lang>/. Nothing is loaded from the web: every "site" is answered locally through CDP Fetch interception.
// usage: node store-assets/tools/shots-capture.mjs [en|th|all]      scratch: CMR_TEST_ROOT or os.tmpdir()
import fs from 'node:fs'; import path from 'node:path';
import {launch, cdp, sleep, REPO, SCRATCH} from './lib-chrome.mjs';
import {iconSvg, featured, categories, bulk, liveTabs, allHosts} from './demo-data.mjs';

const TOTAL_TABS = Number(process.env.SHOTS_TOTAL) || 3420; // SHOTS_TOTAL=300 for a quick trial run
const COLORS = {grey: 1, blue: 2, red: 3, yellow: 4, green: 5, pink: 6, purple: 7, cyan: 8, orange: 9};
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

function scratchExt() {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'tabroost-ext-'));
  for (const f of fs.readdirSync(REPO)) { if (/\.(html|js|css)$/.test(f)) fs.copyFileSync(path.join(REPO, f), path.join(dir, f)); }
  for (const d of ['_locales', 'icons', 'lib']) fs.cpSync(path.join(REPO, d), path.join(dir, d), {recursive: true});
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  m.permissions = [...m.permissions, ...(m.optional_permissions || [])]; m.host_permissions = m.optional_host_permissions || ['<all_urls>'];
  delete m.optional_permissions; delete m.optional_host_permissions;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}
function pageHtml(url, title, kind) {
  const host = new URL(url).hostname;
  const icon = 'data:image/svg+xml;base64,' + b64(iconSvg(host));
  const media = kind === 'media' ? `<audio id="au" loop></audio><script>(()=>{const sr=8000,n=sr*2,b=new ArrayBuffer(44+n*2),v=new DataView(b);const w=(o,t)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/sr*2*Math.PI*30)*400),true);const a=document.getElementById('au');a.src=URL.createObjectURL(new Blob([b],{type:'audio/wav'}));a.volume=0.2;a.play();})();</script>` : '';
  const form = kind === 'form' ? `<form><textarea id="t" rows="6" cols="60"></textarea></form>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="icon" href="${icon}"></head><body style="font:16px system-ui;padding:40px"><h1>${esc(title)}</h1>${form}${media}</body></html>`;
}
async function run(lang) {
  const OUT = path.join(REPO, 'store-assets', 'screenshots', 'raw', lang);
  fs.mkdirSync(OUT, {recursive: true});
  const extDir = scratchExt();
  const L = await launch({extDir, args: ['--autoplay-policy=no-user-gesture-required', '--lang=' + (lang === 'th' ? 'th' : 'en-US')]});
  const rmExt = () => { try { fs.rmSync(extDir, {recursive: true, force: true}); } catch { /* ignore */ } };
  process.on('exit', rmExt);
  const titles = new Map(); // url -> [title, kind]
  async function fakeTab(url, title, kind, {newWindow = false} = {}) {
    if (url) titles.set(url, [title, kind]);
    const r = await L.br.send('Target.createTarget', {url: 'about:blank', newWindow});
    const id = r.result.targetId;
    const t = (await (await fetch(`http://127.0.0.1:${L.port}/json/list`)).json()).find(x => x.id === id);
    const pg = await cdp(t.webSocketDebuggerUrl);
    pg.on(m => { if (m.method !== 'Fetch.requestPaused') return; const u = m.params.request.url; const [ti, k] = titles.get(u) || [new URL(u).hostname, 'open'];
      pg.send('Fetch.fulfillRequest', {requestId: m.params.requestId, responseCode: 200, responseHeaders: [{name: 'Content-Type', value: 'text/html; charset=utf-8'}], body: b64(pageHtml(u, ti, k))}); });
    await pg.send('Fetch.enable', {patterns: [{urlPattern: '*'}]}); await pg.send('Page.enable'); await pg.send('Runtime.enable');
    const go = async (u) => { await pg.send('Page.navigate', {url: u}); await sleep(600); };
    if (url) await go(url);
    return {pg, id, go};
  }
  try {
    const S = await L.open(`chrome-extension://${L.ext}/stash.html?t=1`);
    const msg = m => S.sendMsg(m);
    await msg({type: 'saveSettings', patch: {language: lang, theme: 'light', accent: 'violet', celebrate: false, favMode: process.env.SHOTS_FAV || 'img'}});
    // 1. site icons: visit every demo host once (answered locally) so Chrome's favicon store knows them
    const prim = await fakeTab('', '', 'open');
    for (const h of allHosts()) { await prim.go(`https://${h}/`); const bare = h.split('.').slice(-2).join('.'); if (bare !== h && !/.(co|com).[a-z]{2}$/.test(h)) await prim.go(`https://${bare}/`); else if (h.startsWith('www.')) await prim.go(`https://${h.slice(4)}/`); }
    await L.closeTab(prim.id);
    // 2. categories + sets
    const catId = {};
    for (const c of categories(lang)) { const r = await msg({type: 'catSave', cat: {name: c.name, color: c.color}}); catId[c.key] = r.cat && r.cat.id; }
    console.log('cats', JSON.stringify(catId));
    const now = Date.now();
    const feat = featured(lang);
    const sets = [...bulk(lang, TOTAL_TABS - feat.reduce((a, g) => a + g.items.length, 0)).reverse(), ...feat.slice().reverse()];
    for (const g of sets) {
      const createdAt = now - g.ago;
      const tabGroups = g.tabGroups ? g.tabGroups.map((t, i) => ({i, title: t.title, color: t.color, collapsed: false, windowIdx: 1})) : undefined;
      const gid = (await msg({type: 'debug:seedGroup', title: g.title, createdAt, tabGroups})).gid;
      await msg({type: 'debug:seedItems', gid, items: g.items.map(([url, title, tg], j) => ({url, title, ts: createdAt - (g.items.length - j) * 97000, ...(tg != null ? {tg} : {})}))});
      await msg({type: 'debug:seedDone', gid});
      if (g.emoji || g.color) await msg({type: 'groupLook', groupId: gid, color: COLORS[g.color] || null, emoji: g.emoji || ''});
      if (g.cat && catId[g.cat]) await msg({type: 'groupsSetCat', gids: [gid], cat: catId[g.cat]});
      for (const f of ['starred', 'pinned']) if (g[f]) await msg({type: 'setFlag', groupId: gid, flag: f, value: true});
    }
    // 2b. usage history for the dashboard (local stats rows, written straight into the extension's own IndexedDB)
    await S.ev(`(async()=>{ let seed=7; const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296); const rows=[]; const now=Date.now();
      for (let i=0;i<90;i++){ const d=new Date(now-i*86400000); const k='d:'+(d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate()); const wk=d.getDay()===0||d.getDay()===6;
        const s=i===0?17:Math.round((wk?6:26)*(0.35+rnd()*1.3)+(rnd()<0.12?40:0)); const h=new Array(24).fill(0);
        for (let j=0;j<Math.round(s/3)+1;j++){ const r=rnd(); const hr=r<0.4?9+Math.floor(rnd()*3):r<0.8?13+Math.floor(rnd()*5):20+Math.floor(rnd()*3); h[hr]++; }
        rows.push({k,s,g:1+Math.round(s/14),r:Math.round(s*0.3),o:Math.round(s*0.2),a:Math.round(s*0.5),m:1,x:Math.round(rnd()*3),ram:Math.round((s*0.9+4)*100*(0.5+rnd()*0.4)),pk:30+Math.round(rnd()*50),ls:3420-i*31,h,hi:[2,5,9,12,8,5,3,1].map(v=>Math.round(v*s/20)),hl:[1,3,6,10,12,9,5,2].map(v=>Math.round(v*s/20))}); }
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('cmr'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});
      await new Promise((res,rej)=>{const tx=db.transaction('activity','readwrite'); for(const r of rows) tx.objectStore('activity').put(r); tx.oncomplete=res; tx.onerror=()=>rej(tx.error);}); db.close(); return rows.length; })()`);
    // 3. real open tabs: playing media, an unsaved form, and sleepers
    for (const [u, ti, kind] of liveTabs(lang)) { const t = await fakeTab(u, ti, kind); if (kind === 'form') { await t.pg.send('Runtime.evaluate', {expression: `document.getElementById('t').focus()`}); await t.pg.send('Input.insertText', {text: 'Draft: thanks for the notes, here is the updated plan'}); } }
    await sleep(1500);
    await msg({type: 'debug:sweep', min: 0}); await sleep(2500);
    const disc = await S.ev(`(async()=>{ const tabs=await chrome.tabs.query({}); return tabs.length+' tabs; discarded='+tabs.filter(t=>t.discarded).length+'; audible='+tabs.filter(t=>t.audible).length; })()`);
    console.log(disc);
    // sleeping-since times for the popup list (session storage of the extension, minutes)
    await S.ev(`(async()=>{ const tabs=(await chrome.tabs.query({discarded:true})); const r=await chrome.storage.session.get('fs'); const m=r.fs||{}; const nowM=Math.floor(Date.now()/60000); const ago=[12,18,26,41,55,73,96,128,150,190,240,300,380,460,520]; tabs.forEach((t,i)=>{ m[t.id]=Object.assign({f:nowM-600},m[t.id],{z:nowM-ago[i%ago.length]}); }); await chrome.storage.session.set({fs:m}); })()`);
    await S.pg.send('Page.bringToFront');
    const view = async (P, w, h) => { await P.pg.send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 2, mobile: false}); await sleep(500); };
    const VW = 1200; const VH = 760;
    await view(S, VW, VH); await S.ev('location.reload()'); await sleep(2500);
    for (let i = 0; i < 60 && !(await S.ev(`document.querySelectorAll('.vrow.ghead').length >= 1`).catch(() => false)); i++) await sleep(500);
    await sleep(1500); console.log('rows', await S.ev(`document.querySelectorAll('.vrow').length + ' accent=' + document.documentElement.dataset.accent`));
    await S.ev(`(()=>{ const st=document.createElement('style'); st.textContent='#stRam{font-size:14px;letter-spacing:-.2px;white-space:nowrap;overflow:visible}'; document.head.appendChild(st); for (const b of document.querySelectorAll('#bannerAct button, #welcome [data-act="closeWelcome"]')) { b.click(); break; } })()`); await sleep(600);
    const rects = {};
    const rect = async (name, sel) => { rects[name] = await S.ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`); };
    const shot = async (n, P = S) => { await P.shot(path.join(OUT, n + '.png')); };
    const mouse = (type, x, y) => S.pg.send('Input.dispatchMouseEvent', {type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1});
    const search = async (q) => { await S.ev(`(()=>{ const i=document.getElementById('search'); i.focus(); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(3500); };
    const pos = (needle, sel) => S.ev(`(()=>{ const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(needle)})); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`);
    // ---- list ----
    await rect('side', '#side'); await rect('stats', '#statBlock'); await rect('search', '#search');
    await S.ev(`['banner','bannerVault','bannerMig','bannerSnap','bannerStale','bannerAct','welcome'].forEach(id=>{ const e=document.getElementById(id); if (e) e.hidden=true; })`); await sleep(400);
    await shot('list');
    // set menu open
    const feat0 = feat[0].title;
    await S.ev(`(()=>{ const h=[...document.querySelectorAll('.vrow.ghead')].find(x=>x.textContent.includes(${JSON.stringify(feat0)})); const b=h&&h.querySelector('[data-act="more"]'); if(b) b.click(); })()`); await sleep(700);
    await rect('menu', '#moreMenu'); await shot('list-menu');
    await S.pg.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}); await S.pg.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}); await sleep(400);
    await S.ev(`(()=>{ const m=document.getElementById('moreMenu'); if (m && !m.hidden) document.getElementById('menuScrim').click(); })()`); await sleep(300);
    // ---- search ----
    await mouse('mouseReleased', 700, 4); await S.pg.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 700, y: 4, button: 'none', buttons: 0}); await sleep(300);
    await search('desgin'); await shot('search-typo');
    await search('กาแฟ'); await shot('search-thai');
    await search(''); await sleep(500);
    // ---- settings ----
    for (const s of ['s-suspend', 's-sync', 's-privacy']) { await S.ev(`location.hash='#settings'`); await sleep(900); await S.ev(`document.getElementById('${s}').scrollIntoView({block:'start'})`); await sleep(700); await rect(s, '#' + s); await shot(s); }
    // ---- dashboard ----
    await view(S, 1320, 900); await S.ev(`location.hash='#dashboard'`); await sleep(3500); await shot('dash');
    rects.dashCards = await S.ev(`[...document.querySelectorAll('#dashView .card')].map(e=>{ const b=e.getBoundingClientRect(); return {id:e.dataset.id||'',x:b.x,y:b.y,w:b.width,h:b.height}; })`);
    await S.ev(`location.hash='#list'`); await view(S, VW, VH); await sleep(800);
    // ---- popup ----
    await msg({type: 'debug:sweep', min: 0}); await sleep(2500); // fresh protection state for the popup
    const P = await L.open(`chrome-extension://${L.ext}/popup.html`, {w: 380, h: 900}); await view(P, 380, 900); await sleep(1200);
    const ph = await P.ev(`Math.ceil(document.body.getBoundingClientRect().height)`); console.log('popup height', ph);
    await view(P, 380, Math.min(1200, Math.max(400, ph))); await sleep(600); await shot('popup', P);
    rects.popup = {w: 380, h: Math.min(1200, Math.max(400, ph))};
    for (const [n, sel] of [['pProt', '#protBox'], ['pSleep', '#sleepBox'], ['pSave', '.primary, #btnStashAll, button']]) rects[n] = await P.ev(`(()=>{ const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`);
    await L.closeTab(P.id); await S.pg.send('Page.bringToFront');
    // drag in progress: one saved tab on its way to a category in the sidebar (done after the other captures, in case the cancelled drag changes the list)
    await S.ev(`['banner','bannerVault','bannerMig','bannerSnap','bannerStale','bannerAct','welcome'].forEach(id=>{ const e=document.getElementById(id); if (e) e.hidden=true; })`); await sleep(400);
    { const a = await pos('Agoda', '.vrow.item'); const b = await pos(categories(lang)[0].name, '#catList > *');
      if (a && b) { const x0 = a.x + 180, y0 = a.y + a.h / 2, x1 = b.x + b.w * 0.62, y1 = b.y + b.h / 2 + 3;
        await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0);
        for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 16, y0 + ((y1 - y0) * i) / 16); await sleep(30); }
        await sleep(500); rects.dragTo = {x: x1, y: y1}; await shot('list-drag');
        await S.pg.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}); await S.pg.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await mouse('mouseReleased', x0, y0); await sleep(500); } else console.log('drag: rows not found', !!a, !!b); }
    rects.view = {w: VW, h: VH, dsf: 2};
    fs.writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
    for (const f of fs.readdirSync(OUT)) if (f.startsWith('x-')) fs.unlinkSync(path.join(OUT, f));
  } catch (e) { console.log('ERROR', e.stack || e); }
  L.close(); rmExt();
}
// The lock screen is captured in a second, empty Chrome: with data in the list the lock screen shows an "encrypting existing data" progress line for minutes.
async function runLock(lang) {
  const OUT = path.join(REPO, 'store-assets', 'screenshots', 'raw', lang);
  const extDir = scratchExt();
  const L = await launch({extDir});
  const rmExt = () => { try { fs.rmSync(extDir, {recursive: true, force: true}); } catch { /* ignore */ } };
  process.on('exit', rmExt);
  try {
    const S = await L.open(`chrome-extension://${L.ext}/stash.html?t=1`);
    const msg = m => S.sendMsg(m);
    await msg({type: 'saveSettings', patch: {language: lang, theme: 'light', accent: 'violet'}});
    const VW = 1200; const VH = 760;
    await S.pg.send('Emulation.setDeviceMetricsOverride', {width: VW, height: VH, deviceScaleFactor: 2, mobile: false});
    await S.ev('location.reload()'); await sleep(3000);
    const en = await msg({type: 'lock.enable', password: 'demo-only-' + Math.random().toString(36).slice(2), withRecovery: false}); console.log('lock', JSON.stringify(en).slice(0, 120));
    await sleep(2500); await msg({type: 'lock.lockNow'}); await sleep(3000);
    const rf = path.join(OUT, 'rects.json'); const rects = JSON.parse(fs.readFileSync(rf, 'utf8'));
    rects.lockCard = await S.ev(`(()=>{ let best=null; for (const e of document.querySelectorAll('body *')) { const b=e.getBoundingClientRect(); const cs=getComputedStyle(e); if (b.width>300&&b.width<520&&b.height>300&&b.height<620&&cs.boxShadow!=='none') { best={x:b.x,y:b.y,w:b.width,h:b.height}; break; } } return best; })()`);
    await S.shot(path.join(OUT, 'locked.png'));
    await S.ev(`document.documentElement.dataset.theme='dark'`); await sleep(600); await S.shot(path.join(OUT, 'locked-dark.png'));
    fs.writeFileSync(rf, JSON.stringify(rects, null, 1));
  } catch (e) { console.log('ERROR', e.stack || e); }
  L.close(); rmExt();
}
const which = process.argv[2] || 'all';
const only = process.env.SHOTS_ONLY || ''; // SHOTS_ONLY=lock redoes just the lock screen
for (const lang of which === 'all' ? ['en', 'th'] : [which]) { if (only !== 'lock') await run(lang); await runLock(lang); }
process.exit(0);
