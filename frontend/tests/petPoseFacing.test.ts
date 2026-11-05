/**
 * 多朝向姿态单测（M2 切片 2 · T02 + T04）。
 *
 * <p><b>本文件守三件"零症状"的事：</b></p>
 * <ol>
 *   <li><b>`isPlayable` 的 facing 缺口</b>：`walk`/`run`/`jump` 的 `clips` 是「同 id 左右各一条」，
 *       旧实现只判"存在某一条可播片段"，于是"右向没有片段"这种坏法**永远不会被发现**——
 *       直到用户在真机上看到角色朝反方向走。给了 `facing` 之后判据变成"这个朝向能不能播"；</li>
 *   <li><b>镜像推导锚点</b>：`normalizeBodyAnchor` 缺朝向时会补 `nativeCanvas.width − x` 的镜像锚，
 *       于是"缺锚即不可播"在实现上是一道空门。批级 `byFacingSource` 无法区分哪一侧是推导的，
 *       所以口径是**整批拒绝**（降级 stand）：镜像同时镜像锚点 ⇒ 落点对、内容错；</li>
 *   <li><b>朝向切换不许回落</b>：`setFacing` 换到没有片段的朝向时必须降级站姿，
 *       绝不能拿另一侧的片段顶上去（角色会突然翻转），也绝不能因为"朝向没变"就重启播放
 *       （相位跳回第 0 帧 = 走路一顿一顿）。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（tsx --test）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_POSES, isPlayable } from '../src/pet/poses/manifest';
import { PoseController, type PoseBlinkLike } from '../src/pet/poses/controller';
import {
  buildPoseHandle,
  clipTimingOf,
  declaresReturnStand,
  judgePoseStep,
  runPoseMatrix,
  sampleDelayOf,
  POSE_MATRIX_POSTURES,
} from '../src/pet/debug/dev-backdoor';
import type { PoseClipTiming, PoseDebugSnapshot } from '../src/pet/debug/types';
import type { PoseMatrixPorts } from '../src/pet/debug/dev-backdoor';
import type { BodyAnchor, Facing, PetPoses, PostureId } from '../src/pet/poses/types';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';

/**
 * 可控时钟 + 定时器队列（播放推进只认注入的 `now` / `schedule` / `cancel`）。
 */
class FakeClock {
  /** 虚拟时间（毫秒）。 */
  time = 0;

  /** 待触发的定时器。 */
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];

  /** 句柄自增。 */
  private seq = 0;

  /** 读时间。 */
  now = (): number => this.time;

  /**
   * 安排一次回调。
   *
   * @param callback 回调
   * @param delayMs 延迟
   * @returns 句柄
   */
  schedule = (callback: () => void, delayMs: number): number => {
    this.seq += 1;
    this.timers.push({ id: this.seq, at: this.time + Math.max(0, delayMs), callback });
    return this.seq;
  };

  /**
   * 取消回调（幂等）。
   *
   * @param handle 句柄
   */
  cancel = (handle: number): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  /**
   * 推进时间并触发到期的回调（按时间升序，逐个触发）。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

/** 假眨眼驱动（切姿态要停、回站姿要启）。 */
class FakeBlink implements PoseBlinkLike {
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

/** 极简假元素（控制器只用到这几个成员）。 */
class FakeElement implements ElementLike {
  /** 标签名。 */
  readonly tagName: string;

  /** `data-*` 面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** 属性面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面。 */
  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.properties.set(name, value);
    },
  };

  /** 已写入的 CSS 属性。 */
  readonly properties = new Map<string, string>();

  /** 图片地址。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本。 */
  textContent: string | null = null;

  /**
   * @param tagName 标签名
   */
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /**
   * @param child 子节点
   * @returns 入参
   */
  appendChild(child: ElementLike): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  /**
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /**
   * @param name 属性名
   * @returns 属性值
   */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

/** 假文档（只造 `div` / `img`）。 */
class FakeDocument implements DocumentLike {
  /**
   * @param tagName 标签名
   * @returns 假元素
   */
  createElement(tagName: string): ElementLike {
    assert.ok(tagName === 'div' || tagName === 'img', `控制器不该创建 <${tagName}>`);
    return new FakeElement(tagName);
  }
}

/**
 * 造一个控制器（帧回调记进 `frames`，便于断言"从第 0 帧重播"）。
 *
 * @param options 选项
 * @param options.facing 构造期朝向（缺省 `-1`，与生产一致）
 * @param options.poses 清单（缺省真清单）
 * @returns 控制器与观测面
 */
function makeController(options: { facing?: Facing; poses?: PetPoses } = {}): {
  controller: PoseController;
  clock: FakeClock;
  frames: string[];
  root: FakeElement;
} {
  const clock = new FakeClock();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const frames: string[] = [];
  const controller = new PoseController({
    doc: new FakeDocument(),
    root,
    host,
    poses: options.poses ?? PET_POSES,
    density: '2x',
    ports: {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      onFrame: (frameId) => {
        frames.push(frameId);
      },
      onClipEnd: () => {},
    },
    boxOf: null,
    blink: new FakeBlink(),
    facing: options.facing ?? -1,
  });
  return { controller, clock, frames, root };
}

