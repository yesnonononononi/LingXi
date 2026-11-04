// walk 批次门禁：纯 Node 零依赖（只依赖同目录 png.mjs），全部断言从磁盘像素复算，不信任 build 输出。
// 用法：node docs/assets/desktop-pet/poses/walk/tools/check-walk.mjs   （全通过退出 0，任一失败退出 1）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// ---- 判据阈值（取值理由见 README「判据与阈值」一节）----
export const GATE = {
  marginMin: 8,             // C3a 四边留白下限
  anchorTolY: 2,            // C3b 最低像素与锚点 y 的容差
  contactTolPx: 2,          // C4b contactPoints 与实测容差
  footBandNative: 90,       // 脚部扫描带高（native px，≈墨迹高 3%）
  contactDepthNative: 3,    // 「着地」定义：该脚最低墨迹 y 距整图最低墨迹 y ≤3 native px
  graySemiRatio: 0.02,      // C2c 中性灰半透明像素占比上限
  minIslandArea: 4,         // C2b 孤立块下限（native px）
  irisMinArea: 200,         // C10 虹膜连通块最小面积（native px）
  irisMinFill: 0.35,        // C10 虹膜块填充率下限（区分虹膜 ≈0.4 与蝴蝶结描边 ≈0.15）
  irisMinOffset: 60,        // C10 虹膜相对头部墨迹质心的水平偏移下限（native px；实测最小 116）
  tailMinOffset: 40,        // C12 尾巴必须在身后，偏移下限（native px；实测最小 107）
  bowMinOffset: 15,         // C12 蝴蝶结/发夹必须在前方，偏移下限（native px；实测最小 33）
  mirrorDiffFloor: 0.05,    // C10b 右向帧与任一左向帧镜像后的差异像素占比下限
  perFrameMaxBytes: 2621440,   // C9 单张母版 2.5MB 编码红线
  batchMaxBytes: 13200000,     // C9 本批母版合计上限（见 README 体积说明）
};

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  const line = (ok ? 'PASS ' : 'FAIL ') + id + (detail ? '  ' + detail : '');
  console.log(line);
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function bytes(file) { return fs.statSync(file).size; }

// 逐个 chunk 扫描，读 IHDR 关键字段并检测 sRGB / iCCP / gAMA
function pngInfo(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('不是 PNG: ' + file);
  let offset = 8;
  let ihdr = null;
  const chunks = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    chunks.push(type);
    if (type === 'IHDR') {
      const d = buf.subarray(offset + 8, offset + 8 + length);
      ihdr = { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { ihdr, chunks, hasSrgb: chunks.includes('sRGB') };
}

function bboxOf({ width, height, data }, minA = 1) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < minA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

// 底部带内的脚部段：contactY = 该段内最低墨迹 y 的最大值；inContact = 与整图最低点相差 ≤ contactDepthNative
function footRuns(img, bottom, band) {
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
  const runs = spans.map(([left, right]) => {
    let contactY = -1;
    for (let x = left; x <= right; x += 1) {
      for (let y = bottom; y >= Math.max(0, bottom - band); y -= 1) {
        if (img.data[(y * img.width + x) * 4 + 3] > 128) { if (y > contactY) contactY = y; break; }
      }
    }
    return { left, right, width: right - left + 1, centerX: (left + right) / 2, contactY };
  });
  for (const r of runs) r.role = r.contactY >= bottom - GATE.contactDepthNative ? 'support' : 'lifted';
  return runs.sort((p, q) => q.width - p.width);
}

function torsoCentroidX(img, box) {
  const h = box.bottom - box.top + 1;
  let sx = 0;
  let n = 0;
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

// 深蓝连通块（虹膜）。取「最大且填充率 ≥ irisMinFill」的那块：
// 虹膜是近乎实心的圆块（fill≈0.41~0.50），蝴蝶结/裙摆的深蓝只出现在描边与阴影里（fill≈0.10~0.27）。
function irisBlob(img, box, bandEnd) {
  const mask = new Uint8Array(img.width * img.height);
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
      if (b >= 120 && b - r >= 70 && g <= 165 && r <= 120) mask[y * img.width + x] = 1;
    }
  }
  const seen = new Uint8Array(img.width * img.height);
  const comps = [];
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const s = y * img.width + x;
      if (!mask[s] || seen[s]) continue;
      const stack = [s];
      seen[s] = 1;
      let n = 0; let sx = 0; let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % img.width; const cy = (cur - cx) / img.width;
        n += 1; sx += cx;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
          const k = ny * img.width + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
      const w = maxX - minX + 1; const h = maxY - minY + 1;
      comps.push({ n, cx: sx / n, fill: n / (w * h), w, h });
    }
  }
  comps.sort((p, q) => q.n - p.n);
  const iris = comps.find((c) => c.n >= GATE.irisMinArea && c.fill >= GATE.irisMinFill) || null;
  const runnerUp = comps.find((c) => c !== iris) || null;
  return { iris, runnerUp, count: comps.length };
}

