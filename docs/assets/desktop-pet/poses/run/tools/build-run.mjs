// run 批次构建：6 张左向直出图 → native(1536²) → 2× nearest 母版(3072²)。
// 与 walk 口径一致（§4「按 bbox 落座」修订版），只多一条：腾空帧整体上抬 airborneGapNative，使双脚都离开地面线。
//   1) 所有缩放/定位只在 native 层做，母版必须是 native 的 2× 最近邻（C7）；
//   2) 6 帧共用同一缩放系数（按墨迹高度中位数映射到站姿墨迹高 1377 native px），避免蹲伏/团身帧被单独放大；
//   3) 水平定位用躯干质心（蓝裙簇）对齐画布中线，不用 bbox 中心（尾巴会把 bbox 中心拉偏）；
//   4) 支撑帧最低墨迹落在 native y=1453（= 锚点 2908 / 2 减 1）；腾空帧（l4）最低墨迹再上抬 48 native px。
// 运行：node docs/assets/desktop-pet/poses/run/tools/build-run.mjs
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
  baselineNative: 1454,
  lastInkRowNative: 1453,
  // 躯干质心固定的 native x。walk 用的是画布中线 768，run 不能直接照抄：run 的尾巴向后甩得更远，
  // 实测躯干质心到墨迹右缘最远 730 gen px，按 1.122 缩放后 819 native px > 距中线可用的 768 px，
  // 若仍对齐 768 会把尾巴顶出画布右缘 52 px。改为固定 700 后：右缘最坏 1519（留白 16px）、左缘最坏 309。
  torsoAnchorXNative: 700,
  standingInkHeightNative: 1377,
  footBandNative: 90,
  airborneGapNative: 48,
  airborneFrames: ['l4'],
  frames: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
  facingOf: { l1: -1, l2: -1, l3: -1, l4: -1, l5: -1, l6: -1 },
};

const N = CONFIG.native.width;

function bboxOf(img, minA = 1) {
  let left = img.width; let top = img.height; let right = -1; let bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] < minA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function cleanupAlpha(img) {
  let cleared = 0; let solidified = 0;
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
      const stack = [start]; seen[start] = 1; const cells = [];
      while (stack.length) {
        const cur = stack.pop(); cells.push(cur);
        const cx = cur % W; const cy = (cur - cx) / W;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx; const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const next = ny * W + nx;
            if (seen[next] || data[next * 4 + 3] === 0) continue;
            seen[next] = 1; stack.push(next);
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
  const h = box.height;
  let sx = 0; let n = 0;
  for (let y = box.top + Math.round(h * 0.45); y <= box.top + Math.round(h * 0.85); y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
      if (b - r >= 45 && b >= 150 && g < b - 20) { sx += x; n += 1; }
    }
  }
  return n > 500 ? sx / n : (box.left + box.right) / 2;
}

function resampleInto(src, srcBox, ox, oy, dw, dh, out) {
  // 硬边界：越界时直接报错，绝不允许写到 out 之外（越界会环绕到别的行，产生肉眼看不到的脏点）。

  if (ox < 0 || oy < 0 || ox + dw > 1536 || oy + dh > 1536) {
    throw new Error('resampleInto 越界: ox=' + ox + ' oy=' + oy + ' dw=' + dw + ' dh=' + dh);
  }
  const sw = srcBox.right - srcBox.left + 1;
  const sh = srcBox.bottom - srcBox.top + 1;
  const sx = sw / dw; const sy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(sh, Math.ceil((y + 1) * sy));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(sw, Math.ceil((x + 1) * sx));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const o = ((srcBox.top + yy) * src.width + (srcBox.left + xx)) * 4;
          const al = src.data[o + 3] / 255;
          r += src.data[o] * al; g += src.data[o + 1] * al; b += src.data[o + 2] * al;
          a += al; n += 1;
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

function upscaleNearest2(img) {
  const out = { width: img.width * 2, height: img.height * 2, data: Buffer.alloc(img.width * 2 * img.height * 2 * 4) };
  for (let y = 0; y < out.height; y += 1) {
    const sy = y >> 1;
    for (let x = 0; x < out.width; x += 1) {
      const s = (sy * img.width + (x >> 1)) * 4;
      const t = (y * out.width + x) * 4;
      out.data[t] = img.data[s]; out.data[t + 1] = img.data[s + 1];
      out.data[t + 2] = img.data[s + 2]; out.data[t + 3] = img.data[s + 3];
    }
  }
  return out;
}

// 底部带内的脚部段（native 层）。contactY = 该段内最低墨迹 y（相对底线越接近说明越贴地）。
export function footRuns(img, bottom, band) {
  const b = bboxOf(img, 128);
  const spans = [];
  let start = -1;
  for (let x = b.left; x <= b.right; x += 1) {
    let on = false;
    for (let y = Math.max(0, bottom - band); y <= bottom; y += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] > 128) { on = true; break; }
    }
    if (on && start < 0) start = x;
    if (!on && start >= 0) { spans.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) spans.push([start, b.right]);
  return spans.map(([left, right]) => {
    let contactY = -1;
    for (let x = left; x <= right; x += 1) {
      for (let y = bottom; y >= Math.max(0, bottom - band); y -= 1) {
        if (img.data[(y * img.width + x) * 4 + 3] > 128) { if (y > contactY) contactY = y; break; }
      }
    }
    return { left, right, width: right - left + 1, centerX: (left + right) / 2, contactY };
  }).sort((p, q) => q.width - p.width);
}