/**
 * 深拷贝真清单并按需改动（合成清单只在内存里存在）。
 *
 * @param mutate 改动函数
 * @returns 合成清单
 */
function posesWith(mutate: (draft: PetPoses) => PetPoses): PetPoses {
  const draft = JSON.parse(JSON.stringify(PET_POSES)) as PetPoses;
  return mutate(draft);
}

test('F01 isPlayable 缺省语义与旧实现逐字节相同（4 个既有调用点的前提）', () => {
  // stand 永远可播（它是回落目标）
  assert.equal(isPlayable(PET_POSES, 'stand'), true);
  // sit 已 accepted 且帧齐全 ⇒ 可播；lie/sleep 属切片 3 ⇒ 不可播
  assert.equal(isPlayable(PET_POSES, 'sit'), true);
  assert.equal(isPlayable(PET_POSES, 'lie'), false);
  assert.equal(isPlayable(PET_POSES, 'sleep'), false);
  // 切片 2 起三批都进了 accepted ⇒ 缺省判据（"存在某一条可播片段"）为真
  for (const posture of POSE_MATRIX_POSTURES) {
    assert.equal(isPlayable(PET_POSES, posture), true, `${posture} 已 accepted，缺省判据必须为真`);
  }
  // 不给 facing 时**不按朝向过滤**：把 walk 的右向片段摘掉，缺省判据仍为真
  const leftOnly = posesWith((draft) => {
    const walk = draft.batches.walk;
    assert.ok(walk, '真清单里必须有 walk');
    return {
      ...draft,
      batches: { ...draft.batches, walk: { ...walk, clips: walk.clips.filter((clip) => clip.facing !== 1) } },
    };
  });
  assert.equal(isPlayable(leftOnly, 'walk'), true, '缺省语义只看"有没有可播片段"，不看朝向');
});

test('F02 isPlayable 给了 facing 就只统计该朝向的片段（T02 的核心判据）', () => {
  // sit 只有 facing:-1 一条 hold ⇒ 右向不可播
  assert.equal(isPlayable(PET_POSES, 'sit', -1), true);
  assert.equal(isPlayable(PET_POSES, 'sit', 1), false, 'sit 没有右向片段 ⇒ 右向必须判不可播');

  // walk/run/jump 左右各一条 ⇒ 两个朝向都可播（真数据，不是合成）
  for (const posture of POSE_MATRIX_POSTURES) {
    assert.equal(isPlayable(PET_POSES, posture, -1), true, `${posture} 左向应可播`);
    assert.equal(isPlayable(PET_POSES, posture, 1), true, `${posture} 右向应可播`);
  }

  // 合成：摘掉右向片段 ⇒ 右向不可播，左向不受影响（证明过滤真的按 clip.facing 走）
  const leftOnly = posesWith((draft) => {
    const run = draft.batches.run;
    assert.ok(run, '真清单里必须有 run');
    return {
      ...draft,
      batches: { ...draft.batches, run: { ...run, clips: run.clips.filter((clip) => clip.facing !== 1) } },
    };
  });
  assert.equal(isPlayable(leftOnly, 'run', 1), false, '右向缺 clip ⇒ 该朝向必须不可播');
  assert.equal(isPlayable(leftOnly, 'run', -1), true, '左向不受影响');
});

test('F03 对齐收口：run/jump 的锚点是实测双侧，walk/sit 是批级单值（没有 mirror-derived）', () => {
  const source = (posture: keyof typeof PET_POSES.batches): string => {
    const batch = PET_POSES.batches[posture];
    assert.ok(batch, `真清单里必须有 ${posture}`);
    return batch.bodyAnchor.byFacingSource;
  };
  assert.equal(source('run'), 'measured-per-facing', 'run 的左右锚点都必须是实测（836 / 700）');
  assert.equal(source('jump'), 'measured-per-facing', 'jump 的左右锚点都必须是实测');
  assert.equal(source('walk'), 'batch-single', 'walk 无 byFacing ⇒ 批级单值（正面走动不区分朝向）');
  assert.equal(source('sit'), 'batch-single', 'sit 是单帧静止批 ⇒ 批级单值');
  for (const posture of POSE_MATRIX_POSTURES) {
    assert.notEqual(source(posture), 'mirror-derived', `${posture} 不许使用画布镜像推导锚点`);
  }
});

test('F04 mirror-derived 的批次整批判不可播（批级信息不够区分哪一侧，安全方向是不播）', () => {
  const mirrored = posesWith((draft) => {
    const sit = draft.batches.sit;
    assert.ok(sit, '真清单里必须有 sit');
    const bodyAnchor: BodyAnchor = { ...sit.bodyAnchor, byFacingSource: 'mirror-derived' };
    return { ...draft, batches: { ...draft.batches, sit: { ...sit, bodyAnchor } } };
  });
  // 帧与文件都在、accepted 也在——唯一的变化是锚点来源
  assert.equal(isPlayable(mirrored, 'sit'), false, 'mirror-derived 必须整批判不可播（降级 stand）');
  assert.equal(isPlayable(mirrored, 'sit', -1), false, '带 facing 时同样不可播');
  // 反向：改回实测来源就恢复可播（证明上面的红不是"改坏了别的东西"）
  assert.equal(isPlayable(PET_POSES, 'sit'), true);
});

