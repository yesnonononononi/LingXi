/**
 * 眨眼调度器（本批性价比最高的"活"感）。
 *
 * <p><b>为什么眨眼值得单开一个模块：</b>人眼对"眼睛动"的敏感度远高于任何身体动作。而眨眼是
 * 唯一一个**观察者会主动期待**的微动态——一只 209px 高的立牌如果能眨，人就读成"活的"；
 * 不会眨，读成"贴纸"。</p>
 *
 * <p><b>眨眼是"两态起、三态好"（M1 起）</b>：理想节奏是
 * `open → closed(100ms) → half(80ms) → open`——只做"睁/闭"会像机器人眨眼，中间那 80ms 的
 * 半闭是关键帧。但半闭帧（`blinkHalf`）是<b>独立资产</b>，美术未交付时必须退化成两态
 * （`open → closed → open`），**绝不拿 `sleepy`（困倦整脸）顶上**：
 * 那会让嘴型跟着每次眨眼抖一下（设计文档 §5.1 记录的真实缺陷）。
 * 资产是否可用由构造参数 `hasHalf` 注入（`main.ts` 从 `pet-face-tiles.json` 的 `degraded` 读）。</p>
 *
 * <p><b>为什么随机必须注入 `rng`：</b>测试要断言"短间隔分支占比 22%、长间隔更常见"，
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

/** 眨眼间隔下限（毫秒）：短间隔分支的下界。 */
export const BLINK_SHORT_MIN_DELAY_MS = 900;

/** 短间隔分支的上界（毫秒）。 */
export const BLINK_SHORT_MAX_DELAY_MS = 2000;

/** 长间隔分支的下界（毫秒）。 */
export const BLINK_LONG_MIN_DELAY_MS = 3200;

/** 长间隔分支的上界（毫秒）。 */
export const BLINK_LONG_MAX_DELAY_MS = 9000;

/**
 * 走"短间隔"分支的概率（22%）。
 *
 * <p>真人眨眼不是等间隔：大部分时候隔几秒眨一次，但偶尔会连着眨两三下
 * （累、干、进了东西）。22% 的短间隔让"偶发连眨"能被看见，又不至于读成抽搐。</p>
 */
export const BLINK_SHORT_GAP_PROBABILITY = 0.22;

/**
 * 长间隔分支的长端偏置（>1 = 偏长）。
 *
 * <p>把均匀分布 `u` 变成 `u^(1/1.8)`，取值整体往 1 推——于是"4 秒左右眨一次"
 * 比"8.5 秒才眨一次"更常见，但长间隔仍有可观的机会出现。这就是"长间隔更常见"。</p>
 */
export const BLINK_LONG_SKEW = 1.8;

/** 整个分布的下界（毫秒）。 */
export const BLINK_MIN_DELAY_MS = BLINK_SHORT_MIN_DELAY_MS;

/** 整个分布的上界（毫秒）。 */
export const BLINK_MAX_DELAY_MS = BLINK_LONG_MAX_DELAY_MS;

/** 偶发双眨的概率（12%）。 */
export const DOUBLE_BLINK_PROBABILITY = 0.12;

/** 双眨中第二次眨眼的延迟（毫秒）。 */
export const DOUBLE_BLINK_GAP_MS = 220;

/**
 * 眨眼三态映射（**与美术 `docs/assets/desktop-pet/v4/manifest.json` 的 `blink` 字段一致**）。
 *
 * <p><b>M1 把 `half` 从 `sleepy` 改成 `blinkHalf`（设计文档 §5.1/§5.2）：</b>
 * 旧映射把"半闭"指向了 E8 困倦整脸，于是每次眨眼的中段帧都带困倦<b>嘴型</b>，
 * 0.9–9s 抖一下嘴——这正是 M1 要消灭的缺陷。`blinkHalf` 是"眼睑半闭、嘴型与 neutral 一致"
 * 的独立档；它未交付时 {@link BlinkDriver} 直接走两态（睁→闭→睁），**任何情况下都不许
 * 回落 `sleepy`**（那是"禁止困倦嘴型随眨眼跳动"的机器化表达）。</p>
 *
 * <p>`wink`（单眼闭合）也在这里登记，但它**不参与眨眼调度**：它只由行为层一次性下发
 * （`behavior:pet-end`，priority 1、600ms）。写进映射表是为了让美术清单的三方对账有落点，
 * 不是让 BlinkDriver 去播它。</p>
 */
export const BLINK_EXPRESSION_MAP = {
  /** 睁眼。 */
  open: 'neutral',
  /** 闭眼（双眼闭合）。 */
  closed: 'blink',
  /** 半闭（三态中间帧；资产未交付时跳过这一态，见 `hasHalf`）。 */
  half: 'blinkHalf',
  /** 情绪 wink（单眼闭合，**不参与眨眼调度**，只用于对账）。 */
  wink: 'wink',
} as const;

/**
 * 生成"闭眼"指令。
 *
 * @param reason 排障原因串
 * @returns 闭眼 op（transient 层，优先级 0）
 */
export function blinkClosedOp(reason: string): PresentationOp {
  return {
    kind: 'expression',
    id: BLINK_EXPRESSION_MAP.closed,
    layer: 'transient',
    priority: 0,
    durationMs: BLINK_CLOSED_MS,
    fadeMs: 0,
    reason,
  };
}

/**
 * 生成"半闭"指令（眼皮三态的中间帧）。
 *
 * @param reason 排障原因串
 * @returns 半闭 op（transient 层，优先级 0）
 */
