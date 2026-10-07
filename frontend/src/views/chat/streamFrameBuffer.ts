/**
 * 流式文本渲染帧缓冲器。
 *
 * <p>在大模型高频吐字（100+ tokens/s）场景下，避免单个 token 直接触发 Vue 响应式依赖收集与 DOM 渲染。
 * 收集当前帧内的增量片段，在下一帧统一切片合并刷新，保持 60 FPS 平滑渲染。</p>
 */

type FrameScheduleHandler = (callback: () => void) => number;
type FrameCancelHandler = (id: number) => void;

const scheduleFrame: FrameScheduleHandler =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(cb, 16) as unknown as number;

const cancelFrame: FrameCancelHandler =
  typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : (id) => clearTimeout(id as any);

export class StreamFrameBuffer {
  private pendingTextChunks = new Map<string, string>();
  private pendingThinkingChunks = new Map<string, string>();
  private frameHandle: number | null = null;
  private readonly flushCallback: (textBatch: Map<string, string>, thinkBatch: Map<string, string>) => void;

  constructor(flushCallback: (textBatch: Map<string, string>, thinkBatch: Map<string, string>) => void) {
    this.flushCallback = flushCallback;
  }

  /** 追加正文增量文本 */
  public pushText(bubbleId: string, chunk: string): void {
    if (!chunk) return;
    const current = this.pendingTextChunks.get(bubbleId) ?? '';
    this.pendingTextChunks.set(bubbleId, current + chunk);
    this.requestFrameFlush();
  }

  /** 追加深度思考增量文本 */
  public pushThinking(bubbleId: string, chunk: string): void {
    if (!chunk) return;
    const current = this.pendingThinkingChunks.get(bubbleId) ?? '';
    this.pendingThinkingChunks.set(bubbleId, current + chunk);
    this.requestFrameFlush();
  }

  /** 安排帧末刷新 */
  private requestFrameFlush(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = scheduleFrame(() => {
      this.frameHandle = null;
      this.flushBufferedData();
    });
  }

  /** 立即同步刷新全部残留数据（遇到结构化事件如工具调用、终结事件时调用） */
  public flushImmediate(): void {
    if (this.frameHandle !== null) {
      cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.flushBufferedData();
  }

  private flushBufferedData(): void {
    if (this.pendingTextChunks.size === 0 && this.pendingThinkingChunks.size === 0) {
      return;
    }
    const textSnapshot = new Map(this.pendingTextChunks);
    const thinkSnapshot = new Map(this.pendingThinkingChunks);
    this.pendingTextChunks.clear();
    this.pendingThinkingChunks.clear();
    this.flushCallback(textSnapshot, thinkSnapshot);
  }
}
