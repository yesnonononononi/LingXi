import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPng, writePng } from './png.mjs';
import { measure, describe } from './pixels.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const errors = [];
const candidateArg = process.argv.find(value => value.startsWith('--candidate='));
function assert(condition, message) { if (!condition) errors.push(message); }
function pointVisible(image, point) {
  return point && point.length === 2 && point.every(Number.isInteger) && point[0] >= 0 && point[1] >= 0 &&
    point[0] < image.width && point[1] < image.height && image.data[(point[1] * image.width + point[0]) * 4 + 3] > 0;
}
function inspect(image, stats, entry, actual) {
  const failed = [];
  if (image.width !== 3072 || image.height !== 3072 || image.width !== entry.width || image.height !== entry.height ||
    image.bitDepth !== 8 || image.colorType !== 6 || image.interlace !== 0) failed.push('C1');
  if (stats.lowAlpha || stats.islands.length) failed.push('C2');
  if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes || JSON.stringify(stats.bbox) !== JSON.stringify(entry.bbox)) failed.push('C3');
  const box = stats.bbox;
  if (box.left < 8 || box.top < 8 || box.right > image.width - 9 || box.bottom > image.height - 9) failed.push('C4');
  for (const key of ['footImageLeft', 'footImageRight']) {
    const point = entry.contactPoints[key];
    if (!pointVisible(image, point) || Math.abs(point[1] - entry.anchor.y) > 2) failed.push('C4');
  }
  for (const key of ['belly', 'palmFrontImageLeft', 'palmFrontImageRight']) {
    if (entry.contactPoints[key] && !pointVisible(image, entry.contactPoints[key])) failed.push('C4');
  }
  if (JSON.stringify(entry.contactPoints.foot) !== JSON.stringify([entry.anchor.x, entry.anchor.y])) failed.push('C4');
  return [...new Set(failed)];
}
const required = ['lie_down_01_neutral@2x.png', 'lie_down_02_neutral@2x.png', 'lie_down_03_neutral@2x.png',
  'lie_neutral@2x.png', 'lie_up_01_neutral@2x.png', 'lie_up_02_neutral@2x.png', 'lie_up_03_neutral@2x.png'];
function containsRequiredFrames(files) {
  return files.length === 7 && required.every(name => files.some(entry => entry.file === name));
}
assert(manifest.canvas.width === 3072 && manifest.canvas.height === 3072 && manifest.nativeSourceCanvas.width === 1536 && manifest.nativeSourceCanvas.height === 1536, 'C1 画布契约不符');
assert(manifest.alpha === 'straight' && manifest.colorSpace === 'sRGB', 'C1 导出约定不符');
assert(manifest.mirrorSafe === false && ['bow', 'hairpin', 'tail'].every(name => manifest.notMirrorableParts.includes(name)), 'C5 镜像约束不完整');
assert(containsRequiredFrames(manifest.files), 'C6 七个必交帧位不完整');
assert(JSON.stringify(manifest.sequences.down) === JSON.stringify(required.slice(0, 3)) && JSON.stringify(manifest.sequences.up) === JSON.stringify(required.slice(4)), 'C6 过渡顺序不符');

let neutralImage;
for (const entry of manifest.files) {
  const filename = entry.file === 'lie_neutral@2x.png' && candidateArg ? path.resolve(candidateArg.slice('--candidate='.length)) : path.join(root, entry.file);
  const image = readPng(filename);
  if (entry.file === 'lie_neutral@2x.png') neutralImage = image;
  const stats = measure(image), actual = describe(filename, image);
  const failed = inspect(image, stats, entry, actual);
  assert(!failed.length, `${failed.join('/')} 成品检查失败: file=${entry.file}`);
  const native = readPng(path.join(root, entry.nativeSource));
  let different = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const first = (y * image.width + x) * 4, second = (Math.floor(y / 2) * native.width + Math.floor(x / 2)) * 4;
    for (let c = 0; c < 4; c++) if (image.data[first + c] !== native.data[second + c]) different++;
  }
  assert(!different, `C1 母版不等于原生图2倍最近邻: file=${entry.file}`);
  assert(manifest.sources.some(source => source.file === entry.generatedSource) && manifest.sources.some(source => source.file === entry.nativeSource), `C10 成品未关联两级来源: file=${entry.file}`);
  console.log(`核对母版: file=${entry.file}, bytes=${actual.bytes}, sha256=${actual.sha256}, bbox=${JSON.stringify(actual.bbox)}`);
}
for (const entry of manifest.sources) {
  const filename = path.join(root, entry.file);
  const actual = describe(filename, readPng(filename));
  assert(['width', 'height', 'bytes', 'sha256'].every(key => actual[key] === entry[key]) && JSON.stringify(actual.bbox) === JSON.stringify(entry.bbox), `C10 来源对账失败: file=${entry.file}`);
}
for (const [file, target] of Object.entries(manifest.aliases)) {
  assert(manifest.files.find(entry => entry.file === file).sha256 === manifest.files.find(entry => entry.file === target).sha256, `C6 声明的复用帧不一致: file=${file}`);
}
assert(fs.existsSync(path.join(root, 'qa/lie_review.png')) && readPng(path.join(root, 'qa/lie_review.png')).width === 1380, 'C9 缺少并排复核图');
const prone = manifest.files.find(entry => entry.file === 'lie_neutral@2x.png');
assert(prone.contactPoints.belly && prone.contactPoints.palmFront && prone.contactPoints.footImageLeft && prone.contactPoints.footImageRight, 'C4 趴姿缺少腹部/前掌/后掌接触点');
assert(prone.displayInkHeight < 150 && manifest.files[0].displayInkHeight > 200, 'C6 趴姿高度与站姿不可辨');

