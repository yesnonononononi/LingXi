/**
 * 姿态播放器 + 姿态表现层单测（tsx 执行，不碰真 DOM、不起 Electron）。
 *
 * <p><b>它证明什么（对应设计 §A1.6 与 G-01/G-02/G-03/G-13）：</b></p>
 * <ol>
 *   <li><b>G-13 时序合法性</b>：`frameMs` 的 79 / 80 / 2400 / 2401 四个边界逐个断言；
 *       单帧静止姿态（`sit.hold`）允许 0，**多帧片段的 0 必须红**（那是 rAF 空转）；</li>
 *   <li><b>G-03 同批帧不双影</b>：pose 层里 `<img>` 数恒为 1，换帧只改 `src`。
 *       金丝雀：宿主里原本的 2 个 `.pet-art-frame`（双缓冲）必须还在且仍是 2 个，
 *       证明"数到 1"不是元素都没建；</li>
 *   <li><b>G-02 不叠脸层</b>：非站姿时眨眼驱动被停掉、回站姿重启。
 *       金丝雀：构造时眨眼确实在跑（否则"pose 态没跑"可能是根本没启动过）；</li>
 *   <li><b>G-01 单一可见源</b>：真实 `pet.css` 里三条互斥规则精确匹配到，
 *       且删掉任一条 / 把 `display:none` 换成 `opacity:0` 都必须红；</li>
 *   <li><b>不跳脚的地基</b>：姿态盒只由 `boxOf`（= `placement.ts` 纯函数）结果写入，
 *       本类不碰任何窗口 API；姿态不可播时优雅回落站姿。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PoseController, type PoseBlinkLike, type PoseBox } from '../src/pet/poses/controller';
import { poseVisibilityProblems, matchPoseVisibility } from '../src/pet/poses/css-contract';
import {
  FRAME_MS_MAX,
  FRAME_MS_MIN,
  PosePlayer,
  validatePoseClip,
  type PosePlayerPorts,
} from '../src/pet/poses/player';
import { PET_POSES } from '../src/pet/poses/manifest';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';
import type { Density, PetPoses, PoseClip } from '../src/pet/poses/types';
import { FRONTEND_ROOT } from '../scripts/build-pet-geometry.mjs';

/** 真实的 `pet.css`（G-01 的对象）。 */
const PET_CSS = readFileSync(resolve(FRONTEND_ROOT, 'src', 'pet', 'pet.css'), 'utf8');

/**
 * 假元素：只实现 `ElementLike` 声明的成员（与 `petFaceLayer.test.ts` 同一纪律，不给 `classList`）。
 */
class FakeElement implements ElementLike {
  /** `data-*` 写入面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** CSS 自定义属性写入面。 */
  readonly styleProps = new Map<string, string>();

  /** 属性写入面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面（只实现 `setProperty`）。 */
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

  /** 类名（只为断言 `.pet-pose` 落在宿主里）。 */
  className = '';

  /** 标签名（`poseImageCount` 用它数 `<img>`）。 */
  readonly tagName: string;

  /**
   * 构造假元素。
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
   * @returns 追加进去的节点
   */
  appendChild(child: ElementLike): unknown {
    const element = child as FakeElement;
    this.children.push(element);
    return element;
  }

  /**
   * 写属性。
   *
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    // `class` 是控制器唯一用来标注层名的属性，这里同步一份便于断言
    if (name === 'class') this.className = value;
  }

  /**
   * 读属性。
   *
   * @param name 属性名
   * @returns 属性值；没有时 null
   */
  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }
}

/** 假文档。 */
class FakeDocument implements DocumentLike {
  /**
   * 创建元素。
   *
   * @param tagName 标签名
   * @returns 新的假元素
   */
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}

/**
 * 假时钟：`schedule` 只是入队，测试用 {@link FakeClock.advance} 精确推进。
 *
 * <p>**严禁**内部读 `Date.now`：整套边界断言（19999/20000、79/80/2400/2401）都靠它。</p>
 */
class FakeClock {
  /** 当前时刻。 */
  private time = 0;

