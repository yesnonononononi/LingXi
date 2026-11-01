/**
 * 表情交叉过渡（cross-fade）的可配置核心。
 *
 * <p><b>为什么单开一个模块：</b>过渡时长与缓动是"人眼调出来的参数"，散在 CSS 与 TS 两处
 * 必然会漂移。这里把<b>取值规则</b>（钳制、回落、序列化）与<b>过渡的生命周期</b>
 * （谁在淡入、上一次要不要取消）都收成纯数据 + 纯类，于是能在 node 里直接断言，
 * 不用起浏览器。</p>
 *
 * <p><b>为什么必须有"取消上一次"：</b>连点表情时每次切换都会开一段 100ms 的淡入。
 * 若不取消，上一次的淡入回调会在新过渡开始后才落地，把"已经被换掉的帧"重新点亮，
 * 表现为"表情回闪一下"。{@link CrossfadePlanner} 用单调递增的 token 解决：
 * 新过渡一开，旧 token 立刻失效，旧回调自查 `isCurrent` 后自行放弃。</p>
 *
 * <p><b>为什么是 80–120ms：</b>低于 80ms 人眼读成硬切（本批要解决的就是硬切），
 * 高于 120ms 表情"发懒"，点击反馈变钝。默认 100ms 取中。</p>
 *
 * @module pet/presentation/crossfade
 */

/** 交叉过渡时长下限（毫秒）。低于此值等于硬切。 */
export const CROSSFADE_MIN_MS = 80;

/** 交叉过渡时长上限（毫秒）。高于此值点击反馈发钝。 */
export const CROSSFADE_MAX_MS = 120;

/** 默认过渡时长（毫秒）。 */
export const DEFAULT_CROSSFADE_MS = 100;

/**
 * 默认缓动。
 *
 * <p>用 `cubic-bezier(0.33, 0, 0.2, 1)` 而不是 `linear`：线性淡入在 100ms 这种短时长上
 * 会读成"两帧同时变淡"的糊感；起步快、收尾缓的曲线读成"新表情压上来了"。</p>
 */
export const DEFAULT_CROSSFADE_EASING = 'cubic-bezier(0.33, 0, 0.2, 1)';

/** 写入宿主的 CSS 变量名（与 `pet.css` 的 `var(--pet-crossfade-*)` 一一对应）。 */
export const CROSSFADE_CSS_VARIABLES = {
  /** 过渡时长。 */
  duration: '--pet-crossfade-ms',
  /** 过渡缓动。 */
  easing: '--pet-crossfade-ease',
} as const;

/** 过渡配置（全部可缺省）。 */
export interface CrossfadeSpec {
  /** 期望时长（毫秒）；会被钳制到 {@link CROSSFADE_MIN_MS}..{@link CROSSFADE_MAX_MS}。 */
  readonly durationMs?: number;
  /** 期望缓动（CSS `transition-timing-function` 语法）；空串回落默认值。 */
  readonly easing?: string;
}

/** 解析后的过渡配置。 */
export interface ResolvedCrossfade {
  /** 实际时长（毫秒，整数，已钳制）。 */
  readonly durationMs: number;
  /** 实际缓动。 */
  readonly easing: string;
  /** 可直接写进 CSS 的 `transition` 时间部分（`"100ms cubic-bezier(...)"`）。 */
  readonly cssTransition: string;
}

/**
 * 归一化过渡配置：钳制时长、回落缓动。
 *
 * @param spec 期望配置（可缺省或给脏值）
 * @returns 解析后的配置（保证落在合法区间内）
 */
export function resolveCrossfade(spec: CrossfadeSpec = {}): ResolvedCrossfade {
  const raw = spec?.durationMs;
  const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_CROSSFADE_MS;
  const durationMs = Math.round(Math.min(CROSSFADE_MAX_MS, Math.max(CROSSFADE_MIN_MS, numeric)));
  const easingRaw = spec?.easing;
  const easing =
    typeof easingRaw === 'string' && easingRaw.trim().length > 0 ? easingRaw.trim() : DEFAULT_CROSSFADE_EASING;
  return { durationMs, easing, cssTransition: `${durationMs}ms ${easing}` };
}

