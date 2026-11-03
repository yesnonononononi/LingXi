/**
 * 桌宠行为状态机（纯逻辑，不碰 DOM、不碰定时器）。
 *
 * <p><b>为什么单独一层：</b>"点一下该开心、连点三下该生气、久不动该睡"是<b>业务规则</b>，
 * 与"怎么画"无关。把它塞进渲染入口就只能靠人点着测；抽成纯类之后，每条转移都是
 * 一次同步函数调用，边界（89999 / 90000ms、2 次 / 3 次）能精确断言。</p>
 *
 * <p><b>产出物是表现层指令（{@link PresentationOp}），不是 DOM 操作：</b>状态机只回答
 * "现在该下发什么"，具体怎么写 CSS/贴片由 {@link PetPresentation} 决定。于是换 Live2D
 * 时本文件一行不用改。</p>
 *
 * <p><b>时间与随机必须注入：</b>内部<b>禁止</b>直接读 `Date.now()` / `Math.random()`，
 * 否则测试只能靠 sleep 等待、靠统计猜随机，等于没测。</p>
 *
 * <p><b>为什么"回 idle"要分两步：</b>调度总线有一条硬规则——低优先级指令遇到
 * "不会到期的活动指令"（`remainingMs === null`）会直接拒绝。拖拽动作是无限循环、
 * 优先级 2，如果拖完直接下发优先级 0 的 idle 会被拒掉，桌宠就卡在拖拽姿势。
 * 所以从拖拽回 idle 时先下发一条<b>带 250ms TTL 的桥接 idle</b>，等高优先级记录自然过期，
 * 再由 {@link PetBehaviorStateMachine.tick} 落到常驻 idle。</p>
 *
 * <p><b>动作有两档生命周期，别混用（M6-b 的 D-B3 就是混用造成的）：</b></p>
 * <ul>
 *   <li><b>一次性动作（oneshot）</b>：`tap` / `angry` / `wake` / 打哈欠 / 翻身。
 *       带 TTL，到点自然回 idle。它们的"多久"由 `pet-motions.json` 决定。</li>
 *   <li><b>状态型持续动作（sustained）</b>：`sleepy` 是唯一一档。语义是"<b>进入睡眠状态，
 *       直到被唤醒</b>"，所以它<b>进入状态时下发一次</b>、<b>不自己到期</b>、
 *       <b>由退出该状态的指令打断</b>（惊醒 = 优先级 2）。因此
 *       {@link PetBehaviorStateMachine.tick} 在持续态下<b>必须幂等</b>：每 250ms 再下发一次
 *       只会让 CSS 动画反复重启（或被总线的 80ms 判重丢弃），用户看到的就是"翻来覆去不睡"。</li>
 * </ul>
 * <p>目录里 `sleepy` 仍然是一次性动作（1600ms 一个循环），"持续"这层语义<b>只由本模块声明</b>
 * （下发 `loop: true` 且不带 TTL），表现层照 `op.loop` 编译成无限迭代——
 * 一次性动作的 TTL 语义因此一点没被削掉。</p>
 *
 * @module pet/behavior/state-machine
 */
import type { ExpressionId, MotionId, PresentationOp, Priority } from '../presentation/types';
import type { HitProfile } from './hit-profile';

/**
 * 行为状态。
 *
 * <p>M1 新增两档，语义都来自设计文档 §6 的触发入口表：</p>
 * <ul>
 *   <li>`sleepy`：**困倦**。无交互 {@link SLEEPY_AFTER_IDLE_MS}(60s) 进入，
 *       表现是 `sleepy` 表情 + `sleepy` 动作（循环），再闲 {@link SLEEP_AFTER_IDLE_MS}(90s) 才真睡。
 *       它与 `sleeping` 必须分开：困倦时仍然会眨眼（睡眠中眨眼被抑制）。</li>
 *   <li>`pet`：**被抚摸**。头部连点 2 次（间隔 &lt; {@link PET_DOUBLE_TAP_MS}）或
 *       头部按住 ≥ {@link PET_HOLD_MS} 进入，`shy` 表情 {@link PET_SHOW_MS} 后进 `pet-end`，
 *       回礼 `wink`（见 {@link WINK_MS}）。</li>
 * </ul>
 */
export type PetBehaviorState = 'idle' | 'tap' | 'angry' | 'sleepy' | 'sleeping' | 'wake' | 'drag' | 'pet';

/**
 * 外部驱动可直达的状态名。
 *
 * <p>比 {@link PetBehaviorState} 多一个 `happy`：它不是一个独立行为状态，
 * 而是"表情 happy + 一次性小弹"的组合，只在调试面板里需要一个直达按钮。</p>
 *
 * <p>`sleepy` / `pet` 没有加进来：它们的入口是**真实用户操作**（静置 60s / 摸头），
 * 而调试直达会让"真的能从界面触发"这条验收判据失去意义（§11.4 要求全部用真实输入验）。</p>
 */
export type PetBehaviorDebugState = PetBehaviorState | 'happy';

/** 调试面板按钮的顺序（真源在这里，调试后门与测试共用同一份）。 */
export const PET_BEHAVIOR_DEBUG_STATES: readonly PetBehaviorDebugState[] = [
  'idle',
  'tap',
  'happy',
  'angry',
  'sleeping',
  'wake',
  'drag',
];

/**
 * 判断一个值是否是合法的可直达状态名。
 *
 * @param value 待判断值（来自调试面板 / 调试后门，一律不可信）
 * @returns 是否合法
 */
export function isPetBehaviorDebugState(value: unknown): value is PetBehaviorDebugState {
  return typeof value === 'string' && (PET_BEHAVIOR_DEBUG_STATES as readonly string[]).includes(value);
}

/** 外部事件。 */
export type PetBehaviorEvent = 'tap' | 'drag-start' | 'drag-end' | 'pet-end';