  /** 排程（句柄 → 绝对到期时刻 + 回调）。 */
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  /** 下一个句柄。 */
  private nextHandle = 1;

  /**
   * 当前时刻。
   *
   * @returns 毫秒
   */
  now = (): number => this.time;

  /**
   * 排一次回调。
   *
   * @param callback 回调
   * @param delayMs 延迟
   * @returns 句柄
   */
  schedule = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.time + Math.max(0, delayMs), callback });
    return handle;
  };

  /**
   * 取消一次回调。
   *
   * @param handle 句柄
   */
  cancel = (handle: number): void => {
    this.timers.delete(handle);
  };

  /** 未完成的排程数（= 0 证明"静止帧没有空转"）。 */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * 推进时钟并执行到期回调（按到期顺序，支持回调里再排程）。
   *
   * @param ms 推进多少毫秒
   */
  advance(ms: number): void {
    const target = this.time + Math.max(0, ms);
    // 逐条执行：回调里可能立刻排下一次（循环片段），所以要反复取最早的一条
    for (;;) {
      let dueHandle = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueHandle = handle;
        }
      }
      if (dueHandle < 0) break;
      const timer = this.timers.get(dueHandle);
      this.timers.delete(dueHandle);
      if (timer === undefined) break;
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

/** 记录回调的端口。 */
interface RecordedFrames {
  /** 依次上屏的帧 id。 */
  readonly frames: string[];
  /** 依次上报的片段 id。 */
  readonly ends: string[];
}

/**
 * 造一套播放器端口。
 *
 * @param clock 假时钟
 * @returns 端口 + 记录器
 */
function makePorts(clock: FakeClock): { ports: PosePlayerPorts; log: RecordedFrames } {
  const log: RecordedFrames = { frames: [], ends: [] };
  const ports: PosePlayerPorts = {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onFrame: (frameId) => {
      log.frames.push(frameId);
    },
    onClipEnd: (clipId) => {
      log.ends.push(clipId);
    },
  };
  return { ports, log };
}

/** 单帧静止姿态（`sit` 的真实形态：1 帧 + 0ms）。 */
const SIT_HOLD: PoseClip = {
  id: 'hold',
  facing: -1,
  frames: ['sit_neutral'],
  loop: false,
  frameMs: [0],
  onEnd: 'hold-last',
};

/** 三帧循环（`walk` 的形态：110ms × 4 帧，这里取 3 帧够用）。 */
const WALK_CYCLE: PoseClip = {
  id: 'cycle',
  facing: -1,
  frames: ['l1', 'l2', 'l3'],
  loop: true,
  frameMs: [110, 110, 110],
};

/** 一次性片段（`jump` 的形态：落地即回站姿）。 */
const JUMP_ONCE: PoseClip = {
  id: 'once',
  facing: -1,
  frames: ['anticipate', 'apex'],
  loop: false,
  frameMs: [130, 130],
  onEnd: 'return-stand',
};