test('F05 isPlayable 的 facing 非法值抛 TypeError（与 clipOf 同口径）', () => {
  for (const bad of [0, 2, -2, Number.NaN]) {
    assert.throws(
      () => isPlayable(PET_POSES, 'sit', bad as unknown as Facing),
      (error: unknown) => error instanceof TypeError,
      `facing=${String(bad)} 必须抛 TypeError`,
    );
  }
  // 缺省（undefined）不抛：这是"语义不变"的前提
  assert.doesNotThrow(() => isPlayable(PET_POSES, 'sit', undefined));
});

test('F06 setFacing：朝向未变必须是 no-op（不重启播放）', () => {
  const { controller, clock, frames } = makeController({ facing: -1 });
  controller.setPosture('walk');
  assert.deepEqual(frames, ['l1'], '进姿态先上屏第 0 帧');
  clock.advance(110);
  assert.deepEqual(frames, ['l1', 'l2'], '走一拍到第 2 帧');
  const before = frames.length;

  controller.setFacing(-1); // 同一个朝向
  assert.equal(frames.length, before, '朝向未变不许重启播放（重启 = 相位跳回第 0 帧）');
  assert.equal(controller.currentFrameId, 'l2', '帧位置必须原地不动');
  clock.advance(110);
  assert.equal(frames[frames.length - 1], 'l3', '时间轴继续按原来的相位推进');
});

test('F07 setFacing：正在播姿态时用新朝向重播，且从第 0 帧开始（不续相位）', () => {
  const { controller, clock, frames } = makeController({ facing: -1 });
  controller.setPosture('walk');
  clock.advance(220); // 已经走到 l3
  assert.equal(controller.currentFrameId, 'l3');

  controller.setFacing(1);
  assert.equal(controller.facing, 1, '朝向必须真的改了');
  assert.equal(controller.clipId, 'cycle');
  assert.equal(controller.clipFacing, 1, '片段必须换成右向那条，绝不回落到左向');
  assert.equal(controller.currentFrameId, 'r1', '必须从第 0 帧重播（r1），而不是续着 l3 的相位');
  assert.equal(frames[frames.length - 1], 'r1');
  clock.advance(110);
  assert.equal(controller.currentFrameId, 'r2', '重播后按 110ms 正常推进');
});

test('F08 setFacing：新朝向没有片段 ⇒ 降级站姿，绝不回落到另一朝向', () => {
  // 合成：walk 只留左向片段
  const leftOnly = posesWith((draft) => {
    const walk = draft.batches.walk;
    assert.ok(walk, '真清单里必须有 walk');
    return {
      ...draft,
      batches: { ...draft.batches, walk: { ...walk, clips: walk.clips.filter((clip) => clip.facing !== 1) } },
    };
  });
  const { controller, root } = makeController({ facing: -1, poses: leftOnly });
  controller.setPosture('walk');
  assert.equal(controller.posture, 'walk');

  controller.setFacing(1);
  assert.equal(controller.posture, 'stand', '右向缺片段必须降级站姿');
  assert.equal(root.getAttribute('data-posture'), 'stand', '`data-posture` 必须同步回 stand');
  assert.equal(controller.clipFacing, null, '不许留着左向片段继续播（那就是"回落"）');
  assert.equal(controller.isPlaying, false);
});

test('F09 setFacing：站姿下只记朝向、不播；非法值抛 TypeError', () => {
  const { controller, frames } = makeController({ facing: -1 });
  controller.setFacing(1);
  assert.equal(controller.facing, 1, '站姿下也要记住新朝向（下次进姿态直接用）');
  assert.equal(controller.posture, 'stand');
  assert.deepEqual(frames, [], '站姿下改朝向不许上屏任何帧');

  for (const bad of [0, 2, Number.NaN, '1' as unknown as Facing]) {
    assert.throws(
      () => controller.setFacing(bad),
      (error: unknown) => error instanceof TypeError,
      `setFacing(${String(bad)}) 必须抛 TypeError`,
    );
  }
  assert.equal(controller.facing, 1, '非法值不许改掉朝向');
});

test('F10 runPoseMatrix：一条命令验完 6 个组合（真控制器 + 假时钟）', async () => {
  const { controller, clock } = makeController({ facing: -1 });
  const report = await runPoseMatrix(
    {
      posePlay: (posture, facing) => {
        controller.setFacing(facing);
        controller.setPosture(posture);
        return snapshotOf(controller);
      },
      poseStop: () => {
        controller.setPosture('stand');
      },
      poseSnapshot: () => snapshotOf(controller),
      poseWait: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
    },
    { holdMs: 0 },
  );
  assert.equal(report.steps.length, 6, 'walk/run/jump × 左右 = 6 个组合');
  assert.deepEqual(
    report.steps.map((step) => `${step.posture}@${step.facing}`),
    ['walk@-1', 'walk@1', 'run@-1', 'run@1', 'jump@-1', 'jump@1'],
    '顺序必须稳定（姿态外层、朝向内层）',
  );
  assert.equal(report.ok, true, `6 个组合必须全绿：${report.problems.join(' | ')}`);
  assert.deepEqual(report.problems, []);
  assert.equal(controller.posture, 'stand', '矩阵跑完必须收尾回站姿（不留"跑完还在跳"的现场）');
});

