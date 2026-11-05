// 人眼复核图：亮底 + 暗底双排、5 帧同尺度并排（jump 左向）。全部像素由 manifest 里的母版按同一系数合成
// （母版 3072 → 234 = 引擎 display 宽），不引入任何主观缩放。标签 = 帧号 + 相位（SUP/AIR）+ 离地 gap。
// 运行：node docs/assets/desktop-pet/poses/jump/tools/make-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const CELL = 234;        // 每格内容边长（= 引擎 display 宽，系数 0.07619）
const GAP = 16;
const PAD = 24;
const LABEL_H = 44;      // 两行标签：帧名 / 相位 + gap
const LIGHT = [238, 238, 240];
const DARK = [26, 26, 30];

// 5x7 点阵字体（只放复核图需要的字符）
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(buf, W, x0, y0, text, color, scale = 2) {
  let cursor = x0;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] || FONT[' '];
    for (let gy = 0; gy < 7; gy += 1) {
      for (let gx = 0; gx < 5; gx += 1) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = cursor + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px < 0 || py < 0 || px >= W) continue;
            const o = (py * W + px) * 4;
            buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2]; buf[o + 3] = 255;
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

// 预乘 alpha 的盒式降采样
function downsample(img, outSize) {
  const factor = img.width / outSize;
  const out = Buffer.alloc(outSize * outSize * 4);
  for (let oy = 0; oy < outSize; oy += 1) {
    for (let ox = 0; ox < outSize; ox += 1) {
      const x0 = Math.floor(ox * factor);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.ceil((ox + 1) * factor)));
      const y0 = Math.floor(oy * factor);
      const y1 = Math.min(img.height, Math.max(y0 + 1, Math.ceil((oy + 1) * factor)));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const o = (y * img.width + x) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al;
          a += al; n += 1;
        }
      }
      const t = (oy * outSize + ox) * 4;
      if (a > 0) {
        out[t] = Math.round(r / a); out[t + 1] = Math.round(g / a); out[t + 2] = Math.round(b / a);
      }
      out[t + 3] = Math.round(255 * a / n);
    }
  }
  return out;
}

const frames = manifest.frames;
// 左右向各一组：同一相位左右相邻排布，方便一眼比对「转身有没有走形 / 一高一低」
const PHASES = ['anticipate', 'ascend', 'apex', 'descend', 'land'];
const facingOf = (f) => (f.id.startsWith('r_') ? 1 : -1);
const pick = (facing, phase) => frames.find((f) => facingOf(f) === facing && f.id.replace(/^r_/, '') === phase);
const COLS = PHASES.length;
const W = PAD * 2 + COLS * CELL + (COLS - 1) * GAP;
const HEAD_H = 22;
const SECTION_H = HEAD_H + 2 * (LABEL_H + CELL) + GAP;
const H = PAD * 2 + SECTION_H * 2;
const out = Buffer.alloc(W * H * 4);

function paintBg(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 4;
      out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = 255;
    }
  }
}

function blendTile(px, x0, y0) {
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      const s = (y * CELL + x) * 4;
      const a = px[s + 3] / 255;
      const o = ((y0 + y) * W + (x0 + x)) * 4;
      for (let c = 0; c < 3; c += 1) out[o + c] = Math.round(px[s + c] * a + out[o + c] * (1 - a));
    }
  }
}

const sections = [
  { label: 'LIGHT BG', bg: LIGHT, ink: [40, 40, 48] },
  { label: 'DARK BG', bg: DARK, ink: [225, 225, 235] },
];
const FACING_ROWS = [
  { facing: -1, tag: 'LEFT (<)', arrow: '<' },
  { facing: 1, tag: 'RIGHT (>)', arrow: '>' },
];

// 每帧只解码/降采样一次（同一帧在亮底暗底两排复用）
const tileCache = new Map();
function tileOf(f) {
  if (!tileCache.has(f.id)) tileCache.set(f.id, downsample(decodePng(fs.readFileSync(path.join(root, f.file))), CELL));
  return tileCache.get(f.id);
}

sections.forEach((section, si) => {
  const secY = PAD + si * SECTION_H;
  paintBg(0, secY, W, SECTION_H - GAP / 2, section.bg);
  drawText(out, W, PAD, secY + 2, section.label, section.ink, 2);
  FACING_ROWS.forEach((row, ri) => {
    const y0 = secY + HEAD_H + ri * (LABEL_H + CELL);
    drawText(out, W, PAD, y0 + 2, row.tag, section.ink, 1);
    PHASES.forEach((phase, ci) => {
      const f = pick(row.facing, phase);
      const x0 = PAD + ci * (CELL + GAP);
      if (!f) { drawText(out, W, x0, y0 + LABEL_H + 20, 'MISSING', section.ink, 2); return; }
      const gap = f.contactPoints.airborneGap === null || f.contactPoints.airborneGap === undefined ? 0 : f.contactPoints.airborneGap;
      const tag = f.airborne ? 'AIR' : 'SUP';
      blendTile(tileOf(f), x0, y0 + LABEL_H);
      drawText(out, W, x0, y0 + 2, phase.toUpperCase(), section.ink, 2);
      drawText(out, W, x0, y0 + 20, tag + ' ' + gap + ' ' + row.arrow, section.ink, 2);
    });
  });
});
// 同尺度声明：10 格全部按 母版 3072 → 234 的同一系数降采样，左右两组没有不同缩放
drawText(out, W, PAD, H - PAD + 4, 'ALL 10 CELLS: MASTER 3072 > 234 PX (SAME SCALE)', sections[0].ink, 1);

fs.writeFileSync(path.join(root, 'qa/jump_review.png'), encodePng({ width: W, height: H, data: out }));
console.log('qa/jump_review.png ' + W + 'x' + H + ' cells=' + frames.length + ' cell=' + CELL + 'px scale=' + (CELL / manifest.canvas.width).toFixed(5));