// 粉色尾巴代理：下半身的粉白羽状毛簇
function tailCentroidX(img, box) {
  const midY = box.top + Math.round((box.bottom - box.top + 1) * 0.5);
  let sx = 0; let n = 0;
  for (let y = midY; y <= box.bottom; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
      if (r > 225 && r - g > 20 && g > 150 && b > 150 && Math.abs(g - b) < 25) { sx += x; n += 1; }
    }
  }
  return n > 200 ? { cx: sx / n, n } : { cx: null, n };
}

// 头部带内的浅蓝簇（蝴蝶结 + 云朵发夹的蓝边）
function bowCentroidX(img, box, bandEnd) {
  let sx = 0; let n = 0;
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
      if (b - r >= 45 && b >= 150 && g < b - 20) { sx += x; n += 1; }
    }
  }
  return n > 50 ? { cx: sx / n, n } : { cx: null, n };
}

function headInkCentroidX(img, box, bandEnd) {
  let sx = 0; let n = 0;
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      sx += x; n += 1;
    }
  }
  return n ? sx / n : null;
}

// alpha 卫生：低 alpha 残留、半透明中性灰、<minIslandArea 的孤立块
function alphaHygiene(img) {
  const { width: W, height: H, data } = img;
  let lowAlpha = 0; let semi = 0; let graySemi = 0; let darkSemi = 0;
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4 + 3;
    const a = data[o];
    if (a === 0) continue;
    if (a < 8) { lowAlpha += 1; continue; }
    if (a < 248) {
      semi += 1;
      const r = data[i * 4]; const g = data[i * 4 + 1]; const b = data[i * 4 + 2];
      const near = Math.abs(r - g) <= 6 && Math.abs(g - b) <= 6 && Math.abs(r - b) <= 6;
      if (near) graySemi += 1;
      if (Math.max(r, g, b) < 120) darkSemi += 1;
    }
  }
  // 孤立块：8 邻接连通域面积 < minIslandArea
  const seen = new Uint8Array(W * H);
  let tiny = 0; let tinyPixels = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = y * W + x;
      if (seen[s] || data[s * 4 + 3] === 0) continue;
      const stack = [s]; seen[s] = 1; let n = 0;
      while (stack.length) {
        const cur = stack.pop(); n += 1;
        const cx = cur % W; const cy = (cur - cx) / W;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx; const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = ny * W + nx;
            if (seen[k] || data[k * 4 + 3] === 0) continue;
            seen[k] = 1; stack.push(k);
          }
        }
      }
      if (n < GATE.minIslandArea) { tiny += 1; tinyPixels += n; }
    }
  }
  return { lowAlpha, semi, graySemi, darkSemi, grayRatio: semi ? graySemi / semi : 0, tiny, tinyPixels };
}

