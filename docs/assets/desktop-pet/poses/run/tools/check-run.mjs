// run 批次门禁：纯 Node 零依赖（只依赖同目录 png.mjs），全部断言从磁盘像素复算，不信任 build 输出。
// 用法：node docs/assets/desktop-pet/poses/run/tools/check-run.mjs   （全通过退出 0，任一失败退出 1）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const walkRoot = path.resolve(root, '..', 'walk');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// ---- 判据阈值（取值理由见 README「判据与阈值」）----
export const GATE = {
  marginMin: 8,                 // C3a 四边留白下限
  anchorTolY: 2,                // C3b 支撑帧最低像素与锚点 y 的容差
  contactTolPx: 2,              // C4c contactPoints 与实测容差
  footBandNative: 90,           // 脚段扫描带（native px，≈墨迹高 6%）
  footBandWideNative: 200,      // 腾空帧取证用宽扫描带（脚与裙摆粘连，只作证据）
  contactDepthNative: 3,        // 「着地」定义：该段最低墨迹 y 距地面线 <=3 native px
  graySemiRatio: 0.02,          // C2c 中性灰半透明像素占比上限
  minIslandArea: 4,             // C2b 孤立块下限（native px）
  irisMinArea: 200,             // C10 虹膜连通块最小面积
  irisMinFill: 0.35,            // C10 虹膜填充率下限（虹膜≈0.4-0.5，蝴蝶结描边≈0.10-0.27）
  irisMinOffset: 60,            // C10 虹膜相对头部墨迹质心的水平偏移下限
  perFrameMaxBytes: 2621440,    // C9 单帧硬上限 2.5MB
  mbBytes: 1048576,             // 体积换算
  // C9 批次合计 = 帧数 × 1.9MB。依据 §8 第二次修订：walk 之后 14 个母版实测 1.48–1.76MB/帧，
  // 原 1.65MB/帧 是按 walk 单批定的，对跨步更大的跑姿必然误报（不是放宽，是修正基准）。
  budgetPerFrameMB: 1.9,
  // C9b 全局天花板：sit/lie/sleep/walk/run 五批母版合计 ≤64MB，防「每批贴线、总量爆炸」
  batchTotalGlobalMaxMB: 64,
  // C10b 镜像判据：右向帧 vs 左向帧水平翻转后的差异像素 / 并集墨迹 ≥5%
  mirrorDiffMinRatio: 0.05,
  // C17 bodyAnchor 容差：躯干主轴 x 与声明值、地面线与声明 y、同组帧间 spread
  bodyAnchorTol: 2,
  leanMinFaceForward: 60,       // C14 每帧「面部在躯干前方」的下限（native px）
  leanFirstOverLast: 1.5,       // C14 lean(l1) / lean(l6) 下限
  leanMedianOverWalk: 1.15,     // C14 run 前倾中位数 / walk 前倾中位数
  supportSpanOverWalk: 1.2,     // C14 run 支撑脚 x 跨距 / walk 支撑脚 x 跨距
  headBobOverWalk: 1.5,         // C14 run 头部纵向位移幅度 / walk 同口径
  airborneMinGap: 24,           // C13 腾空间隙可见下限（native px ≈3.7 display px）
};

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? '  ' + detail : ''));
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
  let lowAlpha = 0; let semi = 0; let graySemi = 0; let darkSemi = 0; let grayDirty = 0;
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
      // 「脏边」只算**中性灰且不是白**（亮度 <=210）的半透明像素：
      // 纯白/近白（如 252,252,252）是布料高光/蕾丝的正常抗锯齿，把白色也算灰会让高光多的帧误报。
      // 黑底混色产生的脏边必然偏暗（max 通道远低于 210），因此该收窄不放过真正的脏边。
      if (near && Math.max(r, g, b) <= 210) grayDirty += 1;
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
  return { lowAlpha, semi, graySemi, grayDirty, darkSemi, grayRatio: semi ? grayDirty / semi : 0, tiny, tinyPixels };
}


// ---------- 载入与逐帧实测 ----------
const read = (p) => decodePng(fs.readFileSync(p));
const canvas = manifest.canvas;
const anchor = manifest.anchor;
const GROUND = manifest.contactPoints.groundLine.nativeY;   // 地面线（native）
const ANCHOR_Y_NATIVE = anchor.y / manifest.masterScale;    // 1454

