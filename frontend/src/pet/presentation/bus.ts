/**
 * 表现层调度总线：把"指令"变成"何时应用到实现"。
 *
 * <p><b>它做三件事，别的都不做：</b></p>
 * <ol>
 *   <li>打断判定（委托 `priority.ts` 的纯函数，规则表只有一份实现）；</li>
 *   <li><b>槽位叠加与 TTL</b>：槽位键是 <b>`layer:kind`</b>（`base` / `transient` / `ambient`
 *       × `expression` / `motion` / `driven`）。表情与动作是两套独立叠加，
 *       一条到期只收自己那个槽，绝不"顶掉"另一条；</li>
 *   <li>排队（低优先级指令在活动指令剩余 ≤120ms 时排到其到期后执行，而不是直接丢弃）。</li>
 * </ol>
 *
 * <p><b>到期回落是显式的（M6-b 第四轮）：</b>表情槽到期 → 回落到 `base` 的 expression 槽
 * （当前期望的基础表情；槽空则落到常量 `neutral`）；动作槽到期 → 重放当前主导指令
 * （动作没有"基础动作"真源，下一次 `tick` 会重新下发）。
 * <b>绝不再"重放最后一条/最高优先级指令"</b>——那条路会让半闭眼皮（`sleepy` 贴片）
 * 到期后重放一条 motion，表情于是永久停在半闭眼，而 `sleepingNow()` 又把它读成"睡着了"，
 * 于是再也不眨眼。那条自锁链在第四轮被彻底切断。</p>
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
  /** 所属槽位键（`layer:kind`），排障日志与"同一槽位判重"都要用。 */
  readonly slot: SlotKey;
  /** 到期时间戳（毫秒）；null = 不会自行到期。 */
  readonly expiresAt: number | null;
  /** 该槽位的 TTL 定时器句柄。 */
  readonly timerHandle: number | null;
}

/**
 * 槽位键：**`layer:kind`**，不是只有 `layer`。
 *
 * <p><b>为什么必须是二维的（M6-b 第四轮的核心）：</b>表情（`expression`）与动作（`motion`）
 * 是两套<b>独立叠加</b>的表现。以前每层只有一个槽位，于是 `base` 槽先被 boot 的中性表情占着、
 * 又被后面的动作指令覆盖——眨眼（transient 层的 `blink` → `blinkHalf` 两条带 TTL 的指令）
 * 靠 TTL 到期"回落"来睁眼，而半闭帧到期时槽里只剩一条 <b>motion</b> 指令，
 * 重放它不会把脸改回 `neutral`，回落链当场断开：桌宠永久停在半闭眼。
 * 拆成 `(layer, kind)` 之后，表情的到期只影响表情槽，动作的到期只影响动作槽，
 * 一条到期再也不可能"顶掉"另一条。</p>
 */
type SlotKey = string;

/**
 * 合成槽位键。
 *
 * @param layer 目标层
 * @param kind 指令类别
 * @returns `layer:kind`
 */
function slotKeyOf(layer: PresentationOp['layer'], kind: PresentationOp['kind']): SlotKey {
  return `${layer}:${kind}`;
}

/**
 * 兜底基础表情：`base` 的 expression 槽为空时用它。
 *
 * <p>这是**显式常量**，不是"猜上一条指令"。`main.ts` 在 boot 时就会把
 * `neutral` 写进 base 的 expression 槽，正常情况下根本走不到这里；
 * 它只防"槽被清空"这一种异常，避免表现为"停在最后一张脸上"。</p>
 */
