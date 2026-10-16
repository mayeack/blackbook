#!/usr/bin/env node
// Generates the PWA icons into packages/web/public (committed; rerun after changing the mark):
//   icons/icon.svg           master mark (favicon, manifest "any")
//   icons/icon-192.png       rounded square, transparent corners
//   icons/icon-512.png
//   icons/maskable-512.png   full bleed, glyph inside the 80% safe zone
//   apple-touch-icon.png     180×180 full bleed (iOS rounds the corners itself)
// Pure Node (zlib only): the mark is a gold tile with a dark "Y", rendered from signed distances with 1px AA.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const GOLD_TOP = [0xe2, 0xb3, 0x3a];
const GOLD_BOTTOM = [0xb8, 0x86, 0x0b];
const INK = [0x17, 0x14, 0x0c];
const RADIUS = 0.22; // corner radius of the "any" tile, as a fraction of the side
const HALF_STROKE = 0.065;
// The "Y": two arms meeting at the fork, then the stem (unit square, y down).
const SEGMENTS = [
  [0.32, 0.27, 0.5, 0.5],
  [0.68, 0.27, 0.5, 0.5],
  [0.5, 0.5, 0.5, 0.75],
];

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function segmentDistance(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedRectDistance(px, py, r) {
  const qx = Math.abs(px - 0.5) - (0.5 - r);
  const qy = Math.abs(py - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const coverage = (d, size) => Math.max(0, Math.min(1, 0.5 - d * size));

/** RGBA pixels for one icon. `bleed` fills the square; `glyphScale` shrinks the Y around the centre. */
function render(size, { bleed, glyphScale }) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const bg = bleed ? 1 : coverage(roundedRectDistance(px, py, RADIUS), size);
      const gx = 0.5 + (px - 0.5) / glyphScale;
      const gy = 0.5 + (py - 0.5) / glyphScale;
      const d = Math.min(...SEGMENTS.map((s) => segmentDistance(gx, gy, s))) - HALF_STROKE;
      const ink = coverage(d * glyphScale, size);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const gold = GOLD_TOP[c] + (GOLD_BOTTOM[c] - GOLD_TOP[c]) * py;
        out[i + c] = Math.round(gold + (INK[c] - gold) * ink);
      }
      out[i + 3] = Math.round(bg * 255);
    }
  }
  return out;
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4); // filter 0 per row
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const s = 512;
  const n = (v) => Math.round(v * s * 10) / 10;
  const [a, b, stem] = SEGMENTS;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hex(GOLD_TOP)}"/><stop offset="1" stop-color="${hex(GOLD_BOTTOM)}"/></linearGradient></defs>
  <rect width="${s}" height="${s}" rx="${n(RADIUS)}" fill="url(#g)"/>
  <path d="M${n(a[0])} ${n(a[1])} L${n(a[2])} ${n(a[3])} L${n(b[0])} ${n(b[1])} M${n(stem[0])} ${n(stem[1])} L${n(stem[2])} ${n(stem[3])}" fill="none" stroke="${hex(INK)}" stroke-width="${n(HALF_STROKE * 2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

const outputs = [
  ['icons/icon-192.png', 192, { bleed: false, glyphScale: 1 }],
  ['icons/icon-512.png', 512, { bleed: false, glyphScale: 1 }],
  ['icons/maskable-512.png', 512, { bleed: true, glyphScale: 0.8 }],
  ['apple-touch-icon.png', 180, { bleed: true, glyphScale: 0.9 }],
];

fs.mkdirSync(path.join(PUBLIC, 'icons'), { recursive: true });
fs.writeFileSync(path.join(PUBLIC, 'icons/icon.svg'), svg());
for (const [file, size, opts] of outputs) fs.writeFileSync(path.join(PUBLIC, file), png(size, render(size, opts)));
process.stdout.write(`wrote ${outputs.length + 1} icons to ${path.relative(process.cwd(), PUBLIC)}\n`);
