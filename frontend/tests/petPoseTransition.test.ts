/**
 * 起身链（`lie` → `exit` → `stand`）单测（M2 切片 3 · T04 · P-12 / P-13）。
 *
 * <p><b>为什么要单独立一个文件：</b>切片 2 的 `setPosture('stand')` 是"立刻回站姿"，
 * 于是趴着的猫会**瞬间站起**（没有起身动画）。修法不是"多播一条片段"那么简单，
 * 它引入了三个只有精确时钟才能抓住的缺陷：</p>
 * <ol>
 *   <li><b>重复触发</b>：`main.ts` 的 `syncPosture()` 每 250 ms 重算 `postureOf(state)`，
 *       起身期间 `posture` 仍是 `lie` 而 `desired` 已是 `stand` ⇒ 没有幂等门就会
 *       "一帧内连播两次 exit"（起身动画反复抽搐）；</li>
 *   <li><b>收尾不自洽</b>：`exit` 播完必须回 `stand`、图隐藏、停播、重启眨眼，否则会留下
 *       "看不见但还在播"的幽灵片段；</li>
 *   <li><b>打断</b>：拖拽要能暂停起身、松手能继续（`pause`/`resume`）。</li>
 * </ol>
 *
 * @module tests/petPoseTransition
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_POSES } from '../src/pet/poses/manifest';
import { PoseController, type PoseBlinkLike } from '../src/pet/poses/controller';
import type { Facing, PetPoses } from '../src/pet/poses/types';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';

/** 可控时钟 + 定时器队列（播放推进只认注入的 `now` / `schedule` / `cancel`）。 */
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
   * @param delayMs 延迟（毫秒）
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
   * 推进时间并触发到期回调（按时间升序逐个触发）。
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

/** 假眨眼驱动。 */
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
 * 造一个控制器（帧回调记进 `frames`，日志记进 `logs`）。
 *
 * @param options 选项
 * @param options.facing 构造期朝向（缺省 `-1`）
 * @param options.poses 清单（缺省真清单）
 * @returns 控制器与观测面
 */
function makeController(options: { facing?: Facing; poses?: PetPoses } = {}): {
  controller: PoseController;
  clock: FakeClock;
  frames: string[];
  logs: string[];
  root: FakeElement;
} {
  const clock = new FakeClock();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const frames: string[] = [];
  const logs: string[] = [];
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
    log: (message) => {
      logs.push(message);
    },
    facing: options.facing ?? -1,
  });
  return { controller, clock, frames, logs, root };
}

/**
 * 数某个帧在时间轴上出现了几次。
 *
 * @param frames 帧序列
 * @param frameId 帧 id
 * @returns 次数
 */
function countOf(frames: readonly string[], frameId: string): number {
  return frames.filter((id) => id === frameId).length;
}

test('P-12 pendingStand 幂等门：一轮起身只播一次 exit（syncPosture 每 250ms 重算也不许重播）', () => {
  const { controller, clock, frames } = makeController();
  controller.setPosture('lie');
  assert.equal(controller.posture, 'lie');
  assert.equal(controller.clipId, 'enter', '进姿态播的是 enter（趴下过程 + 停留）');
  clock.advance(480); // enter 播完（4 × 120ms）⇒ 停在末帧
  assert.equal(controller.currentFrameId, 'lie_neutral', 'enter 播完停在末帧（hold-last）');
  const beforeStand = frames.length;

  controller.setPosture('stand');
  assert.equal(controller.posture, 'lie', '起身期间姿态仍是 lie（exit 是过渡片段，不是新姿态）');
  assert.equal(controller.clipId, 'exit', '先播 exit（起身），不是立刻站姿');
  assert.equal(controller.clipFacing, -1, '单朝向批：exit 只有 facing:-1，原样播（不镜像）');
  assert.deepEqual(frames.slice(beforeStand), ['lie_up_01_neutral'], 'exit 从第 0 帧开始');

  // 模拟 syncPosture 每 250ms 重算：desired 一直是 'stand'，会反复进 setPosture('stand')
  for (let tick = 0; tick < 4; tick += 1) {
    clock.advance(250);
    controller.setPosture('stand');
  }
  assert.equal(
    countOf(frames, 'lie_up_01_neutral'),
    1,
    `exit 的第 0 帧只许出现一次（幂等门失效会连播两次起身）：${JSON.stringify(frames)}`,
  );
});

