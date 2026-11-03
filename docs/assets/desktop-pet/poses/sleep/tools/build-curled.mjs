// 蜷睡帧构建：把生图直出结果归一化到 1536² native 画布，再 2× nearest 出母版。
// 与趴睡帧不同，蜷睡是重新生成的 —— 姿态轮廓本来就该不同，因此不能按 lie 的剪影对齐，
// 只能按「接触点必须落在墨迹上」来定标与定位（本脚本自己搜一遍并报告覆盖率）。
//
// 运行：node docs/assets/desktop-pet/poses/sleep/tools/build-curled.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const CONFIG = {
  native: { width: 1536, height: 1536 },
  masterScale: 2,
  alphaClearBelow: 8,
  alphaSolidAt: 248,
  minIslandArea: 4,
  generated: 'source/sleep_curled_generated.png',
  nativeOut: 'source/sleep_curled_native.png',
  masterOut: 'sleep_curled@2x.png',
  baseline: 1468,          // 与趴睡帧同一条落地线（sleep_neutral_native 的 bbox.bottom）
  baseNative: 'source/sleep_neutral_native.png',
  widthCandidates: [1150, 1125, 1100, 1075, 1050, 1025, 1000, 975, 950],
  leftCandidates: (() => { const a = []; for (let l = 270; l <= 400; l += 10) a.push(l); return a; })(),
  // 接触点（母版 3072 坐标）→ native 除以 2；蜷睡沿用趴姿口径
  contactPointsMaster: {
    foot: [2578, 2909],
    footImageLeft: [2489, 2909],
    footImageRight: [2666, 2909],
    belly: [1962, 2889],
    palmFront: [746, 2925],
    palmFrontImageRight: [1186, 2921],
  },
  contactRadius: 10,
};

const N = CONFIG.native.width;

function cleanupAlpha(img) {
  let clearedLowAlpha = 0;
  let solidified = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * 4 + 3;
    const a = img.data[o];
    if (a !== 0 && a < CONFIG.alphaClearBelow) { img.data.fill(0, i * 4, i * 4 + 4); clearedLowAlpha += 1; }
    else if (a >= CONFIG.alphaSolidAt && a < 255) { img.data[o] = 255; solidified += 1; }
  }
  return { clearedLowAlpha, solidified };
}

function bboxOf(img, minAlpha) {
  let left = img.width, top = img.height, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] < minAlpha) continue;
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom };
}

// 去小于 minIslandArea 的孤立不透明块（C2 要求）
function removeIslands(img, minArea) {
  const { width: W, height: H, data } = img;
  const seen = new Uint8Array(W * H);
  let removed = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const start = y * W + x;
      if (seen[start] || data[start * 4 + 3] === 0) continue;
      const stack = [start];
      seen[start] = 1;
      const cells = [];
      while (stack.length) {
        const cur = stack.pop();
        cells.push(cur);
        const cx = cur % W;
        const cy = (cur - cx) / W;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx; const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const next = ny * W + nx;
            if (seen[next] || data[next * 4 + 3] === 0) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (cells.length < minArea) {
        for (const c of cells) data.fill(0, c * 4, c * 4 + 4);
        removed += cells.length;
      }
    }
  }
  return removed;
}

// 预乘 alpha 的 box 重采样（与 build-sleep.mjs 同一口径，避免透明边缘发黑）
// srcBox 是源图里的墨迹框：只resample这一块，别从 (0,0) 取。
function resampleInto(src, srcBox, ox, oy, dw, dh, out) {
  const sw = srcBox.right - srcBox.left + 1;
  const sh = srcBox.bottom - srcBox.top + 1;
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
          const o = ((srcBox.top + yy) * src.width + (srcBox.left + xx)) * 4;
          const alpha = src.data[o + 3] / 255;
          r += src.data[o] * alpha;
          g += src.data[o + 1] * alpha;
          b += src.data[o + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      if (!n || a <= 0) continue;
      const t = ((oy + y) * N + (ox + x)) * 4;
      out[t] = Math.round(r / a);
      out[t + 1] = Math.round(g / a);
      out[t + 2] = Math.round(b / a);
      out[t + 3] = Math.round(255 * a / n);
    }
  }
}

function inkNear(img, cx, cy, radius) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (img.data[(y * img.width + x) * 4 + 3] > 128) return true;
    }
  }
  return false;
}

