/**
 * 微动态的"偶发长停顿"节奏器。
 *
 * <p><b>解决什么：</b>呼吸/摇摆的关键帧里已经有短停顿，但每个周期都一样长、一样顿，
 * 看久了还是能被摸出周期。人真正放松时的微动作是"动一阵、歇一阵"——这里就是那个"歇"。</p>
 *
 * <p><b>为什么不用 CSS 一条长动画凑：</b>停顿长度要随机，CSS 的 `animation` 无法在一次运行里
 * 改周期而不重启（重启会跳帧）。用 `animation-play-state: paused` 暂停再恢复可以保留相位，
 * 所以节奏由 JS 决定、只写一个 `data-*`，动画本身交给合成器。</p>
 *
 * <p><b>rng 与定时器全部注入</b>，因此本模块在 node 里可完整单测（不需要浏览器）。</p>
 *
 * @module pet/visual/motion-pacer
 */
import type { TimerPort } from '../presentation/bus';

/** 一段"动"的时长下界（毫秒）。 */
export const MOTION_ACTIVE_MIN_MS = 4200;

/** 一段"动"的时长上界（毫秒）。 */
export const MOTION_ACTIVE_MAX_MS = 9000;

/** 一次停顿的时长下界（毫秒）。 */
export const MOTION_REST_MIN_MS = 1200;

/** 一次停顿的时长上界（毫秒）。 */
export const MOTION_REST_MAX_MS = 3200;

/**
 * 每个"动"周期结束后真的进入停顿的概率（60%）。
 *
 * <p>不是 100%：每次都停会读成"卡住了"。留 40% 直接进入下一个动的周期，
 * 于是停顿的间隔本身也不规则。</p>
 */
export const MOTION_REST_PROBABILITY = 0.6;

/** 写入宿主的状态属性名（与 `pet.css` 的 `[data-motion-rest='1']` 对应）。 */
export const MOTION_REST_ATTRIBUTE = 'data-motion-rest';

/** 一个周期的节奏安排。 */
export interface MotionPace {
  /** 本次"动"多久（毫秒）。 */
  readonly activeMs: number;
  /** 随后停多久（毫秒）；0 = 本次不停顿。 */
  readonly restMs: number;
}

/**
 * 把随机数规整到 0..1（脏值按 0.5 处理）。
 *
 * @param value 原始随机数
 * @returns 落在 [0,1] 的值
 */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 抽样一个周期（**纯函数**）。
 *
 * @param rng 随机源（返回 0..1）
 * @returns 本周期"动多久 + 停多久"
 */
export function nextMotionPace(rng: () => number): MotionPace {
  const activeMs = Math.round(MOTION_ACTIVE_MIN_MS + unit(rng()) * (MOTION_ACTIVE_MAX_MS - MOTION_ACTIVE_MIN_MS));
  const restRoll = unit(rng());
  const restMs =
    restRoll < MOTION_REST_PROBABILITY
      ? Math.round(MOTION_REST_MIN_MS + unit(rng()) * (MOTION_REST_MAX_MS - MOTION_REST_MIN_MS))
      : 0;
  return { activeMs, restMs };
}

/**
 * 节奏器：按 {@link nextMotionPace} 的结果在"动/歇"之间切换。
 *
 * <p>只回调一个布尔值，由调用方决定写到哪个元素上（渲染层写 `data-*` 的唯一出口在 main.ts）。</p>
 */
export class MotionPacer {
  /** 进入/退出停顿的回调。 */
  private readonly onRest: (resting: boolean) => void;

  /** 随机源。 */
  private readonly rng: () => number;

  /** 定时器端口。 */
  private readonly timer: TimerPort;

  /** 当前待执行的定时器句柄。 */
  private handle: number | null = null;

  /** 是否在运行。 */
  private running = false;

  /** 当前是否处于停顿。 */
  private resting = false;

  /**
   * 构造节奏器。
   *
   * @param onRest 进入/退出停顿的回调
   * @param rng 随机源
   * @param timer 定时器端口
   */
  constructor(onRest: (resting: boolean) => void, rng: () => number, timer: TimerPort) {
    if (typeof onRest !== 'function') throw new TypeError('MotionPacer 需要 onRest 回调');
    if (typeof rng !== 'function') throw new TypeError('MotionPacer 需要 rng');
    if (!timer || typeof timer.setTimeout !== 'function' || typeof timer.clearTimeout !== 'function') {
      throw new TypeError('MotionPacer 需要合法的定时器端口');
    }
    this.onRest = onRest;
    this.rng = rng;
    this.timer = timer;
  }

  /** 是否在运行。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 当前是否在停顿。 */
  get isResting(): boolean {
    return this.resting;
  }

  /** 启动（重复调用无副作用）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleActive();
  }

  /** 停止并回到"在动"状态（窗口隐藏、减少动态时调用）。 */
  stop(): void {
    this.running = false;
    this.clearHandle();
    if (this.resting) {
      this.resting = false;
      this.onRest(false);
    }
  }

  /** 排下一个"动"的周期。 */
  private scheduleActive(): void {
    const pace = nextMotionPace(this.rng);
    this.handle = this.timer.setTimeout(() => {
      this.handle = null;
      if (!this.running) return;
      if (pace.restMs <= 0) {
        this.scheduleActive();
        return;
      }
      this.resting = true;
      this.onRest(true);
      this.handle = this.timer.setTimeout(() => {
        this.handle = null;
        if (!this.running) return;
        this.resting = false;
        this.onRest(false);
        this.scheduleActive();
      }, pace.restMs);
    }, pace.activeMs);
  }

  /** 清掉待执行的定时器。 */
  private clearHandle(): void {
    if (this.handle === null) return;
    this.timer.clearTimeout(this.handle);
    this.handle = null;
  }
}
