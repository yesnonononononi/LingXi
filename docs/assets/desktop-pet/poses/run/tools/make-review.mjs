// 人眼复核图：亮底 + 暗底两排、6 帧同尺度并排（run 左向）。全部像素由 manifest 里的母版按同一个缩放系数合成，
// 不引入任何主观缩放，便于按比例判断「朝向 / 支撑脚 / 轮廓」。
// 运行：node docs/assets/desktop-pet/poses/walk/tools/make-review.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const CELL = 234;        // 每格内容边长（母版 3072 → 234 = 引擎 display 宽度，统一系数 0.07619）
const GAP = 16;
const PAD = 24;
const LABEL_H = 44;      // 两行标签：帧号+朝向箭头+相位 / 前倾量
const LIGHT = [238, 238, 240];
const DARK = [26, 26, 30];

// 5x7 点阵字体（只放复核图需要的字符）
const FONT = {
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
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
const W = PAD * 2 + frames.length * CELL + (frames.length - 1) * GAP;
const rowH = CELL + LABEL_H;
const H = PAD * 2 + rowH * 2 + GAP;
const out = Buffer.alloc(W * H * 4);

function paintBg(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
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

const rows = [
  { label: 'LIGHT BG', bg: LIGHT, ink: [40, 40, 48] },
  { label: 'DARK BG', bg: DARK, ink: [225, 225, 235] },
];

frames.forEach((f, i) => {
  const img = decodePng(fs.readFileSync(path.join(root, f.file)));
  const tile = downsample(img, CELL);
  const x0 = PAD + i * (CELL + GAP);
  rows.forEach((row, ri) => {
    const y0 = PAD + LABEL_H + ri * (rowH + GAP);
    paintBg(x0 - GAP / 2, y0 - LABEL_H, CELL + GAP, LABEL_H + CELL + GAP / 2, row.bg);
    blendTile(tile, x0, y0);
    const tag = f.airborne ? 'AIR' : (f.phase === 'front' ? 'F' : 'B');
    const arrow = f.facing > 0 ? '>' : '<';
    drawText(out, W, x0, y0 - LABEL_H + 2, f.id.toUpperCase() + ' ' + arrow + ' ' + tag, row.ink, 2);
    drawText(out, W, x0, y0 - LABEL_H + 20, String(f.lean ? f.lean.faceForwardNative : 0), row.ink, 2);
  });
  rows.forEach(() => {}); // 行标签统一在左上角绘制，避免每格重复
});
// 每格标注：帧号 + 相位（F=支撑脚在躯干前方 / B=在后方 / AIR=腾空）+ 前倾量（面部相对躯干前伸的 native px）
drawText(out, W, PAD, 6, 'LIGHT', [60, 60, 70], 2);
drawText(out, W, PAD, PAD + LABEL_H + rowH + GAP - LABEL_H + 2, 'DARK', [230, 230, 240], 2);

fs.writeFileSync(path.join(root, 'qa/run_review.png'), encodePng({ width: W, height: H, data: out }));
console.log('qa/run_review.png ' + W + 'x' + H + ' cells=' + frames.length + ' cell=' + CELL + 'px scale=' + (CELL / manifest.canvas.width).toFixed(5));




