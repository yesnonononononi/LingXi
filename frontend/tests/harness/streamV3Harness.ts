import { createPinia, setActivePinia } from 'pinia';
import http from '../../src/services/interceptor';
import { SessionAPI } from '../../src/services/session';
import { useSseRouterStore } from '../../src/stores/sseRouter';
import { STREAM_V3_SCHEMA_VERSION } from '../../src/utils/streamV3';
import type {
  SessionBootstrapVO,
  SessionMessagePageVO,
  SessionVO,
  ToolCallDecisionReceipt,
  ToolCallVO,
} from '../../src/types/chat';

/**
 * v3 集成测试骨架：**只替换网络边界**。
 *
 * <p>真实的部分：`sseRouter`（连接/订阅/换代/重连）、`readSseResponse`（SSE 逐行解析）、
 * `streamV3Sync`（§8 同步时序）、`streamV3Store`（唯一状态机）、`messageProjection`（视图派生）。
 * 被替换的只有三处出口：SSE 建连（`fetch`）、bootstrap、历史分页。</p>
 *
 * <p><b>这不是浏览器端到端测试</b>：没有真实浏览器、没有真实后端、没有 DOM 渲染。
 * 它验证的是「帧按给定顺序到达时，状态与派生视图是否正确」，属于跨模块集成测试。</p>
 *
 * <p><b>为什么不用随机延迟</b>：所有时序都由显式 `push` / `resolveBootstrap` 驱动，
 * 测试读起来就是它断言的那条时序，不靠 sleep 碰运气。</p>
 */

/** 一帧 v3 事件的信封（与后端 `StreamV3Event` 同形）。 */
export interface FrameIdentity {
  rootSessionId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  executionId?: string | null;
  historyRevision?: string | null;
  streamKey?: string | null;
}

let frameSeq = 0;

/** 构造一帧 v3 事件（默认身份：root=session=给定的根会话）。 */
export function frame(type: string, data: unknown, identity: FrameIdentity = {}): Record<string, unknown> {
  const rootSessionId = identity.rootSessionId ?? '100';
  return {
    schemaVersion: STREAM_V3_SCHEMA_VERSION,
    eventId: `evt-${++frameSeq}`,
    rootSessionId,
    sessionId: identity.sessionId === undefined ? rootSessionId : identity.sessionId,
    turnId: identity.turnId ?? null,
    executionId: identity.executionId ?? null,
    historyRevision: identity.historyRevision ?? null,
    streamKey: identity.streamKey ?? null,
    type,
    timestamp: null,
    data,
  };
}

/** STREAM_READY 控制帧：身份字段全空，只带连接标识与协议版本。 */
export function readyFrame(connectionId = 'conn-1'): Record<string, unknown> {
  return frame('STREAM_READY', { connectionId, schemaVersion: STREAM_V3_SCHEMA_VERSION }, {
    rootSessionId: null, sessionId: null,
  });
}

/** 一条 SSE 事件流连接。 */
interface LiveConnection {
  rootSessionId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

/** 可控的 SSE 服务端：接管 `fetch`，把帧按测试指定的顺序写进连接。 */
export class FakeStreamServer {
  /** 当前活着的连接（按建连顺序）。 */
  readonly live: LiveConnection[] = [];
  /** 每次建连的根会话 id（按顺序），用于断言「有没有多余重连」。 */
  readonly openedFor: string[] = [];
  /** 每次建连时携带的 URL，用于断言 `schemaVersion` 参数。 */
  readonly openedUrls: string[] = [];

  private readonly encoder = new TextEncoder();

  install(): void {
    (globalThis as any).fetch = (input: unknown, init?: { signal?: AbortSignal }) => {
      const url = String(input);
      const rootSessionId = extractRootSessionId(url);
      this.openedFor.push(rootSessionId);
      this.openedUrls.push(url);
      const signal = init?.signal;

      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const connection: LiveConnection = { rootSessionId, controller, closed: false };
          this.live.push(connection);
          // 客户端关流（切换会话 / 主动 close）时结束读取循环，与真实 fetch 的中止语义一致。
          signal?.addEventListener('abort', () => {
            if (connection.closed) return;
            connection.closed = true;
            try {
              controller.close();
            } catch {
              // 已关闭：忽略
            }
          });
        },
      });

      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  }

  /** 某根会话当前的活动连接。 */
  connection(rootSessionId: string): LiveConnection | undefined {
    return this.live.find(item => item.rootSessionId === String(rootSessionId) && !item.closed);
  }

  /** 该根会话的建连次数。 */
  openCount(rootSessionId: string): number {
    return this.openedFor.filter(id => id === String(rootSessionId)).length;
  }

  /** 按给定顺序把帧写进某会话的连接。 */
  push(rootSessionId: string, ...frames: unknown[]): void {
    const connection = this.connection(rootSessionId);
    if (!connection) {
      throw new Error(`[harness] 会话 ${rootSessionId} 没有活动连接，无法推送帧`);
    }
    for (const item of frames) {
      connection.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
    }
  }

  /** 服务端主动关流（触发自愈重连）。 */
  closeFromServer(rootSessionId: string): void {
    const connection = this.connection(rootSessionId);
    if (!connection) return;
    connection.closed = true;
    connection.controller.close();
  }

  /** 释放全部连接（测试收尾，避免定时器泄漏到下一个用例）。 */
  reset(): void {
    for (const connection of this.live) {
      if (connection.closed) continue;
      connection.closed = true;
      try {
        connection.controller.close();
      } catch {
        // 已关闭：忽略
      }
    }
    this.live.length = 0;
    this.openedFor.length = 0;
    this.openedUrls.length = 0;
  }
}

