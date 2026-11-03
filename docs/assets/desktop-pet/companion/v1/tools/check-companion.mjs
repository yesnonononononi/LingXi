// 小云酱基础帧门禁：把「画布/锚点/尺寸/alpha/契约一致性/不是主角缩小」变成可执行断言。
// 运行：node docs/assets/desktop-pet/companion/v1/tools/check-companion.mjs
// 退出码：0 全部通过；1 有断言失败（逐条打印原因）。
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPng, decodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Root = path.resolve(here, '..');
const assetRoot = path.resolve(here, '..', '..', '..');
const COMPANION_FILE = path.join(v1Root, 'cloudling_neutral.png');
const MANIFEST_FILE = path.join(v1Root, 'manifest.json');
const PROTAGONIST_FILE = path.join(assetRoot, 'v3', 'front-standing.png');

const CONTRACT = {
  canvas: { width: 512, height: 512 },
  anchor: { x: 256, y: 470 },
  nativeCanvas: { width: 256, height: 256 },
  masterScale: 2,
  marginMin: 8,
  bottomTolerance: 2,
  bboxWidthRange: [180, 260],
  bboxHeightRange: [160, 240],
  alphaClearThreshold: 8,
  minIslandArea: 4,
  maxSilhouetteIoU: 0.95,
  iouMarginOverResampling: 0.15,
  minAspectDifferenceRatio: 0.10,
  minDetailDensityDiffRatio: 0.25,
};

// --asset=<path> 可指向任意候选图做变异自检（不覆盖正式交付物）
const assetArg = process.argv.slice(2).find((a) => a.startsWith('--asset='));
const TARGET_FILE = assetArg ? path.resolve(assetArg.slice('--asset='.length)) : COMPANION_FILE;
const IS_OFFICIAL_TARGET = path.resolve(TARGET_FILE) === path.resolve(COMPANION_FILE);

const results = [];
function assert(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
}

function alphaBBox(img) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function components(img) {
  const { width: W, height: H, data } = img;
  const seen = new Uint8Array(W * H);
  const areas = [];
  const stack = [];
  for (let start = 0; start < W * H; start += 1) {
    if (seen[start] || data[start * 4 + 3] === 0) continue;
    let area = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      area += 1;
      const x = idx % W;
      const y = (idx - x) / W;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
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
    areas.push(area);
  }
  return areas.sort((a, b) => b - a);
}

// 把任意图按 alpha 包围盒归一化采样到 size×size 的覆盖率网格（0..1）
function normalizedCoverage(img, box, size) {
  const grid = new Float64Array(size * size);
  const sx = box.width / size;
  const sy = box.height / size;
  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      let acc = 0, cnt = 0;
      for (let y = Math.floor(box.top + gy * sy); y < Math.ceil(box.top + (gy + 1) * sy); y += 1) {
        for (let x = Math.floor(box.left + gx * sx); x < Math.ceil(box.left + (gx + 1) * sx); x += 1) {
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
          acc += img.data[(y * img.width + x) * 4 + 3] / 255;
          cnt += 1;
        }
      }
      if (cnt) grid[gy * size + gx] = acc / cnt;
    }
  }
  return grid;
}

function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ha = a[i] > 0.5, hb = b[i] > 0.5;
    if (ha && hb) inter += 1;
    if (ha || hb) union += 1;
  }
  return union === 0 ? 1 : inter / union;
}

// 细节密度：归一化后按「边缘能量 / 前景像素」衡量，用于说明这不是同一张图被缩放
function edgeDensity(img, box, size) {
  const grid = normalizedCoverage(img, box, size);
  let energy = 0, fg = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const c = grid[y * size + x];
      if (c > 0.5) fg += 1;
      energy += Math.abs(c - grid[y * size + x - 1]) + Math.abs(c - grid[(y - 1) * size + x]);
    }
  }
  return fg === 0 ? 0 : energy / fg;
}

