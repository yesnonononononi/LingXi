import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type {
  ChatTurn,
  ExecutionStateVO,
  ModelToolCallVO,
  SessionBootstrapVO,
  SessionMessagePageVO,
  SessionMessageVO,
  SessionVO,
  ToolCallVO,
} from '../types/chat';
import {
  parseStreamV3Event,
  resolveResponseClosed,
  type StreamV3Event,
  type StreamV3DeltaPayload,
  type StreamV3ExecutionStatePayload,
  type StreamV3HistoryInvalidatedPayload,
  type StreamV3MessageCommittedPayload,
  type StreamV3ReadyPayload,
  type StreamV3ResponseStartedPayload,
  type StreamV3ResponseFinalizedPayload,
} from '../utils/streamV3';

/**
 * v3 唯一事件 ingress + 单一状态。
 *
 * <h3>职责</h3>
 * 把 v3 直投帧（{@link StreamV3Event}）应用进**唯一状态槽**，并承载 §8 的重连同步时序
 * （先订阅 → STREAM_READY → 发一次 bootstrap → 合并 → 回放暂存帧）。实体一律**按 id 定位**
 * （根/子会话都不例外），不做「最新 assistant 回落」这类位置推断。
 *
 * <h3>状态槽（§9）</h3>
 * - `responses[streamKey]`：正文/思考片段、最终全文、落库 ID 与展示阶段。
 * - `tools[toolCallId]` / `executions[executionId]` / `turns[turnId]` / `sessions[sessionId]`：
 *   版本化业务实体。
 * - 连接状态、同步阶段独立保存，**不写进业务实体**。
 *
 * <h3>为什么用 shallowRef</h3>
 * 槽位是「大量小对象」的 map。用 `shallowRef` + 显式整体替换，避免 Vue 深度代理每个实体字段
 * （长文正文与高频 delta 下开销可观）；消费方按快照读取。
 */

/** 一个响应（一条 assistant 回答）的展示态。 */
export interface ResponseSlot {
  streamKey: string;
  /** 正文：由 TEXT_DELTA 追加、RESPONSE_FINALIZED/MESSAGE_COMMITTED 替换全文。 */
  text: string;
  /** 思考：由 THINKING_DELTA 追加、RESPONSE_FINALIZED 替换全文。 */
  thinking: string;
  /** 落库消息 ID；MESSAGE_COMMITTED 后绑定，未提交为 null。 */
  messageId: string | null;
  /** 是否已收到 RESPONSE_STARTED（确认本连接见证了该响应起点）。 */
  started: boolean;
  /**
   * 是否为「接续片段」（§8 末段）：连接从响应中途开始、未见证 RESPONSE_STARTED 且 bootstrap
   * 也没有对应已提交消息时为 true；完整响应或提交消息到达后清除。
   */
  incompleteUntilFinalized: boolean;
  /** 是否已定格（收到终态/定稿）：定格后的迟到 STARTED/DELTA 不得复活（§8.1 路径 4）。 */
  finalized: boolean;
  /**
   * 归属**执行**（§8.1 路径 2 的匹配键）。
   *
   * <p>与 `sessionId` 是两个不同的键：一个会话下可能并发多个执行（主执行 + 子代理执行），
   * 按会话匹配会误清另一条的进行态。归属未知（`RESPONSE_STARTED` 未带 executionId 且无提交消息）
   * 时为 `null`，此时**不参与**路径 2 的定格（保守不动）。</p>
   */
  executionId: string | null;
  /** 归属会话（便于消费方按会话取用）。 */
  sessionId: string | null;
  /** 归属轮次。 */
  turnId: string | null;
  /**
   * 已随代际作废的**墓碑**。
   *
   * <p>作废不能简单删除槽位：删了之后，仍在网络上的迟到 delta 会用同一个 streamKey
   * 重新建槽并复活（表现为「重发后旧回答又冒出来」）。因此保留一条空槽做墓碑 ——
   * 它阻断迟到帧，但**不参与渲染**（消费方按本标记过滤）。</p>
   */
  discarded: boolean;
}

/** 某会话的连接状态（独立于业务实体）。 */
export type StreamSyncPhase =
  | 'idle'
  /** 已建连接，等待 STREAM_READY（此间新帧进暂存缓冲）。 */
  | 'awaiting-ready'
  /** 已收到 READY，bootstrap 在途（继续暂存帧）。 */
  | 'bootstrapping'
  /** 同步完成，进入正常实时模式。 */
  | 'live';

/** 暂存缓冲上限：超限即放弃本次同步（§8 第 5 段）。 */
const STAGED_FRAME_CAP = 2000;
const STAGED_BYTE_CAP = 2 * 1024 * 1024;

/** 合并持久化实体时用于比较新旧版本的字段名。 */
interface Versioned {
  version?: string | null;
}

/**
 * 比较两个字符串版本号（雪花 ID 十进制文本，按 BigInt 比大小）。
 * 任一无法解析为纯数字时返回 `null`（无法比较），由调用方决定保守策略。
 */
function compareVersion(left?: string | null, right?: string | null): number | null {
  if (left == null || right == null) return null;
  const a = String(left).trim();
  const b = String(right).trim();
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  if (bigA === bigB) return 0;
  return bigA < bigB ? -1 : 1;
}

/**
 * 判断「新实体是否应覆盖旧实体」：版本可比较时取较新者；不可比较时**保守接受新值**
 * （通知一般晚于快照，且 bootstrap 与实时同源）。§8 要求「较旧版本不能覆盖较新事件」。
 */
function shouldApply(incoming: Versioned, existing: Versioned | undefined): boolean {
  if (!existing) return true;
  const cmp = compareVersion(incoming.version, existing.version);
  if (cmp === null) return true;
  return cmp > 0;
}

