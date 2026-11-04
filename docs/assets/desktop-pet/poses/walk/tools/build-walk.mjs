// walk 批次构建：8 帧直出图 → native(1536²) → 2× nearest 母版(3072²)。
// 关键约束：
//   1) 一切缩放/定位只在 native 层做，母版必须是 native 的 2× 最近邻（C7）；
//   2) 8 帧用**同一个缩放系数**（按 8 帧墨迹高度中位数映射到站姿高度），否则蹲伏帧会被放大成"忽高忽低"；
//   3) 水平定位用**躯干质心（蓝裙簇）对齐画布中线**，不用 bbox 中心——尾巴偏在身后会把 bbox 中心拉偏，
//      用 bbox 中心对齐会让角色每帧横向抖动；
//   4) 落地线 y=1454（native）= 2908（母版），与站姿锚点同一基线。
//
// 运行：node docs/assets/desktop-pet/poses/walk/tools/build-walk.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const CONFIG = {
  canvas: { width: 3072, height: 3072 },
  native: { width: 1536, height: 1536 },
  masterScale: 2,
  alphaClearBelow: 8,
  alphaSolidAt: 248,
  minIslandArea: 4,
  baselineNative: 1454,      // 站姿系脚底基线（母版 y=2908）
  centerXNative: 768,        // 画布水平中线（母版 x=1536）
  standingInkHeightNative: 1377, // = v3/front-standing.png 墨迹高 2754 / 2
  bandNative: 40,             // 判脚用的底部带高（native px）
  frames: ['l1', 'l2', 'l3', 'l4', 'r1', 'r2', 'r3', 'r4'],
  facingOf: { l1: -1, l2: -1, l3: -1, l4: -1, r1: 1, r2: 1, r3: 1, r4: 1 },
};

const N = CONFIG.native.width;

function bboxOf(img, minA = 1) {
  let left = img.width, top = img.height, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] < minA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom };
}

function cleanupAlpha(img) {
  let cleared = 0;
  let solidified = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const o = i * 4 + 3;
    const a = img.data[o];
    if (a !== 0 && a < CONFIG.alphaClearBelow) { img.data.fill(0, i * 4, i * 4 + 4); cleared += 1; }
    else if (a >= CONFIG.alphaSolidAt && a < 255) { img.data[o] = 255; solidified += 1; }
  }
  return { cleared, solidified };
}

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
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const next = ny * W + nx;
            if (seen[next] || data[next * 4 + 3] === 0) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (cells.length < minArea) { for (const c of cells) data.fill(0, c * 4, c * 4 + 4); removed += cells.length; }
    }
  }
  return removed;
}

// 躯干质心：蓝裙簇（饱和蓝）在墨迹高度 45%~85% 的中段
function torsoCentroidX(img, box) {
  const H = box.bottom - box.top;
  let sx = 0;
  let n = 0;
  for (let y = box.top + Math.round(H * 0.45); y <= box.top + Math.round(H * 0.85); y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o];
      const g = img.data[o + 1];
      const b = img.data[o + 2];
      if (b - r >= 45 && b >= 150 && g < b - 20) { sx += x; n += 1; }
    }
  }
  return n > 500 ? { x: sx / n, n } : null;
}

// 预乘 alpha 的 box 重采样（源框 → 目标位置）
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
          const al = src.data[o + 3] / 255;
          r += src.data[o] * al;
          g += src.data[o + 1] * al;
          b += src.data[o + 2] * al;
          a += al;
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
// __P2__
function upscaleNearest2(img) {
  const out = { width: img.width * 2, height: img.height * 2, data: Buffer.alloc(img.width * 2 * img.height * 2 * 4) };
  for (let y = 0; y < out.height; y += 1) {
    const sy = y >> 1;
    for (let x = 0; x < out.width; x += 1) {
      const s = (sy * img.width + (x >> 1)) * 4;
      const t = (y * out.width + x) * 4;
      out.data[t] = img.data[s];
      out.data[t + 1] = img.data[s + 1];
      out.data[t + 2] = img.data[s + 2];
      out.data[t + 3] = img.data[s + 3];
    }
  }
  return out;
}

// 底部扫描带内的脚部连通段（native 层）。返回每段的 x 范围、宽度、中心与最低墨迹 y。
// band 取 40 native px（≈墨迹高的 3%）：够把抬起几像素的后脚也纳进来，再由 minY 判断是否真正着地。
export function footRuns(img, bottom, band) {
  const b = bboxOf(img, 128);
  const runs = [];
  let start = -1;
  for (let x = b.left; x <= b.right; x += 1) {
    let on = false;
    for (let y = Math.max(0, bottom - band); y <= bottom; y += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] > 128) { on = true; break; }
    }
    if (on && start < 0) start = x;
    if (!on && start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, b.right]);
  return runs.map(([left, right]) => {
    // contactY = 该段内「最低墨迹 y」的最大值（即真正贴地的那个点）。
    // 注意别写成 min：min 会取到扫描带上沿，无法区分「着地」与「抬脚」。
    let contactY = -1;
    for (let x = left; x <= right; x += 1) {
      for (let y = bottom; y >= Math.max(0, bottom - band); y -= 1) {
        if (img.data[(y * img.width + x) * 4 + 3] > 128) { if (y > contactY) contactY = y; break; }
      }
    }
    return { left, right, width: right - left + 1, center: (left + right) / 2, contactY, inContact: contactY >= bottom - 3 };
  }).sort((p, q) => q.width - p.width);
}

