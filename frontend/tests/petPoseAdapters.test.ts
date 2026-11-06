/**
 * pose adapter 与构建期漂移检测单测（tsx 执行，纯 node）。
 *
 * <p><b>这个文件存在的理由：</b>adapter 是"美术 manifest → 运行时清单"的唯一翻译层。
 * 它最危险的失效方式不是抛错，而是<b>翻译得太顺</b>——把母版锚点透传成 native 锚点、
 * 把美术逐帧实测的离散度丢掉、把 7 个帧位当 7 张不同像素导出。三者都不会报错，
 * 只会让"看起来绿"的守卫全部变成恒等式。所以这里每条判据都配一个"必须红"的变异样本。</p>
 *
 * <p>覆盖守卫：G-08（批内锚一致）、G-11（锚语义隔离）、G-12（构建期漂移检测）、
 * G-14（腾空相位）、G-15（体积与去重）；另加"结构漂移必须硬失败"与"accepted 登记是显式的"。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  ACCEPTED_BATCHES,
  ANCHOR_SPREAD_MAX_NATIVE,
  BATCH_SPECS,
  DEFERRED_REASONS,
  FRAME_TIMING,
  PoseAdapterError,
  adaptAll,
  adaptBatch,
  detectAdapter,
  normalizeAnchorSpread,
  sha256OfFile,
} from '../scripts/pet-pose-adapters.mjs';
import {
  POSES_JSON_PATH,
  runBuild,
} from '../scripts/build-pet-poses.mjs';
// 体积预算的真源（**不**再经 build-pet-poses 转手）：`scripts/pet-budget.mjs`。
import { FRAME_2X_MAX_BYTES, POSE_TOTAL_MAX_BYTES } from '../scripts/pet-budget.mjs';
import { checkDomains } from '../scripts/check-pet-poses.mjs';
import { FRONTEND_ROOT } from '../scripts/build-pet-geometry.mjs';

/** 仓库根（`frontend/` 的上一级）。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** 美术源根（绝对路径）。 */
const POSE_SOURCE_ROOT = resolve(REPO_ROOT, 'docs', 'assets', 'desktop-pet', 'poses');

/** 已提交的运行清单（真实生成物）。 */
const POSES_MANIFEST = JSON.parse(readFileSync(POSES_JSON_PATH, 'utf8')) as {
  batches: Record<string, Record<string, any>>;
  accepted: string[];
  deferred: Array<{ posture: string; reason: string }>;
  totals: { frames: number; bytes1x: number; bytes2x: number };
};

/** 归一结果缓存（adaptAll 会读 6 份 manifest，多个用例共用一份）。 */
let cachedDrafts: Record<string, any> | null = null;

/**
 * 取一次全量归一结果（懒加载缓存）。
 *
 * @returns adaptAll 的结果
 */
function adaptEverything(): { drafts: Record<string, any>; deferred: Array<any>; missing: string[]; problems: string[] } {
  const result = adaptAll({ repoRoot: REPO_ROOT });
  if (result.problems.length > 0) {
    assert.fail(`adapter 无法归一美术资产：\n${result.problems.join('\n')}`);
  }
  if (cachedDrafts === null) cachedDrafts = result.drafts;
  return result;
}

/**
 * 读某批美术源 manifest 的原始对象。
 *
 * @param posture 批次名
 * @returns 原始 manifest
 */
function readSourceManifest(posture: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(POSE_SOURCE_ROOT, posture, 'manifest.json'), 'utf8')) as Record<string, any>;
}

