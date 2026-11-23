// Axe-like accessibility smoke test without libraries, against a REAL Chrome (own throw-away profile, killtree cleanup, watchdog).
//   node tests/ui/a11y-smoke.mjs        Env: CHROME, CMR_TEST_ROOT, CMR_PORT (default 9722)
// Checks on the list page (list, settings), the popup and the about page:
//   - every button / link / input / select / textarea has an accessible name (text, aria-label, aria-labelledby, title, <label>, placeholder)
//   - no duplicate ids; aria-labelledby / aria-controls point at existing ids; img has alt
//   - no focusable element hides inside a [hidden] / display:none container (keyboard trap) and tabindex > 0 is not used
//   - at least one polite live region exists (toasts / progress are announced)
//   - colour contrast of the design tokens, computed from the CSS variables: text >= 4.5:1 on bg / surface / surface-2 and
//     accent-text on accent, accent-ink on accent-weak, muted on surface, for light and dark and every accent colour
//   - reduced motion: no transition / animation survives under prefers-reduced-motion (checked on the popup + list)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killChrome } from './killtree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CMR_PORT || 9722);
const PROFILE = fs.mkdtempSync(path.join(process.env.CMR_TEST_ROOT || os.tmpdir(), 'cmr-a11y-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!ok) failures++; };
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore', detached: true });
chrome.unref();
const dog = setTimeout(() => { console.log('FAIL  watchdog'); killChrome(chrome, PROFILE); process.exit(2); }, 240000);
dog.unref();
const J = (u) => fetch(`http://127.0.0.1:${PORT}${u}`).then((r) => r.json());
async function cdp(u) {
  const ws = new WebSocket(u); let id = 0; const p = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p[m.id]) { p[m.id](m); delete p[m.id]; } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; const t = setTimeout(() => j(new Error('timeout ' + method)), 30000); p[i] = (m) => { clearTimeout(t); r(m); }; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; };
  return { send, ev };
}

// ---- in-page audit (a function string evaluated in each page) ----
const AUDIT = `(()=>{
  const out = { unnamed: [], dupIds: [], badRefs: [], noAlt: [], hiddenFocus: [], posTab: [], live: 0 };
  const vis = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const text = (e) => (e.textContent || '').trim();
  const nameOf = (e) => {
    if (e.getAttribute('aria-label')) return e.getAttribute('aria-label').trim();
    const lb = e.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\\s+/).map((i) => { const x = document.getElementById(i); return x ? text(x) : ''; }).join(' ').trim(); if (t) return t; }
    if (e.labels && e.labels.length) { const t = [...e.labels].map(text).join(' ').trim(); if (t) return t; }
    if (e.closest('label') && text(e.closest('label'))) return text(e.closest('label'));
    if (['BUTTON','A'].includes(e.tagName) && text(e)) return text(e);
    if (e.tagName === 'BUTTON' && e.querySelector('img[alt]:not([alt=""])')) return 'img';
    if (e.title) return e.title.trim();
    if (e.getAttribute('placeholder')) return e.getAttribute('placeholder');
    if (e.getAttribute('data-sa')) return 'pending';
    return '';
  };
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=switch], [role=checkbox]';
  for (const e of document.querySelectorAll(sel)) {
    if (!vis(e) || e.closest('[hidden]')) continue;
    if (!nameOf(e)) out.unnamed.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + String(e.className).slice(0, 40) + (e.dataset && e.dataset.act ? '[' + e.dataset.act + ']' : ''));
  }
  const seen = new Map(); for (const e of document.querySelectorAll('[id]')) seen.set(e.id, (seen.get(e.id) || 0) + 1);
  for (const [k, n] of seen) if (n > 1) out.dupIds.push(k);
  for (const e of document.querySelectorAll('[aria-labelledby],[aria-controls],[aria-describedby]')) for (const a of ['aria-labelledby', 'aria-controls', 'aria-describedby']) { const v = e.getAttribute(a); if (v) for (const i of v.split(/\\s+/)) if (!document.getElementById(i)) out.badRefs.push(a + '->' + i); }
  for (const e of document.querySelectorAll('img')) if (!e.hasAttribute('alt') && !e.closest('[hidden]')) out.noAlt.push(e.src.slice(-30));
  for (const e of document.querySelectorAll('[tabindex]')) if (Number(e.getAttribute('tabindex')) > 0) out.posTab.push(e.id || e.className);
  for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')) {
    if (e.disabled || e.getAttribute('tabindex') === '-1') continue;
    const h = e.closest('[hidden]'); if (h && !h.matches('[popover]') && getComputedStyle(h).display !== 'none') out.hiddenFocus.push((e.id || e.tagName.toLowerCase()) + ' in #' + (h.id || h.className).toString().slice(0, 30));
  }
  out.live = document.querySelectorAll('[aria-live="polite"],[aria-live="assertive"],[role=status],[role=alert]').length;
  return out;
})()`;

const CONTRAST = `(()=>{
  const cv = document.createElement('canvas').getContext('2d');
  const rgb = (c) => { cv.fillStyle = '#000'; cv.fillStyle = c; const m = cv.fillStyle; const h = m.startsWith('#') ? m : null; if (h) return [1,3,5].map((i) => parseInt(h.slice(i, i + 2), 16)); const mm = m.match(/[\\d.]+/g).map(Number); return mm.slice(0, 3); };
  const lum = ([r,g,b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const root = document.documentElement; const cs = () => getComputedStyle(root); const v = (n) => cs().getPropertyValue(n).trim();
  const res = [];
  const accents = ['blue','teal','green','orange','pink','violet'];
  for (const theme of ['light','dark']) for (const ac of accents) {
    root.dataset.theme = theme; if (ac === 'blue') delete root.dataset.accent; else root.dataset.accent = ac;
    const pairs = [['text','bg'],['text','surface'],['text','surface-2'],['muted','bg'],['muted','surface'],['accent-text','accent'],['accent-ink','accent-weak'],['accent-ink','surface'],['danger','surface'],['ok','surface']];
    for (const [f, b] of pairs) { const fg = v('--' + f), bg = v('--' + b); if (!fg || !bg) { res.push({ theme, ac, f, b, r: 0, miss: true }); continue; } res.push({ theme, ac, f, b, r: Math.round(ratio(fg, bg) * 100) / 100 }); }
  }
  delete root.dataset.theme; delete root.dataset.accent;
  return res;
})()`;