export function buildRun() {
  const gen = CONFIG.frames.map((id) => {
    const img = readPng(path.join(root, 'source/run_' + id + '_generated.png'));
    const cleanup = cleanupAlpha(img);
    const box = bboxOf(img, 8);
    return { id, img, box, cleanup };
  });
  const heights = gen.map((g) => g.box.height).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];
  const scale = CONFIG.standingInkHeightNative / medianH;
  const report = [];
  for (const g of gen) {
    const dw = Math.round(g.box.width * scale);
    const dh = Math.round(g.box.height * scale);
    const torso = torsoCentroidX(g.img, g.box);
    const ox = Math.round(CONFIG.torsoAnchorXNative - (torso - g.box.left) * scale);
    const airborne = CONFIG.airborneFrames.includes(g.id);
    const lowestInkY = airborne ? CONFIG.lastInkRowNative - CONFIG.airborneGapNative : CONFIG.lastInkRowNative;
    const oy = lowestInkY - (dh - 1);
    const out = Buffer.alloc(N * N * 4);
    resampleInto(g.img, g.box, ox, oy, dw, dh, out);
    const nativeImg = { width: N, height: N, data: out };
    const cleanup2 = cleanupAlpha(nativeImg);
    const islands = removeIslands(nativeImg, CONFIG.minIslandArea);
    const master = upscaleNearest2(nativeImg);
    const nativeBytes = encodePng(nativeImg);
    const masterBytes = encodePng(master);
    fs.writeFileSync(path.join(root, 'source/run_' + g.id + '_native.png'), nativeBytes);
    fs.writeFileSync(path.join(root, 'run_' + g.id + '@2x.png'), masterBytes);
    const nBox = bboxOf(nativeImg, 1);
    const runs = footRuns(nativeImg, nBox.bottom, CONFIG.footBandNative);
    report.push({
      id: g.id,
      airborne,
      generated: { width: g.img.width, height: g.img.height, inkBox: g.box, cleanup: g.cleanup },
      place: { scale: +scale.toFixed(6), dw, dh, ox, oy, lowestInkY, torsoGenX: +torso.toFixed(1) },
      native: { bbox: nBox, bytes: nativeBytes.length, sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex'),
        cleanup: cleanup2, islandsRemoved: islands },
      master: { bbox: bboxOf(master, 1), bytes: masterBytes.length,
        sha256: crypto.createHash('sha256').update(masterBytes).digest('hex') },
      footRuns: runs.map((r) => ({ left: r.left, right: r.right, width: r.width, centerX: +r.centerX.toFixed(1), contactY: r.contactY })),
    });
  }
  return { scale: +scale.toFixed(6), medianInkHeight: medianH, frames: report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const r = buildRun();
  const total = r.frames.reduce((s, f) => s + f.master.bytes, 0);
  console.log('scale=' + r.scale + ' medianInk=' + r.medianInkHeight);
  for (const f of r.frames) {
    console.log(f.id, f.airborne ? 'AIRBORNE' : 'support ', 'nativeBottom=' + f.native.bbox.bottom,
      'master=' + f.master.bytes, 'feet=' + f.footRuns.map((x) => x.centerX + '@' + x.contactY + '(w' + x.width + ')').join(' '));
  }
  console.log('TOTAL=' + total + ' (' + (total / 1048576).toFixed(2) + 'MB) budget=' + (CONFIG.frames.length * 1.65).toFixed(2) + 'MB');
}


