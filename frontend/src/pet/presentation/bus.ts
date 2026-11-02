/**
 * 表现层调度总线：把"指令"变成"何时应用到实现"。
 *
 * <p><b>它做三件事，别的都不做：</b></p>
 * <ol>
 *   <li>打断判定（委托 `priority.ts` 的纯函数，规则表只有一份实现）；</li>
 *   <li>层叠加与 TTL（`base` / `transient` / `ambient`，到期回落到占主导的那条）；</li>
 *   <li>排队（低优先级指令在活动指令剩余 ≤120ms 时排到其到期后执行，而不是直接丢弃）。</li>
 * </ol>
 *
 * <p><b>不做什么：</b>不碰 DOM、不碰 CSS、不引 rAF。TTL 只用 `setTimeout`（±5ms 对 180ms 的眨眼
 * 无感），定时器与时钟都可注入，所以整条调度链能在 node 里单测。</p>
 *
 * @module pet/presentation/bus
 */
import { interruptDecision, suppressionReason, type ActiveOpState, type InterruptDecision } from './priority';
import { isPresentationOp, type MotionId, type PetPresentation, type PresentationOp } from './types';

/** 定时器端口（可注入：测试用假定时器把 180ms 的 TTL 变成同步断言）。 */
export interface TimerPort {
  /**
   * 注册一次性定时器。
   *
   * @param handler 到期回调
   * @param delayMs 延迟毫秒
   * @returns 句柄（交给 {@link TimerPort.clearTimeout}）
   */
  setTimeout(handler: () => void, delayMs: number): number;
  /**
   * 取消定时器。
   *
   * @param handle {@link TimerPort.setTimeout} 返回的句柄
   */
  clearTimeout(handle: number): void;
}

