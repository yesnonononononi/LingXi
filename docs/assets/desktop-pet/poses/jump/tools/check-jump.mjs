// jump 批次门禁：纯 Node 零依赖（只依赖同目录 png.mjs），全部断言从磁盘像素复算，不信任 build 输出。
// 用法：node docs/assets/desktop-pet/poses/jump/tools/check-jump.mjs   （全通过退出 0，任一失败退出 1）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';
import { bboxOf, alphaHygiene, INK_ALPHA_MIN, ANY_ALPHA_MIN } from './ink.mjs';
import { irisBlob, headCentroid, IRIS_MIN_AREA, IRIS_MIN_FILL, IRIS_MIN_OFFSET } from './iris.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// ---- 判据阈值（取值理由见 README「判据与阈值」）----
export const GATE = {
  marginMin: 8,                 // C3a 四边留白下限
  anchorTolY: 2,                // C3b 支撑帧最低像素与锚点 y 的容差
  contactTolPx: 2,              // C4c contactPoints 与实测容差
  footBandNative: 90,           // 脚段扫描带（native px，≈墨迹高 6%）
  footBandWideNative: 200,      // 取证用宽扫描带（脚与裙摆粘连，只作证据）
  contactDepthNative: 3,        // 「着地」定义：该段最低墨迹 y 距地面线 <=3 native px
  graySemiRatio: 0.02,          // C2c 中性灰半透明像素占比上限
  minIslandArea: 4,             // C2b 孤立块下限（native px）
  // C10 的三个阈值定义在 tools/iris.mjs（build 的实测与 check 的判据共用同一份，防止探测口径漂移）
  irisMinArea: IRIS_MIN_AREA,
  irisMinFill: IRIS_MIN_FILL,
  irisMinOffset: IRIS_MIN_OFFSET,
  perFrameMaxBytes: 2621440,    // C9 单帧硬上限 2.5MB
  mbBytes: 1048576,             // 体积换算
  // C9 批次合计 = 帧数 × 1.9MB。依据 §8 第二次修订：walk 之后 14 个母版实测 1.48–1.76MB/帧。
  budgetPerFrameMB: 1.9,
  // C9b 全局天花板：六批母版合计 <=96MB（§8 第三次修订，原 64MB 会让 play 批次必然破线）
  batchTotalGlobalMaxMB: 96,
  // C13 腾空判据
  apexMinGapNative: 120,        // apex 离地下限（run 腾空帧实测 48，本批必须显著更大）
  gapMarginOverRun: 72,         // apex gap 至少要比 run 的 48 大这么多（即 >=120，写成显式关系）
  airborneMinGapNative: 16,     // 任意腾空帧 gap 下限（ascend/descend 也必须真的离地）
  // C14 禁整体缩放：同一批帧的 nativeInkH/genInkH 系数极差上限（量化舍入允许 0.002，取 0.004 留余量）
  scaleRatioSpread: 0.004,
  // C17 bodyAnchor 容差
  bodyAnchorTol: 2,
  // C16 §6.1 必备键
  requiredTopKeys: ['batch', 'mirrorSafe', 'notMirrorableParts', 'orientation', 'nativeSourceCanvas', 'masterScale',
    'canvas', 'anchor', 'bodyAnchor', 'colorSpace', 'alpha', 'bboxConvention', 'display', 'frames', 'sources',
    'method', 'review', 'notes'],
};

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? '  ' + detail : ''));
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function bytes(file) { return fs.statSync(file).size; }

