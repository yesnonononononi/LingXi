// jump 批次构建：5 张左向直出图 → native(1536²) → 2× nearest 母版(3072²)。
// 与 walk/run 口径一致（§4「按 bbox 落座」），多两条：
//   1) 缩放系数**固定沿用 run 左向的 1.122249**：5 帧全是蹲伏/腾空姿态，用 jump 自身墨迹高度中位数
//      会把角色整体放大 1.7%（中位数 1207 vs run 的 1227 gen px），跨批换动作时角色会忽大忽小；
//   2) 腾空帧靠**整幅上移**产生 airborneGap（纯平移，不改任何像素的比例），上移量 = 1453 − gap。
// 运行：node docs/assets/desktop-pet/poses/jump/tools/build-jump.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';
import { bboxOf, clearDirtyNeutralGray, INK_ALPHA_MIN, ANY_ALPHA_MIN, SOLID_ALPHA } from './ink.mjs';
import { irisBlob, headCentroid, IRIS_MIN_AREA, IRIS_MIN_FILL } from './iris.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const CONFIG = {
  canvas: { width: 3072, height: 3072 },
  native: { width: 1536, height: 1536 },
  masterScale: 2,
  // alpha 阈值全部取自 tools/ink.mjs（与 check 同一出处，避免口径漂移）
  alphaClearBelow: INK_ALPHA_MIN,
  alphaSolidAt: SOLID_ALPHA,
  minIslandArea: 4,
  baselineNative: 1454,
  lastInkRowNative: 1453,
  // 躯干质心固定的 native x。jump 是左向（尾巴甩在画面右侧），与 run 左向同一套布局，取 700。
  // 实测 5 帧「躯干→尾端」最大 758 native、「躯干→面部」最大 531，700 时右缘 1458（留白 78）、左缘 169（留白 169）。
  torsoAnchorXNative: 700,
  // 固定缩放：run 左向交付时用的系数（1377 / 1227）。理由见文件头第 1 条。
  uniformScale: 1.122249,
  footBandNative: 90,
  // 每帧「最低墨迹应落在的 native y」。1453 − gap，纯平移，不做任何缩放。
  // gap 的取值不能只看"脚离地多少"，还要保证**头顶（墨迹上沿）走一条连贯的上抛弧线**：
  // 若是 70/132/64，ascend 的头顶(y=39) 会比 apex(y=57) 还高——因为 apex 收腿使墨迹更矮，看起来像"最高点反而更低"。
  // 取 76/170/64 后头顶 y = 78 → 34 → 20 → 35 → 74，是单调上抛再回落。
  /**
   * 注意：画布 1536 高、角色墨迹 1376 高、脚踩地面线 1453 时头顶只剩 78px 余量，
   * 所以"整体上移"最多约 58 native px（≈4.4 display px）。跳跃感由「双脚离地 170 native + 收腿」承担，
   * 不是靠把整个人物往上顶（那样会顶出画布）。详见 README §2.3。
   */
  lowestInkY: {
    anticipate: 1453,
    ascend: 1377,   // gap 76
    apex: 1283,     // gap 170（≥120，且是 run 腾空帧 48 的 3.5 倍）
    descend: 1389,  // gap 64
    land: 1453,
  },
  airborneFrames: ['ascend', 'apex', 'descend'],
  // C2c 唯一真缺陷的修补范围：只清理点名的帧（descend 实测 3.54% > 2%）。
  // 其余 4 帧本来就 <=1.30%，一律不碰，保证「其余帧指标不变」。
  dirtyEdgeCleanFrames: ['descend'],
  frames: ['anticipate', 'ascend', 'apex', 'descend', 'land'],
  facingOf: { anticipate: -1, ascend: -1, apex: -1, descend: -1, land: -1 },
  // 右向 5 帧（本轮补齐）：与左向共用同一套直出→native→母版流程与同一缩放系数，
  // 只改三处：① 躯干质心固定到 native x=836（=1536−700 严格镜像，见 manifest.bodyAnchor.byFacing["+1"]）；
  // ② 每帧 lowestInkY 与左向**同相位**完全一致（相位几何左右对齐，避免左右动作一高一低）；
  // ③ 帧 id 加 r_ 前缀（文件名因此自动变成 jump_r_<phase>@2x.png / source/jump_r_<phase>_native.png）。
  rightPrefix: 'r_',
  torsoAnchorXNativeRight: 836,
  // 右向帧的 C2c 中性灰脏边净化名单（按实测决定，为空表示一帧都不需要净化）。
  dirtyEdgeCleanRight: [],
};