/**
 * 一次点击的上下文（**判定结果由调用方算好再传进来**，行为层不做坐标运算）。
 *
 * <p>`profile` 来自 `behavior/hit-profile.ts` 的 `classifyProfile`（脸区矩形 + 外扩），
 * `holdMs` 是"按下到松开"的时长（毫秒）。两者都只在 `tap` 事件上有意义：
 * 抚摸语义（连点 2 次 / 按住 600ms）必须靠它们区分，而拖拽/惊醒与分区无关。</p>
 *
 * <p><b>缺省值 = 身体单击</b>：既有调用点（纯逻辑测试、纯浏览器排障）不传 ctx 时，
 * 行为与 M1 之前完全一致（单击 happy），不会因为"少传一个参数"变成摸头。</p>
 */
export interface TapContext {
  /** 命中分区。 */
  readonly profile: HitProfile;
  /** 按下到松开的时长（毫秒）；缺省 0 = 短按。 */
  readonly holdMs: number;
}

/** 默认点击上下文（身体 + 短按）。 */
export const DEFAULT_TAP_CONTEXT: TapContext = { profile: 'body', holdMs: 0 };

/** 点一下后回到 idle 的时长（毫秒），与 `MOTION_RECIPES.tap.motionMs` 同源。 */
export const TAP_HOLD_MS = 480;

/** 连点触发的生气持续时长（毫秒）。 */
export const ANGRY_HOLD_MS = 1200;

/** 惊醒后的过渡时长（毫秒）。 */
export const WAKE_HOLD_MS = 700;

/** 连点判定窗口（毫秒）：相邻两次点击间隔小于它才算"连点"。 */
export const MULTI_TAP_WINDOW_MS = 2000;

/** 连点阈值：窗口内累计到这个次数就生气。 */
export const MULTI_TAP_THRESHOLD = 3;

/** 无交互多久后进入睡眠（毫秒）。 */
export const SLEEP_AFTER_IDLE_MS = 90000;

/**
 * 无交互多久后先进入**困倦**（毫秒，M1 新增）。
 *
 * <p>设计文档 §6 的 E08：60s 犯困（表情 + 循环动作），再闲 30s（= 90s）才真睡。
 * 两档必须分开：困倦仍会眨眼，睡眠中眨眼被抑制——合成一档就会让"眨眼什么时候停"没有中间态。</p>
 */
export const SLEEPY_AFTER_IDLE_MS = 60000;

/** 困倦到真睡之间的间隔（毫秒）：`SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS`。 */
export const SLEEPY_TO_SLEEP_MS = SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS;

/** 抚摸的"按住"阈值（毫秒）：头部按住达到它就触发抚摸。 */
export const PET_HOLD_MS = 600;

/** 抚摸的"连点"窗口（毫秒）：头部两次点击的相邻间隔小于它才算连点。 */
export const PET_DOUBLE_TAP_MS = 1500;

/** 被抚摸时 `shy` 的持续时长（毫秒），到点后进 `pet-end` 回礼 wink。 */
export const PET_SHOW_MS = 900;

/** 回礼 wink 的时长（毫秒）。 */
export const WINK_MS = 600;

/**
 * 长拖拽阈值（毫秒）：拎这么久之后松手会"委屈"。
 */
export const SAD_DRAG_MS = 1200;

/** 委屈表情的持续时长（毫秒）。 */
export const SAD_HOLD_MS = 900;

/** 刚开始拖拽时"惊一下"的时长（毫秒，E03 的 drag-start 入口）。 */
export const DRAG_START_SURPRISED_MS = 600;

/** 从高优先级状态回 idle 时的桥接时长（毫秒），需大于一次 tick 间隔。 */
export const IDLE_BRIDGE_MS = 250;

/** 点一下的时长抖动（毫秒）：避免每次点击的节奏一模一样。 */
export const TAP_HOLD_JITTER_MS = 60;

/** 生气的时长抖动（毫秒）。 */
export const ANGRY_HOLD_JITTER_MS = 100;

/** 状态机依赖（全部注入，便于测试）。 */
export interface BehaviorDeps {
  /** 当前时间（毫秒）。 */
  readonly now: () => number;
  /** 随机源（0..1）。 */
  readonly rng: () => number;
}

/** 构造选项。 */
export interface BehaviorOptions {
  /** 日志出口（调试面板用；缺省静默）。 */
  readonly log?: (message: string) => void;
}

/**
 * 下达一条动作指令。
 *
 * @param id 动作 id
 * @param priority 优先级
 * @param reason 排障原因串
 * @param options 可选：持续时间、是否循环
 * @returns 指令
 */
function motionOp(
  id: MotionId,
  priority: Priority,
  reason: string,
  options: { readonly durationMs?: number; readonly loop?: boolean } = {},
): PresentationOp {
  return {
    kind: 'motion',
    id,
    layer: 'base',
    priority,
    durationMs: options.durationMs,
    loop: options.loop,
    fadeMs: 0,
    reason,
  };
}

/**
 * 下达一条表情指令。
 *
 * @param id 表情 id
 * @param priority 优先级
 * @param reason 排障原因串
 * @param durationMs 持续时间（缺省 = 不自动回退）
 * @param layer 目标层：常驻表情（中性 / 困倦 / 睡眠）用 `base`，一次性反应（happy/angry/…）用 `transient`
 * @returns 指令
 */
function expressionOp(
  id: ExpressionId,
  priority: Priority,
  reason: string,
  durationMs?: number,
  layer: PresentationOp['layer'] = 'transient',
): PresentationOp {
  return {
    kind: 'expression',
    id,
    layer,
    priority,
    durationMs,
    fadeMs: 0,
    reason,
  };
}

