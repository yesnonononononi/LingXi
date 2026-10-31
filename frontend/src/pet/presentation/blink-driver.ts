/**
 * 眨眼调度器（本批性价比最高的"活"感）。
 *
 * <p><b>为什么眨眼值得单开一个模块：</b>人眼对"眼睛动"的敏感度远高于任何身体动作。而眨眼是
 * 唯一一个**观察者会主动期待**的微动态——一只 209px 高的立牌如果能眨，人就读成"活的"；
 * 不会眨，读成"贴纸"。</p>
 *
 * <p><b>三态驱动（美术规格书 §5 的眼皮三态）：</b>一次眨眼不是两态而是三态
 * `open → closed(100ms) → half(80ms) → open`：只做"睁/闭"会像机器人眨眼；
 * 中间那 80ms 的半闭（复用 E8 困倦贴片的眼区）才是自然的关键帧。
 * 三个状态都用**已有枚举 id**，所以工程侧零新契约。</p>
 *
 * <p><b>为什么随机必须注入 `rng`：</b>测试要断言"间隔落在 2.5–6.5s、双眨概率 12%"，
 * 直接 `Math.random()` 就只能测"看起来很随机"——那不叫测试。</p>
 *
 * @module pet/presentation/blink-driver
 */
import type { TimerPort } from './bus';
import type { PresentationOp } from './types';

/** 眨眼"闭眼"相位时长（毫秒）。 */
export const BLINK_CLOSED_MS = 100;

/** 眨眼"半闭"相位时长（毫秒）。 */
export const BLINK_HALF_MS = 80;

/** 眨眼总时长（毫秒）：闭 + 半闭。 */
/** 眨眼总时长（毫秒）：闭 + 半闭。 */
export const BLINK_TOTAL_MS = BLINK_CLOSED_MS + BLINK_HALF_MS;

/** 眨眼间隔下限（毫秒）。 */
export const BLINK_MIN_DELAY_MS = 2500;

/** 眨眼间隔上限（毫秒）。 */
export const BLINK_MAX_DELAY_MS = 6500;

/** 偶发双眨的概率（12%）。 */
export const DOUBLE_BLINK_PROBABILITY = 0.12;

/** 双眨中第二次眨眼的延迟（毫秒）。 */
export const DOUBLE_BLINK_GAP_MS = 220;

/**
 * 生成"闭眼"指令。
 *
 * @param reason 排障原因串
 * @returns 闭眼 op（transient 层，优先级 0）
 */
export function blinkClosedOp(reason: string): PresentationOp {
  return {
    kind: 'expression',
    id: 'blink',
    layer: 'transient',
    priority: 0,
    durationMs: BLINK_CLOSED_MS,
    fadeMs: 0,
    reason,
  };
}

/**
 * 生成"半闭"指令（眼皮三态的中间帧，复用 E8 的眼区）。
 *
 * @param reason 排障原因串
 * @returns 半闭 op（transient 层，优先级 0）
 */
export function blinkHalfOp(reason: string): PresentationOp {
  return {
    kind: 'expression',
    id: 'sleepy',
    layer: 'transient',
    priority: 0,
    durationMs: BLINK_HALF_MS,
    fadeMs: 0,
    reason,
  };
}

/** 眨眼计时器端口（与调度总线共用同一套抽象）。 */
export type BlinkTimerPort = TimerPort;

/**
 * 眨眼调度器。
 *
 * <p>它只**产出 op**，不直接改 DOM：谁消费由 `PresentationBus` 决定。
 * 这样换 Live2D 时眨眼逻辑一行不用改（库自带 eye-blink 时把本类停用即可）。</p>
 */
export class BlinkDriver {
  /** 指令出口。 */
  private readonly emit: (op: PresentationOp) => void;

  /** 随机源（0..1）。 */
  private readonly rng: () => number;

  /** 睡眠判定（睡眠时不眨眼）。 */
  private readonly isSleeping: () => boolean;

  /** 定时器端口。 */
  private readonly timer: BlinkTimerPort;

