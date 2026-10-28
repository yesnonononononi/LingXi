import { getApiBaseUrl } from '../utils/apiConfig';
import { readSseStream, type RawSseEvent } from './sse';

/** 应用只持有一条连接；所有重试与心跳计时都随关闭一起清理。 */
export class ApplicationEventStream {
  private controller?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private closed = true;
  private retryDelay = 1000;
  private generation = 0;

  private readonly onEvent: (event: RawSseEvent) => void;

  constructor(onEvent: (event: RawSseEvent) => void) {
    this.onEvent = onEvent;
  }

  start(): void {
    if (!this.closed) return;

    this.closed = false;
    void this.connect();
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.retryTimer);
    clearTimeout(this.heartbeatTimer);
  }

  reconnect(): void {
    this.controller?.abort();
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.refreshHeartbeat(controller);

    try {
      const response = await fetch(`${getApiBaseUrl()}/application/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error(`应用事件连接失败: status=${response.status}`);
      }

      await readSseStream(response, {
        signal: controller.signal,
        onEvent: event => {
          if (this.closed || generation !== this.generation || controller.signal.aborted) return;

          this.retryDelay = 1000;
          this.refreshHeartbeat(controller);
          this.onEvent(event);
        },
        onError: error => console.warn('读取应用事件失败:', error),
      });
    } catch (error) {
      if (!controller.signal.aborted) console.warn('连接应用事件失败:', error);
    } finally {
      controller.abort();
      if (generation !== this.generation) return;

      clearTimeout(this.heartbeatTimer);

      if (!this.closed) {
        this.retryTimer = setTimeout(() => void this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      }
    }
  }

  private refreshHeartbeat(controller: AbortController): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => controller.abort(), 45000);
  }
}
