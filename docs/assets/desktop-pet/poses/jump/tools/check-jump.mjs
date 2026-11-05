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
  // C10b 镜像判据：右向帧 vs 左向帧水平翻转后的差异像素 / 并集墨迹 ≥5%
  mirrorDiffMinRatio: 0.05,
  // C9c 单朝向体积上限：帧数 × 1.9MB（本轮右向 5 帧 ≤9.5MB，与左向同口径）
  facingMaxBytes: 9961472,
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
// 相位基准（左右向同相位必须落在同一套数字上，判据 C18）。数值与左向上轮交付一字不差。
const PHASE_GROUND = { anticipate: 0, ascend: 76, apex: 170, descend: 64, land: 0 };

// 按朝向分组：本批同时含左向(-1)与右向(+1)帧。
// 跨朝向共用同一个躯干锚点在几何上不成立（尾巴把墨迹拉成不对称形 + 左向帧字节已冻结），
// 故「同批躯干零抖动」「腾空判据」这类判据一律在**同朝向组内**成立，跨组另由 C17（镜像对称）与 C10b 把关。
const groups = new Map();
for (const a of analyzed) {
  const k = a.facing;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(a);
}
const leftGroup = groups.get(-1) || [];
const rightGroup = groups.get(1) || [];
const rightIds = FRAME_ORDER.map((p) => 'r_' + p);
const rightByPhase = new Map(rightGroup.map((a) => [a.id.replace(/^r_/, ''), a]));

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
  // 左右向同批：画布/锚点仍必须全批一致（这些与朝向无关），朝向一致性拆到组内判，
  // 另加「两个朝向组各 FRAME_ORDER.length 帧、facing 取值只能是 ±1」——比原来的单朝向断言只增不减。
  const sizes = new Set(analyzed.map((a) => a.mInfo.ihdr.width + 'x' + a.mInfo.ihdr.height));
  const nativeSizes = new Set(analyzed.map((a) => a.native.width + 'x' + a.native.height));
  const anchors = new Set(analyzed.map((a) => (a.decl.anchor ? a.decl.anchor.x + ',' + a.decl.anchor.y : 'none')));
  const badFacing = analyzed.filter((a) => a.facing !== -1 && a.facing !== 1).map((a) => a.id);
  const spreadOf = (g) => {
    const xs = g.map((a) => a.torsoCx);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : Infinity;
  };
  const problems = [];
  if (sizes.size !== 1) problems.push('母版尺寸不一致');
  if (nativeSizes.size !== 1) problems.push('native 尺寸不一致');
  if (anchors.size !== 1) problems.push('anchor 不一致');
  if (badFacing.length) problems.push('非法 facing: ' + badFacing.join(','));
  if (leftGroup.length !== FRAME_ORDER.length) problems.push('左向组帧数=' + leftGroup.length + ' 应为 ' + FRAME_ORDER.length);
  if (rightGroup.length !== FRAME_ORDER.length) problems.push('右向组帧数=' + rightGroup.length + ' 应为 ' + FRAME_ORDER.length);
  if (!leftGroup.every((a) => a.facing === -1)) problems.push('左向组混入非 -1');
  if (!rightGroup.every((a) => a.facing === 1)) problems.push('右向组混入非 +1');
  const spreadL = spreadOf(leftGroup);
  const spreadR = spreadOf(rightGroup);
  if (spreadL > GATE.bodyAnchorTol) problems.push('左向组躯干 spread=' + spreadL.toFixed(2));
  if (spreadR > GATE.bodyAnchorTol) problems.push('右向组躯干 spread=' + spreadR.toFixed(2));
  check('C8 同批画布/锚点一致 + 左右组各 5 帧且朝向纯一 + 组内躯干横向零抖动（spread<=2）', problems.length === 0,
    problems.length ? problems.join('; ')
      : 'master=' + [...sizes].join(',') + ' native=' + [...nativeSizes].join(',') + ' anchor=' + [...anchors].join(',')
      + ' facing=' + [...groups.keys()].sort((p, q) => p - q).join('/')
      + ' | 左向(' + leftGroup.length + '帧) spread=' + spreadL.toFixed(2) + 'px 右向(' + rightGroup.length + '帧) spread=' + spreadR.toFixed(2) + 'px'
      + ' | torsoX ' + analyzed.map((a) => a.id + ':' + a.torsoCx.toFixed(1)).join(' '));
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
// ---------- C9c 单朝向体积 ----------
{
  // 右向 5 帧单独按 5 × 1.9MB = 9.5MB 复核（与上一轮左向交付同口径），防止右向帧悄悄变胖
  const sum = (g) => g.reduce((s, a) => s + bytes(a.masterPath), 0);
  const rightBytes = sum(rightGroup);
  const leftBytes = sum(leftGroup);
  const problems = [];
  if (rightGroup.length !== FRAME_ORDER.length) problems.push('右向组帧数=' + rightGroup.length);
  if (rightBytes > GATE.facingMaxBytes) problems.push('右向合计 ' + rightBytes + 'B > ' + GATE.facingMaxBytes + 'B');
  if (leftBytes > GATE.facingMaxBytes) problems.push('左向合计 ' + leftBytes + 'B > ' + GATE.facingMaxBytes + 'B（回归）');
  check('C9c 单朝向体积：左右各 5 帧 ≤ 5×1.9MB=9.5MB', problems.length === 0,
    problems.length ? problems.join('; ')
      : '左向=' + (leftBytes / GATE.mbBytes).toFixed(2) + 'MB 右向=' + (rightBytes / GATE.mbBytes).toFixed(2)
      + 'MB 上限=' + (GATE.facingMaxBytes / GATE.mbBytes).toFixed(1) + 'MB'
      + ' | 右向逐帧 ' + rightGroup.map((a) => a.id + ':' + bytes(a.masterPath)).join(' '));
}
// ---------- C10 ----------
{
  const rows = analyzed.map((a) => ({ id: a.id, facing: a.facing, off: a.irisOffset, area: a.iris ? a.iris.n : 0 }));
  const bad = rows.filter((r) => r.off === null || Math.sign(r.off) !== r.facing || Math.abs(r.off) < GATE.irisMinOffset);
  const cnt = (f) => rows.filter((r) => r.facing === f).length;
  check('C10 虹膜朝向判据（符号=facing，|偏移|>=60 native px）', bad.length === 0,
    rows.map((r) => r.id + ':' + Math.round(r.off) + '(n' + Math.round(r.area) + ')').join(' ')
    + ' | 左向 ' + cnt(-1) + ' 帧全为负、右向 ' + cnt(1) + ' 帧全为正'
    + (bad.length ? ' | 未通过: ' + bad.map((r) => r.id).join(',') : ''));
}
// ---------- C10b ----------
// 镜像判据（与 run 的 C10b 完全同一口径）：把每个右向帧与每个左向帧的水平翻转逐像素比，
// 取差异最小（最像镜像）的那一对。差异比 = 差异像素数 / 并集墨迹像素数（任一帧 alpha>=8 即计入并集），通道容差 8/255。
// 真重画的右向帧与任何左向帧的镜像都应在姿态/部件侧别上明显不同，差异比远高于 5%；
// 若有人拿左向帧水平翻转冒充右向，差异比会掉到 0% 附近，这条必红。
{
  const problems = [];
  const rows = [];
  if (!leftGroup.length || !rightGroup.length) problems.push('缺少左向或右向帧，镜像判据无从比较');
  for (const r of rightGroup) {
    const W = r.native.width;
    const H = r.native.height;
    let worst = null;
    let paired = null;
    for (const l of leftGroup) {
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
      // 同相位那一对（r_apex vs mirror(apex)）单列出来，说明"最像镜像的那对不是你同相位的对手"
      if (r.id.replace(/^r_/, '') === l.id) paired = rec;
    }
    rows.push({ id: r.id, worst, paired });
    if (!(worst.ratio >= GATE.mirrorDiffMinRatio)) {
      problems.push(r.id + ' vs mirror(' + worst.l + ')=' + (worst.ratio * 100).toFixed(2) + '%');
    }
  }
  check('C10b 右向帧不是左向帧的镜像（翻转后差异 >=5% 并集墨迹）', problems.length === 0,
    rows.map((x) => x.id + ':min=' + (x.worst.ratio * 100).toFixed(1) + '%(vs mirror ' + x.worst.l + ')'
      + (x.paired ? ' 同相位=' + (x.paired.ratio * 100).toFixed(1) + '%' : '')).join(' ')
    + ' | 阈值>=' + (GATE.mirrorDiffMinRatio * 100) + '%' + (problems.length ? ' | 未通过: ' + problems.join(',') : ''));
}
// ---------- C13 腾空判据 ----------
{
  const problems = [];
  const runGap = manifest.notes.find((n) => n.includes('run')) ? 48 : 48;
  // 左右两组的断言集合完全相同（同相位同 gap），跨组的"左右一高一低"由 C18 另外把关
  for (const [fac, g] of [[-1, leftGroup], [1, rightGroup]]) {
    const get = (phase) => g.find((a) => a.id === (fac === 1 ? 'r_' + phase : phase));
    if (!get('ascend') || !get('apex') || !get('descend')) { problems.push('facing' + fac + ' 缺 ascend/apex/descend'); continue; }
    for (const phase of FRAME_ORDER) {
      const a = get(phase);
      const shouldAir = DECL_AIRBORNE.has(phase);
      if (!a) { problems.push('facing' + fac + ' 缺帧 ' + phase); continue; }
      if (shouldAir !== a.airborne) problems.push(a.id + '.airborne=' + a.airborne + '(应为' + shouldAir + ')');
      if (shouldAir) {
        if (a.decl.contactPoints.support !== null) problems.push(a.id + '.declSupport 应为 null');
        if (!(a.airborneGap > 0)) problems.push(a.id + '.gap<=0');
        if (a.airborneGap < GATE.airborneMinGapNative) problems.push(a.id + '.gap=' + a.airborneGap + ' <' + GATE.airborneMinGapNative);
        for (const f of a.feet) { if (f.contactY >= GROUND) problems.push(a.id + '.foot@' + f.contactY + ' 未高于地面线'); }
      } else if (!a.support) problems.push(a.id + ' 支撑帧缺 support');
    }
    const asc = get('ascend'); const apex = get('apex'); const desc = get('descend');
    if (!(apex.airborneGap >= GATE.apexMinGapNative)) problems.push(apex.id + '.gap=' + apex.airborneGap + ' <' + GATE.apexMinGapNative);
    if (!(apex.airborneGap >= runGap + GATE.gapMarginOverRun)) problems.push(apex.id + '.gap 未显著大于 run 的 ' + runGap);
    if (!(asc.airborneGap < apex.airborneGap)) problems.push(asc.id + '(' + asc.airborneGap + ') 未小于 apex(' + apex.airborneGap + ')');
    if (!(desc.airborneGap < apex.airborneGap)) problems.push(desc.id + '(' + desc.airborneGap + ') 未小于 apex(' + apex.airborneGap + ')');
    // 双脚最低点都高于地面线：脚段 contactY 与 native 底部一致即可证明（墨迹最低点即脚）
    for (const a of [asc, apex, desc]) if (a.nativeBox.bottom >= GROUND) problems.push(a.id + '.nativeBottom 未高于地面线');
  }
  const gapLine = (g) => FRAME_ORDER.map((p) => {
    const a = g.find((x) => x.id === p || x.id === 'r_' + p);
    return a ? a.id + ':' + (a.airborne ? 'gap' + a.airborneGap : 'bottom' + a.nativeBox.bottom) : p + ':缺失';
  }).join(' ');
  check('C13 腾空判据（左右两组同口径：support=null + gap>0 + apex>=120 且显著大于 run 48 + ascend<apex>descend + 双脚高于地面线）',
    problems.length === 0,
    '左向 ' + gapLine(leftGroup) + ' | 右向 ' + gapLine(rightGroup)
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
// ---------- C14b 禁整体缩放（逐朝向组复核）----------
// C14 已把 10 帧放在同一个系数极差里（更强），这里再按朝向组各算一遍
// 「腾空帧不得比支撑帧更宽」与「apex 比 land 窄」，防止某一侧靠放大伪造跳跃。
{
  const problems = [];
  const lines = [];
  for (const [fac, g] of [[-1, leftGroup], [1, rightGroup]]) {
    const sup = g.filter((a) => !a.airborne);
    const air = g.filter((a) => a.airborne);
    if (!sup.length || !air.length) { problems.push('facing' + fac + ' 缺支撑帧或腾空帧'); continue; }
    const supW = Math.max(...sup.map((a) => a.nativeBox.width));
    const airW = Math.max(...air.map((a) => a.nativeBox.width));
    if (airW >= supW) problems.push('facing' + fac + ' 腾空帧宽(' + airW + ') >= 支撑帧宽(' + supW + ')');
    const apex = g.find((a) => a.id === (fac === 1 ? 'r_apex' : 'apex'));
    const land = g.find((a) => a.id === (fac === 1 ? 'r_land' : 'land'));
    const ratio = apex.nativeBox.width / land.nativeBox.width;
    if (ratio > 1) problems.push('facing' + fac + ' apex宽/land宽=' + ratio.toFixed(3) + ' >1');
    lines.push('facing' + fac + ' maxAirW=' + airW + ' < maxSupportW=' + supW + ' apexW/landW=' + ratio.toFixed(4)
      + ' 墨迹高 ' + FRAME_ORDER.map((p) => p + ':' + (g.find((a) => a.id === p || a.id === 'r_' + p) || { nativeBox: {} }).nativeBox.height).join(' '));
  }
  check('C14b 禁整体缩放（逐朝向组：腾空帧不得比支撑帧更宽 / apex 不得比 land 宽）', problems.length === 0,
    problems.length ? problems.join('; ') : lines.join(' | '));
}
// ---------- C15 ----------
{
  const uniq = new Set(analyzed.map((a) => sha256(a.masterPath))).size;
  const uniqNative = new Set(analyzed.map((a) => sha256(a.nativePath))).size;
  check('C15 10 帧（左右各 5）母版/native sha256 互不相同（禁重复副本）', uniq === analyzed.length && uniqNative === analyzed.length,
    'master=' + uniq + '/' + analyzed.length + ' native=' + uniqNative + '/' + analyzed.length
    + ' | 右向 ' + rightGroup.map((a) => a.id).join(','));
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
  for (const need of ['play', 'edge', 'side', 'mini']) if (!deferred.includes(need)) problems.push('deferredUntilApproval 缺 ' + need);
  // 右向已交，不允许再挂在 deferred 里（挂回去说明"其实没做"或清单没同步）
  if (deferred.includes('右向')) problems.push('deferredUntilApproval 仍含「右向」，但右向 5 帧本轮已交');
  if (manifest.review.fullBatchComplete !== true) problems.push('fullBatchComplete 应为 true（左右 10 帧已交齐）');
  const req = new Set(manifest.review.requiredNow);
  for (const id of FRAME_ORDER) if (!req.has(id)) problems.push('requiredNow 缺 ' + id);
  for (const id of rightIds) if (!req.has(id)) problems.push('requiredNow 缺 ' + id);
  if (manifest.frames.length !== FRAME_ORDER.length * 2) problems.push('frames 数=' + manifest.frames.length + ' 应为 ' + FRAME_ORDER.length * 2);
  if (manifest.sources.length !== FRAME_ORDER.length * 2) problems.push('sources 数=' + manifest.sources.length);
  const badFacingCount = k => manifest.frames.filter((f) => f.facing === k).length;
  if (badFacingCount(-1) !== FRAME_ORDER.length || badFacingCount(1) !== FRAME_ORDER.length) {
    problems.push('facing 分布 -1:' + badFacingCount(-1) + ' +1:' + badFacingCount(1));
  }
  check('C16 §6.1 必备键 + nativeSourceCanvas×masterScale=canvas + mirrorSafe=false + notMirrorableParts + deferred 清单 + 左右各 5 帧已交齐',
    problems.length === 0,
    problems.length ? problems.join('; ')
      : GATE.requiredTopKeys.length + ' 个必备键齐全, 1536×2=3072 ✓, mirrorSafe=false, 不可镜像件=' + manifest.notMirrorableParts.length
      + ', frames=' + manifest.frames.length + '(左' + badFacingCount(-1) + '/右' + badFacingCount(1) + '), deferred=' + manifest.review.deferredUntilApproval.length + ' 项');
}
// ---------- C17 bodyAnchor ----------
// §6.2：anchor 只管单批内尺寸/命中推导；跨批切换按 bodyAnchor（躯干主轴中心 + 本批地面线）对齐。
// 六条断言：① 每帧实测躯干主轴 x 与「该帧朝向的声明值」差 <=2px；② 声明 x 落在躯干墨迹内（不是画布中线/bbox 中线）；
// ③ 同朝向组内 spread <=2px；④ 声明 y 与本批地面线差 <=2px；⑤ 腾空帧不跟帧底；
// ⑥ byFacing 的左右 x 必须**严格**镜像（x_left + x_right = native 画布宽，容差 0，因为是算术关系不是测量）。
{
  const problems = [];
  const ba = manifest.bodyAnchor;
  const byFacing = ba && ba.byFacing ? ba.byFacing : null;
  if (!ba) problems.push('缺 bodyAnchor');
  else {
    const declaredFor = (a) => (byFacing && byFacing[String(a.facing)]) ? byFacing[String(a.facing)] : { x: ba.x, y: ba.y };
    for (const a of analyzed) {
      const d = declaredFor(a);
      const dx = Math.abs(a.torsoCx - d.x);
      if (dx > GATE.bodyAnchorTol) problems.push(a.id + '.torsoCx=' + a.torsoCx.toFixed(1) + ' 与声明 ' + d.x + ' 差 ' + dx.toFixed(1));
      // 声明 x 必须落在该帧躯干墨迹内（45%~85% 带内 alpha>=200 的像素），防止"拿画布中线糊弄"
      const bandStart = a.nativeBox.top + Math.round(a.nativeBox.height * 0.45);
      const bandEnd2 = a.nativeBox.top + Math.round(a.nativeBox.height * 0.85);
      const xi = Math.round(d.x);
      let hit = 0;
      for (let y = bandStart; y <= bandEnd2; y += 1) {
        const o = (y * a.native.width + xi) * 4;
        if (a.native.data[o + 3] >= 200) hit += 1;
      }
      if (hit === 0) problems.push(a.id + ' bodyAnchor.x=' + d.x + ' 不在躯干墨迹内');
      if (xi < a.nativeBox.left || xi > a.nativeBox.right) problems.push(a.id + ' bodyAnchor.x 落在墨迹 bbox 之外');
    }
    for (const [fc, g] of [...groups.entries()].sort((p, q) => p[0] - q[0])) {
      const xs = g.map((a) => a.torsoCx);
      const spread = Math.max(...xs) - Math.min(...xs);
      if (spread > GATE.bodyAnchorTol) problems.push('facing' + fc + ' 组内 spread=' + spread.toFixed(2) + ' >' + GATE.bodyAnchorTol);
    }
    if (Math.abs(ba.y - (GROUND - 1)) > GATE.bodyAnchorTol && Math.abs(ba.y - ANCHOR_Y_NATIVE) > GATE.bodyAnchorTol) {
      problems.push('bodyAnchor.y=' + ba.y + ' 与地面线 ' + GROUND + ' 偏差 >' + GATE.bodyAnchorTol);
    }
    if (byFacing && byFacing['-1'] && Math.abs(byFacing['-1'].x - ba.x) > GATE.bodyAnchorTol) problems.push('byFacing[-1] 与 x 不一致');
    // y 不随帧底走：所有帧的 bodyAnchor.y 都必须是同一个地面参考，腾空帧帧底应与 y 相差 gap
    for (const a of analyzed) {
      if (a.airborne) {
        const expect = ba.y - 1 - a.airborneGap;
        if (Math.abs(a.nativeBox.bottom - expect) > GATE.bodyAnchorTol) problems.push(a.id + ' 帧底与 bodyAnchor.y−gap 不符');
      }
    }
    // ⑥ 左右镜像对称（严格算术，容差 0）
    if (!byFacing) problems.push('缺 bodyAnchor.byFacing（左右向必须各声明一个 x）');
    else {
      const L = byFacing['-1']; const R = byFacing['1'];
      if (!L || !R) problems.push('byFacing 缺 -1 或 1 的声明');
      else {
        if (L.x + R.x !== manifest.nativeSourceCanvas.width) {
          problems.push('左右 bodyAnchor.x 不是严格镜像：' + L.x + '+' + R.x + '≠' + manifest.nativeSourceCanvas.width);
        }
        if (R.y !== L.y) problems.push('左右 bodyAnchor.y 不一致：' + L.y + ' vs ' + R.y);
        if (typeof R.x !== 'number' || R.x <= 0 || R.x >= manifest.nativeSourceCanvas.width) problems.push('byFacing[1].x 越界');
      }
    }
  }
  const meanOf = (g) => (g.length ? g.reduce((s, a) => s + a.torsoCx, 0) / g.length : NaN);
  const spreadOf = (g) => (g.length ? Math.max(...g.map((a) => a.torsoCx)) - Math.min(...g.map((a) => a.torsoCx)) : NaN);
  const baRow = (g) => g.length ? '实测均值=' + meanOf(g).toFixed(1) + ' spread=' + spreadOf(g).toFixed(2) : '缺失';
  check('C17 bodyAnchor（按朝向取值 / 躯干墨迹内 / x=实测质心±2 / 组内 spread<=2 / y=地面线±2 / 腾空帧不跟帧底 / 左右严格镜像）',
    problems.length === 0,
    problems.length ? problems.join('; ')
      : 'x=' + manifest.bodyAnchor.x + '(左)/' + (manifest.bodyAnchor.byFacing ? manifest.bodyAnchor.byFacing['1'].x : '缺失') + '(右)'
      + ' y=' + manifest.bodyAnchor.y + ' 地面线=' + GROUND
      + ' | 左向 ' + baRow(leftGroup) + ' 右向 ' + baRow(rightGroup)
      + ' | 镜像 ' + (manifest.bodyAnchor.byFacing ? manifest.bodyAnchor.byFacing['-1'].x + '+' + manifest.bodyAnchor.byFacing['1'].x + '=' + manifest.nativeSourceCanvas.width : '缺失')
      + ' | 腾空帧帧底 ' + airborneFrames.map((a) => a.id + ':' + a.nativeBox.bottom).join(','));
}
// ---------- C18 相位几何左右同帧对齐 ----------
// 左右转身时若同一相位的离地量不同，动作会"一高一低"。判据是硬数字：
// 支撑相位（anticipate / land）native 墨迹底边 = 地面线 1453；腾空相位 ascend 76 / apex 170 / descend 64。
// 左右都要落在 ±2 native 内，且左右同相位的底边/离地量互相也要 ±2 对齐。
{
  const problems = [];
  const rows = [];
  for (const phase of FRAME_ORDER) {
    const l = leftGroup.find((a) => a.id === phase);
    const r = rightByPhase.get(phase);
    if (!l || !r) { problems.push(phase + ' 缺左向或右向帧'); continue; }
    const spec = PHASE_GROUND[phase];
    for (const [tag, a] of [['左', l], ['右', r]]) {
      const got = a.airborne ? a.airborneGap : (GROUND - a.nativeBox.bottom);
      if (Math.abs(got - spec) > GATE.contactTolPx) problems.push(phase + ' ' + tag + '向=' + got + ' 应为 ' + spec);
      if (a.airborne && a.nativeBox.bottom !== GROUND - spec) problems.push(phase + ' ' + tag + '向 帧底=' + a.nativeBox.bottom + ' 应为 ' + (GROUND - spec));
      if (!a.airborne && a.nativeBox.bottom !== GROUND) problems.push(phase + ' ' + tag + '向 支撑帧底部=' + a.nativeBox.bottom + ' 应为 ' + GROUND);
    }
    const gotL = l.airborne ? l.airborneGap : (GROUND - l.nativeBox.bottom);
    const gotR = r.airborne ? r.airborneGap : (GROUND - r.nativeBox.bottom);
    if (Math.abs(gotL - gotR) > GATE.contactTolPx) problems.push(phase + ' 左右不齐：' + gotL + ' vs ' + gotR);
    if (Math.abs(l.nativeBox.bottom - r.nativeBox.bottom) > GATE.contactTolPx) problems.push(phase + ' 左右帧底差=' + Math.abs(l.nativeBox.bottom - r.nativeBox.bottom));
    rows.push(phase + ' 左=' + (l.airborne ? 'gap' + gotL : 'bottom' + l.nativeBox.bottom)
      + ' 右=' + (r.airborne ? 'gap' + gotR : 'bottom' + r.nativeBox.bottom) + '(基准' + spec + ')');
  }
  check('C18 相位几何左右同帧对齐（anticipate/land 底 1453·gap 0；ascend 76 / apex 170 / descend 64，±2 native）',
    problems.length === 0, problems.length ? problems.join('; ') : rows.join(' | '));
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