/**
 * 给一条<b>入态指令</b>打上接管标记。
 *
 * <p>行为层产出的每一条指令都是"我要进入这个状态"的<b>接管</b>声明，不是"请求你让我表现一下"。
 * 以前两者共用一条通道，于是优先级 0 的睡眠会被优先级 1 的生气（TTL 未过期）挡掉，
 * 总线静默丢弃，行为层与画面永久不一致（M6-b 第二轮必修项 1）。</p>
 *
 * <p>判定仍然只发生在 `presentation/priority.ts` 的规则表里（那有一行明文写着"带此标记 → 接管"），
 * 本函数只是<b>贴标记</b>，不做任何优先级比较——单一真源的位置没有挪动。</p>
 *
 * @param op 待打标指令
 * @returns 带 `force: true` 的新指令
 */
function takeover(op: PresentationOp): PresentationOp {
  return { ...op, force: true };
}

/**
 * 把一组指令整体标记为入态接管。
 *
 * @param ops 指令列表
 * @returns 新列表（每条都带 `force: true`）
 */
function entryOps(ops: readonly PresentationOp[]): PresentationOp[] {
  return ops.map(takeover);
}

/**
 * 行为状态的可回滚快照。
 *
 * <p><b>为什么需要它：</b>状态机是"先改自己的字段、再把指令交给上层下发"。如果上层下发失败
 * （总线拒绝 / 没有表现层），行为层就会宣称自己已经切到新状态而画面还停在旧状态——
 * 这正是 QA 报的"各说各话"。有了快照，上层可以在任何一条入态指令没落地时把现场整体滚回去。</p>
 *
 * <p>快照全部是不可变值（含 `sustained` 这种枚举），深拷贝无意义，直接浅拷贝即可。</p>
 */
export interface BehaviorSnapshot {
  /** 切换前的状态。 */
  readonly state: PetBehaviorState;
  /** 切换前的自然结束时刻。 */
  readonly stateUntil: number | null;
  /** 切换前的桥接落地时刻。 */
  readonly bridgeUntil: number | null;
  /** 切换前的连点计数。 */
  readonly tapStreak: number;
  /** 切换前的最后一次点击时刻。 */
  readonly lastTapAt: number | null;
  /** 切换前是否在拖拽。 */
  readonly dragging: boolean;
  /** 切换前的拖拽起点（长拖拽判定用）。 */
  readonly dragStartedAt: number | null;
  /** 切换前的头部连点计数。 */
  readonly petStreak: number;
  /** 切换前的最后一次头部点击时刻。 */
  readonly lastPetAt: number | null;
  /** 切换前的持续动作登记。 */
  readonly sustained: MotionId | null;
  /** 切换前的最近互动时刻。 */
  readonly lastInteractionAt: number;
}

/**
 * 下达一条<b>状态型持续动作</b>指令（sustained）。
 *
 * <p>与 {@link motionOp} 的差别只有两条，但两条都是语义级别的：</p>
 * <ol>
 *   <li>`loop: true` + <b>不带 TTL</b>：动作一直循环，不会自己到期；</li>
 *   <li>只在<b>进入状态</b>时下发一次（{@link PetBehaviorStateMachine.tick} 在持续态下返回空）。</li>
 * </ol>
 *
 * <p><b>为什么"持续"必须由行为层声明而不是改目录：</b>目录里的 `sleepy` 时长（1600ms）
 * 描述的是"一个循环有多长"，不是"这次要跑多久"。把目录值改成 `loop: true` 会让所有
 * 一次性动作（翻身 / 打哈欠）一起失去 TTL 语义；而"这次要跑到被唤醒为止"是<b>行为层</b>
 * 才知道的事。所以这条语义写在 op 上（`loop`），目录保持不动。</p>
 *
 * @param id 动作 id
 * @param priority 优先级（睡眠用 0：不抢占，靠总线的睡眠判定与醒来指令收口）
 * @param reason 排障原因串
 * @returns 指令
 */
function sustainedMotionOp(id: MotionId, priority: Priority, reason: string): PresentationOp {
  return motionOp(id, priority, reason, { loop: true });
}

/**
 * 行为状态机。
 *
 * <p>用法：把用户输入喂给 {@link handle}，把时钟推进喂给 {@link tick}，
 * 把两者返回的指令原样下发即可。</p>
 */
export class PetBehaviorStateMachine {
  /** 时间源。 */
  private readonly now: () => number;

  /** 随机源。 */
  private readonly rng: () => number;

  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /** 当前状态。 */
  private stateValue: PetBehaviorState = 'idle';

  /** 当前状态的自然结束时刻；null = 不会自行结束。 */
  private stateUntil: number | null = null;

  /** 最近一次互动时刻（睡眠计时起点）。 */
  private lastInteractionAt: number;

  /** 桥接 idle 的落地时刻；null = 没有待落地的桥接。 */
  private bridgeUntil: number | null = null;

  /** 连续点击计数（相邻间隔小于窗口才累加）。 */
  private tapStreak = 0;

  /** 上一次点击时刻；null = 还没有点击。 */
  private lastTapAt: number | null = null;

  /** 是否在拖拽。 */
  private dragging = false;

  /** 本次拖拽的开始时刻（毫秒）；null = 没在拖。长拖拽判定（≥{@link SAD_DRAG_MS}）用它。 */
  private dragStartedAt: number | null = null;

  /** 头部连点计数（相邻间隔 < {@link PET_DOUBLE_TAP_MS} 才累加）。 */
  private petStreak = 0;

  /** 上一次头部点击时刻（毫秒）；null = 还没有。 */
  private lastPetAt: number | null = null;

  /**
   * 当前正在持续的"状态型持续动作"；`null` = 没有。
   *
   * <p>它同时是 {@link tick} 的幂等开关：非 null 时 tick 一律不再产出指令，
   * 避免每 250ms 重复下发把动画拽回起点。</p>
   */
  private sustained: MotionId | null = null;

  /**
   * 构造状态机。
   *
   * @param deps 时间与随机源
   * @param options 可选项
   */
  constructor(deps: BehaviorDeps, options: BehaviorOptions = {}) {
    if (!deps || typeof deps.now !== 'function' || typeof deps.rng !== 'function') {
      throw new TypeError('PetBehaviorStateMachine 需要注入 now() 与 rng()');
    }
    this.now = deps.now;
    this.rng = deps.rng;
    this.log = options.log ?? (() => {});
    this.lastInteractionAt = this.now();
  }

