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

/** 行为状态。 */
export type PetBehaviorState = 'idle' | 'tap' | 'angry' | 'sleeping' | 'wake' | 'drag';

/**
 * 外部驱动可直达的状态名。
 *
 * <p>比 {@link PetBehaviorState} 多一个 `happy`：它不是一个独立行为状态，
 * 而是"表情 happy + 一次性小弹"的组合，只在调试面板里需要一个直达按钮。</p>
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
export type PetBehaviorEvent = 'tap' | 'drag-start' | 'drag-end';

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
 * @returns 指令
 */
function expressionOp(
  id: ExpressionId,
  priority: Priority,
  reason: string,
  durationMs?: number,
): PresentationOp {
  return {
    kind: 'expression',
    id,
    layer: 'transient',
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
   * @param event 事件
   * @returns 需要下发的指令（可能为空）
   */
  handle(event: PetBehaviorEvent): PresentationOp[] {
    if (event === 'drag-start') return this.startDrag();
    if (event === 'drag-end') return this.endDrag();
    return this.tap();
  }

  /**
   * 推进时钟：处理"到点回 idle"与"久不动入睡"。
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
    return [];
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
      // 表情同样不带 TTL：睡到被叫醒为止，而不是 1.6 秒后自己变回中性脸
      expressionOp('sleepy', 0, 'behavior:sleep:expression'),
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
    const known: readonly PetBehaviorState[] = ['idle', 'tap', 'angry', 'sleeping', 'wake', 'drag'];
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
        expressionOp('sleepy', 0, 'behavior:repair:sleep:expression'),
      ]);
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
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.lastInteractionAt = now;

    switch (state) {
      case 'idle': {
        // 走桥接而不是直接发优先级 0：上一状态的 base 记录可能还没到期，
        // 直接发会被总线的"低优先级锁"拒绝（那正是 D-B3 的老坑）
        this.enterIdleWithBridge(now);
        return this.idleOps(2, 'debug:force:idle', IDLE_BRIDGE_MS);
      }
      case 'tap':
        return this.tap();
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
   * 点一下。
   *
   * <p>连点判定用<b>相邻间隔</b>而不是"窗口内累计"：用户慢慢点三下（每次隔 1.9s、
   * 总跨度 3.8s）也读作"连着点"，用固定窗口会把第一下漏掉。</p>
   *
   * @returns 需要下发的指令
   */
  private tap(): PresentationOp[] {
    if (this.dragging) return [];
    const now = this.now();
    this.lastInteractionAt = now;

    // 睡眠中点击 = 惊醒：优先级 2，抢掉睡眠动作与任何残留表情
    if (this.stateValue === 'sleeping') {
      this.tapStreak = 0;
      this.lastTapAt = now;
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
      const holdMs = this.jitter(ANGRY_HOLD_MS, ANGRY_HOLD_JITTER_MS);
      this.enter('angry', now + holdMs);
      this.log(`[pet] 行为：相邻间隔 <${MULTI_TAP_WINDOW_MS}ms 连点 ${MULTI_TAP_THRESHOLD} 次，生气`);
      return entryOps([
        motionOp('angry', 1, 'behavior:angry', { durationMs: holdMs }),
        expressionOp('angry', 1, 'behavior:angry:expression', holdMs),
      ]);
    }

    const holdMs = this.jitter(TAP_HOLD_MS, TAP_HOLD_JITTER_MS);
    this.enter('tap', now + holdMs);
    return entryOps([
      motionOp('tap', 1, 'behavior:tap', { durationMs: holdMs }),
      expressionOp('happy', 1, 'behavior:tap:expression', holdMs),
    ]);
  }

  /**
   * 开始拖拽：不限时、优先级 2（打断一切，包括睡着的呼吸）。
   *
   * @returns 需要下发的指令
   */
  private startDrag(): PresentationOp[] {
    if (this.dragging) return [];
    this.dragging = true;
    this.lastInteractionAt = this.now();
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.bridgeUntil = null;
    this.enter('drag', null);
    return entryOps([motionOp('drag', 2, 'behavior:drag', { loop: true })]);
  }

  /**
   * 结束拖拽：先下桥接 idle（带 TTL），由 tick 落到常驻 idle。
   *
   * @returns 需要下发的指令
   */
  private endDrag(): PresentationOp[] {
    if (!this.dragging) return [];
    this.dragging = false;
    const now = this.now();
    this.lastInteractionAt = now;
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
      expressionOp('neutral', priority, `${reason}:expression`, durationMs),
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
