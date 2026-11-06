/**
 * 姿态门禁的**新判据**单测（M2 切片 3）：G-P11 可达性、G-P12 禁镜像、G-P14「在动」。
 *
 * <p><b>为什么这三条必须各自有用例：</b>它们守的都是"数据全合法、门禁全绿、用户看不到/看到错"的
 * 失效形态：</p>
 * <ol>
 *   <li><b>G-P11</b>：`lie` 同时产出 `hold` 与 `enter` 时，候选序里 `hold` 在前 ⇒ `enter` 永远不可达
 *       （趴下动画一次都播不出来），而包络/时序/体积/朝向全绿；</li>
 *   <li><b>G-P12</b>：静态姿态缺右向时用 `scaleX(-1)` 凑合——所有数值判据都不会红，只有肉眼看得出
 *       "猫被翻面了"；</li>
 *   <li><b>G-P14</b>：两帧同图被当成动画（帧数 2 但 distinct contentId 1）⇒ rAF 空转、画面静止。</li>
 * </ol>
 *
 * <p>每个判据都配"必须红"的变异样本（只改坏一处），并保留"真清单必须零问题"的基线自证
 * ——只验绿或只验红都会让判据腐化成恒等式。</p>
 *
 * @module tests/petPoseGate
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  PICK_CANDIDATE_IDS,
  checkClipMotion,
  checkClipReachability,
  checkNoMirrorRender,
  checkPickOrderDrift,
  runPoseGate,
  stripSourceComments,
} from '../scripts/check-pet-poses.mjs';

/** 已提交的运行清单路径。 */
const POSES_JSON_PATH = resolve(import.meta.dirname, '..', 'pet-poses.json');

/** 已提交的运行清单（原始 JSON）。 */
const MANIFEST = JSON.parse(readFileSync(POSES_JSON_PATH, 'utf8')) as Record<string, any>;

/**
 * 深拷贝真清单。
 *
 * @returns 可随意改的副本
 */
function manifestCopy(): Record<string, any> {
  return JSON.parse(JSON.stringify(MANIFEST)) as Record<string, any>;
}

/**
 * 把一份清单写进临时目录，跑完删掉（临时文件前缀 `kou-posegate-`，绝不碰 `.lingxi/tmp`）。
 *
 * @param manifest 清单
 * @returns 临时清单绝对路径与清理函数
 */
function writeTempManifest(manifest: Record<string, any>): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), 'kou-posegate-'));
  const path = resolve(dir, 'pet-poses.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('P-01 基线自证：真清单在三门新判据上零问题（否则后面的红说明不了任何事）', () => {
  // G-P11：每一批、每一朝向都不许有"主选择器候选"片段并存
  for (const [posture, batch] of Object.entries(MANIFEST.batches) as Array<[string, any]>) {
    assert.deepEqual(checkClipReachability(batch), [], `${posture} 的片段可达性不该有问题`);
  }
  // G-P11 的对账项：门禁的候选序与 controller.pickClip 的真实现一致
  assert.deepEqual(checkPickOrderDrift(), [], '候选序与 controller 漂移了：G-P11 会按错的顺序判');
  // G-P12：渲染层里一个镜像变换都没有
  assert.deepEqual(checkNoMirrorRender(), [], '渲染层出现了镜像变换');
  // G-P14：每一批的每个多帧片段都必须真的"在动"
  for (const [posture, batch] of Object.entries(MANIFEST.batches) as Array<[string, any]>) {
    assert.deepEqual(checkClipMotion(batch), [], `${posture} 的"在动"判据不该有问题`);
  }
});

test('P-01 金丝雀：候选序常量与 lie 的片段形态（enter + exit，没有 hold）', () => {
  assert.deepEqual([...PICK_CANDIDATE_IDS], ['hold', 'cycle', 'once', 'enter'], '候选序是 G-P11 的判据前提');
  const lieClipIds = (MANIFEST.batches.lie.clips as any[]).map((clip) => clip.id).sort();
  assert.deepEqual(lieClipIds, ['enter', 'exit'], 'lie 只该有 enter + exit（构建期合并，设计 §4.2 方案 B）');
  // exit 刻意不在候选序里：它由"离开姿态"的专用路径选中（混进来会让"进姿态"顺手播起身）
  assert.equal(PICK_CANDIDATE_IDS.includes('exit'), false, 'exit 不许进主选择器候选序');
});