  /** 当前状态。 */
  get state(): PetBehaviorState {
    return this.stateValue;
  }

  /** 是否处于睡眠（供眨眼调度抑制）。 */
  get isSleeping(): boolean {
    return this.stateValue === 'sleeping';
  }

  /** 是否在拖拽。 */
  get isDragging(): boolean {
    return this.dragging;
  }

  /**
   * 当前正在持续的动作（状态型；`null` = 没有）。
   *
   * <p>调试与测试用它断言"睡眠确实是一次下发的持续动作"，而不是每拍重下发。</p>
   */
  get sustainedMotion(): MotionId | null {
    return this.sustained;
  }

  /** 距上次互动过了多久（毫秒，调试与测试用）。 */
  idleElapsedMs(): number {
    return this.now() - this.lastInteractionAt;
  }

  /**
   * 处理一次用户事件。
   *
   * @param event 事件（`tap` / `drag-start` / `drag-end` / `pet-end`）
   * @param ctx 点击上下文（`profile` + `holdMs`）；非 `tap` 事件忽略
   * @returns 需要下发的指令（可能为空）
   */
  handle(event: PetBehaviorEvent, ctx: TapContext = DEFAULT_TAP_CONTEXT): PresentationOp[] {
    if (event === 'drag-start') return this.startDrag();
    if (event === 'drag-end') return this.endDrag();
    if (event === 'pet-end') return this.endPet();
    return this.tap(ctx);
  }

  /**
   * 推进时钟：处理"到点回 idle"、"抚摸结束回礼"、"困倦转真睡"与"久不动入睡"。
   *
   * <p>建议每 250ms 调一次（渲染入口用 `setInterval`）。纯函数式推进，不自己挂定时器，
   * 所以测试只要改注入的 `now()` 再调用它。</p>
   *
   * @returns 需要下发的指令（可能为空）
   */
  tick(): PresentationOp[] {
    if (this.dragging || this.stateValue === 'drag') return [];
    // 状态型持续动作（sleepy）：进入状态时已经下发过一次，之后每一拍都必须**不产出任何指令**。
    // 少了这一条，睡眠动作每 250ms 被重启一次——表现层看到的是"抽一下"或者"根本没睡"
    // （80ms 判重只挡得住同一拍内的重复，挡不住 250ms 的间隔）。
    if (this.sustained !== null) return [];
    const now = this.now();

    // 抚摸结束（shy 到期）→ 回礼 wink（E02 / E06 的退出路径）
    if (this.stateValue === 'pet') {
      const petUntil = this.stateUntil;
      if (petUntil !== null && now >= petUntil) return this.endPet();
      return [];
    }

    // 困倦（sleepy）到点 → 真睡（E08：60s 犯困、90s 睡着）
    if (this.stateValue === 'sleepy') {
      const sleepyUntil = this.stateUntil;
      if (sleepyUntil !== null && now >= sleepyUntil) return this.enterSleeping();
      return [];
    }

    // 桥接 idle 落地：高优先级记录已过期，换成常驻 idle（优先级 0，允许眨眼打断）
    if (this.stateValue === 'idle' && this.bridgeUntil !== null && now >= this.bridgeUntil) {
      this.bridgeUntil = null;
      return this.idleOps(0, 'behavior:idle');
    }

    const until = this.stateUntil;
    if (until !== null && now >= until && this.stateValue !== 'idle' && this.stateValue !== 'sleeping') {
      // 不直接下发优先级 0 的 idle：上一个状态的动作可能还占着 base 层（优先级更高且
      // 未到期），会被总线按"低优先级锁"拒绝。先落一条带 TTL 的桥接，再由下一拍落到常驻。
      this.enterIdleWithBridge(now);
      return this.idleOps(2, 'behavior:idle:bridge', IDLE_BRIDGE_MS);
    }

    if (this.stateValue === 'idle' && now - this.lastInteractionAt >= SLEEP_AFTER_IDLE_MS) {
      return this.enterSleeping();
    }
    // 先困倦（60s）再真睡（90s）：顺序不能反，否则 60s 那条永远到不了
    if (this.stateValue === 'idle' && now - this.lastInteractionAt >= SLEEPY_AFTER_IDLE_MS) {
      return this.enterSleepy();
    }
    return [];
  }

  /**
   * 进入**困倦**（E08 的第一档）：表情 + 循环动作，{@link SLEEPY_TO_SLEEP_MS} 后转真睡。
   *
   * <p>与 {@link enterSleeping} 的区别只有两条，但两条都影响可用性：</p>
   * <ol>
   *   <li>**不登记 `sustained`**：困倦不是"跑到被唤醒为止"的持续态，它有自己的到期时间
   *       （{@link PetBehaviorStateMachine.tick} 的 sleepy 分支），登记了 tick 就永远沉默，
   *       90s 那条到不了；</li>
   *   <li>不在 `isSleeping` 里：困倦**仍然会眨眼**，只有真睡才抑制眨眼。</li>
   * </ol>
   *
   * @returns 需要下发的指令
   */
  private enterSleepy(): PresentationOp[] {
    const now = this.now();
    // 真睡的硬期限挂在"最近一次互动 + 90s"上，而不是"现在 + 30s"：
    // tick 是 250ms 一拍，用"现在"计数会让记得越晚睡得越晚（最坏慢一拍以上），
    // 而 90 秒这条边界是验收要精确到 1ms 的口径。
    const sleepAt = Math.max(now + 1, this.lastInteractionAt + SLEEP_AFTER_IDLE_MS);
    this.enter('sleepy', sleepAt);
    this.log(`[pet] 行为：${SLEEPY_AFTER_IDLE_MS}ms 无交互，进入困倦（${sleepAt - now}ms 后入睡）`);
    return entryOps([
      // 动作走 `loop` + 不带 TTL：困倦会持续到 90s 真睡，而不是 1.6s 后自己停
      motionOp('sleepy', 0, 'behavior:sleepy', { loop: true }),
      // 表情走 base 槽 + 不带 TTL：它就是这个阶段的"基础表情"（到点由睡眠指令接管）
      expressionOp('sleepy', 0, 'behavior:sleepy:expression', undefined, 'base'),
    ]);
  }

