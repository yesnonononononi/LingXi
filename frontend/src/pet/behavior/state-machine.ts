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
 * @module pet/behavior/state-machine
 */
import type { ExpressionId, MotionId, PresentationOp, Priority } from '../presentation/types';

/** 行为状态。 */
export type PetBehaviorState = 'idle' | 'tap' | 'angry' | 'sleeping' | 'wake' | 'drag';

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
      this.enter('sleeping', null);
      this.log(`[pet] 行为：${SLEEP_AFTER_IDLE_MS}ms 无交互，进入睡眠`);
      return [
        motionOp('sleepy', 0, 'behavior:sleep', { loop: true }),
        expressionOp('sleepy', 0, 'behavior:sleep:expression'),
      ];
    }
    return [];
  }

  /** 重置到初始 idle（页面重新就绪时用）。 */
  reset(): void {
    this.stateValue = 'idle';
    this.stateUntil = null;
    this.bridgeUntil = null;
    this.tapStreak = 0;
    this.lastTapAt = null;
    this.dragging = false;
    this.lastInteractionAt = this.now();
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
      return [
        motionOp('wake', 2, 'behavior:wake', { durationMs: WAKE_HOLD_MS }),
        expressionOp('surprised', 2, 'behavior:wake:expression', WAKE_HOLD_MS),
      ];
    }

    const gap = this.lastTapAt === null ? Number.POSITIVE_INFINITY : now - this.lastTapAt;
    this.tapStreak = gap < MULTI_TAP_WINDOW_MS ? this.tapStreak + 1 : 1;
    this.lastTapAt = now;

    if (this.tapStreak >= MULTI_TAP_THRESHOLD) {
      this.tapStreak = 0;
      const holdMs = this.jitter(ANGRY_HOLD_MS, ANGRY_HOLD_JITTER_MS);
      this.enter('angry', now + holdMs);
      this.log(`[pet] 行为：相邻间隔 <${MULTI_TAP_WINDOW_MS}ms 连点 ${MULTI_TAP_THRESHOLD} 次，生气`);
      return [
        motionOp('angry', 1, 'behavior:angry', { durationMs: holdMs }),
        expressionOp('angry', 1, 'behavior:angry:expression', holdMs),
      ];
    }

    const holdMs = this.jitter(TAP_HOLD_MS, TAP_HOLD_JITTER_MS);
    this.enter('tap', now + holdMs);
    return [
      motionOp('tap', 1, 'behavior:tap', { durationMs: holdMs }),
      expressionOp('happy', 1, 'behavior:tap:expression', holdMs),
    ];
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
    return [motionOp('drag', 2, 'behavior:drag', { loop: true })];
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
    return [
      motionOp('idle', priority, reason, { loop: true, durationMs }),
      expressionOp('neutral', priority, `${reason}:expression`, durationMs),
    ];
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