test('G-P11 变异：给 lie 加回一条 hold ⇒ 必红且点名 hold 与 enter（enter 会被永久遮住）', () => {
  const batch = manifestCopy().batches.lie;
  const enter = (batch.clips as any[]).find((clip) => clip.id === 'enter');
  assert.ok(enter, '前置：lie 必须有 enter');
  // 只加一条 hold（帧照抄 enter 的末帧 = "趴着不动"），其余一字不改
  batch.clips = [
    ...batch.clips,
    { id: 'hold', facing: enter.facing, frames: [enter.frames.at(-1)], loop: false, frameMs: [0], onEnd: 'hold-last' },
  ];
  const problems = checkClipReachability(batch);
  assert.equal(problems.length, 1, `必须正好红一条，实际：${JSON.stringify(problems)}`);
  assert.match(problems[0], /G-P11/);
  assert.match(problems[0], /hold@-1/, '必须点名 hold 那条片段');
  assert.match(problems[0], /enter@-1/, '必须点名 enter 那条片段（它才是被遮住的那条）');
  assert.match(problems[0], /永远不可达/, '文案必须说清"不可达"，否则读的人以为只是命名问题');
});

test('G-P11 反名字表：换一个姿态名与片段名，判据照样成立（不依赖 lie/hold 字面量）', () => {
  const batch = {
    posture: 'dream',
    clips: [
      { id: 'cycle', facing: 1, frames: ['a'], loop: true, frameMs: [100] },
      { id: 'once', facing: 1, frames: ['b'], loop: false, frameMs: [100], onEnd: 'return-stand' },
    ],
    frames: {},
  };
  const problems = checkClipReachability(batch);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cycle@1/);
  assert.match(problems[0], /once@1/);
});

