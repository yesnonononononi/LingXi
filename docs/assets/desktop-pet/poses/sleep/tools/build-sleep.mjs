// sleep 批次构建：把「参考图 + 眼区蒙版」生成的闭眼结果，只取眼区贴片合成回 lie 的原生图。
// 为什么这样合成：工具文档明确写了蒙版「不保证保留其余区域」，实测眼区外 maxDelta=255（整张被重绘）。
// 所以资产层的像素保真不能依赖模型，而是「lie 原像素 + 眼区贴片」的确定性合成：
// 眼区之外逐字节等于 lie native（可机验），眼区之内才是模型画的闭眼。
//
// 运行：node docs/assets/desktop-pet/poses/sleep/tools/build-sleep.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const posesRoot = path.resolve(root, '..');

export const CONFIG = {
  canvas: { width: 3072, height: 3072 },
  native: { width: 1536, height: 1536 },
  masterScale: 2,
  alphaClearBelow: 8,
  alphaSolidAt: 248,
  minIslandArea: 4,
  feather: 8,
  alignSearch: 14,
  // 参照批次（只读，绝不修改）
  reference: { batch: 'lie', file: 'source/lie_neutral_native.png' },
  inputs: {
    generated: 'source/sleep_neutral_generated.png',
    mask: 'source/eye_mask_native.png',
  },
  outputs: {
    native: 'source/sleep_neutral_native.png',
    master: 'sleep_neutral@2x.png',
  },
};

function readMaskBoxes(mask) {
  // 蒙版语义：完全透明 = 待编辑 ⇒ 透明连通域就是眼区，bbox 直接当贴片框
  const { width: W, height: H, data } = mask;
  const seen = new Uint8Array(W * H);
  const boxes = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const start = y * W + x;
      if (seen[start] || data[start * 4 + 3] !== 0) continue;
      const stack = [start];
      seen[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (stack.length) {
        const cur = stack.pop();
        count += 1;
        const cx = cur % W;
        const cy = (cur - cx) / W;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const next = ny * W + nx;
            if (seen[next] || data[next * 4 + 3] !== 0) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (count > 64) boxes.push({ left: minX, top: minY, right: maxX, bottom: maxY, area: count });
    }
  }
  boxes.sort((a, b) => a.left - b.left);
  return boxes;
}

function resamplePremultiplied(src, dw, dh) {
  const { width: sw, height: sh, data } = src;
  const out = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(sh, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(sw, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const o = (yy * sw + xx) * 4;
          const al = data[o + 3] / 255;
          r += data[o] * al;
          g += data[o + 1] * al;
          b += data[o + 2] * al;
          a += al;
          n += 1;
        }
      }
      if (!n || a <= 0) continue;
      const t = (y * dw + x) * 4;
      out[t] = Math.round(r / a);
      out[t + 1] = Math.round(g / a);
      out[t + 2] = Math.round(b / a);
      out[t + 3] = Math.round(255 * a / n);
    }
  }
  return { width: dw, height: dh, data: out };
}

function alignByAlpha(reference, generated, limit) {
  const W = reference.width;
  const samples = [];
  for (let y = 0; y < reference.height; y += 7) {
    for (let x = 0; x < W; x += 7) {
      if (reference.data[(y * W + x) * 4 + 3] > 200) samples.push([x, y]);
    }
  }
  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -limit; dy <= limit; dy += 1) {
    for (let dx = -limit; dx <= limit; dx += 1) {
      let hit = 0;
      for (const [x, y] of samples) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= generated.height) continue;
        if (generated.data[(ny * W + nx) * 4 + 3] > 200) hit += 1;
      }
      const score = hit / samples.length;
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return best;
}