export function blinkHalfOp(reason: string): PresentationOp {
  return {
    kind: 'expression',
    id: BLINK_EXPRESSION_MAP.half,
    layer: 'transient',
    priority: 0,
    durationMs: BLINK_HALF_MS,
    fadeMs: 0,
    reason,
  };
}

/**
 * 半闭帧资产是否可用（默认**不可用**）。
 *
 * <p>默认值取 `false` 而不是 `true`：忘了注入时应当退化成"两态眨眼"（无害、可看），
 * 而不是去请求一张不存在的贴片。真值由 `main.ts` 从 `pet-face-tiles.json` 的
 * `degraded` 读取（`isFaceDegraded('blinkHalf')`），单一真源在那里。</p>
 *
 * @returns 恒 false（未注入时的保守缺省）
 */
function noHalfAvailable(): boolean {
  return false;
}

/** 眨眼计时器端口（与调度总线共用同一套抽象）。 */
export type BlinkTimerPort = TimerPort;

/**
 * 把随机数规整到 0..1（脏值按 0.5 处理，不能因为 rng 返回 NaN 把间隔算成 NaN）。
 *
 * @param value 原始随机数
 * @returns 落在 [0,1] 的值
 */
export function normalizeUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 抽样一次眨眼间隔（**纯函数**，随机源由调用方给）。
 *
 * <p>两个分支：</p>
 * <ul>
 *   <li>短间隔（概率 {@link BLINK_SHORT_GAP_PROBABILITY}）：0.9–2.0s，表现为"连眨"；</li>
 *   <li>长间隔：3.2–9.0s，且用 `u^(1/BLINK_LONG_SKEW)` 把取值往长端推，
 *       使"几秒一次"明显比"接近 9 秒"更常见。</li>
 * </ul>
 *
 * <p>短分支先消耗一次 rng 做概率判定，再消耗一次取值；长分支同理。
 * 两次取值分开是为了让测试能用固定序列精确断言两个分支。</p>
 *
 * @param rng 随机源（返回 0..1）
 * @returns 间隔毫秒（整数，落在 [{@link BLINK_MIN_DELAY_MS}, {@link BLINK_MAX_DELAY_MS}]）
 */
export function nextBlinkDelayMs(rng: () => number): number {
  const gate = normalizeUnit(rng());
  if (gate < BLINK_SHORT_GAP_PROBABILITY) {
    const u = normalizeUnit(rng());
    return Math.round(BLINK_SHORT_MIN_DELAY_MS + u * (BLINK_SHORT_MAX_DELAY_MS - BLINK_SHORT_MIN_DELAY_MS));
  }
  const u = normalizeUnit(rng());
  // 指数 <1 把取值推向上界 → 长间隔比短间隔更常见（但两端都够得着）
  const skewed = Math.pow(u, 1 / BLINK_LONG_SKEW);
  return Math.round(BLINK_LONG_MIN_DELAY_MS + skewed * (BLINK_LONG_MAX_DELAY_MS - BLINK_LONG_MIN_DELAY_MS));
}

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

  /** 半闭帧资产是否可用（`pet-face-tiles.json` 的 `degraded` 反读；false = 两态眨眼）。 */
  private readonly hasHalf: () => boolean;

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
   * @param hasHalf 半闭帧资产是否可用（缺省 false = 两态眨眼）
   */
  constructor(
    emit: (op: PresentationOp) => void,
    rng: () => number,
    isSleeping: () => boolean,
    timer: BlinkTimerPort,
    hasHalf: () => boolean = noHalfAvailable,
  ) {
    if (typeof emit !== 'function') throw new TypeError('BlinkDriver 需要 emit 回调');
    if (typeof rng !== 'function') throw new TypeError('BlinkDriver 需要 rng');
    if (typeof isSleeping !== 'function') throw new TypeError('BlinkDriver 需要 isSleeping');
    if (!timer || typeof timer.setTimeout !== 'function' || typeof timer.clearTimeout !== 'function') {
      throw new TypeError('BlinkDriver 需要合法的定时器端口');
    }
    if (typeof hasHalf !== 'function') throw new TypeError('BlinkDriver 的 hasHalf 必须是函数');
    this.emit = emit;
    this.rng = rng;
    this.isSleeping = isSleeping;
    this.timer = timer;
    this.hasHalf = hasHalf;
  }

  /** 半闭帧当前是否可用（调试与测试用）。 */
  get halfAvailable(): boolean {
    try {
      return this.hasHalf() === true;
    } catch {
      // 探测失败按"没有资产"处理：宁可爱两态，也不要 throw 把眨眼整体带崩
      return false;
    }
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
   * 下一次眨眼的间隔（走 {@link nextBlinkDelayMs} 的混合分布）。
   *
   * @returns 间隔毫秒（整数）
   */
  nextDelayMs(): number {
    return nextBlinkDelayMs(this.rng);
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
   * 产出一次完整眨眼（闭 → 半闭）。
   *
   * <p><b>半闭帧缺失时只产出闭眼那一条（两态）</b>：不会补一条 `sleepy`/`wink` 顶上——
   * 那是"拿别的表情假装眨眼"，用户会看到嘴型/眼皮语义错乱（§5.2 第 3 条）。</p>
   *
   * @param reason 排障原因串前缀
   */
  private emitBlink(reason: string): void {
    if (!this.running || this.isSleeping()) return;
    this.emit(blinkClosedOp(reason));
    if (!this.halfAvailable) return;
    // 半闭必须在"闭"之后立即排队，否则调度总线在闭眼到期时会先回落成睁眼
    this.schedule(BLINK_CLOSED_MS, () => {
      if (!this.running || this.isSleeping()) return;
      this.emit(blinkHalfOp(`${reason}:half`));
    });
  }
}