test('F11 runPoseMatrix 的判别力：任一组合没生效就必须红且点名（不返回"看起来成功")', async () => {
  // 坏法：play 忽略朝向（模拟"回落到另一朝向"这种真实缺陷）
  const { controller, clock } = makeController({ facing: -1 });
  const report = await runPoseMatrix(
    {
      posePlay: (posture, facing) => {
        controller.setFacing(-1); // 永远左向：忽略传入的 facing
        controller.setPosture(posture);
        return snapshotOf(controller);
      },
      poseStop: () => controller.setPosture('stand'),
      poseSnapshot: () => snapshotOf(controller),
      poseWait: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
    },
    { holdMs: 0 },
  );
  assert.equal(report.ok, false, '右向没生效必须判红');
  assert.ok(
    report.problems.some((line) => line.includes('朝向没生效')),
    `必须点名"朝向没生效"，实际：${report.problems.join(' | ')}`,
  );
  assert.equal(report.steps.filter((step) => step.ok).length, 3, '只有三个左向组合该绿');
});

test('F12 judgePoseStep 的三个判据（姿态 / 片段朝向 / 是否在播）各自独立生效', () => {
  const good: PoseDebugSnapshot = {
    posture: 'walk',
    facing: 1,
    clipId: 'cycle',
    clipFacing: 1,
    frameId: 'r1',
    playing: true,
    override: 'walk',
  };
  assert.deepEqual(judgePoseStep(good, 'walk', 1), [], '完全正确时必须零问题');
  assert.deepEqual(judgePoseStep(null, 'walk', 1), ['读不到姿态快照（姿态控制器未就绪）']);

  const wrongPosture = judgePoseStep({ ...good, posture: 'stand' }, 'walk', 1);
  assert.equal(wrongPosture.length, 1);
  assert.match(wrongPosture[0], /姿态没切过去/);

  const wrongFacing = judgePoseStep({ ...good, clipFacing: -1 }, 'walk', 1);
  assert.equal(wrongFacing.length, 1);
  assert.match(wrongFacing[0], /朝向没生效/);

  const notPlaying = judgePoseStep({ ...good, playing: false }, 'walk', 1);
  assert.equal(notPlaying.length, 1);
  assert.match(notPlaying[0], /没有在播/);
});

test('F13 姿态后门的 play 对非法姿态名/朝向给出 ok:false 的结果（不抛错、不假成功）', () => {
  return Promise.resolve().then(() => {
    const handle = buildPoseHandle({
      posePlay: () => null,
      poseStop: () => {},
      poseRelease: () => {},
      poseFacing: (next: Facing): Facing => next,
      poseSnapshot: () => null,
      poseWait: () => Promise.resolve(),
    });
    const bad = handle.play('nope');
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0] ?? '', /未知姿态名/);
    // 读不到快照 ⇒ 明确判红（而不是"没消息就是好消息"）
    const noSnapshot = handle.play('walk', 1);
    assert.equal(noSnapshot.ok, false);
    assert.match(noSnapshot.problems[0] ?? '', /读不到姿态快照/);
    assert.throws(() => handle.facing(0 as unknown as Facing), (error: unknown) => error instanceof TypeError);
    // 端口缺失必须明确报错（假成功比不可用更糟）
    const crippled = buildPoseHandle({ poseSnapshot: () => null });
    assert.throws(() => crippled.play('walk', 1), (error: unknown) => error instanceof Error && /缺少端口/.test(error.message));
  });
});

/**
 * 读控制器快照（测试侧唯一的快照出口，字段与后门一致）。
 */
function snapshotOf(controller: PoseController): PoseDebugSnapshot {
  return {
    posture: controller.posture,
    facing: controller.facing,
    clipId: controller.clipId,
    clipFacing: controller.clipFacing,
    frameId: controller.currentFrameId,
    playing: controller.isPlaying,
    override: null,
  };
}

/**
 * 造一套"矩阵端口"（真控制器 + 假时钟；`poseWait` 只推进时钟，即真机 `setTimeout` 的等价物）。
 *
 * <p><b>为什么 `poseClip` 默认按 `options.poses` 查而不是按全局 `PET_POSES`：</b>
 * 用合成清单测试时，时序必须来自**同一份**清单；否则"合成片段说 hold-last、工具却读真清单说
 * return-stand"会造出一条假红（正是本次要修的这类"工具比现实更严但严错了地方"的缺陷）。</p>
 *
 * @param controller 控制器
 * @param clock 假时钟
 * @param options 选项
 * @param options.poses 控制器实际使用的清单（缺省真清单）
 * @param options.ignoreFacing 故意忽略传入朝向（模拟"回落到另一朝向"的缺陷）
 * @param options.poseClip 覆盖时序查询
 * @returns 端口
 */