export function buildCurled() {
  const gen = readPng(path.join(root, CONFIG.generated));
  const genCleanup = cleanupAlpha(gen);
  const box = bboxOf(gen, 128);
  const inkW = box.right - box.left + 1;
  const inkH = box.bottom - box.top + 1;
  // 接触点：母版坐标 ÷2 → native
  const points = Object.entries(CONFIG.contactPointsMaster).map(([name, [x, y]]) => ({
    name, x: Math.round(x / CONFIG.masterScale), y: Math.round(y / CONFIG.masterScale),
  }));
  // 蜷睡是重新生成的姿态，按 lie 的剪影对齐根本不成立。
  // 定标依据：让「墨迹底部那一条带」正好盖住趴姿接触点的横向跨度，落地线对齐 baseline。
  const bandRows = Math.max(6, Math.round(inkH * 0.03));
  let bandMinX = gen.width;
  let bandMaxX = -1;
  for (let y = Math.max(0, box.bottom - bandRows); y <= box.bottom; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      if (gen.data[(y * gen.width + x) * 4 + 3] <= 128) continue;
      if (x < bandMinX) bandMinX = x;
      if (x > bandMaxX) bandMaxX = x;
    }
  }
  // 地位对齐：两帧共用一个 anchor，切帧时不能横向跳。
  // 实测趴睡帧的 alpha 质心在 native x=698；蜷睡帧按「墨迹质心对齐到 698」摆放（主理人方案 A）。
  const base = readPng(path.join(root, CONFIG.baseNative));
  let baseSum = 0;
  let baseN = 0;
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      if (base.data[(y * base.width + x) * 4 + 3] <= 128) continue;
      baseSum += x; baseN += 1;
    }
  }
  const baseCentroidX = baseSum / baseN;
  let genSum = 0;
  let genN = 0;
  for (let y = box.top; y <= box.bottom; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      if (gen.data[(y * gen.width + x) * 4 + 3] <= 128) continue;
      genSum += x; genN += 1;
    }
  }
  const genCentroidOffset = genSum / genN - box.left; // 质心在墨迹框内的横向偏移
  // 定标：尽量大但留够边距；定位：让墨迹质心落在趴睡帧质心
  let best = null;
  for (let inkTarget = 1450; inkTarget >= 1150; inkTarget -= 25) {
    const scale = inkTarget / inkW;
    const w = Math.round(inkW * scale);
    const h = Math.round(inkH * scale);
    if (w > N - 16 || h > N - 16) continue;
    const top = CONFIG.baseline - h;
    if (top < 8) continue;
    const want = Math.round(baseCentroidX - genCentroidOffset * scale);
    const left = Math.min(Math.max(want, 8), N - 8 - w);
    best = { w, h, left, top, scale: +scale.toFixed(4), wantedLeft: want, clamped: left !== want };
    break;
  }
  if (!best) throw new Error('没有找到能把蜷睡放进画布的定标方案');
  const out = Buffer.alloc(N * N * 4);
  resampleInto(gen, box, best.left, best.top, best.w, best.h, out);
  const native = { width: N, height: N, data: out };
  const cleanup1 = cleanupAlpha(native);
  const islandsRemoved = removeIslands(native, CONFIG.minIslandArea);
  const nativeBox = bboxOf(native, 1);
  // 母版 = native 2× 最近邻（C7 硬要求）
  const master = { width: N * CONFIG.masterScale, height: N * CONFIG.masterScale,
    data: Buffer.alloc(N * CONFIG.masterScale * N * CONFIG.masterScale * 4) };
  for (let y = 0; y < master.height; y += 1) {
    const sy = Math.floor(y / CONFIG.masterScale);
    for (let x = 0; x < master.width; x += 1) {
      const sx = Math.floor(x / CONFIG.masterScale);
      const s = (sy * N + sx) * 4;
      const t = (y * master.width + x) * 4;
      master.data[t] = native.data[s]; master.data[t + 1] = native.data[s + 1];
      master.data[t + 2] = native.data[s + 2]; master.data[t + 3] = native.data[s + 3];
    }
  }
  const nativeBytes = encodePng(native);
  const masterBytes = encodePng(master);
  // 质心/接地带实测（用于证明「切帧不横向跳」）
  const centroidOf = (img) => {
    let sx = 0;
    let n = 0;
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if (img.data[(y * img.width + x) * 4 + 3] <= 128) continue;
        sx += x; n += 1;
      }
    }
    return { x: +(sx / n).toFixed(1), n };
  };
  const groundBand = (img) => {
    const bottom = bboxOf(img, 128).bottom;
    let mn = img.width;
    let mx = -1;
    for (let y = bottom - 2; y <= bottom; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if (img.data[(y * img.width + x) * 4 + 3] <= 128) continue;
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
    }
    return { bottom, minX: mn, maxX: mx, centerX: +((mn + mx) / 2).toFixed(1) };
  };
  return {
    gen: { width: gen.width, height: gen.height, inkBox: box, inkW, inkH,
      aspect: +(inkW / inkH).toFixed(3), cleanup: genCleanup },
    placement: { ...best, scale: +(best.w / inkW).toFixed(4) },
    alignment: {
      baseCentroidX: +baseCentroidX.toFixed(1),
      curledCentroid: centroidOf(native),
      baseGroundBand: groundBand(base),
      curledGroundBand: groundBand(native),
    },
    contactCoverage: points.map((p) => ({ ...p, onInk: inkNear(native, p.x, p.y, CONFIG.contactRadius) })),
    native: { bbox: nativeBox, bytes: nativeBytes.length,
      sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex') },
    master: { bbox: bboxOf(master, 1), bytes: masterBytes.length,
      sha256: crypto.createHash('sha256').update(masterBytes).digest('hex') },
    alphaCleanup: cleanup1, islandsRemoved, nativeBytes, masterBytes,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const r = buildCurled();
  fs.writeFileSync(path.join(root, CONFIG.nativeOut), r.nativeBytes);
  fs.writeFileSync(path.join(root, CONFIG.masterOut), r.masterBytes);
  const { nativeBytes, masterBytes, ...rest } = r;
  console.log(JSON.stringify(rest, null, 2));
}
