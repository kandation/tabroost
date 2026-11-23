// About page + notices test. Pure Node, no browser:   node tests/about-test.mjs
// Checks: strings in Thai and English, no raw {{placeholders}} in the rendered policy, the policy text equals the public policy page,
// THIRD-PARTY-NOTICES.md exists and matches the About page copy, the zip file list contains the notices, about.html has no inline script
// or remote resource, and no personal identifiers appear in the shipped files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, ...p);
const imp = (f) => import(pathToFileURL(R(f)).href);
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const str = await imp('lib/aboutstr.js');
const info = await imp('lib/aboutinfo.js');
const { TH, EN, POLICY_TH, POLICY_EN, renderPolicy, fill, inlineParts } = str;

// ---- 1. strings exist in both languages ------------------------------------------------------------------------------
{
  const kt = Object.keys(TH).sort(); const ke = Object.keys(EN).sort();
  check('TH and EN have the same string keys', JSON.stringify(kt) === JSON.stringify(ke), kt.filter((k) => !ke.includes(k)).concat(ke.filter((k) => !kt.includes(k))).join(','));
  const empty = kt.filter((k) => (typeof TH[k] === 'string' && !TH[k].trim()) || (typeof EN[k] === 'string' && !EN[k].trim()));
  check('no empty strings', empty.length === 0, empty.join(','));
  const sameType = kt.filter((k) => typeof TH[k] !== typeof EN[k]);
  check('TH/EN values have the same type (text or function)', sameType.length === 0, sameType.join(','));
  const raw = kt.filter((k) => typeof TH[k] === 'string' && (/\{\{/.test(TH[k]) || /\{\{/.test(EN[k])));
  check('UI strings have no {{placeholders}}', raw.length === 0, raw.join(','));
  check('Thai strings contain Thai text', /[฀-๿]/.test(TH.privH) && /[฀-๿]/.test(TH.title));
  check('English strings do not contain Thai', !/[฀-๿]/.test(EN.privH + EN.title + EN.back + EN.ctrlAllD));
  check('policy has 12 sections in both languages', POLICY_TH.sections.length === 12 && POLICY_EN.sections.length === 12);
  // every data-s key used in about.html exists
  const html = fs.readFileSync(R('about.html'), 'utf8');
  const used = [...html.matchAll(/data-s="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const missing = used.filter((k) => !(k in TH) || !(k in EN));
  check('every data-s in about.html exists in TH and EN', used.length > 20 && missing.length === 0, missing.join(','));
  // every #id that about.js reads exists in about.html
  const js = fs.readFileSync(R('about.js'), 'utf8');
  const ids = [...js.matchAll(/\$\('#([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]);
  const noId = ids.filter((i) => !html.includes(`id="${i}"`));
  check('every element about.js looks up exists in about.html', ids.length > 10 && noId.length === 0, noId.join(','));
  check('about.js never uses innerHTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
}

// ---- 2. placeholders -------------------------------------------------------------------------------------------------
{
  const filled = { DEVELOPER_NAME: 'Test Dev', CONTACT_EMAIL: 'privacy@example.com', EFFECTIVE_DATE: '2030-01-02' };
  for (const lang of ['th', 'en']) {
    const empty = JSON.stringify(renderPolicy(lang, {}));
    check(`${lang}: unset values never show raw braces`, !/\{\{|\}\}/.test(empty));
    check(`${lang}: unset values show "${(lang === 'th' ? TH : EN).notSet}"`, empty.includes((lang === 'th' ? TH : EN).notSet));
    const todo = JSON.stringify(renderPolicy(lang, { DEVELOPER_NAME: 'TODO name', CONTACT_EMAIL: '{{CONTACT_EMAIL}}', EFFECTIVE_DATE: '' }));
    check(`${lang}: TODO / brace values count as unset`, !/\{\{|\}\}|TODO/.test(todo));
    const full = JSON.stringify(renderPolicy(lang, filled));
    check(`${lang}: filled info leaves no {{placeholders}} and no "not set" text`, !/\{\{|\}\}/.test(full) && !full.includes((lang === 'th' ? TH : EN).notSet));
    check(`${lang}: filled values appear`, full.includes('Test Dev') && full.includes('privacy@example.com') && full.includes('2030-01-02'));
  }
  check('fill() leaves ordinary text alone', fill('a {{DEVELOPER_NAME}} b', filled, 'x') === 'a Test Dev b' && fill('no marks', {}, 'x') === 'no marks');
  const parts = inlineParts('see [site](https://example.com/x) and [bad](javascript:alert(1)) and `code` and [m](mailto:name@example.com)');
  check('inline marks: https and mailto links only', parts.filter((p) => p.t === 'a').map((p) => p.u).join('|') === 'https://example.com/x|mailto:name@example.com' && parts.some((p) => p.t === 'code'));
  check('safeUrl accepts https only', info.safeUrl('https://example.com/a') === 'https://example.com/a' && info.safeUrl('http://example.com') === '' && info.safeUrl('javascript:1') === '' && info.safeUrl('') === '');
  // the repo itself must ship with the developer details unset (no personal data); informational once the developer has filled them in
  const set = Object.entries(info.INFO).filter(([, v]) => info.isSet(v)).map(([k]) => k);
  if (set.length) console.log('INFO  aboutinfo.js has filled values: ' + set.join(', ') + ' (fine for a release build)');
  check('aboutinfo.js INFO values are strings', Object.values(info.INFO).every((v) => typeof v === 'string'));
}

// ---- 3. the policy equals the public policy page ---------------------------------------------------------------------
{
  const page = fs.readFileSync(R('store-assets', 'listing', 'privacy-policy.html'), 'utf8');
  const dec = (s) => s.replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const flat = (s) => dec(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const flatMine = (s) => flat(String(s).replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
  for (const lang of ['en', 'th']) {
    const main = page.split(`<main data-l="${lang}">`)[1].split('</main>')[0];
    const secs = main.split(/<h2>/).slice(1);
    const P = lang === 'th' ? POLICY_TH : POLICY_EN;
    check(`${lang}: policy page has ${P.sections.length} sections`, secs.length === P.sections.length);
    let bad = [];
    secs.forEach((blk, i) => {
      const s = P.sections[i]; if (!s) return;
      const [head, ...rest] = blk.split('</h2>');
      const theirs = flat(rest.join('')).replace(/\s*(Tabroost เป็นโครงการอิสระ.*|Tabroost is an independent project.*)$/, '');
      const mine = flatMine(s.b.map((b) => (Array.isArray(b) ? b.join(' ') : b)).join(' '));
      if (flat(head).replace(/^\d+\.\s*/, '') !== flatMine(s.h)) bad.push(`${i + 1} heading`);
      if (theirs !== mine) bad.push(`${i + 1} body`);
    });
    check(`${lang}: every policy section equals privacy-policy.html`, bad.length === 0, bad.join(', '));
    const sum = flat(main.match(/<div class="card soft">([\s\S]*?)<\/div>/)[1]).replace(/^(In short:|สรุป:)\s*/, '');
    check(`${lang}: summary equals privacy-policy.html`, sum === flatMine(P.summary));
    const codes = [...main.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]);
    check(`${lang}: every <code> term of the page is in the policy`, codes.every((c) => P.sections.some((s) => s.b.flat().join(' ').includes('`' + c + '`'))));
  }
}

// ---- 4. notices ------------------------------------------------------------------------------------------------------
{
  const f = R('THIRD-PARTY-NOTICES.md');
  const md = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  check('THIRD-PARTY-NOTICES.md exists and is not empty', md.trim().length > 500);
  check('notices say third-party code: none', /## A\. Bundled third-party code\s+\*\*None\.\*\*/.test(md));
  check('notices cover trademarks and fonts', /trademarks of Google LLC/.test(md) && /not affiliated with/i.test(md) && /No fonts are bundled|Fonts: none are bundled/i.test(md));
  check('NOTICE exists', fs.existsSync(R('NOTICE')) && fs.readFileSync(R('NOTICE'), 'utf8').includes('THIRD-PARTY-NOTICES.md'));
  const { checkNotices } = await imp('tools/check-notices.mjs');
  const problems = await checkNotices();
  check('THIRD-PARTY-NOTICES.md and lib/aboutinfo.js agree', problems.length === 0, problems.join('; '));
  const site = fs.readFileSync(R('lib', 'site.js'), 'utf8');
  const n = (site.match(/const MULTI = new Set\(\[([\s\S]*?)\]\);/)[1].match(/'[^']+'/g) || []).length;
  check(`notices state the real size of the suffix set (${n})`, md.includes(`${n} multi-label`) && info.NOTICES.find((s) => s.id === 'D').intro.en.includes(`${n} multi-label`));
  check('MIT text on the page matches LICENSE', (() => { const lic = fs.readFileSync(R('LICENSE'), 'utf8').replace(/\r\n/g, '\n'); return lic.includes(info.MIT_BODY); })());
  // no vendored libraries: no dependencies, no minified files, no remote scripts
  const pkg = JSON.parse(fs.readFileSync(R('package.json'), 'utf8'));
  check('package.json has no dependencies', !pkg.dependencies && !pkg.devDependencies);
}

// ---- 5. zip file list ------------------------------------------------------------------------------------------------
let shipped = [];
{
  const r = spawnSync(process.execPath, [R('tools', 'package.mjs'), '--list'], { encoding: 'utf8' });
  shipped = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  check('package.mjs --list works', r.status === 0 && shipped.length > 20, (r.stderr || '').trim());
  for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'about.html', 'about.js', 'about.css', 'lib/aboutstr.js', 'lib/aboutinfo.js', 'manifest.json']) check(`zip contains ${f}`, shipped.includes(f));
  const md = shipped.filter((f) => /\.md$/i.test(f));
  check('zip contains no other .md file', md.length === 1 && md[0] === 'THIRD-PARTY-NOTICES.md', md.join(','));
  check('zip contains no tests, tools or store assets', !shipped.some((f) => /^(tests|tools|store-assets|docs|dev|bench)\//.test(f)));
}

// ---- 6. about.html is MV3-safe ---------------------------------------------------------------------------------------
{
  const html = fs.readFileSync(R('about.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  check('about.html has no inline script', scripts.length > 0 && scripts.every((m) => /\bsrc="[^":]+"/.test(m[1]) && !m[2].trim()));
  check('about.html has no inline event handler or style attribute', !/\son[a-z]+\s*=|\sstyle\s*=|<style/i.test(html));
  const remote = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/gi)].map((m) => m[1]).filter((u) => /^(https?:)?\/\//i.test(u));
  check('about.html loads nothing from the web', remote.length === 0, remote.join(','));
  const css = fs.readFileSync(R('about.css'), 'utf8');
  check('about.css has no url() or @import', !/url\(|@import/.test(css));
  const jsImports = [...fs.readFileSync(R('about.js'), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  check('about.js imports only local files that exist', jsImports.every((p) => p.startsWith('./') && fs.existsSync(R(p))), jsImports.join(','));
  const settingsLinks = fs.readFileSync(R('stash.html'), 'utf8');
  check('stash.html links to about.html', /href="about\.html"/.test(settingsLinks));
}

// ---- 7. no personal identifiers in the shipped files -----------------------------------------------------------------
{
  const devMail = ['akkhaporn', '2559', '@', 'gmail', '.com'].join('');
  const bad = [];
  const OK_MAIL = /(@example\.(com|org)|noreply@|\{\{CONTACT_EMAIL\}\})/i;
  for (const f of shipped) {
    if (!/\.(js|html|css|json|md)$|^(LICENSE|NOTICE)$/.test(f)) continue;
    const txt = fs.readFileSync(R(f), 'utf8');
    if (txt.includes(devMail)) bad.push(`${f}: developer email`);
    if (/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`<>]+/i.test(txt) && !/Users[\\/]+(Public|you|name|USERNAME)\b/i.test(txt)) bad.push(`${f}: user path`);
    if (/scratchpad|AppData[\\/]+Local[\\/]+Temp|[A-Za-z]:[\\/]+projects[\\/]/i.test(txt)) bad.push(`${f}: local path`);
    for (const m of txt.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!OK_MAIL.test(m[0]) && !/\.(png|jpg|svg|js|css)$/i.test(m[0])) bad.push(`${f}: email ${m[0]}`);
    }
  }
  check('no personal identifiers in shipped files', bad.length === 0, bad.slice(0, 6).join('; '));
  const a = spawnSync(process.execPath, [R('tools', 'audit-repo.mjs')], { encoding: 'utf8' });
  const sum = /Summary: HIGH (\d+), MED (\d+)/.exec(a.stdout || '');
  check('tools/audit-repo.mjs reports 0 HIGH and 0 MED', !!sum && sum[1] === '0' && sum[2] === '0', sum ? `HIGH ${sum[1]}, MED ${sum[2]}` : 'no summary line');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll about-page checks passed');
process.exit(failures ? 1 : 0);
