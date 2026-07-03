/*
 * generate-icons.js
 * -----------------
 * Generates the extension's PNG icons (16/48/128) with no image-library
 * dependency — it emits valid PNGs using only Node's built-in zlib.
 *
 * The icon is a rounded blue tile with a white down-arrow (the "export"
 * motif). Replace icons/*.png with your own artwork any time; this script is
 * only here so the repo ships with working defaults.
 *
 * Run: node tools/generate-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Build an RGBA PNG from a pixel function fn(x, y) -> [r,g,b,a].
function makePng(size, fn) {
  const bytesPerRow = size * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (bytesPerRow + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn(x, y);
      const off = y * (bytesPerRow + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BLUE = [0, 82, 204];
const WHITE = [255, 255, 255];

function iconPixel(size) {
  const radius = size * 0.18;
  return function (x, y) {
    // Rounded-corner mask.
    const inCorner = (cx, cy) => Math.hypot(x - cx, y - cy) > radius;
    let outside = false;
    if (x < radius && y < radius && inCorner(radius, radius)) outside = true;
    if (x > size - radius && y < radius && inCorner(size - radius, radius)) outside = true;
    if (x < radius && y > size - radius && inCorner(radius, size - radius)) outside = true;
    if (x > size - radius && y > size - radius && inCorner(size - radius, size - radius)) outside = true;
    if (outside) return [0, 0, 0, 0];

    // Down-arrow glyph (export motif): vertical stem + arrowhead.
    const cx = size / 2;
    const stemW = size * 0.12;
    const stemTop = size * 0.24;
    const stemBottom = size * 0.56;
    const headTop = size * 0.5;
    const headBottom = size * 0.72;
    const headHalf = size * 0.22;

    const inStem = Math.abs(x - cx) <= stemW / 2 && y >= stemTop && y <= stemBottom;
    // Triangle: width shrinks from headHalf at headTop to 0 at headBottom.
    const t = (y - headTop) / (headBottom - headTop);
    const inHead = y >= headTop && y <= headBottom && Math.abs(x - cx) <= headHalf * (1 - t);

    if (inStem || inHead) return [...WHITE, 255];
    return [...BLUE, 255];
  };
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = makePng(size, iconPixel(size));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