// ---------- 载入与逐帧实测 ----------
const read = (p) => decodePng(fs.readFileSync(p));
const analyzed = manifest.frames.map((f) => {
  const masterPath = path.join(root, f.file);
  const nativePath = path.join(root, f.native.file);
  const master = read(masterPath);
  const native = read(nativePath);
  const nBox = bboxOf(native, 1);
  const bandEnd = nBox.top + Math.round(nBox.height * 0.40);
  const feet = footRuns(native, nBox.bottom, GATE.footBandNative);
  const torsoCx = torsoCentroidX(native, nBox);
  const headCx = headInkCentroidX(native, nBox, bandEnd);
  const { iris, runnerUp } = irisBlob(native, nBox, bandEnd);
  const tail = tailCentroidX(native, nBox);
  const bow = bowCentroidX(native, nBox, bandEnd);
  const hygiene = alphaHygiene(native);
  const support = feet.find((r) => r.role === 'support') || null;
  return {
    id: f.id, facing: f.facing, decl: f,
    masterPath, nativePath, master, native, mInfo: pngInfo(masterPath),
    masterBox: bboxOf(master, 1), nativeBox: nBox, feet, torsoCx, headCx, iris, runnerUp,
    tail, bow, hygiene, support,
    phase: support ? ((support.centerX - torsoCx) * f.facing > 0 ? 'front' : 'rear') : null,
    irisOffset: iris && headCx !== null ? iris.cx - headCx : null,
  };
});

const ids = analyzed.map((a) => a.id);
const canvas = manifest.canvas;
const anchor = manifest.anchor;

// ---------- C1 画布 / 位深 / sRGB ----------
check('C1a canvas', analyzed.every((a) => a.mInfo.ihdr.width === canvas.width && a.mInfo.ihdr.height === canvas.height),
  analyzed.map((a) => a.id + '=' + a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height).join(' '));
check('C1b 8bit RGBA 非隔行', analyzed.every((a) => a.mInfo.ihdr.bitDepth === 8 && a.mInfo.ihdr.colorType === 6 && a.mInfo.ihdr.interlace === 0),
  analyzed.map((a) => a.id + '=b' + a.mInfo.ihdr.bitDepth + '/ct' + a.mInfo.ihdr.colorType + '/i' + a.mInfo.ihdr.interlace).join(' '));
check('C1c sRGB chunk', analyzed.every((a) => a.mInfo.hasSrgb),
  'missing=' + (analyzed.filter((a) => !a.mInfo.hasSrgb).map((a) => a.id).join(',') || 'none'));

// ---------- C2 alpha 卫生 ----------
check('C2a alpha<8 必须全透明', analyzed.every((a) => a.hygiene.lowAlpha === 0),
  analyzed.map((a) => a.id + ':' + a.hygiene.lowAlpha).join(' '));
check('C2b 无 <4px 孤立块', analyzed.every((a) => a.hygiene.tiny === 0),
  analyzed.map((a) => a.id + ':' + a.hygiene.tiny).join(' '));
const worstGray = analyzed.reduce((m, a) => Math.max(m, a.hygiene.grayRatio), 0);
check('C2c 半透明无中性灰脏边', worstGray <= GATE.graySemiRatio,
  'worstRatio=' + (worstGray * 100).toFixed(3) + '% (limit ' + (GATE.graySemiRatio * 100) + '%)');

// ---------- C3 bbox 与锚点 ----------
const margins = analyzed.map((a) => ({
  id: a.id,
  left: a.masterBox.left,
  top: a.masterBox.top,
  right: canvas.width - 1 - a.masterBox.right,
  bottom: canvas.height - 1 - a.masterBox.bottom,
}));
const minMargin = Math.min(...margins.flatMap((m) => [m.left, m.top, m.right, m.bottom]));
check('C3a 四边留白 >= 8px', minMargin >= GATE.marginMin,
  'min=' + minMargin + 'px ' + margins.map((m) => m.id + '[' + m.left + ',' + m.top + ',' + m.right + ',' + m.bottom + ']').join(' '));
const bottomDiffs = analyzed.map((a) => Math.abs(a.masterBox.bottom - anchor.y));
check('C3b 最低像素与锚点 y 偏差 <= 2px', Math.max(...bottomDiffs) <= GATE.anchorTolY,
  analyzed.map((a, i) => a.id + ':bottom=' + a.masterBox.bottom + '/diff=' + bottomDiffs[i]).join(' '));

