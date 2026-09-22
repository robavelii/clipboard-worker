/**
 * Generates the app icons.
 *
 * Draws them procedurally and writes real PNGs with zlib rather than adding an
 * image library: the icon is two rounded rectangles, which is less code than
 * the dependency would be.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [0x1f, 0x1f, 0x23];
const FG = [0x6c, 0xc3, 0x9a];
const CLIP = [0xec, 0xec, 0xf0];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Rounded-rectangle coverage, used for cheap anti-aliasing. */
function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const px = (n) => n * size;
  const rows = [];

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let colour = null;

      // Backing plate.
      if (inRounded(x, y, px(0.02), px(0.02), px(0.98), px(0.98), px(0.22))) {
        colour = BG;
      }
      // The clipboard body.
      if (inRounded(x, y, px(0.26), px(0.22), px(0.74), px(0.84), px(0.07))) {
        colour = CLIP;
      }
      // The clip at the top.
      if (inRounded(x, y, px(0.38), px(0.13), px(0.62), px(0.28), px(0.05))) {
        colour = FG;
      }

      const o = 1 + x * 4;
      if (colour) {
        row[o] = colour[0];
        row[o + 1] = colour[1];
        row[o + 2] = colour[2];
        row[o + 3] = 255;
      }
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = [
  ["apps/desktop/src-tauri/icons/32x32.png", 32],
  ["apps/desktop/src-tauri/icons/128x128.png", 128],
  ["apps/desktop/src-tauri/icons/128x128@2x.png", 256],
  ["apps/desktop/src-tauri/icons/icon.png", 512],
  ["apps/desktop/src-tauri/icons/tray.png", 64],
  ["apps/web/public/icon-192.png", 192],
  ["apps/web/public/icon-512.png", 512],
];

mkdirSync("apps/desktop/src-tauri/icons", { recursive: true });
mkdirSync("apps/web/public", { recursive: true });
for (const [path, size] of targets) {
  writeFileSync(path, render(size));
  console.log(`  ${path} (${size}px)`);
}