// ---------- C12 bodyAnchor（§6.2）----------
// x = 躯干主轴中心（横躺姿态用「躯干带 45%~85% 高度的墨迹质心」：蓝裙簇会被蜷曲肢体遮挡、虹膜开合会污染蓝色簇），
// y = 本批地面线。三条断言：实测 x 与声明差 ≤2px、声明 x 落在躯干带墨迹内、同批 spread ≤2px、y 与地面线差 ≤2px。
{
  const TOL = 2;
  const ba = manifest.bodyAnchor || {};
  assert(typeof ba.x === 'number' && typeof ba.y === 'number', 'C12 bodyAnchor 缺 x/y');
  assert(typeof ba.estimator === 'string' && ba.estimator.length > 0, 'C12 bodyAnchor 缺 estimator 说明');
  // bodyAnchor 取「趴平本体」那张原生图（lie_neutral）：lie_down_0x / lie_up_0x 与它逐字节同源（aliases）。
  // 本批还借用了 stand / crouch 两张过渡姿态的原生图（姿态与地面线都不同），
  // 它们的实测值单独声明在 bodyAnchor.byFrame 并逐值对账，不与趴姿混算 spread。
  const allNatives = [...new Set(manifest.files.map((entry) => entry.nativeSource))];
  const proneEntry = manifest.files.find((entry) => entry.file === 'lie_neutral@2x.png');
  assert(proneEntry && proneEntry.nativeSource, 'C12 找不到 lie_neutral 的原生图，无法定位趴姿本体');
  const poseNatives = [proneEntry.nativeSource];
  const transNatives = allNatives.filter((nativeFile) => nativeFile !== proneEntry.nativeSource);
  const rows = [];
  let ground = 0;
  const measureNative = (nativeFile) => {
    const img = readPng(path.join(root, nativeFile));
    const box = measure(img).bbox;
    const y0 = box.top + Math.round((box.bottom - box.top + 1) * 0.45);
    const y1 = box.top + Math.round((box.bottom - box.top + 1) * 0.85);
    let sx = 0; let n = 0; let hit = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        if (img.data[(y * img.width + x) * 4 + 3] < 200) continue;
        sx += x; n += 1;
        if (x === Math.round(ba.x)) hit += 1;
      }
    }
    return { cx: n ? sx / n : null, hit, bottom: box.bottom };
  };
  for (const nativeFile of poseNatives) {
    const { cx, hit, bottom } = measureNative(nativeFile);
    ground = Math.max(ground, bottom);
    assert(cx !== null && Math.abs(cx - ba.x) <= TOL, `C12 躯干带质心 ${cx === null ? 'null' : cx.toFixed(2)} 与 bodyAnchor.x ${ba.x} 差 >${TOL}: file=${nativeFile}`);
    assert(hit > 0, `C12 bodyAnchor.x 不在躯干墨迹内: file=${nativeFile}`);
    assert(Math.abs(ba.y - bottom) <= TOL, `C12 bodyAnchor.y=${ba.y} 与本批地面线 ${bottom} 差 >${TOL}: file=${nativeFile}`);
    rows.push(`${nativeFile.split('/').pop()}:${cx.toFixed(2)}`);
  }
  const xs = rows.map((s) => Number(s.split(':')[1]));
  const spread = Math.max(...xs) - Math.min(...xs);
  assert(spread <= TOL, `C12 同批躯干 x spread=${spread.toFixed(2)}>${TOL}`);
  // 过渡姿态（stand / crouch）的躯干主轴必须逐值声明，不许静默略过
  const byFrame = ba.byFrame || {};
  for (const nativeFile of transNatives) {
    const { cx, bottom } = measureNative(nativeFile);
    const decl = byFrame[nativeFile];
    assert(decl, `C12 过渡姿态未在 bodyAnchor.byFrame 声明: file=${nativeFile}`);
    if (!decl) continue;
    assert(Math.abs(cx - decl.x) <= TOL, `C12 byFrame.x 与实测不符: file=${nativeFile} 实测 ${cx.toFixed(2)} 声明 ${decl.x}`);
    assert(Math.abs(bottom - decl.y) <= TOL, `C12 byFrame.y 与实测地面线不符: file=${nativeFile} 实测 ${bottom} 声明 ${decl.y}`);
    rows.push(`${nativeFile.split('/').pop()}:${cx.toFixed(2)}(过渡,已声明)`);
  }
  console.log(`bodyAnchor: x=${ba.x} y=${ba.y} 地面线=${ground} | ${rows.join(' ')} spread=${spread.toFixed(2)}`);
}