test('G-13：frameMs 边界 79/80/2400/2401 逐个判定，单帧静止姿态允许 0', () => {
  assert.equal(FRAME_MS_MIN, 80, '下界变了：这是守门值，改动必须同步整份文档与门禁');
  assert.equal(FRAME_MS_MAX, 2400, '上界变了：同上');

  const clipOf = (frameMs: readonly number[]): PoseClip => ({
    id: 'c',
    facing: -1,
    frames: frameMs.map((_, index) => `f${index}`),
    loop: true,
    frameMs,
  });

  assert.deepEqual(validatePoseClip(clipOf([80])), [], '80ms 是合法下界');
  assert.deepEqual(validatePoseClip(clipOf([2400])), [], '2400ms 是合法上界');
  assert.equal(validatePoseClip(clipOf([79])).length, 1, '79ms 低于下界，必须红');
  assert.equal(validatePoseClip(clipOf([2401])).length, 1, '2401ms 高于上界，必须红');
  // 单帧静止姿态：0 合法（D-03 的"可播放内容"口径）
  assert.deepEqual(validatePoseClip(SIT_HOLD), [], '单帧静止姿态的 0ms 必须合法');
  // 多帧片段里出现 0：调度器会立刻自我重排 ⇒ 必须红
  assert.equal(validatePoseClip(clipOf([110, 0])).length, 1, '多帧片段里的 0ms 必须红（否则 rAF 空转）');
  // 长度不等 / 空片段
  assert.equal(validatePoseClip({ id: 'c', facing: -1, frames: ['a', 'b'], loop: true, frameMs: [110] }).length, 1);
  assert.equal(validatePoseClip({ id: 'c', facing: -1, frames: [], loop: true, frameMs: [] }).length, 1);
  // facing 也是校验项：0 不是"中立"，它是没写/写错
  const badFacing = { ...clipOf([110]), facing: 0 } as unknown as PoseClip;
  assert.equal(validatePoseClip(badFacing).length, 1, 'facing=0 必须红（不是默认左向）');
  // 播放器入口也拒绝（不是只有校验函数会报）
  const clock = new FakeClock();
  const { ports } = makePorts(clock);
  const player = new PosePlayer(ports);
  assert.throws(() => player.play(clipOf([79])), RangeError);
});

test('单帧静止姿态：只上屏 1 次、不排任何定时器（不空转）、保持末帧', () => {
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(SIT_HOLD, 0);
  assert.deepEqual(log.frames, ['sit_neutral']);
  assert.equal(clock.pending, 0, '静止帧排了定时器 = rAF 空转（帧时长 0 时最典型的坑）');
  clock.advance(10000);
  assert.deepEqual(log.frames, ['sit_neutral'], '静止姿态不该自己换帧');
  assert.deepEqual(log.ends, [], 'hold-last 不上报收尾（它就是"停在这里"）');
  assert.deepEqual(player.current, { clipId: 'hold', frameIndex: 0, frameId: 'sit_neutral' });
});

test('循环片段：按 frameMs 逐帧推进并回环，永不上报收尾', () => {
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(WALK_CYCLE, 0);
  assert.deepEqual(log.frames, ['l1']);
  clock.advance(110);
  clock.advance(110);
  clock.advance(110);
  assert.deepEqual(log.frames, ['l1', 'l2', 'l3', 'l1'], '循环片段应回环到第 0 帧');
  assert.deepEqual(log.ends, []);
  assert.equal(player.current?.frameIndex, 0);
});

test('一次性片段：播完上报 onClipEnd（return-stand），之后不再排程', () => {
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(JUMP_ONCE, 0);
  clock.advance(130);
  assert.deepEqual(log.frames, ['anticipate', 'apex']);
  assert.deepEqual(log.ends, [], '还没播完');
  clock.advance(130);
  assert.deepEqual(log.ends, ['once'], '播完必须上报一次收尾，控制器据此回站姿');
  assert.equal(clock.pending, 0, '播完还在排程 = 空转');
  clock.advance(1000);
  assert.deepEqual(log.ends, ['once'], '收尾只许上报一次');
});

test('暂停/恢复按剩余时长继续，不重算已流逝时间（拖拽场景）', () => {
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(WALK_CYCLE, 0);
  clock.advance(40);
  player.pause();
  assert.equal(player.isPaused, true);
  assert.equal(clock.pending, 0, '暂停必须取消排程');
  clock.advance(5000);
  assert.deepEqual(log.frames, ['l1'], '暂停期间不该换帧');
  player.resume();
  assert.equal(player.isPaused, false);
  // 剩余 70ms：提前 1ms 不该切，正好到点才切
  clock.advance(69);
  assert.deepEqual(log.frames, ['l1']);
  clock.advance(1);
  assert.deepEqual(log.frames, ['l1', 'l2'], '恢复后必须按剩余 70ms 继续，不能从头计时');
});

