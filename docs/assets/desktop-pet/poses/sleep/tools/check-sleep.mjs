// sleep 批次门禁：零业务依赖，只用本目录的 PNG 读写工具。
// 设计原则：每条断言都必须能「变红」——没有恒真断言，也没有为了凑绿放宽容差。
// 运行：node docs/assets/desktop-pet/poses/sleep/tools/check-sleep.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const lieNativePath = path.resolve(root, '../lie/source/lie_neutral_native.png');

const EXPECT = {
  canvas: { width: 3072, height: 3072 },
  native: { width: 1536, height: 1536 },
  marginMin: 8,
  alphaClearBelow: 8,
  alphaSolidAt: 248,
  minIslandArea: 4,
  diffTolerance: 8,
  breathBand: { left: 830, top: 646, right: 1350, bottom: 1468 },
  breathBandCenter: { lo: 1050, hi: 1150 },
  breathMinTopShift: 8,
  breathMaxAsymmetry: 4,
  breathDisplayWidth: 234,
  // C8 是二级佐证，主判据是 C7（直接量位移场的幅度与对称性）。
  // 阈值刻意留余量：实测 8.5% 左右，若把线画在 8% 就等于把"当前实测值"抄成"要求"，
  // 任何无害改动（哪怕只是重算路径变了）都会误报，人就会开始无视它。
  breathMinDisplayDiffPct: 6,
  curledMaxIou: 0.75,
  irisRatio: { min: 0.65, max: 0.92 },
};

const results = [];
function check(id, title, fn) {
  try {
    results.push({ id, title, ok: true, detail: fn() });
  } catch (err) {
    results.push({ id, title, ok: false, detail: err.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function readIhdr(file) {
  const buf = fs.readFileSync(file);
  assert(buf.length > 33, 'PNG 头过短');
  assert(buf.readUInt32BE(0) === 0x89504e47, 'PNG 签名不对');
  return {
    width: buf.readUInt32BE(16), height: buf.readUInt32BE(20),
    bitDepth: buf[24], colorType: buf[25], compression: buf[26], filter: buf[27], interlace: buf[28],
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}
function bboxOf(img, minAlpha = 1) {
  let left = img.width, top = img.height, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.data[(y * img.width + x) * 4 + 3] < minAlpha) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom };
}
function inAny(regions, x, y) {
  return regions.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}
function diffStats(a, b, regions) {
  let inside = 0, insideMax = 0, outside = 0, outsideMax = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const o = (y * a.width + x) * 4;
      let d = 0;
      for (let k = 0; k < 4; k += 1) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
      if (d === 0) continue;
      if (inAny(regions, x, y)) { inside += 1; if (d > insideMax) insideMax = d; }
      else { outside += 1; if (d > outsideMax) outsideMax = d; }
    }
  }
  return { insidePixels: inside, insideMaxDelta: insideMax, outsidePixels: outside, outsideMaxDelta: outsideMax };
}
function toDisplay(img, targetW) {
  const scale = img.width / targetW;
  const dw = targetW;
  const dh = Math.round(img.height / scale);
  const out = { width: dw, height: dh, data: Buffer.alloc(dw * dh * 4) };
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(img.height, Math.ceil((y + 1) * scale));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(img.width, Math.ceil((x + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const o = (yy * img.width + xx) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al;
          a += al; n += 1;
        }
      }
      if (!n || a <= 0) continue;
      const t = (y * dw + x) * 4;
      out.data[t] = Math.round(r / a);
      out.data[t + 1] = Math.round(g / a);
      out.data[t + 2] = Math.round(b / a);
      out.data[t + 3] = Math.round(255 * a / n);
    }
  }
  return out;
}
function displayDiffPct(a, b, tolerance) {
  let ink = 0, diff = 0;
  for (let i = 0; i < a.width * a.height; i += 1) {
    const o = i * 4;
    if (a.data[o + 3] <= 40 && b.data[o + 3] <= 40) continue;
    ink += 1;
    let d = 0;
    for (let k = 0; k < 4; k += 1) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
    if (d > tolerance) diff += 1;
  }
  return { ink, diff, pct: ink ? (diff / ink) * 100 : 0 };
}
function iou(a, b) {
  let inter = 0, uni = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const onA = a.data[(y * a.width + x) * 4 + 3] > 40;
      const onB = b.data[(y * b.width + x) * 4 + 3] > 40;
      if (onA && onB) inter += 1;
      if (onA || onB) uni += 1;
    }
  }
  return uni ? inter / uni : 0;
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const frameById = Object.fromEntries(manifest.frames.map((f) => [f.id, f]));
const loadFrame = (id) => {
  const f = frameById[id];
  assert(f, 'manifest 缺少帧 ' + id);
  return { ...f, masterImg: readPng(path.join(root, f.file)), nativeImg: readPng(path.join(root, f.nativeFile)) };
};
const frames = Object.fromEntries(['neutral', 'breathIn', 'breathOut', 'startle', 'curled'].map((id) => [id, loadFrame(id)]));