/** 基于 `globalThis` 的默认定时器端口（浏览器与 node 都有）。 */
export const DEFAULT_TIMER_PORT: TimerPort = {
  setTimeout(handler: () => void, delayMs: number): number {
    return globalThis.setTimeout(handler, delayMs) as unknown as number;
  },
  clearTimeout(handle: number): void {
    globalThis.clearTimeout(handle as unknown as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};

/** dispatch 的处理结果（调用方一般忽略，测试与调试面板要用）。 */
export type DispatchOutcome = 'applied' | 'queued' | 'rejected';

/** 调度器可选项。 */
export interface PresentationBusOptions {
  /** 定时器端口，缺省用全局定时器。 */
  readonly timer?: TimerPort;
  /** 时钟（毫秒），缺省用 `Date.now`。 */
  readonly now?: () => number;
  /** 日志（缺省静默；调试面板传入 console.debug）。 */
  readonly log?: (message: string) => void;
  /** 是否处于睡眠表情（用于抑制眨眼）；缺省恒 false。 */
  readonly isSleeping?: () => boolean;
}

/** 一条在生效中的层记录。 */
interface ActiveEntry {
  /** 生效的指令。 */
  readonly op: PresentationOp;
  /** 到期时间戳（毫秒）；null = 不会自行到期。 */
  readonly expiresAt: number | null;
  /** 该层的 TTL 定时器句柄。 */
  readonly timerHandle: number | null;
}

/**
 * 表现层调度总线。
 *
 * <p>用法：</p>
 * <pre>
 *   const bus = new PresentationBus(presentation);
 *   bus.dispatch({ kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: 900, reason: 'tap' });
 * </pre>
 */
export class PresentationBus {
  /** 被调度的表现层实现。 */
  private readonly target: PetPresentation;

  /** 定时器端口。 */
  private readonly timer: TimerPort;

  /** 时钟。 */
  private readonly now: () => number;

  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /** 睡眠判定（抑制眨眼）。 */
  private readonly isSleeping: () => boolean;

  /** 各层当前生效的指令。 */
  private readonly layers: Map<'base' | 'transient' | 'ambient', ActiveEntry> = new Map();

  /** 等待活动指令到期的队列（先进先出）。 */
  private queue: PresentationOp[] = [];

  /** 最近一次实际应用的指令（80ms 连点合并用）。 */
  private lastApplied: { kind: string; id: string; atMs: number } | null = null;

  /** 是否已释放。 */
  private disposed = false;

  /**
   * 构造调度总线。
   *
   * @param target 表现层实现
   * @param options 可选项（定时器/时钟/日志/睡眠判定）
   */
  constructor(target: PetPresentation, options: PresentationBusOptions = {}) {
    if (!target) throw new TypeError('PresentationBus 需要一个 PetPresentation 实现');
    this.target = target;
    this.timer = options.timer ?? DEFAULT_TIMER_PORT;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.isSleeping = options.isSleeping ?? (() => false);
  }

  /** 表现层当前状态（转发给实现，保证快照只有一份）。 */
  get state() {
    return this.target.state;
  }

  /** 当前排队中的指令数（调试面板用）。 */
  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * 投递一条指令。
   *
   * @param op 指令（结构非法时丢弃并记日志，不抛——桌宠不该因为一条脏消息白屏）
   * @returns 处理结果
   */
  dispatch(op: PresentationOp): DispatchOutcome {
    if (this.disposed) return 'rejected';
    if (!isPresentationOp(op)) {
      this.log(`[pet] 丢弃非法指令: ${safeStringify(op)}`);
      return 'rejected';
    }

    const active = this.dominant();
    const decision: InterruptDecision = this.decide(op, active);

    if (decision === 'reject') {
      this.log(`[pet] 指令被拒绝: kind=${op.kind} id=${String(op.id)} 原因=${this.reasonOf(op, active)}`);
      return 'rejected';
    }
    if (decision === 'queue') {
      this.queue.push(op);
      this.log(`[pet] 指令排队: kind=${op.kind} id=${String(op.id)} 队列长度=${this.queue.length}`);
      return 'queued';
    }

    // 入态接管（规则表第 1 行）：判定是"apply"，但接管的语义还包括"旧的请求全部作废"——
    // 排队里的都是针对上一个状态的低优先级请求，接管之后它们已经过期，
    // 留着会在某个 TTL 到期时把上一个状态的表情/动作偷偷贴回来（正是"最终一致式闪一下"）。
    if (op.force === true && this.queue.length > 0) {
      const dropped = this.queue.length;
      this.queue = [];
      this.log(`[pet] 入态接管，作废排队中的 ${dropped} 条旧请求`);
    }

    this.applyNow(op);
    return 'applied';
  }

  /**
   * 释放调度器：清掉所有定时器与队列。
   *
   * <p>不调用实现的 `dispose()`——那由持有实现的 `main.ts` 决定生命周期。</p>
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.layers.values()) {
      if (entry.timerHandle !== null) this.timer.clearTimeout(entry.timerHandle);
    }
    this.layers.clear();
    this.queue = [];
  }

  /**
   * 判定新指令能否立即应用。
   *
   * @param op 新指令
   * @param active 当前占主导的活动指令
   * @returns 判定结果
   */
  private decide(op: PresentationOp, active: ActiveEntry | null): InterruptDecision {
    return interruptDecision({
      incoming: op,
      active: this.toActiveState(active),
      sleeping: this.isSleeping(),
      activeMotion: this.state.motion,
      lastApplied: this.lastApplied,
      nowMs: this.now(),
    });
  }

  /**
   * 取拒绝/排队原因（日志用）。
   *
   * @param op 新指令
   * @param active 当前主导指令
   * @returns 原因字符串
   */
  private reasonOf(op: PresentationOp, active: ActiveEntry | null): string {
    return (
      suppressionReason({
        incoming: op,
        active: this.toActiveState(active),
        sleeping: this.isSleeping(),
        activeMotion: this.state.motion,
        lastApplied: this.lastApplied,
        nowMs: this.now(),
      }) ?? 'unknown'
    );
  }

  /**
   * 把内部层记录转成判定所需的快照。
   *
   * @param entry 层记录
   * @returns 活动指令快照；没有则 null
   */
  private toActiveState(entry: ActiveEntry | null): ActiveOpState | null {
    if (!entry) return null;
    return {
      layer: entry.op.layer,
      priority: entry.op.priority,
      remainingMs: entry.expiresAt === null ? null : Math.max(0, entry.expiresAt - this.now()),
      kind: entry.op.kind,
      id: String(entry.op.id),
    };
  }

  /**
   * 找当前"占主导"的活动指令：优先级最高者，同优先级取更"新"的（剩余更短）。
   *
   * <p>为什么要跨层取主导而不是只看同层：眨眼在 transient 层、生气表情在 base 层，
   * 只比同层会让"眨眼刷掉生气"这条规则失效（正是设计文档 §3.2 要防的场景）。</p>
   *
   * @returns 主导指令；没有任何活动指令时 null
   */
  private dominant(): ActiveEntry | null {
    let best: ActiveEntry | null = null;
    for (const entry of this.layers.values()) {
      if (!best) {
        best = entry;
        continue;
      }
      if (entry.op.priority > best.op.priority) {
        best = entry;
        continue;
      }
      if (entry.op.priority === best.op.priority) {
        const bestExpiry = best.expiresAt ?? Number.POSITIVE_INFINITY;
        const entryExpiry = entry.expiresAt ?? Number.POSITIVE_INFINITY;
        if (entryExpiry < bestExpiry) best = entry;
      }
    }
    return best;
  }

  /**
   * 立即应用一条指令，并挂上 TTL 定时器。
   *
   * @param op 待应用指令
   */
  private applyNow(op: PresentationOp): void {
    this.clearLayer(op.layer);
    const hasTtl = typeof op.durationMs === 'number' && op.durationMs > 0;
    const handle = hasTtl ? this.timer.setTimeout(() => this.onExpired(op.layer, op), op.durationMs as number) : null;
    this.layers.set(op.layer, {
      op,
      expiresAt: hasTtl ? this.now() + (op.durationMs as number) : null,
      timerHandle: handle,
    });
    this.lastApplied = { kind: op.kind, id: String(op.id), atMs: this.now() };
    this.target.apply(op);
  }

  /**
   * 清掉某一层的定时器与记录（同层新指令覆盖旧指令时调用）。
   *
   * @param layer 目标层
   */
  private clearLayer(layer: 'base' | 'transient' | 'ambient'): void {
    const entry = this.layers.get(layer);
    if (!entry) return;
    if (entry.timerHandle !== null) this.timer.clearTimeout(entry.timerHandle);
    this.layers.delete(layer);
  }

  /**
   * TTL 到期：先回落到主导指令，再执行排队指令。
   *
   * @param layer 到期的层
   * @param expired 到期的那条指令（防止旧定时器误删同层的新指令）
   */
  private onExpired(layer: 'base' | 'transient' | 'ambient', expired: PresentationOp): void {
    if (this.disposed) return;
    const current = this.layers.get(layer);
    // 同层已被更新的指令覆盖：这条到期事件作废
    if (!current || current.op !== expired) return;
    this.layers.delete(layer);

    const queued = this.queue.shift();
    if (queued) {
      this.applyNow(queued);
      return;
    }
    const dominant = this.dominant();
    if (dominant) {
      // 回落：把占主导的那条重新"应用"一遍，实现侧无需理解层概念
      this.target.apply(dominant.op);
      this.lastApplied = { kind: dominant.op.kind, id: String(dominant.op.id), atMs: this.now() };
      return;
    }
    this.log(`[pet] 层 ${layer} 到期后无可用指令（base 层被清空？）`);
  }

  /**
   * 供测试与调试面板读取当前某层的指令。
   *
   * @param layer 目标层
   * @returns 该层当前指令；没有则 null
   */
  peek(layer: 'base' | 'transient' | 'ambient'): PresentationOp | null {
    return this.layers.get(layer)?.op ?? null;
  }

  /**
   * 当前动作（拖拽抑制判定需要）。
   *
   * @returns 当前动作；没有则 null
   */
  activeMotion(): MotionId | null {
    return this.state.motion;
  }
}

/**
 * 安全序列化（日志用：循环引用或 JSON 失败时不能把渲染层带崩）。
 *
 * @param value 任意值
 * @returns 字符串
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