test('D-03：单帧静止 + return-stand，pause→resume 绝不许触发 onClipEnd（暂停是透明操作）', () => {
  // 现状（修复前）：单帧静止片段的 remainingMs 在 emitCurrentFrame 时就是 0，
  // 老 resume() 见 <=0 直接 advance() ⇒ 到末尾 ⇒ onClipEnd('return-stand') 被误触发。
  // QA 实测：不暂停 [A] 的 ends=[]，pause→resume [B] 的 ends=["hold"] —— 暂停改变了播放结果。
  const STATIC_RETURN_STAND: PoseClip = {
    id: 'hold',
    facing: -1,
    frames: ['sit_neutral'],
    loop: false,
    frameMs: [0],
    onEnd: 'return-stand',
  };

  // [A] 基线：不暂停
  const clockA = new FakeClock();
  const portsA = makePorts(clockA);
  const playerA = new PosePlayer(portsA.ports);
  playerA.play(STATIC_RETURN_STAND, 0);
  clockA.advance(10000);
  assert.deepEqual(portsA.log.ends, [], '[A] 单帧静止片段本来就不会"自然播完"，不许上报收尾');

  // [B] 对照：pause → resume（拖拽一次，甚至多次）
  const clockB = new FakeClock();
  const portsB = makePorts(clockB);
  const playerB = new PosePlayer(portsB.ports);
  playerB.play(STATIC_RETURN_STAND, 0);
  for (let round = 0; round < 3; round += 1) {
    playerB.pause();
    clockB.advance(50);
    playerB.resume();
    clockB.advance(50);
  }
  assert.deepEqual(
    portsB.log.ends,
    portsA.log.ends,
    '[B] 拖拽 3 次后的收尾轨迹必须与不暂停一致（暂停不许改变播放结果）',
  );
  assert.deepEqual(portsB.log.frames, portsA.log.frames, '上屏帧也必须一致');
  assert.deepEqual(playerB.current, { clipId: 'hold', frameIndex: 0, frameId: 'sit_neutral' });
  assert.equal(clockB.pending, 0, '静止帧恢复后仍不许排程（排了就是 rAF 空转）');
  assert.equal(playerB.isPlaying, true, '恢复后仍在播放（不是"播完了"）');
});

test('D-03 反向守护：自然播完仍必须上报恰好一次（别把缺陷修成另一个缺陷）', () => {
  // 判据 2：不暂停的一次性片段，播完必须 onClipEnd 一次，且只一次
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(JUMP_ONCE, 0);
  clock.advance(130);
  clock.advance(130);
  assert.deepEqual(log.ends, ['once'], '自然播完必须上报一次');
  clock.advance(10000);
  assert.deepEqual(log.ends, ['once'], '收尾只许一次');
  assert.equal(clock.pending, 0);
});

test('D-03 反向守护：多帧片段中途 pause/resume，帧序不跳不重复', () => {
  // 判据 3：多帧片段（每帧 110ms）在第 2 帧中途暂停 40ms 再恢复
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(WALK_CYCLE, 0);
  assert.deepEqual(log.frames, ['l1']);
  clock.advance(110);
  assert.deepEqual(log.frames, ['l1', 'l2'], '推进到第 2 帧');
  clock.advance(40); // 第 2 帧已过 40ms（剩余 70ms）
  player.pause();
  clock.advance(9999); // 暂停期间时间飞逝，不许推进
  assert.deepEqual(log.frames, ['l1', 'l2'], '暂停期间不许换帧');
  player.resume();
  clock.advance(69);
  assert.deepEqual(log.frames, ['l1', 'l2'], '剩余 70ms 未走完前不许换帧');
  clock.advance(1);
  assert.deepEqual(log.frames, ['l1', 'l2', 'l3'], '恢复后必须从第 3 帧继续，不跳帧');
  clock.advance(110);
  assert.deepEqual(log.frames, ['l1', 'l2', 'l3', 'l1'], '循环照常回环，不重复');
  assert.deepEqual(log.ends, [], '循环片段永不上报收尾');
});