function headCentroid(img, box, bandEnd) {
  let sx = 0; let sy = 0; let n = 0;
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      sx += x; sy += y; n += 1;
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

const analyzed = manifest.frames.map((f) => {
  const masterPath = path.join(root, f.file);
  const nativePath = path.join(root, f.native.file);
  const master = read(masterPath);
  const native = read(nativePath);
  const nBox = bboxOf(native, 1);
  const bandEnd = nBox.top + Math.round(nBox.height * 0.40);
  const feet = footRuns(native, nBox.bottom, GATE.footBandNative)
    .map((r) => ({ ...r, role: r.contactY >= GROUND - GATE.contactDepthNative ? 'support' : 'lifted' }))
    .sort((p, q) => q.contactY - p.contactY);
  const feetWide = footRuns(native, nBox.bottom, GATE.footBandWideNative).sort((p, q) => q.contactY - p.contactY);
  const torsoCx = torsoCentroidX(native, nBox);
  const headC = headCentroid(native, nBox, bandEnd);
  const { iris } = irisBlob(native, nBox, bandEnd);
  const hygiene = alphaHygiene(native);
  const support = feet.find((r) => r.role === 'support') || null;
  const airborneGap = GROUND - nBox.bottom;
  return {
    id: f.id, facing: f.facing, decl: f, masterPath, nativePath, master, native,
    mInfo: pngInfo(masterPath), masterBox: bboxOf(master, 1), nativeBox: nBox,
    feet, feetWide, torsoCx, headC, iris, hygiene, support, airborneGap,
    airborne: support === null,
    phase: support ? ((support.centerX - torsoCx) * f.facing > 0 ? 'front' : 'rear') : null,
    irisOffset: iris && headC ? iris.cx - headC.x : null,
    leanFace: iris && headC ? (iris.cx - torsoCx) * f.facing : null,
    headRel: headC ? headC.y - nBox.bottom : null,
  };
});

// 按朝向分组：本批同时含左向(-1)与右向(+1)帧。
// 跨朝向共用同一个躯干锚点在几何上不成立（尾巴把墨迹拉成不对称形，见 README §2.2 的可行性证明），
// 故「同批躯干零抖动」「支撑脚交替」「加减速」这类判据一律在**同朝向组内**成立，跨组另由 C17 与 C10b 把关。
const groups = new Map();
for (const a of analyzed) {
  const k = a.facing;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(a);
}

const WALK_FALLBACK = { supportSpan: 332.5, headRelRange: 19.0, leanMedian: 100, source: 'fallback 常量（walk 不可读）' };
function walkBaseline() {
  const wm = path.join(walkRoot, 'manifest.json');
  if (!fs.existsSync(wm)) return WALK_FALLBACK;
  const w = JSON.parse(fs.readFileSync(wm, 'utf8'));
  const rows = w.frames.filter((f) => f.facing === -1).map((f) => {
    const img = read(path.join(walkRoot, f.native.file));
    const b = bboxOf(img, 1);
    const bandEnd = b.top + Math.round(b.height * 0.40);
    const feet = footRuns(img, b.bottom, GATE.footBandNative)
      .map((r) => ({ ...r, role: r.contactY >= b.bottom - GATE.contactDepthNative ? 'support' : 'lifted' }))
      .sort((p, q) => q.contactY - p.contactY);
    return {
      support: feet.find((r) => r.role === 'support') || null,
      torso: torsoCentroidX(img, b),
      head: headCentroid(img, b, bandEnd),
      iris: irisBlob(img, b, bandEnd).iris,
      bottom: b.bottom,
    };
  });
  const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const supX = rows.filter((r) => r.support).map((r) => r.support.centerX);
  const headRel = rows.filter((r) => r.head).map((r) => r.head.y - r.bottom);
  // 左向帧：facing=-1，前倾距离 = (虹膜 - 躯干) × facing = 躯干 - 虹膜（正 = 面部在躯干前方）
  const leans = rows.filter((r) => r.iris && r.head).map((r) => r.torso - r.iris.cx);
  return {
    supportSpan: Math.max(...supX) - Math.min(...supX),
    headRelRange: Math.max(...headRel) - Math.min(...headRel),
    leanMedian: median(leans),
    source: 'walk 左向 4 帧实测复算',
  };
}
const walk = walkBaseline();
// ---------- C1 ----------
check('C1a 画布 3072x3072', analyzed.every((a) => a.mInfo.ihdr.width === canvas.width && a.mInfo.ihdr.height === canvas.height),
  analyzed.map((a) => a.id + '=' + a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height).join(' '));
check('C1b 8bit RGBA 非隔行', analyzed.every((a) => a.mInfo.ihdr.bitDepth === 8 && a.mInfo.ihdr.colorType === 6 && a.mInfo.ihdr.interlace === 0),
  analyzed.map((a) => a.id + '=b' + a.mInfo.ihdr.bitDepth + '/ct' + a.mInfo.ihdr.colorType + '/i' + a.mInfo.ihdr.interlace).join(' '));
check('C1c sRGB chunk', analyzed.every((a) => a.mInfo.hasSrgb),
  'missing=' + (analyzed.filter((a) => !a.mInfo.hasSrgb).map((a) => a.id).join(',') || 'none'));

// ---------- C2 ----------
check('C2a alpha<8 必须全透明', analyzed.every((a) => a.hygiene.lowAlpha === 0),
  analyzed.map((a) => a.id + ':' + a.hygiene.lowAlpha).join(' '));
check('C2b 无 <4px 孤立块', analyzed.every((a) => a.hygiene.tiny === 0),
  analyzed.map((a) => a.id + ':' + a.hygiene.tiny).join(' '));
const worstGray = Math.max(...analyzed.map((a) => a.hygiene.grayRatio));
check('C2c 半透明无中性灰脏边（中性灰且亮度<=210 占半透明像素比例 <=2%）', worstGray <= GATE.graySemiRatio,
  'worstRatio=' + (worstGray * 100).toFixed(3) + '% limit=' + (GATE.graySemiRatio * 100) + '% '
  + analyzed.map((a) => a.id + ':' + (a.hygiene.grayRatio * 100).toFixed(2) + '%').join(' '));

// ---------- C3 ----------
const margins = analyzed.map((a) => ({
  id: a.id, left: a.masterBox.left, top: a.masterBox.top,
  right: canvas.width - 1 - a.masterBox.right, bottom: canvas.height - 1 - a.masterBox.bottom,
}));
const minMargin = Math.min(...margins.flatMap((m) => [m.left, m.top, m.right, m.bottom]));
check('C3a 四边留白 >= 8px', minMargin >= GATE.marginMin,
  'min=' + minMargin + 'px ' + margins.map((m) => m.id + '[' + m.left + ',' + m.top + ',' + m.right + ',' + m.bottom + ']').join(' '));
const supportFrames = analyzed.filter((a) => !a.airborne);
const airborneFrames = analyzed.filter((a) => a.airborne);
const supportDiffs = supportFrames.map((a) => Math.abs(a.masterBox.bottom - anchor.y));
check('C3b 支撑帧最低像素与锚点 y 偏差 <= 2px', Math.max(...supportDiffs) <= GATE.anchorTolY,
  supportFrames.map((a, i) => a.id + ':bottom=' + a.masterBox.bottom + '/diff=' + supportDiffs[i]).join(' ')
  + ' | 腾空帧 ' + airborneFrames.map((a) => a.id + ':gap=' + a.airborneGap).join(','));

// ---------- C4 ----------
{
  const problems = [];
  for (const a of analyzed) {
    const d = a.decl;
    if (bytes(a.masterPath) !== d.bytes) problems.push(a.id + '.bytes');
    if (sha256(a.masterPath) !== d.sha256) problems.push(a.id + '.sha256');
    for (const k of ['left', 'top', 'right', 'bottom']) if (d.bbox[k] !== a.masterBox[k]) problems.push(a.id + '.bbox.' + k);
    if (bytes(a.nativePath) !== d.native.bytes) problems.push(a.id + '.native.bytes');
    if (sha256(a.nativePath) !== d.native.sha256) problems.push(a.id + '.native.sha256');
    for (const k of ['left', 'top', 'right', 'bottom']) if (d.native.bbox[k] !== a.nativeBox[k]) problems.push(a.id + '.native.bbox.' + k);
    if (d.native.width !== a.native.width || d.native.height !== a.native.height) problems.push(a.id + '.native.size');
  }
  check('C4a frames[] 母版/归一化图 bytes+sha256+bbox', problems.length === 0,
    problems.length ? problems.join('; ') : analyzed.length + ' 帧逐值一致');
}
{
  const problems = [];
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));
  for (const a of analyzed) {
    const s = byId.get(a.id);
    if (!s) { problems.push(a.id + ' 缺 sources'); continue; }
    const p = path.join(root, s.file);
    if (!fs.existsSync(p)) { problems.push(a.id + ' 文件缺失'); continue; }
    if (bytes(p) !== s.bytes) problems.push(a.id + '.bytes');
    if (sha256(p) !== s.sha256) problems.push(a.id + '.sha256');
    const g = read(p);
    const gb = bboxOf(g, 1);
    for (const k of ['left', 'top', 'right', 'bottom']) if (s.bbox[k] !== gb[k]) problems.push(a.id + '.bbox.' + k);
    if (s.width !== g.width || s.height !== g.height) problems.push(a.id + '.size');
  }
  check('C4b sources[] 直出图 bytes+sha256+bbox', problems.length === 0,
    problems.length ? problems.join('; ') : manifest.sources.length + ' 张直出图逐值一致');
}
{
  const problems = [];
  for (const a of analyzed) {
    const cp = a.decl.contactPoints || {};
    const declSupport = cp.support || null;
    if (a.airborne) {
      if (declSupport !== null) problems.push(a.id + '.support 应为 null');
      if (cp.airborneGap === undefined || cp.airborneGap === null) problems.push(a.id + '.airborneGap 未声明');
      else if (Math.abs(cp.airborneGap - a.airborneGap) > GATE.contactTolPx) problems.push(a.id + '.airborneGap ' + cp.airborneGap + '≠' + a.airborneGap);
    } else {
      if (!declSupport) { problems.push(a.id + '.support 未声明'); continue; }
      const sup = a.support;
      if (Math.abs(sup.centerX - declSupport.centerX) > GATE.contactTolPx) problems.push(a.id + '.support.centerX ' + declSupport.centerX + '≠' + sup.centerX);
      if (Math.abs(sup.contactY - declSupport.contactY) > GATE.contactTolPx) problems.push(a.id + '.support.contactY ' + declSupport.contactY + '≠' + sup.contactY);
      if ((declSupport.role || 'support') !== 'support') problems.push(a.id + '.support.role');
      if (cp.airborneGap !== null && cp.airborneGap !== undefined && cp.airborneGap !== 0) problems.push(a.id + '.airborneGap 应声明 0 或 null');
    }
  }
  check('C4c contactPoints 与实测一致（<=2px；腾空帧 support=null）', problems.length === 0,
    problems.length ? problems.join('; ') : '6 帧 support/airborneGap 全部对上');
}
// ---------- C5 ----------
{
  const r = manifest.batchBboxRange;
  const bad = [];
  for (const a of analyzed) {
    const b = a.masterBox;
    if (b.width < r.minWidth || b.width > r.maxWidth) bad.push(a.id + '.width=' + b.width);
    if (b.height < r.minHeight || b.height > r.maxHeight) bad.push(a.id + '.height=' + b.height);
  }
  check('C5 bbox 在声明区间内', bad.length === 0,
    'width∈[' + r.minWidth + ',' + r.maxWidth + '] height∈[' + r.minHeight + ',' + r.maxHeight + '] ' + (bad.length ? bad.join(',') : analyzed.length + ' 帧通过'));
}
// ---------- C7 ----------
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
// ---------- C8 ----------
{
  const sizes = new Set(analyzed.map((a) => a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height));
  const nativeSizes = new Set(analyzed.map((a) => a.native.width + 'x' + a.native.height));
  const anchors = new Set(analyzed.map((a) => (a.decl.anchor ? a.decl.anchor.x + ',' + a.decl.anchor.y : 'none')));
  const facings = [...new Set(analyzed.map((a) => a.facing))].sort();
  const badFacing = analyzed.filter((a) => a.facing !== -1 && a.facing !== 1).map((a) => a.id);
  const spreads = [...groups.entries()].map(([k, g]) => {
    const xs = g.map((a) => a.torsoCx);
    return { k, spread: Math.max(...xs) - Math.min(...xs), n: g.length };
  });
  const ok = sizes.size === 1 && nativeSizes.size === 1 && anchors.size === 1 && badFacing.length === 0
    && spreads.every((s) => s.spread <= GATE.bodyAnchorTol)
    && manifest.nativeSourceCanvas.width * manifest.masterScale === canvas.width;
  check('C8 同批画布/锚点一致 + 同朝向组内躯干横向零抖动', ok,
    'master=' + [...sizes].join(',') + ' native=' + [...nativeSizes].join(',') + ' anchor=' + [...anchors].join(',')
    + ' facing=' + facings.join('/') + ' | ' + spreads.map((s) => 'facing' + s.k + '(' + s.n + '帧) torsoX spread=' + s.spread.toFixed(1) + 'px').join(' ; '));
}
// ---------- C9 ----------
{
  const total = analyzed.reduce((s, a) => s + bytes(a.masterPath), 0);
  const budget = analyzed.length * GATE.budgetPerFrameMB * GATE.mbBytes;
  const over = analyzed.filter((a) => bytes(a.masterPath) > GATE.perFrameMaxBytes).map((a) => a.id);
  check('C9 体积：单帧 <=2.5MB 且合计 <= 帧数×1.9MB（依据 §8 第二次修订：14 帧实测 1.48–1.76MB/帧）',
    over.length === 0 && total <= budget,
    'total=' + total + 'B(' + (total / GATE.mbBytes).toFixed(2) + 'MB) budget=' + Math.round(budget) + 'B(' + (budget / GATE.mbBytes).toFixed(1) + 'MB)'
    + ' 占比=' + (total / budget * 100).toFixed(1) + '% maxFrame=' + Math.max(...analyzed.map((a) => bytes(a.masterPath))) + 'B'
    + ' minFrame=' + Math.min(...analyzed.map((a) => bytes(a.masterPath))) + 'B'
    + (over.length ? '; 超单帧上限=' + over.join(',') : ''));
}
// ---------- C9b ----------
{
  const batches = ['sit', 'lie', 'sleep', 'walk', 'run'];
  const detail = [];
  let grand = 0;
  for (const b of batches) {
    const dir = path.resolve(root, '..', b);
    if (!fs.existsSync(dir)) { detail.push(b + '=缺失'); continue; }
    const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    const sum = pngs.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    grand += sum;
    detail.push(b + '=' + pngs.length + '帧/' + (sum / GATE.mbBytes).toFixed(2) + 'MB');
  }
  const limit = GATE.batchTotalGlobalMaxMB * GATE.mbBytes;
  check('C9b 全局体积天花板：sit+lie+sleep+walk+run 母版合计 <=64MB', grand <= limit,
    detail.join(' ') + ' | 合计=' + (grand / GATE.mbBytes).toFixed(2) + 'MB / 上限' + GATE.batchTotalGlobalMaxMB + 'MB ('
    + (grand / limit * 100).toFixed(1) + '%)');
}
// ---------- C10 ----------
{
  const rows = analyzed.map((a) => ({ id: a.id, facing: a.facing, off: a.irisOffset, area: a.iris ? a.iris.n : 0 }));
  const bad = rows.filter((r) => r.off === null || Math.sign(r.off) !== r.facing || Math.abs(r.off) < GATE.irisMinOffset);
  const cnt = (f) => rows.filter((r) => r.facing === f).length;
  check('C10 虹膜朝向判据（符号=朝向，|偏移|>=60 native px）', bad.length === 0,
    rows.map((r) => r.id + ':' + Math.round(r.off) + '(n' + Math.round(r.area) + ')').join(' ')
    + ' | 左向 ' + cnt(-1) + ' 帧全为负、右向 ' + cnt(1) + ' 帧全为正');
}
// ---------- C10b ----------
// 镜像判据：把每个右向帧与每个左向帧的水平翻转逐像素比，取差异最小（最像镜像）的那一对。
// 差异比 = 差异像素数 / 并集墨迹像素数（任一帧 alpha>=8 即计入并集）；通道容差 8/255。
// 真重画的右向帧与任何左向帧的镜像都应在姿态/部件侧别上明显不同，差异比远高于 5%。
{
  const lefts = groups.get(-1) || [];
  const rights = groups.get(1) || [];
  const problems = [];
  const rows = [];
  if (!lefts.length || !rights.length) problems.push('缺少左向或右向帧，镜像判据无从比较');
  for (const r of rights) {
    const W = r.native.width;
    const H = r.native.height;
    let worst = null;
    let paired = null;
    for (const l of lefts) {
      let ink = 0; let diff = 0;
      for (let y = 0; y < H; y += 1) {
        const rowR = y * W;
        for (let x = 0; x < W; x += 1) {
          const oR = (rowR + x) * 4;
          const oL = (rowR + (W - 1 - x)) * 4;
          const aR = r.native.data[oR + 3];
          const aL = l.native.data[oL + 3];
          if (aR < 8 && aL < 8) continue;
          ink += 1;
          if (Math.abs(aR - aL) > 8
            || Math.abs(r.native.data[oR] - l.native.data[oL]) > 8
            || Math.abs(r.native.data[oR + 1] - l.native.data[oL + 1]) > 8
            || Math.abs(r.native.data[oR + 2] - l.native.data[oL + 2]) > 8) diff += 1;
        }
      }
      const ratio = ink ? diff / ink : 0;
      const rec = { l: l.id, ratio, ink, diff };
      if (!worst || ratio < worst.ratio) worst = rec;
      if (r.id.slice(1) === l.id.slice(1)) paired = rec;
    }
    rows.push({ id: r.id, worst, paired });
    if (!(worst.ratio >= GATE.mirrorDiffMinRatio)) {
      problems.push(r.id + ' vs mirror(' + worst.l + ')=' + (worst.ratio * 100).toFixed(2) + '%');
    }
  }
  check('C10b 右向帧不是左向帧的镜像（翻转后差异 >=5% 并集墨迹）', problems.length === 0,
    rows.map((x) => x.id + ':min=' + (x.worst.ratio * 100).toFixed(1) + '%(vs mirror ' + x.worst.l + ')'
      + (x.paired ? ' 同序号=' + (x.paired.ratio * 100).toFixed(1) + '%' : '')).join(' ')
    + ' | 阈值>=' + (GATE.mirrorDiffMinRatio * 100) + '%' + (problems.length ? ' | 未通过: ' + problems.join(',') : ''));
}
// ---------- C11 ----------
{
  const parts = [];
  const problems = [];
  for (const [fc, g] of [...groups.entries()].sort((p, q) => p[0] - q[0])) {
    const sup = g.filter((a) => !a.airborne);
    const phases = sup.map((a) => ({ id: a.id, phase: a.phase, fwd: Math.round((a.support.centerX - a.torsoCx) * a.facing) }));
    const alternates = phases.every((p, i) => i === 0 || p.phase !== phases[i - 1].phase);
    const front = phases.filter((p) => p.phase === 'front').length;
    const rear = phases.filter((p) => p.phase === 'rear').length;
    const air = g.filter((a) => a.airborne);
    const airborneOk = air.length >= 1 && air.every((a) => a.support === null);
    if (!alternates) problems.push('facing' + fc + ' 相邻支撑帧同脚');
    if (front < 2 || rear < 2) problems.push('facing' + fc + ' front=' + front + ' rear=' + rear);
    if (!airborneOk) problems.push('facing' + fc + ' 缺少 support=null 的腾空帧');
    parts.push('facing' + fc + ' ' + phases.map((p) => p.id + ':' + p.phase + '(' + p.fwd + ')').join(' ')
      + ' front=' + front + ' rear=' + rear + ' 交替=' + (alternates ? '是' : '否')
      + ' 腾空=' + (air.map((a) => a.id).join(',') || '无'));
  }
  check('C11 支撑脚交替（同朝向组内相邻支撑帧不同脚；每组都有腾空帧 support=null）', problems.length === 0,
    parts.join(' | ') + (problems.length ? ' | 未通过: ' + problems.join(',') : ''));
}
// ---------- C13 ----------
{
  const problems = [];
  if (airborneFrames.length < 1) problems.push('没有 support=null 的腾空帧');
  for (const [fc, g] of [...groups.entries()].sort((p, q) => p[0] - q[0])) {
    if (!g.some((a) => a.airborne)) problems.push('facing' + fc + ' 组内没有腾空帧');
  }
  for (const a of airborneFrames) {
    const decl = (a.decl.contactPoints && a.decl.contactPoints.airborneGap) || 0;
    if (!(a.airborneGap > 0)) problems.push(a.id + '.airborneGap<=0');
    if (a.airborneGap < GATE.airborneMinGap) problems.push(a.id + '.airborneGap=' + a.airborneGap + '<' + GATE.airborneMinGap);
    if (Math.abs(decl - a.airborneGap) > GATE.contactTolPx) problems.push(a.id + '.airborneGap 声明与实测不符');
    for (const r of a.feetWide) if (r.contactY > GROUND - 2) problems.push(a.id + ' 有墨迹贴到地面线 y=' + r.contactY);
    const others = analyzed.filter((b) => b !== a && !b.airborne).map((b) => b.nativeBox.bottom);
    if (!(a.nativeBox.bottom < Math.min(...others) - 10)) problems.push(a.id + ' 未明显高于其它帧');
  }
  check('C13 腾空帧（support=null、airborneGap>0、双脚都高于地面线）', problems.length === 0,
    problems.length ? problems.join('; ')
      : airborneFrames.map((a) => a.id + ':support=null gap=' + a.airborneGap + 'native(' + (a.airborneGap * 2) + 'master) 底部段='
        + a.feetWide.map((r) => r.centerX + '@' + r.contactY).join(',') + ' 地面线=' + GROUND).join(' | '));
}
// ---------- C14 ----------
{
  const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const problems = [];
  const lines = [];
  if (!(walk.leanMedian > 0)) problems.push('walk 前倾基准非正，判据失效（符号口径错）');
  if (!(walk.supportSpan > 0)) problems.push('walk 支撑跨距基准非正，判据失效');
  if (!(walk.headRelRange > 0)) problems.push('walk 头部位移基准非正，判据失效');
  for (const [fc, firstId, lastId] of [[-1, 'l1', 'l6'], [1, 'r1', 'r6']]) {
    const grp = groups.get(fc) || [];
    if (grp.length < 2) { problems.push('facing' + fc + ' 帧数不足'); continue; }
    const pelas = grp.map((a) => ({ id: a.id, lean: a.leanFace, headRel: a.headRel }));
    const byId = new Map(pelas.map((p) => [p.id, p]));
    const leanMedian = median(pelas.map((p) => p.lean));
    const supX = grp.filter((a) => !a.airborne).map((a) => a.support.centerX);
    const supportSpan = Math.max(...supX) - Math.min(...supX);
    const headRels = pelas.map((p) => p.headRel);
    const headBob = Math.max(...headRels) - Math.min(...headRels);
    for (const p of pelas) if (!(p.lean > GATE.leanMinFaceForward)) problems.push(p.id + '.lean=' + Math.round(p.lean));
    if (!(byId.get(firstId).lean >= GATE.leanFirstOverLast * byId.get(lastId).lean)) problems.push('lean(' + firstId + ') 未显著大于 lean(' + lastId + ')');
    if (!(leanMedian >= GATE.leanMedianOverWalk * walk.leanMedian)) problems.push('facing' + fc + ' 前倾中位数未显著大于 walk');
    if (!(supportSpan >= GATE.supportSpanOverWalk * walk.supportSpan)) problems.push('facing' + fc + ' 支撑脚跨距未显著大于 walk');
    if (!(headBob >= GATE.headBobOverWalk * walk.headRelRange)) problems.push('facing' + fc + ' 头部纵向位移未显著大于 walk');
    lines.push('facing' + fc + ' [' + pelas.map((p) => p.id + ':lean=' + Math.round(p.lean) + '/headRel=' + Math.round(p.headRel)).join(' ') + ']'
      + ' lean(' + firstId + ')=' + Math.round(byId.get(firstId).lean) + ' vs lean(' + lastId + ')=' + Math.round(byId.get(lastId).lean)
      + ' (' + (byId.get(firstId).lean / byId.get(lastId).lean).toFixed(2) + 'x>=' + GATE.leanFirstOverLast + ')'
      + ' 中位数=' + Math.round(leanMedian) + '(walk ' + Math.round(walk.leanMedian) + ', ' + (leanMedian / walk.leanMedian).toFixed(2) + 'x)'
      + ' 支撑跨距=' + supportSpan.toFixed(1) + '(walk ' + walk.supportSpan.toFixed(1) + ', ' + (supportSpan / walk.supportSpan).toFixed(2) + 'x)'
      + ' 头部位移=' + headBob.toFixed(1) + '(walk ' + walk.headRelRange.toFixed(1) + ', ' + (headBob / walk.headRelRange).toFixed(2) + 'x)');
  }
  check('C14 前倾与加减速（左右两组分别对比 walk 基准：中位数>=1.15x、跨距>=1.2x、头部位移>=1.5x）',
    problems.length === 0,
    lines.join(' || ') + ' | 基准来源=' + walk.source + (problems.length ? ' | 未通过: ' + problems.join(',') : ''));
}
// ---------- C15 ----------
{
  const hashes = analyzed.map((a) => sha256(a.masterPath));
  const nativeHashes = analyzed.map((a) => sha256(a.nativePath));
  const uniq = new Set(hashes).size;
  const uniqNative = new Set(nativeHashes).size;
  check('C15 6 帧母版/归一化图 sha256 互不相同', uniq === analyzed.length && uniqNative === analyzed.length,
    'master distinct=' + uniq + '/' + analyzed.length + ' native distinct=' + uniqNative + '/' + analyzed.length);
}
// ---------- C16 ----------
{
  const problems = [];
  const common = ['version', 'batch', 'assetId', 'status', 'canvas', 'masterScale', 'colorSpace', 'alpha',
    'bboxConvention', 'normalization', 'nativeSourceCanvas', 'display', 'review', 'notes'];
  const multi = ['anchor', 'bodyAnchor', 'mirrorSafe', 'notMirrorableParts', 'orientation', 'frames', 'sources'];
  for (const k of [...common, ...multi]) if (manifest[k] === undefined) problems.push('缺顶层键 ' + k);
  const rv = manifest.review || {};
  for (const k of ['requiredNow', 'deferredUntilApproval', 'fullBatchComplete']) if (rv[k] === undefined) problems.push('review 缺 ' + k);
  // 左右 12 帧都做完后 fullBatchComplete 才允许为 true，且 requiredNow 必须覆盖全部帧
  const frameIds = manifest.frames.map((f) => f.id);
  if (rv.fullBatchComplete !== true) problems.push('review.fullBatchComplete 必须为 true（12 帧已齐）');
  if (!Array.isArray(rv.requiredNow) || rv.requiredNow.length !== frameIds.length
    || frameIds.some((id) => !rv.requiredNow.includes(id))) problems.push('review.requiredNow 未覆盖全部 ' + frameIds.length + ' 帧');
  if (!Array.isArray(rv.deferredUntilApproval) || rv.deferredUntilApproval.length === 0) problems.push('deferredUntilApproval 为空');
  for (const must of ['jump', 'play', 'edge', 'side', 'mini']) {
    if (!(rv.deferredUntilApproval || []).some((s) => String(s).includes(must))) problems.push('deferredUntilApproval 缺 ' + must);
  }
  if (manifest.nativeSourceCanvas.width * manifest.masterScale !== canvas.width) problems.push('nativeSourceCanvas.width×masterScale≠canvas.width');
  if (manifest.nativeSourceCanvas.height * manifest.masterScale !== canvas.height) problems.push('nativeSourceCanvas.height×masterScale≠canvas.height');
  for (const f of manifest.frames) {
    for (const k of ['id', 'role', 'file', 'native', 'contactPoints']) if (f[k] === undefined) problems.push(f.id + ' 缺 ' + k);
    if (!f.native) continue;
    for (const k of ['width', 'height', 'bytes', 'sha256', 'bbox']) if (f.native[k] === undefined) problems.push(f.id + '.native 缺 ' + k);
    if (f.native.width !== manifest.nativeSourceCanvas.width || f.native.height !== manifest.nativeSourceCanvas.height) {
      problems.push(f.id + '.native 尺寸≠nativeSourceCanvas');
    }
  }
  for (const s of manifest.sources) {
    for (const k of ['file', 'width', 'height', 'bytes', 'sha256', 'bbox']) if (s[k] === undefined) problems.push('sources[' + s.id + '] 缺 ' + k);
  }
  check('C16 §6.1 必备键 + nativeSourceCanvas×masterScale=canvas + fullBatchComplete=true 且 requiredNow 覆盖 12 帧', problems.length === 0,
    problems.length ? problems.join('; ')
      : 'common 14 键 + multi 7 键 + review 3 键齐全；' + manifest.nativeSourceCanvas.width + '×' + manifest.masterScale + '='
        + canvas.width + '；frames ' + manifest.frames.length + ' 条、sources ' + manifest.sources.length + ' 条；deferred=' + manifest.review.deferredUntilApproval.join('/'));
}
// ---------- C17 bodyAnchor ----------
// §6.2：anchor 只管单批内尺寸/命中推导；跨批切换按 bodyAnchor（躯干主轴中心 + 本批地面线）对齐。
// 五条断言：① 每帧实测躯干主轴 x 与声明值差 <=2px；② 声明 x 落在躯干墨迹内（不是画布中线/bbox 中线）；
// ③ 同朝向组内 spread <=2px；④ 声明 y 与本批地面线（= 全批最高墨迹行）差 <=2px；
// ⑤ 若声明了 byFacing，左右两组的 x 必须严格镜像对称（x_left + x_right = native 画布宽）。
{
  const ba = manifest.bodyAnchor || {};
  const problems = [];
  if (typeof ba.x !== 'number' || typeof ba.y !== 'number') problems.push('bodyAnchor 缺数值 x/y');
  if (!ba.estimator) problems.push('bodyAnchor 缺 estimator 说明');
  const byFacing = ba.byFacing || null;
  const declaredFor = (a) => (byFacing && byFacing[String(a.facing)]) ? byFacing[String(a.facing)] : { x: ba.x, y: ba.y };
  const rows = [];
  for (const a of analyzed) {
    const d = declaredFor(a);
    const dx = Math.abs(a.torsoCx - d.x);
    if (dx > GATE.bodyAnchorTol) problems.push(a.id + '.torsoCx=' + a.torsoCx.toFixed(1) + ' 与声明 ' + d.x + ' 差 ' + dx.toFixed(1));
    const bandStart = a.nativeBox.top + Math.round(a.nativeBox.height * 0.45);
    const bandEnd = a.nativeBox.top + Math.round(a.nativeBox.height * 0.85);
    const x = Math.round(d.x);
    let hit = 0;
    for (let y = bandStart; y <= bandEnd; y += 1) {
      const o = (y * a.native.width + x) * 4;
      if (a.native.data[o + 3] >= 200) hit += 1;
    }
    if (hit === 0) problems.push(a.id + ' bodyAnchor.x=' + d.x + ' 不在躯干墨迹内');
    if (x < a.nativeBox.left || x > a.nativeBox.right) problems.push(a.id + ' bodyAnchor.x 落在墨迹 bbox 之外');
    rows.push(a.id + ':' + a.torsoCx.toFixed(1));
  }
  for (const [fc, g] of [...groups.entries()].sort((p, q) => p[0] - q[0])) {
    const xs = g.map((a) => a.torsoCx);
    const sp = Math.max(...xs) - Math.min(...xs);
    if (sp > GATE.bodyAnchorTol) problems.push('facing' + fc + ' 躯干 x spread=' + sp.toFixed(1));
    rows.push('facing' + fc + ' spread=' + sp.toFixed(1));
  }
  const measuredGround = Math.max(...analyzed.map((a) => a.nativeBox.bottom));
  if (typeof ba.y !== 'number' || Math.abs(ba.y - measuredGround) > GATE.bodyAnchorTol) {
    problems.push('bodyAnchor.y=' + ba.y + ' 与实测地面线 ' + measuredGround + ' 差 >' + GATE.bodyAnchorTol);
  }
  if (typeof ba.groundLineNative === 'number' && Math.abs(ba.groundLineNative - measuredGround) > GATE.bodyAnchorTol) {
    problems.push('bodyAnchor.groundLineNative=' + ba.groundLineNative + ' 与实测地面线 ' + measuredGround + ' 不符');
  }
  if (byFacing) {
    const L = byFacing['-1']; const R = byFacing['1'];
    if (!L || !R) problems.push('byFacing 缺 -1 或 1 的声明');
    else if (Math.abs((L.x + R.x) - manifest.nativeSourceCanvas.width) > GATE.bodyAnchorTol) {
      problems.push('左右 bodyAnchor.x 不是镜像对称：' + L.x + '+' + R.x + '≠' + manifest.nativeSourceCanvas.width);
    }
  }
  check('C17 bodyAnchor（躯干墨迹内 / y=地面线±2 / 同朝向组 spread<=2 / 左右镜像对称）', problems.length === 0,
    problems.length ? problems.join('; ')
      : 'x=' + ba.x + (byFacing ? '(左)/' + byFacing['1'].x + '(右)' : '') + ' y=' + ba.y + ' 实测地面线=' + measuredGround
        + ' | ' + rows.join(' '));
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

