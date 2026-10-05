import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AgentStreamEvent } from '../types/chat';
import { readSseResponse } from '../utils/sse';
import { resolveApiUrl } from '../utils/apiConfig';
import { STREAM_V3_SCHEMA_VERSION } from '../utils/streamV3';

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
  /**
   * 连接代次（generation）：同一根会话每建一次流自增。
   *
   * <p>用途：所有异步回调（建连成功、读取循环结束、错误、终态）在动作前先比对本连接代次是否
   * 仍是该会话的当前代次，不是则**静默丢弃**。这样「旧连接迟到的回调」就不会误改新连接的状态、
   * 误触发重连、或把旧流的事件渲染进已换代的前端状态。</p>
   */
  generation: number;
}

/** 重连退避：首次 1s，之后翻倍，封顶 15s。不做次数上限 —— 只要还有人订阅就一直尝试。 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

/**
 * 会话事件流的挂载地址；对应后端 `ChatController#subscribe`。
 *
 * <p>**必须带 `?schemaVersion=3`**：后端 `subscribe` 按该参数分流，缺省（未带）会落到 `1`
 * （旧 v1 协议）。整条 v3 直投链路（唯一 ingress、RESPONSE_STARTED/FINALIZED、bootstrap 时序）
 * 都以这版参数为前提，漏带就等于整链跑不起来。</p>
 */