test('D-03 边界：整帧在暂停期间走完 ⇒ 从当前帧重开一个完整时长，不推进索引', () => {
  // pause() 里 remaining = max(0, remaining − elapsed)：若 elapsed 已经吃掉整帧，
  // remaining 归零。此时**不许 advance()**（那会让手势吃掉一帧），而是重开当前帧计时。
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  player.play(WALK_CYCLE, 0);
  clock.advance(109); // 第 1 帧还没走完（剩 1ms）
  player.pause();
  clock.advance(1); // 恰好把剩余 1ms 耗光 ⇒ remaining = 0
  assert.deepEqual(log.frames, ['l1'], '暂停期间不许换帧');
  player.resume();
  assert.deepEqual(log.frames, ['l1'], '恢复不许先推一帧');
  assert.equal(player.current?.frameIndex, 0, '索引必须仍是第 1 帧');
  clock.advance(110);
  assert.deepEqual(log.frames, ['l1', 'l2'], '重开一个完整 frameMs 后才推进');
});

test('seek 与"按起始时间轴起播"：跨批切朝向时对齐相位', () => {
  const clock = new FakeClock();
  const { ports, log } = makePorts(clock);
  const player = new PosePlayer(ports);
  // 循环片段按周期取模：220ms 落在第 3 帧（110+110）
  player.play(WALK_CYCLE, 220);
  assert.deepEqual(log.frames, ['l3'], 'startAtMs=220 应落在第 3 帧');
  player.seek(1);
  assert.deepEqual(log.frames, ['l3', 'l2'], 'seek 应立即上屏目标帧');
  // 越界夹取
  player.seek(99);
  assert.equal(player.current?.frameIndex, 2);
  player.seek(-5);
  assert.equal(player.current?.frameIndex, 0);
  // stop 之后 current 为 null
  player.stop();
  assert.equal(player.current, null);
  assert.equal(clock.pending, 0);
});

test('G-01：真实 pet.css 精确匹配三条互斥规则（display:none，不是 opacity）', () => {
  const problems = poseVisibilityProblems(PET_CSS);
  assert.deepEqual(problems, [], `pet.css 不满足互斥契约：\n${problems.join('\n')}`);
  const matched = matchPoseVisibility(PET_CSS);
  assert.deepEqual(matched.nonStandHides, ['pet-action', 'pet-layers'], '非站姿必须同时藏动作宿主与层栈');
  assert.deepEqual(matched.standHides, ['pet-pose'], '站姿必须藏姿态层');
  assert.ok(matched.rootPrefixedRules >= 1, '必须存在 #pet-root 前缀规则（防空集通过）');
  assert.deepEqual(matched.opacityHides, [], '不许用 opacity 藏层');
});

