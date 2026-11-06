/**
 * 姿态入口单测：`sit` 从"真实可达"到"能被任意交互打断"的整条行为链。
 *
 * <p><b>为什么这条链必须用假时钟精确测：</b>切片 1 唯一的用户可见新增是
 * "静置 20s 坐下"。它有三类只能靠 1ms 精度才能抓住的缺陷：</p>
 * <ol>
 *   <li><b>顺序错</b>：`sit`(20s) 排在 `sleepy`(60s) / `sleeping`(90s) 之前，
 *       会把困倦与睡眠两档全吃掉——用户再也看不到 60s 犯困、90s 睡着；</li>
 *   <li><b>计时起点错</b>：从"构造时刻"起算而不是"最近一次互动"起算，
 *       于是拖完一次就立刻坐下（用户读成"松手就瘫了"）；</li>
 *   <li><b>打断不了</b>：`sit` 没有 TTL（它不自己过期），退出只能靠交互或更高档状态，
 *       所以"点一下必须立刻回 stand"是它唯一的下车通道。</li>
 * </ol>
 *
 * <p>同时逐条钉住三条<b>既有行为不许退化</b>的兼容点（89999/90000ms、连点 3 次生气、
 * 无 `sleep` 资产时 sleeping 的指令逐项不变），因为本改动的最大风险不是新功能不工作，
 * 而是旧功能被别人以为"顺手改一下更好"。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MULTI_TAP_THRESHOLD,
  PetBehaviorStateMachine,
  PET_SHOW_MS,
  SIT_AFTER_IDLE_MS,
  SLEEPY_AFTER_IDLE_MS,
  SLEEP_AFTER_IDLE_MS,
  postureOf,
  type PetBehaviorState,
} from '../src/pet/behavior/state-machine';
import { PET_POSES, isFacingSensitive } from '../src/pet/poses/manifest';
import { PoseController, type PoseBlinkLike } from '../src/pet/poses/controller';
import { POSTURE_IDS, type PetPoses, type PosePostureId, type PostureId } from '../src/pet/poses/types';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';

/** 可控时钟（状态机只认注入的 `now()`）。 */
class Clock {
  /** 虚拟时间（毫秒）。 */
  time = 0;

  /** 读时间。 */
  now = (): number => this.time;

  /**
   * 推进时间。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
  }
}

/**
 * 建一个抖动为 0 的状态机（`rng` 固定 0.5）。
 *
 * @param clock 时钟
 * @returns 状态机
 */
function machine(clock: Clock): PetBehaviorStateMachine {
  return new PetBehaviorStateMachine({ now: clock.now, rng: () => 0.5 });
}

/** 假眨眼驱动（记录 start/stop 次数）。 */
class FakeBlink implements PoseBlinkLike {
  /** 是否在跑。 */
  private running = true;

  /** `stop()` 被调用次数。 */
  stops = 0;

  /** `start()` 被调用次数。 */
  starts = 0;

  /** 是否在跑（`PoseBlinkLike` 的只读面）。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 停。 */
  stop(): void {
    this.stops += 1;
    this.running = false;
  }

  /** 启。 */
  start(): void {
    this.starts += 1;
    this.running = true;
  }
}

/** 极简假元素（控制器只用到这几个成员）。 */
class FakeElement implements ElementLike {
  /** 标签名（`poseImageCount` 靠它数 `<img>`）。 */
  readonly tagName: string;

  /** `data-*` 写入面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** 属性写入面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面（控制器只写 left/top/width/height）。 */
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