test('accepted 是显式登记：切片 3 起六批全部可播，adapter 归属逐批写死（改一处必须改本测试）', () => {
  assert.deepEqual(
    [...ACCEPTED_BATCHES],
    ['sit', 'walk', 'run', 'jump', 'lie', 'sleep'],
    'ACCEPTED_BATCHES 变了：这是"工程接受"的唯一开关，必须同步改测试',
  );
  const mapping = Object.fromEntries(
    (BATCH_SPECS as Array<{ posture: string; adapter: string }>).map((spec) => [spec.posture, spec.adapter]),
  );
  assert.deepEqual(mapping, {
    sit: 'legacy-v1',
    lie: 'files-sequences-v2',
    sleep: 'frames-nested-v3',
    walk: 'frames-nested-v3',
    run: 'frames-nested-v3',
    jump: 'frames-nested-v3',
  });
  // 金丝雀：6 批都在登记表里（少登记一批 ⇒ adaptAll 永远不会碰它，等于静默丢掉一批资产）
  assert.equal(Object.keys(mapping).length, 6);
  // 时序也必须逐批登记（美术 6 批里 0 个时序字段，速度归工程侧）
  for (const posture of Object.keys(mapping)) {
    assert.ok(
      (FRAME_TIMING as Record<string, Record<string, number>>)[posture] !== undefined,
      `${posture} 没有登记帧时长`,
    );
  }
  const result = adaptEverything();
  assert.deepEqual(result.missing, [], `有批次资产缺失：${result.missing.join(', ')}`);
  assert.deepEqual(
    Object.keys(result.drafts).sort(),
    ['jump', 'lie', 'run', 'sit', 'sleep', 'walk'],
    '草稿里应当有全部六批（切片 3 起 lie/sleep 也 accepted）；少一批说明 accepted 与真资产脱节',
  );
  assert.deepEqual(result.deferred ?? [], [], '六批全部 accepted ⇒ 不许再有任何 deferred 批次');
  // 幽灵守卫：已 accepted 的批次不许还留着 deferred 理由（"已可播却仍说未导出"）
  for (const posture of ACCEPTED_BATCHES) {
    assert.equal(
      (DEFERRED_REASONS as Record<string, string>)[posture],
      undefined,
      `${posture} 已 accepted，DEFERRED_REASONS 里不许再有它的理由`,
    );
  }
});

test('G-08：批内帧锚点与批级 bodyAnchor 一致（≤2 native），且离散度实测值被真收下', () => {
  const { drafts } = adaptEverything();
  const all = { ...drafts };
  // deferred 批次也要查：它们虽然不导出，但 adapter 已经把锚点算出来了，超限同样是数据问题
  const deferredDrafts = adaptAll({ repoRoot: REPO_ROOT, accepted: [...BATCH_SPECS.map((spec: any) => spec.posture)] }).drafts;
  Object.assign(all, deferredDrafts);

  for (const [posture, batch] of Object.entries(all) as Array<[string, any]>) {
    const spread = batch.bodyAnchor.spreadNative;
    assert.notEqual(spread, undefined, `${posture} 丢了 spreadNative：G-08 会退化成恒等式`);
    assert.notEqual(spread, null, `${posture} 的 spreadNative 是 null：说明没读到美术的实测汇总`);
    assert.ok(
      Math.abs(spread) <= ANCHOR_SPREAD_MAX_NATIVE,
      `${posture} 的 spreadNative=${spread} 超过 ${ANCHOR_SPREAD_MAX_NATIVE} native`,
    );
    // 逐帧锚点必须与批级一致（adapter 从批级派生；将来若改成逐帧读，这里就是红的哨兵）
    for (const [frameId, frame] of Object.entries(batch.frames ?? {}) as Array<[string, any]>) {
      const anchor = batch.bodyAnchor.byFacing[String(frame.facing)];
      assert.equal(frame.anchorNative.x, anchor.x, `${posture}/${frameId} 的锚点 x 与批级不一致`);
      assert.equal(frame.anchorNative.y, anchor.y, `${posture}/${frameId} 的锚点 y 与批级不一致`);
    }
  }

  // 金丝雀：sleep 的实测 spread = 1.75（**不是 0**，证明这个数来自美术而不是自造）
  assert.equal(all.sleep.bodyAnchor.spreadNative, 1.75, 'sleep 的 spreadNative 应为实测 1.75');
  assert.equal(all.sleep.bodyAnchor.maxDeviationNative, 1, 'sleep 的 maxDeviationNative 应为实测 1');
  // 多朝向批（run）逐朝向报的离散度要取最大值 1.1（0.77 vs 1.1）
  assert.equal(all.run.bodyAnchor.spreadNative, 1.1, 'run 的 spreadNative 应取两朝向最大值 1.1');
  // sit 是单帧批：离散度 0，但 maxDeviationNative 0.16 证明"0"是实测出来的 0
  assert.equal(all.sit.bodyAnchor.spreadNative, 0);
  assert.equal(all.sit.bodyAnchor.maxDeviationNative, 0.16);
});

