// 小云酱（cloudling）基础帧构建：绿幕生成源 -> 干净 straight alpha -> 原生 256 画布 -> 2× nearest 母版。
//
// 为什么不在生成图里直接要「透明背景」：位图模型给不出可信 alpha，边上一律带灰绿脏边。
// 所以流程是「绿幕 -> 数学抠像 -> 反预乘 -> 去溢色 -> 原生分辨率重采样 -> 整数倍放大」，
// 每一步都可复算，产物是确定的像素，不是调出来的效果。
//
// 运行：node docs/assets/desktop-pet/companion/v1/tools/build-companion.mjs --source=<生成源.png>
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

export const CONTRACT = {
  canvas: { width: 512, height: 512 },
  anchor: { x: 256, y: 470 },
  nativeCanvas: { width: 256, height: 256 },
  masterScale: 2,
  // 目标母版可见宽度（182–260 区间取中上，视觉上"小一号"但不至于看不清）
  targetMasterWidth: 244,
  alphaClearThreshold: 8,
  alphaSolidThreshold: 248,
  minIslandAreaNative: 4,
  // 绿幕抠像：u = (g - max(r,b)) / keyGreenness
  matteLowU: 0.10,
  matteHighU: 0.62,
  gripOffsetRatio: 0.34,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Root = path.resolve(here, '..');

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(t) { return t * t * (3 - 2 * t); }

// 1) 绿幕抠像：按「绿色相对主导度」而不是 RGB 距离，奶白/粉/蓝都不会被误判
function keyGreen(img) {
  const { width: W, height: H, data } = img;
  // 采样四角 8×8 作为键色基准，避免整幅取平均被主体污染
  let kr = 0, kg = 0, kb = 0, n = 0;
  const patches = [[0, 0], [W - 8, 0], [0, H - 8], [W - 8, H - 8]];
  for (const [px, py] of patches) {
    for (let y = py; y < py + 8; y += 1) {
      for (let x = px; x < px + 8; x += 1) {
        const i = (y * W + x) * 4;
        kr += data[i]; kg += data[i + 1]; kb += data[i + 2]; n += 1;
      }
    }
  }
  kr /= n; kg /= n; kb /= n;
  const keyGreenness = Math.max(1, kg - Math.max(kr, kb));
  const out = Buffer.alloc(W * H * 4);
  let opaque = 0, partial = 0, clear = 0;
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const u = (g - Math.max(r, b)) / keyGreenness;
    const t = clamp01((u - CONTRACT.matteLowU) / (CONTRACT.matteHighU - CONTRACT.matteLowU));
    const a = 1 - smoothstep(t);
    if (a <= 0.002) { clear += 1; continue; }
    // 反预乘：观测色 C = a·F + (1-a)·K  =>  F = (C - (1-a)K) / a
    const inv = 1 / a;
    let fr = (r - (1 - a) * kr) * inv;
    let fg = (g - (1 - a) * kg) * inv;
    let fb = (b - (1 - a) * kb) * inv;
    // 去溢色：绿通道不得显著高于红/蓝（否则边缘发绿）
    const cap = Math.max(fr, fb) + 2;
    if (fg > cap) fg = cap;
    out[o] = Math.round(clamp0_255(fr));
    out[o + 1] = Math.round(clamp0_255(fg));
    out[o + 2] = Math.round(clamp0_255(fb));
    out[o + 3] = Math.round(a * 255);
    if (a >= 0.98) opaque += 1; else partial += 1;
  }
  return { image: { width: W, height: H, data: out }, key: { kr, kg, kb, keyGreenness }, stats: { opaque, partial, clear } };
}