const FALLBACK_BASE_EXPRESSION = 'neutral' as const;

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

  /**
   * 各槽位当前生效的指令（键 = `layer:kind`）。
   *
   * <p>同一层里 expression 与 motion 各占一个槽：互相不覆盖、互不"顶占"。</p>
   */
  private readonly slots: Map<SlotKey, ActiveEntry> = new Map();

  /** 等待活动指令到期的队列（先进先出）。 */
  private queue: PresentationOp[] = [];

  /** 最近一次实际应用的指令（80ms 连点合并用；按**槽位**判重）。 */
  private lastApplied: { slot: SlotKey; id: string; atMs: number } | null = null;

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
    for (const entry of this.slots.values()) {
      if (entry.timerHandle !== null) this.timer.clearTimeout(entry.timerHandle);
    }
    this.slots.clear();
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
   * 把内部槽位记录转成判定所需的快照。
   *
   * @param entry 槽位记录
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
   * <p>为什么要跨槽位取主导而不是只看同层同 kind：眨眼是 `transient:expression`、
   * 生气表情是 `base:expression`、拖拽是 `base:motion`——
   * 只比同槽位会让"眨眼刷掉生气""拖拽中乱眨眼"这些规则失效（设计文档 §3.2）。</p>
   *
   * <p><b>它只用于"能不能打断"的判定，不用于"到期回落到谁"</b>（M6-b 第四轮）：
   * 回落在 {@link onExpired} 里按**显式目标**处理，绝不"重放最后一条/最高优先级指令"——
   * 那正是半闭眼皮到期后被重放成 motion、永远睁不开眼的原因。</p>
   *
   * @returns 主导指令；没有任何活动指令时 null
   */
  private dominant(): ActiveEntry | null {
    let best: ActiveEntry | null = null;
    for (const entry of this.slots.values()) {
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
   * <p>只清**同一槽位**（`layer:kind`）的旧记录：表情的新指令不会顶掉动作，反之亦然。</p>
   *
   * @param op 待应用指令
   */
  private applyNow(op: PresentationOp): void {
    const slot = slotKeyOf(op.layer, op.kind);
    this.clearSlot(slot);
    const hasTtl = typeof op.durationMs === 'number' && op.durationMs > 0;
    const handle = hasTtl ? this.timer.setTimeout(() => this.onExpired(slot, op), op.durationMs as number) : null;
    this.slots.set(slot, {
      op,
      slot,
      expiresAt: hasTtl ? this.now() + (op.durationMs as number) : null,
      timerHandle: handle,
    });
    this.lastApplied = { slot, id: String(op.id), atMs: this.now() };
    this.target.apply(op);
  }

  /**
   * 清掉某个槽位的定时器与记录（同槽位新指令覆盖旧指令时调用）。
   *
   * @param slot 槽位键（`layer:kind`）
   */
  private clearSlot(slot: SlotKey): void {
    const entry = this.slots.get(slot);
    if (!entry) return;
    if (entry.timerHandle !== null) this.timer.clearTimeout(entry.timerHandle);
    this.slots.delete(slot);
  }

  /**
   * TTL 到期：**按显式回落目标**收尾，再执行排队指令。
   *
   * <p><b>表情的回落目标是"base 的 expression 槽"（M6-b 第四轮）：</b>
   * 表情到期只该影响表情槽，之后脸必须回到<b>当前期望的基础表情</b>——
   * 也就是 `base:expression` 槽里那条（boot 时写入的 `neutral`，或被
   * `setExpression` 显式改掉的那一条）。拿不到就落到常量
   * {@link FALLBACK_BASE_EXPRESSION}，绝不"重放最高优先级指令"：
   * 那条路在半闭眼皮到期时会重放一条 <b>motion</b>，于是表情永远停在 `sleepy`。</p>
   *
   * <p><b>动作/参数档的回落：</b>它们没有"基础动作"这种全局真源
   * （下一次 `tick` 会重新下发 idle / 睡眠），这里只保证画面不停在半截：
   * 重放当前主导指令；连一条都没有就记日志。</p>
   *
   * @param slot 到期的槽位（`layer:kind`）
   * @param expired 到期的那条指令（防止旧定时器误删同槽位的新指令）
   */
  private onExpired(slot: SlotKey, expired: PresentationOp): void {
    if (this.disposed) return;
    const current = this.slots.get(slot);
    // 同槽位已被更新的指令覆盖：这条到期事件作废
    if (!current || current.op !== expired) return;
    this.slots.delete(slot);

    const queued = this.queue.shift();
    if (queued) {
      this.applyNow(queued);
      return;
    }

    if (expired.kind === 'expression') {
      this.applyBaseExpression(slot);
      return;
    }

    const dominant = this.dominant();
    if (dominant) {
      // 动作档没有"基础动作"真源：重放主导指令，避免画面停在半截
      this.target.apply(dominant.op);
      this.lastApplied = { slot: dominant.slot, id: String(dominant.op.id), atMs: this.now() };
      return;
    }
    this.log(`[pet] 槽位 ${slot} 到期后无可用指令`);
  }

  /**
   * 把表情回落到"基础表情"（显式目标，不猜）。
   *
   * <p>目标来源只有两个，按顺序取：</p>
   * <ol>
   *   <li>`base:expression` 槽里的那条指令（正常情况下是 `neutral`，由 boot 写入）；</li>
   *   <li>常量 {@link FALLBACK_BASE_EXPRESSION}（仅当槽被清空这种异常发生）。</li>
   * </ol>
   *
   * @param expiredSlot 到期的是哪个槽位（日志用）
   */
  private applyBaseExpression(expiredSlot: SlotKey): void {
    const base = this.slots.get(slotKeyOf('base', 'expression'));
    if (base && base.slot !== expiredSlot) {
      this.target.apply(base.op);
      this.lastApplied = { slot: base.slot, id: String(base.op.id), atMs: this.now() };
      return;
    }
    // base 的表情槽自己到期了（或从未写入）：落到中性脸，绝不停在半闭眼
    const op: PresentationOp = {
      kind: 'expression',
      id: FALLBACK_BASE_EXPRESSION,
      layer: 'base',
      priority: 0,
      fadeMs: 0,
      reason: 'bus:fallback:base-expression',
    };
    this.applyNow(op);
    this.log(`[pet] 表情回落：${expiredSlot} 到期且 base 表情槽为空，落到 ${FALLBACK_BASE_EXPRESSION}`);
  }

  /**
   * 供测试与调试面板读取某个槽位的指令。
   *
   * @param layer 目标层
   * @param kind 指令类别（**必须给**：同层里 expression 与 motion 是两个槽）
   * @returns 该槽位当前指令；没有则 null
   */
  peek(layer: PresentationOp['layer'], kind: PresentationOp['kind']): PresentationOp | null {
    return this.slots.get(slotKeyOf(layer, kind))?.op ?? null;
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
