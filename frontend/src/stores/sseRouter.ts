import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AgentStreamEvent } from '../types/chat';
import { readSseResponse } from '../utils/sse';

/**
 * SSE 路由管理中心。
 *
 * <h3>解决什么问题</h3>
 * 原先 SSE 流由「发消息的那一次请求」持有，读取循环写在调用方的闭包里：组件一卸载、路由一切换，
 * 流就断了。切回来只能重新发请求或回查历史，中途的实时更新一律收不到。
 *
 * 本中心把**连接归属**从组件手里收上来，按根会话保管：组件订阅/退订只影响「谁在听」，
 * 不影响「流在不在」。于是切走再切回是重新订阅，而不是重新建流。
 *
 * <h3>职责边界（刻意划清，避免与后端重复）</h3>
 * - 本中心只做三件事：**建/复用/关连接**、**按会话把事件分发给订阅者**、**暴露连接状态**。
 * - **不解释事件语义**：事件怎么变成消息气泡由消费方（如 chatStreamService 的解释器）决定。
 * - **不缓存事件、不回放**：服务端也不回放。切走期间的缺口由消费方**回查会话历史**对齐——
 *   实时通道与历史接口各管一段，不重复承担一致性。因此重新订阅时若连接早已在跑，
 *   本中心会回调 `onReattached`，提示消费方「你可能漏过事件，去拉一次历史」。
 *
 * <h3>为什么不用 reactive 包连接对象</h3>
 * `AbortController`、订阅者集合都不需要、也不应该被 Vue 代理。只有「状态」需要给 UI 看，
 * 单独用 `statuses` 暴露；其余放在普通 Map 里。
 */

/** 连接状态。从未建过流的会话在 `statuses` 里没有条目（消费方按 `undefined` 处理即可）。 */
export type SseStreamStatus = 'connecting' | 'open' | 'closed' | 'error';

/** 流结束的原因，消费方据此决定要不要提示用户。 */
export type SseCloseReason =
  /** 本端主动关闭：切换会话、点停止 */
  | 'aborted'
  /** 服务端关流：执行结束、网关断开 */
  | 'server-closed'
  /** 建立连接或读取过程失败 */
  | 'error';

export interface SseStreamHandlers {
  /** 实时事件。子会话事件也会投递到这里（归属细分由消费方按 sessionId 自行路由）。 */
  onEvent: (event: AgentStreamEvent) => void;
  /**
   * 本次订阅是「重新挂载」：连接早已在跑且已投递过事件，注册前的那段可能漏了。
   * 消费方应回查会话历史对齐（服务端不做回放）。
   */
  onReattached?: () => void;
  /** 流结束。无论何种原因结束都会回调一次。 */
  onClosed?: (reason: SseCloseReason) => void;
  /** 建流/读取失败。随后仍会回调一次 `onClosed('error')`。 */
  onError?: (error: unknown) => void;
}

/** 连接内部状态：生命周期 + 传输对象。 */
interface SseConnection {
  rootSessionId: string;
  controller: AbortController;
  /** 是否已投递过至少一条事件：重新订阅时据此判断「注册前可能漏过事件」 */
  delivered: boolean;
}

/** 会话事件流的挂载地址；对应后端 `ChatController#subscribe`。 */
export const sessionStreamUrl = (rootSessionId: string): string =>
  `/a/completion/${encodeURIComponent(rootSessionId)}/events`;

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

