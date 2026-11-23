// Re-encodes a PNG written by Chrome (8-bit RGB or RGBA, not interlaced) as 24-bit RGB without an alpha channel,
// which is what the Chrome Web Store asks for. Transparent pixels are flattened onto white. No dependencies.
import fs from 'node:fs'; import zlib from 'node:zlib';

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

export function info(buf) { return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28] }; }

export function toRgb(buf) {
  const { width: w, height: h, bitDepth, colorType, interlace } = info(buf);
  if (bitDepth !== 8 || interlace || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let p = 8; p < buf.length;) { const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8); if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0; const b = y ? px[dst + x - stride] : 0; const c = x >= bpp && y ? px[dst + x - stride - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 0xff;
    }
  }
  const out = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    let o = y * (w * 3 + 1); out[o++] = 0;
    for (let x = 0; x < w; x++) { const i = y * stride + x * bpp; const al = bpp === 4 ? px[i + 3] / 255 : 1; out[o++] = Math.round(px[i] * al + 255 * (1 - al)); out[o++] = Math.round(px[i + 1] * al + 255 * (1 - al)); out[o++] = Math.round(px[i + 2] * al + 255 * (1 - al)); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function fileToRgb(file) { const b = toRgb(fs.readFileSync(file)); fs.writeFileSync(file, b); return info(b); }