function matrixPorts(
  controller: PoseController,
  clock: FakeClock,
  options: {
    poses?: PetPoses;
    ignoreFacing?: boolean;
    poseClip?: (posture: string, facing: Facing, clipId: string | null) => PoseClipTiming | null;
  } = {},
): PoseMatrixPorts {
  const poses = options.poses ?? PET_POSES;
  const query =
    options.poseClip ?? ((posture: string, facing: Facing, clipId: string | null) =>
      clipTimingOf(poses, posture as PostureId, facing, clipId));
  return {
    posePlay: (posture, facing) => {
      controller.setFacing(options.ignoreFacing === true ? -1 : facing);
      controller.setPosture(posture);
      return snapshotOf(controller);
    },
    poseStop: () => {
      controller.setPosture('stand');
    },
    poseSnapshot: () => snapshotOf(controller),
    poseWait: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    poseClip: (posture, facing, clipId) => query(posture, facing, clipId),
  };
}

test('F14 假阴性回归：jump 的 once（650ms + return-stand）在 700ms 处会拍到"已回站姿"', () => {
  // 这正是主理人实测到的三条红：固定等 700ms 之后，jump 已经播完回站姿了
  const { controller, clock } = makeController({ facing: -1 });
  controller.setPosture('jump');
  clock.advance(700);
  const late = snapshotOf(controller);
  assert.equal(late.posture, 'stand', 'jump 的 once 是 5 帧 × 130ms = 650ms，700ms 时已回站姿');
  assert.equal(late.playing, false);
  const problems = judgePoseStep({ ...late, posture: 'jump', clipFacing: -1, playing: true }, 'jump', -1);
  assert.deepEqual(problems, [], '连"伪造一个在播快照"都能过——说明判据本身没错，错的是**拍照时刻**');

  // 用真实（已播完）的快照判，必然三条全红——这就是旧实现干的事
  const real = judgePoseStep(late, 'jump', -1);
  assert.equal(real.length, 3, `旧时机应当三条全红，实际：${real.join(' | ')}`);
  assert.match(real[0], /姿态没切过去/);
  assert.match(real[1], /朝向没生效/);
  assert.match(real[2], /没有在播/);
});

test('F15 runPoseMatrix 按片段时长采样：jump 两项必须 ok:true，且带 clipMs / sampleAtMs / terminalChecked', async () => {
  const { controller, clock } = makeController({ facing: -1 });
  // 关键：仍然传 700（旧的固定值）。判红不该靠把这个数调小，而该靠"按片段时长采样"。
  const report = await runPoseMatrix(matrixPorts(controller, clock), { holdMs: 700 });
  assert.equal(report.ok, true, `6 个组合必须全绿（含 jump 左右两向）：${report.problems.join(' | ')}`);

  const jumps = report.steps.filter((step) => step.posture === 'jump');
  assert.equal(jumps.length, 2);
  for (const step of jumps) {
    assert.equal(step.ok, true, `jump@${step.facing} 必须判 ok（旧实现把正确行为判成失败）`);
    assert.equal(step.clipMs, 650, 'jump 的 once 总时长 = 5 × 130 = 650ms');
    assert.equal(step.sampleAtMs, 260, '一次性片段在 min(650 × 0.4, 300) = 260ms 处采样');
    assert.equal(step.terminalChecked, true, '一次性 + return-stand 必须补验"播完回站姿"');
    assert.equal(step.snapshot?.posture, 'jump', '采样时刻必须仍在 jump（不是已回站姿）');
    assert.equal(step.snapshot?.playing, true);
  }
  // 循环片段：在 min(总时长/2, 300) 处采样
  const walk = report.steps.filter((step) => step.posture === 'walk');
  const run = report.steps.filter((step) => step.posture === 'run');
  for (const step of walk) {
    assert.equal(step.clipMs, 440, 'walk 的 cycle = 4 × 110 = 440ms');
    assert.equal(step.sampleAtMs, 220, '循环片段在 min(440/2, 300) = 220ms 处采样');
    assert.equal(step.terminalChecked, false, '循环片段没有"播完"这回事');
  }
  for (const step of run) {
    assert.equal(step.clipMs, 540, 'run 的 cycle = 6 × 90 = 540ms');
    assert.equal(step.sampleAtMs, 270);
  }
  // 采样函数本身的契约（上表就是它的三个分支）
  assert.equal(sampleDelayOf({ clipId: 'cycle', clipMs: 440, loop: true, returnsToStand: false }), 220);
  assert.equal(sampleDelayOf({ clipId: 'cycle', clipMs: 2000, loop: true, returnsToStand: false }), 300, '封顶 300');
  assert.equal(sampleDelayOf({ clipId: 'once', clipMs: 650, loop: false, returnsToStand: true }), 260);
  assert.equal(sampleDelayOf({ clipId: 'hold', clipMs: 0, loop: false, returnsToStand: false }), 0, '静止帧立即拍');
  assert.equal(sampleDelayOf(null), 0, '查不到时序时不许猜一个时长');
  // 收尾：矩阵跑完必须回站姿
  assert.equal(controller.posture, 'stand');
});