check('C1', '母版 3072x3072 / native 1536x1536，8bit RGBA 非隔行', () => {
  const lines = [];
  for (const id of Object.keys(frames)) {
    const m = readIhdr(path.join(root, frames[id].file));
    const n = readIhdr(path.join(root, frames[id].nativeFile));
    assert(m.width === EXPECT.canvas.width && m.height === EXPECT.canvas.height, id + ' 母版尺寸 ' + m.width + 'x' + m.height);
    assert(n.width === EXPECT.native.width && n.height === EXPECT.native.height, id + ' native 尺寸 ' + n.width + 'x' + n.height);
    for (const [tag, h] of [['master', m], ['native', n]]) {
      assert(h.bitDepth === 8 && h.colorType === 6, id + ' ' + tag + ' 不是 8bit RGBA (bitDepth=' + h.bitDepth + ' colorType=' + h.colorType + ')');
      assert(h.interlace === 0, id + ' ' + tag + ' 是隔行 PNG');
    }
    lines.push(id + ' ok');
  }
  return lines.join('; ');
});

check('C2', 'alpha<8 全透明、无 248..254 灰边、无小于 4px 孤立块', () => {
  const lines = [];
  for (const id of Object.keys(frames)) {
    for (const [tag, img] of [['master', frames[id].masterImg], ['native', frames[id].nativeImg]]) {
      let low = 0, gray = 0;
      for (let i = 0; i < img.width * img.height; i += 1) {
        const a = img.data[i * 4 + 3];
        if (a !== 0 && a < EXPECT.alphaClearBelow) low += 1;
        else if (a >= EXPECT.alphaSolidAt && a < 255) gray += 1;
      }
      assert(low === 0, id + ' ' + tag + ' 有 ' + low + ' 个 0<alpha<8 像素');
      assert(gray === 0, id + ' ' + tag + ' 有 ' + gray + ' 个 248<=alpha<255 灰边像素');
    }
    lines.push(id + ' low=0 gray=0');
  }
  for (const id of Object.keys(frames)) {
    const img = frames[id].nativeImg;
    const W = img.width, H = img.height;
    const seen = new Uint8Array(W * H);
    let small = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const start = y * W + x;
        if (seen[start] || img.data[start * 4 + 3] === 0) continue;
        const stack = [start];
        seen[start] = 1;
        let n = 0;
        while (stack.length) {
          const cur = stack.pop();
          n += 1;
          const cx = cur % W;
          const cy = (cur - cx) / W;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const next = ny * W + nx;
              if (seen[next] || img.data[next * 4 + 3] === 0) continue;
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
        if (n < EXPECT.minIslandArea) small += n;
      }
    }
    assert(small === 0, id + ' 有面积<4px 孤立块，共 ' + small + ' px');
    lines.push(id + ' islands=0');
  }
  return lines.join('; ');
});
check('C3', '可见包围盒四边留白 >=8px', () => {
  const lines = [];
  for (const id of Object.keys(frames)) {
    const b = bboxOf(frames[id].masterImg);
    const gaps = { left: b.left, top: b.top, right: EXPECT.canvas.width - 1 - b.right, bottom: EXPECT.canvas.height - 1 - b.bottom };
    for (const [k, v] of Object.entries(gaps)) assert(v >= EXPECT.marginMin, id + ' ' + k + ' 留白 ' + v + 'px');
    lines.push(id + ' ' + JSON.stringify(b));
  }
  return lines.join('; ');
});

