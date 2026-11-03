// v4 wink 母版门禁：把「wink 是单眼闭、其余像素一字不动」变成可执行的断言。
// 运行：node docs/assets/desktop-pet/v4/tools/check-wink.mjs
// 退出码：0 = 全部通过；1 = 有断言失败（失败项逐条打印原因）。
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPng, decodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const v4Root = path.resolve(here, '..');
const v3Root = path.resolve(here, '..', '..', 'v3');
const WINK_FILE = path.join(v4Root, 'expr', 'E9_wink.png');
// --wink=<path> 可指向任意候选图，用于变异自检（不覆盖正式交付物）
const winkArg = process.argv.slice(2).find((a) => a.startsWith('--wink='));
const TARGET_FILE = winkArg ? path.resolve(winkArg.slice('--wink='.length)) : WINK_FILE;
const IS_OFFICIAL_TARGET = path.resolve(TARGET_FILE) === path.resolve(WINK_FILE);
const E1_FILE = path.join(v3Root, 'expr', 'E1_default.png');
const E2_FILE = path.join(v3Root, 'expr', 'E2_blink.png');
const MANIFEST_FILE = path.join(v4Root, 'manifest.json');

// 与 build-wink.mjs 共用同一份契约常量，避免「生成用一套、校验用另一套」
const CONTRACT = {
  canvas: { width: 2048, height: 3072 },
  anchor: { x: 1024, y: 2908 },
  diffThreshold: 7,
  dilateRadius: 4,
  winkEyeZone: { left: 570, top: 1070, right: 960, bottom: 1380 },
  openEyeZone: { left: 1000, top: 1060, right: 1400, bottom: 1380 },
  faceRegionMaster: { left: 560, top: 1064, width: 792, height: 400 },
  alphaSolid: 248,
  // 单个眨眼笔迹的量级上限：E2 单眼笔迹约 4.8 万像素，膨胀后约 5.8 万；
  // 超过 9 万说明改动范围已经不像「一只眼睛」，典型症状是整头重绘/整体滤镜。
  maxDiffPixels: 90000,
};

const results = [];
function assert(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
}

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

