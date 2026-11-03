import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './png.mjs';
import { clean, describe, measure } from './pixels.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvas = { width: 3072, height: 3072 };
const specifications = [
  { id: 'stand', divisor: 2, dx: 256, dy: 0, baseline: 1454,
    footRegions: [[640, 2750, 970, 2910], [975, 2750, 1250, 2910]],
    palmRegions: [], bellyRegion: null },
  { id: 'crouch', divisor: 1, dx: 256, dy: 165, baseline: 1289,
    footRegions: [[570, 1200, 700, 1300], [705, 1200, 840, 1300]],
    palmRegions: [[155, 1260, 280, 1320], [410, 1260, 540, 1320]], bellyRegion: null },
  { id: 'lie', divisor: 1, dx: 0, dy: 571, baseline: 883,
    footRegions: [[1040, 800, 1280, 900], [1290, 800, 1530, 900]],
    palmRegions: [[330, 840, 420, 900], [560, 840, 630, 900]],
    bellyRegion: [980, 830, 1040, 890] },
];

// 接触区域由人工标注语义，落点取该区域最低可见像素；不能拿尾巴或阴影冒充脚底。
function locateContact(image, region) {
  const [left, top, right, bottom] = region;
  let foundY = -1, samples = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    if (!image.data[(y * image.width + x) * 4 + 3]) continue;
    if (y > foundY) { foundY = y; samples = []; }
    if (y === foundY) samples.push(x);
  }
  if (!samples.length) throw new Error('接触区域内没有可见像素');
  return [samples[Math.floor(samples.length / 2)], foundY];
}

const poses = {};
const sources = [];
for (const specification of specifications) {
  const { id, divisor, dx, dy } = specification;
  const generated = `source/${id}_neutral_generated.png`;
  const nativeFile = `source/${id}_neutral_native.png`;
  const raw = readPng(path.join(root, generated));
  sources.push({ file: generated, role: id === 'stand' ? '既有v3站姿逐字节副本，不是本轮新生图' : '内置image_gen直出原图，未加工', ...describe(path.join(root, generated), raw) });
  const sourceCleanup = clean(raw);
  const sourceBox = measure(raw).bbox;
  const native = { width: 1536, height: 1536, data: Buffer.alloc(1536 * 1536 * 4) };
  for (let y = 0; y < raw.height / divisor; y++) for (let x = 0; x < raw.width / divisor; x++) {
    const from = ((y * divisor) * raw.width + x * divisor) * 4;
    if (x + dx >= native.width || y + dy >= native.height) {
      if (raw.data[from + 3]) throw new Error('归一化画布无法容纳全部可见像素');
      continue;
    }
    const to = ((y + dy) * native.width + x + dx) * 4;
    raw.data.copy(native.data, to, from, from + 4);
  }
  const nativeCleanup = clean(native);
  writePng(path.join(root, nativeFile), native);
  sources.push({ file: nativeFile, role: '统一画布的原生图；母版的1/2', ...describe(path.join(root, nativeFile), native) });
  const master = { ...canvas, data: Buffer.alloc(canvas.width * canvas.height * 4) };
  for (let y = 0; y < master.height; y++) for (let x = 0; x < master.width; x++) {
    const from = (Math.floor(y / 2) * native.width + Math.floor(x / 2)) * 4;
    native.data.copy(master.data, (y * master.width + x) * 4, from, from + 4);
  }
  const convertRegion = ([l, t, r, b]) => [Math.floor((l / divisor + dx) * 2), Math.floor((t / divisor + dy) * 2), Math.floor((r / divisor + dx) * 2 + 1), Math.floor((b / divisor + dy) * 2 + 1)];
  const regions = specification.footRegions.map(convertRegion);
  const feet = regions.map(region => locateContact(master, region));
  const palms = specification.palmRegions.map(region => locateContact(master, convertRegion(region)));
  const belly = specification.bellyRegion ? locateContact(master, convertRegion(specification.bellyRegion)) : null;
  const anchor = { x: id === 'stand' ? 1536 : Math.round((feet[0][0] + feet[1][0]) / 2), y: 2909 };
  poses[id] = { master, nativeFile, generated, anchor,
    contactPoints: { foot: [anchor.x, anchor.y], footImageLeft: feet[0], footImageRight: feet[1],
      belly, palmFront: palms[0] ?? null, palmFrontImageLeft: palms[0] ?? null, palmFrontImageRight: palms[1] ?? null },
    contactRegions: { footImageLeft: regions[0], footImageRight: regions[1] },
    normalization: { generatedCanvas: { width: raw.width, height: raw.height }, sourceBboxAfterCleanup: sourceBox,
      uniformScaleToNative: 1 / divisor, kernel: divisor === 2 ? 'nearest' : 'identity-padding',
      translationNative: { x: dx, y: dy }, targetNativeFootBaseline: 1454,
      originalFootBaselineNative: specification.baseline, sourceCleanup, nativeCleanup },
  };
}