  /** 文本内容。 */
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
 * 造一个控制器 + 假眨眼驱动（端口用不到定时器：`sit` 是单帧 hold）。
 *
 * @param clock 时钟
 * @returns 控制器与眨眼驱动
 */
function makeController(clock: Clock): { controller: PoseController; blink: FakeBlink; root: FakeElement } {
  const root = new FakeElement();
  const host = new FakeElement();
  const blink = new FakeBlink();
  const controller = new PoseController({
    doc: new FakeDocument(),
    root,
    host,
    poses: PET_POSES,
    density: '1x',
    ports: {
      now: clock.now,
      schedule: () => 0,
      cancel: () => {},
      onFrame: () => {},
      onClipEnd: () => {},
    },
    boxOf: null,
    blink,
  });
  return { controller, blink, root };
}

/**
 * 造一份"把某个姿态批次整个摘掉"的假清单。
 *
 * <p><b>为什么需要它：</b>切片 2 把 `walk`/`run`/`jump`、切片 3 把 `lie`/`sleep` 翻进 `accepted`
 * 之后，真清单里六批都能播了，于是"没有资产 ⇒ 降级 stand"这条路径在真数据上**不再可达**。
 * 直接删掉那段覆盖等于放行"将来某批资产丢了会变成空白窗口"。
 * 所以用合成清单继续守住它：摘掉批次 + 从 `accepted` 移除 ⇒ 必须降级 stand。</p>
 *
 * @param posture 要摘掉的姿态
 * @returns 假清单
 */
function posesWithout(posture: PosePostureId): PetPoses {
  assert.ok(PET_POSES.batches[posture], `真实清单里必须有 ${posture} 批次（否则本用例无意义）`);
  const batches = { ...PET_POSES.batches };
  delete batches[posture];
  return {
    ...PET_POSES,
    batches,
    accepted: PET_POSES.accepted.filter((item) => item !== posture),
  };
}

test('SIT_AFTER_IDLE_MS 边界：19999ms 仍站着，20000ms 恰好坐下（且姿态不下发 PresentationOp）', () => {
  const clock = new Clock();
  const sm = machine(clock);

  clock.advance(SIT_AFTER_IDLE_MS - 1);
  assert.deepEqual(sm.tick(), [], '19999ms 不该产生任何指令');
  assert.equal(sm.state, 'idle', '19999ms 还不该坐下');
  assert.equal(postureOf(sm.state, PET_POSES), 'stand');

  clock.advance(1);
  const ops = sm.tick();
  assert.equal(sm.state, 'sit', '20000ms 必须恰好坐下');
  // 姿态走独立通道（PostureId → PoseController.setPosture），不进表现层总线
  assert.deepEqual(ops, [], '坐姿是姿态不是动作：不许产出 PresentationOp');
  assert.equal(postureOf(sm.state, PET_POSES), 'sit');
});

test('sit 入口真实可达：拖拽松手后重新计时，满 20s 才坐下', () => {
  const clock = new Clock();
  const sm = machine(clock);
  // 拖着不放 30s：全程不坐（拖拽期间 tick 直接返回）
  sm.handle('drag-start');
  clock.advance(30000);
  assert.deepEqual(sm.tick(), []);
  assert.equal(sm.state, 'drag');

  sm.handle('drag-end');
  clock.advance(250); // 桥接 idle 落地
  sm.tick();
  assert.equal(sm.state, 'idle');

  clock.advance(SIT_AFTER_IDLE_MS - 1);
  sm.tick();
  assert.equal(sm.state, 'idle', '松手后 19999ms 不该坐（计时起点必须是松手时刻）');

  clock.advance(1);
  sm.tick();
  assert.equal(sm.state, 'sit');
});

test('点击立刻回 stand：sit 无 TTL，点击是它唯一的下车通道（blink 同步重启）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const { controller, blink } = makeController(clock);

  clock.advance(SIT_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.state, 'sit');

  // 站姿 → 坐姿：画面切到 pose 层、眨眼停掉
  controller.setPosture(postureOf(sm.state, PET_POSES));
  assert.equal(controller.posture, 'sit');
  assert.equal(blink.isRunning, false, '姿态态必须停眨眼（G-02）');
  assert.equal(controller.poseImageCount, 1, '姿态层恒有 1 张 <img>（G-03）');

  const ops = sm.handle('tap');
  assert.equal(sm.state, 'tap');
  assert.equal(postureOf(sm.state, PET_POSES), 'stand', '点击后必须立刻派生回站姿');
  assert.ok(ops.some((op) => op.kind === 'motion' && op.id === 'tap'), '点击仍要下发 tap 动作');

  controller.setPosture(postureOf(sm.state, PET_POSES));
  assert.equal(controller.posture, 'stand');
  assert.equal(blink.isRunning, true, '回站姿必须重启眨眼');
});

test('拖拽期间暂停播放且姿态保持不变，松手后才重算（drag 本身派生 stand）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const { controller, blink } = makeController(clock);

  clock.advance(SIT_AFTER_IDLE_MS);
  sm.tick();
  controller.setPosture('sit');
  assert.equal(controller.isPlaying, true);
  assert.equal(blink.isRunning, false);

  sm.handle('drag-start');
  // 主循环（main.ts 的 syncPosture）在 drag 态只 pause，不 setPosture
  controller.pause();
  assert.equal(controller.isPlaying, true, '暂停不是停止：片段还在');
  assert.equal(controller.posture, 'sit', '拖拽期间姿态必须保持住（画面不许切回站姿）');
  assert.equal(postureOf(sm.state, PET_POSES), 'stand', 'drag 派生的纯函数结果仍是 stand（保持由调用方负责）');

  sm.handle('drag-end');
  controller.resume();
  assert.equal(controller.posture, 'sit', '松手到下一拍重算之间，姿态不能闪回站姿');
  controller.setPosture(postureOf(sm.state, PET_POSES));
  assert.equal(controller.posture, 'stand');
  assert.equal(blink.isRunning, true);
});