test('G-01 变异：删掉任一条互斥规则、或把 display:none 换成 opacity:0 ⇒ 必须红', () => {
  const withoutAction = PET_CSS.replace(/#pet-root:not\(\[data-posture='stand'\]\) \.pet-action,\r?\n/, '');
  assert.notEqual(withoutAction.length, PET_CSS.length, '变异没生效（找不到 .pet-action 那条规则）');
  assert.ok(
    poseVisibilityProblems(withoutAction).some((line) => line.includes('pet-action')),
    '删掉 .pet-action 规则却仍然绿：G-01 失效',
  );

  const withoutPose = PET_CSS.replace(/#pet-root\[data-posture='stand'\] \.pet-pose \{\r?\n {2}display: none;\r?\n\}/, '');
  assert.notEqual(withoutPose.length, PET_CSS.length, '变异没生效（找不到 .pet-pose 站姿规则）');
  assert.ok(
    poseVisibilityProblems(withoutPose).some((line) => line.includes('pet-pose')),
    '删掉站姿 .pet-pose 规则却仍然绿：G-01 失效',
  );

  const opacityInstead = PET_CSS.replace(
    /#pet-root:not\(\[data-posture='stand'\]\) \.pet-action,\r?\n#pet-root:not\(\[data-posture='stand'\]\) \.pet-layers \{\r?\n {2}display: none;\r?\n\}/,
    "#pet-root:not([data-posture='stand']) .pet-layers {\n  opacity: 0;\n}",
  );
  assert.notEqual(opacityInstead.length, PET_CSS.length, '变异没生效（找不到层栈互斥规则）');
  const opacityProblems = poseVisibilityProblems(opacityInstead);
  assert.ok(
    opacityProblems.some((line) => line.includes('opacity')),
    `换成 opacity:0 没被点名：\n${opacityProblems.join('\n')}`,
  );
  assert.ok(
    opacityProblems.some((line) => line.includes('pet-action')),
    '换成 opacity:0 之后 pet-action 的规则也没了，但没报：G-01 漏判',
  );

  // 反向对照：把选择器改名（`data-posture` → `data-pose`）必须红，而不是"匹配到 0 条就算过"
  const renamed = PET_CSS.replace(/data-posture/g, 'data-pose');
  assert.ok(
    poseVisibilityProblems(renamed).length > 0,
    '属性改名后仍然绿：说明判据是"找到就行"而不是"精确匹配"',
  );
});

test('B-2：裸 .pet-pose 基规则必须自带 display:none（"data-posture 未设置"第三态兜底）', () => {
  // 前三条 G-01 断言只认 `#pet-root…[data-posture…]` 前缀规则，覆盖 stand 与非 stand 两态。
  // 第三态（DOM 刚建好、`writePosture()` 还没调）只有裸 `.pet-pose` 基规则在管：
  // 缺了它，首帧姿态层会按 `position: absolute` 铺满整窗盖住立绘（QA 盲区 B-2）。
  const matched = matchPoseVisibility(PET_CSS);
  assert.equal(matched.bareBaseRuleHides, true, '.pet-pose 基规则必须含 display:none');
  assert.deepEqual(poseVisibilityProblems(PET_CSS), [], '真实 pet.css 必须满足含第三态在内的全部契约');

  // 变异点：只删掉**基规则**里那一行 `display: none;`（两态规则原样保留）⇒ 必须红
  // 用非全局 replace：文件里第一处 `.pet-pose {` 就是基规则（前面只有注释提到它）
  const withoutBaseHide = PET_CSS.replace(/(\.pet-pose\s*\{[^}]*?)\n {2}display: none;/, '$1');
  assert.notEqual(withoutBaseHide.length, PET_CSS.length, '变异没生效（找不到基规则的 display:none）');
  const mutated = matchPoseVisibility(withoutBaseHide);
  assert.equal(mutated.bareBaseRuleHides, false, '删掉后必须识别为"第三态无兜底"');
  // 两态规则仍在 ⇒ 证明这条判据不是靠"反正有别的规则"混过去的
  assert.deepEqual(mutated.standHides, ['pet-pose'], '站姿规则不该被这次变异影响（区分开才说明判据独立）');
  const problems = poseVisibilityProblems(withoutBaseHide);
  assert.ok(problems.length > 0, '删掉基规则默认隐藏却仍然绿：B-2 守卫失效');
  assert.ok(
    problems.some((line) => line.includes('基规则') || line.includes('第三态')),
    `报错必须点明缺的是"基规则 / 第三态兜底"，实际：\n${problems.join('\n')}`,
  );
});

/**
 * 造一份**多帧**的清单副本：把 sit 的 hold 换成 3 帧 80ms 的片段。/**
 * 造一份**多帧**的清单副本：把 sit 的 hold 换成 3 帧 80ms 的片段。
 *
 * <p>真实清单（切片 1）只有单帧，但 G-03 的判据是"换帧只改 src"，
 * 必须有换帧才能证伪"每帧新建元素"。副本只改 frames/clips，其余字段与真实清单一致，
 * 所以 `isPlayable` / `batchOf` / `frameOf` 走的都是生产路径。</p>
 *
 * @returns 多帧清单
 */
function multiFramePoses(): PetPoses {
  const clone = JSON.parse(JSON.stringify(PET_POSES)) as PetPoses;
  const batch = clone.batches.sit;
  assert.ok(batch, '真实清单里必须有 sit 批次（切片 1 已导出）');
  const base = batch.frames.sit_neutral;
  assert.ok(base, '真实清单里必须有 sit_neutral 帧');
  const frames: Record<string, typeof base> = {};
  for (const id of ['sit_a', 'sit_b', 'sit_c']) {
    // 每帧给一个**不同的 URL**（真实多帧批本来就不同图）；否则"换帧只改 src"这条断言
    // 会因为三帧同一个 src 而失去鉴别力
    frames[id] = {
      ...base,
      id,
      files: {
        '1x': { ...base.files['1x'], url: `lxa://pet-poses/sit/${id}@1x.webp` },
        '2x': { ...base.files['2x'], url: `lxa://pet-poses/sit/${id}@2x.webp` },
      },
    };
  }
  const mutable = clone as unknown as {
    batches: Record<string, { frames: Record<string, unknown>; clips: readonly PoseClip[] }>;
  };
  mutable.batches.sit.frames = frames;
  mutable.batches.sit.clips = [
    { id: 'hold', facing: -1, frames: ['sit_a', 'sit_b', 'sit_c'], loop: true, frameMs: [80, 80, 80] },
  ];
  return clone;
}

/**
 * 造一个控制器（含 2 个既有 `.pet-art-frame` 的宿主，模拟双缓冲）。
 *
 * @param options 覆盖项
 * @returns 控制器 + 观测量
 */
function makeController(options: {
  readonly poses?: PetPoses;
  readonly boxOf?: (() => PoseBox | null) | null;
  readonly blink?: PoseBlinkLike;
  readonly density?: Density;
} = {}): {
  controller: PoseController;
  clock: FakeClock;
  root: FakeElement;
  host: FakeElement;
  frames: string[];
  blink: FakeBlink;
} {
  const clock = new FakeClock();
  const doc = new FakeDocument();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  // 双缓冲的两张压平帧（G-03 的金丝雀：宿主里本来就有 2 个 img 风格的帧元素）
  host.appendChild(new FakeElement('img'));
  host.appendChild(new FakeElement('img'));
  const frames: string[] = [];
  const blink = options.blink instanceof FakeBlink ? options.blink : new FakeBlink();
  const controller = new PoseController({
    doc,
    root,
    host,
    poses: options.poses ?? PET_POSES,
    density: options.density ?? '2x',
    ports: {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      onFrame: (frameId) => {
        frames.push(frameId);
      },
      onClipEnd: () => {},
    },
    boxOf: options.boxOf === undefined ? () => ({ left: 20.87, top: 96, width: 156, height: 234 }) : options.boxOf,
    blink,
    log: () => {},
  });
  return { controller, clock, root, host, frames, blink };
}

/** 假眨眼驱动（记录 stop/start 次数）。 */
class FakeBlink implements PoseBlinkLike {
  /** 是否在跑。 */
  private running = true;

  /** stop 次数。 */
  stops = 0;

  /** start 次数。 */
  starts = 0;

  /** {@inheritDoc PoseBlinkLike.isRunning} */
  get isRunning(): boolean {
    return this.running;
  }

  /** 停掉。 */
  stop = (): void => {
    this.stops += 1;
    this.running = false;
  };

  /** 启动。 */
  start = (): void => {
    this.starts += 1;
    this.running = true;
  };
}

test('G-02：pose 态眨眼被停掉，回站姿重启（金丝雀：构造时确实在跑）', () => {
  const blink = new FakeBlink();
  const { controller, root } = makeController({ blink });
  assert.equal(blink.isRunning, true, '金丝雀失败：眨眼本来就没跑，下面"pose 态没跑"就没有证明力');
  assert.equal(blink.stops, 0);

  controller.setPosture('sit');
  assert.equal(blink.isRunning, false, 'pose 态必须停眨眼（脸层与姿态帧会双份眼睛）');
  assert.equal(blink.stops, 1);
  assert.equal(root.getAttribute('data-posture'), 'sit');

  controller.setPosture('stand');
  assert.equal(blink.isRunning, true, '回站姿必须重启眨眼');
  assert.ok(blink.starts >= 1);
  assert.equal(root.getAttribute('data-posture'), 'stand');
});

test('G-03：pose 层 <img> 恒为 1，换帧只改 src；宿主原有 2 张压平帧不受影响', () => {
  const { controller, host, clock } = makeController({ poses: multiFramePoses() });
  /** 数宿主里的 `<img>`（= 压平帧的双缓冲，与姿态层无关）。 */
  const artFrameCount = (): number => host.children.filter((child) => child.tagName === 'img').length;
  // 金丝雀：构造之前宿主就有 2 个帧元素（双缓冲），"数到 1"不是"元素都没建"
  assert.equal(artFrameCount(), 2, '宿主应保持 2 个压平帧（双缓冲）');
  assert.equal(host.children.length, 3, '宿主 = 2 张压平帧 + 1 个 .pet-pose 层');

  controller.setPosture('sit');
  assert.equal(controller.poseImageCount, 1, 'pose 层必须只有 1 个 img');

  const firstSrc = controller.imageElement.src;
  assert.ok(firstSrc.length > 0, '首帧应该有 src');
  clock.advance(80);
  clock.advance(80);
  assert.notEqual(controller.imageElement.src, firstSrc, '换帧必须改 src');
  assert.equal(controller.poseImageCount, 1, '换帧不许新建 img（新建 = 双影）');
  assert.equal(artFrameCount(), 2, '换帧不许动压平帧');
  assert.equal(host.children.length, 3, '换帧不许往宿主里加节点');
});

test('姿态盒只由 boxOf 写入（单一位置写入者的地基），不注入则不写', () => {
  const { controller } = makeController();
  controller.setPosture('sit');
  const styleProps = (controller.layerElement as unknown as FakeElement).styleProps;
  assert.equal(styleProps.get('left'), '20.87px');
  assert.equal(styleProps.get('top'), '96px');
  assert.equal(styleProps.get('width'), '156px');
  assert.equal(styleProps.get('height'), '234px');

  // 不注入 boxOf：一个样式都不许写（宁可不定位，也不许自己瞎算）
  const noBox = makeController({ boxOf: null });
  noBox.controller.setPosture('sit');
  const noneProps = (noBox.controller.layerElement as unknown as FakeElement).styleProps;
  assert.equal(noneProps.size, 0, `没注入 boxOf 却写了样式：${[...noneProps.keys()].join(',')}`);

  // 算不出盒（null）时保持上一帧位置，不写半套值
  const nullBox = makeController({ boxOf: () => null });
  nullBox.controller.setPosture('sit');
  assert.equal((nullBox.controller.layerElement as unknown as FakeElement).styleProps.size, 0);
});

test('不可播的姿态优雅回落站姿（没有资产不能变成空白窗口）', () => {
  const { controller, root, frames } = makeController();
  // walk 在切片 1 未导出 ⇒ 不在 accepted ⇒ 不可播
  controller.setPosture('walk');
  assert.equal(controller.posture, 'stand', '不可播姿态必须回落到站姿');
  assert.equal(root.getAttribute('data-posture'), 'stand');
  assert.deepEqual(frames, [], '不可播姿态一帧都不该上屏');

  // sit 可播：正例（否则上面的断言可能是"什么都不工作"）
  controller.setPosture('sit');
  assert.equal(controller.posture, 'sit');
  assert.equal(frames.length, 1);
});

test('切姿态用当前密度档的 URL（DPR 只决定选哪一档，不参与对齐）', () => {
  const oneX = makeController({ density: '1x' });
  oneX.controller.setPosture('sit');
  const oneXUrl = oneX.controller.imageElement.src;
  const twoX = makeController({ density: '2x' });
  twoX.controller.setPosture('sit');
  const twoXUrl = twoX.controller.imageElement.src;
  assert.match(oneXUrl, /@1x\.webp$/, `1x 档应选 @1x 文件，实际 ${oneXUrl}`);
  assert.match(twoXUrl, /@2x\.webp$/, `2x 档应选 @2x 文件，实际 ${twoXUrl}`);
  assert.notEqual(oneXUrl, twoXUrl);
});