export const useStreamV3Store = defineStore('streamV3', () => {
  /* -------------------- 唯一状态槽 -------------------- */
  const responses = shallowRef<Map<string, ResponseSlot>>(new Map());
  const tools = shallowRef<Map<string, ToolCallVO>>(new Map());
  const executions = shallowRef<Map<string, ExecutionStateVO>>(new Map());
  const turns = shallowRef<Map<string, ChatTurn>>(new Map());
  const sessions = shallowRef<Map<string, SessionVO>>(new Map());

  /**
   * 持久化历史行：rootSessionId → (messageId → 行)。
   *
   * <p><b>为什么历史也进 v3 状态源</b>：批次 A 的硬要求是「bootstrap、历史分页、命令回执也统一
   * 进入 v3，否则双源竞争」。实时响应（{@link responses}）与持久化行（本槽）是**同一份业务状态的
   * 两个阶段**：未提交的活响应按 streamKey 存，提交后由 MESSAGE_COMMITTED 绑定 messageId，
   * 最终以持久化行形态出现在历史槽里。视图适配层把两者按 turnId 归并成消息，不另存第二份。</p>
   *
   * <p>按 messageId 作为键：分页可能重复拉同一行（游标边界），同键覆盖天然幂等。</p>
   */
  const history = shallowRef<Map<string, Map<string, SessionMessageVO>>>(new Map());
  /** 各会话历史是否还有更早一页（游标分页用）；缺省 true。 */
  const historyHasMore = shallowRef<Record<string, boolean>>({});
  /** 各会话历史下一页游标；null/缺失 = 未知。 */
  const historyCursor = shallowRef<Record<string, string | null>>({});
  /**
   * 各会话是否已装载过历史首屏。
   *
   * <p>与 {@link historyRevision} 配对的作废判据：代际变化时必须重置历史槽（旧代际的行已作废），
   * 但「重置」不等于「已装载」—— 适配层据此区分「历史真空」与「历史尚未拉取」，不把空历史渲染成
   * 「没有消息」。</p>
   */
  const historyLoaded = shallowRef<Record<string, boolean>>({});

  /** 各会话当前写代次（historyRevision）：变化即旧代际作废（§8.1 路径 3）。 */
  const historyRevision = shallowRef<Map<string, string>>(new Map());

  /**
   * 各根会话树已被作废的**轮次 / 执行身份**（作废范围登记）。
   *
   * <p><b>为什么墓碑不够</b>：`responses` 里的墓碑只认「store 已经见过的 streamKey」。
   * 旧代际的迟到帧若带的是一个**从未出现过的新 streamKey**，`ensureResponse` 会为它凭空建槽，
   * 旧正文照样被接纳 —— 墓碑对未知身份完全失效。</p>
   *
   * <p>因此作废时必须**按身份**登记：被点名的 turnId / executionId 一旦作废，之后任何引用它们的
   * 帧（无论 streamKey 新旧）都不得复活。身份是比 streamKey 更稳定的判据 —— streamKey 每次
   * 响应都不同，而它挂在哪个轮次/执行上是确定的。</p>
   */
  const doomedTurns = shallowRef<Map<string, Set<string>>>(new Map());
  const doomedExecutions = shallowRef<Map<string, Set<string>>>(new Map());
  /** 各会话同步阶段（连接控制态，非业务实体）。 */
  const syncPhase = ref<Record<string, StreamSyncPhase>>({});
  /**
   * 各会话「同步失败」事件计数（单调递增）。
   *
   * <p>协调器用 `watch` 观察它：任一失败的同步出口（bootstrap 报错 / 暂存溢出 / 版本不符）
   * 都会递增，协调器据此登记有界退避恢复。它与 {@link syncPhase} 不同 —— phase 只有
   * 「当前处于哪一步」的语义，观察 idle **不会**告诉你「刚刚失败了一次」还是「本来就在 idle」。</p>
   */
  const syncFailureSeq = ref<Record<string, number>>({});
  /** 本连接标识（STREAM_READY.data.connectionId），供调试与日志。 */
  const connectionIds = ref<Record<string, string>>({});

  /** 每会话的暂存缓冲（READY 之前 + bootstrap 在途时的新帧）。 */
  const staged = new Map<string, { frames: StreamV3Event[]; bytes: number }>();
  /**
   * 每会话的同步代次（token）。
   *
   * <p><b>为什么需要它</b>：bootstrap 是一次网络往返。若期间切走再切回（或连接换代），
   * 旧请求仍会返回 —— 没有代次判定，它就会把**上一代**的持久化快照写进新连接的状态，
   * 表现为代际回退、已被实时更新过的实体被旧值覆盖。</p>
   *
   * <p>由 {@link beginSync} / {@link beginResync} / {@link invalidateSync} 递增；
   * {@link applyBootstrap} 携带发起时的 token，不一致即整体丢弃。</p>
   */
  const syncTokens = new Map<string, number>();

  /** 递增某会话的同步代次，返回新值。 */
  const bumpSyncToken = (key: string): number => {
    const token = (syncTokens.get(key) ?? 0) + 1;
    syncTokens.set(key, token);
    return token;
  };

  const setPhase = (rootSessionId: string, phase: StreamSyncPhase) => {
    syncPhase.value = { ...syncPhase.value, [rootSessionId]: phase };
  };

  /** 覆盖式写一个 map（shallowRef 需整体替换才能触发消费方更新）。 */
  const writeMap = <T>(source: Map<string, T>, key: string, value: T): Map<string, T> => {
    const next = new Map(source);
    next.set(key, value);
    return next;
  };

  /* -------------------- 同步时序（§8 四步） -------------------- */

  /**
   * 第 1 步：建立新连接代次，进入「等待 READY」并清空暂存。
   *
   * <p>READY 之前的帧不存在（它是首帧），故此刻起把后续帧暂存，直到同步结束再按 FIFO 回放。</p>
   *
   * @returns 本次同步的代次 token；bootstrap 返回时必须原样带回 {@link applyBootstrap}
   */
  const beginSync = (rootSessionId: string): number => {
    const key = String(rootSessionId);
    const token = bumpSyncToken(key);
    staged.set(key, { frames: [], bytes: 0 });
    setPhase(key, 'awaiting-ready');
    return token;
  };

  /**
   * 第 1 步的变体：**连接已在跑**时的重新同步（重挂到既有连接）。
   *
   * <p><b>为什么不能复用 {@link beginSync}</b>：复用连接不会重发 STREAM_READY。
   * 若进入「等待 READY」，既不会有人唤醒它，期间到达的帧还会被**无限暂存**而永不应用
   * （表现为「切回会话后界面不再更新」）。重挂的语义只是「中间可能漏了事件」，
   * 因此直接进入 bootstrap 在途：暂存屏障照常生效，只是不等那个永远不会到的控制帧。</p>
   *
   * @returns 本次同步的代次 token
   */
  const beginResync = (rootSessionId: string): number => {
    const key = String(rootSessionId);
    const token = bumpSyncToken(key);
    staged.set(key, { frames: [], bytes: 0 });
    setPhase(key, 'bootstrapping');
    return token;
  };

  /**
   * 让某会话**在途**的同步作废（切走会话 / 关闭连接）。
   *
   * <p>只递增代次、不改阶段：连接可能已经被上层关闭，这里只负责让旧请求的结果落不了地。</p>
   */
  const invalidateSync = (rootSessionId: string): void => {
    bumpSyncToken(String(rootSessionId));
  };

  /**
   * 处理 STREAM_READY（第 2 步的前置）：读 `data.connectionId` 与 `data.schemaVersion`。
   *
   * <p>版本 != 3 表示服务端下发了非本协议帧 → **放弃本次同步并返回 false**，调用方应关闭连接、
   * 提示刷新。身份字段全 null 是控制帧的正常形态，不参与实体定位。</p>
   *
   * <p>★ 同一连接上的**重复 READY 幂等**：身份没变就不重置阶段。否则一条重复控制帧会把
   * 已 live 的会话打回 bootstrapping，而重复 READY 之后不会再有 bootstrap 来把它救回来 ——
   * 后续帧被无限暂存，表现为「界面从此不再更新」。</p>
   *
   * @returns 是否为可用的 v3 READY
   */
  const onStreamReady = (rootSessionId: string, event: StreamV3Event): boolean => {
    const key = String(rootSessionId);
    const payload = event.data as StreamV3ReadyPayload | null;
    const schemaVersion = payload && typeof payload.schemaVersion === 'number' ? payload.schemaVersion : NaN;
    if (schemaVersion !== 3) {
      console.warn('[streamV3] STREAM_READY schemaVersion 非 3，放弃同步并要求刷新:', schemaVersion);
      setPhase(key, 'idle');
      staged.delete(key);
      return false;
    }
    const connectionId = String(payload?.connectionId ?? '');
    const sameConnection = connectionIds.value[key] === connectionId;
    connectionIds.value = { ...connectionIds.value, [key]: connectionId };
    // 已在 live 且连接未变 = 这条 READY 不代表新一轮同步，保持 live 不动。
    if (sameConnection && syncPhase.value[key] === 'live') return true;
    // 暂存屏障必须在「进入 bootstrap 在途」这一刻就位：失败后重试走的是 abortSync，
    // 它会清掉缓冲，而重试的 READY 不会再来一次 beginSync —— 缺这一行则重试期间到达的
    // 帧会被静默丢弃（stage 找不到缓冲就直接返回），比缓冲溢出还难查。
    // 只补位、不重置：重置会把这一代已暂存的帧清掉。
    if (!staged.has(key)) staged.set(key, { frames: [], bytes: 0 });
    setPhase(key, 'bootstrapping');
    return true;
  };

  /**
   * 第 3+4 步：应用 bootstrap 快照，随后按 FIFO 回放暂存帧。同步结束进入 live。
   *
   * <p>合并规则（§8）：按 scope、historyRevision、实体 version 合并；bootstrap **范围外**的实体
   * **不得**当作已删除（保留）；historyRevision 增大时清除旧代际历史与未提交响应。</p>
   *
   * @returns 快照是否被**本次代次接纳**（已应用）。`false` 表示被代次 guard 拒绝（过期快照），
   *   调用方**不得**把它记为同步成功 —— 否则协调器会清掉退避计数、丢掉恢复机会。
   */
  const applyBootstrap = (rootSessionId: string, snapshot: SessionBootstrapVO, token?: number): boolean => {
    const key = String(rootSessionId);

    // 第 0 步：代次判定。bootstrap 是网络往返，返回时可能已经换了连接 / 换过会话。
    // 过期快照必须整体丢弃 —— 部分应用会造成「新代际的实时值被旧快照覆盖」这种最难查的错位。
    if (token !== undefined && token !== (syncTokens.get(key) ?? 0)) {
      console.warn('[streamV3] 过期的 bootstrap 响应，已丢弃:', key);
      return false;
    }

    // 3a. historyRevision：变化即旧代际作废（清除未提交响应），再记录新值。
    const incomingRevision = String(snapshot.historyRevision ?? '');
    if (incomingRevision) {
      const previousRevision = historyRevision.value.get(key);
      if (previousRevision !== undefined && previousRevision !== incomingRevision) {
        invalidateGeneration(key);
      }
      historyRevision.value = writeMap(historyRevision.value, key, incomingRevision);
    }

    // 3b. 会话实体：按 version 合并（bootstrap 覆盖同 id 旧值当且仅当更新）。
    for (const session of snapshot.sessions ?? []) {
      if (session?.id == null) continue;
      const sid = String(session.id);
      if (shouldApply(session as Versioned, sessions.value.get(sid) as Versioned | undefined)) {
        sessions.value = writeMap(sessions.value, sid, session);
      }
    }

    // 3c. 进行中轮次：只补历史分页取不到的活跃轮次（同 turnId 以 history.turns 为准，但此处仍
    //     写入，消费方合并时后者覆盖）。已终结轮次不重复下发。
    for (const turn of snapshot.turns ?? []) {
      if (turn?.turnId == null) continue;
      const tid = String(turn.turnId);
      if (shouldApply(turn as Versioned, turns.value.get(tid) as Versioned | undefined)) {
        turns.value = writeMap(turns.value, tid, turn);
      }
    }

    // 3d. 未决卡片：完整 ToolCallVO，按 version 合并。
    for (const tool of snapshot.toolCalls ?? []) {
      if (tool?.id == null) continue;
      const toolKey = String(tool.id);
      if (shouldApply(tool, tools.value.get(toolKey))) {
        tools.value = writeMap(tools.value, toolKey, tool);
      }
    }

    // 3e. 执行状态：bootstrap 的 executions[] 直接参与 §8.1 路径 2（与实时等价）。
    for (const execution of snapshot.executions ?? []) {
      if (!execution?.executionId) continue;
      executions.value = writeMap(executions.value, String(execution.executionId), execution);
      // §8.1 路径 2：执行终态或 SUSPENDED（bootstrap 侧）→ 结束相关响应的进行态。
      // 判据是「响应停收」（含挂起），不是「执行终结」—— 挂起后这段同样不会再收增量。
      if (resolveResponseClosed(execution.status)) {
        finalizeByExecution(String(execution.executionId));
      }
    }

    // 3f. 历史首屏：持久化行 + 同页轮次摘要 + **行内工具事实**。首屏是「代际基准」——
    //     先按代际清旧，再整页覆盖。必须在 3g 对账之前：已决断事实要先进入 `tools` 基线，
    //     对账才不会把「已决断、但不在未决集合里」的工具误判成「该删的悬挂旧卡」。
    if (snapshot.history) {
      applyHistoryPage(key, snapshot.history, true);
    }

    // 3g. 未决集合对账：`bootstrap.toolCalls` 是该会话树**完整**的未决卡片集合，
    //      已决断的卡不会返回。因此「属于本根会话树、且仍是 pending、却不在该集合里」的旧实体
    //      必须清掉 —— 否则它在切回会话后继续以 v1「待审批」悬挂。
    //      ★ 只看 `pending === true`：已决断的实体（历史行带来的 v2）不在未决集合里是正常的，
    //        它不是「悬挂的旧卡」，删了会把权威历史事实一起抹掉。
    //      ★ 必须按根会话树筛选：多个根会话的连接可以同时活着，清宽一格就误删别人的卡片。
    reconcilePendingTools(key, snapshot.toolCalls ?? []);

    setPhase(key, 'live');
    flushStaged(key);
    // 只有落到这里才算「本次代次接纳了这份快照」；上面的 guard 提前 return false 的都是过期快照。
    return true;
  };

  /**
   * 应用一页持久化历史（bootstrap 首屏或游标翻页）。
   *
   * <p><b>首屏替换、翻页追加</b>：首屏是代际内的权威起点，必须整体替换（否则上一代际残留会混入）；
   * 翻页是「更早的历史」，按 messageId 追加合并（同键覆盖保证重复拉取幂等）。</p>
   *
   * <p>同页的 `turns` 字典（turnId → ChatTurn）并入轮次槽：它是持久化的 token/模型/耗时权威，
   * 与实时 TURN_UPDATED 走同一份 version 合并逻辑。</p>
   */
  const applyHistoryPage = (rootSessionId: string, page: SessionMessagePageVO, replace: boolean): void => {
    const key = String(rootSessionId);

    let rows = replace ? new Map<string, SessionMessageVO>() : new Map(history.value.get(key) ?? new Map());
    for (const record of page.records ?? []) {
      if (record?.id == null) continue;
      rows.set(String(record.id), record);
      // ★ 历史 TOOL 行携带的完整工具事实必须进入 `tools` 版本基线。
      //
      // 为什么不能只把它当「渲染数据」留在行里：`tools` 是 TOOL_CALL_UPDATED 的合并基线，
      // 决定「暂存/迟到的旧帧能否覆盖新事实」。若已决断的 v2 只存在于历史行、不进基线，
      // 回放一条更旧的 pending v1 时 `shouldApply(v1, undefined)` 会返回 true —— 旧卡被当新实体
      // 接纳、顶掉历史里的 v2，审批按钮在「已审批」之后又冒出来。
      //
      // 幂等：按 version 合并，同值不覆盖（`shouldApply` 已含版本比较）。
      if (record.toolCall && record.toolCall.id != null) {
        const toolKey = String(record.toolCall.id);
        if (shouldApply(record.toolCall, tools.value.get(toolKey))) {
          tools.value = writeMap(tools.value, toolKey, record.toolCall);
        }
      }
    }
    history.value = writeMap(history.value, key, rows);

    for (const turn of Object.values(page.turns ?? {})) {
      if (!turn || turn.turnId == null) continue;
      const tid = String(turn.turnId);
      if (shouldApply(turn as Versioned, turns.value.get(tid) as Versioned | undefined)) {
        turns.value = writeMap(turns.value, tid, turn);
      }
    }

    historyHasMore.value = { ...historyHasMore.value, [key]: Boolean(page.hasMore) };
    historyCursor.value = { ...historyCursor.value, [key]: page.nextCursor ?? null };
    if (replace) {
      historyLoaded.value = { ...historyLoaded.value, [key]: true };
    }
  };

  /**
   * 放弃本次同步（bootstrap 失败 / 暂存溢出 / READY 版本不符）：清暂存、回到 idle。
   *
   * <p><b>必须递增失败计数</b>：协调器无法只靠「phase 变 idle」判断失败 —— 它会先记
   * `bootstrappedConnectionId`、清退避计数，再调用返回 void 的 {@link applyBootstrap}；
   * 快照被代次 guard 拒绝时协调器毫不知情。失败计数是**单向信号**：协调器观察它变化即登记恢复，
   * 与失败来自哪条分支（bootstrap 报错 / 溢出 / 版本不符）无关。</p>
   *
   * @returns 作废后的新代次 token。调用方持有的 token 自此失效，须接住返回值继续使用 ——
   *   否则它下一次发起的 bootstrap 会因代次不符被自己丢弃。
   */
  const abortSync = (rootSessionId: string): number => {
    const key = String(rootSessionId);
    const token = bumpSyncToken(key);
    staged.delete(key);
    setPhase(key, 'idle');
    syncFailureSeq.value = { ...syncFailureSeq.value, [key]: (syncFailureSeq.value[key] ?? 0) + 1 };
    return token;
  };

  /* -------------------- 帧应用（§8.1 四路径 + 分派） -------------------- */

  /**
   * 该帧是否属于**已作废**的代际或身份（入口守卫）。
   *
   * <h3>两条判据</h3>
   * <ol>
   *   <li><b>代际落后</b>：帧自带 `historyRevision` 且严格小于当前代际 → 该帧产生于作废之前，
   *       一律拒绝。这是旧代际迟到的普通增量（新 streamKey 也拦得住）。</li>
   *   <li><b>身份已作废**：帧引用的 turnId / executionId 在作废范围里 → 拒绝。覆盖「帧不带
   *       revision、却指向已删除轮次」的情况（如某些工具/执行事实）。</li>
   * </ol>
   *
   * <h3>为什么不能一刀切按 revision 丢</h3>
   * USER 行、bootstrap 装入的旧行、以及部分事实帧**不带 `historyRevision`**（后端只在增量与
   * 提交上带）。对它们「没有 revision」不等于「旧」—— 只能回落到身份判据，不能凭空拒绝。
   * 因此本守卫是**保守拒绝**：任一判据命中才丢，判不出来就放行，交由各自的墓碑 / 版本比较处理。
   *
   * <h3>★ 为什么实体类帧（SESSION_UPDATED / TURN_UPDATED）不做代际判据</h3>
   * 它们的信封 `historyRevision` 填的是**实体自身字段**，不是根代际 ——
   * `CommittedStateV3Observer.publishSessionUpdated` 用的就是 `session.getHistoryRevision()`。
   * 而 `Session.historyRevision` 默认 `1L`、`SubSessionResolver.createSubSession` **不继承**根代际，
   * 于是「根已重发（revision=2）→ 新建子会话（还是 1）」这种**完全合法**的实体更新会被误判成
   * 旧代际而丢掉，症状是子会话不进 `sessions` 槽 → 子面板、卡片冒泡、范围判定全部失灵。
   *
   * 实体帧的正确防线是各自的 `version` 比较（`shouldApply`），那是**版本**语义，不是代际语义：
   * 一个实体只有「新旧」，没有「属于哪一代历史」。
   */
  const isStaleFrame = (event: StreamV3Event): boolean => {
    // STREAM_READY 是控制帧，身份全空，不参与判定。
    if (event.type === 'STREAM_READY') return false;

    const rootKey = event.rootSessionId == null ? null : String(event.rootSessionId);

    // 判据 1：代际落后 —— **只对把信封 revision 当真代际的帧生效**。
    // 实体类帧的信封 revision 是实体自身字段，交给它们的 version 比较处理（见方法 doc）。
    const carriesRootRevision =
      event.type !== 'SESSION_UPDATED' && event.type !== 'TURN_UPDATED';
    if (carriesRootRevision && rootKey && event.historyRevision != null) {
      const current = historyRevision.value.get(rootKey);
      if (current !== undefined && compareRevision(String(event.historyRevision), current) < 0) {
        console.warn('[streamV3] 旧代际帧，已拒绝:', event.type, event.historyRevision, '<', current);
        return true;
      }
    }

    // 判据 2：身份已被作废。归属键按帧自带 rootSessionId；它同时是作废登记键。
    if (rootKey) {
      const killedTurns = doomedTurns.value.get(rootKey);
      if (killedTurns && event.turnId != null && killedTurns.has(String(event.turnId))) {
        console.warn('[streamV3] 已作废轮次的帧，已拒绝:', event.type, 'turnId=', event.turnId);
        return true;
      }
      const killedExecutions = doomedExecutions.value.get(rootKey);
      if (killedExecutions && event.executionId != null && killedExecutions.has(String(event.executionId))) {
        console.warn('[streamV3] 已作废执行的帧，已拒绝:', event.type, 'executionId=', event.executionId);
        return true;
      }
    }
    return false;
  };

  /**
   * 唯一 ingress 入口：把一帧 v3 事件应用进状态。
   *
   * <p>分派依据是 {@link parseStreamV3Event} 的 `data.type`（不是 SSE `event:` 名）。未知类型
   * 已被解析层记 warn 并返回 `null`，此处直接忽略（不 fallback 成正文）。</p>
   */
  const applyFrame = (rootSessionId: string, event: StreamV3Event): void => {
    // 各类型一律按事件自带身份定位（rootSessionId 仅用于日志与 API 对称，不参与实体定位）。
    void rootSessionId;
    // ★ 失效守卫必须先于一切分派：旧代际 / 已作废身份的帧在入口就被拦住，
    //   否则它们会在各自的 applyXxx 里凭空建槽，把已作废的正文重新灌进视图。
    if (isStaleFrame(event)) {
      return;
    }
    switch (event.type) {
      case 'STREAM_READY':
        // 已由 onStreamReady 单独处理；此处兜底忽略重复帧。
        return;
      case 'RESPONSE_STARTED':
        applyResponseStarted(event);
        return;
      case 'TEXT_DELTA':
        applyDelta(event, 'text');
        return;
      case 'THINKING_DELTA':
        applyDelta(event, 'thinking');
        return;
      case 'RESPONSE_FINALIZED':
        applyResponseFinalized(event);
        return;
      case 'MESSAGE_COMMITTED':
        applyMessageCommitted(event);
        return;
      case 'TOOL_CALL_UPDATED':
        applyToolCallUpdated(event);
        return;
      case 'EXECUTION_UPDATED':
        applyExecutionUpdated(event);
        return;
      case 'TURN_UPDATED':
        applyTurnUpdated(event);
        return;
      case 'SESSION_UPDATED':
        applySessionUpdated(event);
        return;
      case 'HISTORY_INVALIDATED':
        applyHistoryInvalidated(event);
        return;
      default: {
        // 类型联合已穷尽；防御将来 wire 值新增时前端未同步的静默丢帧。
        const exhaustive: never = event.type;
        console.warn('[streamV3] 未处理的事件类型，已忽略:', exhaustive);
        return;
      }
    }
  };

  /** 对外的 ingress：按会话阶段决定「直接应用」还是「暂存」。 */
  const ingress = (rootSessionId: string, event: StreamV3Event): void => {
    const key = String(rootSessionId);
    const phase = syncPhase.value[key];
    if (phase === 'awaiting-ready' || phase === 'bootstrapping') {
      if (event.type === 'STREAM_READY') return; // READY 由控制流程处理
      stage(key, event);
      return;
    }
    applyFrame(key, event);
  };

  /**
   * 暂存一帧；超帧数/字节上限即放弃本次同步（§8 第 5 段）。
   *
   * <p><b>溢出必须作废同步代次</b>：缓冲里已经暂存的帧随 `staged.delete` 一起丢失，本次同步
   * 的「完整性」已经不成立。若不作废 token，在途的 bootstrap 返回时仍会通过代次 guard、
   * 把这次残缺同步标记为 live —— 系统声称同步成功，实际丢了中间一大段事件。</p>
   *
   * <p>作废后 phase 回到 idle，由 {@link streamV3Sync} 的失败出口统一登记退避恢复。</p>
   */
  const stage = (rootSessionId: string, event: StreamV3Event): void => {
    const buffer = staged.get(rootSessionId);
    if (!buffer) return;
    const size = estimateBytes(event);
    if (buffer.frames.length + 1 > STAGED_FRAME_CAP || buffer.bytes + size > STAGED_BYTE_CAP) {
      console.warn('[streamV3] 暂存缓冲溢出，放弃本次同步:', rootSessionId);
      // 与 bootstrap 失败走同一出口：作废旧代次 + 清缓冲 + 回 idle。
      abortSync(rootSessionId);
      return;
    }
    buffer.frames.push(event);
    buffer.bytes += size;
  };

  /** 按 FIFO 回放暂存帧，然后清空缓冲。 */
  const flushStaged = (rootSessionId: string): void => {
    const buffer = staged.get(rootSessionId);
    if (!buffer) return;
    const frames = buffer.frames;
    staged.delete(rootSessionId);
    for (const frame of frames) {
      applyFrame(rootSessionId, frame);
    }
  };

  /** 粗略估算一帧字节数（仅用于缓冲上限判定，不需精确）。 */
  const estimateBytes = (event: StreamV3Event): number => {
    try {
      return JSON.stringify(event).length;
    } catch {
      // 循环引用等异常：按一个保守的大值计，促使尽快触发上限。
      return 4096;
    }
  };

  /* -------------------- 各类型应用逻辑 -------------------- */

  /** 取或建 response 槽。 */
  const ensureResponse = (streamKey: string, event: StreamV3Event): ResponseSlot => {
    const existing = responses.value.get(streamKey);
    if (existing) return existing;
    const created: ResponseSlot = {
      streamKey,
      text: '',
      thinking: '',
      messageId: null,
      started: false,
      incompleteUntilFinalized: false,
      finalized: false,
      executionId: event.executionId ?? null,
      sessionId: event.sessionId,
      turnId: event.turnId,
      discarded: false,
    };
    responses.value = writeMap(responses.value, streamKey, created);
    return created;
  };

  /** RESPONSE_STARTED：确认本响应身份，清除「接续片段」标记（§8.1 路径 4 的反面）。 */
  const applyResponseStarted = (event: StreamV3Event): void => {
    const payload = event.data as StreamV3ResponseStartedPayload | null;
    const streamKey = payload?.streamKey ?? event.streamKey;
    if (!streamKey) {
      console.warn('[streamV3] RESPONSE_STARTED 缺 streamKey，已忽略');
      return;
    }
    const current = ensureResponse(streamKey, event);
    if (current.finalized) {
      // 已定格的响应：迟到 STARTED 不得复活（§8.1 路径 4）。
      return;
    }
    responses.value = writeMap(responses.value, streamKey, {
      ...current,
      // 执行归属：RESPONSE_STARTED 帧顶层带 executionId（后端构造 v3 身份时已发），
      // 记到 slot 上供 §8.1 路径 2 按执行精确定格；帧缺失时保留既有值，不覆盖成 null。
      executionId: event.executionId ?? current.executionId,
      started: true,
      incompleteUntilFinalized: false,
    });
  };

  /**
   * TEXT_DELTA / THINKING_DELTA：只追加片段。
   *
   * <p>未见证 RESPONSE_STARTED 且未定格的响应 → 标记 `incompleteUntilFinalized`（接续片段语义，
   * §8 末段）。已定格的响应收到迟到 DELTA → 丢弃（§8.1 路径 4）。</p>
   */
  const applyDelta = (event: StreamV3Event, field: 'text' | 'thinking'): void => {
    const payload = event.data as StreamV3DeltaPayload | null;
    const streamKey = payload?.streamKey ?? event.streamKey;
    const delta = payload?.delta ?? '';
    if (!streamKey) {
      console.warn('[streamV3] 增量帧缺 streamKey，已忽略');
      return;
    }
    const current = ensureResponse(streamKey, event);
    if (current.finalized) {
      // 定格之后的迟到增量一律忽略，不得把已定格响应重新置为进行中（§8.1 路径 4）。
      return;
    }
    const next: ResponseSlot = {
      ...current,
      [field]: current[field] + delta,
      // 没有 STARTED 且没有已提交消息 → 记为接续片段（不断言它是完整响应）。
      incompleteUntilFinalized: !current.started && !current.messageId,
    };
    responses.value = writeMap(responses.value, streamKey, next);
  };

  /** RESPONSE_FINALIZED：替换全文、清片段标记并定格（§8.1 路径 1）。 */
  const applyResponseFinalized = (event: StreamV3Event): void => {
    const payload = event.data as StreamV3ResponseFinalizedPayload | null;
    const streamKey = payload?.streamKey ?? event.streamKey;
    if (!streamKey) {
      console.warn('[streamV3] RESPONSE_FINALIZED 缺 streamKey，已忽略');
      return;
    }
    const current = ensureResponse(streamKey, event);
    // 已作废（墓碑）：迟到的定稿不得把整段旧正文写回来。非作废的槽位允许再次定稿
    // （FINALIZED 之后仍可能有 MESSAGE_COMMITTED 用落库全文覆盖）。
    if (current.discarded) return;
    responses.value = writeMap(responses.value, streamKey, {
      ...current,
      text: payload?.text ?? current.text,
      thinking: payload?.thinking ?? current.thinking,
      incompleteUntilFinalized: false,
      finalized: true,
    });
  };

  /**
   * MESSAGE_COMMITTED：落库事实按**消息类型**落地（§8.1 路径 1）。
   *
   * <p><b>为什么按类型分两路</b>：后端 USER 行本来就没有 {@code streamKey}（它不是一次流式响应
   * 的产物），AI 行才有。若一律要求 streamKey，已有连接上的新提问会被整条丢弃；若反过来给 USER
   * 编造一个响应身份，又会让「响应」承载两种互斥语义。因此：**USER（及无 streamKey 的类型）按
   * messageId 入历史；AI 用 streamKey 绑定实时响应**；历史行保留真实 type，不改写成 AI。</p>
   */
  const applyMessageCommitted = (event: StreamV3Event): void => {
    const payload = event.data as StreamV3MessageCommittedPayload | null;
    const messageId = payload?.messageId ?? null;
    if (messageId == null) {
      console.warn('[streamV3] MESSAGE_COMMITTED 缺 messageId，已忽略');
      return;
    }
    const messageType = payload?.type ?? 'AI';
    const sessionId = payload?.sessionId ?? event.sessionId;
    if (sessionId == null) {
      console.warn('[streamV3] MESSAGE_COMMITTED 缺会话归属，已忽略: messageId=', messageId);
      return;
    }
    const turnId = payload?.turnId ?? event.turnId;
    const text = payload?.text ?? null;
    const streamKey = payload?.streamKey ?? event.streamKey;
    // 思考与工具调用随载荷下发（后端已解析落库实体的 AiMessageEntity）。载荷缺字段时退回活响应槽：
    // 兼容旧后端，也防「提交发生在活响应槽被清空之后」。两者都没有才留空。
    let thinking: string | undefined = payload?.thinking ?? undefined;
    let toolCalls: ModelToolCallVO[] | undefined = payload?.toolCalls ?? undefined;

    // AI：streamKey 是它与实时响应的绑定键；绑上后响应归一为「已提交」，不再重复渲染
    if (streamKey) {
      const current = ensureResponse(streamKey, event);
      if (current.discarded) {
        // 墓碑：该 streamKey 所属代际已被作废（例如重发）。迟到的提交必须**整条丢弃** ——
        // 只跳过响应绑定是不够的，下面的 appendCommittedRow 会把旧回答写回历史槽，
        // 让已作废的回答重新显示。
        console.warn('[streamV3] 已作废响应的迟到提交，整条丢弃: messageId=', messageId);
        return;
      }
      thinking = thinking ?? (current.thinking || undefined);
      responses.value = writeMap(responses.value, streamKey, {
        ...current,
        messageId,
        sessionId,
        turnId: turnId ?? current.turnId,
        text: text ?? current.text,
        incompleteUntilFinalized: false,
        finalized: true,
      });
    } else if (messageType === 'AI') {
      // AI 行没有 streamKey 仍入历史（正文权威在落库行），但实时响应无从绑定 —— 只告警不编造
      console.warn('[streamV3] AI 提交缺 streamKey，跳过响应绑定: messageId=', messageId);
    }

    // 提交即「持久化行」：按消息类型入历史槽（保留真实 type），让视图适配层只需读
    // 「历史行 + 未提交响应」两种形态。
    //
    // thinking 与 toolCalls 必须一并落行：实时通道不发 TOOL_CALL_UPDATED 帧（工具事实只存在于
    // 落库行），若历史行不带它们，实时路径就永远看不到思考步骤与工具痕迹 —— 只有刷新后的
    // bootstrap 才补得回来。这正是「工具调用无痕迹」的根因。
    appendCommittedRow(sessionId, {
      id: messageId,
      turnId: turnId ?? null,
      type: messageType,
      text: text == null ? undefined : text,
      thinking,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      streamKey: streamKey == null ? undefined : streamKey,
    });
  };

  /**
   * 把一条已提交消息写成历史行（按 messageId 幂等覆盖）。
   *
   * <p>{@code rootKey} 用归属会话 id：调用方传的是消息自身 sessionId，子会话消息因此归到子会话的
   * 历史槽 —— 与 {@link aggregateSessionMessages} 按 sessionId 聚合的口径一致。</p>
   */
  const appendCommittedRow = (rootKey: string, row: SessionMessageVO & { streamKey?: string }): void => {
    const key = String(rootKey);
    const rows = new Map(history.value.get(key) ?? new Map<string, SessionMessageVO>());
    rows.set(String(row.id), row);
    history.value = writeMap(history.value, key, rows);
  };

  /** TOOL_CALL_UPDATED：`data` 即完整 ToolCallVO，按 version 合并进 tools[toolCallId]。 */
  const applyToolCallUpdated = (event: StreamV3Event): void => {
    const card = event.data as ToolCallVO | null;
    if (!card || card.id == null) {
      console.warn('[streamV3] TOOL_CALL_UPDATED 缺卡片 id，已忽略');
      return;
    }
    const toolKey = String(card.id);
    if (shouldApply(card, tools.value.get(toolKey))) {
      tools.value = writeMap(tools.value, toolKey, card);
    }
  };

  /**
   * EXECUTION_UPDATED：`data.state` 是框架执行状态名。
   *
   * <p>§8.1 路径 2：该执行终态或 SUSPENDED（实时侧）→ 结束相关响应的进行态。</p>
   */
  const applyExecutionUpdated = (event: StreamV3Event): void => {
    const payload = event.data as StreamV3ExecutionStatePayload | null;
    const state = payload?.state ?? '';
    const executionId = event.executionId ?? '';
    if (!executionId) {
      console.warn('[streamV3] EXECUTION_UPDATED 缺 executionId，已忽略');
      return;
    }
    const previous = executions.value.get(executionId);
    executions.value = writeMap(executions.value, executionId, {
      executionId,
      sessionId: event.sessionId ?? previous?.sessionId ?? null,
      status: state,
      startedAt: previous?.startedAt ?? null,
      completedAt: previous?.completedAt ?? null,
    });
    // §8.1 路径 2（实时侧）：同 bootstrap，判「响应停收」而非「执行终结」。
    if (resolveResponseClosed(state)) {
      finalizeByExecution(executionId);
    }
  };

  /** TURN_UPDATED：轮次实体，按 version 合并进 turns[turnId]。 */
  const applyTurnUpdated = (event: StreamV3Event): void => {
    const turn = event.data as ChatTurn | null;
    if (!turn || turn.turnId == null) {
      console.warn('[streamV3] TURN_UPDATED 缺 turnId，已忽略');
      return;
    }
    const tid = String(turn.turnId);
    if (shouldApply(turn as Versioned, turns.value.get(tid) as Versioned | undefined)) {
      turns.value = writeMap(turns.value, tid, turn);
    }
  };

  /** SESSION_UPDATED：会话实体，按 version 合并进 sessions[sessionId]。 */
  const applySessionUpdated = (event: StreamV3Event): void => {
    const session = event.data as SessionVO | null;
    if (!session || session.id == null) {
      console.warn('[streamV3] SESSION_UPDATED 缺会话 id，已忽略');
      return;
    }
    const sid = String(session.id);
    if (shouldApply(session as Versioned, sessions.value.get(sid) as Versioned | undefined)) {
      sessions.value = writeMap(sessions.value, sid, session);
    }
  };

  /**
   * HISTORY_INVALIDATED：新代际 → 按**范围**作废旧代际事实（§8.1 路径 3）。
   *
   * <h3>为什么必须比较 revision</h3>
   * 失效帧与 bootstrap 是两条独立通道，**没有先后保证**。常见时序是：连接已订阅 → bootstrap
   * 在途 → 失效帧(rev=2) 被暂存 → bootstrap 返回 rev=2 的**权威快照** → 回放暂存的失效帧。
   * 若此处不看 revision 直接作废，刚装入的 rev=2 历史会当场被清空，而连接停在 live
   * 不再同步 —— 界面变成空白且无人负责恢复。
   *
   * <p>判定：同 revision 是**幂等重放**（快照已覆盖，不作废）；更旧 revision 是**迟到帧**
   * （不回退、不复活）；只有严格更高的 revision 才推进代际并执行作废语义。</p>
   *
   * <h3>为什么按范围而不是整树清空</h3>
   * 重发只作废「目标轮次及其后」，目标之前的第一轮必须保留。整树清空会把有效前缀一起抹掉，
   * 且后续的范围化回执无法把它恢复（回执只负责删，不负责还原）。范围由提交事实随帧直投
   * （{@code turnIds} / {@code executionIds}），与回执走**同一套** {@link discardByInvalidation}。
   */
  const applyHistoryInvalidated = (event: StreamV3Event): void => {
    const payload = event.data as StreamV3HistoryInvalidatedPayload | null;
    const rootSessionId = payload?.rootSessionId ?? event.rootSessionId;
    const revision = payload?.historyRevision;
    if (!rootSessionId || !revision) {
      console.warn('[streamV3] HISTORY_INVALIDATED 缺根会话或代际，已忽略');
      return;
    }
    const key = String(rootSessionId);
    const incoming = String(revision);
    const current = historyRevision.value.get(key);

    // 同代际：幂等重放。快照（或更早的失效）已经是这一代，重复作废只会误伤。
    if (current !== undefined && current === incoming) {
      return;
    }
    // 更旧代际：迟到的失效帧。回退 revision 或用旧范围作废新代际事实都会造成实质损坏。
    if (current !== undefined && compareRevision(incoming, current) < 0) {
      console.warn('[streamV3] 迟到的旧代际失效事件，已忽略:', key, incoming, '<', current);
      return;
    }

    // 新代际：先按范围作废旧事实，再记录代际。范围可能为空（纯代际清理），此时按整树作废
    // 未提交响应 —— 那是「换代」的本义，但**不动**已装入的历史槽（新代际首屏负责替换它）。
    const turnIds = payload?.turnIds ?? [];
    const executionIds = payload?.executionIds ?? [];
    invalidateGeneration(key, turnIds, executionIds);
    historyRevision.value = writeMap(historyRevision.value, key, incoming);
  };

  /**
   * 比较两个代际字符串：数值可比时按数值，否则按字符串序（保持确定性，不抛错）。
   *
   * <p>后端 revision 是递增计数，正常情况下是数字串；字符串兜底只是防御非法载荷。</p>
   */
  const compareRevision = (left: string, right: string): number => {
    const leftNum = Number(left);
    const rightNum = Number(right);
    if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
      return leftNum === rightNum ? 0 : leftNum < rightNum ? -1 : 1;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  };

  /**
   * 作废某会话的旧代际：清除**属于该根会话树**的未提交响应，并按范围删持久化行。
   *
   * <p><b>必须按根会话筛选</b>：未提交响应是全 store 共存的（多个根会话的连接可以同时活着）。
   * 不筛选就会把别的根会话正在生成的正文一起清掉 —— 那条连接上没有任何事件能让它恢复。</p>
   *
   * <p><b>作废 = 立墓碑而非删除</b>：删除会让仍在网络上的迟到 delta 用同一 streamKey 复活。</p>
   *
   * <p><b>范围为空 ≠ 清空历史</b>：早期实现无条件清整树历史，导致重发把目标之前的有效轮次
   * 一起抹掉。无范围时只按「已被立墓碑的 streamKey」摘孤儿行（已作废响应的持久化影子），
   * 更早的、没有对应活响应的有效历史照常保留。</p>
   *
   * @param turnIds 本次作废点名删除的轮次；为空表示只换代、按墓碑摘孤儿行
   * @param executionIds 本次作废点名删除的执行（卡片没有 turnId，只有 executionId）
   */
  const invalidateGeneration = (
    rootSessionId: string,
    turnIds: Array<string | number> = [],
    executionIds: Array<string | number> = []
  ): void => {
    const rootKey = String(rootSessionId);
    const next = new Map(responses.value);
    for (const [streamKey, slot] of next) {
      if (slot.discarded) continue;           // 已是墓碑：幂等
      if (slot.sessionId == null) {
        // 归属未知：无法断定它属于谁，保守只定格、不作废（与既有口径一致）。
        next.set(streamKey, { ...slot, incompleteUntilFinalized: false, finalized: true });
        continue;
      }
      if (!belongsToRoot(slot.sessionId, rootKey)) continue;  // 别的根会话：不动
      // 本根会话树的响应：立墓碑（清正文，阻断迟到帧复活，且不参与渲染）。
      // **含已提交的** —— 其历史行随代际一并清空，槽位成了孤儿；不立墓碑的话，
      // 迟到的 MESSAGE_COMMITTED 会借它把旧回答重新写回历史槽（复活已作废的回答）。
      next.set(streamKey, {
        ...slot,
        text: '',
        thinking: '',
        incompleteUntilFinalized: false,
        finalized: true,
        discarded: true,
      });
    }
    responses.value = next;
    // 持久化行：只删**被点名轮次**的行，保留有效前缀。范围为空则不动历史槽（由新代际首屏替换）。
    if (turnIds.length > 0 || executionIds.length > 0) {
      discardRowsByRange(rootKey, turnIds, executionIds);
      historyLoaded.value = { ...historyLoaded.value, [rootKey]: false };
    } else {
      // 无范围的纯换代：按**已被作废的响应身份**删行。
      //
      // 为什么需要这一步：已提交行是本代际流式响应落库后的持久化影子，它带着 `streamKey`。
      // 上面刚把本根会话树的活响应立了墓碑 —— 那些墓碑对应的历史行是孤儿，不删就会
      // 在「重发/换代但未携带范围」时继续显示已作废的旧回答（Ops 4B 时序）。
      //
      // 为什么不是整树清空：整树清空会把「没有对应活响应」的有效历史（更早轮次的落库行）
      // 一起抹掉 —— 那正是重发丢有效前缀的根因。按 streamKey 精确摘孤儿才两全。
      discardRowsByTombstonedStreams(rootKey);
    }
  };

  /**
   * 删除「streamKey 已被立为墓碑」的历史行（孤儿行）。
   *
   * <p>只删带 `streamKey` 且该 streamKey 在响应槽里已是 `discarded` 的行：无 streamKey 的历史
   * （USER 行、或 bootstrap 装入的旧行）不受影响，因而不会误伤有效前缀。</p>
   */
  const discardRowsByTombstonedStreams = (rootKey: string): void => {
    const rows = history.value.get(rootKey);
    if (!rows || rows.size === 0) return;
    let changed = false;
    const kept = new Map(rows);
    for (const [messageId, row] of kept) {
      const streamKey = (row as SessionMessageVO & { streamKey?: string }).streamKey;
      if (!streamKey) continue;
      if (responses.value.get(streamKey)?.discarded) {
        kept.delete(messageId);
        changed = true;
      }
    }
    if (changed) {
      history.value = writeMap(history.value, rootKey, kept);
      historyLoaded.value = { ...historyLoaded.value, [rootKey]: false };
    }
  };

  /**
   * 按轮次 / 执行范围删除持久化行与实体（幂等）。
   *
   * <p>供「代际作废」与「重发回执」两条入口复用 —— 范围语义只能有一套实现，
   * 否则失效帧与回执的删法会各自漂移，出问题时分不清是谁删多了。</p>
   */
  const discardRowsByRange = (
    rootKey: string,
    turnIds: Array<string | number>,
    executionIds: Array<string | number>
  ): void => {
    const killedTurns = new Set(turnIds.map(turnId => String(turnId)));
    const killedExecutions = new Set(executionIds.map(executionId => String(executionId)));
    if (killedTurns.size === 0 && killedExecutions.size === 0) return;

    // ★ 先登记作废身份：入口守卫据此拦住**之后**任何引用它们的帧（含未知 streamKey 的迟到增量）。
    //   登记必须早于删除，否则同一批帧的处理窗口内仍有漏网机会。
    registerDoomedIdentities(rootKey, killedTurns, killedExecutions);

    // 持久化行：按 turnId 删（只删被点名轮次的行，同会话其他轮次照常显示）。
    let historyChanged = false;
    const nextHistory = new Map(history.value);
    for (const [sessionId, rows] of nextHistory) {
      if (sessionId !== rootKey && !belongsToRoot(sessionId, rootKey)) continue;
      const kept = new Map(rows);
      for (const [messageId, row] of kept) {
        if (row.turnId != null && killedTurns.has(String(row.turnId))) {
          kept.delete(messageId);
          historyChanged = true;
        }
      }
      if (kept.size !== rows.size) nextHistory.set(sessionId, kept);
    }
    if (historyChanged) history.value = nextHistory;

    // 轮次与卡片实体：复用既有的按 id 删除（本身就是幂等删除）。
    dropTurns([...killedTurns]);
    dropToolsByExecution([...killedExecutions]);
  };

  /**
   * 登记某根会话树已被作废的轮次 / 执行身份（累积，幂等）。
   *
   * <p>身份登记与墓碑是**互补**的两道防线：墓碑认 streamKey（已知的响应），身份认
   * turnId/executionId（响应挂在谁身上）。只有墓碑时，迟到的旧代际帧用一个全新 streamKey
   * 就能绕过；登记身份后，无论 streamKey 新旧，只要指向已作废的轮次/执行就被拦下。</p>
   */
  const registerDoomedIdentities = (
    rootKey: string,
    turnIds: Set<string>,
    executionIds: Set<string>
  ): void => {
    if (turnIds.size > 0) {
      const merged = new Set(doomedTurns.value.get(rootKey) ?? []);
      for (const id of turnIds) merged.add(id);
      doomedTurns.value = writeMap(doomedTurns.value, rootKey, merged);
    }
    if (executionIds.size > 0) {
      const merged = new Set(doomedExecutions.value.get(rootKey) ?? []);
      for (const id of executionIds) merged.add(id);
      doomedExecutions.value = writeMap(doomedExecutions.value, rootKey, merged);
    }
  };

  /**
   * 某会话是否属于给定根会话树（自身即根，或 `sessions` 槽里声明的根一致）。
   *
   * <p>子会话实体可能尚未到达（SESSION_UPDATED 晚于帧），此时无法判定归属 → 返回 `false`，
   * 宁可漏作废（新代际首屏会覆盖）也不误删别的根会话。</p>
   */
  const belongsToRoot = (sessionId: string, rootKey: string): boolean => {
    if (sessionId === rootKey) return true;
    const session = sessions.value.get(sessionId);
    if (!session) return false;
    const declaredRoot = session.rootSessionId != null ? String(session.rootSessionId) : null;
    return declaredRoot === rootKey;
  };

  /**
   * §8.1 路径 2：按执行终态结束**归属该执行**的响应的进行态。
   *
   * <p>「定格为未接收完整、清除进行态、保留已收片段」—— 不删除已收到的片段（用户仍能看到），
   * 只把 `incompleteUntilFinalized` 置位并把响应定格，使后续迟到帧不再复活它。</p>
   *
   * <p><b>必须按执行精确匹配</b>：一个会话下可能并发多个执行（主执行 + 子代理执行），
   * 子执行终止不得定格主执行的响应 —— 否则主执行后续 delta 会被 §8.1 路径 4 丢弃、正文丢字。
   * 归属未知（`slot.executionId === null`）的响应**不动**：无法断定它属于谁，保守不动
   * （与 {@link invalidateGeneration} 同一标准）。</p>
   */
  const finalizeByExecution = (executionId: string): void => {
    if (!executionId) return;
    const next = new Map(responses.value);
    let changed = false;
    for (const [streamKey, slot] of next) {
      if (slot.finalized) continue;
      // 只定格明确归属该执行的响应；归属未知或属于别的执行的一律不动。
      if (slot.executionId !== executionId) continue;
      next.set(streamKey, { ...slot, incompleteUntilFinalized: true, finalized: true });
      changed = true;
    }
    if (changed) {
      responses.value = next;
    }
  };

  /* -------------------- 读取器 -------------------- */

  const getResponse = (streamKey: string): ResponseSlot | undefined =>
    responses.value.get(String(streamKey));

  const getTool = (toolCallId: string): ToolCallVO | undefined =>
    tools.value.get(String(toolCallId));

  const getExecution = (executionId: string): ExecutionStateVO | undefined =>
    executions.value.get(String(executionId));

  const getTurn = (turnId: string): ChatTurn | undefined =>
    turns.value.get(String(turnId));

  const getSession = (sessionId: string): SessionVO | undefined =>
    sessions.value.get(String(sessionId));

  const getPhase = (rootSessionId: string): StreamSyncPhase =>
    syncPhase.value[String(rootSessionId)] ?? 'idle';

  /** 某会话当前全部持久化历史行（调用方按需排序/分组，不在此复制状态）。 */
  const getHistory = (rootSessionId: string): Map<string, SessionMessageVO> =>
    history.value.get(String(rootSessionId)) ?? new Map();

  const getHistoryHasMore = (rootSessionId: string): boolean =>
    historyHasMore.value[String(rootSessionId)] ?? false;

  const getHistoryCursor = (rootSessionId: string): string | null =>
    historyCursor.value[String(rootSessionId)] ?? null;

  const isHistoryLoaded = (rootSessionId: string): boolean =>
    Boolean(historyLoaded.value[String(rootSessionId)]);

  /**
   * 摄取一页游标分页历史（追加语义）。供「向上加载更早消息」调用。
   *
   * <p>不从 bootstrap 走同一入口：首屏是替换、翻页是追加，语义不同，故分开成两个参数化调用，
   * 由调用方声明意图而不是在本方法里猜。</p>
   */
  const ingestHistoryPage = (rootSessionId: string, page: SessionMessagePageVO, expectedRevision?: string): boolean => {
    if (!revisionMatches(rootSessionId, expectedRevision)) return false;
    applyHistoryPage(String(rootSessionId), page, false);
    return true;
  };

  /**
   * 替换某会话的持久化历史（代际基准，清旧后整页写入）。
   *
   * <p>用于「受同步屏障保护的基准重建」：bootstrap 建立的首页基准由屏障保护 ——
   * **普通详情与对账不要走这里**（快照缺行不等于行被删除，替换会把实时写入的新行抹掉），
   * 它们应走 {@link ingestHistoryPage} 在同代际内合并事实。</p>
   */
  const replaceHistory = (rootSessionId: string, page: SessionMessagePageVO, expectedRevision?: string): boolean => {
    if (!revisionMatches(rootSessionId, expectedRevision)) return false;
    applyHistoryPage(String(rootSessionId), page, true);
    return true;
  };

  /**
   * 某会话（含子会话）的代际**归属键**：代际记在根会话下，历史槽记在会话自身下。
   *
   * <p><b>为什么要归根</b>：bootstrap / HISTORY_INVALIDATED 只把代际记在根会话键下，
   * 若用子会话 id 去读会得到 undefined —— 调用方再把它当「不检查」处理，子会话的代次守卫
   * 就整体失效。因此校验范围（根）与写入位置（会话自身）必须分开。</p>
   */
  const resolveRevisionOwner = (sessionId: string): string => {
    const key = String(sessionId);
    const session = sessions.value.get(key);
    const declared = session?.rootSessionId != null ? String(session.rootSessionId) : null;
    return declared && declared !== '0' && declared !== key ? declared : key;
  };

  /** 某会话（含子会话）当前生效的代际；尚未建立基线时为空串。 */
  const currentHistoryRevision = (sessionId: string | number): string =>
    historyRevision.value.get(resolveRevisionOwner(String(sessionId))) ?? '';

  /**
   * 分页结果是否仍属当前代际。
   *
   * <p><b>为什么分页也要判代际</b>：分页是网络往返。重发会在往返期间推进代际并清空历史槽，
   * 旧请求随后返回就会把**作废前**的行重新灌回来（表现为「重发后旧消息又出现」）。
   * 调用方在发起请求时用 {@link currentHistoryRevision} 快照代际，返回时带回即可。</p>
   *
   * <p>{@code expectedRevision} 为 {@code undefined} 表示调用方显式选择不校验（仅供
   * 尚未接入守卫的旧调用方过渡）；正常调用方应始终传入 {@link currentHistoryRevision} 的结果。
   * 注意：**空串是合法基线**（bootstrap 尚未到达），不是「不检查」—— 在途期间代际被推进时
   * 照样丢弃。</p>
   */
  const revisionMatches = (sessionId: string, expectedRevision?: string): boolean => {
    if (expectedRevision === undefined) return true;
    const current = currentHistoryRevision(sessionId);
    if (String(expectedRevision) === current) return true;
    console.warn('[streamV3] 过期的分页响应，已丢弃:', sessionId, expectedRevision, '!=', current);
    return false;
  };

  /**
   * 摄取一张未决卡片（命令回执 / 决策后刷新）。
   *
   * <p>卡片是**唯一工具实体**：按 toolCallId 存进 {@link tools}，消息视图只持有引用，
   * 不复制一份可变卡片状态（否则两处各自更新必然分叉）。</p>
   */
  const ingestToolCall = (tool: ToolCallVO): void => {
    if (!tool || tool.id == null) return;
    const toolKey = String(tool.id);
    if (shouldApply(tool, tools.value.get(toolKey))) {
      tools.value = writeMap(tools.value, toolKey, tool);
    }
  };

  /**
   * 摄取轮次摘要（命令回执 / 决策后刷新）。
   *
   * <p>与 TURN_UPDATED 帧走**同一份 version 合并逻辑** —— 回执与实时是同一实体的两个来源，
   * 合并规则必须一致，否则会出现「回执覆盖掉更新的实时值」。</p>
   */
  const ingestTurn = (turn: ChatTurn): void => {
    if (!turn || turn.turnId == null) return;
    const tid = String(turn.turnId);
    if (shouldApply(turn as Versioned, turns.value.get(tid) as Versioned | undefined)) {
      turns.value = writeMap(turns.value, tid, turn);
    }
  };

  /**
   * 未决卡片集合对账：把「属于本根会话树、仍在声称待审批、却不在快照未决集合里」的实体清掉。
   *
   * <p><b>为什么以快照为准</b>：后端 `bootstrap.toolCalls` 下发的是该会话树**完整**的未决集合，
   * 已决断的卡不再返回。因此缺席即「已在别处决断」，旧实体是过期事实 —— 不清就会在切回会话后
   * 继续以旧版本「待审批」悬挂，并把历史行里已批准的新版本事实顶掉。</p>
   *
   * <p><b>只清仍待审批的</b>：已定格的实体不再以「待审批」悬挂，留着无害；而它可能还没有对应的
   * 历史行（决策与提交是两条通道），删掉会让已决断的卡片整块消失。只清 pending 是更保守的口径。</p>
   *
   * <p><b>必须按根会话树筛选</b>：多个根会话的连接可以同时活着，跨根删除会误伤别的会话的卡片。
   * 归属判不出的（子会话实体尚未到达）也不动 —— 宁可漏清，等下一次 bootstrap 再收敛。</p>
   */
  const reconcilePendingTools = (rootSessionId: string, pendingTools: ToolCallVO[]): void => {
    const rootKey = String(rootSessionId);
    const pendingIds = new Set(pendingTools.map(tool => String(tool.id)));
    const next = new Map(tools.value);
    let changed = false;
    for (const [toolId, tool] of next) {
      if (!pendingIds.has(toolId) && tool.pending === true && belongsToToolRoot(tool, rootKey)) {
        next.delete(toolId);
        changed = true;
      }
    }
    if (changed) tools.value = next;
  };

  /**
   * 工具实体是否属于给定根会话的会话树。
   *
   * <p>卡片只带 `conversationId`（即会话 id）、没有根 id，根归属需经 `sessions` 槽判定；
   * 判不出（子会话实体未到达）时返回 false，含义是「不动」。</p>
   */
  const belongsToToolRoot = (tool: ToolCallVO, rootKey: string): boolean => {
    if (tool.conversationId == null) return false;
    return belongsToRoot(String(tool.conversationId), rootKey);
  };

  /**
   * 移除若干轮次实体（重发作废范围）。
   *
   * <p><b>为什么必须由回执驱动删除</b>：重发是物理删除，被作废轮次的摘要（token/模型/状态）
   * 若不逐条移除，会继续让已删除的轮次以「失败」「已完成」的样子渲染出来。只清实时槽不够 ——
   * `turns` 里可能两者都有。</p>
   */
  const dropTurns = (turnIds: Array<string | number>): void => {
    if (turnIds.length === 0) return;
    const doomed = new Set(turnIds.map(turnId => String(turnId)));
    const next = new Map(turns.value);
    for (const turnId of doomed) next.delete(turnId);
    turns.value = next;
  };

  /**
   * 移除若干执行产出的工具实体（重发作废范围）。
   *
   * <p>卡片没有 turnId，但**有 executionId**；回执的 `invalidatedExecutionIds` 正是它的钥匙。
   * 不按执行清掉，被作废轮次的待审批卡会继续挂在界面上（还会跨会话冒泡到根视图）。</p>
   */
  const dropToolsByExecution = (executionIds: Array<string | number>): void => {
    if (executionIds.length === 0) return;
    const doomed = new Set(executionIds.map(executionId => String(executionId)));
    const next = new Map(tools.value);
    for (const [toolId, tool] of next) {
      if (tool.executionId != null && doomed.has(String(tool.executionId))) next.delete(toolId);
    }
    tools.value = next;
  };

  /**
   * 按**回执点名的范围**作废重发影响到的旧代际事实（重发回执专用，幂等）。
   *
   * <h3>为什么不能用 {@link resetSession}</h3>
   * `resetSession` 是「切走这个会话」的清空语义：它清整棵树的 `responses` 与 `history`。
   * 而重发回执与 SSE 事件流**没有顺序保证** —— 常见时序是失效事件与新代际的提交先到、
   * 回执后到。此时用 `resetSession` 会把**已经到达的新代际正文**一起抹掉，表现为「重发后回答消失」。
   *
   * <h3>为什么按 turnId / executionId 而不是按代际</h3>
   * 回执给的就是精确范围（后端物理删除了哪些轮次与执行）。按代际作废是隐式推断：一旦
   * 「回执所知的旧代际」与「前端已收到提交的新代际」交错，按代际清会把新事实当成旧的清掉 ——
   * 这正是要修的 bug。范围化之后，两个通道无论谁先到，最终状态都收敛到同一结果。
   *
   * <p><b>幂等</b>：重复调用结果相同（墓碑跳过、删除按 id 幂等），因此回执重复投递安全。</p>
   *
   * @param rootSessionId 被重发的根会话（作废范围限定在它的会话树内）
   * @param turnIds 回执声明被物理删除的轮次
   * @param executionIds 回执声明被删除的执行（卡片没有 turnId，只有 executionId）
   */
  const discardByInvalidation = (
    rootSessionId: string,
    turnIds: Array<string | number>,
    executionIds: Array<string | number> = []
  ): void => {
    const rootKey = String(rootSessionId);
    const doomedTurns = new Set(turnIds.map(turnId => String(turnId)));
    const doomedExecutions = new Set(executionIds.map(executionId => String(executionId)));
    if (doomedTurns.size === 0 && doomedExecutions.size === 0) return;

    // 1. 响应槽：命中范围的立墓碑（而非删除），阻断仍在网络上的迟到 delta 复活旧正文。
    //    范围之外（含新代际已到达的响应）一律不动。
    let responsesChanged = false;
    const nextResponses = new Map(responses.value);
    for (const [streamKey, slot] of nextResponses) {
      if (slot.discarded) continue;                                  // 已是墓碑：幂等
      if (slot.sessionId == null || !belongsToRoot(slot.sessionId, rootKey)) continue;  // 归属不明或别的根：不动
      const hitTurn = slot.turnId != null && doomedTurns.has(String(slot.turnId));
      const hitExecution = slot.executionId != null && doomedExecutions.has(String(slot.executionId));
      if (!hitTurn && !hitExecution) continue;
      nextResponses.set(streamKey, {
        ...slot,
        text: '',
        thinking: '',
        incompleteUntilFinalized: false,
        finalized: true,
        discarded: true,
      });
      responsesChanged = true;
    }
    if (responsesChanged) responses.value = nextResponses;

    // 2. 持久化行与实体：与代际作废共用同一套范围删除，避免两条入口的删法漂移。
    const rowsBefore = history.value.get(rootKey);
    discardRowsByRange(rootKey, turnIds, executionIds);
    // 行被物理删除过一轮：首屏基准已不是「原样」，让消费层知道可以重新对齐。
    if (history.value.get(rootKey) !== rowsBefore) {
      historyLoaded.value = { ...historyLoaded.value, [rootKey]: false };
    }
  };

  /** 清空某会话全部实时状态（切换会话 / 断开且不再订阅时）。 */
  const resetSession = (rootSessionId: string): void => {
    const key = String(rootSessionId);
    // 切走即作废在途同步：否则旧 bootstrap 返回时会把刚清空的状态又写回来。
    bumpSyncToken(key);
    const nextResponses = new Map(responses.value);
    for (const [streamKey, slot] of nextResponses) {
      // 按**根会话树**清：只清根自身会让子会话的活响应残留下来，
      // 切回来时它们会以「未提交响应」的形态混进新会话的视图。
      if (slot.sessionId == null || belongsToRoot(slot.sessionId, key)) nextResponses.delete(streamKey);
    }
    responses.value = nextResponses;
    // 历史槽也按会话清：切走再回来必须重新拉首屏，不能复用可能已过期的行。
    history.value = writeMap(history.value, key, new Map());
    historyLoaded.value = { ...historyLoaded.value, [key]: false };
    staged.delete(key);
    setPhase(key, 'idle');
  };

  return {
    // 状态槽
    responses,
    tools,
    executions,
    turns,
    sessions,
    history,
    historyRevision,
    currentHistoryRevision,
    historyHasMore,
    historyCursor,
    historyLoaded,
    syncPhase,
    syncFailureSeq,
    connectionIds,
    // 同步时序
    beginSync,
    beginResync,
    invalidateSync,
    onStreamReady,
    applyBootstrap,
    abortSync,
    // 帧应用
    ingress,
    applyFrame,
    // 持久化摄取（bootstrap 首屏 / 分页 / 回执）
    ingestHistoryPage,
    replaceHistory,
    ingestToolCall,
    ingestTurn,
    dropTurns,
    dropToolsByExecution,
    discardByInvalidation,
    // 读取器
    getResponse,
    getTool,
    getExecution,
    getTurn,
    getSession,
    getPhase,
    getHistory,
    getHistoryHasMore,
    getHistoryCursor,
    isHistoryLoaded,
    resetSession,
  };
});