  /**
   * 进入睡眠：下发<b>一次</b>状态型持续动作，此后由 tick 的幂等分支保持沉默。
   *
   * @returns 需要下发的指令
   */
  private enterSleeping(): PresentationOp[] {
    this.enter('sleeping', null);
    // 登记持续动作：这是"不自动回退"的唯一凭据，也是 tick 幂等的开关
    this.sustained = 'sleepy';
    this.log(`[pet] 行为：${SLEEP_AFTER_IDLE_MS}ms 无交互，进入睡眠`);
    return entryOps([
      // 睡眠优先级维持 0：真正的"抑制眨眼"由总线的 sleeping 判定做，不靠抢占；
      // 醒来的 wake 是优先级 2，一定能打断它（见 priority.ts 的规则表）。
      // 入态指令带 force：即使上一拍的生气记录还没过期，睡眠也必须真的落到画面上。
      sustainedMotionOp('sleepy', 0, 'behavior:sleep'),
      // 表情同样不带 TTL：睡到被叫醒为止，而不是 1.6 秒后自己变回中性脸。
      // 走 base 槽：它就是这一阶段的"基础表情"（transient 到期回落的目标）。
      expressionOp('sleepy', 0, 'behavior:sleep:expression', undefined, 'base'),
    ]);
  }

  /**
   * 抚摸结束（`pet-end`）：回到 idle 的桥接 + 一次**回礼 wink**（E02）。
   *
   * <p><b>为什么桥接时长是 {@link WINK_MS} 而不是 {@link IDLE_BRIDGE_MS}：</b>
   * 桥接落地时会下发常驻 idle（含中性表情），如果它比 wink 早到，中性脸就会把 wink
   * 在 250ms 处截断——用户看到的是"嘴刚咧开就没了"。让桥接与 wink 同时到期，
   * wink 播满 600ms 之后再由 tick 落到常驻 idle，两边时序才对得上。</p>
   *
   * @returns 需要下发的指令
   */
  private endPet(): PresentationOp[] {
    const now = this.now();
    this.petStreak = 0;
    this.lastPetAt = null;
    this.enter('idle', null);
    this.bridgeUntil = now + WINK_MS;
    this.log('[pet] 行为：抚摸结束，回礼 wink');
    return entryOps([
      motionOp('idle', 2, 'behavior:pet-end:idle', { loop: true, durationMs: WINK_MS }),
      // E02：wink 是**交互表情**（单眼闭合），不是生理眨眼——优先级 1、600ms、fade 0
      expressionOp('wink', 1, 'behavior:pet-end', WINK_MS),
    ]);
  }

  /** 重置到初始 idle（页面重新就绪时用）。 */
  reset(): void {
    this.stateValue = 'idle';
    this.stateUntil = null;
    this.bridgeUntil = null;
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.dragging = false;
    this.dragStartedAt = null;
    this.petStreak = 0;
    this.lastPetAt = null;
    this.sustained = null;
    this.lastInteractionAt = this.now();
  }

  /**
   * 拍一张当前现场的快照（**入态指令下发前**调用）。
   *
   * <p>配合 {@link restore}：上层把指令交给总线之后，只要有一条没落地，
   * 就用这张快照把行为层整体滚回去，避免"行为层说切了、画面没切"。</p>
   *
   * @returns 现场快照（不可变值）
   */
  snapshot(): BehaviorSnapshot {
    return {
      state: this.stateValue,
      stateUntil: this.stateUntil,
      bridgeUntil: this.bridgeUntil,
      tapStreak: this.tapStreak,
      lastTapAt: this.lastTapAt,
      dragging: this.dragging,
      dragStartedAt: this.dragStartedAt,
      petStreak: this.petStreak,
      lastPetAt: this.lastPetAt,
      sustained: this.sustained,
      lastInteractionAt: this.lastInteractionAt,
    };
  }

  /**
   * 回滚到一张现场快照。
   *
   * <p>非法快照（`null` / 缺字段 / 状态名不认识）一律拒绝并返回 `false`，不抛——
   * 这条路径只在"表现层拒绝入态指令"的异常时刻走，不能因为回滚本身再把渲染层带崩。</p>
   *
   * @param snapshot 由 {@link snapshot} 产出的快照
   * @param reason 回滚原因（只用于日志）
   * @returns 是否真的回滚了
   */
  restore(snapshot: BehaviorSnapshot | null, reason = ''): boolean {
    if (!snapshot || typeof snapshot !== 'object') {
      this.log('[pet] 行为回滚失败：快照为空');
      return false;
    }
    const state = snapshot.state;
    // known 列表必须与 PetBehaviorState 联合同步（M1 新增 sleepy / pet）
    const known: readonly PetBehaviorState[] = [
      'idle',
      'tap',
      'angry',
      'sleepy',
      'sleeping',
      'wake',
      'drag',
      'pet',
    ];
    if (!known.includes(state)) {
      this.log(`[pet] 行为回滚失败：未知状态 ${String(state)}`);
      return false;
    }
    this.stateValue = state;
    this.stateUntil = typeof snapshot.stateUntil === 'number' ? snapshot.stateUntil : null;
    this.bridgeUntil = typeof snapshot.bridgeUntil === 'number' ? snapshot.bridgeUntil : null;
    this.tapStreak = typeof snapshot.tapStreak === 'number' ? snapshot.tapStreak : 0;
    this.lastTapAt = typeof snapshot.lastTapAt === 'number' ? snapshot.lastTapAt : null;
    this.dragging = snapshot.dragging === true;
    this.dragStartedAt = typeof snapshot.dragStartedAt === 'number' ? snapshot.dragStartedAt : null;
    this.petStreak = typeof snapshot.petStreak === 'number' ? snapshot.petStreak : 0;
    this.lastPetAt = typeof snapshot.lastPetAt === 'number' ? snapshot.lastPetAt : null;
    this.sustained = snapshot.sustained === 'sleepy' ? 'sleepy' : null;
    this.lastInteractionAt =
      typeof snapshot.lastInteractionAt === 'number' ? snapshot.lastInteractionAt : this.now();
    this.log(`[pet] 行为已回滚到 ${state}${reason ? `（${reason}）` : ''}`);
    return true;
  }