function main() {
  const stats = {};

  // C1 文件、画布、像素格式、sRGB 标记
  const exists = fs.existsSync(TARGET_FILE);
  assert('C1', 'cloudling_neutral.png 存在且可解码', exists, exists ? TARGET_FILE : '文件缺失：' + TARGET_FILE);
  if (!exists) return finish(stats);

  const bytes = fs.readFileSync(TARGET_FILE);
  const img = decodePng(bytes);
  stats.file = 'cloudling_neutral.png';
  stats.width = img.width;
  stats.height = img.height;
  stats.bytes = bytes.length;
  stats.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  assert('C1a', '画布 512×512', img.width === CONTRACT.canvas.width && img.height === CONTRACT.canvas.height,
    img.width + '×' + img.height);
  assert('C1b', '8bit RGBA、非隔行（straight alpha 容器）',
    img.colorType === 6 && img.bitDepth === 8, 'colorType=' + img.colorType + ' bitDepth=' + img.bitDepth);
  const hasSrgbChunk = (() => {
    let off = 8;
    while (off + 8 <= bytes.length) {
      const len = bytes.readUInt32BE(off);
      const type = bytes.toString('latin1', off + 4, off + 8);
      if (type === 'sRGB') return true;
      if (type === 'IEND') return false;
      off += 12 + len;
    }
    return false;
  })();
  assert('C1c', '带 sRGB 标记块（色彩解释不留白）', hasSrgbChunk, hasSrgbChunk ? 'sRGB chunk 存在' : '缺少 sRGB chunk');

  // C2 alpha 干净
  const W = img.width, H = img.height;
  let lowAlphaNonZero = 0, partial = 0;
  for (let i = 0; i < W * H; i += 1) {
    const a = img.data[i * 4 + 3];
    if (a === 0) continue;
    if (a < CONTRACT.alphaClearThreshold) lowAlphaNonZero += 1;
    if (a < 255) partial += 1;
  }
  assert('C2a', 'alpha < ' + CONTRACT.alphaClearThreshold + ' 的像素必须全透明（无灰边底噪）',
    lowAlphaNonZero === 0, '残留低 alpha 像素=' + lowAlphaNonZero);

  const areas = components(img);
  const tiny = areas.filter((a) => a < CONTRACT.minIslandArea);
  assert('C2b', '无面积 < ' + CONTRACT.minIslandArea + 'px 的孤立像素块',
    tiny.length === 0, '连通块 ' + areas.length + ' 个，最大 ' + areas[0] + 'px，最小 ' + areas[areas.length - 1] + 'px');
  stats.components = areas.length;
  stats.componentAreas = areas;

  // 灰边（黑/灰垫色遗留）：半透明像素若既接近中性灰又显著暗于相邻实心像素，就是脏边
  let greyFringe = 0;
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const o = (y * W + x) * 4;
      const a = img.data[o + 3];
      if (a === 0 || a === 255) continue;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 24;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let neighbourLum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const oo = ((y + dy) * W + (x + dx)) * 4;
          if (img.data[oo + 3] === 255) {
            neighbourLum += 0.2126 * img.data[oo] + 0.7152 * img.data[oo + 1] + 0.0722 * img.data[oo + 2];
            n += 1;
          }
        }
      }
      if (n > 0 && neutral && lum < 0.55 * (neighbourLum / n)) greyFringe += 1;
    }
  }
  assert('C2c', '半透明边缘无中性灰脏边', greyFringe === 0,
    '半透明像素=' + partial + '，疑似灰边=' + greyFringe);
  stats.partialPixels = partial;

  // C3 包围盒与锚点
  const box = alphaBBox(img);
  stats.bbox = box;
  if (!box) { assert('C3', '存在可见像素', false, '整幅图全透明'); return finish(stats); }
  const margins = {
    left: box.left,
    top: box.top,
    right: CONTRACT.canvas.width - 1 - box.right,
    bottom: CONTRACT.canvas.height - 1 - box.bottom,
  };
  stats.margins = margins;
  assert('C3a', '可见包围盒四边留白 ≥ ' + CONTRACT.marginMin + 'px',
    Object.values(margins).every((m) => m >= CONTRACT.marginMin), 'margins=' + JSON.stringify(margins));
  stats.bottomDeviation = Math.abs(box.bottom - CONTRACT.anchor.y);
  assert('C3b', '最低点 y 与锚点 ' + CONTRACT.anchor.y + ' 偏差 ≤ ' + CONTRACT.bottomTolerance + 'px',
    stats.bottomDeviation <= CONTRACT.bottomTolerance, 'bbox.bottom=' + box.bottom + ' 偏差=' + stats.bottomDeviation);

  // C5 尺寸区间
  const widthOk = box.width >= CONTRACT.bboxWidthRange[0] && box.width <= CONTRACT.bboxWidthRange[1];
  const heightOk = box.height >= CONTRACT.bboxHeightRange[0] && box.height <= CONTRACT.bboxHeightRange[1];
  assert('C5', '包围盒宽 ∈ [' + CONTRACT.bboxWidthRange.join(',') + '] 且高 ∈ [' + CONTRACT.bboxHeightRange.join(',') + ']',
    widthOk && heightOk, '实测 ' + box.width + '×' + box.height);

  // C7 2× 母版结构：每 2×2 块内像素必须完全一致
  let blockMismatch = 0;
  for (let by = 0; by < H / CONTRACT.masterScale; by += 1) {
    for (let bx = 0; bx < W / CONTRACT.masterScale; bx += 1) {
      const o = (by * 2 * W + bx * 2) * 4;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2], a = img.data[o + 3];
      const same = img.data[o + 4] === r && img.data[o + 5] === g && img.data[o + 6] === b && img.data[o + 7] === a
        && img.data[o + W * 4] === r && img.data[o + W * 4 + 1] === g && img.data[o + W * 4 + 2] === b && img.data[o + W * 4 + 3] === a
        && img.data[o + W * 4 + 4] === r && img.data[o + W * 4 + 5] === g && img.data[o + W * 4 + 6] === b && img.data[o + W * 4 + 7] === a;
      if (!same) blockMismatch += 1;
    }
  }
  assert('C7', '2× 母版结构成立：每个 2×2 块内像素完全一致（原生 256 画布的整数倍放大）',
    blockMismatch === 0, '不一致块数=' + blockMismatch);
  // C6 不是主角缩小：轮廓归一化后的形状重合度 + 宽高比 + 细节密度
  const companionGrid = normalizedCoverage(img, box, 64);
  const companionAspect = box.width / box.height;
  if (!fs.existsSync(PROTAGONIST_FILE)) {
    assert('C6', '不是主角母版的缩放复制', false, '缺少对照母版：' + PROTAGONIST_FILE);
  } else {
    const hero = readPng(PROTAGONIST_FILE);
    const heroBox = alphaBBox(hero);
    const heroGrid = normalizedCoverage(hero, heroBox, 64);
    const silhouetteIoU = iou(companionGrid, heroGrid);
    // 自校准上界：把主角自己的轮廓降到 32×32 再升回 64×64，测出「同一形状、只损失分辨率」时的 IoU。
    // 缩放不改变归一化形状，所以「主角缩小版」的重合度会贴着这个上界；差得远才说明是另一个轮廓。
    const downsampled = (() => {
      const half = 32;
      const small = new Float64Array(half * half);
      for (let y = 0; y < half; y += 1) {
        for (let x = 0; x < half; x += 1) {
          let acc = 0;
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) acc += heroGrid[(y * 2 + dy) * 64 + x * 2 + dx];
          }
          small[y * half + x] = acc / 4;
        }
      }
      const back = new Float64Array(64 * 64);
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) back[y * 64 + x] = small[Math.floor(y / 2) * half + Math.floor(x / 2)];
      }
      return back;
    })();
    const resamplingIoU = iou(heroGrid, downsampled);
    const heroAspect = heroBox.width / heroBox.height;
    const aspectDiff = Math.abs(companionAspect - heroAspect) / heroAspect;
    const companionDetail = edgeDensity(img, box, 64);
    const heroDetail = edgeDensity(hero, heroBox, 64);
    stats.c6 = {
      companionAspect: Number(companionAspect.toFixed(4)),
      protagonistAspect: Number(heroAspect.toFixed(4)),
      aspectDifferenceRatio: Number(aspectDiff.toFixed(4)),
      silhouetteIoU: Number(silhouetteIoU.toFixed(4)),
      detailDensity: { companion: Number(companionDetail.toFixed(4)), protagonist: Number(heroDetail.toFixed(4)) },
    };
    assert('C6a', '轮廓归一化后的形状重合度必须显著低于「同形状重采样」上界（若为主角缩图会贴着上界）',
      silhouetteIoU < resamplingIoU - CONTRACT.iouMarginOverResampling && silhouetteIoU < CONTRACT.maxSilhouetteIoU,
      'silhouetteIoU=' + silhouetteIoU.toFixed(4) + '，自校准上界=' + resamplingIoU.toFixed(4)
      + '（要求 < ' + (resamplingIoU - CONTRACT.iouMarginOverResampling).toFixed(4) + '）');
    assert('C6b', '宽高比与主角相差 > ' + Math.round(CONTRACT.minAspectDifferenceRatio * 100) + '%',
      aspectDiff > CONTRACT.minAspectDifferenceRatio,
      '小云酱 ' + companionAspect.toFixed(3) + ' vs 主角 ' + heroAspect.toFixed(3) + '（差 ' + (aspectDiff * 100).toFixed(1) + '%）');
    const detailDiff = Math.abs(companionDetail - heroDetail) / heroDetail;
    assert('C6c', '归一化细节密度与主角相差 > ' + Math.round(CONTRACT.minDetailDensityDiffRatio * 100) + '%（缩放不改变该指标）',
      detailDiff > CONTRACT.minDetailDensityDiffRatio,
      'edgeDensity 小云酱=' + companionDetail.toFixed(4) + ' 主角=' + heroDetail.toFixed(4) + '（差 ' + (detailDiff * 100).toFixed(1) + '%）');
  }

  // C9 不许交占位图：必须有暗色描边 + 内部色彩层次（纯色块/空白框在这里必死）
  let outlinePixels = 0;
  const colorSet = new Set();
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const o = (y * W + x) * 4;
      const a = img.data[o + 3];
      if (a === 0) continue;
      const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (a >= 250) colorSet.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      if (lum < 120) {
        let touchesClear = false;
        for (let dy = -1; dy <= 1 && !touchesClear; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (img.data[((y + dy) * W + (x + dx)) * 4 + 3] === 0) { touchesClear = true; break; }
          }
        }
        if (touchesClear) outlinePixels += 1;
      }
    }
  }
  stats.outlinePixels = outlinePixels;
  stats.distinctColors16 = colorSet.size;
  assert('C9a', '存在贴边暗色描边（不是纯色块/空白占位）', outlinePixels >= 100, '描边像素=' + outlinePixels);
  assert('C9b', '内部有色彩层次（16 级量化后 ≥ 12 种颜色）', colorSet.size >= 12, '量化色数=' + colorSet.size);

  // C4 manifest 对账（变异候选不参与，避免噪声）
  if (!IS_OFFICIAL_TARGET) {
    assert('C4', 'manifest 对账（当前为变异候选，跳过）', true, TARGET_FILE);
    return finish(stats);
  }
  if (!fs.existsSync(MANIFEST_FILE)) {
    assert('C4', 'manifest.json 存在', false, '缺少 ' + MANIFEST_FILE);
    return finish(stats);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const problems = [];
  for (const key of ['version', 'assetId', 'canvas', 'anchor', 'gripPoint', 'files']) {
    if (!(key in manifest)) problems.push('缺少字段 ' + key);
  }
  if (manifest.canvas && (manifest.canvas.width !== CONTRACT.canvas.width || manifest.canvas.height !== CONTRACT.canvas.height)) {
    problems.push('canvas 与 512×512 不符');
  }
  if (manifest.anchor && (manifest.anchor.x !== CONTRACT.anchor.x || manifest.anchor.y !== CONTRACT.anchor.y)) {
    problems.push('anchor 与 (256,470) 不符');
  }
  const entry = (manifest.files || []).find((f) => f.file === 'cloudling_neutral.png');
  if (!entry) problems.push('files[] 缺少 cloudling_neutral.png 条目');
  else {
    if (entry.bytes !== stats.bytes) problems.push('files[].bytes ' + entry.bytes + ' ≠ 实测 ' + stats.bytes);
    if (entry.sha256 !== stats.sha256) problems.push('files[].sha256 ≠ 实测 ' + stats.sha256);
    if (entry.width !== box.width || entry.height !== box.height) {
      problems.push('files[].width/height ' + entry.width + '×' + entry.height + ' ≠ 实测 bbox ' + box.width + '×' + box.height);
    }
    const b = entry.bbox || {};
    if (b.left !== box.left || b.top !== box.top || b.right !== box.right || b.bottom !== box.bottom) {
      problems.push('files[].bbox ' + JSON.stringify(b) + ' ≠ 实测 ' + JSON.stringify({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }));
    }
  }
  assert('C4', 'manifest 的 bytes/sha256/bbox 与磁盘实测逐字节一致', problems.length === 0,
    problems.length === 0 ? '对账通过' : problems.join('；'));

  // C8 gripPoint 合理性
  const grip = manifest.gripPoint || {};
  const gripInside = Number.isInteger(grip.x) && Number.isInteger(grip.y)
    && grip.x >= 0 && grip.x < W && grip.y >= 0 && grip.y < H
    && img.data[(grip.y * W + grip.x) * 4 + 3] > 0;
  const bandTop = box.top;
  const bandBottom = box.top + Math.round(box.height * 0.6);
  const gripBand = grip.y >= bandTop && grip.y <= bandBottom;
  assert('C8', 'gripPoint 落在可见像素内且位于包围盒上部 60%（抱起时的握持点）',
    Boolean(gripInside && gripBand),
    'gripPoint=' + JSON.stringify(grip) + ' 允许 y ∈ [' + bandTop + ', ' + bandBottom + ']');

  return finish(stats);
}

function finish(stats) {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log((r.ok ? '[PASS] ' : '[FAIL] ') + r.id + ' ' + r.title);
    if (r.detail) console.log('        ' + r.detail);
  }
  if (Object.keys(stats).length) console.log('\n实测统计: ' + JSON.stringify(stats, null, 2));
  const ok = failed.length === 0;
  console.log('\n' + (ok ? '结论: 全部通过' : '结论: ' + failed.length + ' 项失败') + '（' + (results.length - failed.length) + '/' + results.length + '）');
  if (process.argv.includes('--json')) console.log('\n' + JSON.stringify({ ok, results, stats }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main();
