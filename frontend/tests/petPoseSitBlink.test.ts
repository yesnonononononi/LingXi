/**
 * 坐姿眨眼（`sit_blink`）从美术补充包落进运行时的守卫（tsx 执行，纯 node）。
 *
 * <p><b>为什么单独立一个文件：</b>这一片把 `sit` 从"一张静止画"改成"坐着眨眼（7 帧 / 6.61 s 循环）"，
 * 它同时踩到三处had曾经各自独立的真源——①美术 `supplemental/gif-v1/manifest.json` 的
 * `clips.sit_blink`（帧序 + 逐帧时长）；②构建门禁 `check-pet-poses.mjs` 的 `FRAME_MS_RANGE`；
 * ③运行时播放器 `player.ts` 的 `FRAME_MS_MAX`。三者不同步的表现是**功能静默消失**
 * （门禁全绿、运行时抛 `RangeError`、坐姿永远回站姿），而没有任何判据会红。所以本文件钉住：</p>
 * <ol>
 *   <li>`sit_blink` 的片段结构（帧数 / 帧时长 / 总时长 / loop / 朝向 / distinct 内容数）；</li>
 *   <li>补充时序真源**缺字段即硬失败**（不许回落到默认值）；</li>
 *   <li>运行时与门禁的**窄豁免**都放行真数据、都拒绝同样四种越界；</li>
 *   <li>运行时与门禁的豁免**逐值对账**（`checkPlayerExemptionDrift`）；</li>
 *   <li>默认播放行为：`setPosture('sit')` 之后真的在播 `cycle`，且 `data-posture` 是 `sit`。</li>
 * </ol>
 *
 * @module tests/petPoseSitBlink
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SUPPLEMENTAL_FRAMES, adaptAll } from '../scripts/pet-pose-adapters.mjs';
import {
  FRAME_MS_EXEMPTION,
  FRAME_MS_RANGE,
  checkPlayerExemptionDrift,
  checkTimingReport,
} from '../scripts/check-pet-poses.mjs';
import { FRAME_MS_MAX } from '../src/pet/poses/player';
import { PoseController } from '../src/pet/poses/controller';
import { PET_POSES } from '../src/pet/poses/manifest';
import { FRONTEND_ROOT } from '../scripts/build-pet-geometry.mjs';

/** 仓库根（`frontend/` 的上一级）。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** 美术补充包根（相对仓库根）。 */
const SUPPLEMENTAL_REL = 'docs/assets/desktop-pet/supplemental/gif-v1';

/** gif-v1 manifest 的原始对象（只读，测试用来交叉核对时序）。 */
const GIF_MANIFEST = JSON.parse(
  readFileSync(resolve(REPO_ROOT, SUPPLEMENTAL_REL, 'manifest.json'), 'utf8'),
) as Record<string, any>;

/** `clips.sit_blink` 的声明（帧序 + 逐帧时长）。 */
const GIF_CLIP = GIF_MANIFEST.clips.sit_blink as { frames: string[]; frameMs: number[]; loop: boolean };

/** 期望的总时长（7 帧合计 6.61 s，与任务书的"真实 6.61 秒"一致）。 */
const GIF_CLIP_TOTAL_MS = 6610;

/**
 * 造一份"只有 sit + 补充包"的临时仓库（其余 5 批缺席是合法中间态）。
 *
 * @returns 临时仓库根（调用方负责删除）
 */
function makeTempRepo(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'lx-pet-sitblink-'));
  const sitDir = resolve(root, 'docs', 'assets', 'desktop-pet', 'poses', 'sit');
  mkdirSync(sitDir, { recursive: true });
  const sourceManifest = resolve(REPO_ROOT, 'docs', 'assets', 'desktop-pet', 'poses', 'sit', 'manifest.json');
  copyFileSync(sourceManifest, resolve(sitDir, 'manifest.json'));
  const sitManifest = JSON.parse(readFileSync(sourceManifest, 'utf8')) as { files: Array<{ file: string }> };
  for (const entry of sitManifest.files) {
    copyFileSync(
      resolve(REPO_ROOT, 'docs', 'assets', 'desktop-pet', 'poses', 'sit', entry.file),
      resolve(sitDir, entry.file),
    );
  }
  cpSync(resolve(REPO_ROOT, SUPPLEMENTAL_REL), resolve(root, SUPPLEMENTAL_REL), { recursive: true });
  return root;
}