  /**
   * 失败修复：把<b>当前状态</b>的可表现指令重新下发一遍。
   *
   * <p>回滚只把行为层拉回去了，画面可能还停在"半截"（比如动作已落地、表情被拒）。
   * 这条方法让上层用一次强制定向把两层的描述重新对齐，保证任何时刻读到的
   * `behaviorState()` 与 `data-motion` / `getExpression()` 都在讲同一件事。</p>
   *
   * <p>一次性动作（tap / angry / wake）回滚到它们没有意义（TTL 早就在过去点了），
   * 统一落到 idle：行为层与画面都回到 idle，仍然是一致的。</p>
   *
   * @returns 需要下发的（force）指令
   */
  repairOps(): PresentationOp[] {
    if (this.stateValue === 'sleeping') {
      this.sustained = 'sleepy';
      return entryOps([
        sustainedMotionOp('sleepy', 0, 'behavior:repair:sleep'),
        expressionOp('sleepy', 0, 'behavior:repair:sleep:expression', undefined, 'base'),
      ]);
    }
    if (this.stateValue === 'sleepy') {
      // 困倦不是"一次性动作"，重定向时要重新登记它的到期时刻，否则会永远停在困倦
      return this.enterSleepy();
    }
    if (this.stateValue === 'drag' && this.dragging) {
      return entryOps([motionOp('drag', 2, 'behavior:repair:drag', { loop: true })]);
    }
    this.enter('idle', null);
    this.bridgeUntil = null;
    return this.idleOps(0, 'behavior:repair:idle');
  }

  /**
   * 记一次互动：把"无交互 90 秒入睡"的计时起点拉回现在。
   *
   * <p>调试时要反复验"静置 90 秒才睡"，总不能每次都真等一分半：把计时起点拉回现在即可。
   * 它只动计时起点，不动状态、不下发指令。调试后门（O1）把它挂成 `petDebug.resetIdleTimer`。</p>
   */
  markInteraction(): void {
    this.lastInteractionAt = this.now();
  }

  /**
   * 外部驱动：直接切到某个状态并返回该状态的"首发指令"。
   *
   * <p><b>为什么要有这个入口：</b>行为层原本是纯自驱的（只认 `handle` / `tick`），
   * 但"立刻让我看到睡眠态"这类需求（O1 的调试后门，以及将来的剧情 / 任务编排）
   * 需要一个受控的直达通道。</p>
   *
   * <p><b>为什么入口放在行为层而不是渲染层：</b>状态语义只在这里。渲染层自己拼 `sleepy`
   * 指令会绕过持续动作的登记（`sustained`），于是"强制睡眠"能睡、但语义与真机不一致；
   * 后门必须和真机走同一条路径，否则调试看到的东西没有参考价值。</p>
   *
   * <p>非法状态名一律返回空数组（不抛），避免外部传错值把桌宠带崩。</p>
   *
   * @param state 目标状态（含 `happy` 这个"组合态"别名）
   * @returns 需要下发的指令（可能为空）
   */
  enterState(state: PetBehaviorDebugState): PresentationOp[] {
    if (!isPetBehaviorDebugState(state)) return [];
    const now = this.now();
    // 外部驱动可以随时介入：先把"拖拽中"这类长驻标记清掉，否则所有转移都会被 `dragging` 拦住
    this.dragging = false;
    this.dragStartedAt = null;
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.petStreak = 0;
    this.lastPetAt = null;
    this.lastInteractionAt = now;

    switch (state) {
      case 'idle': {
        // 走桥接而不是直接发优先级 0：上一状态的 base 记录可能还没到期，
        // 直接发会被总线的"低优先级锁"拒绝（那正是 D-B3 的老坑）
        this.enterIdleWithBridge(now);
        return this.idleOps(2, 'debug:force:idle', IDLE_BRIDGE_MS);
      }
      case 'tap':
        return this.tap(DEFAULT_TAP_CONTEXT);
      case 'happy': {
        // happy 不是独立行为状态：它是"tap 状态 + happy 动作/表情"的组合
        this.enter('tap', now + TAP_HOLD_MS);
        return entryOps([
          motionOp('happy', 1, 'debug:force:happy', { durationMs: TAP_HOLD_MS }),
          expressionOp('happy', 1, 'debug:force:happy:expression', TAP_HOLD_MS),
        ]);
      }
      case 'angry': {
        const holdMs = this.jitter(ANGRY_HOLD_MS, ANGRY_HOLD_JITTER_MS);
        this.enter('angry', now + holdMs);
        return entryOps([
          motionOp('angry', 1, 'debug:force:angry', { durationMs: holdMs }),
          expressionOp('angry', 1, 'debug:force:angry:expression', holdMs),
        ]);
      }
      case 'sleeping':
        // 不伪造"已经静置 90 秒"，直接走同一套入睡路径（含持续动作登记）
        return this.enterSleeping();
      case 'wake': {
        this.enter('wake', now + WAKE_HOLD_MS);
        return entryOps([
          motionOp('wake', 2, 'debug:force:wake', { durationMs: WAKE_HOLD_MS }),
          expressionOp('surprised', 2, 'debug:force:wake:expression', WAKE_HOLD_MS),
        ]);
      }
      case 'drag':
        return this.startDrag();
      default:
        return [];
    }
  }