test('F16 终态断言的牙齿：return-stand 坏掉（播完不回站姿）⇒ 必须红且点名"没有回站姿"', async () => {
  // 合成：把 jump 的 once 改成 hold-last（= return-stand 这一环坏了），帧数/时长不变
  const holdLast = posesWith((draft) => {
    const jump = draft.batches.jump;
    assert.ok(jump, '真清单里必须有 jump');
    return {
      ...draft,
      batches: {
        ...draft.batches,
        jump: { ...jump, clips: jump.clips.map((clip) => ({ ...clip, onEnd: 'hold-last' as const })) },
      },
    };
  });
  // ① 数据一变，`clipTimingOf` 必须立刻看出来（工具跟着数据走，不是硬编码"jump 会回站姿"）
  const realTiming = clipTimingOf(PET_POSES, 'jump', -1, 'once');
  assert.ok(realTiming, '真数据里必须有 jump 的 once 片段');
  assert.equal(realTiming.returnsToStand, true);
  assert.equal(clipTimingOf(holdLast, 'jump', -1, 'once')?.returnsToStand, false);

  // ② 用 hold-last 的清单跑：终态不再是站姿，但时序如实报告 returnsToStand=false ⇒ 不补终态断言，判 ok
  const held = makeController({ facing: -1, poses: holdLast });
  const heldReport = await runPoseMatrix(matrixPorts(held.controller, held.clock, { poses: holdLast }), { holdMs: 700 });
  assert.equal(heldReport.ok, true, `hold-last 片段本来就该停在末帧，不是缺陷：${heldReport.problems.join(' | ')}`);
  assert.equal(
    heldReport.steps.filter((step) => step.posture === 'jump').every((step) => step.terminalChecked === false),
    true,
    '不到"回站姿"的场景不许假装验过终态',
  );

  // ③ 但若口径说"该回站姿"（时序报 returnsToStand=true）而实际没回 ⇒ 必须红
  const lying = makeController({ facing: -1, poses: holdLast });
  const lyingReport = await runPoseMatrix(
    matrixPorts(lying.controller, lying.clock, {
      poses: holdLast,
      // 谎报：声称这条片段会回站姿（等价于"有人把 behavior 或裁剪改坏了"）
      poseClip: (posture, facing, clipId) => {
        const timing = clipTimingOf(holdLast, posture as PostureId, facing, clipId);
        return timing === null ? null : { ...timing, returnsToStand: true };
      },
    }),
    { holdMs: 700 },
  );
  assert.equal(lyingReport.ok, false, 'return-stand 没生效必须红');
  assert.ok(
    lyingReport.problems.some((line) => line.includes('没有回站姿')),
    `必须点名"没有回站姿"，实际：${lyingReport.problems.join(' | ')}`,
  );
});

test('F17 judgePoseStep：该验的终态没验也必须判红（删掉终态断言会有人红）', () => {
  const playing: PoseDebugSnapshot = {
    posture: 'jump',
    facing: -1,
    clipId: 'once',
    clipFacing: -1,
    frameId: 'apex',
    playing: true,
    override: 'jump',
  };
  const timing = { clipId: 'once', clipMs: 650, frameCount: 5, loop: false, returnsToStand: true };
  // 给了 timing 却不给终态快照 ⇒ "该验的没验"
  const unchecked = judgePoseStep(playing, 'jump', -1, { timing });
  assert.equal(unchecked.length, 1);
  assert.match(unchecked[0], /没有验"播完回站姿"的终态/);

  // 终态给了且正确 ⇒ 零问题
  const done: PoseDebugSnapshot = { ...playing, posture: 'stand', clipId: null, clipFacing: null, playing: false };
  assert.deepEqual(judgePoseStep(playing, 'jump', -1, { timing, terminal: done }), []);
  // 终态给了但还在跳 ⇒ 红
  const stuck = judgePoseStep(playing, 'jump', -1, { timing, terminal: playing });
  assert.equal(stuck.length, 1);
  assert.match(stuck[0], /没有回站姿/);
});