export function buildSleep() {
  const lieNative = readPng(path.join(posesRoot, CONFIG.reference.batch, CONFIG.reference.file));
  const generated = readPng(path.join(root, CONFIG.inputs.generated));
  const mask = readPng(path.join(root, CONFIG.inputs.mask));
  const N = CONFIG.native.width;
  if (lieNative.width !== N || lieNative.height !== CONFIG.native.height) throw new Error('参照 native 尺寸不符');
  if (mask.width !== N || mask.height !== CONFIG.native.height) throw new Error('蒙版尺寸必须与 native 一致');

  const boxes = readMaskBoxes(mask);
  if (boxes.length !== 2) throw new Error('蒙版应恰好含两个眼区透明块，实际 ' + boxes.length);

  const genScaled = resamplePremultiplied(generated, N, CONFIG.native.height);
  const align = alignByAlpha(lieNative, genScaled, CONFIG.alignSearch);

  const out = Buffer.from(lieNative.data);
  const perBox = [];
  for (const box of boxes) {
    const bands = { left: [], right: [], top: [], bottom: [] };
    for (let y = box.top - 14; y <= box.bottom + 14; y += 1) {
      for (let x = box.left - 14; x <= box.right + 14; x += 1) {
        if (x < 0 || y < 0 || x >= N || y >= CONFIG.native.height) continue;
        const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
        if (inside) continue;
        const a = (y * N + x) * 4;
        const c = ((y + align.dy) * N + (x + align.dx)) * 4;
        if (lieNative.data[a + 3] < 250 || genScaled.data[c + 3] < 250) continue;
        const d = [genScaled.data[c] - lieNative.data[a], genScaled.data[c + 1] - lieNative.data[a + 1], genScaled.data[c + 2] - lieNative.data[a + 2]];
        if (x < box.left - 3) bands.left.push(d);
        else if (x > box.right + 3) bands.right.push(d);
        else if (y < box.top - 3) bands.top.push(d);
        else if (y > box.bottom + 3) bands.bottom.push(d);
      }
    }
    const mean = (arr) => (arr.length ? arr.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]).map((v) => v / arr.length) : [0, 0, 0]);
    const bl = mean(bands.left);
    const br = mean(bands.right);
    const bt = mean(bands.top);
    const bb = mean(bands.bottom);
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const t = (y * N + x) * 4;
        const c = ((y + align.dy) * N + (x + align.dx)) * 4;
        if (genScaled.data[c + 3] < 250) continue;
        const u = (x - box.left) / (box.right - box.left);
        const v = (y - box.top) / (box.bottom - box.top);
        const dist = Math.min(x - box.left, box.right - x, y - box.top, box.bottom - y);
        const w = dist >= CONFIG.feather ? 1 : (dist + 1) / (CONFIG.feather + 1);
        for (let k = 0; k < 3; k += 1) {
          const corr = ((bl[k] * (1 - u) + br[k] * u) + (bt[k] * (1 - v) + bb[k] * v)) / 2;
          const value = Math.max(0, Math.min(255, genScaled.data[c + k] - corr));
          out[t + k] = Math.round(lieNative.data[t + k] * (1 - w) + value * w);
        }
        out[t + 3] = 255;
      }
    }
    perBox.push({
      bbox: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      bandOffsets: {
        left: bl.map((n) => +n.toFixed(2)), right: br.map((n) => +n.toFixed(2)),
        top: bt.map((n) => +n.toFixed(2)), bottom: bb.map((n) => +n.toFixed(2)),
      },
    });
  }

  // alpha 清理（沿用 v3/lie 的 8/248 口径 + 去小孤岛）
  let clearedLowAlpha = 0;
  let solidified = 0;
  for (let i = 0; i < N * CONFIG.native.height; i += 1) {
    const o = i * 4 + 3;
    const a = out[o];
    if (a !== 0 && a < CONFIG.alphaClearBelow) { out.fill(0, i * 4, i * 4 + 4); clearedLowAlpha += 1; }
    else if (a >= CONFIG.alphaSolidAt && a < 255) { out[o] = 255; solidified += 1; }
  }
  const native = { width: N, height: CONFIG.native.height, data: out };

  // 眼区外一致性：与 lie native 逐像素比对（这就是资产层保真的证据）
  let outsideDiff = 0;
  let outsideMaxDelta = 0;
  const inAny = (x, y) => boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  for (let y = 0; y < native.height; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (inAny(x, y)) continue;
      const o = (y * N + x) * 4;
      let d = 0;
      for (let k = 0; k < 4; k += 1) d = Math.max(d, Math.abs(out[o + k] - lieNative.data[o + k]));
      if (d > 0) outsideDiff += 1;
      if (d > outsideMaxDelta) outsideMaxDelta = d;
    }
  }
  if (outsideDiff !== 0) throw new Error('合成后眼区外出现 ' + outsideDiff + ' 个差异像素，拒绝出图');

  // 2× near先放大成母版
  const master = { width: N * CONFIG.masterScale, height: CONFIG.native.height * CONFIG.masterScale, data: Buffer.alloc(N * CONFIG.masterScale * CONFIG.native.height * CONFIG.masterScale * 4) };
  for (let y = 0; y < master.height; y += 1) {
    const sy = Math.floor(y / CONFIG.masterScale);
    for (let x = 0; x < master.width; x += 1) {
      const sx = Math.floor(x / CONFIG.masterScale);
      const s = (sy * N + sx) * 4;
      const t = (y * master.width + x) * 4;
      master.data[t] = out[s]; master.data[t + 1] = out[s + 1]; master.data[t + 2] = out[s + 2]; master.data[t + 3] = out[s + 3];
    }
  }

  const nativeBytes = encodePng(native);
  const masterBytes = encodePng(master);
  return {
    native, master, perBox, align,
    stats: {
      alphaCleanup: { clearedLowAlpha, solidified },
      outsideEyeDiffPixels: outsideDiff,
      outsideEyeMaxDelta: outsideMaxDelta,
      native: { bytes: nativeBytes.length, sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex') },
      master: { bytes: masterBytes.length, sha256: crypto.createHash('sha256').update(masterBytes).digest('hex') },
    },
    nativeBytes, masterBytes,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = buildSleep();
  fs.writeFileSync(path.join(root, CONFIG.outputs.native), result.nativeBytes);
  fs.writeFileSync(path.join(root, CONFIG.outputs.master), result.masterBytes);
  console.log(JSON.stringify({
    native: CONFIG.outputs.native, master: CONFIG.outputs.master,
    align: result.align, boxes: result.perBox, ...result.stats,
  }, null, 2));
}