  /** 未清掉的定时器句柄。 */
  private readonly handles: Set<number> = new Set();

  /** 是否在运行。 */
  private running = false;

  /**
   * 构造眨眼调度器。
   *
   * @param emit 指令出口
   * @param rng 随机源（0..1）
   * @param isSleeping 睡眠判定
   * @param timer 定时器端口（测试注入假定时器）
   */
  constructor(
    emit: (op: PresentationOp) => void,
    rng: () => number,
    isSleeping: () => boolean,
    timer: BlinkTimerPort,
  ) {
    if (typeof emit !== 'function') throw new TypeError('BlinkDriver 需要 emit 回调');
    if (typeof rng !== 'function') throw new TypeError('BlinkDriver 需要 rng');
    if (typeof isSleeping !== 'function') throw new TypeError('BlinkDriver 需要 isSleeping');
    if (!timer || typeof timer.setTimeout !== 'function' || typeof timer.clearTimeout !== 'function') {
      throw new TypeError('BlinkDriver 需要合法的定时器端口');
    }
    this.emit = emit;
    this.rng = rng;
    this.isSleeping = isSleeping;
    this.timer = timer;
  }

  /** 是否在运行。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 启动：排下一次眨眼。重复调用无副作用。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.nextDelayMs());
  }

  /** 停止：清掉所有待执行的定时器（窗口隐藏、减少动态时调用）。 */
  stop(): void {
    this.running = false;
    for (const handle of this.handles) {
      this.timer.clearTimeout(handle);
    }
    this.handles.clear();
  }

  /**
   * 下一次眨眼的间隔（2500 + rng × 4000 → 2.5~6.5s）。
   *
   * @returns 间隔毫秒（整数）
   */
  nextDelayMs(): number {
    const value = this.rng();
    const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    return BLINK_MIN_DELAY_MS + Math.round(normalized * (BLINK_MAX_DELAY_MS - BLINK_MIN_DELAY_MS));
  }

  /**
   * 本次是否触发双眨（概率 12%）。
   *
   * @returns 是否双眨
   */
  shouldDoubleBlink(): boolean {
    const value = this.rng();
    return (Number.isFinite(value) ? value : 1) < DOUBLE_BLINK_PROBABILITY;
  }

  /**
   * 排一个定时器并登记句柄（`stop()` 时统一清理）。
   *
   * @param delayMs 延迟毫秒
   * @param handler 到期回调
   * @returns 句柄
   */
  private schedule(delayMs: number, handler: () => void = () => this.tick()): number {
    const handle = this.timer.setTimeout(() => {
      this.handles.delete(handle);
      if (!this.running) return;
      handler();
    }, delayMs);
    this.handles.add(handle);
    return handle;
  }

  /** 一次眨眼节拍。 */
  private tick(): void {
    if (!this.running) return;
    if (this.isSleeping()) {
      // 睡觉不该眨眼：直接排下一轮，不产出任何 op
      this.schedule(this.nextDelayMs());
      return;
    }
    this.emitBlink('blink-scheduler');
    if (this.shouldDoubleBlink()) {
      // 偶发双眨：220ms 后再来一次，人眼读成"连眨两下"而不是"手抖"
      this.schedule(DOUBLE_BLINK_GAP_MS, () => this.emitBlink('blink-scheduler:double'));
    }
    this.schedule(this.nextDelayMs());
  }

  /**
   * 产出一次完整三态眨眼（闭 → 半闭）。
   *
   * @param reason 排障原因串前缀
   */
  private emitBlink(reason: string): void {
    if (!this.running || this.isSleeping()) return;
    this.emit(blinkClosedOp(reason));
    // 半闭必须在"闭"之后立即排队，否则调度总线在闭眼到期时会先回落成睁眼
    this.schedule(BLINK_CLOSED_MS, () => {
      if (!this.running || this.isSleeping()) return;
      this.emit(blinkHalfOp(`${reason}:half`));
    });
  }
}