test('F18 【G-1】锚点来源是白名单：mirror-derived 与任何未知值一律判不可播', () => {
  /** 把某个批次的 byFacingSource 改成任意值（`undefined` 直接删键，模拟"清单里没这个字段"）。 */
  const withSource = (posture: PostureId, value: unknown): PetPoses =>
    posesWith((draft) => {
      const anchor = draft.batches[posture]?.bodyAnchor as unknown as Record<string, unknown> | undefined;
      assert.ok(anchor, `真清单里必须有 ${posture}`);
      if (value === undefined) delete anchor.byFacingSource;
      else anchor.byFacingSource = value;
      return draft;
    });

  // 黑名单写法（`!== 'mirror-derived'`）会把这些**未知值全部放行**——白名单必须全部拒绝。
  const rejected = [undefined, 'x', null, '', 0, 'MEASURED-PER-FACING', 'mirror-derived'];
  for (const value of rejected) {
    const poses = withSource('walk', value);
    assert.equal(isPlayable(poses, 'walk'), false, `byFacingSource=${JSON.stringify(value)} 必须判不可播（缺省 facing）`);
    assert.equal(isPlayable(poses, 'walk', -1), false, `byFacingSource=${JSON.stringify(value)} 必须判不可播（facing=-1）`);
    assert.equal(isPlayable(poses, 'walk', 1), false, `byFacingSource=${JSON.stringify(value)} 必须判不可播（facing=1）`);
  }

  // 零行为变化：真清单四批的来源都是合法白名单值，逐批仍可播（左右两向都查一遍）
  for (const posture of ['sit', 'walk', 'run', 'jump'] as const) {
    const source = PET_POSES.batches[posture]?.bodyAnchor.byFacingSource;
    assert.ok(
      source === 'measured-per-facing' || source === 'batch-single',
      `${posture} 的真来源必须落在白名单里，实际 ${JSON.stringify(source)}`,
    );
    assert.equal(isPlayable(PET_POSES, posture), true, `${posture} 必须仍可播（白名单没有改变真数据的行为）`);
    assert.equal(isPlayable(PET_POSES, posture, -1), true, `${posture}@-1 必须仍可播`);
  }
  // 白名单里两种值都必须真的放行（否则"全部拒绝"也能骗过上面的断言）
  for (const allowed of ['measured-per-facing', 'batch-single'] as const) {
    assert.equal(isPlayable(withSource('walk', allowed), 'walk'), true, `${allowed} 必须放行`);
  }
});

test('F19 【G-2】时序查不到 + 姿态声明了 return-stand ⇒ 判红"该验的没验"（两种成因都算）', () => {
  const playing: PoseDebugSnapshot = {
    posture: 'jump',
    facing: 1,
    clipId: 'once',
    clipFacing: 1,
    frameId: 'apex',
    playing: true,
    override: 'jump',
  };
  // ① 独立查询：真数据里 jump 声明了 return-stand，其余姿态没有
  assert.equal(declaresReturnStand(PET_POSES, 'jump', 1, 'once'), true);
  assert.equal(declaresReturnStand(PET_POSES, 'jump', -1, 'once'), true);
  assert.equal(declaresReturnStand(PET_POSES, 'walk', -1, 'cycle'), false, 'walk 是循环片段，不该要求终态');
  assert.equal(declaresReturnStand(PET_POSES, 'sit', -1, 'hold'), false);
  // 片段查不到时保守扫描该姿态全部片段（宁可多验一次，也不许当作"不用验"）
  assert.equal(declaresReturnStand(PET_POSES, 'jump', 1, 'does-not-exist'), true);
  assert.equal(declaresReturnStand(PET_POSES, 'jump', 1, null), true);

  // ② timing 查不到 + 声明了 return-stand ⇒ 红（成因一：片段查不到；成因二：poseClip 端口缺失/null）
  const unchecked = judgePoseStep(playing, 'jump', 1, { timing: null, declaresReturnStand: true });
  assert.equal(unchecked.length, 1, `必须只有这一条红：${unchecked.join(' | ')}`);
  assert.match(unchecked[0], /该验的没验/);
  assert.match(unchecked[0], /return-stand/);
  // 对照组：没声明 return-stand 的姿态，timing 查不到不算缺陷（不许"永远判红"）
  assert.deepEqual(judgePoseStep(playing, 'jump', 1, { timing: null, declaresReturnStand: false }), []);
});

test('F19b 【G-2】矩阵里 poseClip 端口撒谎（返回 null）也红：jump 两步必须点名"该验的没验"', async () => {
  const live: { current: PoseDebugSnapshot | null } = { current: null };
  const report = await runPoseMatrix({
    posePlay: (posture, facing) => {
      live.current = {
        posture,
        facing,
        clipId: posture === 'jump' ? 'once' : 'cycle',
        clipFacing: facing,
        frameId: `${posture}-0`,
        playing: true,
        override: posture,
      };
      return live.current;
    },
    poseStop: () => {},
    poseSnapshot: () => live.current,
    poseWait: async () => {},
    // 端口撒谎：任何片段都查不到时序
    poseClip: () => null,
  });
  assert.equal(report.ok, false, 'jump 声明了 return-stand 而时序查不到 ⇒ 不许判绿');
  const jumps = report.steps.filter((step) => step.posture === 'jump');
  assert.equal(jumps.length, 2);
  for (const step of jumps) {
    assert.equal(step.ok, false, `jump@${step.facing} 必须红`);
    assert.equal(step.terminalChecked, false, '报告必须承认"终态没验"');
    assert.ok(
      step.problems.some((line) => line.includes('该验的没验')),
      `必须点名"该验的没验"，实际：${step.problems.join(' | ')}`,
    );
  }
  // walk/run 是循环片段，不受这条影响（不许连带打红）
  for (const step of report.steps.filter((item) => item.posture !== 'jump')) {
    assert.equal(step.problems.some((line) => line.includes('该验的没验')), false, `${step.posture} 不该被连坐`);
  }
});