const frameSpecifications = [
  ['lie_down_01_neutral@2x.png', 'stand', '趴下第1帧：站姿起点'],
  ['lie_down_02_neutral@2x.png', 'crouch', '趴下第2帧：屈膝、前掌支撑，腹部离地'],
  ['lie_down_03_neutral@2x.png', 'lie', '趴下第3帧：腹部下降到衣摆接地位置'],
  ['lie_neutral@2x.png', 'lie', '中性趴姿'],
  ['lie_up_01_neutral@2x.png', 'lie', '起身第1帧：趴姿起点'],
  ['lie_up_02_neutral@2x.png', 'crouch', '起身第2帧：反向复用半趴支撑画面'],
  ['lie_up_03_neutral@2x.png', 'stand', '起身第3帧：回到既有站姿'],
];
const files = [];
for (const [file, poseId, purpose] of frameSpecifications) {
  const pose = poses[poseId];
  writePng(path.join(root, file), pose.master);
  const actual = describe(path.join(root, file), pose.master);
  files.push({ file, purpose, poseId, ...actual, anchor: pose.anchor,
    contactPoints: pose.contactPoints, contactRegions: pose.contactRegions,
    generatedSource: pose.generated, nativeSource: pose.nativeFile,
    normalization: pose.normalization,
    displayInkHeight: (actual.bbox.bottom - actual.bbox.top + 1) * 234 / 3072 });
  console.log(`生成关键帧: file=${file}, pose=${poseId}, bbox=${JSON.stringify(actual.bbox)}`);
}
const neutral = poses.lie;
for (const file of ['source/lie_flat_reference.png', 'source/lie_pose_reference.png']) {
  sources.push({ file, role: '生成过程中使用的姿态参考原图，不是运行时成品', ...describe(path.join(root, file), readPng(path.join(root, file))) });
}
const manifest = {
  version: 1, batch: 'lie', assetId: 'lingxi-pet-m2-lie-review-v1', status: 'awaiting-static-review',
  canvas, anchor: neutral.anchor, contactPoints: neutral.contactPoints,
  nativeSourceCanvas: { width: 1536, height: 1536 }, masterScale: { factor: 2, kernel: 'nearest', addsDetail: false },
  colorSpace: 'sRGB', alpha: 'straight', bboxConvention: 'right/bottom含端点，alpha>0',
  mirrorSafe: false, notMirrorableParts: ['bow', 'hairpin', 'tail'],
  orientation: '三分之四正面，身体向画面右侧延伸；云朵发夹、发侧蝴蝶结和尾巴保留画面右侧',
  normalization: neutral.normalization,
  display: { canvasHeight: 234, canvasWidth: 234, comparisonScale: '全部使用234/3072，相同母版像素密度' },
  sequences: { down: frameSpecifications.slice(0, 3).map(entry => entry[0]),
    neutral: ['lie_neutral@2x.png'], up: frameSpecifications.slice(4).map(entry => entry[0]) },
  review: { requiredNow: frameSpecifications.map(entry => entry[0]), fullBatchComplete: false,
    frameSlotsDelivered: 7, uniqueDrawings: 3, newlyDrawnPoses: 2, humanApproved: false,
    reason: '帧位齐全只代表可审阅，画风与脚部结构仍待主理人验收；不自行标记approved。',
    focus: ['与v3站姿同尺对比头脸、线条、虹膜与服装', '膝盖到靴口、袖口到手掌的连接', '腹部接地代理点是否符合趴姿'] },
  aliases: { 'lie_down_03_neutral@2x.png': 'lie_neutral@2x.png',
    'lie_up_01_neutral@2x.png': 'lie_neutral@2x.png',
    'lie_up_02_neutral@2x.png': 'lie_down_02_neutral@2x.png',
    'lie_up_03_neutral@2x.png': 'lie_down_01_neutral@2x.png' },
  files, sources,
  notes: '为横向趴姿与原尺寸站姿共用画布，增加横向透明留白至3072×3072；站姿按既有原生2倍策略复刻并水平补边512px，统一再做alpha清理，原像素密度保持不变。新绘图只清理alpha并平移补边，没有压缩或旋转站姿。顶层anchor/contactPoints对应中性趴姿；过渡帧以files各自anchor为准。原图坐标乘uniformScaleToNative，再加translationNative，最后乘2；最低像素行按2倍块的下沿实测。统一脚底基线为y=2909，各脚偏差≤2px。腹部不可穿过衣服直接观测，belly明确记录为对应衣摆下缘的接地代理点；前掌是可见手掌，后掌是两只靴底。前掌和衣摆的透视接触点不强制与后脚处于同一像素行。起身采用下降序列反放，端点和中性帧合法复用，7帧位并非7张独立新画。没有定义播放速度、概率或停留时间。'
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