check('C4', 'manifest 的 bytes/sha256/bbox 与磁盘一致', () => {
  const lines = [];
  for (const id of Object.keys(frames)) {
    const f = frames[id];
    for (const [tag, rel, img] of [['master', f.file, f.masterImg], ['native', f.nativeFile, f.nativeImg]]) {
      const h = readIhdr(path.join(root, rel));
      const rec = f[tag];
      assert(rec, id + ' manifest 缺 ' + tag + ' 记录');
      assert(rec.bytes === h.bytes, id + ' ' + tag + ' bytes ' + rec.bytes + ' != 磁盘 ' + h.bytes);
      assert(rec.sha256 === h.sha256, id + ' ' + tag + ' sha256 不一致');
      assert(rec.width === h.width && rec.height === h.height, id + ' ' + tag + ' 尺寸记录不一致');
      const b = bboxOf(img);
      assert(rec.bbox.left === b.left && rec.bbox.top === b.top && rec.bbox.right === b.right && rec.bbox.bottom === b.bottom,
        id + ' ' + tag + ' bbox ' + JSON.stringify(rec.bbox) + ' != 实测 ' + JSON.stringify(b));
      lines.push(id + '/' + tag);
    }
  }
  return lines.join('; ');
});

check('C5', '母版 = native 的 2x 最近邻（每个 2x2 块四像素相同且等于 native）', () => {
  const lines = [];
  for (const id of Object.keys(frames)) {
    const m = frames[id].masterImg;
    const ni = frames[id].nativeImg;
    let mismatch = 0, bad = 0;
    for (let y = 0; y < m.height; y += 2) {
      for (let x = 0; x < m.width; x += 2) {
        const o = (y * m.width + x) * 4;
        const base = [m.data[o], m.data[o + 1], m.data[o + 2], m.data[o + 3]];
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const p = ((y + dy) * m.width + (x + dx)) * 4;
            let diff = false;
            for (let k = 0; k < 4; k += 1) if (m.data[p + k] !== base[k]) diff = true;
            if (diff) mismatch += 1;
          }
        }
        const n = (Math.floor(y / 2) * EXPECT.native.width + Math.floor(x / 2)) * 4;
        let diffNative = false;
        for (let k = 0; k < 4; k += 1) if (base[k] !== ni.data[n + k]) diffNative = true;
        if (diffNative) bad += 1;
      }
    }
    assert(mismatch === 0, id + ' 有 ' + mismatch + ' 个 2x2 块内部不一致');
    assert(bad === 0, id + ' 有 ' + bad + ' 个块与 native 不同');
    lines.push(id + ' ok');
  }
  return lines.join('; ');
});
// C6 口径（主理人裁定后修正）：
//   「轮廓完全不动」会禁止真正的呼吸（胸腔抬起必然改变 alpha 外轮廓），
//   「按比例整体放大/缩小」才是作弊。所以：允许 ≤2% 的尺寸起伏，但禁止宽高同向变化 >1%。
//   惊醒帧只换眼/嘴/汗滴，外形不该动 → 仍按「与 lie 睁眼帧同轮廓」逐值比对。
check('C6', '呼吸帧允许 ≤2% 尺寸起伏但禁止整体缩放；startle 与 lie 同轮廓', () => {
  const base = bboxOf(frames.neutral.nativeImg, 128);
  const baseW = base.right - base.left + 1;
  const baseH = base.bottom - base.top + 1;
  const lines = ['neutral ' + JSON.stringify(base) + ' ' + baseW + 'x' + baseH];
  for (const id of ['breathIn', 'breathOut']) {
    const b = bboxOf(frames[id].nativeImg, 128);
    const w = b.right - b.left + 1;
    const h = b.bottom - b.top + 1;
    const dw = (w - baseW) / baseW;
    const dh = (h - baseH) / baseH;
    assert(Math.abs(dw) <= 0.02, id + ' 宽度变化 ' + (dw * 100).toFixed(2) + '% > 2%');
    assert(Math.abs(dh) <= 0.02, id + ' 高度变化 ' + (dh * 100).toFixed(2) + '% > 2%');
    assert(!(dw > 0.01 && dh > 0.01), id + ' 宽高同时增大 >1%（' + (dw * 100).toFixed(2) + '% / ' + (dh * 100).toFixed(2) + '%）＝整体放大');
    assert(!(dw < -0.01 && dh < -0.01), id + ' 宽高同时减小 >1%（' + (dw * 100).toFixed(2) + '% / ' + (dh * 100).toFixed(2) + '%）＝整体缩小');
    lines.push(id + ' ' + w + 'x' + h + ' dW=' + (dw * 100).toFixed(2) + '% dH=' + (dh * 100).toFixed(2) + '%');
  }
  // startle：外形必须与 lie 睁眼帧一致（它只换眼/嘴/汗滴）
  assert(fs.existsSync(lieNativePath), '找不到 lie 睁眼基准：' + lieNativePath);
  const lie = readPng(lieNativePath);
  const lieBox = bboxOf(lie, 128);
  const stBox = bboxOf(frames.startle.nativeImg, 128);
  for (const k of ['left', 'top', 'right', 'bottom']) {
    assert(lieBox[k] === stBox[k], 'startle 外轮廓 ' + k + '=' + stBox[k] + ' != lie ' + lieBox[k]);
  }
  lines.push('startle=lie ' + JSON.stringify(lieBox));
  return lines.join('; ');
});