/**
 * 改动临时仓库里的补充 manifest 后跑一次全量归一，返回问题列表。
 *
 * @param mutate 改动函数（收到可变 manifest）
 * @returns 归一问题列表
 */
function problemsAfterMutatingSupplemental(mutate: (manifest: Record<string, any>) => void): string[] {
  const root = makeTempRepo();
  try {
    const path = resolve(root, SUPPLEMENTAL_REL, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    mutate(manifest);
    writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
    return adaptAll({ repoRoot: root }).problems;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('S1 sit_blink 片段结构：7 帧 / 6610ms / loop / 左向 / 2 个 distinct 内容，且与美术 manifest 逐值相等', () => {
  const result = adaptAll({ repoRoot: REPO_ROOT });
  assert.deepEqual(result.problems, [], `adapter 不该有问题：${result.problems.join('; ')}`);
  const sit = result.drafts.sit as Record<string, any>;
  assert.equal(sit.clips.length, 1, 'sit 只许有一条片段：`hold` 被 `cycle` 替换，绝不并存（G-P11 死片段）');
  const cycle = sit.clips[0];
  assert.equal(cycle.id, 'cycle', '片段 id 必须在 pickClip 候选序里（hold → cycle → once → enter）');
  assert.equal(cycle.facing, -1, '坐姿是单朝向静态批：只有左向画稿');
  assert.equal(cycle.loop, true, '眨眼是循环片段');
  assert.equal(cycle.onEnd, undefined, '循环片段不许声明 onEnd（否则"循环 + 收尾"语义打架）');
  assert.deepEqual(cycle.frames, GIF_CLIP.frames, '帧序必须逐值等于美术 clips.sit_blink.frames');
  assert.deepEqual(cycle.frameMs, GIF_CLIP.frameMs, '逐帧时长必须逐值等于美术 clips.sit_blink.frameMs');
  assert.equal(cycle.frames.length, 7, '7 个帧位');
  const total = (cycle.frameMs as number[]).reduce((sum, ms) => sum + ms, 0);
  assert.equal(total, GIF_CLIP_TOTAL_MS, `总时长必须是 ${GIF_CLIP_TOTAL_MS}ms（对应 gif 的 6.61 秒），实际 ${total}`);

  // distinct 内容数（草稿期按母版 sourceFile 判；转码后由 contentId 表达，G-P14 用后者）
  const sources = new Set((cycle.frames as string[]).map((frameId) => sit.frames[frameId].sourceFile));
  assert.equal(sources.size, 2, '眨眼只有两张画（sit_neutral / sit_blink），7 个帧位是它们交替引用');

  // 继承关系：眨眼帧的墨迹 / 锚点 / 支撑脚与中性帧逐值相同（声明区域严格落在中性帧墨迹内）
  assert.deepEqual(sit.frames.sit_blink.inkNative, sit.frames.sit_neutral.inkNative, '墨迹必须继承中性帧');
  assert.deepEqual(sit.frames.sit_blink.anchorNative, sit.frames.sit_neutral.anchorNative, '锚点必须继承中性帧');
  assert.equal(sit.frames.sit_blink.supportFootX, sit.frames.sit_neutral.supportFootX, '支撑脚必须继承中性帧');
  assert.equal(sit.frames.sit_blink.facing, -1);

  // **已落盘清单**与美术声明的总时长必须一致（手改 pet-poses.json 的任一帧时长 ⇒ 这里立刻红；
  // 只靠"adapter 与 manifest 逐字段漂移"会在别人只看单测时看不见，所以这里再独立断一次总和）
  const committed = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8')) as Record<string, any>;
  const committedClip = committed.batches.sit.clips[0];
  const committedTotal = (committedClip.frameMs as number[]).reduce((sum, ms) => sum + ms, 0);
  const declaredTotal = GIF_CLIP.frameMs.reduce((sum, ms) => sum + ms, 0);
  assert.equal(
    committedTotal,
    declaredTotal,
    `已落盘 sit 片段总时长 ${committedTotal}ms 必须等于美术 clips.sit_blink 声明的 ${declaredTotal}ms` +
      `（6.61 秒；不符就是有一侧被手改了）`,
  );
});

test('S2 补充时序真源是硬前置：缺 clips.sit_blink / frames 与 frameMs 不等长 / loop 不为真 ⇒ 构建直接报错', () => {
  // 登记表本身必须指向 gif manifest 的那条片段（改登记 = 改真源定位）
  assert.equal((SUPPLEMENTAL_FRAMES as Record<string, any>).sit.clipKey, 'sit_blink');
  assert.equal((SUPPLEMENTAL_FRAMES as Record<string, any>).sit.manifestPath, `${SUPPLEMENTAL_REL}/manifest.json`);
  // ① 缺整条片段
  const missingClip = problemsAfterMutatingSupplemental((manifest) => {
    delete manifest.clips.sit_blink;
  });
  assert.ok(
    missingClip.some((line) => line.includes('clips.sit_blink')),
    `缺 clips.sit_blink 必须硬失败（不许静默回落到"静止不眨眼"）：${missingClip.join('; ')}`,
  );
  // ② frames 与 frameMs 不等长（少一个时长 = 给某一帧编了个数）
  const uneven = problemsAfterMutatingSupplemental((manifest) => {
    manifest.clips.sit_blink.frameMs.pop();
  });
  assert.ok(
    uneven.some((line) => line.includes('不等长')),
    `frames/frameMs 不等长必须硬失败：${uneven.join('; ')}`,
  );
  // ③ loop 不为 true（非循环会播完就停，用户看到坐着不动）
  const notLoop = problemsAfterMutatingSupplemental((manifest) => {
    manifest.clips.sit_blink.loop = false;
  });
  assert.ok(
    notLoop.some((line) => line.includes('loop')),
    `loop 不为真必须硬失败：${notLoop.join('; ')}`,
  );
  // ④ 帧时长出现 0（循环里填 0 = 永不推进）
  const zeroMs = problemsAfterMutatingSupplemental((manifest) => {
    manifest.clips.sit_blink.frameMs[1] = 0;
  });
  assert.ok(
    zeroMs.some((line) => line.includes('不是正数')),
    `帧时长 0 必须硬失败：${zeroMs.join('; ')}`,
  );
});

test('S3 门禁的窄豁免：真数据放行并点名，四种越界各自红（豁免不许宽过 rs 的 2400 上限）', () => {
  assert.equal(FRAME_MS_EXEMPTION.maxOverMs, 6000);
  assert.equal(FRAME_MS_EXEMPTION.maxClipTotalMs, 9000);
  assert.equal(FRAME_MS_EXEMPTION.frameIndex, 0);
  assert.equal(FRAME_MS_EXEMPTION.minDistinctContentIds, 2);
  assert.equal(FRAME_MS_RANGE.max, 2400, '"2400 上限"本身一个字都不许改');

  const realSit = (PET_POSES.batches.sit as unknown) as Record<string, any>;
  const real = runTimingReport(realSit);
  assert.deepEqual(real.problems, [], `真数据必须放行：${real.problems.join('; ')}`);
  assert.equal(real.notes.length, 1, '放行必须**点名**（静默放行会让 2400 上限变成空话）');
  assert.match(real.notes[0], /FRAME_MS_EXEMPTION 放行/);
  assert.match(real.notes[0], /2600ms/);

  // ① 第 1 帧超限 ⇒ 红（豁免只认第 0 帧）。第 0 帧同时压回合法值，
  //    否则会先撞上"至多 1 帧超限"那条，测不到本分支。
  const secondFrame = mutateSit((clip) => {
    clip.frameMs = [...clip.frameMs];
    clip.frameMs[0] = 1800;
    clip.frameMs[1] = 2600;
  });
  const second = runTimingReport(secondFrame);
  assert.equal(second.problems.length, 1, `第 1 帧超限必须红：${JSON.stringify(second.problems)}`);
  assert.match(second.problems[0], /豁免只认第 0 帧/);

  // ② 单帧片段给 2600ms ⇒ 红（静态该用 hold-last 表达）
  const singleFrame = mutateSit((clip) => {
    clip.frames = ['sit_neutral'];
    clip.frameMs = [2600];
  });
  const single = runTimingReport(singleFrame);
  assert.ok(single.problems.length > 0, '单帧片段超限必须红');
  assert.match(single.problems.join(' | '), /单帧片段禁止使用豁免/);

  // ③ 同一片段两帧超限 ⇒ 红（至多 1 帧）
  const twoOver = mutateSit((clip) => {
    clip.frameMs = [...clip.frameMs];
    clip.frameMs[0] = 2600;
    clip.frameMs[2] = 2500;
  });
  const many = runTimingReport(twoOver);
  assert.equal(many.problems.length, 1, `两帧超限必须红且只报一条：${JSON.stringify(many.problems)}`);
  assert.match(many.problems[0], /至多 1 帧/);

  // ④ 第 0 帧 2600ms 但只有 1 个 distinct contentId ⇒ 红（G-P14 不许被豁免吃掉）
  const sameImage = mutateSit((clip, batch) => {
    // 把 7 个帧位全部指向同一张画（内容寻址后 contentId 一致），帧时长保持真值
    for (const frameId of Object.keys(batch.frames)) {
      const contentId = '0123456789abcdef';
      for (const density of ['1x', '2x']) {
        batch.frames[frameId].files[density] = { ...batch.frames[frameId].files[density], contentId };
      }
    }
  });
  const flat = runTimingReport(sameImage);
  assert.ok(flat.problems.length > 0, '只有 1 个 distinct contentId 必须红');
  assert.match(flat.problems.join(' | '), /distinct contentId/);
});

test('S4 运行时与门禁的豁免逐值对账：数值一致 + 四个字段真的被引用 + 代理关系写在源码里', () => {
  assert.deepEqual(checkPlayerExemptionDrift(), [], '真仓库的运行时豁免必须与门禁逐条同构');
  assert.equal(FRAME_MS_MAX, FRAME_MS_RANGE.max, '运行时上界必须与门禁上界同值（历史事故：两份真源）');

  const realPlayer = resolve(FRONTEND_ROOT, 'src', 'pet', 'poses', 'player.ts');
  const original = readFileSync(realPlayer, 'utf8');

  // ① 只改运行时一侧的 maxOverMs（6000 → 8000），门禁不动 ⇒ 对账必须红
  const drifted = resolve(tmpdir(), `kou-player-drift-${Date.now()}.ts`);
  writeFileSync(drifted, original.replace('maxOverMs: 6000', 'maxOverMs: 8000'), 'utf8');
  try {
    const problems = checkPlayerExemptionDrift({ playerPath: drifted });
    assert.equal(problems.length, 1, `maxOverMs 漂移必须红一条：${JSON.stringify(problems)}`);
    assert.match(problems[0], /maxOverMs/);
    assert.match(problems[0], /两份真源/);
  } finally {
    rmSync(drifted, { force: true });
  }

  // ② 把"以 distinct frame id 代理 contentId"那句说明删掉 ⇒ 必须红（口径不许只留在口头）
  const noProxy = resolve(tmpdir(), `kou-player-proxy-${Date.now()}.ts`);
  writeFileSync(noProxy, original.replace(/distinct frame id/g, '某些帧'), 'utf8');
  try {
    const problems = checkPlayerExemptionDrift({ playerPath: noProxy });
    assert.ok(problems.length > 0, '代理关系说明被删必须红');
    assert.match(problems.join(' | '), /G-P14/);
  } finally {
    rmSync(noProxy, { force: true });
  }
});

test('S5 默认播放：setPosture(sit) 之后真的在播 cycle（不抛、不回 stand，data-posture 是 sit）', () => {
  const clock = new FakeClock();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const frames: string[] = [];
  const controller = new PoseController({
    doc: new FakeDocument(),
    root,
    host,
    poses: PET_POSES,
    density: '2x',
    ports: {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      onFrame: (frameId: string) => {
        frames.push(frameId);
      },
      onClipEnd: () => {},
    },
    boxOf: null,
    blink: new FakeBlink(),
    facing: -1,
  });

  // 不抛错就是"接上了"：旧实现会在这里抛 RangeError → 被 catch → leavePose('播放失败') → stand
  assert.doesNotThrow(() => controller.setPosture('sit'), '播放 2600ms 首帧的片段不许抛 RangeError');
  assert.equal(controller.posture, 'sit', '坐姿必须真的切过去（旧实现在这里回 stand）');
  assert.equal(root.getAttribute('data-posture'), 'sit', 'data-posture 必须同步（CSS 全靠它切可见层）');
  assert.equal(controller.clipId, 'cycle', '坐姿默认播的就是眨眼循环');
  assert.equal(controller.isPlaying, true);
  assert.deepEqual(frames, ['sit_neutral'], '第一帧是中性坐姿（先坐定 2.6 秒）');

  // 走完 2600ms 的入静等待 ⇒ 进入眨眼帧（证明长等待是"会推进的长等待"，不是卡死）
  clock.advance(2600);
  assert.deepEqual(frames, ['sit_neutral', 'sit_blink'], `入静 2.6s 之后必须开始眨眼，实际 ${JSON.stringify(frames)}`);
  clock.advance(GIF_CLIP_TOTAL_MS);
  assert.ok(frames.length > 3, '循环必须继续推进（rAF 不许空转）');
});

/** 取 sit 批次的一份深拷贝并改动其中的 `cycle` 片段。 */
function mutateSit(mutate: (clip: Record<string, any>, batch: Record<string, any>) => void): Record<string, any> {
  const batch = JSON.parse(JSON.stringify(PET_POSES.batches.sit)) as Record<string, any>;
  const clip = batch.clips[0];
  mutate(clip, batch);
  return batch;
}

/** 调门禁的时序判据并保证返回两份结果。 */
function runTimingReport(batch: Record<string, any>): { problems: string[]; notes: string[] } {
  if (typeof checkTimingReport !== 'function') {
    assert.fail('check-pet-poses.mjs 必须导出 checkTimingReport（豁免放行要点名）');
  }
  return checkTimingReport(batch) as { problems: string[]; notes: string[] };
}

/** 极简假时钟（只入队，测试用 advance 精确推进）。 */
class FakeClock {
  /** 当前时刻。 */
  private time = 0;

  /** 排程。 */
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  /** 下一个句柄。 */
  private nextHandle = 1;

  /** 当前时刻。 */
  now = (): number => this.time;

  /** 排一次回调。 */
  schedule = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.time + Math.max(0, delayMs), callback });
    return handle;
  };

  /** 取消一次回调。 */
  cancel = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** 推进时钟并跑到期回调。 */
  advance = (ms: number): void => {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  };
}