  /**
   * 点一下（**按命中分区分流**：头部 = 抚摸语义，身体 = 普通点击）。
   *
   * <p>连点判定用<b>相邻间隔</b>而不是"窗口内累计"：用户慢慢点三下（每次隔 1.9s、
   * 总跨度 3.8s）也读作"连着点"，用固定窗口会把第一下漏掉。</p>
   *
   * <p>顺序有意如此：<b>惊醒 &gt; 连点生气 &gt; 抚摸 &gt; 单击</b>。连点生气放在分区之前，
   * 是因为"连点 3 次生气（间隔 &lt; 2s）"是既有语义（§6 的 E05，现状不变）。</p>
   *
   * <p><b>§6 的 E05 与 E06 在头部会重叠，这里的裁决是「抚摸优先」：</b>头部第 2 下就进
   * `pet`，并把连点计数清零（见 {@link tapHead}），所以"摸头摸快了"永远走不到生气——
   * 摸头是亲昵动作，摸到第三下就翻脸是明显的错误表现。生气仍然可以从身体连点 3 下到达
   * （§6 的 E05 入口写的就是"连点 3 次"，没有限定分区），因此每一档表情依旧有真实入口。
   * 用例：`tests/petBehaviorTriggers.test.ts` 的「头部连点 3 次是抚摸不是生气」。</p>
   *
   * @param ctx 点击上下文（分区 + 按住时长）
   * @returns 需要下发的指令
   */
  private tap(ctx: TapContext): PresentationOp[] {
    if (this.dragging) return [];
    const now = this.now();
    this.lastInteractionAt = now;

    // 睡眠中点击 = 惊醒：优先级 2，抢掉睡眠动作与任何残留表情。
    // 与分区无关：睡着的人被点哪儿都该醒。
    if (this.stateValue === 'sleeping') {
      this.tapStreak = 0;
      this.lastTapAt = now;
      this.petStreak = 0;
      this.lastPetAt = null;
      this.enter('wake', now + WAKE_HOLD_MS);
      this.log('[pet] 行为：睡眠中被点击，惊醒');
      return entryOps([
        motionOp('wake', 2, 'behavior:wake', { durationMs: WAKE_HOLD_MS }),
        expressionOp('surprised', 2, 'behavior:wake:expression', WAKE_HOLD_MS),
      ]);
    }

    const gap = this.lastTapAt === null ? Number.POSITIVE_INFINITY : now - this.lastTapAt;
    this.tapStreak = gap < MULTI_TAP_WINDOW_MS ? this.tapStreak + 1 : 1;
    this.lastTapAt = now;

    if (this.tapStreak >= MULTI_TAP_THRESHOLD) {
      this.tapStreak = 0;
      this.petStreak = 0;
      this.lastPetAt = null;
      const holdMs = this.jitter(ANGRY_HOLD_MS, ANGRY_HOLD_JITTER_MS);
      this.enter('angry', now + holdMs);
      this.log(`[pet] 行为：相邻间隔 <${MULTI_TAP_WINDOW_MS}ms 连点 ${MULTI_TAP_THRESHOLD} 次，生气`);
      return entryOps([
        motionOp('angry', 1, 'behavior:angry', { durationMs: holdMs }),
        expressionOp('angry', 1, 'behavior:angry:expression', holdMs),
      ]);
    }

    if (ctx.profile === 'head') return this.tapHead(ctx, now);

    return this.tapBody();
  }

  /**
   * 身体单击（E07）：`happy` 表情 + 整图一弹。
   *
   * @returns 需要下发的指令
   */
  private tapBody(): PresentationOp[] {
    const now = this.now();
    const holdMs = this.jitter(TAP_HOLD_MS, TAP_HOLD_JITTER_MS);
    this.enter('tap', now + holdMs);
    return entryOps([
      motionOp('tap', 1, 'behavior:tap', { durationMs: holdMs }),
      expressionOp('happy', 1, 'behavior:tap:expression', holdMs),
    ]);
  }

  /**
   * 头部点击：凑够"抚摸"就进 `pet`，否则仍然给一次普通点击反应。
   *
   * <p>两条入口（§6 的 E06）：</p>
   * <ul>
   *   <li><b>按住 ≥ {@link PET_HOLD_MS}</b>（长按抚摸）——一次就够；</li>
   *   <li><b>连点 2 次</b>（相邻间隔 &lt; {@link PET_DOUBLE_TAP_MS}）——第二次触发。</li>
   * </ul>
   *
   * <p>头部单击还没有构成抚摸，但用户确实点了：给一次普通点击反应（与身体单击同一条路径），
   * 否则"点了一下头什么都没发生"会被读成没响应。</p>
   *
   * @param ctx 点击上下文
   * @param now 当前时间
   * @returns 需要下发的指令
   */
  private tapHead(ctx: TapContext, now: number): PresentationOp[] {
    const isHold = Number.isFinite(ctx.holdMs) && ctx.holdMs >= PET_HOLD_MS;
    const gap = this.lastPetAt === null ? Number.POSITIVE_INFINITY : now - this.lastPetAt;
    if (isHold) {
      this.petStreak = Math.max(2, this.petStreak + 1);
    } else {
      this.petStreak = gap < PET_DOUBLE_TAP_MS ? this.petStreak + 1 : 1;
    }
    this.lastPetAt = now;

    if (this.petStreak < 2) return this.tapBody();

    this.petStreak = 0;
    this.lastPetAt = null;
    // 抚摸同时把"连点"计数清零：摸头是亲昵动作，不该在摸第 3 下时被连点规则判成生气
    // （§6 里 E05「连点 3 次」与 E06「头部连点 2 次」在头部会重叠，这里明确让抚摸优先；
    //  用例：`petBehaviorTriggers.test.ts` 的「头部连点 3 次是抚摸不是生气」）。
    this.tapStreak = 0;
    this.lastTapAt = null;
    const holdMs = PET_SHOW_MS;
    this.enter('pet', now + holdMs);
    this.bridgeUntil = null;
    this.log(`[pet] 行为：头部被抚摸（${isHold ? `按住 ≥${PET_HOLD_MS}ms` : `连点 2 次（间隔 <${PET_DOUBLE_TAP_MS}ms）`}）`);
    return entryOps([
      // E06：shy 表情 + 一次小弹。心形特效是表现层的装饰件（M1 未实现，见设计文档 §6 备注）
      motionOp('happy', 1, 'behavior:pet', { durationMs: holdMs }),
      expressionOp('shy', 1, 'behavior:pet:expression', holdMs),
    ]);
  }