check('C6b', '每帧在「作者声明区域并集」之外与 neutral 逐像素零变化', () => {
  const lines = [];
  const neutral = frames.neutral.nativeImg;
  for (const id of ['breathIn', 'breathOut', 'startle']) {
    const f = frames[id];
    assert(Array.isArray(f.allowedRegions) && f.allowedRegions.length > 0, id + ' 没有声明 allowedRegions');
    const s = diffStats(neutral, f.nativeImg, f.allowedRegions);
    assert(s.outsidePixels === 0, id + ' 声明区域外仍有 ' + s.outsidePixels + ' px 变化 (maxDelta=' + s.outsideMaxDelta + ')');
    assert(s.outsideMaxDelta === 0, id + ' 区域外 maxDelta=' + s.outsideMaxDelta);
    assert(s.insidePixels > 0, id + ' 声明区域内没有任何变化');
    lines.push(id + ' inside=' + s.insidePixels + ' outside=0');
  }
  return lines.join('; ');
});

const topEdgeAt = (img, x) => {
  for (let y = 0; y < img.height; y += 1) {
    if (img.data[(y * img.width + x) * 4 + 3] > 8) return y;
  }
  return -1;
};
// 正数 = b 的墨迹上沿比 a 更靠上（抬升），负数 = 更靠下
const edgeShift = (a, b, lo, hi) => {
  const v = [];
  for (let x = lo; x <= hi; x += 1) {
    const ya = topEdgeAt(a, x);
    const yb = topEdgeAt(b, x);
    if (ya < 0 || yb < 0) continue;
    v.push(ya - yb);
  }
  const mean = v.reduce((s, t) => s + t, 0) / v.length;
  return { n: v.length, mean: +mean.toFixed(1), min: Math.min(...v), max: Math.max(...v) };
};

check('C7', '呼吸两帧只动躯干带；带中央顶边位移 吸气≥+8 / 呼气≤-8 且两侧对称', () => {
  const neutral = frames.neutral.nativeImg;
  const sIn = diffStats(neutral, frames.breathIn.nativeImg, [EXPECT.breathBand]);
  const sOut = diffStats(neutral, frames.breathOut.nativeImg, [EXPECT.breathBand]);
  assert(sIn.insidePixels > 5000, '吸气帧带内变化只有 ' + sIn.insidePixels + ' px');
  assert(sOut.insidePixels > 5000, '呼气帧带内变化只有 ' + sOut.insidePixels + ' px');
  const { lo, hi } = EXPECT.breathBandCenter;
  const lift = edgeShift(neutral, frames.breathIn.nativeImg, lo, hi);
  const drop = edgeShift(frames.breathOut.nativeImg, neutral, lo, hi); // 反向：呼气帧上沿更低 ⇒ 正数=下降
  assert(lift.mean >= EXPECT.breathMinTopShift, '吸气带中央顶边只抬 ' + lift.mean + 'px < ' + EXPECT.breathMinTopShift);
  assert(drop.mean >= EXPECT.breathMinTopShift, '呼气带中央顶边只降 ' + drop.mean + 'px < ' + EXPECT.breathMinTopShift);
  assert(Math.abs(lift.mean - drop.mean) <= EXPECT.breathMaxAsymmetry,
    '吸气/呼气幅度不对称：' + lift.mean + ' vs ' + drop.mean + '（差 > ' + EXPECT.breathMaxAsymmetry + 'px）');
  const lr = (img) => {
    const l = edgeShift(neutral, img, 940, 1040).mean;
    const r = edgeShift(neutral, img, 1140, 1240).mean;
    assert(Math.abs(l - r) <= EXPECT.breathMaxAsymmetry, '左右不对称：左 ' + l + ' vs 右 ' + r + '（差 > ' + EXPECT.breathMaxAsymmetry + 'px）');
    return l + '/' + r;
  };
  const lrIn = lr(frames.breathIn.nativeImg);
  const lrOut = lr(frames.breathOut.nativeImg);
  return 'in=' + sIn.insidePixels + 'px lift=' + lift.mean + '(min' + lift.min + '/max' + lift.max + ') L/R=' + lrIn
    + ' | out=' + sOut.insidePixels + 'px drop=' + drop.mean + '(min' + drop.min + '/max' + drop.max + ') L/R=' + lrOut
    + '  （L/R 为左右各 100 列的顶边位移，正=上移、负=下移）';
});