test('G-P11 对账项变异：controller.pickClip 的候选序被改掉 ⇒ checkPickOrderDrift 必红', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'kou-posegate-'));
  try {
    const fakePath = resolve(dir, 'controller.ts');
    writeFileSync(
      fakePath,
      [
        'export class PoseController {',
        '  private pickClip(batch: PoseBatch): PoseClip | null {',
        "    for (const id of ['cycle', 'hold', 'once', 'enter']) {",
        '      return null;',
        '    }',
        '    return null;',
        '  }',
        '  private handleFrame(): void {}',
        '}',
      ].join('\n'),
      'utf8',
    );
    const problems = checkPickOrderDrift({ controllerPath: fakePath });
    assert.equal(problems.length, 1, `必须红一条，实际：${JSON.stringify(problems)}`);
    assert.match(problems[0], /候选序/);
    assert.match(problems[0], /cycle, hold/, '必须把实现里的顺序打出来（读的人才能对照）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G-P12 / P-18：渲染层出现 scaleX(-1) ⇒ 必红；注释里提到不算（去注释后扫描）', () => {
  const injected = [
    { path: 'src/pet/pet.css', text: '.pet-action { transform: scaleX(-1); }\n' },
    { path: 'src/pet/poses/controller.ts', text: "style.transform = 'scale(-1, 1)';\n" },
    { path: 'src/pet/main.ts', text: '// 这里以前写过 scaleX(-1)，已删除\nconst x = 1;\n' },
    { path: 'src/pet/pet.css', text: '.pet-halo { transform: scaleX(0.92); }\n' },
  ];
  const problems = checkNoMirrorRender({ files: injected });
  assert.equal(problems.length, 2, `必须正好红两条（CSS 内联与 style 各一条），实际：${JSON.stringify(problems)}`);
  assert.match(problems[0], /src\/pet\/pet\.css:1/);
  assert.match(problems[0], /scaleX\(-1\)/);
  assert.match(problems[0], /G-P12/);
  assert.match(problems[1], /controller\.ts:1/);
  assert.match(problems[1], /scale\(负数/);
  // 注释剥离本身也要可测：块注释里的写法同样不算违规
  assert.equal(stripSourceComments('/* scaleX(-1) */').trim(), '');
  assert.deepEqual(checkNoMirrorRender({ files: [{ path: 'x.css', text: '/* scaleX(-1) */' }] }), []);
});

test('G-P14 变异：四帧同图 ⇒ 判红（帧数不是"在动"的证据），单帧片段显式豁免', () => {
  const batch = manifestCopy().batches.lie;
  const enter = (batch.clips as any[]).find((clip) => clip.id === 'enter');
  assert.ok(enter, '前置：lie 必须有 enter');
  // 只把 enter 的四帧全指向同一张画（帧数、frameMs、片段形态都不变）
  const neutralId = enter.frames.at(-1) as string;
  const mutated = {
    ...batch,
    clips: batch.clips.map((clip: any) =>
      clip.id === 'enter' ? { ...clip, frames: [neutralId, neutralId, neutralId, neutralId] } : clip,
    ),
  };
  const problems = checkClipMotion(mutated);
  assert.equal(problems.length, 1, `必须正好红一条，实际：${JSON.stringify(problems)}`);
  assert.match(problems[0], /G-P14/);
  assert.match(problems[0], /distinct contentId/);
  assert.match(problems[0], /假动画/);

  // 单帧片段显式豁免：它本来就该是静止的。
  // 切片 4 起 `sit` 不再是单帧静姿（坐姿 = 7 帧眨眼循环，见 supplemental/gif-v1 的 clips.sit_blink），
  // 所以这条豁免的样本改用**真清单里仍然单帧**的片段（sleep.exit = 单帧 startle×300），
  // 并把 sit 单帧的说法换成"sleep 的 exit 就是单帧"——前提变了，判据本身一个字没放宽。
  assert.deepEqual(checkClipMotion(MANIFEST.batches.sleep), [], '单帧 exit 必须被豁免，不许判红');
  const sleepExit = (MANIFEST.batches.sleep.clips as any[]).find((clip) => clip.id === 'exit');
  assert.ok(sleepExit, '前置：sleep 必须有 exit');
  assert.equal(sleepExit.frames.length, 1, '前置：sleep 的 exit 就是单帧');

  // 缺 contentId ⇒ 判红（"无法判断是否在动"与"在动"是两句不同的话）
  const noContentId = {
    ...MANIFEST.batches.sleep,
    frames: Object.fromEntries(
      Object.entries(MANIFEST.batches.sleep.frames).map(([frameId, frame]: [string, any]) => [
        frameId,
        { ...frame, files: { '1x': { ...frame.files['1x'], contentId: undefined }, '2x': frame.files['2x'] } },
      ]),
    ),
  };
  const missing = checkClipMotion(noContentId);
  assert.ok(missing.length > 0, '缺 contentId 必须红');
  assert.match(missing[0], /缺少合法的 contentId/);
});

test('G-P14 接线（整门禁）：变异清单跑 runPoseGate ⇒ 问题里必须出现 G-P14 行', async () => {
  const manifest = manifestCopy();
  const enter = (manifest.batches.lie.clips as any[]).find((clip) => clip.id === 'enter');
  const neutralId = enter.frames.at(-1) as string;
  manifest.batches.lie.clips = manifest.batches.lie.clips.map((clip: any) =>
    clip.id === 'enter' ? { ...clip, frames: [neutralId, neutralId, neutralId, neutralId] } : clip,
  );
  const temp = writeTempManifest(manifest);
  try {
    const result = await runPoseGate({ posesJsonPath: temp.path });
    assert.equal(result.ok, false, '变异清单必须让整门禁红');
    assert.ok(
      result.problems.some((line: string) => /G-P14/.test(line)),
      `问题里必须有 G-P14 行（说明判据真的接进了 runPoseGate）：${JSON.stringify(result.problems.slice(0, 6))}`,
    );
  } finally {
    temp.cleanup();
  }
});