/**
 * 命中管线（**已降级为调试诊断器**，不再是穿透状态机入口）。
 *
 * <p><b>M2 重构后的定位：</b>命中归主进程独占判定（`electron/pet-hit-poller.cjs` 轮询系统光标），
 * 渲染层既不判定也不上报。本文件保留的唯一用途是：`?debug=1` 时在**本地视角**也算一遍，
 * 把"本地认为在立绘上"与"主进程认为可交互"两个视角并排打印——排查回声类缺陷时这是
 * 唯一能一眼看出"两边不一致"的手段（本次 `mouseleave → reset()` 回声就是靠它定位的）。</p>
 *
 * <p><b>为什么整体保留而不是删掉：</b>①删它会连带删掉 `tests/petHitTester.test.ts` 的 7 条
 * 既有用例，等于放宽基线；②它作为"本地视角采样器"仍有诊断价值。生产路径**不实例化**
 * （`main.ts` 里 `new HitPipeline(...)` 只在 `DEBUG_ENABLED` 分支），所以零成本、无回声。</p>
 *
 * <p><b>`reset()` 的语义也变了：</b>`emit(false)` 现在只作用于诊断回调，
 * **不再有 IPC 消费者**——它绝不会改变窗口的穿透状态。</p>
 *
 * <p>历史（保留以备追溯）：本文件曾承担"每帧最多判一次 + 值变化才上报 + 主进程回执优先"，
 * 其中"上报"那一环是缺陷根因，已随主进程接管一起删除。</p>
 *
 * @module pet/hit/hit-pipeline
 */
import type { HitTester } from './types';

/** 帧调度端口（可注入：node 里没有 rAF，测试用同步调度器）。 */
export interface FrameScheduler {
  /**
   * 请求下一帧。
   *
   * @param callback 帧回调
   * @returns 句柄
   */
  request(callback: () => void): number;
  /**
   * 取消一帧。
   *
   * @param handle 句柄
   */
  cancel(handle: number): void;
}

/**
 * 默认帧调度器：优先 `requestAnimationFrame`，没有则退回 16ms 定时器。
 *
 * <p>`requestAnimationFrame` 在窗口不可见时不产生帧——这正是我们要的（隐藏时不判定），
 * 但纯 node 环境下它不存在，所以要有兜底。</p>
 */
export const DEFAULT_FRAME_SCHEDULER: FrameScheduler = {
  request(callback: () => void): number {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
    return globalThis.setTimeout(callback, 16) as unknown as number;
  },
  cancel(handle: number): void {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle);
      return;
    }
    globalThis.clearTimeout(handle as unknown as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};

/** 命中状态变化回调。 */
export interface HitPipelineCallback {
  /**
   * 命中状态变化时调用（只在值真的变了时触发）。
   *
   * @param hit 是否命中
   */
  onHitChange(hit: boolean): void;
}

/**
 * 命中管线。
 *
 * <p>它是穿透状态机唯一的本地入口：`schedule()` 喂坐标，`reconcileFromMain()` 对齐权威值，
 * `reset()` 处理"光标离开窗口"这类必须强制回穿透的情况。</p>
 */
export class HitPipeline {
  /** 命中实现。 */
  private readonly tester: HitTester;

  /** 变化回调。 */
  private readonly callback: HitPipelineCallback;

  /** 帧调度器。 */
  private readonly frames: FrameScheduler;

  /** 待判定的坐标（每帧只取最后一个）。 */
  private pending: { x: number; y: number } | null = null;

  /** 已排队的帧句柄（0 = 没有排队）。 */
  private frame = 0;

  /** 当前命中状态。 */
  private current = false;

  /** 是否已释放。 */
  private disposed = false;

  /**
   * 构造命中管线。
   *
   * @param tester 命中实现
   * @param callback 变化回调
   * @param frames 帧调度器（测试注入）
   */
  constructor(tester: HitTester, callback: HitPipelineCallback, frames: FrameScheduler = DEFAULT_FRAME_SCHEDULER) {
    if (!tester) throw new TypeError('HitPipeline 需要一个 HitTester');
    if (!callback || typeof callback.onHitChange !== 'function') {
      throw new TypeError('HitPipeline 需要 onHitChange 回调');
    }
    this.tester = tester;
    this.callback = callback;
    this.frames = frames;
  }

  /** 当前命中状态（本地视角）。 */
  get hit(): boolean {
    return this.current;
  }

  /** 是否有帧在排队（测试用）。 */
  get framePending(): boolean {
    return this.frame !== 0;
  }

  /**
   * 喂一个坐标，每帧最多判定一次。
   *
   * @param viewX 视口 x（CSS px）
   * @param viewY 视口 y（CSS px）
   */
  schedule(viewX: number, viewY: number): void {
    if (this.disposed) return;
    this.pending = { x: viewX, y: viewY };
    if (this.frame) return;
    this.frame = this.frames.request(() => {
      this.frame = 0;
      const point = this.pending;
      this.pending = null;
      if (!point) return;
      this.emit(this.tester.test(point.x, point.y));
    });
  }

  /**
   * 对齐主进程回执（权威值，不再回声）。
   *
   * @param hit 主进程认为的命中状态
   */
  reconcileFromMain(hit: boolean): void {
    this.current = hit === true;
  }

  /**
   * 强制回到"未命中"（**仅影响诊断回调**）。
   *
   * <p>M2 重构前这里会经 `reportHit(false)` 把窗口切回穿透，而"切回穿透"本身又在 DOM 层
   * 制造 enter/leave ⇒ 同一个状态既因又果。现在渲染层没有上报通道，本方法只把本地视角
   * 复位，不会改变窗口状态。</p>
   */
  reset(): void {
    if (this.frame) {
      this.frames.cancel(this.frame);
      this.frame = 0;
    }
    this.pending = null;
    this.emit(false);
  }

  /** 释放：取消排队帧并丢掉待判定坐标。 */
  dispose(): void {
    this.disposed = true;
    if (this.frame) {
      this.frames.cancel(this.frame);
      this.frame = 0;
    }
    this.pending = null;
  }

  /**
   * 值变化才回调。
   *
   * @param next 新状态
   */
  private emit(next: boolean): void {
    if (next === this.current) return;
    this.current = next;
    this.callback.onHitChange(next);
  }
}