test('G-08 变异：离散度超 2 native ⇒ adapter 与清单校验都必须硬失败（不许放宽阈值）', () => {
  // ① adapter 侧：3 native 的离散度必须当场拒绝
  assert.throws(
    () => normalizeAnchorSpread(3, null, 'sleep'),
    (err: unknown) => err instanceof PoseAdapterError && /G-08/.test((err as Error).message),
    'spreadNative=3 被放过了：G-08 阈值失效',
  );
  // ② 多朝向对象形态也要拦（run 的真实形态）
  assert.throws(() => normalizeAnchorSpread({ '1': 0.5, '-1': 2.5 }, null, 'run'), PoseAdapterError);
  // ③ 负数不是"更好"，是脏数据
  assert.throws(() => normalizeAnchorSpread(-1, null, 'run'), PoseAdapterError);
  // ④ 清单侧：把已生成清单里的 spreadNative 改大 ⇒ 门禁判据必须报错
  const batch = JSON.parse(JSON.stringify(POSES_MANIFEST.batches.sit));
  batch.bodyAnchor.spreadNative = 2.4;
  const problems = checkDomains(batch);
  assert.ok(
    problems.some((line: string) => line.includes('spreadNative') && line.includes('G-08')),
    `门禁没拦住 spreadNative 超限：${problems.join('; ')}`,
  );
  // ⑤ 反过来：删掉它必须是红的（"没有证据"不等于"没有偏差"）
  const stripped = JSON.parse(JSON.stringify(POSES_MANIFEST.batches.sit));
  delete stripped.bodyAnchor.spreadNative;
  assert.ok(
    checkDomains(stripped).some((line: string) => line.includes('spreadNative')),
    '清单里删掉 spreadNative 却没红：G-08 会真空通过',
  );
  // ⑥ 真实清单本身必须绿
  assert.deepEqual(checkDomains(JSON.parse(JSON.stringify(POSES_MANIFEST.batches.sit))), []);
});

test('G-11：PoseBatch 上不存在 anchor 字段（6 批全查），lie 的 native 锚与母版 anchor/2 的差被显式记录', () => {
  const { drafts } = adaptEverything();
  const all = adaptAll({ repoRoot: REPO_ROOT, accepted: [...BATCH_SPECS.map((spec: any) => spec.posture)] }).drafts;
  const every = { ...drafts, ...all };

  for (const [posture, batch] of Object.entries(every) as Array<[string, any]>) {
    assert.equal('anchor' in batch, false, `${posture} 的草稿里出现了母版 anchor 字段：域混用入口被打开了`);
    assert.equal('anchor' in (POSES_MANIFEST.batches[posture] ?? {}), false, `${posture} 的运行清单里出现了 anchor`);
  }

  // lie：母版 anchor.y=2909 ⇒ anchor.y/2=1454.5，而实测 bodyAnchor.y=1468，差 13.5
  const lieSource = readSourceManifest('lie');
  assert.equal(lieSource.anchor.y, 2909, 'lie 的母版 anchor.y 变了，本用例的差值断言需要同步');
  const lieDiff = all.lie.bodyAnchor.byFacing['-1'].y - lieSource.anchor.y / 2;
  assert.equal(Number(lieDiff.toFixed(4)), 13.5, `lie 的 native 锚应比母版 anchor/2 高 13.5，实际 ${lieDiff}`);
  // 4 个直立批的 native 锚与母版 anchor/2 **几乎相等**（差 ≤1px）：这正是"透传 anchor 也能跑通"
  // 的陷阱来源，必须显式留痕，而不是靠"它们不等"来兜底。
  const upright = ['sit', 'walk', 'run', 'jump'];
  const uprightDiffs: Record<string, number> = {};
  for (const posture of upright) {
    const source = readSourceManifest(posture);
    const derived = source.anchor.y / 2;
    const delta = all[posture].bodyAnchor.byFacing['-1'].y - derived;
    uprightDiffs[posture] = Number(delta.toFixed(4));
    assert.ok(
      Math.abs(delta) <= 1,
      `${posture} 的 native 锚与母版 anchor/2 差了 ${delta}：超出"直立批几乎相等"的已知事实，需重新确认口径`,
    );
  }
  // 金丝雀：确实存在"native 锚 === 母版 anchor/2"的批次（陷阱是真的），同时 lie 明显不等
  // （两者同时成立才说明本用例能区分"碰巧相等"与"域混用"）
  assert.ok(
    Object.values(uprightDiffs).some((delta) => delta === 0),
    `直立批里没有一批与 anchor/2 完全相等（${JSON.stringify(uprightDiffs)}），陷阱前提失效`,
  );
  assert.ok(Number(lieDiff.toFixed(4)) > 10, 'lie 的 native 锚与母版 anchor/2 必须显著不同，否则无法证明域被区分');
});