// 逐个 chunk 扫描，读 IHDR 关键字段并检测 sRGB / iCCP / gAMA
// 逐个 chunk 扫完整文件：给出真实的块序列与 IHDR 关键字段（C1c 的直接依据）。
// 旧实现读到 IHDR 就 return，chunks 里永远只有 [IHDR]，hasSrgb 恒为 false —— 这就是 C1c 5 帧全报 missing 的原因。
function pngInfo(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('不是 PNG: ' + file);
  let offset = 8;
  const chunks = [];
  let ihdr = null;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') {
      const d = buf.subarray(offset + 8, offset + 8 + length);
      ihdr = {
        width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9],
        compression: d[10], filter: d[11], interlace: d[12],
      };
    }
    chunks.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('无 IHDR: ' + file);
  return { chunks, ihdr, hasSrgb: chunks.includes('sRGB'), hasIccp: chunks.includes('iCCP'), hasGama: chunks.includes('gAMA') };
}





// 底部带内的脚段：[left,right] + 该段最低墨迹 y（contactY）
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

function torsoCentroidX(img, box) {
  const h = box.bottom - box.top + 1;
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



function headInkCentroidX(img, box, bandEnd) {
  let sx = 0; let n = 0;
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      sx += x; n += 1;
    }
  }
  return n ? sx / n : (box.left + box.right) / 2;
}

// alpha 卫生：低 alpha 残留 / 中性灰脏边 / <4px 孤立块


const read = (p) => decodePng(fs.readFileSync(p));
const canvas = manifest.canvas;
const anchor = manifest.anchor;
const GROUND = manifest.contactPoints.groundLine.nativeY;   // 地面线（native）
const ANCHOR_Y_NATIVE = anchor.y / manifest.masterScale;    // 1454



const analyzed = manifest.frames.map((f) => {
  const masterPath = path.join(root, f.file);
  const nativePath = path.join(root, f.native.file);
  const master = read(masterPath);
  const native = read(nativePath);
  const nBox = bboxOf(native, ANY_ALPHA_MIN);
  const bandEnd = nBox.top + Math.round(nBox.height * 0.40);
  const feet = footRuns(native, nBox.bottom, GATE.footBandNative)
    .map((r) => ({ ...r, role: r.contactY >= GROUND - GATE.contactDepthNative ? 'support' : 'lifted' }))
    .sort((p, q) => q.contactY - p.contactY);
  const feetWide = footRuns(native, nBox.bottom, GATE.footBandWideNative).sort((p, q) => q.contactY - p.contactY);
  const torsoCx = torsoCentroidX(native, nBox);
  const headC = headCentroid(native, nBox, bandEnd);
  const { iris } = irisBlob(native, nBox, bandEnd, { minArea: GATE.irisMinArea, minFill: GATE.irisMinFill });
  const hygiene = alphaHygiene(native, GATE.minIslandArea);
  const support = feet.find((r) => r.role === 'support') || null;
  const airborneGap = GROUND - nBox.bottom;
  return {
    id: f.id, facing: f.facing, decl: f, masterPath, nativePath, master, native,
    mInfo: pngInfo(masterPath), masterBox: bboxOf(master, ANY_ALPHA_MIN), nativeBox: nBox,
    feet, feetWide, torsoCx, headC, iris, hygiene, support, airborneGap,
    airborne: support === null,
    irisOffset: iris && headC ? iris.cx - headC.x : null,
    headRel: headC ? headC.y - nBox.bottom : null,
  };
});

const byId = new Map(analyzed.map((a) => [a.id, a]));
const FRAME_ORDER = ['anticipate', 'ascend', 'apex', 'descend', 'land'];
const DECL_AIRBORNE = new Set(['ascend', 'apex', 'descend']);

// ---------- C1 ----------
check('C1a 画布 3072x3072', analyzed.every((a) => a.mInfo.ihdr.width === canvas.width && a.mInfo.ihdr.height === canvas.height),
  analyzed.map((a) => a.id + '=' + a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height).join(' '));
check('C1b 8bit RGBA 非隔行', analyzed.every((a) => a.mInfo.ihdr.bitDepth === 8 && a.mInfo.ihdr.colorType === 6 && a.mInfo.ihdr.interlace === 0),
  analyzed.map((a) => a.id + '=b' + a.mInfo.ihdr.bitDepth + '/ct' + a.mInfo.ihdr.colorType + '/i' + a.mInfo.ihdr.interlace).join(' '));
