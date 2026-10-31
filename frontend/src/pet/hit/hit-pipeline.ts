/**
 * 命中管线：把"每帧最多判一次 + 值变化才上报 + 主进程回执优先"收成一个门面。
 *
 * <p><b>现有节流逻辑是对的，本文件只做搬家，不重写：</b></p>
 * <ul>
 *   <li>`mousemove` 一次移动可能来几十次，直接判定 + IPC 会把主进程打满；</li>
 *   <li>只在**值变化**时回调，避免 `setIgnoreMouseEvents` 反复调用导致鼠标指针抖动；</li>
 *   <li>主进程的 `hit-state` 回执是权威值，收到就对齐本地状态，不再回声。</li>
 * </ul>
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
   * 强制回到穿透态（光标离开窗口 / 拖拽结束时调用）。
   *
   * <p>光标离开窗口后不会再有 `mousemove`，不主动清就会永久卡在"可交互"，
   * 表现为整块窗口吃掉桌面点击。</p>
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