test('G-11 变异：把 anchor 透传进批次 ⇒ 运行时清单校验与门禁都必须红', () => {
  const batch = JSON.parse(JSON.stringify(POSES_MANIFEST.batches.sit));
  batch.anchor = { x: 948, y: 2908 };
  const problems = checkDomains(batch);
  assert.ok(
    problems.some((line: string) => line.includes('anchor')),
    `透传 anchor 没被拦住：${problems.join('; ')}`,
  );
  // 合法数据不触发该断言（否则守卫就是"永远红"，同样没用）
  assert.deepEqual(checkDomains(JSON.parse(JSON.stringify(POSES_MANIFEST.batches.sit))), []);
});

test('G-12：--check 在未改动时通过；改任一被消费字段 ⇒ 必须非 0', async () => {
  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'lx-pet-poses-drift-'));
  const outDir = resolve(tmpRoot, 'out');
  const posesJsonPath = resolve(tmpRoot, 'pet-poses.json');
  const sitDir = resolve(tmpRoot, 'docs', 'assets', 'desktop-pet', 'poses', 'sit');
  try {
    mkdirSync(sitDir, { recursive: true });
    // 只搬 sit（其余 5 批缺席 = 合法中间态，adaptAll 会记 missing 而不是报错）
    const sourceManifestPath = resolve(POSE_SOURCE_ROOT, 'sit', 'manifest.json');
    copyFileSync(sourceManifestPath, resolve(sitDir, 'manifest.json'));
    const sitManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as { files: Array<{ file: string }> };
    for (const entry of sitManifest.files) {
      copyFileSync(resolve(POSE_SOURCE_ROOT, 'sit', entry.file), resolve(sitDir, entry.file));
    }

    // ① 首次构建：应成功且能二次 --check 通过（证明 adapter 是确定性的）
    const build = await runBuild({ repoRoot: tmpRoot, outDir, posesJsonPath });
    assert.deepEqual(build.problems, [], `首次构建失败：${build.problems.join('; ')}`);
    assert.deepEqual(build.missing.sort(), ['jump', 'lie', 'run', 'sleep', 'walk'], '缺席批次应记为 missing');
    const firstCheck = await runBuild({ check: true, repoRoot: tmpRoot, outDir, posesJsonPath });
    assert.deepEqual(firstCheck.problems, [], `未改动时 --check 应通过：${firstCheck.problems.join('; ')}`);

    // ② 改一个**被消费**的字段（bodyAnchor.x 474 → 476）：清单漂移必须被抓住
    const mutated = JSON.parse(readFileSync(resolve(sitDir, 'manifest.json'), 'utf8')) as Record<string, any>;
    mutated.bodyAnchor.x = 476;
    writeFileSync(resolve(sitDir, 'manifest.json'), JSON.stringify(mutated, null, 2), 'utf8');
    const drifted = await runBuild({ check: true, repoRoot: tmpRoot, outDir, posesJsonPath });
    assert.ok(drifted.problems.length > 0, '改了被消费字段却仍然通过：漂移检测失效');
    assert.ok(
      drifted.problems.some((line: string) => line.includes('bodyAnchor') || line.includes('锚')),
      `漂移报告没点名改了哪里：\n${drifted.problems.join('\n')}`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('G-14：jump 的腾空相位（anticipate/land 贴地，其余腾空，apex 严格最大）', () => {
  const all = adaptAll({ repoRoot: REPO_ROOT, accepted: [...BATCH_SPECS.map((spec: any) => spec.posture)] }).drafts;
  const jump = all.jump;
  assert.ok(jump, 'jump 草稿缺失');
  const gaps: Record<string, number> = {};
  for (const [frameId, frame] of Object.entries(jump.frames) as Array<[string, any]>) {
    gaps[frameId] = frame.airborneGapNative;
  }
  const ids = Object.keys(gaps);
  assert.ok(ids.length >= 5, `jump 至少 5 帧，实际 ${ids.length}（${ids.join(',')}）`);

  // 贴地帧：值必须是 0（不是 null，也不是小正数）
  for (const grounded of ids.filter((id) => /anticipate|land/.test(id))) {
    assert.equal(gaps[grounded], 0, `${grounded} 应当贴地（airborneGapNative=0），实际 ${gaps[grounded]}`);
  }
  // 腾空帧：必须 > 0
  const airborne = ids.filter((id) => !/anticipate|land/.test(id));
  assert.ok(airborne.length > 0, '没有腾空帧样本');
  for (const id of airborne) {
    assert.ok(gaps[id] > 0, `${id} 应当是腾空帧（gap>0），实际 ${gaps[id]}`);
  }
  // 金丝雀：不是全 0（否则"apex 最大"恒成立）
  assert.ok(
    ids.some((id) => gaps[id] > 0),
    `jump 的 airborneGapNative 全是 0，G-14 会真空通过`,
  );
  // apex 在每个朝向上都严格最大（左右向帧是镜像，两个 apex 的 gap 相同 ⇒ 只能按 facing 比较）
  const byFacing = new Map<number, Array<[string, any]>>();
  for (const entry of Object.entries(jump.frames) as Array<[string, any]>) {
    const list = byFacing.get(entry[1].facing) ?? [];
    list.push(entry);
    byFacing.set(entry[1].facing, list);
  }
  assert.ok(byFacing.size >= 1, 'jump 没有帧');
  for (const [facing, entries] of byFacing) {
    const apexEntry = entries.find(([frameId]) => frameId.includes('apex'));
    assert.ok(apexEntry, `朝向 ${facing} 没有 apex 帧`);
    const apexGap = apexEntry[1].airborneGapNative;
    for (const [otherId, other] of entries) {
      if (otherId === apexEntry[0]) continue;
      assert.ok(
        apexGap > other.airborneGapNative,
        `朝向 ${facing}：apex(${apexGap}) 应当严格大于 ${otherId}(${other.airborneGapNative})`,
      );
    }
  }
  // 全局最大值必须落在 apex 上（防"某个非 apex 帧更高"）
  const globalMax = Math.max(...ids.map((id) => gaps[id]));
  assert.equal(
    globalMax,
    Math.max(...ids.filter((id) => id.includes('apex')).map((id) => gaps[id])),
    '全局最大腾空高度不在 apex 帧上',
  );
  // 切片 2 起 jump 已 accepted ⇒ 进运行清单，因此"与运行时的值逐值相等"这条现在**真的能比**
  // （旧断言只能以"清单里没有 jump"的形式成立，那是切片 1 的权宜说法）
  assert.equal(
    POSES_MANIFEST.deferred.some((item: any) => item.posture === 'jump'),
    false,
    'jump 已 accepted，不该再出现在 deferred 列表里（幽灵理由）',
  );
  const runtimeJump = (POSES_MANIFEST.batches as any).jump;
  assert.ok(runtimeJump, 'jump 已 accepted，必须在运行清单里');
  for (const [frameId, frame] of Object.entries(jump.frames) as Array<[string, any]>) {
    assert.equal(
      runtimeJump.frames[frameId].airborneGapNative,
      frame.airborneGapNative,
      `jump/${frameId} 的腾空高度与 adapter 草稿不一致（导出管线把值改坏了）`,
    );
  }
});

test('P-04 / P-05（切片 3）：lie 只产出 `enter`(4 帧，末帧 = neutral) + `exit`(3 帧)，**没有 hold**；7 个帧位只有 3 个 distinct contentId', () => {
  const all = adaptAll({ repoRoot: REPO_ROOT, accepted: [...BATCH_SPECS.map((spec: any) => spec.posture)] }).drafts;
  const lie = all.lie;
  assert.ok(lie, 'lie 草稿缺失');

  // ① 片段形态：enter + exit，没有 hold（方案 B 构建期合并，设计 §4.2(1)）
  const clipIds = lie.clips.map((clip: any) => clip.id).sort();
  assert.deepEqual(clipIds, ['enter', 'exit'], `lie 只该有 enter + exit，实际 ${clipIds.join(',')}`);
  assert.equal(
    lie.clips.some((clip: any) => clip.id === 'hold'),
    false,
    'lie 不许再产出 hold：候选序里 hold 在 enter 之前，enter 会被永久遮住（G-P11）',
  );
  const enter = lie.clips.find((clip: any) => clip.id === 'enter');
  assert.ok(enter, 'lie 必须有 enter 片段');
  assert.equal(enter.frames.length, 4, `enter 必须是 down(3) + neutral(1) = 4 帧，实际 ${enter.frames.length}`);
  assert.equal(enter.frames[3], 'lie_neutral', 'enter 的末帧必须是"趴着不动"那张（动画与静止是同一片段的结尾）');
  assert.deepEqual(enter.frameMs, [120, 120, 120, 120], 'enter 的 frameMs 必须全 120 且全 > 0');
  assert.equal(enter.loop, false);
  assert.equal(enter.onEnd, 'hold-last', 'enter 播完必须停在末帧（不是回到别的片段）');
  const exit = lie.clips.find((clip: any) => clip.id === 'exit');
  assert.ok(exit, 'lie 必须有 exit 片段');
  assert.equal(exit.frames.length, 3, `exit 必须是 up 的 3 帧，实际 ${exit.frames.length}`);
  assert.deepEqual(exit.frameMs, [120, 120, 120]);
  assert.equal(exit.onEnd, 'return-stand', 'exit 播完必须回站姿（pendingStand 的收尾靠它）');

  // ② 帧位与像素：7 个帧位、3 个不同源文件（aliases 必须真的生效）
  assert.equal(Object.keys(lie.frames).length, 7, 'lie 必须还是 7 个帧位（合并片段不许删帧）');
  const distinctSources = new Set(Object.values(lie.frames).map((frame: any) => frame.sourceFile));
  assert.equal(distinctSources.size, 3, `lie 的 7 个帧位只对应 3 张不同像素，实际 ${distinctSources.size}`);

  // ③ 运行清单侧的 contentId：7 个帧位落到 3 个 distinct contentId（P-04 的运行时口径）
  const runtimeLie = POSES_MANIFEST.batches.lie;
  assert.ok(runtimeLie, '运行清单里必须有 lie（切片 3 起 accepted）');
  assert.equal(Object.keys(runtimeLie.frames).length, 7);
  const contentIds = new Set(
    Object.values(runtimeLie.frames).map((frame: any) => frame.files['1x'].contentId as string),
  );
  assert.equal(contentIds.size, 3, `lie 的 distinctContentId 必须是 3（去重口径），实际 ${contentIds.size}`);
  const runtimeClipIds = (runtimeLie.clips as any[]).map((clip) => clip.id).sort();
  assert.deepEqual(runtimeClipIds, ['enter', 'exit'], '运行清单里 lie 也只能有 enter + exit');

  // ④ 守卫：帧引用不许悬空（enter 与 exit 加起来正好覆盖 7 个帧位，一个不多一个不少）
  const referenced = new Set<string>([
    ...(runtimeLie.clips as any[]).flatMap((clip) => clip.frames as string[]),
  ]);
  assert.deepEqual(
    [...referenced].sort(),
    Object.keys(runtimeLie.frames).sort(),
    'lie 的片段引用集合必须与帧集合完全相同（多 = 悬空引用，少 = 孤儿帧）',
  );
});

test('P-07（切片 3）：sleep 是单条 cycle、loop:true、5 帧 × 1800ms、没有 onEnd', () => {
  const runtimeSleep = POSES_MANIFEST.batches.sleep;
  assert.ok(runtimeSleep, '运行清单里必须有 sleep（切片 3 起 accepted）');
  const clips = runtimeSleep.clips as any[];
  assert.equal(clips.length, 1, `sleep 只该有一条片段，实际 ${clips.length}`);
  const clip = clips[0];
  assert.equal(clip.id, 'cycle', 'sleep 的片段 id 必须是 cycle（pickClip 第一轮就命中）');
  assert.equal(clip.loop, true, 'sleep 必须循环');
  assert.equal(clip.onEnd, undefined, '循环片段的 onEnd 必须缺省（写了也不会被调用，是假配置）');
  assert.equal(clip.frames.length, 5, `sleep 必须 5 帧，实际 ${clip.frames.length}`);
  assert.deepEqual(clip.frameMs, [1800, 1800, 1800, 1800, 1800], 'sleep 每帧 1800ms');
  assert.equal(
    clip.frameMs.reduce((sum: number, ms: number) => sum + ms, 0),
    9000,
    'sleep 一个循环必须正好 9 秒（5 × 1800）',
  );
  // 单朝向静态批：只有一条 facing:-1
  assert.equal(clip.facing, -1);
  assert.equal(new Set(clips.map((item) => item.facing)).size, 1, 'sleep 是单朝向批');
});

test('G-15：体积预算与 aliases 去重（lie 7 个帧位只有 3 张不同像素）', () => {
  const all = adaptAll({ repoRoot: REPO_ROOT, accepted: [...BATCH_SPECS.map((spec: any) => spec.posture)] }).drafts;
  const lie = all.lie;
  const frameEntries = Object.entries(lie.frames) as Array<[string, any]>;
  assert.equal(frameEntries.length, 7, `lie 应有 7 个帧位，实际 ${frameEntries.length}`);
  const distinctSources = new Set(frameEntries.map(([, frame]) => frame.sourceFile));
  assert.equal(distinctSources.size, 3, `aliases 失效：7 个帧位解析出 ${distinctSources.size} 个源文件（应为 3）`);
  assert.equal(lie.aliasesResolved.length, 4, `应解析 4 条 aliases，实际 ${lie.aliasesResolved.length}`);
  // 金丝雀：三张不同像素的 sha256 也必须互不相同（防"文件名不同但内容同一张"）
  const hashes = new Set(
    [...distinctSources].map((file) => sha256OfFile(resolve(POSE_SOURCE_ROOT, 'lie', String(file)))),
  );
  assert.equal(hashes.size, 3, '三张源文件的 sha256 出现重复，去重口径需要重新确认');

  // 体积：单帧 @2x ≤ 400 KiB，全量 ≤ 8 MiB（真实运行清单；上限真源见 scripts/pet-budget.mjs）
  for (const [posture, batch] of Object.entries(POSES_MANIFEST.batches) as Array<[string, any]>) {
    for (const [frameId, frame] of Object.entries(batch.frames) as Array<[string, any]>) {
      assert.ok(
        frame.files['2x'].bytes <= FRAME_2X_MAX_BYTES,
        `${posture}/${frameId}@2x ${frame.files['2x'].bytes} 字节超过单帧上限 ${FRAME_2X_MAX_BYTES}`,
      );
    }
  }
  const total = POSES_MANIFEST.totals.bytes1x + POSES_MANIFEST.totals.bytes2x;
  assert.ok(total > 0, '全量体积为 0：totals 没被算出来');
  assert.ok(total <= POSE_TOTAL_MAX_BYTES, `全量 ${total} 字节超过预算 ${POSE_TOTAL_MAX_BYTES}`);
});

test('G-09 域隔离：批级锚点必须落在本批墨迹的横跨范围内（把母版值当 native 塞进来必红）', () => {
  const result = adaptEverything();
  for (const [posture, batch] of Object.entries(result.drafts) as Array<[string, any]>) {
    for (const facing of ['-1', '1']) {
      const frames = Object.values(batch.frames as Record<string, any>).filter(
        (frame) => String(frame.facing) === facing,
      );
      if (frames.length === 0) continue;
      const anchor = batch.bodyAnchor.byFacing[facing];
      const left = Math.min(...frames.map((frame) => frame.inkNative.left));
      const right = Math.max(...frames.map((frame) => frame.inkNative.right));
      // ① 躯体质心不可能在身体外面：母版值（×2）会立刻落到躯干范围之外
      assert.ok(
        anchor.x >= left && anchor.x <= right,
        `${posture}/${facing} 的 bodyAnchor.x=${anchor.x} 落在墨迹横跨范围 [${left}, ${right}] 之外：` +
          '大概率是把母版域的 anchor.x 当成了 native 值（域混用）',
      );
      // ② 锚点必须落在 native 画布内（与 manifest.ts 的运行时断言同一条判据）
      assert.ok(
        anchor.x >= 0 && anchor.x <= batch.nativeCanvas.width && anchor.y >= 0 && anchor.y <= batch.nativeCanvas.height,
        `${posture}/${facing} 的锚点 (${anchor.x}, ${anchor.y}) 越出 native 画布 ${batch.nativeCanvas.width}×${batch.nativeCanvas.height}`,
      );
    }
  }
});

test('B-5：源目录出现未登记批次目录 ⇒ adaptAll 必须报问题（不许静默忽略）', () => {
  // 真实仓库里 6 批全部登记过 ⇒ 不许误报（金丝雀）
  assert.deepEqual(adaptAll({ repoRoot: REPO_ROOT }).problems, [], '真实源目录不该有未登记批次');

  const tmpRoot = mkdtempSync(resolve(tmpdir(), 'lx-pet-poses-unregistered-'));
  const posesDir = resolve(tmpRoot, 'docs', 'assets', 'desktop-pet', 'poses');
  try {
    // ① 有 manifest.json 但没在 BATCH_SPECS 登记（美术新交一批、工程忘了登记）
    const stretchDir = resolve(posesDir, 'stretch');
    mkdirSync(stretchDir, { recursive: true });
    writeFileSync(resolve(stretchDir, 'manifest.json'), JSON.stringify({ posture: 'stretch' }, null, 2), 'utf8');
    // ② 连 manifest.json 都没有的野目录（误建的 / 半途废弃的）
    mkdirSync(resolve(posesDir, 'tmp-wip'), { recursive: true });

    const result = adaptAll({ repoRoot: tmpRoot });
    assert.ok(result.problems.length >= 2, `未登记批次必须报问题，实际：${JSON.stringify(result.problems)}`);
    assert.ok(
      result.problems.some((line: string) => line.includes('stretch')),
      `报错必须点名 stretch：\n${result.problems.join('\n')}`,
    );
    assert.ok(
      result.problems.some((line: string) => line.includes('tmp-wip')),
      `报错必须点名 tmp-wip：\n${result.problems.join('\n')}`,
    );
    assert.ok(
      result.problems.some((line: string) => line.includes('BATCH_SPECS')),
      '报错必须告诉人该改哪里（BATCH_SPECS）',
    );
    // 未登记目录**不能**被当成"已交付批次"塞进 drafts（否则会出现没有 adapter 的批次）
    assert.equal(result.drafts.stretch, undefined);
    // 已登记但缺 manifest 的批次仍走 missing（两条判据互不干扰）
    assert.deepEqual(result.missing.sort(), BATCH_SPECS.map((spec: any) => spec.posture).sort());
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('结构漂移必须硬失败：未知 manifest 形态与登记不符都不许"能跑就行"', () => {
  // ① 三种已知形态都不是 ⇒ 拒绝猜
  assert.throws(
    () => detectAdapter({ notes: '这是一个新格式' }, 'sit'),
    (err: unknown) => err instanceof PoseAdapterError && /拒绝猜/.test((err as Error).message),
    '未知结构被猜过去了',
  );
  // ② 结构识别结果与 BATCH_SPECS 登记不符 ⇒ 硬失败（把 sit 的 manifest 当成 frames 形态）
  const sitManifest = readSourceManifest('sit');
  const asFrames = { ...sitManifest, frames: [{ id: 'x', file: 'a.png', facing: -1 }] };
  assert.throws(
    () => adaptBatch(asFrames, { posture: 'sit', adapter: 'legacy-v1' }),
    (err: unknown) => err instanceof PoseAdapterError && /结构漂移/.test((err as Error).message),
    '结构漂移被放过了：adapter 会静默读错字段',
  );
  // ③ manifest.batch 与目录名不一致 ⇒ 硬失败（复制粘贴造成的最常见事故）
  const wrongBatch = { ...sitManifest, batch: 'lie' };
  assert.throws(() => adaptBatch(wrongBatch, { posture: 'sit', adapter: 'legacy-v1' }), PoseAdapterError);
  // ④ 合法结构不触发以上任何一条（否则守卫变成"永远红"）
  assert.doesNotThrow(() => adaptBatch(sitManifest, { posture: 'sit', adapter: 'legacy-v1' }));
});