const N = CONFIG.native.width;


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
  return n ? sx / n : (box.left + box.right) / 2;
}

function resampleInto(src, srcBox, ox, oy, dw, dh, out) {
  // 硬边界：越界直接报错（越界会环绕到别的行，产生肉眼看不到的脏点）
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

// 落座校正：整幅上下平移 dy 行（native 层）。alpha 清理可能抹掉最后一行，
// 平移后每帧底部精确落在 lowestInkY，gap 才可复算。
function translateY(img, dy) {
  if (!dy) return;
  const { width: W, height: H, data } = img;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const sy = y - dy;
    if (sy < 0 || sy >= H) continue;
    for (let x = 0; x < W; x += 1) {
      const s = (sy * W + x) * 4; const t = (y * W + x) * 4;
      out[t] = data[s]; out[t + 1] = data[s + 1]; out[t + 2] = data[s + 2]; out[t + 3] = data[s + 3];
    }
  }
  out.copy(data);
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

// 底部带内的脚部段（native 层）。contactY = 该段内最低墨迹 y。
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

/**
 * 本批要构建的帧规格（左向 + 右向），供 build 与「只构建某个朝向」的增量调用共用。
 *
 * 每帧只声明 4 件与几何有关的事实：id（决定文件名）、相位（决定 gap）、朝向、躯干锚点 x。
 * gap 与锚点以外的所有编辑（缩放、alpha 清理、孤立块、2× nearest）对左右向完全同口径。
 *
 * @param {number|null} facingFilter -1 / 1 只构建该朝向；null 构建全部
 * @returns {Array<{id:string,phase:string,facing:number,torsoAnchorX:number,lowestInkY:number,airborne:boolean,dirtyEdgeClean:boolean}>}
 */
export function frameSpecs(facingFilter = null) {
  const specs = [];
  for (const phase of CONFIG.frames) {
    specs.push({
      id: phase, phase, facing: -1,
      torsoAnchorX: CONFIG.torsoAnchorXNative,
      lowestInkY: CONFIG.lowestInkY[phase],
      airborne: CONFIG.airborneFrames.includes(phase),
      dirtyEdgeClean: CONFIG.dirtyEdgeCleanFrames.includes(phase),
    });
  }
  for (const phase of CONFIG.frames) {
    const id = CONFIG.rightPrefix + phase;
    specs.push({
      id, phase, facing: 1,
      torsoAnchorX: CONFIG.torsoAnchorXNativeRight,
      lowestInkY: CONFIG.lowestInkY[phase],
      airborne: CONFIG.airborneFrames.includes(phase),
      dirtyEdgeClean: CONFIG.dirtyEdgeCleanRight.includes(id),
    });
  }
  return facingFilter === null ? specs : specs.filter((s) => s.facing === facingFilter);
}

export function buildJump(facingFilter = null) {
  const scale = CONFIG.uniformScale;
  const report = [];
  for (const spec of frameSpecs(facingFilter)) {
    const id = spec.id;
    const sourcePath = path.join(root, 'source/jump_' + id + '_generated.png');
    const sourceBytes = fs.readFileSync(sourcePath);
    const img = readPng(sourcePath);
    // 直出图的两种口径必须先量：cleanupAlpha 会就地改写 img（alpha<8 清零）。
    const sourceInkBox = bboxOf(img, INK_ALPHA_MIN);
    const sourceAlphaExtent = bboxOf(img, ANY_ALPHA_MIN);
    const cleanup = cleanupAlpha(img);
    const box = bboxOf(img, INK_ALPHA_MIN);
    const dw = Math.round(box.width * scale);
    const dh = Math.round(box.height * scale);
    const torso = torsoCentroidX(img, box);
    const ox = Math.round(spec.torsoAnchorX - (torso - box.left) * scale);
    const lowestInkY = spec.lowestInkY;
    const oy = lowestInkY - (dh - 1);
    const out = Buffer.alloc(N * N * 4);
    resampleInto(img, box, ox, oy, dw, dh, out);
    const nativeImg = { width: N, height: N, data: out };
    const cleanup2 = cleanupAlpha(nativeImg);
    // 半透明中性灰脏边净化：只在 dirtyEdgeCleanFrames 里的帧执行（见 CONFIG 注释）。
    // 口径与 C2c 度量同源（isDirtyNeutralGray），只把 alpha 在 [INK_ALPHA_MIN, SOLID_ALPHA) 的中性灰暗像素清零。
    const dirtyEdgeCleared = spec.dirtyEdgeClean ? clearDirtyNeutralGray(nativeImg) : 0;
    const islands = removeIslands(nativeImg, CONFIG.minIslandArea);
    const seatDelta = lowestInkY - bboxOf(nativeImg, ANY_ALPHA_MIN).bottom;
    translateY(nativeImg, seatDelta);
    const master = upscaleNearest2(nativeImg);
    const nativeBytes = encodePng(nativeImg);
    const masterBytes = encodePng(master);
    fs.writeFileSync(path.join(root, 'source/jump_' + id + '_native.png'), nativeBytes);
    fs.writeFileSync(path.join(root, 'jump_' + id + '@2x.png'), masterBytes);
    const nBox = bboxOf(nativeImg, ANY_ALPHA_MIN);
    // 朝向实测：与 check 的 C10 共用 tools/iris.mjs 的同一实现与同一阈值，manifest 不再手抄数字。
    const bandEnd = nBox.top + Math.round(nBox.height * 0.40);
    const headC = headCentroid(nativeImg, nBox, bandEnd);
    const { iris } = irisBlob(nativeImg, nBox, bandEnd, { minArea: IRIS_MIN_AREA, minFill: IRIS_MIN_FILL });
    report.push({
      id,
      facing: spec.facing,
      airborne: spec.airborne,
      generated: {
        file: 'source/jump_' + id + '_generated.png', width: img.width, height: img.height,
        bytes: sourceBytes.length, sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
        inkBox: sourceInkBox, alphaExtent: sourceAlphaExtent, cleanup,
      },
      place: {
        scale, dw, dh, ox, oy, lowestInkY, torsoGenX: +torso.toFixed(1), torsoAnchorX: spec.torsoAnchorX,
        seatDelta, airborneGap: CONFIG.lastInkRowNative - lowestInkY,
      },
      native: {
        bbox: nBox, bytes: nativeBytes.length, sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex'),
        cleanup: cleanup2, islandsRemoved: islands, dirtyEdgeCleared,
      },
      master: { bbox: bboxOf(master, ANY_ALPHA_MIN), bytes: masterBytes.length, sha256: crypto.createHash('sha256').update(masterBytes).digest('hex') },
      orientation: {
        irisCentroidX: iris ? +iris.cx.toFixed(1) : null,
        irisCentroidY: iris ? +iris.cy.toFixed(1) : null,
        irisArea: iris ? iris.n : 0,
        irisFill: iris ? +iris.fill.toFixed(3) : 0,
        headInkCentroidX: headC ? +headC.x.toFixed(1) : null,
        irisOffsetNative: iris && headC ? +(iris.cx - headC.x).toFixed(1) : null,
        facing: spec.facing,
      },
      footRuns: footRuns(nativeImg, nBox.bottom, CONFIG.footBandNative).map((r) => ({
        left: r.left, right: r.right, width: r.width, centerX: +r.centerX.toFixed(1), contactY: r.contactY,
      })),
    });
  }
  return { scale, frames: report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  // --facing=1 / --facing=-1 只重建该朝向（左向已验收，重建右向时绝不重写左向字节）
  const facingArg = process.argv.find((arg) => arg.startsWith('--facing='));
  const facingFilter = facingArg ? Number(facingArg.slice('--facing='.length)) : null;
  const r = buildJump(facingFilter);
  const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
  if (reportArg) {
    const reportPath = reportArg.slice('--report='.length);
    fs.writeFileSync(reportPath, JSON.stringify(r, null, 1));
    console.log('report -> ' + reportPath);
  }
  const total = r.frames.reduce((s, f) => s + f.master.bytes, 0);
  console.log('scale=' + r.scale + ' (固定沿用 run 左向系数) facing=' + (facingFilter === null ? '全部' : facingFilter));
  for (const f of r.frames) {
    console.log(f.id.padEnd(13), f.facing > 0 ? 'RIGHT' : 'LEFT ', f.airborne ? 'AIRBORNE' : 'support ', 'nativeBottom=' + f.native.bbox.bottom,
      'gap=' + f.place.airborneGap, 'dw=' + f.place.dw, 'dh=' + f.place.dh, 'ox=' + f.place.ox, 'oy=' + f.place.oy,
      'master=' + f.master.bytes, 'dirtyEdgeCleared=' + f.native.dirtyEdgeCleared,
      'iris=' + f.orientation.irisOffsetNative + '(n' + f.orientation.irisArea + ')',
      'feet=' + f.footRuns.map((x) => x.centerX + '@' + x.contactY + '(w' + x.width + ')').join(' '));
  }
  console.log('TOTAL=' + total + ' (' + (total / 1048576).toFixed(2) + 'MB) budget=' + (r.frames.length * 1.9).toFixed(1) + 'MB');
}