export const useSseRouterStore = defineStore('sseRouter', () => {
  /**
   * 连接表：rootSessionId → 连接。
   *
   * 键一律是**根会话 ID**，与后端推送路由同一口径 —— 后端按根会话归档 emitter，
   * 用子会话 ID 建流会挂到另一个桶里，结果就是「连上了却收不到任何事件」。
   */
  const connections = new Map<string, SseConnection>();
  /**
   * 订阅表：rootSessionId → 订阅者集合。
   *
   * 刻意与连接分开：订阅关系属于会话，连接属于传输。连接断了不该把订阅也丢掉 ——
   * 否则重新建流时没人再收到事件，而订阅方还以为自己挂着。
   */
  const handlersBySession = new Map<string, Set<SseStreamHandlers>>();
  /** 只把状态暴露成响应式，供 UI 显示「该会话仍在跑」。 */
  const statuses = ref<Record<string, SseStreamStatus>>({});

  const setStatus = (rootSessionId: string, status: SseStreamStatus) => {
    statuses.value = { ...statuses.value, [rootSessionId]: status };
  };

  /** 单个订阅者抛错不能拖垮整条分发链，也不能影响其他订阅者。 */
  const safeCall = (run: () => void, hook: string) => {
    try {
      run();
    } catch (err) {
      console.warn(`[sseRouter] ${hook} 回调抛错，已忽略:`, err);
    }
  };

  const dispatch = (connection: SseConnection, event: AgentStreamEvent) => {
    connection.delivered = true;
    const handlers = handlersBySession.get(connection.rootSessionId);
    if (!handlers || handlers.size === 0) {
      // 无人订阅（例如组件已卸载）：事件丢弃。缺口由消费方回查历史补齐，本中心不缓存。
      return;
    }
    for (const handler of [...handlers]) {
      safeCall(() => handler.onEvent(event), 'onEvent');
    }
  };

  const finish = (connection: SseConnection, reason: SseCloseReason) => {
    // 只有当前这条连接才允许把自己从表里摘掉：期间可能已经建了新连接，
    // 旧连接迟到的结束回调不能把新连接误删。
    if (connections.get(connection.rootSessionId) === connection) {
      connections.delete(connection.rootSessionId);
    }
    setStatus(connection.rootSessionId, reason === 'error' ? 'error' : 'closed');
    const handlers = handlersBySession.get(connection.rootSessionId);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      safeCall(() => handler.onClosed?.(reason), 'onClosed');
    }
  };

  const run = async (
    connection: SseConnection,
    open: (signal: AbortSignal) => Promise<Response>,
    stopOnTerminal: boolean
  ) => {
    try {
      const response = await open(connection.controller.signal);
      if (!response.ok || !response.body) {
        throw new Error(`SSE 建立连接失败 (${response.status})`);
      }
      setStatus(connection.rootSessionId, 'open');
      await readSseResponse(response, {
        // 会话级订阅不在终态处结束（一次执行结束不是这个会话的终点）；
        // 请求级流保持默认，终态即读取终点。
        rootSessionId: stopOnTerminal ? connection.rootSessionId : null,
        stopOnTerminal,
        onEvent: event => dispatch(connection, event),
      });
      finish(connection, 'server-closed');
    } catch (err) {
      if (isAbortError(err) || connection.controller.signal.aborted) {
        finish(connection, 'aborted');
        return;
      }
      setStatus(connection.rootSessionId, 'error');
      const handlers = handlersBySession.get(connection.rootSessionId);
      if (handlers) {
        for (const handler of [...handlers]) {
          safeCall(() => handler.onError?.(err), 'onError');
        }
      }
      finish(connection, 'error');
    }
  };

  /**
   * 建流；已有在跑（或正在建）的连接则复用。
   *
   * @param rootSessionId 根会话 ID
   * @param open          执行请求的函数，必须使用传入的 signal，否则 `closeStream` 关不掉它
   * @param options.stopOnTerminal 是否在根会话终态事件处结束读取，缺省 `true`
   */
  const openStream = (
    rootSessionId: string,
    open: (signal: AbortSignal) => Promise<Response>,
    options: { stopOnTerminal?: boolean } = {}
  ): void => {
    const key = String(rootSessionId);
    const existing = connections.get(key);
    if (existing) {
      // 复用：同一会话两条流会让每个事件投递两遍，消费方就得各自去重 —— 不如在这里堵住。
      return;
    }
    const connection: SseConnection = {
      rootSessionId: key,
      controller: new AbortController(),
      delivered: false,
    };
    connections.set(key, connection);
    setStatus(key, 'connecting');
    void run(connection, open, options.stopOnTerminal !== false);
  };

  /**
   * 确保该根会话挂着一条会话级事件流（已挂则复用）。
   *
   * 与「发消息」无关的纯订阅入口：切回某个会话时调用它重新挂上即可。
   * 配合 `subscribe` 使用：先订阅（拿到 onReattached 提示），再 ensure。
   */
  const ensureSessionStream = (rootSessionId: string): void => {
    openStream(
      String(rootSessionId),
      signal =>
        fetch(sessionStreamUrl(String(rootSessionId)), {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal,
        }),
      { stopOnTerminal: false }
    );
  };

  /**
   * 订阅某个根会话的事件。返回退订函数。
   *
   * 订阅与连接解耦：订阅时若连接已在跑且已投递过事件，会立刻回调 `onReattached` ——
   * 这就是「切回会话」时消费方需要回查历史的信号。
   */
  const subscribe = (rootSessionId: string, handlers: SseStreamHandlers): (() => void) => {
    const key = String(rootSessionId);
    let handlersOfSession = handlersBySession.get(key);
    if (!handlersOfSession) {
      handlersOfSession = new Set<SseStreamHandlers>();
      handlersBySession.set(key, handlersOfSession);
    }
    handlersOfSession.add(handlers);

    const connection = connections.get(key);
    if (connection?.delivered) {
      safeCall(() => handlers.onReattached?.(), 'onReattached');
    }

    return () => {
      const current = handlersBySession.get(key);
      if (!current) return;
      current.delete(handlers);
      if (current.size === 0) {
        handlersBySession.delete(key);
      }
    };
  };

  /** 主动关闭该会话的流（停止按钮、离开会话且不再需要实时更新）。订阅关系保留。 */
  const closeStream = (rootSessionId: string): void => {
    connections.get(String(rootSessionId))?.controller.abort();
  };

  /** 关闭全部连接（登出、页面卸载）。 */
  const closeAll = (): void => {
    for (const connection of [...connections.values()]) {
      connection.controller.abort();
    }
  };

  const isStreaming = (rootSessionId: string): boolean => {
    const status = statuses.value[String(rootSessionId)];
    return status === 'connecting' || status === 'open';
  };

  const streamStatus = (rootSessionId: string): SseStreamStatus | undefined =>
    statuses.value[String(rootSessionId)];

  return {
    statuses,
    openStream,
    ensureSessionStream,
    subscribe,
    closeStream,
    closeAll,
    isStreaming,
    streamStatus,
  };
});
