import { watch } from 'vue';
import { SessionAPI } from './session';
import { isOk } from '../utils/api';
import { useSseRouterStore } from '../stores/sseRouter';
import { useStreamV3Store } from '../stores/streamV3Store';
import { parseStreamV3Event, type StreamV3Event } from '../utils/streamV3';
import { aggregateSessionMessages } from '../utils/session';
import type { ChatMessage, ChatTurn, SessionBootstrapVO } from '../types/chat';
import type { AgentStreamEvent } from '../types/chat';

/**
 * v3 会话流协调器：把「连接中心（sseRouter）」「唯一状态（streamV3Store）」「持久化同步
 * （bootstrap）」三者接到一起，落实 design §8 的四步同步时序与 §8.1 四条退出路径。
 *
 * <h3>为什么单独一个协调器</h3>
 * sseRouter 只懂「连接生命周期与投递」、不解释事件语义；streamV3Store 只懂「帧 → 状态」，
 * 不知道何时该发 bootstrap。**时序**是二者的第三方知识：先建代次 → READY 后发一次 bootstrap →
 * 合并 → 回放暂存。放进任一 store 都会破坏它们各自的职责边界，故独立成此模块。
 *
 * <h3>暂存屏障的作用</h3>
 * bootstrap 是一次网络往返。往返期间到达的实时帧若直接应用，会与即将返回的持久化快照产生
 * 「先实时后快照」的时序倒挂（快照覆盖掉更新的实时值）。于是往返期间的帧先入缓冲，
 * 快照合并完再按 FIFO 回放 —— 实时帧总是晚于快照应用，实体 version 比较因此总是正确的。
 */

/** 协调器句柄：持有订阅退订函数，供关流时释放。 */
export interface StreamV3Session {
  rootSessionId: string;
  detach: () => void;
}

/**
 * 解析一条 v1 运行时事件是否为 v3 帧并交给 ingress。
 *
 * <p>v3 帧经 SSE 到达时，`utils/sse.ts#readSseResponse` 已把它 `JSON.parse` 成对象并包成
 * `AgentStreamEvent`（spread 透传），因此这里直接把该对象当「已解析 JSON」交给解析层。
 * v1 事件（无 v3 类型）会被解析层记 warn 后返回 null，本函数据此忽略。</p>
 */
function extractFrame(raw: AgentStreamEvent): StreamV3Event | null {
  return parseStreamV3Event(raw as unknown as Record<string, unknown>);
}

/**
 * 建立 / 复用某个根会话的 v3 事件流，并驱动完整同步时序。
 *
 * @param rootSessionId 根会话 ID
 * @returns 句柄（含退订函数）
 */
