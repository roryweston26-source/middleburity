// Writes the PNG app icons from the same shape as public/icon.svg (a white "M" on navy).
// iOS ignores SVG home-screen icons and Android's install prompt wants PNGs, so these are
// generated here with no image library: the shape is simple enough to draw directly.
//   npm run build:icons
// Rerun after changing icon.svg, and keep the shape below in step with it.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const NAVY = [0x16, 0x32, 0x5c];
const WHITE = [0xff, 0xff, 0xff];
// icon.svg, in its 64-unit box: the M's points, stroke width 6, round caps and joins.
const M = [[17, 46], [17, 19], [32, 36], [47, 19], [47, 46]];
const STROKE = 6;
const RADIUS = 14;

const ICONS = [
  // Browsers and Android's "any" purpose: the rounded square as drawn, transparent corners.
  { file: "icon-192.png", size: 192, corner: RADIUS, scale: 1 },
  { file: "icon-512.png", size: 512, corner: RADIUS, scale: 1 },
  // Android's maskable icon: full bleed, the M shrunk to stay inside the launcher's safe circle.
  { file: "icon-maskable-512.png", size: 512, corner: 0, scale: 0.8 },
  // iOS rounds the corners itself and shows transparency as black, so this one is full bleed.
  { file: "apple-touch-icon.png", size: 180, corner: 0, scale: 1 },
];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// With round caps and joins, a stroked polyline is exactly the points within STROKE/2 of a segment.
function inM(x, y, scale) {
  const sx = 32 + (x - 32) / scale;
  const sy = 32 + (y - 32) / scale;
  for (let i = 0; i < M.length - 1; i++) {
    if (segDist(sx, sy, M[i], M[i + 1]) <= STROKE / 2) return true;
  }
  return false;
}

function inSquare(x, y, r) {
  if (r === 0) return x >= 0 && x <= 64 && y >= 0 && y <= 64;
  const cx = Math.min(Math.max(x, r), 64 - r);
  const cy = Math.min(Math.max(y, r), 64 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

// 4x4 samples per pixel for smooth edges.
function render({ size, corner, scale }) {
  const N = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let fill = 0;
      let white = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = ((px + (i + 0.5) / N) * 64) / size;
          const y = ((py + (j + 0.5) / N) * 64) / size;
          if (!inSquare(x, y, corner)) continue;
          fill++;
          if (inM(x, y, scale)) white++;
        }
      }
      const o = (py * size + px) * 4;
      if (fill === 0) continue;
      for (let c = 0; c < 3; c++) rgba[o + c] = Math.round((NAVY[c] * (fill - white) + WHITE[c] * white) / fill);
      rgba[o + 3] = Math.round((255 * fill) / (N * N));
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // Each row starts with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const icon of ICONS) {
  const out = new URL(`../public/${icon.file}`, import.meta.url);
  writeFileSync(out, png(icon.size, render(icon)));
  console.log(`public/${icon.file} (${icon.size}x${icon.size})`);
}