check('C8', '呼吸两帧在 234px 显示尺度差异 >=6% 墨迹（主判据见 C7）', () => {
  const a = toDisplay(frames.breathIn.masterImg, EXPECT.breathDisplayWidth);
  const b = toDisplay(frames.breathOut.masterImg, EXPECT.breathDisplayWidth);
  const r = displayDiffPct(a, b, EXPECT.diffTolerance);
  assert(r.pct >= EXPECT.breathMinDisplayDiffPct, '显示尺度差异 ' + r.pct.toFixed(2) + '% < ' + EXPECT.breathMinDisplayDiffPct + '%');
  return r.diff + '/' + r.ink + ' = ' + r.pct.toFixed(2) + '%';
});
check('C9', '蜷睡帧轮廓与趴睡帧明显不同（IoU<0.75 且 bbox 至少两处不同）', () => {
  const i = iou(frames.neutral.nativeImg, frames.curled.nativeImg);
  const bn = bboxOf(frames.neutral.nativeImg, 128);
  const bc = bboxOf(frames.curled.nativeImg, 128);
  assert(i < EXPECT.curledMaxIou, '蜷睡与趴睡 IoU=' + i.toFixed(3) + ' >= ' + EXPECT.curledMaxIou);
  const sameEdges = ['left', 'top', 'right', 'bottom'].filter((k) => Math.abs(bn[k] - bc[k]) <= 2).length;
  assert(sameEdges < 2, '蜷睡 bbox 与趴睡几乎相同（' + sameEdges + ' 条边相同）');
  return 'iou=' + i.toFixed(4) + ' neutral=' + JSON.stringify(bn) + ' curled=' + JSON.stringify(bc);
});

check('C10', 'source/ 直出图与 native 齐全，manifest.sources 与磁盘一致', () => {
  const need = ['source/sleep_neutral_generated.png', 'source/eye_mask_native.png', 'source/sleep_curled_generated.png',
    'source/sleep_neutral_native.png', 'source/sleep_curled_native.png',
    'source/sleep_breath_in_native.png', 'source/sleep_breath_out_native.png', 'source/sleep_startle_native.png'];
  for (const rel of need) assert(fs.existsSync(path.join(root, rel)), '缺少 ' + rel);
  assert(Array.isArray(manifest.sources) && manifest.sources.length >= 3, 'manifest.sources 少于 3 项');
  for (const s of manifest.sources) {
    const h = readIhdr(path.join(root, s.file));
    assert(s.bytes === h.bytes, s.file + ' bytes 记录不一致');
    assert(s.sha256 === h.sha256, s.file + ' sha256 记录不一致');
  }
  return need.length + ' files ok; sources=' + manifest.sources.length;
});

check('C11', 'status 为 awaiting-static-review 且未自封 approved', () => {
  assert(manifest.status === 'awaiting-static-review', 'status=' + manifest.status);
  assert(manifest.review && manifest.review.approvedBy === null, 'review.approvedBy 必须为 null');
  assert(Array.isArray(manifest.review.deferredUntilApproval), 'review.deferredUntilApproval 必须是数组');
  return 'status=' + manifest.status + ' approvedBy=null deferred=' + manifest.review.deferredUntilApproval.length;
});