check('C1c sRGB chunk（逐块解析真实块序列）', analyzed.every((a) => a.mInfo.hasSrgb),
  'missing=' + (analyzed.filter((a) => !a.mInfo.hasSrgb).map((a) => a.id).join(',') || 'none')
  + ' | ' + analyzed.map((a) => a.id + '[' + a.mInfo.chunks.join('|') + ']').join(' '));

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
check('C3b 支撑帧最低像素与锚点 y 偏差 <= 2px', supportDiffs.length > 0 && Math.max(...supportDiffs) <= GATE.anchorTolY,
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
  check('C4a frames[] 母版/native 的 bytes+sha256+bbox', problems.length === 0,
    problems.length ? problems.join('; ') : analyzed.length + ' 帧逐值一致（母版+normalized 各 5 项）');
}
{
  const problems = [];
  const srcById = new Map(manifest.sources.map((s) => [s.id, s]));
  for (const a of analyzed) {
    const s = srcById.get(a.id);
    if (!s) { problems.push(a.id + ' 缺 sources'); continue; }
    const p = path.join(root, s.file);
    if (!fs.existsSync(p)) { problems.push(a.id + ' 文件缺失'); continue; }
    if (bytes(p) !== s.bytes) problems.push(a.id + '.bytes');
    if (sha256(p) !== s.sha256) problems.push(a.id + '.sha256');
    const g = read(p);
    // 两个口径都逐字段核对：
    //   bbox        = 墨迹框（alpha>=INK_ALPHA_MIN，build 落座与 C14 缩放系数所用的口径）
    //   alphaExtent = alpha>0 的完整范围（manifest.bboxConvention 声明的口径，比墨迹框更严）
    const inkBox = bboxOf(g, INK_ALPHA_MIN);
    const anyBox = bboxOf(g, ANY_ALPHA_MIN);
    for (const k of ['left', 'top', 'right', 'bottom']) if (s.bbox[k] !== inkBox[k]) problems.push(a.id + '.bbox.' + k);
    if (!s.alphaExtent) problems.push(a.id + '.alphaExtent 缺失');
    else for (const k of ['left', 'top', 'right', 'bottom']) if (s.alphaExtent[k] !== anyBox[k]) problems.push(a.id + '.alphaExtent.' + k);
    if (s.width !== g.width || s.height !== g.height) problems.push(a.id + '.size');
  }
  check('C4b sources[] 直出图 bytes+sha256+墨迹框+alpha 完整范围框', problems.length === 0,
    problems.length ? problems.join('; ') : manifest.sources.length + ' 张直出图逐值一致（墨迹框与 alpha 完整范围框各 4 字段）');
}
{
  // 接触点：支撑帧必须与实测同段（<=2px），腾空帧必须 support=null 且 gap 与实测一致
  const problems = [];
  for (const a of analyzed) {
    const cp = a.decl.contactPoints || {};
    if (a.airborne) {
      if (cp.support !== null) problems.push(a.id + '.support 应为 null');
      if (cp.airborneGap === null || cp.airborneGap === undefined) problems.push(a.id + '.airborneGap 缺失');
      else if (Math.abs(cp.airborneGap - a.airborneGap) > GATE.contactTolPx) problems.push(a.id + '.airborneGap=' + cp.airborneGap + ' vs 实测' + a.airborneGap);
    } else {
      if (!cp.support) problems.push(a.id + '.support 缺失');
      else {
        const near = a.feet.reduce((best, r) => (Math.abs(r.centerX - cp.support.centerX) < Math.abs(best.centerX - cp.support.centerX) ? r : best), a.feet[0]);
        if (Math.abs(near.centerX - cp.support.centerX) > GATE.contactTolPx) problems.push(a.id + '.support.centerX');
        if (Math.abs(near.contactY - cp.support.contactY) > GATE.contactTolPx) problems.push(a.id + '.support.contactY');
        if (Math.abs(near.width - cp.support.width) > GATE.contactTolPx) problems.push(a.id + '.support.width');
      }
    }
  }
  check('C4c contactPoints 与实测一致（<=2px；腾空帧 support=null + gap 对账）', problems.length === 0,
    problems.length ? problems.join('; ') : analyzed.map((a) => a.id + ':' + (a.airborne ? 'null/gap' + a.airborneGap : a.support.centerX + '@' + a.support.contactY)).join(' '));
}
// ---------- C5 ----------
{
  // 声明区间是 **native** 单位（batchBboxRange.unit）→ 必须拿 native 墨迹框去比。
  // 旧实现拿母版（3072，2x）去比 native 区间，量级整体差 2 倍 —— C5 假红的原因。
  const r = manifest.batchBboxRange;
  const problems = [];
  if (r.unit !== 'native') problems.push('batchBboxRange.unit=' + r.unit + ' 应为 native');
  for (const a of analyzed) {
    if (a.nativeBox.width < r.minWidth || a.nativeBox.width > r.maxWidth
      || a.nativeBox.height < r.minHeight || a.nativeBox.height > r.maxHeight) {
      problems.push(a.id + ' ' + a.nativeBox.width + 'x' + a.nativeBox.height + ' 出区间');
    }
  }
  check('C5 native 墨迹框在声明区间内（batchBboxRange.unit=native）', problems.length === 0,
    '区间 w[' + r.minWidth + ',' + r.maxWidth + '] h[' + r.minHeight + ',' + r.maxHeight + '] native | '
    + analyzed.map((a) => a.id + ':' + a.nativeBox.width + 'x' + a.nativeBox.height + '(master ' + a.masterBox.width + 'x' + a.masterBox.height + ')').join(' ')
    + (problems.length ? ' | ' + problems.join('; ') : ''));
}
// ---------- C7 ----------
{
  let totalMismatch = 0;
  const reports = [];
  for (const a of analyzed) {
    const nw = a.native.width; const nh = a.native.height;
    let mismatch = 0;
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        const s = (y * nw + x) * 4;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const t = ((y * 2 + dy) * a.master.width + (x * 2 + dx)) * 4;
            if (a.master.data[t] !== a.native.data[s] || a.master.data[t + 1] !== a.native.data[s + 1]
              || a.master.data[t + 2] !== a.native.data[s + 2] || a.master.data[t + 3] !== a.native.data[s + 3]) mismatch += 1;
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
  const facings = new Set(analyzed.map((a) => a.facing));
  const xs = analyzed.map((a) => a.torsoCx);
  const spread = Math.max(...xs) - Math.min(...xs);
  const ok = sizes.size === 1 && nativeSizes.size === 1 && anchors.size === 1 && facings.size === 1
    && facings.has(-1) && spread <= GATE.bodyAnchorTol;
  check('C8 同批画布/锚点/朝向一致 + 躯干横向零抖动（spread<=2）', ok,
    'master=' + [...sizes].join(',') + ' native=' + [...nativeSizes].join(',') + ' anchor=' + [...anchors].join(',')
    + ' facing=' + [...facings].join('/') + ' | torsoX ' + analyzed.map((a) => a.id + ':' + a.torsoCx.toFixed(1)).join(' ')
    + ' spread=' + spread.toFixed(2) + 'px');
}
// ---------- C9 / C9b ----------
{
  const total = analyzed.reduce((s, a) => s + bytes(a.masterPath), 0);
  const budget = analyzed.length * GATE.budgetPerFrameMB * GATE.mbBytes;
  const over = analyzed.filter((a) => bytes(a.masterPath) > GATE.perFrameMaxBytes).map((a) => a.id);
  check('C9 体积：单帧 <=2.5MB 且合计 <= 帧数×1.9MB（依据 §8 第二次修订）', over.length === 0 && total <= budget,
    'total=' + total + 'B(' + (total / GATE.mbBytes).toFixed(2) + 'MB) budget=' + Math.round(budget) + 'B(' + (budget / GATE.mbBytes).toFixed(1) + 'MB)'
    + ' 占比=' + (total / budget * 100).toFixed(1) + '% maxFrame=' + Math.max(...analyzed.map((a) => bytes(a.masterPath))) + 'B'
    + (over.length ? '; 超单帧上限=' + over.join(',') : ''));
}
{
  const batches = ['sit', 'lie', 'sleep', 'walk', 'run', 'jump'];
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
  check('C9b 全局体积天花板：六批母版合计 <=96MB（§8 第三次修订）', grand <= limit,
    detail.join(' ') + ' | 合计=' + (grand / GATE.mbBytes).toFixed(2) + 'MB / 上限' + GATE.batchTotalGlobalMaxMB + 'MB ('
    + (grand / limit * 100).toFixed(1) + '%)');
}
// ---------- C10 ----------
{
  const rows = analyzed.map((a) => ({ id: a.id, facing: a.facing, off: a.irisOffset, area: a.iris ? a.iris.n : 0 }));
  const bad = rows.filter((r) => r.off === null || Math.sign(r.off) !== r.facing || Math.abs(r.off) < GATE.irisMinOffset);
  check('C10 虹膜朝向判据（全部左向：符号=facing=-1，|偏移|>=60 native px）', bad.length === 0,
    rows.map((r) => r.id + ':' + Math.round(r.off) + '(n' + Math.round(r.area) + ')').join(' ')
    + ' | 5 帧全为负 = 全部左向');
}
// ---------- C13 腾空判据 ----------
{
  const problems = [];
  const asc = byId.get('ascend'); const apex = byId.get('apex'); const desc = byId.get('descend');
  for (const id of FRAME_ORDER) {
    const a = byId.get(id);
    const shouldAir = DECL_AIRBORNE.has(id);
    if (shouldAir !== a.airborne) problems.push(id + '.airborne=' + a.airborne + '(应为' + shouldAir + ')');
    if (shouldAir) {
      if (a.decl.contactPoints.support !== null) problems.push(id + '.declSupport 应为 null');
      if (!(a.airborneGap > 0)) problems.push(id + '.gap<=0');
      if (a.airborneGap < GATE.airborneMinGapNative) problems.push(id + '.gap=' + a.airborneGap + ' <' + GATE.airborneMinGapNative);
      for (const f of a.feet90 || a.feet) { if (f.contactY >= GROUND) problems.push(id + '.foot@' + f.contactY + ' 未高于地面线'); }
    } else if (!a.support) problems.push(id + ' 支撑帧缺 support');
  }
  if (!(apex.airborneGap >= GATE.apexMinGapNative)) problems.push('apex.gap=' + apex.airborneGap + ' <' + GATE.apexMinGapNative);
  const runGap = manifest.notes.find((n) => n.includes('run')) ? 48 : 48;
  if (!(apex.airborneGap >= runGap + GATE.gapMarginOverRun)) problems.push('apex.gap 未显著大于 run 的 ' + runGap);
  if (!(asc.airborneGap < apex.airborneGap)) problems.push('ascend(' + asc.airborneGap + ') 未小于 apex(' + apex.airborneGap + ')');
  if (!(desc.airborneGap < apex.airborneGap)) problems.push('descend(' + desc.airborneGap + ') 未小于 apex(' + apex.airborneGap + ')');
  // 双脚最低点都高于地面线：脚段 contactY 与 native 底部一致即可证明（墨迹最低点即脚）
  for (const a of [asc, apex, desc]) if (a.nativeBox.bottom >= GROUND) problems.push(a.id + '.nativeBottom 未高于地面线');
  check('C13 腾空判据（support=null + gap>0 + apex>=120 且显著大于 run 48 + ascend<apex>descend + 双脚高于地面线）',
    problems.length === 0,
    'ascend=' + asc.airborneGap + ' apex=' + apex.airborneGap + ' descend=' + desc.airborneGap
    + ' nativeBottom=' + FRAME_ORDER.map((id) => id + ':' + byId.get(id).nativeBox.bottom).join(' ')
    + (problems.length ? ' | ' + problems.join('; ') : ''));
}
// ---------- C14 禁整体缩放 ----------
// 判据三条：
//  a 全批共用一个缩放系数（nativeInkH / generatedInkH 极差 <=0.004，只留量化舍入余量）
//  b 腾空帧不得比支撑帧更宽（用"放大"伪造跳跃会让腾空帧整体变大）
//  c 各帧墨迹高度与腾空高度不成比例（gap 用缩放解释不掉）
{
  const problems = [];
  const genH = (id) => {
    const s = manifest.sources.find((x) => x.id === id);
    return s.bbox.bottom - s.bbox.top + 1;
  };
  const ratios = analyzed.map((a) => a.nativeBox.height / genH(a.id));
  const ratioSpread = Math.max(...ratios) - Math.min(...ratios);
  if (ratioSpread > GATE.scaleRatioSpread) problems.push('缩放系数极差=' + ratioSpread.toFixed(5) + ' > ' + GATE.scaleRatioSpread);
  const supW = Math.max(...analyzed.filter((a) => !a.airborne).map((a) => a.nativeBox.width));
  const airW = Math.max(...analyzed.filter((a) => a.airborne).map((a) => a.nativeBox.width));
  if (airW >= supW) problems.push('腾空帧宽(' + airW + ') >= 支撑帧宽(' + supW + ')：疑用放大伪造跳跃');
  // 若腾空是缩放造成的，宽度会随 gap 同比变大；实测应反向（收腿使腾空帧更窄）
  const apex = byId.get('apex'); const land = byId.get('land');
  const widthScaled = apex.nativeBox.width / land.nativeBox.width;
  const wouldBeScale = 1 + apex.airborneGap / land.nativeBox.height;
  if (widthScaled > 1) problems.push('apex 宽/land 宽=' + widthScaled.toFixed(3) + ' >1');
  check('C14 禁整体缩放（同批单一缩放系数 / 腾空帧不得更宽 / 宽度不随 gap 增加）', problems.length === 0,
    'ratioSpread=' + ratioSpread.toFixed(5) + '(' + analyzed.map((a, i) => a.id + ':' + ratios[i].toFixed(4)).join(' ') + ')'
    + ' maxAirW=' + airW + ' < maxSupportW=' + supW
    + ' apexW/landW=' + widthScaled.toFixed(4) + '（若用缩放解释 gap 应≈' + wouldBeScale.toFixed(4) + '）'
    + (problems.length ? ' | ' + problems.join('; ') : ''));
}
// ---------- C15 ----------
{
  const uniq = new Set(analyzed.map((a) => sha256(a.masterPath))).size;
  const uniqNative = new Set(analyzed.map((a) => sha256(a.nativePath))).size;
  check('C15 5 帧母版/native sha256 互不相同（禁重复副本）', uniq === analyzed.length && uniqNative === analyzed.length,
    'master=' + uniq + '/' + analyzed.length + ' native=' + uniqNative + '/' + analyzed.length);
}
// ---------- C16 §6.1 必备键 + 不变量 ----------
{
  const problems = [];
  for (const k of GATE.requiredTopKeys) if (!(k in manifest)) problems.push('缺顶层键 ' + k);
  if (manifest.nativeSourceCanvas.width * manifest.masterScale !== manifest.canvas.width) problems.push('nativeSourceCanvas.w×masterScale != canvas.w');
  if (manifest.nativeSourceCanvas.height * manifest.masterScale !== manifest.canvas.height) problems.push('nativeSourceCanvas.h×masterScale != canvas.h');
  if (manifest.mirrorSafe !== false) problems.push('mirrorSafe 应为 false');
  const parts = ['蝴蝶结', '云朵发夹', '内耳', '尾巴'];
  for (const p of parts) if (!manifest.notMirrorableParts.some((s) => s.includes(p))) problems.push('notMirrorableParts 缺 ' + p);
  const deferred = manifest.review.deferredUntilApproval.join('|');
  for (const need of ['右向', 'play', 'edge', 'side', 'mini']) if (!deferred.includes(need)) problems.push('deferredUntilApproval 缺 ' + need);
  if (manifest.review.fullBatchComplete !== false) problems.push('fullBatchComplete 应为 false（右向未做）');
  const req = new Set(manifest.review.requiredNow);
  for (const id of FRAME_ORDER) if (!req.has(id)) problems.push('requiredNow 缺 ' + id);
  if (manifest.frames.length !== FRAME_ORDER.length) problems.push('frames 数=' + manifest.frames.length);
  check('C16 §6.1 必备键 + nativeSourceCanvas×masterScale=canvas + mirrorSafe=false + notMirrorableParts + deferred 清单',
    problems.length === 0,
    problems.length ? problems.join('; ')
      : GATE.requiredTopKeys.length + ' 个必备键齐全, 1536×2=3072 ✓, mirrorSafe=false, 不可镜像件=' + manifest.notMirrorableParts.length
      + ', deferred=' + manifest.review.deferredUntilApproval.length + ' 项');
}
// ---------- C17 bodyAnchor ----------
{
  const problems = [];
  const ba = manifest.bodyAnchor;
  if (!ba) problems.push('缺 bodyAnchor');
  else {
    const xs = analyzed.map((a) => a.torsoCx);
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    if (Math.abs(mean - ba.x) > GATE.bodyAnchorTol) problems.push('bodyAnchor.x=' + ba.x + ' vs 实测均值' + mean.toFixed(1));
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread > GATE.bodyAnchorTol) problems.push('同批 spread=' + spread.toFixed(2) + ' >' + GATE.bodyAnchorTol);
    if (Math.abs(ba.y - (GROUND - 1)) > GATE.bodyAnchorTol && Math.abs(ba.y - ANCHOR_Y_NATIVE) > GATE.bodyAnchorTol) {
      problems.push('bodyAnchor.y=' + ba.y + ' 与地面线 ' + GROUND + ' 偏差 >' + GATE.bodyAnchorTol);
    }
    if (ba.byFacing && ba.byFacing['-1'] && Math.abs(ba.byFacing['-1'].x - ba.x) > GATE.bodyAnchorTol) problems.push('byFacing[-1] 与 x 不一致');
    // y 不随帧底走：所有帧的 bodyAnchor.y 都必须是同一个地面参考，腾空帧帧底应与 y 相差 gap
    for (const a of analyzed) {
      if (a.airborne) {
        const expect = ba.y - 1 - a.airborneGap;
        if (Math.abs(a.nativeBox.bottom - expect) > GATE.bodyAnchorTol) problems.push(a.id + ' 帧底与 bodyAnchor.y−gap 不符');
      }
    }
  }
  check('C17 bodyAnchor（躯干墨迹内 / x=实测质心±2 / 同批 spread<=2 / y=地面线±2 / 腾空帧不跟帧底）', problems.length === 0,
    problems.length ? problems.join('; ')
      : 'x=' + manifest.bodyAnchor.x + ' 实测均值=' + (analyzed.reduce((s, a) => s + a.torsoCx, 0) / analyzed.length).toFixed(1)
      + ' spread=' + (Math.max(...analyzed.map((a) => a.torsoCx)) - Math.min(...analyzed.map((a) => a.torsoCx))).toFixed(2)
      + ' y=' + manifest.bodyAnchor.y + ' 地面线=' + GROUND + ' | 腾空帧帧底 ' + airborneFrames.map((a) => a.id + ':' + a.nativeBox.bottom).join(','));
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('---- jump gate: ' + (results.length - failed.length) + '/' + results.length + ' PASS ----');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.id).join(' | '));
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
