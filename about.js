// About page: version, privacy policy, where the data is, credits, licence, links, shortcuts. No inline script, no remote resource.
// All text comes from lib/aboutstr.js and lib/aboutinfo.js. Elements are built with textContent / createElement (no HTML strings).
import { getSettings } from './lib/settings.js';
import { initTheme } from './lib/theme.js';
import { resolveLang } from './lib/i18n.js';
import * as db from './lib/db.js';
import { TH, EN, inlineParts, renderPolicy, fill } from './lib/aboutstr.js';
import { INFO, NOTICES, MIT_BODY, COPYRIGHT_YEAR, safeUrl } from './lib/aboutinfo.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
let S = TH;
let lang = 'th';

/** `code` and [text](https://link) marks -> nodes */
function rich(str) {
  const frag = document.createDocumentFragment();
  for (const p of inlineParts(str)) {
    if (p.t === 'code') frag.append(el('code', '', p.s));
    else if (p.t === 'a') { const a = el('a', '', p.s); a.href = p.u; a.rel = 'noopener'; if (p.u.startsWith('http')) a.target = '_blank'; frag.append(a); }
    else frag.append(p.s);
  }
  return frag;
}

function fillStatic() {
  for (const n of document.querySelectorAll('[data-s]')) { const v = S[n.dataset.s]; if (typeof v === 'string') n.textContent = v; }
  document.title = 'Tabroost · ' + (lang === 'th' ? 'เกี่ยวกับ' : 'About');
  document.documentElement.lang = lang;
}

function renderHead() {
  let v = '';
  try { v = chrome.runtime.getManifest().version; } catch { /* page opened outside the extension */ }
  $('#ver').textContent = v ? S.version(v) : '';
}

function renderPolicyBlock() {
  const P = renderPolicy(lang, INFO);
  $('#policyMeta').textContent = P.meta;
  $('#inShort').textContent = S.inShort + ':';
  $('#policySummary').textContent = P.summary;
  const body = $('#policyBody');
  body.replaceChildren();
  for (const s of P.sections) {
    body.append(el('h3', '', `${s.n}. ${s.h}`));
    for (const b of s.b) {
      if (Array.isArray(b)) { const ul = el('ul'); for (const li of b) ul.append(el('li', '', rich(li))); body.append(ul); }
      else body.append(el('p', '', rich(b)));
    }
  }
  $('#policyNote').textContent = P.note;
}

function renderNotices() {
  const box = $('#noticeBody');
  box.replaceChildren();
  for (const sec of NOTICES) {
    const wrap = el('div', 'notice', el('h3', '', `${sec.id}. ${sec.title[lang]}`), el('p', '', sec.intro[lang]));
    if (sec.items.length) {
      const ul = el('ul');
      for (const it of sec.items) {
        const li = el('li', '', el('b', '', it.k), ' ', it[lang]);
        if (it.url && it.url.length) {
          const urls = el('div', 'urls');
          for (const u of it.url) { const a = el('a', '', u); a.href = u; a.rel = 'noopener'; a.target = '_blank'; urls.append(a); }
          li.append(urls);
        }
        ul.append(li);
      }
      wrap.append(ul);
    }
    box.append(wrap);
  }
}

function renderMit() {
  const holder = fill('{{DEVELOPER_NAME}}', INFO, S.notSet);
  $('#mitText').textContent = `MIT License\n\nCopyright (c) ${COPYRIGHT_YEAR} ${holder}\n\n${MIT_BODY}\n`;
}

function renderLinks() {
  const ul = $('#linkList');
  ul.replaceChildren();
  const rows = [[S.linkRepo, INFO.REPO_URL], [S.linkIssues, INFO.ISSUES_URL], [S.linkPrivacy, INFO.PRIVACY_URL], [S.linkSupport, INFO.SUPPORT_URL]];
  for (const [label, url] of rows) {
    const u = safeUrl(url);
    let v;
    if (u) { v = el('a', '', u); v.href = u; v.rel = 'noopener'; v.target = '_blank'; } else v = el('span', 'muted', S.notSet);
    ul.append(el('li', '', el('span', '', label), v));
  }
  const mail = fill('{{CONTACT_EMAIL}}', INFO, '');
  if (mail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { const a = el('a', '', mail); a.href = 'mailto:' + mail; ul.append(el('li', '', el('span', '', lang === 'th' ? 'อีเมล' : 'Email'), a)); }
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}

async function renderLive() {
  const nowIdb = $('#nowIdb'); const nowStore = $('#nowStore'); const total = $('#nowTotal');
  nowIdb.textContent = nowStore.textContent = total.textContent = S.loading;
  try {
    const gs = await db.listGroups();
    nowIdb.textContent = S.nowIdb(gs.length, gs.reduce((a, g) => a + (g.count || 0), 0));
  } catch { nowIdb.textContent = S.unknown; }
  try { nowStore.textContent = S.nowStore(fmtBytes(await chrome.storage.local.getBytesInUse(null))); } catch { nowStore.textContent = S.unknown; }
  try {
    const e = await navigator.storage.estimate();
    total.textContent = e && e.quota ? S.nowTotal(fmtBytes(e.usage || 0), fmtBytes(e.quota)) : '';
  } catch { total.textContent = ''; }
}

async function renderKeys() {
  const ul = $('#keyList');
  ul.replaceChildren();
  try {
    const cmds = await chrome.commands.getAll();
    for (const c of cmds) {
      const parts = String(c.description || (c.name === '_execute_action' ? S.keysAction : c.name)).split(' / ');
      const text = (lang === 'th' ? parts[1] : parts[0]) || parts[0];
      ul.append(el('li', '', el('span', '', text), c.shortcut ? el('kbd', '', c.shortcut) : el('span', 'none', S.keysNone)));
    }
  } catch { ul.append(el('li', 'none', S.keysFail)); }
}

function wireKeysButton() {
  $('#editKeys').addEventListener('click', async () => {
    try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); $('#keysMsg').textContent = ''; } catch { $('#keysMsg').textContent = S.keysOpenFail; }
  });
}

async function init() {
  let st = {};
  try { st = await getSettings(); } catch { /* opened outside the extension: defaults */ }
  initTheme();
  lang = resolveLang(st.language);
  S = lang === 'en' ? EN : TH;
  fillStatic();
  renderHead();
  renderPolicyBlock();
  renderNotices();
  renderMit();
  renderLinks();
  wireKeysButton();
  await Promise.all([renderLive(), renderKeys()]);
  if (location.hash) { const t2 = document.getElementById(location.hash.slice(1)); if (t2) t2.scrollIntoView(); }
}

init();
