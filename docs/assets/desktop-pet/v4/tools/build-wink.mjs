// 从 v3 母版合成 E9_wink.png（单眼眨眼）：保留 E1 睁眼那张脸的全部像素，
// 只把「画面左侧那只眼」替换成 E2_blink 的闭眼笔迹。
// 为什么要这样合成：E2 的闭眼是同一角色、同一位置、同一光照下的既有笔迹，
// 直接复用像素比重新手绘更不容易跑形；而 wink 与 E1 的差异被严格限制在单侧眼区，
// 靠 diff 掩膜 + 膨胀保证「闭眼笔迹全覆盖」且「眼区之外一个像素都不动」。
//
// 运行：node docs/assets/desktop-pet/v4/tools/build-wink.mjs
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

export const CONTRACT = {
  canvas: { width: 2048, height: 3072 },
  anchor: { x: 1024, y: 2908 },
  // 与 E1 求差时的逐通道阈值（与架构师 §4.1 实测口径一致）
  diffThreshold: 7,
  // 掩膜膨胀半径：覆盖抗锯齿过渡带，避免闭眼笔迹边缘残留睁眼轮廓
  dilateRadius: 4,
  // 闭眼那一侧的眼区（画面左，2048×3072 画布坐标）——差异唯一允许出现的区域
  winkEyeZone: { left: 570, top: 1070, right: 960, bottom: 1380 },
  // 睁眼那一侧的眼区——差异必须为 0，否则就是「双眼闭合」而非 wink
  openEyeZone: { left: 1000, top: 1060, right: 1400, bottom: 1380 },
  // 架构师 §4.1 实测的整脸可动区域
  faceRegionMaster: { left: 560, top: 1064, width: 792, height: 400 },
  alphaSolid: 248,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const assetRoot = path.resolve(here, '..', '..');
const v3Expr = path.join(assetRoot, 'v3', 'expr');
const defaultOut = path.join(assetRoot, 'v4', 'expr', 'E9_wink.png');

function maxChannelDelta(a, b, i) {
  return Math.max(
    Math.abs(a[i] - b[i]),
    Math.abs(a[i + 1] - b[i + 1]),
    Math.abs(a[i + 2] - b[i + 2]),
    Math.abs(a[i + 3] - b[i + 3]),
  );
}

function inRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// 方形核膨胀：先横向后纵向做最大值滤波，复杂度 O(n·r)
function dilate(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = 0;
      for (let k = -radius; k <= radius && v === 0; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < width && mask[row + xx]) v = 1;
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let v = 0;
      for (let k = -radius; k <= radius && v === 0; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < height && tmp[yy * width + x]) v = 1;
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

function bboxOf(mask, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return { count: 0, bbox: null };
  return { count, bbox: { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

export function buildWink() {
  const e1 = readPng(path.join(v3Expr, 'E1_default.png'));
  const e2 = readPng(path.join(v3Expr, 'E2_blink.png'));
  const { width, height } = CONTRACT.canvas;
  for (const [name, img] of [['E1_default', e1], ['E2_blink', e2]]) {
    if (img.width !== width || img.height !== height) {
      throw new Error(`${name} 画布 ${img.width}×${img.height} 与契约 ${width}×${height} 不一致`);
    }
  }

  const pixels = width * height;
  const raw = new Uint8Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!inRect(x, y, CONTRACT.winkEyeZone)) continue;
      const i = (y * width + x) * 4;
      if (maxChannelDelta(e1.data, e2.data, i) > CONTRACT.diffThreshold) raw[y * width + x] = 1;
    }
  }
  const rawStat = bboxOf(raw, width, height);
  if (rawStat.count === 0) throw new Error('E1 与 E2 在闭眼侧眼区间无差异，无法提取闭眼笔迹');

  const mask = dilate(raw, width, height, CONTRACT.dilateRadius);
  const maskStat = bboxOf(mask, width, height);
  const zone = CONTRACT.winkEyeZone;
  if (maskStat.bbox.left < zone.left || maskStat.bbox.right > zone.right
    || maskStat.bbox.top < zone.top || maskStat.bbox.bottom > zone.bottom) {
    throw new Error(`膨胀后掩膜 ${JSON.stringify(maskStat.bbox)} 溢出单侧眼区 ${JSON.stringify(zone)}`);
  }

  const out = Buffer.from(e1.data);
  for (let i = 0; i < pixels; i += 1) {
    if (!mask[i]) continue;
    const o = i * 4;
    out[o] = e2.data[o];
    out[o + 1] = e2.data[o + 1];
    out[o + 2] = e2.data[o + 2];
    out[o + 3] = e2.data[o + 3];
  }

  // alpha 自检：E1 不透明的实心像素，合成后不得变透明（不许抠出新洞）
  let newHoles = 0;
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4 + 3;
    if (e1.data[o] >= CONTRACT.alphaSolid && out[o] < CONTRACT.alphaSolid) newHoles += 1;
  }
  if (newHoles !== 0) throw new Error(`合成后新增 ${newHoles} 个不透明→半透明像素`);

  return {
    image: { width, height, data: out },
    report: {
      sourcePatchedPixels: rawStat.count,
      patchedPixels: maskStat.count,
      patchedBbox: maskStat.bbox,
      sourceBbox: rawStat.bbox,
      dilateRadius: CONTRACT.dilateRadius,
      newAlphaHoles: newHoles,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
  const target = outArg ? path.resolve(outArg.slice('--out='.length)) : defaultOut;
  const { image, report } = buildWink();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = encodePng(image);
  fs.writeFileSync(target, bytes);
  console.log(JSON.stringify({
    output: target,
    width: image.width,
    height: image.height,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...report,
  }, null, 2));
}
