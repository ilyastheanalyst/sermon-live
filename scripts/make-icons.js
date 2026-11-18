/**
 * Writes the app icons. Run once:  node scripts/make-icons.js
 *
 * Draws them from scratch rather than shipping binaries, so there are no
 * image files to download and nothing to install — Node's own zlib is the
 * only thing used.
 *
 * The mark is two columns of text with a rule between them and one line in
 * scripture gold: the display's own layout, shrunk to an icon.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const INK = [20, 22, 26];
const PARCHMENT = [242, 237, 227];
const SCRIPTURE = [199, 178, 133];
const RULE = [49, 54, 63];

/* ---- minimal PNG encoder ---- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline is prefixed with a filter byte; 0 means no filtering.
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0; o += 1;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      raw[o] = rgb[i]; raw[o + 1] = rgb[i + 1]; raw[o + 2] = rgb[i + 2];
      o += 3;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- the mark, drawn at 4x then averaged down for smooth edges ---- */

function render(size, maskable) {
  const SS = 4;
  const S = size * SS;
  const buf = new Uint8Array(S * S * 3);

  for (let i = 0; i < S * S; i += 1) {
    buf[i * 3] = INK[0]; buf[i * 3 + 1] = INK[1]; buf[i * 3 + 2] = INK[2];
  }

  const rect = (x1, y1, x2, y2, c, radius = 0) => {
    for (let y = Math.max(0, Math.round(y1)); y < Math.min(S, Math.round(y2)); y += 1) {
      for (let x = Math.max(0, Math.round(x1)); x < Math.min(S, Math.round(x2)); x += 1) {
        if (radius > 0) {
          // Round the caps so the bars read as text, not as blocks.
          const cx = Math.min(Math.max(x, x1 + radius), x2 - radius);
          const cy = Math.min(Math.max(y, y1 + radius), y2 - radius);
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        }
        const i = (y * S + x) * 3;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
      }
    }
  };

  // A maskable icon can be cropped to a circle, so its mark sits tighter.
  const inset = maskable ? 0.30 : 0.20;
  const left = S * inset;
  const right = S * (1 - inset);
  const w = right - left;
  const mid = S / 2;

  const gap = w * 0.10;
  const col = (w - gap) / 2;
  const bar = S * 0.038;
  const space = bar * 1.95;

  const rows = [
    [0.95, 0.88, false],
    [0.72, 0.80, false],
    [0.90, 0.95, true],
    [0.58, 0.64, false],
  ];

  let y = S * (inset + 0.02) + S * 0.045;
  const blockTop = y;

  for (const [lf, rf, isVerse] of rows) {
    const c = isVerse ? SCRIPTURE : PARCHMENT;
    const r = bar / 2;
    const lx2 = mid - gap / 2;
    rect(lx2 - col * lf, y, lx2, y + bar, c, r);
    const rx1 = mid + gap / 2;
    rect(rx1, y, rx1 + col * rf, y + bar, c, r);
    y += space;
  }

  rect(mid - S * 0.0035, blockTop, mid + S * 0.0035, y - space + bar, RULE);

  // Downsample by averaging each SS x SS block.
  const out = new Uint8Array(size * size * 3);
  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((oy * SS + dy) * S + (ox * SS + dx)) * 3;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
        }
      }
      const n = SS * SS;
      const o = (oy * size + ox) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }

  return png(size, size, out);
}

mkdirSync(OUT, { recursive: true });

for (const s of [32, 180, 192, 256, 512]) {
  const name = s === 32 ? 'favicon-32.png' : `icon-${s}.png`;
  writeFileSync(path.join(OUT, name), render(s, false));
  console.log(`  ${name}`);
}
writeFileSync(path.join(OUT, 'maskable-512.png'), render(512, true));
console.log('  maskable-512.png');
console.log('\nIcons written to public/icons/');
