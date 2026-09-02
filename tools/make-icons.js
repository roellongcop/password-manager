// Generates the extension icons as PNGs with no dependencies.
//   node tools/make-icons.js
// Rerun this only if the mark changes; the PNGs are committed alongside it.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, '..', 'icons');

const ACCENT = [47, 111, 79];
const WHITE = [255, 255, 255];
const SUPERSAMPLE = 4;

// --- geometry, all in 0..1 unit space -------------------------------------

function insideRoundedRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// The stem of the keyhole: a symmetrical trapezoid under the bore.
function insideStem(x, y) {
  const top = 0.46;
  const bottom = 0.76;
  if (y < top || y > bottom) return false;
  const t = (y - top) / (bottom - top);
  const halfWidth = 0.055 + 0.075 * t;
  return Math.abs(x - 0.5) <= halfWidth;
}

function sample(x, y) {
  if (!insideRoundedRect(x, y, 0.22)) return null; // transparent corner
  if (insideCircle(x, y, 0.5, 0.4, 0.145) || insideStem(x, y)) return WHITE;
  return ACCENT;
}

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          const colour = sample(x, y, step);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      const covered = a / 255;
      // Premultiplied averaging would darken the edge; average over covered
      // samples instead so antialiased pixels keep the right hue.
      pixels[offset] = covered ? Math.round(r / covered) : 0;
      pixels[offset + 1] = covered ? Math.round(g / covered) : 0;
      pixels[offset + 2] = covered ? Math.round(b / covered) : 0;
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

// --- minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, renderRgba(size)));
  console.log('wrote', path.relative(process.cwd(), file));
}