/** 极简假元素（控制器只用到这几个成员）。 */
class FakeElement {
  /** 标签名。 */
  readonly tagName: string;

  /** `data-*` 面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** CSS 自定义属性面。 */
  readonly styleProps = new Map<string, string>();

  /** 属性面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** 内联样式（只实现 setProperty）。 */
  readonly style: { setProperty: (name: string, value: string) => void } = {
    setProperty: (name: string, value: string): void => {
      this.styleProps.set(name, value);
    },
  };

  /** 图片地址。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本内容。 */
  textContent: string | null = null;

  /** 类名。 */
  className = '';

  /**
   * 构造。
   *
   * @param tagName 标签名
   */
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /**
   * 追加子节点。
   *
   * @param child 子节点
   * @returns 追加的节点
   */
  appendChild(child: unknown): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  /**
   * 写属性。
   *
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice('data-'.length)] = value;
  }

  /**
   * 读属性。
   *
   * @param name 属性名
   * @returns 属性值（没有则 null）
   */
  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  /**
   * 删属性。
   *
   * @param name 属性名
   */
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

/** 极简假文档。 */
class FakeDocument {
  /**
   * 创建元素。
   *
   * @param tagName 标签名
   * @returns 假元素
   */
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

/** 极简假眨眼驱动（姿态态会被停掉，这里只记录状态）。 */
class FakeBlink {
  /** 是否在跑。 */
  private running = true;

  /** 是否在跑。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 停。 */
  stop(): void {
    this.running = false;
  }

  /** 启。 */
  start(): void {
    this.running = true;
  }
}