export function buildWalk() {
  const gen = CONFIG.frames.map((id) => {
    const img = readPng(path.join(root, 'source/walk_' + id + '_generated.png'));
    const cleanup = cleanupAlpha(img);
    const box = bboxOf(img, 8);
    return { id, img, box, cleanup };
  });
  const heights = gen.map((g) => g.box.bottom - g.box.top + 1).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];
  const scale = CONFIG.standingInkHeightNative / medianH;
  const report = [];
  for (const g of gen) {
    const inkH = g.box.bottom - g.box.top + 1;
    const dw = Math.round((g.box.right - g.box.left + 1) * scale);
    const dh = Math.round(inkH * scale);
    const torso = torsoCentroidX(g.img, g.box);
    const anchorX = torso ? torso.x : (g.box.left + g.box.right) / 2;
    const ox = Math.round(CONFIG.centerXNative - (anchorX - g.box.left) * scale);
    const oy = CONFIG.baselineNative - dh;
    const out = Buffer.alloc(N * N * 4);
    resampleInto(g.img, g.box, ox, oy, dw, dh, out);
    const nativeImg = { width: N, height: N, data: out };
    const cleanup2 = cleanupAlpha(nativeImg);
    const islands = removeIslands(nativeImg, CONFIG.minIslandArea);
    const master = upscaleNearest2(nativeImg);
    const nativeBytes = encodePng(nativeImg);
    const masterBytes = encodePng(master);
    fs.writeFileSync(path.join(root, 'source/walk_' + g.id + '_native.png'), nativeBytes);
    fs.writeFileSync(path.join(root, 'walk_' + g.id + '@2x.png'), masterBytes);
    const nBox = bboxOf(nativeImg, 1);
    const runs = footRuns(nativeImg, nBox.bottom, CONFIG.bandNative);
    const facing = CONFIG.facingOf[g.id];
    const torsoN = torso ? (ox + (torso.x - g.box.left) * scale) : null;
    const planted = runs.find((r) => r.inContact) || runs[0];
    const other = runs.find((r) => r !== planted) || null;
    const plantedFwd = planted && torsoN !== null ? ((planted.center - torsoN) * facing) : null;
    report.push({
      id: g.id,
      generated: { width: g.img.width, height: g.img.height, inkBox: g.box,
        inkW: g.box.right - g.box.left + 1, inkH, cleanup: g.cleanup },
      place: { scale: +scale.toFixed(4), dw, dh, ox, oy, torsoGenX: torso ? +torso.x.toFixed(1) : null,
        torsoNativeX: torsoN === null ? null : +torsoN.toFixed(1) },
      native: { bbox: nBox, bytes: nativeBytes.length,
        sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex'), cleanup: cleanup2, islandsRemoved: islands },
      master: { bbox: bboxOf(master, 1), bytes: masterBytes.length,
        sha256: crypto.createHash('sha256').update(masterBytes).digest('hex') },
      footRuns: runs.map((r) => ({ left: r.left, right: r.right, width: r.width, center: +r.center.toFixed(1), contactY: r.contactY, inContact: r.inContact })),
      plantedCenterNative: planted ? +planted.center.toFixed(1) : null,
      otherFootCenterNative: other ? +other.center.toFixed(1) : null,
      facing,
      plantedForwardness: plantedFwd === null ? null : Math.round(plantedFwd),
      plantedPhase: plantedFwd === null ? null : (plantedFwd > 0 ? 'front' : 'rear'),
      nativeBytes, masterBytes,
    });
  }
  return { scale: +scale.toFixed(6), medianInkHeight: medianH, frames: report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const r = buildWalk();
  const printed = {
    scale: r.scale, medianInkHeight: r.medianInkHeight,
    frames: r.frames.map((f) => ({
      id: f.id, place: f.place, nativeBbox: f.native.bbox, masterBbox: f.master.bbox,
      masterBytes: f.master.bytes, nativeBytes: f.native.bytes,
      nativeSha: f.native.sha256.slice(0, 16), masterSha: f.master.sha256.slice(0, 16),
      footRuns: f.footRuns, plantedPhase: f.plantedPhase, plantedForwardness: f.plantedForwardness,
      plantedCenterNative: f.plantedCenterNative, otherFootCenterNative: f.otherFootCenterNative,
      islandsRemoved: f.native.islandsRemoved, cleanup: f.native.cleanup,
    })),
  };
  console.log(JSON.stringify(printed, null, 1));
  const total = r.frames.reduce((s, f) => s + f.master.bytes, 0);
  console.error('MASTER_TOTAL=' + total + ' (' + (total / 1048576).toFixed(2) + 'MB)');
}
// __END__