  /**
   * 开始拖拽：不限时、优先级 2（打断一切，包括睡着的呼吸）。
   *
   * <p>顺带"惊一下"（E03 的 drag-start 入口）：`surprised` 600ms，
   * 让"被拎起来"有一个即时反馈，而不是只有整图位移。</p>
   *
   * @returns 需要下发的指令
   */
  private startDrag(): PresentationOp[] {
    if (this.dragging) return [];
    const now = this.now();
    this.dragging = true;
    this.dragStartedAt = now;
    this.lastInteractionAt = now;
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.petStreak = 0;
    this.lastPetAt = null;
    this.bridgeUntil = null;
    this.enter('drag', null);
    return entryOps([
      motionOp('drag', 2, 'behavior:drag', { loop: true }),
      expressionOp('surprised', 2, 'behavior:drag-start:expression', DRAG_START_SURPRISED_MS),
    ]);
  }

  /**
   * 结束拖拽：短拖 → 桥接 idle；**长拖（≥ {@link SAD_DRAG_MS}）→ 委屈 `sad`**（E04）。
   *
   * <p>「被拎久了委屈」是唯一一条按<b>拖拽时长</b>分支的表情触发。判定用
   * {@link PetBehaviorStateMachine.startDrag} 记下的 `dragStartedAt`，不是调用方传的时长——
   * 少一个可以传错的参数，就少一类"IPC 抖动导致误判"的缺陷。</p>
   *
   * <p>委屈的桥接时长同样取 {@link SAD_HOLD_MS}（而不是 250ms）：桥接落地会下发中性表情，
   * 比 sad 早到就会把委屈截断在 250ms（与 `pet-end` 的 wink 同一个坑）。</p>
   *
   * @returns 需要下发的指令
   */
  private endDrag(): PresentationOp[] {
    if (!this.dragging) return [];
    const now = this.now();
    const dragMs = this.dragStartedAt === null ? 0 : now - this.dragStartedAt;
    this.dragging = false;
    this.dragStartedAt = null;
    this.lastInteractionAt = now;

    if (dragMs >= SAD_DRAG_MS) {
      this.enter('idle', null);
      this.bridgeUntil = now + SAD_HOLD_MS;
      this.log(`[pet] 行为：拖拽 ${dragMs}ms ≥ ${SAD_DRAG_MS}ms，松手委屈`);
      return entryOps([
        motionOp('idle', 2, 'behavior:drag-end:long:idle', { loop: true, durationMs: SAD_HOLD_MS }),
        expressionOp('sad', 1, 'behavior:drag-end:long', SAD_HOLD_MS),
      ]);
    }

    this.enterIdleWithBridge(now);
    return this.idleOps(2, 'behavior:drag-end:idle', IDLE_BRIDGE_MS);
  }

  /**
   * 切到 idle 并登记一次桥接（高优先级状态必须先过期，才能落到常驻 idle）。
   *
   * @param now 当前时间
   */
  private enterIdleWithBridge(now: number): void {
    this.enter('idle', null);
    this.bridgeUntil = now + IDLE_BRIDGE_MS;
  }

  /**
   * 生成一组 idle 指令（动作 + 中性表情）。
   *
   * @param priority 优先级（桥接时用 2，常驻时用 0）
   * @param reason 排障原因串
   * @param durationMs 可选持续时间（桥接用）
   * @returns 指令列表
   */
  private idleOps(priority: Priority, reason: string, durationMs?: number): PresentationOp[] {
    // 回 idle 同样是"进入一个状态"：带上接管标记，才不会被上一个未到期的状态记录挡住
    // （旧实现为此专门走"桥接 + 等下一拍"，那条补丁现在只留作心跳节流，不再承担正确性）
    return entryOps([
      motionOp('idle', priority, reason, { loop: true, durationMs }),
      // 中性表情走 **base** 槽（E01：`expression neutral base prio0 无TTL`）：
      // 它就是"回落目标"，transient 槽到期时总线回落到这里；放在 transient 会让
      // 一次眨眼/一次点击之后的中性脸与"基础表情"变成两条互不相干的记录。
      expressionOp('neutral', priority, `${reason}:expression`, durationMs, 'base'),
    ]);
  }

  /**
   * 切换到指定状态。
   *
   * @param next 目标状态
   * @param until 自然结束时刻；null = 不自动结束
   */
  private enter(next: PetBehaviorState, until: number | null): void {
    this.stateValue = next;
    this.stateUntil = until;
    if (next !== 'idle') this.bridgeUntil = null;
    // 任何一次状态切换都终止"状态型持续动作"：持续语义的边界就是"离开这个状态"。
    // 需要继续持续的状态由进入方自己重新登记（见 enterSleeping）。
    this.sustained = null;
  }

  /**
   * 给时长加一点抖动（以 `rng()` 为中心，±jitter）。
   *
   * @param baseMs 基准时长
   * @param jitterMs 抖动幅度（毫秒）
   * @returns 抖动后的时长（整数，至少 1）
   */
  private jitter(baseMs: number, jitterMs: number): number {
    const raw = this.rng();
    const unit = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
    return Math.max(1, Math.round(baseMs + (unit * 2 - 1) * jitterMs));
  }
}
