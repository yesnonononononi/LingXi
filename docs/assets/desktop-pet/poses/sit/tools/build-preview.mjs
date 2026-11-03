import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sitting = readPng(path.join(root, 'sit_neutral@2x.png'));
const standing = readPng(path.join(root, '../../v3/front-standing.png'));
const canvas = { width: 1000, height: 740, data: Buffer.alloc(1000 * 740 * 4) };
for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
  const dark = x >= 500;
  const color = dark ? [35, 44, 58] : [244, 241, 236];
  const index = (y * canvas.width + x) * 4;
  for (let channel = 0; channel < 3; channel++) canvas.data[index + channel] = color[channel];
  canvas.data[index + 3] = 255;
}
function draw(image, left, top, scale) {
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = left + x, dy = top + y;
    if (dx < 0 || dy < 0 || dx >= canvas.width || dy >= canvas.height) continue;
    const src = (Math.min(image.height - 1, Math.floor(y / scale)) * image.width + Math.min(image.width - 1, Math.floor(x / scale))) * 4;
    const dst = (dy * canvas.width + dx) * 4;
    const alpha = image.data[src + 3] / 255;
    for (let c = 0; c < 3; c++) canvas.data[dst + c] = Math.round(image.data[src + c] * alpha + canvas.data[dst + c] * (1 - alpha));
  }
}
draw(sitting, 65, 185, 0.18); draw(sitting, 565, 185, 0.18);
draw(standing, 48, 15, 0.095); draw(sitting, 257, 15, 0.095);
draw(standing, 548, 15, 0.095); draw(sitting, 757, 15, 0.095);
writePng(path.join(root, 'qa/sit_review.png'), canvas);
console.log('生成复核图: file=qa/sit_review.png, 上方=站坐同尺对照, 下方=坐姿细节, 左=浅底, 右=深底');