test('sleeping 抢占一切姿态：坐着也会在 60s 犯困、90s 睡着', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SIT_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.state, 'sit');

  clock.advance(SLEEPY_AFTER_IDLE_MS - SIT_AFTER_IDLE_MS - 1);
  assert.deepEqual(sm.tick(), [], 'sit 驻留态自己不该再下发指令');
  assert.equal(sm.state, 'sit', `${SLEEPY_AFTER_IDLE_MS - 1}ms 还没到困倦`);

  clock.advance(1);
  sm.tick();
  assert.equal(sm.state, 'sleepy', '坐满 60s 必须升级到困倦（否则睡眠两档被吃掉）');

  clock.advance(SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.state, 'sleeping');
  assert.equal(sm.sustainedMotion, 'sleepy');
});

test('兼容点 ①：89999 / 90000ms 入睡边界逐值不变', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  assert.ok(sm.tick().length > 0, '60s 必须下发困倦指令');
  assert.equal(sm.state, 'sleepy');

  clock.advance(SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS - 1);
  assert.deepEqual(sm.tick(), []);
  assert.equal(sm.state, 'sleepy', '89999ms 仍在困倦（不能提前睡）');

  clock.advance(1);
  assert.ok(sm.tick().length > 0, '90000ms 必须入睡');
  assert.equal(sm.state, 'sleeping');
});

test('兼容点 ②：身体连点 3 次仍然生气（sit 的加入没有吃掉连点规则）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  for (let index = 0; index < MULTI_TAP_THRESHOLD; index += 1) {
    sm.handle('tap', { profile: 'body', holdMs: 0 });
    clock.advance(100); // 相邻间隔远小于连点窗口
  }
  assert.equal(sm.state, 'angry');
  assert.equal(postureOf(sm.state, PET_POSES), 'stand', '生气是动作，不改姿态');
});

test('兼容点 ③：无 sleep 资产时 sleeping 的指令与姿态逐项不变', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  sm.tick();
  clock.advance(SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS);
  const ops = sm.tick();

  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.id, 'sleepy', '睡眠动作仍是 sleepy 循环');
  assert.equal(motion?.loop, true);
  assert.equal(motion?.durationMs, undefined, '睡眠动作不带 TTL');
  assert.equal(motion?.priority, 0);
  assert.equal(expression?.id, 'blink', '睡眠表情仍是闭眼贴片（不是困倦的半闭眼）');
  assert.equal(expression?.layer, 'base');
  assert.equal(expression?.durationMs, undefined);
  // 切片 3 起 sleep 已 accepted ⇒ 真清单会切 sleep；"没资产就降级"这条路径改用合成清单守
  // （`posesWithout('sleep')`），否则它会因为真数据补齐而**静默失效**——那正是"资产丢了变空白窗口"的入口。
  assert.equal(postureOf('sleeping', PET_POSES), 'sleep', '切片 3 起睡眠有自己的姿态资产');
  assert.equal(postureOf('sleeping', posesWithout('sleep')), 'stand', '没有 sleep 资产时必须降级 stand');
});