// ---------- C4 manifest 与磁盘逐值对账 ----------
{
  const problems = [];
  for (const a of analyzed) {
    const d = a.decl;
    if (bytes(a.masterPath) !== d.bytes) problems.push(a.id + '.bytes ' + d.bytes + '≠' + bytes(a.masterPath));
    if (sha256(a.masterPath) !== d.sha256) problems.push(a.id + '.sha256');
    for (const k of ['left', 'top', 'right', 'bottom']) {
      if (d.bbox[k] !== a.masterBox[k]) problems.push(a.id + '.bbox.' + k + ' ' + d.bbox[k] + '≠' + a.masterBox[k]);
    }
    if (bytes(a.nativePath) !== d.native.bytes) problems.push(a.id + '.native.bytes');
    if (sha256(a.nativePath) !== d.native.sha256) problems.push(a.id + '.native.sha256');
    for (const k of ['left', 'top', 'right', 'bottom']) {
      if (d.native.bbox[k] !== a.nativeBox[k]) problems.push(a.id + '.native.bbox.' + k);
    }
  }
  check('C4a files[] 母版/归一化图 bytes+sha256+bbox', problems.length === 0, problems.length ? problems.join('; ') : '8/8 帧逐值一致');
}

{
  const problems = [];
  const srcById = new Map(manifest.sources.map((s) => [s.id, s]));
  for (const a of analyzed) {
    const s = srcById.get(a.id);
    if (!s) { problems.push(a.id + ' 缺少 sources 条目'); continue; }
    const p = path.join(root, s.file);
    if (!fs.existsSync(p)) { problems.push(a.id + ' 文件不存在'); continue; }
    if (bytes(p) !== s.bytes) problems.push(a.id + '.bytes');
    if (sha256(p) !== s.sha256) problems.push(a.id + '.sha256');
    const g = read(p);
    const gb = bboxOf(g, 1);
    for (const k of ['left', 'top', 'right', 'bottom']) if (s.bbox[k] !== gb[k]) problems.push(a.id + '.bbox.' + k);
    if (s.width !== g.width || s.height !== g.height) problems.push(a.id + '.size');
  }
  check('C4b sources[] 直出图 bytes+sha256+bbox', problems.length === 0,
    problems.length ? problems.join('; ') : manifest.sources.length + ' 个直出图逐值一致');
}

{
  // 声明口径：contactPoints.support 必填（真实着地点）；contactPoints.lifted 仅在「扫描带内恰好分出两只脚」时必填。
  // 若声明 lifted:null，则实测也必须不是两段——「少报一只脚」和「凭空多报一只脚」都会红。
  const problems = [];
  for (const a of analyzed) {
    const decl = a.decl.contactPoints || {};
    const runs = a.feet;
    if (!decl.support) { problems.push(a.id + '.support 未声明'); continue; }
    const supportRuns = runs.filter((r) => r.role === 'support');
    const sup = supportRuns.reduce((m, r) => (Math.abs(r.centerX - decl.support.centerX) < Math.abs(m.centerX - decl.support.centerX) ? r : m),
      supportRuns[0] || runs[0]);
    if (!sup) { problems.push(a.id + ' 实测无支撑脚'); continue; }
    if (Math.abs(sup.centerX - decl.support.centerX) > GATE.contactTolPx) problems.push(a.id + '.support.centerX ' + decl.support.centerX + '≠' + sup.centerX);
    if (Math.abs(sup.contactY - decl.support.contactY) > GATE.contactTolPx) problems.push(a.id + '.support.contactY ' + decl.support.contactY + '≠' + sup.contactY);
    if (decl.support.role !== 'support') problems.push(a.id + '.support.role');
    const others = runs.filter((r) => r !== sup);
    if (decl.lifted) {
      if (!others.length) { problems.push(a.id + '.lifted 多报（实测只有一段）'); continue; }
      const near = others.reduce((m, r) => (Math.abs(r.centerX - decl.lifted.centerX) < Math.abs(m.centerX - decl.lifted.centerX) ? r : m), others[0]);
      if (Math.abs(near.centerX - decl.lifted.centerX) > GATE.contactTolPx) problems.push(a.id + '.lifted.centerX ' + decl.lifted.centerX + '≠' + near.centerX);
      if (Math.abs(near.contactY - decl.lifted.lowestY) > GATE.contactTolPx) problems.push(a.id + '.lifted.lowestY ' + decl.lifted.lowestY + '≠' + near.contactY);
    } else if (runs.length === 2) {
      problems.push(a.id + '.lifted 漏报（实测可分两段）');
    }
  }
  check('C4c contactPoints 与实测一致（<=2px）', problems.length === 0,
    problems.length ? problems.join('; ') : '8 帧支撑脚 + 可分离的抬起脚全部对上');
}