check('C12', '惊醒帧虹膜半径缩小约 15%（蓝色像素比 0.65-0.92）', () => {
  assert(fs.existsSync(lieNativePath), '找不到 lie 睁眼基准');
  const lie = readPng(lieNativePath);
  const isBlue = (img, x, y) => {
    const o = (y * img.width + x) * 4;
    const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    void g;
    return b - r >= 40 && b >= 100;
  };
  let lieBlue = 0, stBlue = 0;
  for (const box of frames.startle.allowedRegions.filter((r) => typeof r.name === 'string' && r.name.indexOf('eye') === 0)) {
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        if (isBlue(lie, x, y)) lieBlue += 1;
        if (isBlue(frames.startle.nativeImg, x, y)) stBlue += 1;
      }
    }
  }
  assert(lieBlue > 1000, 'lie 眼区蓝色像素只有 ' + lieBlue + '，判据失效');
  const ratio = stBlue / lieBlue;
  assert(ratio >= EXPECT.irisRatio.min && ratio <= EXPECT.irisRatio.max,
    '虹膜蓝色像素比 ' + ratio.toFixed(3) + ' 不在 [' + EXPECT.irisRatio.min + ',' + EXPECT.irisRatio.max + ']');
  return 'lie=' + lieBlue + ' startle=' + stBlue + ' ratio=' + ratio.toFixed(3);
});

check('C13', '惊醒帧眼区/嘴区/汗滴区各自都有变化', () => {
  const neutral = frames.neutral.nativeImg;
  const byName = {};
  for (const r of frames.startle.allowedRegions) byName[r.name] = r;
  const out = [];
  for (const name of ['eyeLeft', 'eyeRight', 'mouth', 'sweat']) {
    const r = byName[name];
    assert(r, '缺少声明区域 ' + name);
    const s = diffStats(neutral, frames.startle.nativeImg, [r]);
    assert(s.insidePixels > 0, name + ' 区域没有任何变化');
    out.push(name + '=' + s.insidePixels + 'px');
  }
  return out.join(' ');
});

// C12：§6.1 的共同必备键 + 关键不变量。加这条的理由：本批的契约漂移（nativeCanvas 写成旧名、缺 9 个必备键）
// 之所以能活到验收之后，就是因为自家门禁根本不查这些键 —— 门禁不查 = 没有门禁。
check('C14', '§6.1 共同必备键齐全 + nativeSourceCanvas×masterScale=canvas（防契约漂移）', () => {
  const common = ['version', 'batch', 'assetId', 'status', 'canvas', 'masterScale', 'colorSpace', 'alpha',
    'bboxConvention', 'normalization', 'nativeSourceCanvas', 'display', 'review', 'notes'];
  const multi = ['anchor', 'mirrorSafe', 'notMirrorableParts', 'orientation', 'frames', 'sources'];
  const missing = [...common, ...multi].filter((k) => manifest[k] === undefined);
  assert(missing.length === 0, '缺必备键: ' + missing.join(','));
  assert(manifest.review && manifest.review.requiredNow !== undefined
    && manifest.review.deferredUntilApproval !== undefined
    && manifest.review.fullBatchComplete !== undefined, 'review 缺 requiredNow/deferredUntilApproval/fullBatchComplete');
  assert(Number.isFinite(manifest.masterScale), 'masterScale 必须是数字（引擎要用它做乘法）');
  assert(manifest.nativeSourceCanvas.width * manifest.masterScale === manifest.canvas.width,
    'nativeSourceCanvas.width×masterScale ≠ canvas.width（' + manifest.nativeSourceCanvas.width + '×' + manifest.masterScale + '≠' + manifest.canvas.width + '）');
  assert(manifest.nativeSourceCanvas.height * manifest.masterScale === manifest.canvas.height,
    'nativeSourceCanvas.height×masterScale ≠ canvas.height（' + manifest.nativeSourceCanvas.height + '×' + manifest.masterScale + '≠' + manifest.canvas.height + '）');
  for (const f of manifest.frames) {
    assert(f.native, f.id + ' 缺 native{}');
    assert(f.native.width === manifest.nativeSourceCanvas.width && f.native.height === manifest.nativeSourceCanvas.height,
      f.id + ' 的 native 尺寸 ≠ nativeSourceCanvas');
  }
  return 'common 14 键 + multi 6 键齐全；' + manifest.nativeSourceCanvas.width + '×' + manifest.masterScale
    + '=' + manifest.canvas.width + '；' + manifest.frames.length + ' 帧 native 尺寸与声明一致';
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.id + '  ' + r.title);
  console.log('     ' + r.detail);
}
console.log('');
console.log(failed.length === 0 ? 'ALL ' + results.length + ' CHECKS PASSED' : failed.length + ' CHECK(S) FAILED: ' + failed.map((f) => f.id).join(','));
process.exit(failed.length === 0 ? 0 : 1);