test('六批全部 accepted 时每个姿态态都返回自己；摘掉任一批次都降级 stand（降级判据不是硬编码）', () => {
  // 真清单：六批全 accepted ⇒ sleep 也返回自己（切片 3 前这里只能断言 stand）
  assert.equal(postureOf('sleeping', PET_POSES), 'sleep');
  assert.equal(postureOf('sleeping', posesWithout('sleep')), 'stand', '摘掉 sleep 批次必须降级');
  // 切片 2 起 sit/walk/run/jump 已登记：真数据下它们必须返回**自己**（不是 stand）
  for (const posture of POSTURE_IDS) {
    if (posture === 'stand') continue;
    // 姿态 id → 行为状态名（唯一例外：姿态 `sleep` 对应的状态叫 `sleeping`）
    const state = (posture === 'sleep' ? 'sleeping' : posture) as PetBehaviorState;
    // 真清单：accepted 决定可播性（未 accepted 的一律 stand，不许空白窗口）
    const expected = PET_POSES.accepted.includes(posture) ? posture : 'stand';
    assert.equal(
      postureOf(state, PET_POSES),
      expected,
      `${posture}（状态 ${state}）在真清单下应派生为 ${expected}（accepted 决定可播性）`,
    );
    // 摘掉批次 ⇒ 必须降级 stand（真清单六批都在，所以每一批都能被这条守住）
    if (PET_POSES.batches[posture]) {
      assert.equal(
        postureOf(state, posesWithout(posture as PosePostureId)),
        'stand',
        `${posture} 摘掉批次后必须降级为 stand（否则"资产丢了"会表现成空白窗口）`,
      );
    } else {
      assert.fail(`真清单里缺 ${posture} 批次：切片 3 之后六批必须都在`);
    }
  }
});

test('postureOf 对全部状态都有定义，且只有姿态态才返回非 stand', () => {
  const states: readonly PetBehaviorState[] = [
    'idle',
    'tap',
    'angry',
    'sleepy',
    'sleeping',
    'wake',
    'drag',
    'pet',
    'sit',
    'lie',
    'walk',
    'run',
    'jump',
  ];
  // 切片 3 起六批全部 accepted ⇒ 六个姿态态都返回自己
  const expected: Record<PetBehaviorState, PostureId> = {
    idle: 'stand',
    tap: 'stand',
    angry: 'stand',
    sleepy: 'stand',
    sleeping: 'sleep',
    wake: 'stand',
    drag: 'stand',
    pet: 'stand',
    sit: 'sit',
    lie: 'lie',
    walk: 'walk',
    run: 'run',
    jump: 'jump',
  };
  for (const state of states) {
    assert.equal(postureOf(state, PET_POSES), expected[state], `状态 ${state} 派生的姿态不对`);
  }
  // 反向守卫：期望表与清单的 accepted 必须一致（将来再翻一批而忘了改这张表，这里会红）
  const postureStates = states.filter((state) => state !== 'idle' && state !== 'tap' && state !== 'angry'
    && state !== 'sleepy' && state !== 'sleeping' && state !== 'wake' && state !== 'drag' && state !== 'pet');
  for (const state of postureStates) {
    const derived = expected[state];
    if (derived === 'stand') {
      assert.equal(PET_POSES.accepted.includes(state as PostureId), false, `${state} 已 accepted，本表却写 stand`);
    } else {
      assert.equal(PET_POSES.accepted.includes(state as PostureId), true, `${state} 未 accepted，本表却写 ${derived}`);
    }
  }
});

