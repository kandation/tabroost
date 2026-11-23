// Generates the SVG sources for the 3 logo directions. Run: node gen-svg.mjs
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'svg');
fs.mkdirSync(out, {recursive: true});
const CREAM = '#FFF3DC', AMBER = '#FFC247';
const dirs = {
  'a-sleepy': { tile: '#7F52E8', ink: '#3A1E85',
    big: (c) => ({
      card: `<path d="M23 82H73Q82 82 82 73V45Q82 36 73 36H50V33Q50 24 41 24H23Q14 24 14 33V73Q14 82 23 82Z"/>`,
      accent: `<path d="M60 11H76L60 27H76" fill="none" stroke="C" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      ink: `<path d="M29 59q7 8 14 0M53 59q7 8 14 0" fill="none" stroke="C" stroke-width="5" stroke-linecap="round"/>` }),
    small: () => ({
      card: `<path d="M3 14H13Q14 14 14 13V9Q14 8 13 8H9V7Q9 6 8 6H3Q2 6 2 7V13Q2 14 3 14Z"/>`,
      accent: `<path d="M10 1.6H14L10 5.6H14" fill="none" stroke="C" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      ink: `<path d="M4 11.2q1 1.3 2 0M9 11.2q1 1.3 2 0" fill="none" stroke="C" stroke-width="1.2" stroke-linecap="round"/>` }) },
  'b-nest': { tile: '#14867F', ink: '#0B4A46',
    big: () => ({
      card: `<rect x="10" y="66" width="76" height="20" rx="9"/><rect x="18" y="41" width="60" height="20" rx="9"/>`,
      accent: `<rect x="26" y="16" width="44" height="20" rx="9" fill="A"/>`,
      ink: `<path d="M24 76H38M32 51H44M38 26H48" fill="none" stroke="C" stroke-width="4.5" stroke-linecap="round"/>` }),
    small: () => ({
      card: `<rect x="2" y="10" width="12" height="4" rx="2"/><rect x="3" y="6" width="10" height="3" rx="1.5"/>`,
      accent: `<rect x="4" y="2" width="8" height="3" rx="1.5" fill="A"/>`,
      ink: `` }) },
  'c-chip': { tile: '#C2417A', ink: '#6E1745',
    big: () => ({
      card: `<rect x="22" y="22" width="52" height="52" rx="10"/>`,
      accent: `<g fill="A"><rect x="9" y="30" width="15" height="6" rx="3"/><rect x="9" y="43" width="15" height="6" rx="3"/><rect x="9" y="56" width="15" height="6" rx="3"/><rect x="72" y="30" width="15" height="6" rx="3"/><rect x="72" y="43" width="15" height="6" rx="3"/><rect x="72" y="56" width="15" height="6" rx="3"/><rect x="33" y="9" width="6" height="15" rx="3"/><rect x="45" y="9" width="6" height="15" rx="3"/><rect x="57" y="9" width="6" height="15" rx="3"/><rect x="33" y="72" width="6" height="15" rx="3"/><rect x="45" y="72" width="6" height="15" rx="3"/><rect x="57" y="72" width="6" height="15" rx="3"/></g>`,
      ink: `<path d="M52 35A14 14 0 1 0 64 58A11 11 0 0 1 52 35Z" fill="C"/>` }),
    small: () => ({
      card: `<rect x="4" y="4" width="8" height="8" rx="2"/>`,
      accent: `<g fill="A"><rect x="1" y="5" width="3" height="2"/><rect x="1" y="9" width="3" height="2"/><rect x="12" y="5" width="3" height="2"/><rect x="12" y="9" width="3" height="2"/></g>`,
      ink: `<path d="M8.6 5.4A2.8 2.8 0 1 0 10.6 9.8A2.3 2.3 0 0 1 8.6 5.4Z" fill="C"/>` }) },
};
const paint = (s, C, A) => s.replaceAll('stroke="C"', `stroke="${C}"`).replaceAll('fill="C"', `fill="${C}"`).replaceAll('fill="A"', `fill="${A}"`).replaceAll('stroke="A"', `stroke="${A}"`).replaceAll('stroke="C"', `stroke="${C}"`);
const cardFill = (s, f) => s.startsWith('<path') ? s : `<g fill="${f}">${s}</g>`;
function color(p, d, size) {
  const g = p, W = size;
  const body = `<g fill="${CREAM}">${paint(g.card, CREAM, AMBER)}</g>`.replace(/<g fill="#FFF3DC"><path/, `<g><path`);
  // card strokes use C -> cream
  const card = `<g fill="${CREAM}">${paint(g.card, CREAM, AMBER)}</g>`;
  const ac = paint(g.accent, AMBER, AMBER);
  return (g.first ? ac + card : card + ac) + paint(g.ink, d.ink, AMBER);
}
function mono(p, fill, size) {
  const id = 'm' + Math.random().toString(36).slice(2, 6);
  const cg = `<g fill="${fill}">${paint(p.card, fill, fill)}</g>`, ag = paint(p.accent, fill, fill);
  const solid = p.first ? ag + cg : cg + ag;
  const cut = paint(p.ink, '#000', '#000');
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-20" y="-20" width="${size + 40}" height="${size + 40}"><rect x="-20" y="-20" width="${size + 40}" height="${size + 40}" fill="#fff"/>${cut}</mask></defs><g mask="url(#${id})">${solid}</g>`;
}
const svg = (vb, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}</svg>\n`;
for (const [k, d] of Object.entries(dirs)) {
  const big = d.big(), sm = d.small();
  const tile = (s, r) => `<rect width="${s}" height="${s}" rx="${r}" fill="${d.tile}"/>`;
  const w = (n, s) => fs.writeFileSync(path.join(out, `${k}-${n}.svg`), s);
  w('icon-fullbleed', svg('0 0 96 96', tile(96, 22) + color(big, d, 96)));       // 32/48/512 (no padding)
  w('icon-128', svg('-16 -16 128 128', tile(96, 22) + color(big, d, 96)));       // 128 with 16px padding
  w('icon-16', svg('0 0 16 16', tile(16, 4) + color(sm, d, 16)));                // simplified 16px
  w('mono', svg('0 0 96 96', mono(big, '#000', 96)));
  w('mono-white', svg('0 0 96 96', mono(big, '#fff', 96)));
  w('mono-16', svg('0 0 16 16', mono(sm, '#000', 16)));
  w('mono-16-white', svg('0 0 16 16', mono(sm, '#fff', 16)));
}
console.log(fs.readdirSync(out).length, 'svgs');