/** 可控的 bootstrap：请求挂起，由测试决定何时返回、返回什么。 */
export class FakeBootstrap {
  /** 每次请求的根会话 id（按顺序）。 */
  readonly calls: string[] = [];
  private readonly pending: Array<{ rootSessionId: string; resolve: (value: any) => void }> = [];

  install(): void {
    (SessionAPI as any).bootstrap = (rootSessionId: string | number) => {
      const key = String(rootSessionId);
      this.calls.push(key);
      return new Promise(resolve => {
        this.pending.push({ rootSessionId: key, resolve });
      });
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 完成最早一次未决请求。 */
  resolveNext(snapshot: SessionBootstrapVO): boolean {
    return this.resolveAt(0, snapshot);
  }

  /**
   * 完成第 `index` 次未决请求（0 = 最早）。
   *
   * <p>用于「旧请求迟到」这类时序：必须能先让**后发起**的那次返回，再让先发起的返回。</p>
   */
  resolveAt(index: number, snapshot: SessionBootstrapVO): boolean {
    const item = this.pending[index];
    if (!item) return false;
    this.pending.splice(index, 1);
    item.resolve({ code: 1, data: snapshot });
    return true;
  }

  /** 让最早一次未决请求失败（模拟 bootstrap 拉取失败）。 */
  rejectNext(errMsg = '会话同步失败'): boolean {
    const item = this.pending.shift();
    if (!item) return false;
    item.resolve({ code: 0, errMsg, data: null });
    return true;
  }

  reset(): void {
    this.calls.length = 0;
    this.pending.length = 0;
  }
}

/** 可控的历史分页：按根/会话 id 预置响应，由测试决定何时返回。 */
export class FakeMessagePages {
  readonly calls: Array<{ sessionId: string; cursor: string | null }> = [];
  private readonly pending: Array<{ sessionId: string; resolve: (value: any) => void }> = [];

  install(): void {
    (SessionAPI as any).messages = (id: string | number, cursor?: string | null) => {
      const key = String(id);
      this.calls.push({ sessionId: key, cursor: cursor ?? null });
      return new Promise(resolve => {
        this.pending.push({ sessionId: key, resolve });
      });
    };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  resolveNext(page: SessionMessagePageVO): boolean {
    const item = this.pending.shift();
    if (!item) return false;
    item.resolve({ code: 1, data: page });
    return true;
  }

  reset(): void {
    this.calls.length = 0;
    this.pending.length = 0;
  }
}

/**
 * 可控的命令 / 决策 JSON 接口：接管 axios 适配器。
 *
 * <p>记录全部请求，用于断言「审批链路没有逐卡 GET」—— 那正是要删掉的 N+1 回查。</p>
 */
export class FakeCommandApi {
  /** 按顺序记录 `METHOD url`，供「有没有多打请求」的断言。 */
  readonly calls: string[] = [];
  /** 决策接口的应答工厂；缺省回一条「已批准」的回执（与后端同形）。 */
  decisionResponder: (body: Record<string, any>) => ToolCallDecisionReceipt = body => ({
    commandId: String(body.commandId ?? ''),
    decisionApplied: true,
    decision: String(body.action ?? 'APPROVE'),
    toolCall: promiseCard({
      id: String(body.toolCallId ?? ''),
      conversationId: body.conversationId == null ? undefined : String(body.conversationId),
      version: '2',
      status: 'completed',
      pending: false,
      allowedActions: [],
      rawOutput: { outcome: 'APPROVED' },
    }),
    resumeDisposition: 'QUEUED',
  });

  install(): void {
    (http as any).defaults.adapter = async (config: any) => {
      const url = String(config.url ?? '');
      this.calls.push(`${String(config.method ?? 'get').toUpperCase()} ${url}`);
      if (url.includes('/tool-call/decisions')) {
        const body = typeof config.data === 'string' ? JSON.parse(config.data) : (config.data ?? {});
        return {
          data: { code: 1, data: this.decisionResponder(body) },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        };
      }
      // 其余请求一律视为「不该发生」：测试用它来抓多余的查库/回查。
      throw new Error(`[harness] 未打桩的请求: ${url}`);
    };
  }

  /** 逐卡查询（GET /tool-call/{id}）的次数。 */
  perCardGetCount(): number {
    return this.calls.filter(call => call.startsWith('GET /tool-call/') && !call.includes('/query')).length;
  }

  reset(): void {
    this.calls.length = 0;
  }
}

/** 组装一份 bootstrap 快照（缺省空历史，只给必需字段）。 */export function bootstrapSnapshot(overrides: Partial<SessionBootstrapVO> = {}): SessionBootstrapVO {
  return {
    rootSessionId: '100',
    historyRevision: '1',
    sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [],
    turns: [],
    executions: [],
    ...overrides,
  };
}

/** 组装一个子会话实体（`SESSION_UPDATED` 载荷 / bootstrap.sessions 元素）。 */
export function subSessionVO(id: string, rootSessionId = '100', name = '子代理'): SessionVO {
  return { id, rootSessionId, name } as SessionVO;
}

/** 组装一张 PROMISE 卡片（`TOOL_CALL_UPDATED` 载荷）。 */
export function promiseCard(overrides: Partial<ToolCallVO> = {}): ToolCallVO {
  return {
    id: 'call_1',
    conversationId: '100',
    type: 'PROMISE',
    status: 'pending',
    pending: true,
    allowedActions: ['APPROVE', 'REJECT'],
    version: '1',
    title: '命令审批',
    content: { kind: 'COMMAND', command: 'ls -la', workDir: '/tmp', shell: 'bash' },
    ...overrides,
  };
}

/** 让已排队的微任务与流读取推进若干轮（不是 sleep，不引入时间不确定性）。 */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** 安装最小 DOM 全局：`sseRouter` 与 `readSseResponse` 会用到 `window.setTimeout`。 */
export function installDomGlobals(): void {
  const globalRef = globalThis as any;
  if (!globalRef.window) {
    globalRef.window = {};
  }
  globalRef.window.setTimeout = globalThis.setTimeout.bind(globalThis);
  globalRef.window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  // 滚动/动画路径用的浏览器 API：无 DOM 环境下用「立即执行」的桩代替
  globalRef.requestAnimationFrame = (handler: (time: number) => void) => {
    handler(0);
    return 0;
  };
  globalRef.cancelAnimationFrame = () => undefined;
  globalRef.window.requestAnimationFrame = globalRef.requestAnimationFrame;
  globalRef.window.cancelAnimationFrame = globalRef.cancelAnimationFrame;
  // 滚动容器：useChatScroll / scrollToBottomIfAuto 读取这些属性，桩成恒定值避免 NaN
  globalRef.window.scrollY = 0;
  globalRef.window.innerHeight = 800;
  if (!globalRef.localStorage) {
    globalRef.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
  }
}

/** 一次测试的全套环境：独立 Pinia + 三处网络替身。 */
export interface Harness {
  server: FakeStreamServer;
  bootstrap: FakeBootstrap;
  pages: FakeMessagePages;
  commands: FakeCommandApi;
  teardown: () => void;
}

/** 建立测试环境。每个用例调用一次，互不串状态。 */
export function createHarness(): Harness {
  installDomGlobals();
  setActivePinia(createPinia());

  const server = new FakeStreamServer();
  const bootstrap = new FakeBootstrap();
  const pages = new FakeMessagePages();
  const commands = new FakeCommandApi();
  server.install();
  bootstrap.install();
  pages.install();
  commands.install();

  return {
    server,
    bootstrap,
    pages,
    commands,
    teardown: () => {
      // 先撤销「想要一条流」的意图并取消待执行的重连定时器，再关连接：
      // 否则关流会触发自愈重连，把 1s 定时器留在事件循环里，测试进程迟迟不退出。
      try {
        useSseRouterStore().closeAll();
      } catch {
        // store 尚未建立（用例在 createHarness 之前就失败）：忽略
      }
      server.reset();
      bootstrap.reset();
      pages.reset();
      commands.reset();
    },
  };
}

/** 从 SSE URL 里取根会话 id（`/a/completion/{id}/events?...`）。 */
function extractRootSessionId(url: string): string {
  const match = /\/a\/completion\/([^/]+)\/events/.exec(url);
  return match ? decodeURIComponent(match[1]) : url;
}