export const sessionStreamUrl = (rootSessionId: string): string =>
  resolveApiUrl(
    `/a/completion/${encodeURIComponent(rootSessionId)}/events?schemaVersion=${STREAM_V3_SCHEMA_VERSION}`
  );

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
  /**
   * 「想要挂着流」的会话集合（意图），与「正在挂着的连接」（现实）分开：
   * 断线自愈必须以**意图**为准 —— 连接被服务端/网络终结时它自己会从 `connections` 里消失，
   * 而意图还在，才应该重连。`closeStream`/`closeAll` 是唯一撤销意图的入口。
   */
  const desiredStreams = new Set<string>();
  /** 各会话的建流函数：重连时要复用同一个 opener，不能在 store 里写死 URL。 */
  const openersBySession = new Map<string, (signal: AbortSignal) => Promise<Response>>();
  /** 各会话当前的重连尝试次数（算退避用）与待执行的重连定时器。 */
  const reconnectAttempts = new Map<string, number>();
  const reconnectTimers = new Map<string, number>();
  /**
   * 各会话当前连接代次：每建一次流自增。旧连接的回调据此判定自己是否已被换代而丢弃。
   * 与 `connections` 分离：连接被换掉后旧连接对象仍短暂存活（读取循环尚未退出），
   * 需要用它自己的 generation 与新值比对，而不能只看 `connections` 里是否还是它。
   */
  const generations = new Map<string, number>();
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

  /** 本连接是否仍是该会话的当前代次。旧连接的一切异步回调据此短路。 */
  const isCurrent = (connection: SseConnection): boolean =>
    generations.get(connection.rootSessionId) === connection.generation
    && connections.get(connection.rootSessionId) === connection;

  const dispatch = (connection: SseConnection, event: AgentStreamEvent) => {
    // 旧代次连接迟到的事件一律丢弃：它们属于被替换掉的那条流，渲染进去会造成重复/回退。
    if (!isCurrent(connection)) return;
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
    // 先判定「本连接是否仍是当前代次」——必须在摘除/回收代次**之前**取快照，
    // 否则回收 generations 会让 isCurrent 立刻转假，正常收尾的 onClosed 与自愈重连都会被吞掉。
    const currentGeneration = isCurrent(connection);
    // 只有当前这条连接才允许把自己从表里摘掉：期间可能已经建了新连接，
    // 旧连接迟到的结束回调不能把新连接误删、也不能把状态/订阅回调打到新一代上。
    if (connections.get(connection.rootSessionId) === connection) {
      connections.delete(connection.rootSessionId);
      // 连接已摘除，代次随之回收（下一个 openStream 会重新从 1 起算，无旧连接可比对）。
      generations.delete(connection.rootSessionId);
    }
    // 已被更新的连接取代：静默丢弃，不置状态、不回调、不重连。
    if (!currentGeneration) return;
    setStatus(connection.rootSessionId, reason === 'error' ? 'error' : 'closed');
    const handlers = handlersBySession.get(connection.rootSessionId);
    if (handlers) {
      for (const handler of [...handlers]) {
        safeCall(() => handler.onClosed?.(reason), 'onClosed');
      }
    }
    // 自愈：本端没有主动关闭、且这个会话仍然想要一条流 → 退避后重连。
    // 重连成功会触发订阅者的 onReattached（把「中间可能漏了事件」交给消费方回查历史补齐）。
    if (reason !== 'aborted' && desiredStreams.has(connection.rootSessionId)) {
      scheduleReconnect(connection.rootSessionId);
    }
  };

  /**
   * 退避重连。以「意图」为准：只要 `desiredStreams` 还包含该会话（closeStream/closeAll 之前）
   * 且仍有人在听，就一直尝试；`openStream` 的复用语义保证同一时刻至多一条连接。
   */
  const scheduleReconnect = (rootSessionId: string) => {
    if (reconnectTimers.has(rootSessionId)) return;
    const attempts = reconnectAttempts.get(rootSessionId) ?? 0;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
    reconnectAttempts.set(rootSessionId, attempts + 1);
    const timer = window.setTimeout(() => {
      reconnectTimers.delete(rootSessionId);
      if (!desiredStreams.has(rootSessionId)) return;
      if (connections.has(rootSessionId)) return;   // 已有别的路径先把它挂回来了
      const opener = openersBySession.get(rootSessionId);
      if (!opener) return;
      console.warn(`[sseRouter] 会话 ${rootSessionId} 事件流断开，${delay}ms 后重连（第 ${attempts + 1} 次）`);
      openStream(rootSessionId, opener, { stopOnTerminal: false });
    }, delay);
    reconnectTimers.set(rootSessionId, timer);
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
      // 已换代：这条连接的建连结果不再属于当前会话，直接收尾（不置状态、不触发重连）。
      if (!isCurrent(connection)) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      // ★ 退避计数只在**成功建立连接之后**清零：若在发起建连时就清零，
      //   后端持续不可达（每次都在 open 处失败）会让退避永远从 1s 起步，表现为无限快重连。
      reconnectAttempts.delete(connection.rootSessionId);
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
      // 已换代：旧连接的错误不再上报、不改状态、不触发重连（新连接有自己的生命周期）。
      if (!isCurrent(connection)) {
        finish(connection, 'server-closed');
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
      // 但意图与 opener 仍要登记：断线自愈以它们为准。
      desiredStreams.add(key);
      openersBySession.set(key, open);
      return;
    }
    const connection: SseConnection = {
      rootSessionId: key,
      controller: new AbortController(),
      delivered: false,
      generation: (generations.get(key) ?? 0) + 1,
    };
    // 换代：登记新代次后，旧连接（若有）随后的一切回调都会因 isCurrent 为假而被丢弃。
    generations.set(key, connection.generation);
    // 挂上即视为「意图成立」，并记录 opener 供断线自愈复用；随后取消可能还挂着的重连定时器
    // （新连接已经就位，定时器再触发只会被上面那条复用分支挡掉，留着只会白耗一次日志）。
    // ★ 刻意不在此处重置 reconnectAttempts —— 退避清零只在 run() 里「真正建连成功」之后做，
    //   否则后端不可达时每次都从 1s 起步，变成无限快重连。
    desiredStreams.add(key);
    openersBySession.set(key, open);
    const pendingTimer = reconnectTimers.get(key);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      reconnectTimers.delete(key);
    }
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

  /**
   * 主动关闭该会话的流（停止按钮、离开会话且不再需要实时更新）。订阅关系保留。
   *
   * <p>撤销「想要挂着流」的意图并取消待执行的重连：这是**唯一**不会触发自愈的关流路径 ——
   * 其余结束原因（服务端关流 / 网络 / 建流失败）都会退避重连。</p>
   */
  const closeStream = (rootSessionId: string): void => {
    const key = String(rootSessionId);
    desiredStreams.delete(key);
    const pendingTimer = reconnectTimers.get(key);
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      reconnectTimers.delete(key);
    }
    reconnectAttempts.delete(key);
    // 主动关闭只 abort，不动代次：本条连接仍是「当前代次」，其 abort 迟到回调走 finish('aborted')，
    // 正常清理自身并回调一次 onClosed（既有契约）。若期间已建了新连接（复用了新代次），
    // finish 的 isCurrent 判定自然会把它挡掉，不会误删新连接。
    connections.get(key)?.controller.abort();
  };;

  /** 关闭全部连接（登出、页面卸载）。 */
  const closeAll = (): void => {
    for (const connection of [...connections.values()]) {
      closeStream(connection.rootSessionId);
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