if (process.argv.includes('--self-test')) {
  // 正对照先证明全画布扫描能命中低alpha和孤岛，包括末行末列。
  const test = { width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4) };
  test.data[(15 * 16 + 15) * 4 + 3] = 1;
  let stats = measure(test);
  assert(stats.lowAlpha === 1 && stats.islands.length === 1 && stats.bbox.right === 15 && stats.bbox.bottom === 15, '金丝雀漏报: 末行末列低alpha与单像素孤岛');
  console.log('金丝雀正对照: 末行末列低alpha=命中, 单像素孤岛=命中');
  assert(!containsRequiredFrames(manifest.files.slice(1)), '金丝雀漏报: 缺少站姿起点');
  console.log('变异拒绝: case=缺少关键帧, expected=C6, detected=true');
  const actual = { bytes: prone.bytes, sha256: prone.sha256 };
  stats = measure(neutralImage);
  const mutations = [
    ['错误画布', { ...neutralImage, width: 3071 }, prone, actual, 'C1'],
    ['错误位深', { ...neutralImage, bitDepth: 16 }, prone, actual, 'C1'],
    ['错误哈希', neutralImage, { ...prone, sha256: '0'.repeat(64) }, actual, 'C3'],
    ['错误字节数', neutralImage, { ...prone, bytes: prone.bytes + 1 }, actual, 'C3'],
    ['错误包围盒', neutralImage, { ...prone, bbox: { ...prone.bbox, left: prone.bbox.left + 1 } }, actual, 'C3'],
    ['错误脚底锚点', neutralImage, { ...prone, anchor: { ...prone.anchor, y: 2800 } }, actual, 'C4'],
  ];
  for (const [name, image, entry, checksum, code] of mutations) {
    const detected = inspect(image, stats, entry, checksum).includes(code);
    assert(detected, `金丝雀漏报: case=${name}`);
    console.log(`变异拒绝: case=${name}, expected=${code}, detected=${detected}`);
  }
  const edgeStats = { ...stats, bbox: { ...stats.bbox, left: 0 } };
  assert(inspect(neutralImage, edgeStats, { ...prone, bbox: edgeStats.bbox }, actual).includes('C4'), '金丝雀漏报: 画布边缘没有留白');
  console.log('变异拒绝: case=边缘无留白, expected=C4, detected=true');
  const temporary = path.join(root, 'qa/.canary-replacement.png');
  try {
    const changed = { ...neutralImage, data: Buffer.from(neutralImage.data) };
    const x = prone.contactPoints.footImageLeft[0], y = prone.contactPoints.footImageLeft[1];
    changed.data[(y * changed.width + x) * 4] ^= 1;
    writePng(temporary, changed);
    const replacement = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--candidate=${temporary}`], { encoding: 'utf8' });
    assert(replacement.status === 1 && replacement.stderr.includes('C3'), 'C11 成品替换变异未触发非0退出');
    console.log(`成品替换变异: exit=${replacement.status}, C3=${replacement.stderr.includes('C3') ? '命中' : '漏报'}`);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
if (process.argv.includes('--approved')) assert(manifest.status === 'approved' && manifest.review.humanApproved, '人工验收未通过，禁止标记整批完成');
for (const error of errors) console.error(`校验失败: ${error}`);
if (errors.length) process.exitCode = 1;
else console.log('资产机验通过: C1-C6=通过, C7=非mini不适用, C8=纯Node零依赖, C9=复核图已交, C10-C11=对账通过');
console.log('人工验收状态: 待确认画风、四肢结构及腹部衣摆接地代理点；7帧位=3张独立画面，起身反向复用');
