// 人眼复核图生成：亮底 + 暗底两排，同一尺度；另附一条 1.5x 脸部放大条。
// 图上只有数字徽标（1..9），图例写在 README「怎么一眼复核」里。
// 运行：node docs/assets/desktop-pet/poses/sleep/tools/make-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.join(root, 'qa/sleep_review.png');

const TILE = 320;
const GAP = 12;
const PAD = 16;
const ROWS = [
  { bg: [242, 243, 245], ink: [30, 32, 38] },
  { bg: [26, 28, 34], ink: [250, 250, 252] },
];
const TILES = [
  { n: 1, file: '../lie/lie_neutral@2x.png', label: 'lie 睁眼基准' },
  { n: 2, file: 'sleep_neutral@2x.png', label: '趴睡闭眼' },
  { n: 3, file: 'sleep_breath_in_neutral@2x.png', label: '吸气' },
  { n: 4, file: 'sleep_breath_out_neutral@2x.png', label: '呼气' },
  { n: 5, file: 'sleep_startle_neutral@2x.png', label: '惊醒' },
  { n: 6, file: 'sleep_curled@2x.png', label: '蜷睡' },
];
const ZOOM = [
  { n: 7, file: 'sleep_neutral@2x.png', box: { l: 640, t: 2200, r: 1440, b: 2620 } },
  { n: 8, file: 'sleep_startle_neutral@2x.png', box: { l: 640, t: 2200, r: 1440, b: 2620 } },
  { n: 9, file: 'sleep_curled@2x.png', box: { l: 640, t: 2200, r: 1440, b: 2620 } },
];

// 5x7 点阵数字，只用来打编号，避免依赖字体
const GLYPH = {
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

const zoomW = ZOOM[0].box.r - ZOOM[0].box.l + 1;
const zoomH = ZOOM[0].box.b - ZOOM[0].box.t + 1;
const zoomScale = 1;
const zoomTileW = Math.round(zoomW * zoomScale);
const zoomTileH = Math.round(zoomH * zoomScale);

const rowW = TILE * TILES.length + GAP * (TILES.length - 1);
const zW = zoomTileW * ZOOM.length + GAP * (ZOOM.length - 1);
const blockW = Math.max(rowW, zW);
const width = blockW + PAD * 4;
const rowBlockH = TILE + PAD * 2;
const zoomBlockH = zoomTileH + PAD * 2;
const height = PAD * 2 + rowBlockH * ROWS.length + zoomBlockH;

const canvas = { width, height, data: Buffer.alloc(width * height * 4) };
function fillRect(x0, y0, w, h, rgb, a = 255) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const o = (y * canvas.width + x) * 4;
      const al = a / 255;
      for (let k = 0; k < 3; k += 1) canvas.data[o + k] = Math.round(rgb[k] * al + canvas.data[o + k] * (1 - al));
      canvas.data[o + 3] = 255;
    }
  }
}
function blend(img, sx, sy, sw, sh, dx, dy, dw, dh) {
  const sxs = sw / dw;
  const sys = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(sy + y * sys);
    const y1 = Math.max(y0 + 1, Math.min(sy + sh, Math.ceil(sy + (y + 1) * sys)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(sx + x * sxs);
      const x1 = Math.max(x0 + 1, Math.min(sx + sw, Math.ceil(sx + (x + 1) * sxs)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const o = (yy * img.width + xx) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al;
          a += al; n += 1;
        }
      }
      if (!n || a <= 0) continue;
      const cov = a / n;
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= canvas.width || ty >= canvas.height) continue;
      const o = (ty * canvas.width + tx) * 4;
      for (let k = 0; k < 3; k += 1) {
        const src = [r / a, g / a, b / a][k];
        canvas.data[o + k] = Math.round(src * cov + canvas.data[o + k] * (1 - cov));
      }
      canvas.data[o + 3] = 255;
    }
  }
}
function badge(x, y, digit, bg, fg) {
  const R = 15;
  for (let dy = -R; dy <= R; dy += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      if (dx * dx + dy * dy > R * R) continue;
      const tx = x + dx; const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= canvas.width || ty >= canvas.height) continue;
      const o = (ty * canvas.width + tx) * 4;
      for (let k = 0; k < 3; k += 1) canvas.data[o + k] = bg[k];
      canvas.data[o + 3] = 255;
    }
  }
  const g = GLYPH[digit];
  const s = 2;
  const ox = x - Math.round((5 * s) / 2);
  const oy = y - Math.round((7 * s) / 2);
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      if (g[r][c] !== '1') continue;
      fillRect(ox + c * s, oy + r * s, s, s, fg);
    }
  }
}

fillRect(0, 0, width, height, [120, 122, 128]);
const cache = new Map();
const load = (rel) => {
  if (!cache.has(rel)) cache.set(rel, readPng(path.join(root, rel)));
  return cache.get(rel);
};

for (const [ri, row] of ROWS.entries()) {
  const blockY = PAD + ri * rowBlockH;
  const y = blockY + PAD;
  const x0 = Math.round((width - rowW) / 2);
  fillRect(x0 - PAD, blockY, rowW + PAD * 2, rowBlockH, row.bg);
  for (const [ti, t] of TILES.entries()) {
    const x = x0 + ti * (TILE + GAP);
    const img = load(t.file);
    blend(img, 0, 0, img.width, img.height, x, y, TILE, TILE);
    // 1px 描边，暗底上也能看清每一格边界
    fillRect(x - 1, y - 1, TILE + 2, 1, row.ink);
    fillRect(x - 1, y + TILE, TILE + 2, 1, row.ink);
    fillRect(x - 1, y, 1, TILE, row.ink);
    fillRect(x + TILE, y, 1, TILE, row.ink);
    badge(x + 22, y + 22, t.n, row.ink, row.bg);
  }
}
// 放大条：只放 neutral / startle / curled 的脸部，同一裁剪框同一倍率
const zBlockY = PAD + ROWS.length * rowBlockH;
const zy = zBlockY + PAD;
const zx = Math.round((width - zW) / 2);
fillRect(zx - PAD, zBlockY, zW + PAD * 2, zoomBlockH, ROWS[0].bg);
for (const [zi, z] of ZOOM.entries()) {
  const img = load(z.file);
  const x = zx + zi * (zoomTileW + GAP);
  blend(img, z.box.l, z.box.t, zoomW, zoomH, x, zy, zoomTileW, zoomTileH);
  fillRect(x - 1, zy - 1, zoomTileW + 2, 1, ROWS[0].ink);
  fillRect(x - 1, zy + zoomTileH, zoomTileW + 2, 1, ROWS[0].ink);
  fillRect(x - 1, zy, 1, zoomTileH, ROWS[0].ink);
  fillRect(x + zoomTileW, zy, 1, zoomTileH, ROWS[0].ink);
  badge(x + 22, zy + 22, z.n, ROWS[0].ink, ROWS[0].bg);
}
for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 255;
const bytes = encodePng(canvas);
fs.writeFileSync(OUT, bytes);
console.log(JSON.stringify({ out: 'qa/sleep_review.png', width, height, bytes: bytes.length,
  tiles: TILES.map((t) => t.n + ':' + t.label), zoomBox: ZOOM[0].box, zoomScale }, null, 2));
