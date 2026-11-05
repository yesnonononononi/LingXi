/**
 * 运行时清单契约单测（`src/pet/poses/{types,units,manifest}.ts`）。
 *
 * <p>本文件守两件"静默错"的事，二者都只有机器断言抓得住：</p>
 * <ol>
 *   <li><b>G-10 比例等式</b>：`masterToCss === artWidth / canvasWidth` 且
 *       `nativeToCss === masterToCss × 2`。不成立就说明有人"为了塞进窗口而缩放了资产"，
 *       表现为换姿时角色忽大忽小（肉眼要两帧对比才看得出）。</li>
 *   <li><b>G-09 域混用</b>：把母版值当 native 用。历史上真发生过——`bodyAnchor` 的母版值
 *       被当成 native，四倍偏差，把 `run` 算成"只需 31 CSS px、完全装得下"（真实 249.5）。</li>
 * </ol>
 *
 * <p>另有两条**静态扫描**（B8 的公约）：`src/pet/poses/**` 不许出现裸比例与裸换算
 * （`units.ts` 是唯一换算实现，豁免），`src/pet/**` 不许出现 `docs/` 路径字面量
 * （引擎只读 `frontend/pet-poses.json`，读美术目录等于让运行时依赖资产库布局）。</p>
 *
 * <p>运行：`npm run test:pet`（tsx --test）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PET_GEOMETRY } from '../src/pet/layout';
import {
  PET_POSES,
  PET_POSES_GENERATED_BY,
  PET_POSES_VERSION,
  assertScaleConsistent,
  batchOf,
  clipOf,
  densityFor,
  frameOf,
  isPlayable,
  normalizePetPoses,
} from '../src/pet/poses/manifest';
import type { PetPoses, PoseScale } from '../src/pet/poses/types';

const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSES_SRC_DIR = join(FRONTEND_ROOT, 'src', 'pet', 'poses');
const PET_SRC_DIR = join(FRONTEND_ROOT, 'src', 'pet');

/** 64 位小写十六进制（fixture 里当占位 sha256 用）。 */
const SHA = 'a'.repeat(64);

/**
 * 造一张合法清单的原始 JSON（默认就是 slice-1 的 `sit` 单帧批，可按需覆盖）。
 *
 * @param patch 覆盖项（顶层字段浅覆盖）
 * @returns 可喂给 `normalizePetPoses` 的原始对象
 */
function rawPoses(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const file = (density: '1x' | '2x'): Record<string, unknown> => ({
    file: `poses/sit/sit_neutral@${density}.webp`,
    url: `lxa://pet-poses/sit/sit_neutral@${density}.webp`,
    width: density === '2x' ? 468 : 234,
    height: density === '2x' ? 468 : 234,
    bytes: density === '2x' ? 4096 : 1024,
    sha256: SHA,
    format: 'webp-lossless',
  });
  const batch = {
    posture: 'sit',
    assetId: 'fixture-sit',
    status: 'awaiting-static-review',
    masterScale: 2,
    canvas: { width: 2048, height: 3072 },
    nativeCanvas: { width: 1024, height: 1536 },
    bodyAnchor: {
      byFacing: { '-1': { x: 474, y: 1454 }, '1': { x: 474, y: 1454 } },
      byFacingSource: 'batch-single',
    },
    envelopeCss: { left: -56.21, right: 67.72, top: -173.19, bottom: 0.08 },
    clips: [{ id: 'hold', frames: ['sit_neutral'], loop: false, frameMs: [0], onEnd: 'hold-last' }],
    frames: {
      sit_neutral: {
        id: 'sit_neutral',
        facing: -1,
        files: { '1x': file('1x'), '2x': file('2x') },
        anchorNative: { x: 474, y: 1454 },
        inkNative: { left: 105, top: 375, right: 918.5, bottom: 1454.5 },
        airborneGapNative: null,
        supportFootX: 1024,
      },
    },
    provenance: {
      adapter: 'legacy-v1',
      manifestSha256: SHA,
      consumedKeys: ['files[].bbox', 'bodyAnchor'],
      aliasesResolved: [],
    },
  };
  return {
    version: PET_POSES_VERSION,
    generatedBy: PET_POSES_GENERATED_BY,
    sourceRoot: 'docs/assets/desktop-pet/poses',
    scale: {
      masterToCss: 156 / 2048,
      nativeToCss: (156 / 2048) * 2,
      artWidth: 156,
      canvasWidth: 2048,
    },
    align: { xNative: 479.7, yNative: 1454, xSource: 'measured-blue-skirt-centroid' },
    densities: ['1x', '2x'],
    batches: { sit: batch },
    accepted: ['sit'],
    deferred: [],
    degradations: ['no-face-overlay', 'no-blink'],
    totals: { frames: 1, bytes1x: 1024, bytes2x: 4096 },
    ...patch,
  };
}

