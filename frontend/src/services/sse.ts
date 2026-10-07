/**
 * SSE 流式响应解析。
 *
 * <p>只做一件事：把 `text/event-stream` 响应体切成一条条事件，并把 data 反序列化成对象。
 * 不含业务语义、不含渲染、不关心事件名是怎么来的。</p>
 *
 * <p><b>用途</b>：当前唯一消费者是会话级事件流（{@code GET /a/completion/{sessionId}/events}）。
 * 旧的请求级流（{@code POST /a/completion/stream}）已删除，但本模块是<b>传输层能力</b>，
 * 与「用哪种方式建立流」无关，故保留。</p>
 */

/**
 * 一条已解析的 SSE 事件（传输层原始形态）。
 *
 * <p>本层不做业务判别：`event` 只是服务端下发的名字，`data` 只是 JSON.parse 的结果。
 * 业务侧的事件契约（每个事件名的具体载荷）见 `types/Event.ts`，由调用方在边界收窄。</p>
 */
export interface RawSseEvent<T = unknown> {
  /** 事件名（服务端下发，通常等于事件体的 type）。 */
  event: string;
  /** 反序列化后的事件体；解析失败为 null，原文见 raw。 */
  data: T | null;
  /** data 行原文，解析失败时用于排查。 */
  raw: string;
}

/** {@link readSseStream} 的选项。 */
export interface ReadSseStreamOptions {
  /** 每解析出一条事件回调一次。 */
  onEvent: (event: RawSseEvent) => void;
  /** 中止句柄；触发 abort 会中断读取，且不会走 onError。 */
  signal?: AbortSignal;
  /** 流被服务端正常关闭时回调。 */
  onDone?: () => void;
  /** 读取出错时回调；主动 abort 不算错误。 */
  onError?: (error: unknown) => void;
}

/**
 * 读取一条 SSE 响应流，逐条回调解析后的事件。
 *
 * <p>按字节流读、按 `\n\n` 切块、跨 chunk 缓冲半截事件。中止靠 `signal`：</p>
 *
 * <pre>
 * const controller = new AbortController();
 * const response = await AgentAPI.subscribeSessionEvents(sessionId, controller.signal);
 * await readSseStream(response, {
 *   signal: controller.signal,
 *   onEvent: ({ event, data }) => handleEvent(event, data),
 * });
 * </pre>
 *
 * @param response SSE 响应
 * @param options  回调与中止句柄
 */
export async function readSseStream(
  response: Response,
  options: ReadSseStreamOptions
): Promise<void> {
  const { onEvent, signal, onDone, onError } = options;

  if (!response.body) {
    onError?.(new Error('响应没有可读的 body，无法读取 SSE 流'));
    return;
  }

  // 必须按字节流读：response.text() 会等整条流结束，等于没有实时性。
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  // 光把 signal 交给 fetch 不够：响应头早已返回，此后 abort 不会再让 fetch 拒绝。
  // 必须显式取消 reader，让挂起的 read() 以 AbortError 结束。
  const onAbort = (): void => { void reader.cancel(); };
  signal?.addEventListener('abort', onAbort, { once: true });

  /** 跨 chunk 残留：一个事件可能被网络切成两半。 */
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // stream: true 保证多字节字符跨 chunk 时正确解码。
      buffer += decoder.decode(value, { stream: true });

      // 事件以空行分隔；最后一段可能只是半截，留着下轮再拼。
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed);
      }
    }

    const tail = buffer.trim();
    if (tail) {
      const parsed = parseSseBlock(tail);
      if (parsed) onEvent(parsed);
    }
    onDone?.();
  } catch (error) {
    if (isAbortError(error)) return;
    onError?.(error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* 已释放则忽略 */
    }
  }
}

/**
 * 解析一个 SSE 事件块（形如 `event: X\ndata: Y`）。
 *
 * <p>规则：`:` 开头是注释（心跳）整块忽略；`event:` 是事件名；`data:` 是事件体（多行用
 * `\n` 拼接）；没有 data 行则返回 null。冒号后只吃掉一个空格，其余空格属于数据。</p>
 */
export function parseSseBlock(block: string): RawSseEvent | null {
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx);
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;

  const raw = dataLines.join('\n');
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // 后端理论上都发 JSON；解析失败保留原文交给调用方定性。
    data = null;
  }
  return { event: eventName, data, raw };
}

/** 判断是否为主动中止引起的错误。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : false;
}