test('postureOf 的朝向语义：只有朝向敏感批次才按朝向过滤，单朝向静态批忽略 facing', () => {
  // 单朝向静态批（sit/lie/sleep）：全仓只有 `facing:-1` 一条片段 ⇒ **忽略** facing 参数。
  // 若这里无条件透传 facing，`postureOf('sit', poses, 1)` 就变 false ⇒ 光标一移到右边，
  // 猫连坐都不坐、也不趴（设计 §4.3 裁决Ⅰ）。
  for (const posture of ['sit', 'lie', 'sleep'] as const) {
    const state = (posture === 'sleep' ? 'sleeping' : posture) as PetBehaviorState;
    assert.equal(isFacingSensitive(PET_POSES, posture), false, `${posture} 是单朝向批`);
    assert.equal(postureOf(state, PET_POSES), posture, '缺省（不给朝向）语义必须与旧实现一致');
    assert.equal(postureOf(state, PET_POSES, -1), posture);
    assert.equal(
      postureOf(state, PET_POSES, 1),
      posture,
      `${posture} 是单朝向批 ⇒ 右向也用左向那条原样播（绝不降级、绝不镜像）`,
    );
  }

  // 朝向敏感批：walk/run/jump 左右各一条 ⇒ 两个朝向都能播
  for (const posture of ['walk', 'run', 'jump'] as const) {
    assert.equal(isFacingSensitive(PET_POSES, posture), true, `${posture} 有左右两条片段`);
    assert.equal(postureOf(posture, PET_POSES, -1), posture);
    assert.equal(postureOf(posture, PET_POSES, 1), posture);
  }

  // 合成：朝向敏感批里**右向片段帧不齐** ⇒ 右向必须降级，左向不受影响（证明判据真的按 facing 过滤）。
  // 这里刻意不用"把右向 clip 整条删掉"来造场景：删掉之后批次只剩一个朝向、按定义变成单朝向批，
  // 回退规则就会生效（那是设计 §4.3 落地项 2 的可判定前提，不是判据失效）。
  const walk = PET_POSES.batches.walk;
  assert.ok(walk, '真实清单里必须有 walk 批次');
  const brokenRight: PetPoses = {
    ...PET_POSES,
    batches: {
      ...PET_POSES.batches,
      walk: {
        ...walk,
        clips: walk.clips.map((clip) => (clip.facing === 1 ? { ...clip, frames: ['不存在的帧'] } : clip)),
      },
    },
  };
  assert.equal(postureOf('walk', brokenRight, 1), 'stand', '右向片段帧不齐 ⇒ 右向必须降级 stand');
  assert.equal(postureOf('walk', brokenRight, -1), 'walk', '左向不受影响');
  assert.equal(postureOf('walk', brokenRight), 'walk', '缺省语义只看"有没有可播片段"');
});

test('restore 接受 sit（快照的 known 列表已扩到 5 个姿态态）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const before = sm.snapshot();
  assert.equal(sm.restore(before, 'test'), true);
  assert.equal(sm.state, 'idle');

  clock.advance(SIT_AFTER_IDLE_MS);
  sm.tick();
  const sitSnapshot = sm.snapshot();
  assert.equal(sitSnapshot.state, 'sit');
  clock.advance(1000);
  sm.handle('tap');
  assert.equal(sm.state, 'tap');
  assert.equal(sm.restore(sitSnapshot, '回滚到坐姿'), true, 'sit 必须在 known 列表里');
  assert.equal(sm.state, 'sit');
});

test('PET_SHOW_MS 等既有时长常量未被改动（守卫：改阈值必须显式改这条）', () => {
  // 这些数值是既有验收口径的一部分，改它们会让"90s 睡""480ms 点击"整套断言失衡
  assert.equal(PET_SHOW_MS, 900);
  assert.equal(SIT_AFTER_IDLE_MS, 20000);
  assert.equal(SLEEPY_AFTER_IDLE_MS, 60000);
  assert.equal(SLEEP_AFTER_IDLE_MS, 90000);
  assert.equal(MULTI_TAP_THRESHOLD, 3);
});