// ---------- C5 bbox 落在本批声明区间 ----------
{
  const r = manifest.batchBboxRange;
  const bad = [];
  for (const a of analyzed) {
    const b = a.masterBox;
    if (b.width < r.minWidth || b.width > r.maxWidth) bad.push(a.id + '.width=' + b.width);
    if (b.height < r.minHeight || b.height > r.maxHeight) bad.push(a.id + '.height=' + b.height);
  }
  check('C5 bbox 在声明区间内', bad.length === 0,
    'width∈[' + r.minWidth + ',' + r.maxWidth + '] height∈[' + r.minHeight + ',' + r.maxHeight + '] ' + (bad.length ? bad.join(',') : '8/8 通过'));
}

// ---------- C7 母版 = native 的 2x nearest ----------
{
  const reports = [];
  let totalMismatch = 0;
  for (const a of analyzed) {
    const { master, native } = a;
    let mismatch = 0;
    for (let y = 0; y < native.height; y += 1) {
      for (let x = 0; x < native.width; x += 1) {
        const s = (y * native.width + x) * 4;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const t = ((y * 2 + dy) * master.width + (x * 2 + dx)) * 4;
            if (master.data[t] !== native.data[s] || master.data[t + 1] !== native.data[s + 1]
              || master.data[t + 2] !== native.data[s + 2] || master.data[t + 3] !== native.data[s + 3]) mismatch += 1;
          }
        }
      }
    }
    totalMismatch += mismatch;
    reports.push(a.id + ':' + mismatch);
  }
  check('C7 母版 = native 的 2x nearest', totalMismatch === 0, reports.join(' '));
}

// ---------- C8 同批画布 / 锚点口径一致 ----------
{
  const sizes = new Set(analyzed.map((a) => a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height));
  const nativeSizes = new Set(analyzed.map((a) => a.native.width + 'x' + a.native.height));
  const anchors = new Set(analyzed.map((a) => (a.decl.anchor ? a.decl.anchor.x + ',' + a.decl.anchor.y : 'none')));
  const facingCount = new Map();
  for (const a of analyzed) facingCount.set(a.facing, (facingCount.get(a.facing) || 0) + 1);
  const ok = sizes.size === 1 && nativeSizes.size === 1 && anchors.size === 1
    && facingCount.get(-1) === 4 && facingCount.get(1) === 4
    && manifest.nativeSourceCanvas.width * manifest.masterScale === canvas.width;
  check('C8 同批画布/锚点/朝向分组一致', ok,
    'master=' + [...sizes].join(',') + ' native=' + [...nativeSizes].join(',')
    + ' anchor=' + [...anchors].join(',') + ' facing(-1/1)=' + facingCount.get(-1) + '/' + facingCount.get(1));
}

// ---------- C9 体积 ----------
{
  const total = analyzed.reduce((s, a) => s + a.master.data.length * 0, 0) + analyzed.reduce((s, a) => s + bytes(a.masterPath), 0);
  const over = analyzed.filter((a) => bytes(a.masterPath) > GATE.perFrameMaxBytes).map((a) => a.id);
  check('C9 体积：单张 <=2.5MB 且合计 <=上限', over.length === 0 && total <= GATE.batchMaxBytes,
    'total=' + total + 'B(' + (total / 1048576).toFixed(2) + 'MB) limit=' + GATE.batchMaxBytes
    + 'B; maxFrame=' + Math.max(...analyzed.map((a) => bytes(a.masterPath))) + 'B'
    + (over.length ? '; 超单张上限=' + over.join(',') : ''));
}