export function attachStreamV3(rootSessionId: string | number): StreamV3Session {
  const key = String(rootSessionId);
  const router = useSseRouterStore();
  const store = useStreamV3Store();

  // 第 1 步：建立新连接代次，进入等待 READY（此刻起新帧暂存）。
  // token 是本次同步的身份：bootstrap 返回时要带回，代次不符即整体丢弃。
  let syncToken = store.beginSync(key);

  /**
   * 最近一次收到 READY 的**连接身份**（`STREAM_READY.data.connectionId`）。
   *
   * <p>为什么不能用闭包布尔 `bootstrapSent`：它只表达「本协调器发过一次」，自动重连就废了 ——
   * 重连复用**已有订阅者**，不重新 `subscribe`，因此不触发 `onReattached`；而新连接发来的
   * READY 会被 `bootstrapSent === true` 直接挡掉，phase 卡在 bootstrapping，新连接永不 live。</p>
   *
   * <p>★ 为什么不能复用「已 bootstrap 成功的连接身份」这一个变量来判新旧连接：那份快照**可能
   * 还挂在途**（上一次 bootstrap 没返回就断流重连了）。此时旧身份从未被记下 → 判据误认为
   * 「不是新连接」→ 不换代次，上一代在途请求仍带着**有效 token**，它返回的旧快照会把断流
   * 期间的状态写成新连接的权威。READY 的连接身份与 bootstrap 有无在途无关，故单列一份。</p>
   */
  let readyConnectionId: string | null = null;

  /**
   * 同步失败的有界退避恢复。
   *
   * <p><b>为什么必须有</b>：bootstrap 失败或暂存溢出后，store 把 phase 打回 idle 并作废 token，
   * 但 SSE 连接**仍然开着** —— 服务端只在建连那一刻发一次 READY，之后不会因为你失败了再发。
   * 没有这个出口，本次缺失的历史与卡片就再也没有自愈机会（普通未来事件能应用，但缺口永久存在）。</p>
   *
   * <p><b>为什么是有界退避而不是「轮询数据库」</b>：失败是异常路径，重试次数有限、间隔递增；
   * 它不是持续拉取，恢复成功即停。上限到顶后停在 idle，等待下一次 READY / 重挂带来的新代次。</p>
   *
   * <p><b>为什么用 `window.setTimeout` 而不是裸 `setTimeout`</b>：本仓约定（见
   * `streamV3Harness`）由宿主的 `window` 提供定时器，测试据此接管退避调度。
   * 模块顶层可能还没有 `window`（纯 Node 导入），因此**调用时**才解析，缺省回落到全局。</p>
   */
  const RETRY_DELAYS_MS = [1000, 2000, 4000];
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let detached = false;

  const resolveTimerHost = (): { set: typeof setTimeout; clear: typeof clearTimeout } => {
    const host = (globalThis as any).window;
    if (host && typeof host.setTimeout === 'function') {
      return { set: host.setTimeout.bind(host), clear: host.clearTimeout.bind(host) };
    }
    return { set: setTimeout, clear: clearTimeout };
  };

  const cancelRetry = (): void => {
    if (retryTimer !== null) {
      resolveTimerHost().clear(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRecovery = (): void => {
    if (detached || retryTimer !== null) return;
    if (retryAttempt >= RETRY_DELAYS_MS.length) {
      console.warn('[streamV3Sync] 同步恢复重试已达上限，等待下一次 READY/重挂:', key);
      return;
    }
    const delay = RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    console.warn('[streamV3Sync] 同步失败，登记退避恢复:', key, `第 ${retryAttempt} 次，延迟 ${delay}ms`);
    retryTimer = resolveTimerHost().set(() => {
      retryTimer = null;
      if (detached) return;
      // 重试必须换代次：失败时 store 已作废旧 token，沿用旧的会被自己的 guard 丢弃。
      syncToken = store.beginResync(key);
      void runBootstrap(store.connectionIds[key] ?? '', syncToken);
    }, delay);
  };

  /**
   * 已完成 bootstrap 的**连接身份**：只在成功后记，失败时保持未完成，
   * 使同一条连接上再来一次 READY 仍可重试。
   */
  let bootstrappedConnectionId: string | null = null;

  /**
   * 在途 bootstrap 所属的**同步代次**。
   *
   * <p>为什么按代次而不是布尔：布尔会让「上一代还在途」把**新代次**的 bootstrap 一起挡掉
   * （新连接一次快照都拉不到，phase 停在 bootstrapping）。代次不同即互不阻挡。</p>
   */
  let inFlightGeneration: number | null = null;

  /**
   * 为指定连接发一次 bootstrap；在途期间继续暂存帧。
   *
   * <p>★ 刻意不做「这条连接是否已同步过」的去重：那是 READY 分支的幂等规则（同一连接上的
   * 重复控制帧不算新的一轮同步），而 {@link runBootstrap} 的另一个调用方
   * {@code onReattached} 语义正相反 —— 它就是「中间漏了事件，去补齐」，必须无条件拉一次。
   * 两者共用一个去重判据时，补齐信号会被自己的历史挡掉。</p>
   *
   * @param connectionId 发起时的连接身份（成功后记账，供 READY 分支判重）
   * @param generation 发起时的同步代次；返回时若已换代，这份响应整体丢弃
   */
  const runBootstrap = async (connectionId: string, generation: number): Promise<void> => {
    // 同代次重复发起才去重；跨代次不阻挡（上一代在途属于断流期间，与新连接无关）。
    if (inFlightGeneration === generation) return;
    inFlightGeneration = generation;
    try {
      const res = await SessionAPI.bootstrap(key);
      if (!isOk(res.code) || !res.data) {
        console.warn('[streamV3Sync] bootstrap 失败，放弃本次同步:', res.errMsg);
        // 只有本代次的失败才允许放弃同步：旧代次失败不得把新代次的阶段打回 idle。
        // abortSync 会作废代次并返回新值，必须接住 —— 否则本地 token 停在被作废的那个上，
        // 这条连接上后续的 bootstrap 会因代次不符被自己丢弃，「失败可重试」就废了。
        if (generation === syncToken) {
          syncToken = store.abortSync(key);
          // 统一失败出口：登记有界退避恢复。服务端不会因为你失败再发一次 READY，
          // 不主动重试就等于放弃本次缺失的历史与卡片。
          scheduleRecovery();
        }
        return;
      }
      // 换代判定：期间已换代（自动重连 / 切走再切回），这份快照属于上一代，整体丢弃。
      if (generation !== syncToken) {
        console.warn('[streamV3Sync] 过期 bootstrap 响应，已丢弃:', key);
        return;
      }
      // 第 3+4 步：合并持久化状态（含§8.1 路径 2 的 bootstrap 侧执行终态判定），再回放暂存帧。
      // ★ 记账必须依据 store 的接纳结果：快照被代次 guard 拒绝（如期间溢出触发 abortSync）时
      //   `false`，此时记成「同步成功」会清零退避计数、把这次本该恢复的缺口一起抹掉。
      const accepted = store.applyBootstrap(key, res.data as SessionBootstrapVO, generation);
      if (!accepted) {
        console.warn('[streamV3Sync] bootstrap 快照未被当前代次接纳，保留恢复机会:', key);
        return;
      }
      bootstrappedConnectionId = connectionId;
      // 恢复成功：清零退避计数，让下一次失败可以从最短间隔重新退避。
      retryAttempt = 0;
      cancelRetry();
    } catch (err) {
      console.warn('[streamV3Sync] bootstrap 异常，放弃本次同步:', err);
      if (generation === syncToken) {
        syncToken = store.abortSync(key);
        scheduleRecovery();
      }
    } finally {
      if (inFlightGeneration === generation) inFlightGeneration = null;
    }
  };

  /**
   * 监听 store 的「同步失败出口」计数。
   *
   * <p><b>为什么不能只靠上面的 try/catch</b>：暂存溢出发生在帧 ingest 路径（store 内部），
   * 它只作废 token 并打回 idle，**不会**抛出到 bootstrap 的 await 链上。协调器若只处理
   * 自己发起的那次请求的失败，就会漏掉这个出口 —— 表现为「界面停在 idle 再也不动」。</p>
   *
   * <p>停止条件要等 stop 句柄，因此 watch 必须在本作用域内创建、在 detach 时一并释放。</p>
   */
  const stopFailureWatch = watch(
    () => store.syncFailureSeq[key],
    (seq) => {
      if (detached) return;
      if (seq === undefined) return;
      // 失败出口统一登记恢复：无论失败来自 bootstrap 报错、暂存溢出还是版本不符，
      // 都走同一条有界退避。重复调度由 scheduleRecovery 自身去重（retryTimer 非空即返回）。
      if (store.getPhase(key) !== 'live') scheduleRecovery();
    },
    { flush: 'sync' }
  );

  const unsubscribe = router.subscribe(key, {
    onEvent: (event: AgentStreamEvent) => {
      const frame = extractFrame(event);
      if (!frame) return; // 非 v3 帧（v1 或噪声）：忽略，不 fallback 成正文。

      if (frame.type === 'STREAM_READY') {
        const usable = store.onStreamReady(key, frame);
        if (!usable) {
          // 版本不符：放弃同步。上层下次进入会话会重建连接（要求刷新契约）。
          router.closeStream(key);
          return;
        }
        const connectionId = store.connectionIds[key] ?? '';
        // 同一连接上的重复 READY：这条连接已经同步成功过，幂等忽略。
        // ★ 两个条件缺一不可：只看连接身份会让「本条连接 bootstrap 失败后再次 READY」被
        //   一起挡掉，失败就变成永久失去同步机会；只看是否成功过则同一条连接会重复拉快照。
        //   在途由 runBootstrap 的代次 guard 负责（同一代次不重复发起）。
        if (readyConnectionId === connectionId && bootstrappedConnectionId === connectionId) return;
        const isNewConnection = readyConnectionId !== null && readyConnectionId !== connectionId;
        readyConnectionId = connectionId;
        // 真正换了连接（自动重连）：换同步代次 —— 上一代在途的 bootstrap 必须作废，
        // 否则它返回的快照会写进新连接的状态（那些帧属于断流期间，已被新快照取代）。
        //
        // ★ 这里必须用 beginResync 而不是 beginSync：beginSync 会把阶段置成「等 READY」，
        //   而新连接的 READY 已经到了、之后不会再有 —— 后续帧会被无限暂存，界面不再更新。
        if (isNewConnection) {
          syncToken = store.beginResync(key);
        }
        void runBootstrap(connectionId, syncToken);
        return;
      }
      // 其余帧交给 ingress：按当前阶段决定「直接应用」或「暂存」。
      store.ingress(key, frame);
    },
    onReattached: () => {
      // 重挂 = 连接早已在跑且已投递过事件：中间可能漏了事件。重新走一次同步时序补齐。
      //
      // ★ 这里**不能**进入「等 READY」：复用连接不会再发 STREAM_READY，
      //   停在该阶段会让后续帧被无限暂存（界面从此不再更新）。
      //   直接进入 bootstrap 在途 —— 暂存屏障照常生效，只是不等那个不会来的控制帧。
      syncToken = store.beginResync(key);
      void runBootstrap(store.connectionIds[key] ?? '', syncToken);
    },
  });

  // 挂上连接（携带 ?schemaVersion=3）。若连接已在跑则复用，READY 不会再发 —— 此时同步
  // 由 onReattached 分支驱动。
  router.ensureSessionStream(key);

  return {
    rootSessionId: key,
    detach: () => {
      detached = true;
      cancelRetry();
      stopFailureWatch();
      unsubscribe();
      // 在途的 bootstrap 随之作废：切走之后返回的快照不得写回（否则清空的状态会被旧快照复活）。
      store.invalidateSync(key);
    },
  };
}

/** 由 bootstrap 快照装配出的会话展示数据（供消费方直接喂给现有渲染管线）。 */
export interface BootstrapAssembly {
  rootSessionId: string;
  historyRevision: string;
  /** 历史首屏聚合出的展示消息（与 `chatApi.fetchSessionDetail` 同一装配函数）。 */
  messages: ChatMessage[];
  /** 历史首屏的轮次摘要（已终结轮次）。 */
  historyTurns: Record<string, ChatTurn>;
  /** 进行中轮次（bootstrap.turns，互补于 historyTurns，不重叠）。 */
  activeTurns: ChatTurn[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * 拉取一次 bootstrap 快照并**复用既有装配逻辑**（`utils/session#aggregateSessionMessages`，
 * 即 `chatApi.fetchSessionDetail` 使用的同一函数）把历史首屏转换成展示消息。
 *
 * <p>「不新造读路径」的落点：历史记录的结构与 `SessionMessagePageVO` 完全一致，因此直接喂给
 * 同一个聚合器，实时通道之外不重复实现一套历史解析。定位只读，不改变实时状态（实时状态由
 * `attachStreamV3` 的同步时序负责）。</p>
 *
 * @returns 判别结构：`ok:false` 时带错误文案供展示重试
 */
export async function fetchBootstrapSnapshot(
  rootSessionId: string | number
): Promise<{ ok: true; data: BootstrapAssembly } | { ok: false; error: string }> {
  const res = await SessionAPI.bootstrap(rootSessionId);
  if (!isOk(res.code) || !res.data) {
    return { ok: false, error: res.errMsg || '会话同步失败，请稍后重试' };
  }
  const snapshot = res.data as SessionBootstrapVO;
  return {
    ok: true,
    data: {
      rootSessionId: String(snapshot.rootSessionId),
      historyRevision: String(snapshot.historyRevision ?? ''),
      messages: aggregateSessionMessages(snapshot.history?.records ?? [], snapshot.rootSessionId),
      historyTurns: snapshot.history?.turns ?? {},
      activeTurns: snapshot.turns ?? [],
      nextCursor: snapshot.history?.nextCursor ?? null,
      hasMore: Boolean(snapshot.history?.hasMore),
    },
  };
}

/** 供上层在切换会话 / 卸载时释放协调器（退订 + 关流）。 */
export function detachStreamV3(session: StreamV3Session): void {
  session.detach();
  const router = useSseRouterStore();
  router.closeStream(session.rootSessionId);
}