function clamp0_255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// 可选水平镜像：设定图小图标把云朵发夹画在画面右上，若要与设定严格一致可开 --mirror
function mirrorImage(img) {
  const { width: W, height: H, data } = img;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = (y * W + (W - 1 - x)) * 4;
      const d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

// 2) 可见包围盒（以 alpha > 0 为可见）
function alphaBBox(img) {
  const { width: W, height: H, data } = img;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (data[(y * W + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// 3) 面积平均重采样（在预乘空间做，避免半透明边缘被拉黑/拉灰）
function resampleArea(img, bbox, dw, dh) {
  const { width: W, data } = img;
  const sx = bbox.width / dw;
  const sy = bbox.height / dh;
  const accR = new Float64Array(dw * dh);
  const accG = new Float64Array(dw * dh);
  const accB = new Float64Array(dw * dh);
  const accA = new Float64Array(dw * dh);
  const accArea = new Float64Array(dw * dh);
  for (let y = bbox.top; y <= bbox.bottom; y += 1) {
    const y0 = (y - bbox.top) / sy;
    const y1 = y0 + 1 / sy;
    for (let x = bbox.left; x <= bbox.right; x += 1) {
      const o = (y * W + x) * 4;
      const a = data[o + 3] / 255;
      const x0 = (x - bbox.left) / sx;
      const x1 = x0 + 1 / sx;
      for (let dy = Math.floor(y0); dy < Math.ceil(y1); dy += 1) {
        const oy = Math.min(dy + 1, y1) - Math.max(dy, y0);
        if (oy <= 0 || dy < 0 || dy >= dh) continue;
        for (let dx = Math.floor(x0); dx < Math.ceil(x1); dx += 1) {
          const ox = Math.min(dx + 1, x1) - Math.max(dx, x0);
          if (ox <= 0 || dx < 0 || dx >= dw) continue;
          const w = ox * oy;
          const d = dy * dw + dx;
          accR[d] += data[o] * a * w;
          accG[d] += data[o + 1] * a * w;
          accB[d] += data[o + 2] * a * w;
          accA[d] += a * w;
          accArea[d] += w;
        }
      }
    }
  }
  const out = Buffer.alloc(dw * dh * 4);
  for (let i = 0; i < dw * dh; i += 1) {
    const o = i * 4;
    const alpha = accA[i] / accArea[i];
    if (alpha <= 0.0005) continue;
    out[o] = Math.round(clamp0_255(accR[i] / accA[i]));
    out[o + 1] = Math.round(clamp0_255(accG[i] / accA[i]));
    out[o + 2] = Math.round(clamp0_255(accB[i] / accA[i]));
    out[o + 3] = Math.round(alpha * 255);
  }
  return { width: dw, height: dh, data: out };
}

// 4) 连通域清理：小于阈值的孤立像素块直接删掉（C2 的"无小碎块"）
function removeSmallIslands(img, minArea, connect8 = true) {
  const { width: W, height: H, data } = img;
  const seen = new Uint8Array(W * H);
  const stack = [];
  let removedComponents = 0, removedPixels = 0;
  for (let start = 0; start < W * H; start += 1) {
    if (seen[start] || data[start * 4 + 3] === 0) continue;
    const comp = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      comp.push(idx);
      const x = idx % W;
      const y = (idx - x) / W;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!connect8 && dx !== 0 && dy !== 0) continue;
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nIdx = ny * W + nx;
          if (seen[nIdx] || data[nIdx * 4 + 3] === 0) continue;
          seen[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    if (comp.length < minArea) {
      for (const idx of comp) data[idx * 4 + 3] = 0;
      removedComponents += 1;
      removedPixels += comp.length;
    }
  }
  return { removedComponents, removedPixels };
}

// 5) alpha 清理：低 alpha 归零、内侧实心化（沿用 v3 的 8/248 阈值口径）
function cleanupAlpha(img, lowThreshold, solidThreshold) {
  const { width: W, height: H, data } = img;
  let cleared = 0, solidified = 0;
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4 + 3;
    const a = data[o];
    if (a === 0) continue;
    if (a < lowThreshold) { data[o] = 0; cleared += 1; continue; }
    // 只把"四周都没有软边"的内部像素钉到 255，保留真正的外缘抗锯齿
    const x = i % W;
    const y = (i - x) / W;
    if (a >= solidThreshold) {
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (data[(ny * W + nx) * 4 + 3] < solidThreshold) { edge = true; break; }
        }
      }
      if (!edge) { data[o] = 255; solidified += 1; }
    }
  }
  return { cleared, solidified };
}

// 6) 整数倍 nearest 放大（母版 = 原生 × 2，块内必一致）
function upscaleNearest(img, factor) {
  const { width: W, height: H, data } = img;
  const dw = W * factor, dh = H * factor;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.floor(x / factor);
      const s = (sy * W + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: dw, height: dh, data: out };
}

export function buildCompanion(sourceFile, options = {}) {
  const raw = readPng(sourceFile);
  const keyed = keyGreen(raw);
  const mirrored = options.mirror ? mirrorImage(keyed.image) : keyed.image;
  const tight = alphaBBox(mirrored);

  // 目标母版尺寸：宽固定 244，高按内容比例推导并取偶数（保证 2× 母版块对齐）
  const aspect = tight.width / tight.height;
  const masterWidth = Math.round(CONTRACT.targetMasterWidth / 2) * 2;
  const masterHeight = Math.round(masterWidth / aspect / 2) * 2;
  const nativeWidth = masterWidth / CONTRACT.masterScale;
  const nativeHeight = masterHeight / CONTRACT.masterScale;

  const native = resampleArea(mirrored, tight, nativeWidth, nativeHeight);
  const islands = removeSmallIslands(native, CONTRACT.minIslandAreaNative);
  const cleaned = cleanupAlpha(native, CONTRACT.alphaClearThreshold, CONTRACT.alphaSolidThreshold);
  const nativeBox = alphaBBox(native);
  const master = upscaleNearest(native, CONTRACT.masterScale);

  const canvas = { width: CONTRACT.canvas.width, height: CONTRACT.canvas.height, data: Buffer.alloc(CONTRACT.canvas.width * CONTRACT.canvas.height * 4) };
  // 2× 母版必须对齐画布网格：left/top 都取偶数，否则整画布 /2 降采样会跨块取样。
  // 对齐后最低一行必然落在奇数行（top + 2h − 1），取 anchor.y − 1 = 469，
  // 即该行的下边缘正好压在锚点 y=470 的地面线上（偏差 1px，在 ±2px 容差内）。
  const left = CONTRACT.anchor.x - master.width / 2;
  const top = CONTRACT.anchor.y - master.height;
  if (!Number.isInteger(left) || left % 2 !== 0 || top % 2 !== 0) {
    throw new Error(`2× 母版未对齐画布网格：left=${left} top=${top}（要求均为偶数整数）`);
  }
  for (let y = 0; y < master.height; y += 1) {
    for (let x = 0; x < master.width; x += 1) {
      const s = (y * master.width + x) * 4;
      if (master.data[s + 3] === 0) continue;
      const dx = left + x, dy = top + y;
      if (dx < 0 || dy < 0 || dx >= canvas.width || dy >= canvas.height) throw new Error(`合成越界 (${dx},${dy})`);
      const d = (dy * canvas.width + dx) * 4;
      canvas.data[d] = master.data[s];
      canvas.data[d + 1] = master.data[s + 1];
      canvas.data[d + 2] = master.data[s + 2];
      canvas.data[d + 3] = master.data[s + 3];
    }
  }

  const box = alphaBBox(canvas);
  const gripPoint = {
    x: box.left + Math.round(box.width / 2),
    y: box.top + Math.round(box.height * CONTRACT.gripOffsetRatio),
  };
  return {
    image: canvas,
    report: {
      source: { width: raw.width, height: raw.height },
      key: keyed.key,
      matte: keyed.stats,
      sourceContentBbox: tight,
      nativeSize: { width: nativeWidth, height: nativeHeight },
      nativeContentBbox: nativeBox,
      islandsRemoved: islands,
      alphaCleanup: cleaned,
      canvas: CONTRACT.canvas,
      bbox: box,
      anchor: CONTRACT.anchor,
      gripPoint,
      margins: {
        left: box.left,
        top: box.top,
        right: CONTRACT.canvas.width - 1 - box.right,
        bottom: CONTRACT.canvas.height - 1 - box.bottom,
      },
      bottomDeviation: Math.abs(box.bottom - CONTRACT.anchor.y),
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--source='));
  if (!arg) throw new Error('缺少 --source=<生成源 png>');
  const source = path.resolve(arg.slice('--source='.length));
  const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
  const target = outArg ? path.resolve(outArg.slice('--out='.length)) : path.join(v1Root, 'cloudling_neutral.png');
  const { image, report } = buildCompanion(source, { mirror: process.argv.includes('--mirror') });
  const bytes = encodePng(image);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(JSON.stringify({
    output: target,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    ...report,
  }, null, 2));
}
