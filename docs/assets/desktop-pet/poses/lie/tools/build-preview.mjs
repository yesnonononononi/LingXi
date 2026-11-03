import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = { width: 1380, height: 820, data: Buffer.alloc(1380 * 820 * 4) };
for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
  const color = y < 410 ? [247, 244, 239] : [33, 42, 56];
  const offset = (y * image.width + x) * 4;
  for (let c = 0; c < 3; c++) image.data[offset + c] = color[c];
  image.data[offset + 3] = 255;
}

// 面积加权采样只用于复核缩略图，母版始终保留最近邻原始像素。
function draw(sprite, left, top, scale) {
  for (let y = 0; y < Math.ceil(sprite.height * scale); y++) for (let x = 0; x < Math.ceil(sprite.width * scale); x++) {
    let alphaSum = 0, weightSum = 0;
    const rgb = [0, 0, 0];
    const sx0 = x / scale, sx1 = Math.min(sprite.width, (x + 1) / scale);
    const sy0 = y / scale, sy1 = Math.min(sprite.height, (y + 1) / scale);
    for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
      const weight = Math.max(0, Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * Math.max(0, Math.min(sy + 1, sy1) - Math.max(sy, sy0));
      const offset = (sy * sprite.width + sx) * 4;
      const alpha = sprite.data[offset + 3] / 255;
      weightSum += weight; alphaSum += alpha * weight;
      for (let c = 0; c < 3; c++) rgb[c] += sprite.data[offset + c] * alpha * weight;
    }
    const offset = ((top + y) * image.width + left + x) * 4;
    const alpha = alphaSum / weightSum;
    if (alphaSum) for (let c = 0; c < 3; c++) image.data[offset + c] = Math.round(rgb[c] / weightSum + image.data[offset + c] * (1 - alpha));
  }
}
for (const row of [0, 1]) for (const [column, filename] of ['lie_down_01_neutral@2x.png', 'lie_down_02_neutral@2x.png', 'lie_neutral@2x.png'].entries()) {
  draw(readPng(path.join(root, filename)), column * 460 + 30, row * 410, 0.13);
}
writePng(path.join(root, 'qa/lie_review.png'), image);
console.log('生成复核图: file=qa/lie_review.png, 上排=亮底, 下排=暗底, 每排从左到右=站姿/半趴/趴姿');