// ---------- C10 朝向判据 ----------
// 判据：虹膜（头部带内最大的实心深蓝连通块）质心相对头部带墨迹质心的水平偏移。
// 为什么能区分朝向：侧视下双眼长在面部平面，面部朝向前进方向；头后侧被长发与后脑占据，
// 因此虹膜质心总是偏向前方（原图坐标里的符号 = 朝向符号）。镜像一帧会把符号翻过来，必被抓。
{
  const rows = analyzed.map((a) => ({
    id: a.id, facing: a.facing, off: a.irisOffset,
    norm: a.irisOffset === null ? null : a.irisOffset * a.facing,
    irisArea: a.iris ? a.iris.n : 0, irisFill: a.iris ? +a.iris.fill.toFixed(2) : 0,
    runnerUp: a.runnerUp ? +a.runnerUp.n.toFixed(0) : 0,
  }));
  const bad = rows.filter((r) => r.off === null || Math.sign(r.off) !== r.facing || Math.abs(r.off) < GATE.irisMinOffset);
  const leftMean = rows.filter((r) => r.facing === -1).reduce((s, r) => s + r.off, 0) / 4;
  const rightMean = rows.filter((r) => r.facing === 1).reduce((s, r) => s + r.off, 0) / 4;
  check('C10a 虹膜朝向判据（符号=朝向，|偏移|>=60 native px）', bad.length === 0 && leftMean < 0 && rightMean > 0,
    rows.map((r) => r.id + ':' + Math.round(r.off) + '(n' + Math.round(r.irisArea) + ',fill' + r.irisFill + ')').join(' ')
    + ' | 左组均值=' + leftMean.toFixed(0) + ' 右组均值=' + rightMean.toFixed(0));
}

// C10b 右向帧绝不可能由左向帧镜像得到：镜像后差异像素占比必须显著 > 0。
{
  const leftFrames = analyzed.filter((a) => a.facing === -1);
  const rightFrames = analyzed.filter((a) => a.facing === 1);
  const diffs = [];
  for (const r of rightFrames) {
    let best = { l: null, ratio: 1 };
    for (const l of leftFrames) {
      let changed = 0; let union = 0;
      for (let y = 0; y < r.native.height; y += 1) {
        for (let x = 0; x < r.native.width; x += 1) {
          const mx = r.native.width - 1 - x;
          const oR = (y * r.native.width + x) * 4;
          const oL = (y * l.native.width + mx) * 4;
          const aR = r.native.data[oR + 3]; const aL = l.native.data[oL + 3];
          if (aR < 8 && aL < 8) continue;
          union += 1;
          const d = Math.max(Math.abs(r.native.data[oR] - l.native.data[oL]),
            Math.abs(r.native.data[oR + 1] - l.native.data[oL + 1]),
            Math.abs(r.native.data[oR + 2] - l.native.data[oL + 2]),
            Math.abs(aR - aL));
          if (d > 8) changed += 1;
        }
      }
      const ratio = changed / union;
      if (ratio < best.ratio) best = { l: l.id, ratio };
    }
    diffs.push({ id: r.id, mirrorOf: best.l, ratio: best.ratio });
  }
  const minRatio = Math.min(...diffs.map((d) => d.ratio));
  check('C10b 右向帧与左向帧镜像后差异 >= 5%（证明非同源镜像）', minRatio >= GATE.mirrorDiffFloor,
    diffs.map((d) => d.id + ':min vs mirror(' + d.mirrorOf + ')=' + (d.ratio * 100).toFixed(1) + '%').join(' '));
}

// ---------- C11 脚掌交替 ----------
// 判据：支撑脚（着地脚）中心相对躯干质心的前后关系。facing=-1 时 x 更小为前，facing=+1 时 x 更大为前。
// 断言：同向 4 帧里相邻帧的支撑相位必须交替，且 front / rear 各出现 2 次。
{
  const groups = [['左向', analyzed.filter((a) => a.facing === -1)], ['右向', analyzed.filter((a) => a.facing === 1)]];
  const details = [];
  let ok = true;
  for (const [name, frames] of groups) {
    const phases = frames.map((a) => a.phase);
    const alternates = phases.every((p, i) => i === 0 || p !== phases[i - 1]);
    const frontCount = phases.filter((p) => p === 'front').length;
    const rearCount = phases.filter((p) => p === 'rear').length;
    if (!alternates || frontCount !== 2 || rearCount !== 2) ok = false;
    details.push(name + '[' + frames.map((a, i) => a.id + ':' + phases[i] + '(' + Math.round((a.support.centerX - a.torsoCx) * a.facing) + ')').join(' ')
      + '] front=' + frontCount + ' rear=' + rearCount + (alternates ? ' 交替=是' : ' 交替=否'));
  }
  check('C11 支撑脚交替（相邻帧不同脚，每组 front/rear 各 2）', ok, details.join(' | '));
}