function scan(imgA, imgB, threshold, region) {
  const { width, height } = CONTRACT.canvas;
  let count = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    if (region && (y < region.top || y > region.bottom)) continue;
    for (let x = 0; x < width; x += 1) {
      if (region && (x < region.left || x > region.right)) continue;
      const i = (y * width + x) * 4;
      const d = threshold > 0 ? maxChannelDelta(imgA.data, imgB.data, i) > threshold
        : (imgA.data[i] !== imgB.data[i] || imgA.data[i + 1] !== imgB.data[i + 1]
          || imgA.data[i + 2] !== imgB.data[i + 2] || imgA.data[i + 3] !== imgB.data[i + 3]);
      if (!d) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return count === 0
    ? { count, bbox: null }
    : { count, bbox: { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

function alphaBBox(img) {
  const { width, height } = CONTRACT.canvas;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (img.data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { left: minX, top: minY, right: maxX, bottom: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function bboxInside(inner, outer) {
  return inner.left >= outer.left && inner.right <= outer.right
    && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

function main() {
  // C1 文件与解码
  const exists = fs.existsSync(WINK_FILE);
  assert('C1', 'E9_wink.png 存在且可解码', exists, exists ? WINK_FILE : '文件缺失：' + WINK_FILE);
  if (!exists) return finish();

  const winkBytes = fs.readFileSync(TARGET_FILE);
  const pngHeader = decodePng(winkBytes);
  assert('C1b', 'E1_default.png / E2_blink.png 可解码（v3 基线未被改动）',
    fs.existsSync(E1_FILE) && fs.existsSync(E2_FILE), v3Root);

  // C2 画布与像素格式
  const canvasOk = pngHeader.width === CONTRACT.canvas.width && pngHeader.height === CONTRACT.canvas.height;
  assert('C2', '画布与 v3 完全一致 2048×3072',
    canvasOk, `${pngHeader.width}×${pngHeader.height}`);
  assert('C2b', '像素格式 8bit RGBA、非隔行（straight alpha 容器）',
    pngHeader.colorType === 6 && pngHeader.bitDepth === 8 && winkBytes.length > 0,
    `colorType=${pngHeader.colorType} bitDepth=${pngHeader.bitDepth}`);

  const e1 = readPng(E1_FILE);
  const e2 = readPng(E2_FILE);
  const wink = pngHeader;

  // C3 差异量级：必须 >0，且小于上限
  const anyDiff = scan(e1, wink, 0);
  const over7 = scan(e1, wink, CONTRACT.diffThreshold);
  assert('C3', '与 E1 的差异像素数 > 0（不是原图直接复制）',
    anyDiff.count > 0, `diffPixels=${anyDiff.count}`);
  assert('C4', `差异像素数 < 上限 ${CONTRACT.maxDiffPixels}（防整头重绘/整体滤镜）`,
    anyDiff.count <= CONTRACT.maxDiffPixels, `diffPixels=${anyDiff.count}`);

  // C5 差异包围盒落在单侧眼区
  const zone = CONTRACT.winkEyeZone;
  if (anyDiff.bbox) {
    assert('C5', '差异包围盒 ⊆ 单侧眼区 x570–960 / y1070–1380',
      bboxInside(anyDiff.bbox, zone),
      `bbox=${JSON.stringify(anyDiff.bbox)} zone=${JSON.stringify(zone)}`);
  }

  // C6 眼区之外差异必须为 0
  const outsideCount = (() => {
    const { width, height } = CONTRACT.canvas;
    let n = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (inRect(x, y, zone)) continue;
        const i = (y * width + x) * 4;
        if (wink.data[i] !== e1.data[i] || wink.data[i + 1] !== e1.data[i + 1]
          || wink.data[i + 2] !== e1.data[i + 2] || wink.data[i + 3] !== e1.data[i + 3]) n += 1;
      }
    }
    return n;
  })();
  assert('C6', '眼区之外与 E1 的差异像素 = 0（嘴型/腮红/发饰/耳朵/轮廓一字未动）',
    outsideCount === 0, `outsideDiffPixels=${outsideCount}`);

  // C7 另一只眼区差异为 0
  const openEyeDiff = scan(e1, wink, 0, CONTRACT.openEyeZone);
  assert('C7', '另一只眼区（睁眼侧）差异 = 0', openEyeDiff.count === 0,
    `openEyeZone=${JSON.stringify(CONTRACT.openEyeZone)} diff=${openEyeDiff.count}`);

  // C8 不是整张 blink 复制：睁眼侧必须与 E2 明显不同
  const vsBlinkOpenEye = scan(e2, wink, CONTRACT.diffThreshold, CONTRACT.openEyeZone);
  assert('C8', '睁眼侧与 E2_blink 不同（排除「双眼闭合冒充 wink」）',
    vsBlinkOpenEye.count > 1000, `睁眼区与 blink 的差异像素=${vsBlinkOpenEye.count}`);

  // C9 差异包围盒 ⊆ 架构师实测脸区
  const face = CONTRACT.faceRegionMaster;
  const faceRect = { left: face.left, top: face.top, right: face.left + face.width - 1, bottom: face.top + face.height - 1 };
  if (anyDiff.bbox) {
    assert('C9', '差异包围盒 ⊆ faceRegionMaster 560,1064,792,400',
      bboxInside(anyDiff.bbox, faceRect), `faceRegion=${JSON.stringify(faceRect)}`);
  }

  // C10 alpha 通道无新增空洞
  const { width, height } = CONTRACT.canvas;
  let newHoles = 0, alphaTouched = 0;
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4 + 3;
    if (e1.data[o] >= CONTRACT.alphaSolid && wink.data[o] < CONTRACT.alphaSolid) newHoles += 1;
    if (e1.data[o] !== wink.data[o]) alphaTouched += 1;
  }
  assert('C10', `alpha 无新增空洞（E1 α≥${CONTRACT.alphaSolid} 的实心像素，wink 仍 ≥${CONTRACT.alphaSolid}）`,
    newHoles === 0, `newHoles=${newHoles} alphaChangedPixels=${alphaTouched}`);

  // C11 头部外轮廓包围盒与 E1 一致（防整体缩放/位移）
  const winkAlphaBox = alphaBBox(wink);
  const e1AlphaBox = alphaBBox(e1);
  assert('C11', '整图 alpha 外轮廓包围盒与 E1 逐值一致（未缩放/未平移/未重新居中即同一锚点语义）',
    JSON.stringify(winkAlphaBox) === JSON.stringify(e1AlphaBox),
    `wink=${JSON.stringify(winkAlphaBox)} E1=${JSON.stringify(e1AlphaBox)}`);

  // C12 manifest 记录与实测对账
  const stats = {
    file: 'expr/E9_wink.png',
    width: wink.width,
    height: wink.height,
    bytes: winkBytes.length,
    sha256: crypto.createHash('sha256').update(winkBytes).digest('hex'),
    diffPixels: anyDiff.count,
    diffPixelsOver7: over7.count,
    diffBbox: anyDiff.bbox,
    diffOutsideEyeZone: outsideCount,
    openEyeZoneDiff: openEyeDiff.count,
    openEyeZoneVsBlink: vsBlinkOpenEye.count,
    newAlphaHoles: newHoles,
  };
  if (!IS_OFFICIAL_TARGET) {
    assert('C12', 'manifest.json 对账（非正式目标时跳过）', true, '当前为目标为变异候选：' + TARGET_FILE);
  } else if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    const entry = (manifest.files || []).find((f) => f.file === 'expr/E9_wink.png');
    const winkRecord = manifest.wink || {};
    const problems = [];
    if (!entry) problems.push('files[] 缺少 expr/E9_wink.png 条目');
    else {
      if (entry.bytes !== stats.bytes) problems.push(`files[].bytes ${entry.bytes} ≠ 实测 ${stats.bytes}`);
      if (entry.sha256 !== stats.sha256) problems.push(`files[].sha256 ${entry.sha256} ≠ 实测 ${stats.sha256}`);
      if (entry.width !== stats.width || entry.height !== stats.height) problems.push('files[] 尺寸与实测不符');
    }
    if (!Array.isArray(manifest.expressionIds) || !manifest.expressionIds.includes('wink')) problems.push('expressionIds 未包含 wink');
    if ((manifest.blink || {}).wink !== 'wink') problems.push('blink.wink 未指向 wink');
    if (winkRecord.diffPixels !== stats.diffPixels) problems.push(`wink.diffPixels ${winkRecord.diffPixels} ≠ 实测 ${stats.diffPixels}`);
    if (JSON.stringify(winkRecord.diffBbox) !== JSON.stringify(stats.diffBbox)) problems.push(`wink.diffBbox ${JSON.stringify(winkRecord.diffBbox)} ≠ 实测 ${JSON.stringify(stats.diffBbox)}`);
    if (winkRecord.diffOutsideEyeZonePixels !== 0) problems.push('wink.diffOutsideEyeZonePixels 必须记录为 0');
    if (winkRecord.openEyeZoneDiffPixels !== 0) problems.push('wink.openEyeZoneDiffPixels 必须记录为 0');
    assert('C12', 'manifest.json 记录与实测值一致（含 bytes/sha256/差异统计）',
      problems.length === 0, problems.length === 0 ? '对账通过' : problems.join('；'));
  } else {
    assert('C12', 'manifest.json 存在', false, '缺少 ' + MANIFEST_FILE);
  }

  return finish(stats);
}

function finish(stats) {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.id} ${r.title}`);
    if (r.detail) console.log(`        ${r.detail}`);
  }
  if (stats) console.log('\n实测统计: ' + JSON.stringify(stats, null, 2));
  const ok = failed.length === 0;
  console.log(`\n${ok ? '结论: 全部通过' : `结论: ${failed.length} 项失败`}（${results.length - failed.length}/${results.length}）`);
  if (process.argv.includes('--json')) console.log('\n' + JSON.stringify({ ok, results, stats: stats || null }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main();