test('P-13 exit 播完 ⇒ 回站姿 + 图隐藏 + 停播 + 门复位（下一轮起身能再触发）', () => {
  const { controller, clock, root } = makeController();
  controller.setPosture('lie');
  clock.advance(480);
  controller.setPosture('stand');
  assert.equal(controller.clipId, 'exit');

  // exit = 3 帧 × 120ms = 360ms
  clock.advance(360);
  assert.equal(controller.posture, 'stand', 'exit 播完必须回站姿（onEnd: return-stand 的收尾）');
  assert.equal(root.getAttribute('data-posture'), 'stand', 'data-posture 必须同步回 stand');
  assert.equal(controller.clipId, null, '不许留着 exit 片段（"看不见但还在播"的幽灵）');
  assert.equal(controller.isPlaying, false, '必须停播');
  assert.equal(controller.imageElement.hidden, true, '.pet-pose 的图必须藏起来（站姿由压平帧承担）');
  assert.equal(controller.currentFrameId, null, '帧位置必须清空');

  // 门已复位：再趴一次、再起身，必须还能触发 exit（否则第二轮起身会退化成"立刻站起"）
  controller.setPosture('lie');
  assert.equal(controller.posture, 'lie');
  clock.advance(480);
  controller.setPosture('stand');
  assert.equal(controller.clipId, 'exit', '第二轮起身必须同样先播 exit');
});

test('sleep 没有 exit 片段 ⇒ 走旧路径硬切站姿（一帧都不播，行为与切片 2 相同）', () => {
  const { controller, frames } = makeController();
  controller.setPosture('sleep');
  assert.equal(controller.posture, 'sleep');
  const before = frames.length;
  controller.setPosture('stand');
  assert.equal(controller.posture, 'stand', 'sleep 没有起身过渡 ⇒ 立刻回站姿');
  assert.equal(controller.clipId, null);
  assert.equal(controller.isPlaying, false);
  assert.equal(frames.length, before, '硬切不许上屏任何新帧（不会"闪一下 exit"）');
});

test('拖拽打断起身：pause 期间时间轴不动，resume 后继续把 exit 播完', () => {
  const { controller, clock, frames } = makeController();
  controller.setPosture('lie');
  clock.advance(480);
  controller.setPosture('stand');
  assert.deepEqual(frames.slice(-1), ['lie_up_01_neutral']);

  controller.pause();
  const pausedAt = controller.currentFrameId;
  clock.advance(1000);
  assert.equal(controller.currentFrameId, pausedAt, '暂停期间不许推进（拖拽中姿态保持）');
  assert.equal(controller.posture, 'lie', '暂停期间仍是 lie（起身没结束）');

  controller.resume();
  clock.advance(120);
  assert.deepEqual(frames.slice(-1), ['lie_up_02_neutral'], 'resume 后从剩余时间继续起身');
  clock.advance(240);
  assert.equal(controller.posture, 'stand', '继续播完 ⇒ 回站姿');
});

test('T04 第 9 项：趴/睡状态下改朝向不打断姿态（不 leavePose、不重播 enter）', () => {
  const { controller, clock, frames, logs } = makeController();
  controller.setPosture('lie');
  assert.equal(controller.posture, 'lie');
  clock.advance(240); // enter 播到第 3 帧
  const before = frames.length;
  const frameBefore = controller.currentFrameId;

  controller.setFacing(1);
  assert.equal(controller.facing, 1, '朝向本身必须真的改了（渲染层不做镜像）');
  assert.equal(controller.posture, 'lie', '不许把趴着的猫踢起来（旧实现会 leavePose）');
  assert.equal(controller.clipId, 'enter', '片段不变（单朝向批忽略朝向）');
  assert.equal(controller.currentFrameId, frameBefore, '不许从第 0 帧重播（重放趴下动画同样不是用户要的）');
  assert.equal(frames.length, before, '朝向变化不该上屏任何新帧');
  assert.ok(
    logs.some((line) => /单朝向批/.test(line) && /保持当前片段/.test(line)),
    `日志必须写清"单朝向批保持当前片段"：${JSON.stringify(logs)}`,
  );

  // 起身之后再验一次：换朝向后仍能正常起身（exit 只有 facing:-1，单朝向回退必须生效）
  clock.advance(240);
  controller.setPosture('stand');
  assert.equal(controller.clipId, 'exit', '朝向 1 下也必须能起身（exit 走单朝向回退）');
  clock.advance(360);
  assert.equal(controller.posture, 'stand');
});
