#!/usr/bin/env node
// 趴睡批次门禁（纯 Node 零第三方依赖）
// 常规 C1/C2/C4/C5/C7 之外，本批特有两条核心断言：
//   C3-lie 外轮廓 bbox 必须与 lie 趴平帧逐值相同（证明身体姿态未动）
//   C6      蒙版外逐像素零变化（证明模型没有重绘眼区以外区域）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATCH = path.resolve(HERE, '..');
const POSES = path.resolve(BATCH, '..');
const MANIFEST = path.join(BATCH, 'manifest.json');
const MASTER = path.join(BATCH, 'sleep_neutral@2x.png');
const NATIVE = path.join(BATCH, 'source', 'sleep_neutral_native.png');
const MASK = path.join(BATCH, 'source', 'eye_mask_native.png');
const LIE_MANIFEST = path.join(POSES, 'lie', 'manifest.json');
const LIE_NATIVE = path.join(POSES, 'lie', 'source', 'lie_neutral_native.png');

let fails = 0;
const check = (id, label, ok, detail) => {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + id + ' ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fails += 1;
};
const header = (file) => {
  const b = fs.readFileSync(file);
  return { bytes: b.length, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25], interlace: b[28], hasSrgb: b.includes(Buffer.from('sRGB', 'latin1')) };
};

if (!fs.existsSync(MANIFEST)) { console.log('[FAIL] C4 manifest.json 存在'); process.exit(1); }
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const h = header(MASTER);
const img = readPng(MASTER);

check('C1a', '画布与 manifest 一致', h.width === m.canvas.width && h.height === m.canvas.height, h.width + 'x' + h.height);
check('C1b', '8bit RGBA 非隔行', h.bitDepth === 8 && h.colorType === 6 && h.interlace === 0, 'bitDepth=' + h.bitDepth + ' colorType=' + h.colorType + ' interlace=' + h.interlace);
check('C1c', '带 sRGB chunk', h.hasSrgb, h.hasSrgb ? 'sRGB 存在' : '缺少 sRGB');

let lowAlpha = 0, partial = 0, grey = 0;
for (let i = 0; i < img.data.length; i += 4) {
  const a = img.data[i + 3];
  if (a > 0 && a < 8) lowAlpha += 1;
  if (a > 0 && a < 255) {
    partial += 1;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && Math.abs(r - b) < 6) grey += 1;
  }
}
check('C2a', 'alpha<8 的像素全透明', lowAlpha === 0, '残留=' + lowAlpha);
check('C2c', '半透明边缘无中性灰脏边（阈值按现有批次量级：lie 220 / sit 28）', grey <= 300, '半透明=' + partial + ' 疑似灰边=' + grey);

let box = null;
for (let y = 0; y < img.height; y += 1) for (let x = 0; x < img.width; x += 1) {
  if (img.data[(y * img.width + x) * 4 + 3] > 0) {
    if (!box) box = { left: x, top: y, right: x, bottom: y };
    else { box.left = Math.min(box.left, x); box.right = Math.max(box.right, x); box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y); }
  }
}
check('C3a', '存在可见像素', !!box, box ? JSON.stringify(box) : '全透明');
if (box) {
  const lm = JSON.parse(fs.readFileSync(LIE_MANIFEST, 'utf8'));
  const lieNeutral = (lm.files || []).find((f) => f.file === 'lie_neutral@2x.png');
  const lb = lieNeutral ? lieNeutral.bbox : null;
  const same = lb !== null && box.left === lb.left && box.top === lb.top && box.right === lb.right && box.bottom === lb.bottom;
  check('C3-lie', '外轮廓 bbox 与 lie 趴平帧逐值相同（身体未动）', same, same ? JSON.stringify(box) : 'sleep=' + JSON.stringify(box) + ' lie_neutral=' + JSON.stringify(lb));
}

const sha = crypto.createHash('sha256').update(fs.readFileSync(MASTER)).digest('hex');
const f0 = m.files[0];
const ok4 = f0.sha256 === sha && f0.bytes === h.bytes && box !== null && f0.bbox.left === box.left && f0.bbox.top === box.top && f0.bbox.right === box.right && f0.bbox.bottom === box.bottom;
check('C4', 'manifest bytes/sha256/bbox 与磁盘逐字节一致', ok4, 'sha=' + sha.slice(0, 16) + ' bytes=' + h.bytes);
for (const s of (m.sources || [])) {
  const p = path.join(BATCH, s.file);
  if (!fs.existsSync(p)) { check('C4src', 'source 存在: ' + s.file, false); continue; }
  const buf = fs.readFileSync(p);
  const sh = crypto.createHash('sha256').update(buf).digest('hex');
  check('C4src', 'source 对账: ' + s.file, sh === s.sha256 && buf.length === s.bytes, 'sha=' + sh.slice(0, 12));
}

if (box) {
  const w = box.right - box.left + 1, hh = box.bottom - box.top + 1;
  check('C5', 'bbox 宽高在合理区间', w >= 2500 && w <= 3072 && hh >= 1400 && hh <= 3072, w + 'x' + hh);
}

if (fs.existsSync(LIE_NATIVE) && fs.existsSync(NATIVE) && fs.existsSync(MASK)) {
  const lieI = readPng(LIE_NATIVE), slpI = readPng(NATIVE), mskI = readPng(MASK);
  let inside = 0, outside = 0, maxOut = 0, outBox = null;
  for (let y = 0; y < lieI.height; y += 1) for (let x = 0; x < lieI.width; x += 1) {
    const i = (y * lieI.width + x) * 4;
    let d = 0;
    for (let c = 0; c < 4; c += 1) d = Math.max(d, Math.abs(lieI.data[i + c] - slpI.data[i + c]));
    if (d > 0) {
      const mi = (y * mskI.width + x) * 4;
      if (mskI.data[mi + 3] === 0) inside += 1;
      else {
        outside += 1;
        if (d > maxOut) maxOut = d;
        if (!outBox) outBox = { left: x, top: y, right: x, bottom: y };
        else { outBox.left = Math.min(outBox.left, x); outBox.right = Math.max(outBox.right, x); outBox.top = Math.min(outBox.top, y); outBox.bottom = Math.max(outBox.bottom, y); }
      }
    }
  }
  check('C6a', '蒙版内确有像素变化', inside > 0, 'inside=' + inside);
  check('C6b', '蒙版外逐像素零变化', outside === 0, 'outside=' + outside + ' maxDelta=' + maxOut + (outBox ? ' bbox=' + JSON.stringify(outBox) : ''));
} else {
  check('C6', '蒙版比对所需文件齐备', false);
}

let bad = 0;
for (let y = 0; y + 1 < img.height; y += 2) for (let x = 0; x + 1 < img.width; x += 2) {
  const i0 = (y * img.width + x) * 4, i1 = (y * img.width + x + 1) * 4, i2 = ((y + 1) * img.width + x) * 4, i3 = ((y + 1) * img.width + x + 1) * 4;
  for (let c = 0; c < 4; c += 1) {
    if (img.data[i0 + c] !== img.data[i1 + c] || img.data[i0 + c] !== img.data[i2 + c] || img.data[i0 + c] !== img.data[i3 + c]) { bad += 1; break; }
  }
}
check('C7', '2x2 块完全一致（整数倍放大）', bad === 0, '不一致块=' + bad);

console.log('---');
if (fails === 0) { console.log('资产机验通过（含 C3-lie 外轮廓一致、C6 蒙版外零污染）'); process.exit(0); }
console.log('资产机验失败：' + fails + ' 项'); process.exit(1);