// ---------- C12 不对称部件侧别 ----------
// 尾巴（粉白羽簇）在身后，蝴蝶结/云朵发夹（头部浅蓝簇）在前方。两者在 8 帧里归一化后符号必须一致；
// 镜像会把两侧同时翻边，因此这条能抓住「右向其实是左向镜像」。
{
  const rows = analyzed.map((a) => {
    const centerX = (a.nativeBox.left + a.nativeBox.right) / 2;
    const tailOff = a.tail.cx === null ? null : a.tail.cx - centerX;
    const bowOff = a.bow.cx === null ? null : a.bow.cx - centerX;
    return { id: a.id, facing: a.facing, tailOff, bowOff, tailN: a.tail.n, bowN: a.bow.n };
  });
  const badTail = rows.filter((r) => r.tailOff === null || r.tailOff * r.facing > -GATE.tailMinOffset);
  const badBow = rows.filter((r) => r.bowOff === null || r.bowOff * r.facing < GATE.bowMinOffset);
  check('C12 尾巴在身后 / 蝴蝶结发夹在前方，8 帧侧别一致', badTail.length === 0 && badBow.length === 0,
    rows.map((r) => r.id + ':tailNorm=' + Math.round(r.tailOff * r.facing) + ' bowNorm=' + Math.round(r.bowOff * r.facing)).join(' '));
}

// ---------- C13 bodyAnchor（§6.2）----------
// x = 躯干主轴中心（蓝裙簇中段 45%~85% 高度的质心），不是画布中线、也不是 bbox 中线（尾巴把 bbox 拉偏）；
// y = 本批地面线。三条断言：每帧实测 x 与声明差 ≤2px、声明 x 落在躯干墨迹内、同批 spread ≤2px、y 与地面线差 ≤2px。
{
  const TOL = 2;
  const ba = manifest.bodyAnchor || {};
  const problems = [];
  if (typeof ba.x !== 'number' || typeof ba.y !== 'number') problems.push('缺 bodyAnchor.x/y');
  if (!ba.estimator) problems.push('缺 bodyAnchor.estimator 说明');
  const xs = analyzed.map((a) => a.torsoCx);
  const spread = Math.max(...xs) - Math.min(...xs);
  if (spread > TOL) problems.push('同批躯干 x spread=' + spread.toFixed(1) + '>' + TOL);
  for (const a of analyzed) {
    if (Math.abs(a.torsoCx - ba.x) > TOL) problems.push(a.id + '.torsoCx=' + a.torsoCx.toFixed(1) + ' 与声明 ' + ba.x + ' 差 >' + TOL);
    const y0 = a.nativeBox.top + Math.round(a.nativeBox.height * 0.45);
    const y1 = a.nativeBox.top + Math.round(a.nativeBox.height * 0.85);
    let hit = 0;
    for (let y = y0; y <= y1; y += 1) if (a.native.data[(y * a.native.width + Math.round(ba.x)) * 4 + 3] >= 200) hit += 1;
    if (!hit) problems.push(a.id + ' bodyAnchor.x 不在躯干墨迹内');
  }
  const ground = Math.max(...analyzed.map((a) => a.nativeBox.bottom));
  if (Math.abs(ba.y - ground) > TOL) problems.push('bodyAnchor.y=' + ba.y + ' 与本批地面线 ' + ground + ' 差 >' + TOL);
  check('C13 bodyAnchor（落在躯干墨迹内 / y=本批地面线±2 / 同批各帧 spread<=2）', problems.length === 0,
    problems.length ? problems.join('; ')
      : 'x=' + ba.x + ' y=' + ba.y + ' 地面线=' + ground + ' | 实测躯干 x=' + analyzed.map((a) => a.id + ':' + a.torsoCx.toFixed(1)).join(' ') + ' spread=' + spread.toFixed(1));
}

// ---------- 汇总 ----------// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log('');
console.log('--- 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ---');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id + ' (' + f.detail + ')').join(' | '));
  process.exitCode = 1;
} else {
  console.log('全部 PASS');
  process.exitCode = 0;
}

