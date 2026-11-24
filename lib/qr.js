// Offline QR Code generator (ISO/IEC 18004), byte mode only. No dependencies, no DOM, no network.
// Written for Tabroost from the public specification; nothing is copied from another library.
//
//   qrMatrix(text, { ecc: 'L'|'M'|'Q'|'H' })  -> { size, version, ecc, mask, get(x, y) }   (get returns true for a dark module)
//   qrSvg(matrix, { margin, dark, light })      -> SVG string (one <path> of merged horizontal runs)
//   qrCanvas(matrix, canvas, { scale, margin }) -> draws black on white, returns the canvas
// qrMatrix throws an Error when the UTF-8 text does not fit in version 40 at the chosen ECC level.

// Per-version tables, indexed [ecc][version]; index 0 is unused. ecc order: L, M, Q, H.
const ECC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS = [1, 0, 3, 2]; // 2-bit ECC indicator in the format info, same order as above

// Total modules that can hold data or ECC bits (everything except function patterns).
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const a = Math.floor(ver / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver, e) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = EXP[i + 255] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data, degree) {
  // generator = product of (x - 2^i), i = 0..degree-1 (coefficients without the leading 1, highest first)
  const gen = new Array(degree).fill(0); gen[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++) {
    for (let j = 0; j < degree; j++) { gen[j] = gmul(gen[j], root); if (j + 1 < degree) gen[j] ^= gen[j + 1]; }
    root = gmul(root, 2);
  }
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift(); rem.push(0);
    for (let j = 0; j < degree; j++) rem[j] ^= gmul(gen[j], f);
  }
  return rem;
}

// ---- Data segment: mode indicator, length, bytes, terminator, padding ----
function pushBits(bits, value, len) { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); }

function encodeData(bytes, ver, e) {
  const cap = dataCodewords(ver, e) * 8;
  const bits = [];
  pushBits(bits, 0b0100, 4); // byte mode
  pushBits(bits, bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);
  pushBits(bits, 0, Math.min(4, cap - bits.length)); // terminator
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8); // byte align
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; out.push(v); }
  return out;
}

// Split into blocks, append ECC to each, then interleave.
function addEccAndInterleave(data, ver, e) {
  const nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawModules(ver) / 8), nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += d.length;
    blocks.push({ d, ecc: rsRemainder(d, eccLen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen - eccLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Penalty score of the four spec rules (runs, 2x2 blocks, finder-like patterns, dark balance); the lowest-scoring mask wins.
function penalty(m, size) {
  let score = 0, dark = 0;
  const scanLine = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    // 1:1:3:1:1 finder-like pattern with 4 light modules on one side (outside the symbol counts as light)
    for (let i = -4; i + 7 <= size + 4; i++) {
      if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)
        && ((!get(i - 1) && !get(i - 2) && !get(i - 3) && !get(i - 4)) || (!get(i + 7) && !get(i + 8) && !get(i + 9) && !get(i + 10)))) score += 40;
    }
  };
  for (let a = 0; a < size; a++) {
    scanLine((x) => x >= 0 && x < size && m[a][x]);
    scanLine((y) => y >= 0 && y < size && m[y][a]);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  const total = size * size;
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

function buildSymbol(ver, e, codewords) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false)); // true = function pattern (not data)
  const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };

  // timing patterns
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finder patterns with separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // alignment patterns
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue; // overlap a finder
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // version information (versions 7+), two copies
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b); set(c, a, b);
    }
  }
  // format information (ECC level + mask), two copies; drawn first with mask 0 to reserve the modules
  const drawFormat = (mask) => {
    const data = (ECC_FORMAT_BITS[e] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // the always-dark module
  };
  drawFormat(0);

  // place data bits in zigzag order: column pairs from the bottom right, alternately upwards and downwards
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!fn[y][x] && k < codewords.length * 8) { m[y][x] = ((codewords[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
    }
  }

  const applyMask = (mask) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]; };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask); drawFormat(mask);
    const s = penalty(m, size);
    if (s < bestScore) { bestScore = s; best = mask; }
    applyMask(mask); // XOR again to undo
  }
  applyMask(best); drawFormat(best);
  return { m, size, mask: best };
}

export function qrMatrix(text, { ecc = 'M' } = {}) {
  const e = ECC_INDEX[ecc];
  if (e === undefined) throw new Error('QR: unknown ECC level ' + ecc);
  const bytes = new TextEncoder().encode(String(text));
  let ver = 1;
  while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, e) * 8) ver++;
  if (ver > 40) throw new Error(`QR: text too long (${bytes.length} bytes) for a version 40 code at ECC ${ecc}`);
  const { m, size, mask } = buildSymbol(ver, e, addEccAndInterleave(encodeData(bytes, ver, e), ver, e));
  return { size, version: ver, ecc, mask, get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && m[y][x] };
}

// SVG with one <path>: each horizontal run of dark modules is one "M x y h len v1 h-len z" segment. Units are modules.
export function qrSvg(matrix, { margin = 4, dark = '#000', light = '#fff' } = {}) {
  const n = matrix.size + margin * 2;
  let d = '';
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.get(x, y)) continue;
      let x2 = x; while (x2 + 1 < matrix.size && matrix.get(x2 + 1, y)) x2++;
      const len = x2 - x + 1;
      d += `M${x + margin} ${y + margin}h${len}v1h-${len}z`;
      x = x2;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

// Draws black modules on a white background, `scale` pixels per module, including the quiet zone.
export function qrCanvas(matrix, canvas, { scale = 8, margin = 4 } = {}) {
  const n = matrix.size + margin * 2;
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, n * scale, n * scale);
  ctx.fillStyle = '#000';
  for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) if (matrix.get(x, y)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return canvas;
}