/**
 * 深拷贝一份原始清单（避免用例之间互相污染）。
 *
 * @param value 原始对象
 * @returns 深拷贝
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 读源码并去掉注释（**保留字符串字面量**）。
 *
 * <p>为什么去注释：本模块的文档注释必须能点名 `0.15234375` 这类"反面教材"值，
 * 否则下一个人根本不知道这条扫描在防什么。代码里出现才算实现。</p>
 *
 * @param text 源码
 * @returns 去注释后的文本（行号不变）
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (matched) => matched.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index >= 0 ? line.slice(0, index) : line;
    })
    .join('\n');
}

test('空清单是合法中间态：不抛错、不可播、取批次返回 null（资产未到不等于坏数据）', () => {
  const empty = rawPoses({ batches: {}, accepted: [], deferred: [], totals: { frames: 0, bytes1x: 0, bytes2x: 0 } });
  const poses = normalizePetPoses(empty);
  assert.deepEqual(poses.accepted, []);
  assert.equal(batchOf(poses, 'sit'), null);
  assert.equal(isPlayable(poses, 'sit'), false, '没有资产时 sit 必须判不可播（引擎回落站姿）');
  assert.equal(isPlayable(poses, 'stand'), true, '站姿永远可播（它就是回落目标）');
});

test('合法清单可加载，且 accepted 才可播（"有资产"与"被接受"是两件事）', () => {
  const poses = normalizePetPoses(rawPoses());
  const batch = batchOf(poses, 'sit');
  assert.ok(batch, '合法数据必须解析出 sit 批');
  assert.equal(batch?.posture, 'sit');
  assert.equal(isPlayable(poses, 'sit'), true);
  assert.equal(clipOf(batch!, 'hold')?.frames.length, 1);
  assert.equal(frameOf(batch!, 'sit_neutral')?.inkNative.bottom, 1454.5);
  assert.equal(clipOf(batch!, 'nope'), null);
  assert.equal(frameOf(batch!, 'nope'), null);

  // 从 accepted 里摘掉：资产还在，但不许播（`status` 是美术声明，不驱动行为）
  const dropped = rawPoses({ accepted: [] });
  assert.equal(isPlayable(normalizePetPoses(dropped), 'sit'), false);
});

test('G-10 比例等式：masterToCss === artWidth / canvasWidth，且 nativeToCss 是其两倍', () => {
  const scale: PoseScale = PET_POSES.scale;
  // 金丝雀：等式两侧都必须非 0，否则 `0 === 0` 会让这条断言空转
  assert.ok(scale.masterToCss > 0, 'masterToCss 不能是 0');
  assert.ok(PET_GEOMETRY.artWidth > 0 && PET_GEOMETRY.canvasWidth > 0);
  assert.ok(
    Math.abs(scale.masterToCss - PET_GEOMETRY.artWidth / PET_GEOMETRY.canvasWidth) <= 1e-9,
    `比例不自洽：masterToCss=${scale.masterToCss}，artWidth/canvasWidth=${PET_GEOMETRY.artWidth / PET_GEOMETRY.canvasWidth}`,
  );
  assert.ok(Math.abs(scale.nativeToCss - scale.masterToCss * 2) <= 1e-12);
  // 逐值钉死（改一格就必须改这里，改这里就必须说明为什么）
  assert.equal(scale.masterToCss, 0.076171875);
  assert.equal(scale.nativeToCss, 0.15234375);

  // 变异：把几何真源的 artWidth 改成 157 ⇒ 必须红
  const mutated = { ...PET_GEOMETRY, artWidth: 157 };
  assert.throws(() => assertScaleConsistent(scale, mutated), RangeError);
  // 变异：nativeToCss 少一倍 ⇒ 必须红
  assert.throws(
    () => assertScaleConsistent({ ...scale, nativeToCss: scale.masterToCss }, PET_GEOMETRY),
    RangeError,
  );
});

test('G-09 域混用：把母版锚点当 native 塞进来必须抛错（合法数据不触发）', () => {
  // 金丝雀：合法数据必须不触发该断言
  assert.doesNotThrow(() => normalizePetPoses(rawPoses()));

  // 变异 1：bodyAnchor.x = 948（= sit 的母版值 474 × 2）⇒ 掉到墨迹右缘 918.5 之外
  const misused = clone(rawPoses());
  const batch = (misused.batches as Record<string, Record<string, unknown>>).sit;
  batch.bodyAnchor = { byFacing: { '-1': { x: 948, y: 1454 }, '1': { x: 948, y: 1454 } }, byFacingSource: 'batch-single' };
  assert.throws(() => normalizePetPoses(misused), RangeError, '母版锚点当 native 用却仍然通过：域守卫失效');

  // 变异 2：把 native 画布填进母版字段 canvas ⇒ 倍率变成 1
  const swapped = clone(rawPoses());
  const swappedBatch = (swapped.batches as Record<string, Record<string, unknown>>).sit;
  swappedBatch.canvas = { width: 1024, height: 1536 };
  assert.throws(() => normalizePetPoses(swapped), RangeError, '母版/native 画布互换却仍然通过：域守卫失效');

  // 变异 3：把对齐点 x 塞到 native 画布之外（1200 > 1024）⇒ 必须红。
  // 注意：母版值 959（= 479.7 × 2）仍在 native 画布内，结构校验抓不到它——
  // 那种混用由 G-04 的包络断言抓（E-02 的金丝雀：align.xNative 改 400 ⇒ 包络必须红）。
  const badAlign = rawPoses({ align: { xNative: 1200, yNative: 1454, xSource: 'measured-blue-skirt-centroid' } });
  assert.throws(() => normalizePetPoses(badAlign), RangeError);
});

test('清单结构校验：缺帧、时长不等长、accepted 指向不存在的批都必须硬失败', () => {
  const missingFrame = clone(rawPoses());
  const missingBatch = (missingFrame.batches as Record<string, Record<string, unknown>>).sit;
  missingBatch.clips = [{ id: 'hold', frames: ['ghost'], loop: false, frameMs: [0] }];
  assert.throws(() => normalizePetPoses(missingFrame), TypeError);

  const badTiming = clone(rawPoses());
  const badTimingBatch = (badTiming.batches as Record<string, Record<string, unknown>>).sit;
  badTimingBatch.clips = [{ id: 'hold', frames: ['sit_neutral'], loop: false, frameMs: [0, 100] }];
  assert.throws(() => normalizePetPoses(badTiming), RangeError);

  const phantomAccept = rawPoses({ accepted: ['lie'] });
  assert.throws(() => normalizePetPoses(phantomAccept), TypeError, 'accepted 声明了没资产的批次必须红');

  const badVersion = rawPoses({ version: 2 });
  assert.throws(() => normalizePetPoses(badVersion), RangeError);
});

test('E-01 对齐线：align.yNative 是 native 域 1454，Py = artOrigin.y + yNative × nativeToCss', () => {
  const { align, scale } = PET_POSES;
  assert.equal(align.yNative, 1454, 'align.yNative 必须是 native 域的 1454（不是母版 2908）');
  assert.equal(align.xNative, 479.7);
  // artOrigin.y = effectMargin.top(24) + bubbleHeight(72) = 96
  const artOriginY = PET_GEOMETRY.effectMargin.top + PET_GEOMETRY.bubbleHeight;
  assert.equal(artOriginY, 96);
  const py = artOriginY + align.yNative * scale.nativeToCss;
  // 1454 × 0.15234375 = 221.5078125 → Py = 317.5078125（E-01 的 317.51 是它的两位小数）
  assert.ok(Math.abs(py - 317.5078125) < 1e-9, `Py 必须是 317.5078125，实际 ${py}`);
  // 反面教材（E-01 原文的错误算式）：96 + 234 × 2908/6144 = 206.75，差 110.8 CSS px
  const wrong = artOriginY + 234 * (2908 / 6144);
  assert.ok(Math.abs(wrong - 206.75) < 0.01, `错误算式应得 206.75，实际 ${wrong}`);
  assert.ok(Math.abs(wrong - py) > 100, 'E-01 的错法与正确值必须差出量级，否则这条守不住任何东西');
});

test('densityFor：1.49→@1x、1.5→@2x，非有限数按 1 处理（不可信输入）', () => {
  assert.equal(densityFor(1), '1x');
  assert.equal(densityFor(1.49), '1x');
  assert.equal(densityFor(1.5), '2x');
  assert.equal(densityFor(2), '2x');
  assert.equal(densityFor(Number.NaN), '1x');
  // 非有限数（含 Infinity）一律按 1 处理：不可信输入下宁可糊一点，也不要挑一个不存在的档
  assert.equal(densityFor(Number.POSITIVE_INFINITY), '1x');
});

test('静态扫描：src/pet/poses/** 不得出现裸比例与裸换算（units.ts 是唯一豁免）', () => {
  const forbidden = [
    { pattern: /0\.15234375/, reason: 'native→CSS 比例必须从清单读（经 units.ts）' },
    { pattern: /0\.076171875/, reason: '母版→CSS 比例必须从清单读（经 units.ts）' },
    { pattern: /6144/, reason: 'E-01 的错误分母：母版 3072 × 2 冒充站姿母线' },
    { pattern: /[*]\s*2(?![0-9.])/, reason: '裸 ×2（母版↔native 只能经 units.ts）' },
    { pattern: /\/\s*2(?![0-9.])/, reason: '裸 ÷2（母版↔native 只能经 units.ts）' },
  ];
  const files = readdirSync(POSES_SRC_DIR).filter((name) => name.endsWith('.ts') && name !== 'units.ts');
  assert.ok(
    readdirSync(POSES_SRC_DIR).includes('units.ts'),
    'units.ts 不存在：豁免名单失效会让这条扫描失去意义',
  );
  assert.ok(files.length >= 2, `扫描集太小（${files.length} 个文件），守卫会空转`);
  for (const name of files) {
    const code = stripComments(readFileSync(join(POSES_SRC_DIR, name), 'utf8'));
    for (const { pattern, reason } of forbidden) {
      assert.equal(pattern.test(code), false, `${name} 命中 ${pattern}：${reason}`);
    }
  }
});

test('静态扫描：src/pet/** 不得出现 docs/ 路径字面量（引擎只读 pet-poses.json）', () => {
  const collected: string[] = [];
  /** 深度优先收集 .ts 文件。 */
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      collected.push(full);
    }
  };
  walk(PET_SRC_DIR);
  assert.ok(collected.length > 10, `扫描集太小（${collected.length} 个文件），守卫会空转`);
  const offenders: string[] = [];
  for (const file of collected) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/docs\//.test(code) || /docs\\/.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `这些文件出现了美术目录字面量：${offenders.join(', ')}`);
});

test('PET_POSES 单例与 JSON 真源一致（加载即校验，非法数据在 boot 前就炸）', () => {
  const source = JSON.parse(readFileSync(join(FRONTEND_ROOT, 'pet-poses.json'), 'utf8')) as PetPoses;
  assert.equal(PET_POSES.version, source.version);
  assert.equal(PET_POSES.generatedBy, source.generatedBy);
  assert.deepEqual([...PET_POSES.accepted], [...source.accepted]);
  assert.deepEqual([...PET_POSES.densities], [...source.densities]);
});