try {
  for (let i = 0; i < 60; i++) { try { await J('/json/version'); break; } catch { await sleep(500); } }
  const br = await cdp((await J('/json/version')).webSocketDebuggerUrl);
  const ld = await br.send('Extensions.loadUnpacked', { path: ROOT.replace(/\\/g, '/') });
  const EXT = ld.result.id;
  const open = async (file, w, h, scheme = 'light') => {
    const { result } = await br.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    let t; for (let i = 0; i < 20 && !t; i++) { await sleep(200); t = (await J('/json/list')).find((x) => x.id === result.targetId); }
    const pg = await cdp(t.webSocketDebuggerUrl);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await pg.send('Page.navigate', { url: `chrome-extension://${EXT}/${file}` }); await sleep(2200);
    pg.targetId = result.targetId; return pg;
  };
  const report = (label, a) => {
    check(`${label}: every control has an accessible name`, a.unnamed.length === 0, JSON.stringify(a.unnamed.slice(0, 8)));
    check(`${label}: no duplicate ids`, a.dupIds.length === 0, JSON.stringify(a.dupIds));
    check(`${label}: aria references point at existing ids`, a.badRefs.length === 0, JSON.stringify(a.badRefs.slice(0, 5)));
    check(`${label}: every <img> has alt`, a.noAlt.length === 0, JSON.stringify(a.noAlt));
    check(`${label}: no positive tabindex`, a.posTab.length === 0, JSON.stringify(a.posTab));
    check(`${label}: no focusable element inside a hidden container`, a.hiddenFocus.length === 0, JSON.stringify(a.hiddenFocus.slice(0, 6)));
    check(`${label}: has a live region for announcements`, a.live > 0);
  };
  // seed one set so the list has rows
  const seed = await open('stash.html', 1200, 800);
  const msg = (m) => seed.ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const g = (await msg({ type: 'debug:seedGroup', title: 'a11y' })).gid;
  await msg({ type: 'debug:seedItems', gid: g, items: Array.from({ length: 6 }, (_, i) => ({ url: `https://example.test/${i}`, title: `Page ${i}`, ts: Date.now() })) });
  await msg({ type: 'debug:seedDone', gid: g });
  await seed.ev('location.reload()'); await sleep(2500);
  for (const [label, scheme] of [['list light', 'light'], ['list dark', 'dark']]) {
    await seed.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }); await sleep(300);
    report(label, await seed.ev(AUDIT));
  }
  await seed.ev(`location.hash='#settings'`); await sleep(1500);
  report('settings', await seed.ev(AUDIT));
  const cont = await seed.ev(CONTRAST);
  const bad = cont.filter((c) => c.miss || c.r < 4.5);
  check('tokens: text/accent contrast >= 4.5:1 in light + dark and every accent', bad.length === 0, bad.map((b) => `${b.theme}/${b.ac} ${b.f} on ${b.b} ${b.r}`).join('; '));
  console.log(`INFO  contrast pairs checked: ${cont.length}`);
  // keyboard: Esc closes the command palette and focus does not get trapped
  await seed.ev(`location.hash='#list'`); await sleep(600);
  await seed.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 }); await sleep(500);
  const pal = await seed.ev(`!!document.querySelector('dialog[open], .pal, #palette') `);
  await seed.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(400);
  const palAfter = await seed.ev(`!!document.querySelector('dialog[open], .pal:not([hidden]), #palette:not([hidden])')`);
  check('palette: opens with Ctrl+K and closes with Esc', pal === true && palAfter === false, `open=${pal} afterEsc=${palAfter}`);
  // popup + about
  const pop = await open('popup.html', 380, 700);
  report('popup', await pop.ev(AUDIT));
  const abt = await open('about.html', 900, 800);
  report('about', await abt.ev(AUDIT));
  // reduced motion
  await pop.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(300);
  const anim = await pop.ev(`[...document.querySelectorAll('*')].filter((e) => { const c = getComputedStyle(e); return (parseFloat(c.transitionDuration) > 0.01) || (c.animationName !== 'none' && parseFloat(c.animationDuration) > 0.01); }).length`);
  check('reduced motion: popup has no running transitions / animations', anim === 0, `elements=${anim}`);
  await seed.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(300);
  const anim2 = await seed.ev(`[...document.querySelectorAll('*')].filter((e) => { const c = getComputedStyle(e); return (parseFloat(c.transitionDuration) > 0.01) || (c.animationName !== 'none' && parseFloat(c.animationDuration) > 0.01); }).map((e)=>e.className).slice(0,5)`);
  check('reduced motion: list page has no running transitions / animations', anim2.length === 0, JSON.stringify(anim2));
} catch (e) {
  console.log('ERROR ' + (e && e.stack || e)); failures++;
} finally {
  killChrome(chrome, PROFILE);
  console.log(failures ? `a11y-smoke: ${failures} FAILED` : 'a11y-smoke: ALL PASSED');
  process.exit(failures ? 1 : 0);
}