/** 一次过渡的计划（由 {@link CrossfadePlanner} 产出）。 */
export interface CrossfadePlan {
  /** 本次过渡的令牌（单调递增）。用于"过期回调自救"。 */
  readonly token: number;
  /** 淡出帧的下标（0 / 1）。 */
  readonly fromIndex: 0 | 1;
  /** 淡入帧的下标（0 / 1）。 */
  readonly toIndex: 0 | 1;
  /** 被本次过渡取消掉的上一次过渡令牌；没有则 null。 */
  readonly cancelledToken: number | null;
  /** 本次过渡时长（毫秒）。 */
  readonly durationMs: number;
  /** 本次过渡缓动。 */
  readonly easing: string;
}

/**
 * 过渡规划器：只管令牌与"同一时刻最多一段过渡"，不碰 DOM。
 *
 * <p>双缓冲只有两张帧，所以"复用"是结构性的：调用方永远从"当前可见帧"出发，
 * 目标帧就是另一张。规划器额外保证：<b>任何时刻最多一段未完成过渡</b>，
 * 新的一开就把旧的一作废（{@link CrossfadePlan.cancelledToken}）。</p>
 */
export class CrossfadePlanner {
  /** 令牌发号器。 */
  private sequence = 0;

  /** 当前未完成过渡的令牌；null = 没有过渡在飞。 */
  private inFlight: number | null = null;

  /**
   * 规划下一次过渡（并立刻作废上一次未完成的过渡）。
   *
   * @param fromIndex 淡出帧下标
   * @param toIndex 淡入帧下标
   * @param spec 过渡配置
   * @returns 过渡计划
   * @throws TypeError 当下标不合法（只允许 0 / 1 且两者不同）
   */
  plan(fromIndex: 0 | 1, toIndex: 0 | 1, spec: CrossfadeSpec = {}): CrossfadePlan {
    if ((fromIndex !== 0 && fromIndex !== 1) || (toIndex !== 0 && toIndex !== 1)) {
      throw new TypeError('CrossfadePlanner 的下标只能是 0 或 1');
    }
    if (fromIndex === toIndex) {
      throw new TypeError('CrossfadePlanner 的来去下标必须不同（双缓冲互斥）');
    }
    const cancelledToken = this.inFlight;
    this.sequence += 1;
    const token = this.sequence;
    this.inFlight = token;
    const resolved = resolveCrossfade(spec);
    return {
      token,
      fromIndex,
      toIndex,
      cancelledToken,
      durationMs: resolved.durationMs,
      easing: resolved.easing,
    };
  }

  /**
   * 判断某个令牌是否仍是最新的一次过渡。
   *
   * <p>异步回调（等帧解码、等过渡结束）落地前必须问一次，否则会把已经作废的过渡
   * 应用到画面上。</p>
   *
   * @param token 令牌
   * @returns 是否仍然有效
   */
  isCurrent(token: number): boolean {
    return this.inFlight === token;
  }

  /**
   * 标记某次过渡已完成。
   *
   * @param token 令牌
   * @returns 是否真的收尾了（过期令牌返回 false）
   */
  complete(token: number): boolean {
    if (this.inFlight !== token) return false;
    this.inFlight = null;
    return true;
  }

  /** 主动取消当前过渡（释放时用）。 */
  cancel(): void {
    this.inFlight = null;
  }

  /** 当前是否有过渡在飞。 */
  get isTransitioning(): boolean {
    return this.inFlight !== null;
  }

  /** 当前在飞的令牌；没有则 null。 */
  get pendingToken(): number | null {
    return this.inFlight;
  }
}