test('F20 【G-4】"帧在推进"判据：冻住的动画必须红，单帧片段必须显式豁免并写明原因', async () => {
  // ① judgePoseStep 单点：frameId 不变 ⇒ 红；变了 ⇒ 零问题
  const playing: PoseDebugSnapshot = {
    posture: 'walk',
    facing: -1,
    clipId: 'cycle',
    clipFacing: -1,
    frameId: 'l1',
    playing: true,
    override: 'walk',
  };
  const frozen = judgePoseStep(playing, 'walk', -1, { startFrameId: 'l1', motionRequired: true });
  assert.equal(frozen.length, 1);
  assert.match(frozen[0], /帧没在推进/);
  assert.deepEqual(judgePoseStep({ ...playing, frameId: 'l3' }, 'walk', -1, { startFrameId: 'l1', motionRequired: true }), []);
  // 没给起点同样算"该验的没验"（不许静默通过）
  const missing = judgePoseStep(playing, 'walk', -1, { motionRequired: true });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /没有验"帧在推进"/);
  // 单帧片段：调用方必须显式传 motionRequired:false，此时不许判红
  assert.deepEqual(judgePoseStep(playing, 'walk', -1, { startFrameId: 'l1', motionRequired: false }), []);

  // ② 真控制器 + 假时钟：6 个组合都必须真的验过"帧在推进"
  const { controller, clock } = makeController({ facing: -1 });
  const okReport = await runPoseMatrix(matrixPorts(controller, clock), {});
  assert.equal(okReport.ok, true, `真控制器必须全绿：${okReport.problems.join(' | ')}`);
  for (const step of okReport.steps) {
    assert.equal(step.motionChecked, true, `${step.posture}@${step.facing} 必须真的验了帧推进（${step.motionReason}）`);
    assert.notEqual(step.startFrameId, step.sampleFrameId, `${step.posture}@${step.facing} 采样前后帧必须不同`);
    assert.equal(step.sampleFrameId, step.snapshot?.frameId ?? null);
  }

  // ③ 冻住的端口（frameId 恒定、playing 恒 true）：必须红，且点名"帧没在推进"
  const frozenReport = await runPoseMatrix({
    posePlay: (posture, facing) => ({
      posture,
      facing,
      clipId: posture === 'jump' ? 'once' : 'cycle',
      clipFacing: facing,
      frameId: `${posture}-frozen-0`,
      playing: true,
      override: posture,
    }),
    poseStop: () => {},
    poseSnapshot: () => null, // 退化到 posePlay 的返回值（同一帧）
    poseWait: async () => {},
  });
  assert.equal(frozenReport.ok, false, '动画冻住必须判红——"playing:true"不等于"画面在动"');
  for (const step of frozenReport.steps) {
    assert.ok(
      step.problems.some((line) => line.includes('帧没在推进')),
      `${step.posture}@${step.facing} 必须点名"帧没在推进"，实际：${step.problems.join(' | ')}`,
    );
  }
  assert.equal(
    frozenReport.problems.filter((line) => line.includes('帧没在推进')).length,
    6,
    '6 个组合的帧推进都必须被验到并判红（一个都不许漏）',
  );

  // ④ 单帧片段（如 sit 的 hold）：显式豁免，motionChecked 必须是 false 且原因写明"单帧"
  const singleFrame = await runPoseMatrix(
    {
      posePlay: (posture, facing) => ({
        posture,
        facing,
        clipId: posture === 'jump' ? 'once' : 'cycle',
        clipFacing: facing,
        frameId: `${posture}-0`,
        playing: true,
        override: posture,
      }),
      poseStop: () => {},
      poseSnapshot: () => null,
      poseWait: async () => {},
      // 谎称每条片段都是"单帧 0ms 的静止姿态"（等价于 sit 的 hold）
      poseClip: (posture, facing, clipId) => ({ clipId: clipId ?? 'hold', clipMs: 0, frameCount: 1, loop: false, returnsToStand: false }),
    },
    {},
  );
  assert.equal(singleFrame.ok, true, '单帧片段没有帧可推进，不该判红');
  for (const step of singleFrame.steps) {
    assert.equal(step.motionChecked, false, '单帧片段必须标 motionChecked:false（false = 没验，不是通过）');
    assert.match(step.motionReason, /单帧片段/, `必须写明理由，实际：${step.motionReason}`);
  }
  // ⑤ 采样时刻短于单帧时长 ⇒ 不能判"帧没在推进"（那是采样太早，不是动画冻住），必须标未验
  const early = await runPoseMatrix(matrixPorts(controller, clock), { holdMs: 0 });
  assert.equal(early.ok, true, `立即采样不该被打红：${early.problems.join(' | ')}`);
  for (const step of early.steps) {
    assert.equal(step.motionChecked, false, '0ms 采样跨不过帧边界 ⇒ 必须如实标未验');
    assert.match(step.motionReason, /短于单帧时长/);
  }
});
