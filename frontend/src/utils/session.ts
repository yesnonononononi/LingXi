import type { ChatMessage, ChatSession, ChatTurn, ToolCallVO, SessionMessageVO, SubSessionVO } from '../types/chat';
import type { TurnViewVO } from '../types/block';
import type { ToolExecutionState } from './toolMeta';
import { isEditFileTool, resolveToolCategory, resolveToolMeta } from './toolMeta';
import { asObject, toObject, toText } from './json';
import { isTempSessionId } from './ids';
import { parseTimestamp } from './time';
import { upsertPromptCard } from './toolCallCard';
import { upsertTurnViewIntoMessages } from '../views/chat/blockProjection';

/**
 * 将后端 SessionMessageVO.records 解析为前端展示所用的标准 ChatMessage[] 结构。
 *
 * 契约来源：GET /session/{id}/messages → SessionMessagePageVO.records（已是结构化 VO）。
 * 消息类型收敛为 USER / AI / TOOL / SYSTEM；工具调用状态与卡片载荷来自 TOOL 行携带的
 * 聚合 ToolCallVO（`item.toolCall`），与实时工具事件拉取的 VO 同源、同形状。
 * 执行失败**不再**以 ERROR 行落库，改由同页下发的 turns[turnId].status/errorReason 呈现。
 */

/**
 * 解析单条消息的创建时间。
 * 解析不出来返回 null，由调用方决定降级方式 —— 绝不用 Date.now() 冒充历史时间。
 */
function parseItemTimestamp(item: any): number | null {
  // 契约来源：SessionMessageVO.createTime（Instant，序列化为 ISO 字符串）。
  return parseTimestamp(item.createTime);
}

/**
 * 归一化 turnId：字符串（雪花 ID 已 Long→String）保留，空值/缺失归为 null。
 *
 * <p>null 表示「归属未知」（旧数据），调用方须走降级路径，**不得**据此伪造统计。</p>
 */
export function normalizeTurnId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** 回答组：以 turnId 为唯一键的一段连续消息。 */
export interface AnswerGroup {
  /** 分组键：turnId；旧数据（归属未知）为 null。 */
  turnId: string | null;
  messages: ChatMessage[];
}

/**
 * 按 turnId 把消息切成回答组（渲染层唯一分组规则，主会话与子会话共用）。
 *
 * <p>规则（务必与后端契约一致）：</p>
 * <ol>
 *   <li>按服务端顺序遍历；USER 消息一律开启新组 —— 用户提问是轮次的起点；</li>
 *   <li>非 USER 消息：turnId 与当前组相同则并入，**不同必须拆组**，
 *       绝不能被旧的「USER 边界」逻辑跨轮次合并；</li>
 *   <li>turnId 为 null 的旧数据沿用「USER 边界」降级，且不伪造任何统计。</li>
 * </ol>
 */
export function groupMessagesByTurn(messages: ChatMessage[]): AnswerGroup[] {
  const groups: AnswerGroup[] = [];
  let current: AnswerGroup | null = null;
  for (const msg of messages) {
    const turnId = normalizeTurnId(msg.turnId);
    // USER 开新组；turnId 变化也开新组（含旧数据 null 的边界降级）。
    if (!current || msg.role === 'user' || current.turnId !== turnId) {
      current = { turnId, messages: [] };
      groups.push(current);
    }
    current.messages.push(msg);
  }
  return groups;
}

/** 消息 → 所属回答组的轮次摘要与组尾标记（主会话与子会话共用同一分组规则）。 */
export interface MessageTurnBinding {
  /** 该组所属轮次的权威摘要；null = 无摘要（旧数据 / 未采集），展示层须隐藏统计、绝不显示成 0。 */
  turn: ChatTurn | null;
  /** 是否为组尾：同一轮次只在组尾展示一次执行元信息。 */
  isGroupTail: boolean;
}

/**
 * 按 turnId 把消息分组，并把每组的轮次摘要（来自会话轮次表 `session.turns`）绑定到组内每条消息。
 *
 * <p>回答组的 token / 模型 / 耗时 / 状态是整轮属性，同组消息共享同一 turn。turnId 缺失
 * （旧数据）或轮次表无该键时保持 null —— 不得回落成会话累计用量或 0。</p>
 *
 * <p><b>键必须是消息对象引用，不能是 {@code m.id}</b>：聚合器会给同一轮的助手气泡发稳定
 * id（{@code msg-<sessionId>-turn-<turnId>}），跨页各聚合一次就会产生两条 <b>同 id 不同对象</b>
 * 的气泡；按 id 做键时后者覆盖前者，两条都被读成 {@code isGroupTail: true}，工具条在同一轮重复出现。
 * 键用对象引用后两条各自绑定，组尾仍唯一。</p>
 */
export function buildMessageTurnMap(
  messages: ChatMessage[],
  turns?: Record<string, ChatTurn> | null
): Map<ChatMessage, MessageTurnBinding> {
  const map = new Map<ChatMessage, MessageTurnBinding>();
  for (const group of groupMessagesByTurn(messages)) {
    const lastIdx = group.messages.length - 1;
    const turn = group.turnId != null ? turns?.[group.turnId] ?? null : null;
    group.messages.forEach((m, i) => {
      map.set(m, { turn, isGroupTail: i === lastIdx });
    });
  }
  return map;
}

/**
 * 逐页 union 合并轮次摘要表（键 = turnId，后到的覆盖先到的 —— 更新的快照更准确）。
 *
 * <p>返回新对象，不改动入参；缺失归一为 `{}`（无摘要 ≠ 用量为 0）。供消息对账与分页加载
 * 把每页下发的 turns 累积进会话实体的 `session.turns`。</p>
 */
export function mergeTurns(
  base: Record<string, ChatTurn> | null | undefined,
  incoming: Record<string, ChatTurn> | null | undefined
): Record<string, ChatTurn> {
  if (!base && !incoming) return {};
  return { ...(base ?? {}), ...(incoming ?? {}) };
}

/**
 * 合并不同分页的块视图表（键 = turnId）。
 *
 * <p><b>后到的覆盖先到的</b>：装配器按 turnId 读该轮的**全部**消息，与「本页切在哪」无关，
 * 因此任意一页给出的同轮视图都是完整的；而后发起的请求看到的是更新的库状态，故以它为准。
 * 与 {@link mergeTurns} 同口径，不做版本比较。</p>
 */
export function mergeTurnViews(
  base: Record<string, TurnViewVO> | null | undefined,
  incoming: Record<string, TurnViewVO> | null | undefined
): Record<string, TurnViewVO> {
  if (!base && !incoming) return {};
  return { ...(base ?? {}), ...(incoming ?? {}) };
}

/**
 * 会话是否处于「运行中」（进行中 或 挂起等待）。
 *
 * <p>生成中判据的唯一真源：受理是同步的（POST 立刻返回），只看 POST 会让界面在返回瞬间
 * 闪回可发送态；挂起（SUSPENDED）同样算运行中 —— 此时后端拒绝开新一轮，用户也不该能发。</p>
 */
export function isSessionRunning(runStatus: string | null | undefined): boolean {
  return runStatus === 'RUNNING' || runStatus === 'SUSPENDED';
}

/**
 * 会话树对账时合并子会话：树只下发元数据、不带消息正文，按 id 保留旧 VO 上已加载的消息。
 *
 * <p><b>为什么不能整体替换</b>：{@code subSessions} 每次对账都被树的新 VO 替换，而新 VO 的
 * {@code messages} 是空的；直接替换会把已加载/已实时渲染的子会话历史整段丢掉，且分页守卫会
 * 让后续点击不再重拉（表现为「点了子会话卡片，历史一闪就没了，再点也不加载」）。
 * 保留同一个 {@code messages} 数组引用，实时 reducer 也才能继续写进当前数组。</p>
 *
 * <p>轮次摘要逐页 union（键 = turnId，后到覆盖先到），语义同 {@link mergeTurns}。</p>
 */
export function mergeSubSessionTree(
  previous: SubSessionVO[] | null | undefined,
  incoming: SubSessionVO[]
): SubSessionVO[] {
  const prevById = new Map<string, SubSessionVO>();
  for (const sub of previous ?? []) {
    if (sub?.id == null) continue;
    prevById.set(String(sub.id), sub);
  }
  return incoming.map(fresh => {
    const old = prevById.get(String(fresh.id));
    if (!old) return fresh;
    return {
      ...fresh,
      messages: old.messages ?? fresh.messages,
      turns: mergeTurns(old.turns, fresh.turns)
    };
  });
}

/**
 * 解析会话实体的根会话 id（订阅键与子会话归属判定的唯一真源）。
 *
 * <p>后端契约：{@code rootSessionId} 为 {@code 0}（{@code Session.ROOT_SESSION_ID}）或 null
 * 都表示「自身即根」。只有非空且非 {@code '0'} 时才回指真正的根，否则取会话自身 id ——
 * 把 {@code '0'} 当连接键会请求 {@code /a/completion/0/events}，后端 {@code Unknown session: 0} → HTTP 500。</p>
 *
 * <p>临时会话（尚未落库）没有根，返回 null，由调用方决定是否订阅。</p>
 */
export function resolveRootSessionId(session: ChatSession | null | undefined): string | null {
  if (!session) return null;
  const id = String(session.id);
  if (isTempSessionId(id)) return null;
  const declared = session.rootSessionId != null ? String(session.rootSessionId) : null;
  return declared && declared !== '0' ? declared : id;
}

/**
 * 历史与本地实时消息的合并输入。
 *
 * <p>{@code terminalTurnIds} 是已确认终结的轮次（收到终态事件或挂起事件，或对账读回非运行态）。
 * 它是「替换 vs 保留」的唯一开关。</p>
 */
export interface MergeMessagesByTurnInput {
  /** 本地消息（实时 reducer 正在追加的正文在这里）。 */
  local: ChatMessage[] | null | undefined;
  /** 权威历史消息（由 {@link aggregateSessionMessages} 聚合而来）。 */
  history: ChatMessage[] | null | undefined;
  /** 已终结的轮次集合；其中的轮次用权威历史整体替换。未列出的轮次保留本地正文。 */
  terminalTurnIds?: Iterable<string> | null;
}

/** 过程类集合（思考 / 中间正文 / 工具 / 卡片 / 时间线）逐项合并时要读写的键。 */
interface ProcessItem {
  id?: string;
  text?: string;
  content?: string;
  title?: string;
  toolName?: string;
  order?: number;
}

/**
 * 合并一组过程项：两侧都按**权威身份 `id`** 去重后取并集，然后按 `order` 升序。
 *
 * <p>接入 Block 契约后，两侧的身份同源：历史走 {@code TurnViewAssembler}，
 * 实时走 {@code TURN_SNAPSHOT}/{@code BLOCK_UPSERT}，块 id 都是
 * {@code thinking:<responseId>} / {@code text:<responseId>} / {@code tool:<toolCallId>}。
 * 同一块在两侧**必然同名**，因此单一 `id` 判据即可幂等，不再需要「内容指纹」这条
 * 只为弥合两侧 id 不同而存在的第二条身份。</p>
 *
 * <p><b>顺序必须由 order 决定，不能靠「本地在前」</b>：合并结果直接喂给渲染层，
 * 而渲染层按 order 升序排。历史 order 是后端千位槽步长（{@code responseOrder * 1000 + slot}），
 * 本地 order 由 {@link blockProjection.nextOrderFor} 从气泡最大值续写 —— 两者同一量纲，
 * 拼接后按 order 排序即与真实发生顺序一致。此前「本地在前」的假设建立在
 * 「本地 order 恒大于历史 order」之上，一旦某轮历史 order 更高（分页补齐了更晚的块）就会错位。</p>
 */
function mergeProcessById<T extends ProcessItem>(
  localItems: T[] | undefined,
  historyItems: T[] | undefined
): T[] | undefined {
  if (!historyItems || historyItems.length === 0) return localItems;
  if (!localItems || localItems.length === 0) return historyItems;
  const byId = new Map<string, T>();
  for (const item of localItems) {
    byId.set(String(item?.id ?? ''), item);
  }
  for (const item of historyItems) {
    const id = String(item?.id ?? '');
    if (!byId.has(id)) byId.set(id, item);
  }
  const merged = [...byId.values()];
  merged.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  return merged;
}

/**
 * 同一轮内角色的排序权重：user 必须排在 assistant 之前。
 *
 * <p>渲染层按「先提问、后回答」组织气泡，顺序颠倒会让用户先看到回答再看到自己的提问。</p>
 */
function roleOrder(role: ChatMessage['role']): number {
  return role === 'user' ? 0 : role === 'assistant' ? 1 : 2;
}

/**
 * 保留本地正文、用历史补齐该轮缺失的过程数据。
 *
 * <p>实时路径的正文是增量追加的，而「正在生成的片段不保证已落库」——
 * 直接整体替换会把已经渲染出来的正文回退成半截。</p>
 *
 * <p>补齐进来的整条消息<b>按角色归位</b>（user 在 assistant 之前），不能一律 push 到末尾：
 * 本地该轮可能只有助手气泡（用户气泡还没绑定 turnId），无条件追加会让提问排到回答之后。</p>
 */
function complementTurnKeepingLocalBody(
  localTurn: ChatMessage[],
  historyTurn: ChatMessage[]
): ChatMessage[] {
  if (localTurn.length === 0) return historyTurn;

  // 必须汇总该轮**全部**历史助手的过程数据，不能只取第一条：分页窗口滑进一轮中间时，
  // 该轮会在两页各产出一条助手气泡（id 相同、过程各半），只认第一条就会丢掉另一页的工具 /
  // 思考 —— 表现为「对账后工具数少了一半」。
  const thoughtSteps = historyTurn.flatMap(item => item.role === 'assistant' ? (item.thoughtSteps ?? []) : []);
  const toolCalls = historyTurn.flatMap(item => item.role === 'assistant' ? (item.toolCalls ?? []) : []);
  const aiMessages = historyTurn.flatMap(item => item.role === 'assistant' ? (item.aiMessages ?? []) : []);
  const promptCards = historyTurn.flatMap(item => item.role === 'assistant' ? (item.promptCards ?? []) : []);

  const merged = localTurn.map(message => {
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      thoughtSteps: mergeProcessById(message.thoughtSteps, thoughtSteps),
      toolCalls: mergeProcessById(message.toolCalls, toolCalls),
      aiMessages: mergeProcessById(message.aiMessages, aiMessages),
      promptCards: mergeProcessById(message.promptCards, promptCards)
    };
  });

  // 按角色去重：一个轮次里 user / assistant 各只应有一条。实时乐观气泡 id 形如
  // `user-<sessionId>-<ts>`，历史 id 形如 `srv-<雪花>` —— 同一轮两者 id 不同，
  // 不按角色去重就会渲染出两个用户气泡。
  const mergedRoles = new Set(merged.map(message => message.role));
  for (const message of historyTurn) {
    if (mergedRoles.has(message.role)) continue;
    mergedRoles.add(message.role);
    // 归位：插到第一条权重更大的消息之前，保证 user 不落在 assistant 后面
    const weight = roleOrder(message.role);
    const insertAt = merged.findIndex(item => roleOrder(item.role) > weight);
    if (insertAt < 0) merged.push(message);
    else merged.splice(insertAt, 0, message);
  }
  return merged;
}

/**
 * 按权威 turnId 分轮合并「本地实时消息」与「服务端历史消息」。
 *
 * <p><b>为什么不能按消息 ID 追加</b>：实时助手气泡 id 形如 {@code bubble-<sessionId>-<turnId>}，
 * 历史消息 id 形如 {@code msg-<sessionId>-turn-<turnId>} —— <b>同一轮的两个 id 不同</b>，
 * 按 id 合并必然产生重复气泡。</p>
 *
 * <p>合并规则：</p>
 * <ol>
 *   <li>先按 turnId 把两侧各自分组（历史侧已由聚合器按 turnId 归一）；</li>
 *   <li><b>被确认终结的轮次</b>（在 {@code terminalTurnIds} 内）：用权威历史整体替换；</li>
 *   <li><b>其余轮次</b>：保留本地实时正文，只用历史补齐该轮缺失的过程数据；</li>
 *   <li><b>turnId 未知（null）的本地消息</b>：按 {@code role + content} 与历史对账，
 *       命中说明历史已把它落库（权威），删本地那条；未命中才追加。</li>
 * </ol>
 *
 * <p>排序沿用历史顺序（已按轮次雪花 ID 排好），本地多出的轮次按其 snowflake 键插到正确位置，
 * 保证「实时气泡不会跳到会话末尾」。</p>
 */
export function mergeMessagesByTurn(input: MergeMessagesByTurnInput): ChatMessage[] {
  const local = input.local ?? [];
  const history = input.history ?? [];
  if (history.length === 0) return [...local];
  if (local.length === 0) return [...history];

  const terminalTurnIds = new Set<string>();
  for (const turnId of input.terminalTurnIds ?? []) {
    const normalized = normalizeTurnId(turnId);
    if (normalized) terminalTurnIds.add(normalized);
  }

  /** 本地消息按 turnId 分组；null 轮次单独保留原顺序。 */
  const localByTurn = new Map<string, ChatMessage[]>();
  const localWithoutTurn: ChatMessage[] = [];
  for (const message of local) {
    const turnId = normalizeTurnId(message.turnId);
    if (!turnId) {
      localWithoutTurn.push(message);
      continue;
    }
    const bucket = localByTurn.get(turnId);
    if (bucket) bucket.push(message);
    else localByTurn.set(turnId, [message]);
  }

  const historyByTurn = new Map<string, ChatMessage[]>();
  for (const message of history) {
    const turnId = normalizeTurnId(message.turnId);
    if (!turnId) continue;
    const bucket = historyByTurn.get(turnId);
    if (bucket) bucket.push(message);
    else historyByTurn.set(turnId, [message]);
  }

  /**
   * 指纹比对范围：**只有历史的最后一个轮次**。
   *
   * <p>为什么不能比全历史：指纹只由 role + content 构成，用户重复发送相同内容
   * （「继续」「好的」「1」这类高频短消息，或失败后原样重发）时，新乐观气泡会与
   * <b>更早轮次</b>的同内容消息误判为同一条 → 用户刚发的消息在界面上消失。
   * 吞掉用户输入比多渲染一个气泡严重得多。</p>
   *
   * <p>为什么「最后一个轮次」是对的：乐观气泡只可能对应最近落库的那一轮
   * （bindUserMessageTurn 在受理返回后才写 turnId，此前它没有轮次身份）。</p>
   */
  const latestHistoryTurnId = resolveLatestHistoryTurnId(history);
  const latestHistoryFingerprints = new Set(
    latestHistoryTurnId === null
      ? []
      : (historyByTurn.get(latestHistoryTurnId) ?? []).map(buildFingerprint),
  );

  // 以历史顺序为主干，逐轮决定「整体替换 / 保留本地正文」
  const merged: ChatMessage[] = [];
  const emittedTurnIds = new Set<string>();
  for (const message of history) {
    const turnId = normalizeTurnId(message.turnId);
    if (!turnId) {
      merged.push(message);
      continue;
    }
    if (emittedTurnIds.has(turnId)) continue; // 同一轮已在上一条消息时整体处理过
    emittedTurnIds.add(turnId);

    const historyTurn = historyByTurn.get(turnId) ?? [];
    const localTurn = localByTurn.get(turnId);

    if (!localTurn || localTurn.length === 0) {
      merged.push(...historyTurn);
      continue;
    }
    if (terminalTurnIds.has(turnId)) {
      merged.push(...historyTurn);
      continue;
    }
    // 未确认终结：保留本地正文（更近），过程数据用历史补齐
    merged.push(...complementTurnKeepingLocalBody(localTurn, historyTurn));
  }

  // 本地有、历史还没有的轮次：按雪花键插到正确位置（不能一律追加到末尾）
  const localOnlyTurnIds = Array.from(localByTurn.keys()).filter(turnId => !emittedTurnIds.has(turnId));
  for (const turnId of localOnlyTurnIds) {
    const bucket = localByTurn.get(turnId) ?? [];
    if (bucket.length === 0) continue;
    const insertAt = resolveInsertIndex(merged, turnId);
    merged.splice(insertAt, 0, ...bucket);
  }

  // turnId 未知的本地消息：与「历史最后一轮」对账 —— 命中说明它就是那一轮已落库的
  // 同一条消息（历史权威），删本地那条。不做这一步会同时渲染乐观气泡与历史消息，
  // 变成两个用户气泡（bindUserMessageTurn 尚未执行或执行失败时就是这个窗口）。
  //
  // 额外要求本地已有那一轮的其它消息：没有就说明这条乐观气泡属于<b>另一轮</b>
  // （很可能是用户重复发送相同内容），删掉就是吞掉用户输入。
  //
  // <b>已接受的副作用（v1 边界，不要当 bug 改）</b>：当「本地恰好留有上一轮的助手气泡」
  // 且「新消息内容与上一轮完全相同」，且这次对账恰好发生在 POST 在途、
  // bindUserMessageTurn 尚未执行的窗口内时，这条乐观气泡会被去重（界面上少一条用户消息）。
  // 为何接受：概率低；下一轮对账自愈（届时气泡已带 turnId，按轮归并会正确保留），
  // 属瞬态而非持久丢失；消除它需要先拿到 turnId，而那正是该窗口存在的原因（鸡生蛋）。
  // 回归守卫见 tests/singleSessionStream.test.ts 的「已知边界」用例。
  for (const message of localWithoutTurn) {
    if (latestHistoryTurnId !== null && localByTurn.has(latestHistoryTurnId)
      && latestHistoryFingerprints.has(buildFingerprint(message))) {
      continue;
    }
    merged.push(message);
  }
  return merged;
}

/**
 * 历史里最后一个（雪花键最大）的轮次 id；无法解析时返回 null。
 *
 * <p><b>必须按雪花键，不能按数组下标</b>：分页回溯时数组顺序不完全等于轮次先后
 * （窗口滑进某一轮中间时，该轮可能晚于更晚的轮次出现）。按下标取「最后一条」会在乱序
 * 历史里选错轮次，使「指纹比对范围」与「本地是否有该轮消息」两个判断同时失效。</p>
 *
 * <p>回归守卫：tests/singleSessionStream.test.ts 的「历史倒序」用例。</p>
 */
function resolveLatestHistoryTurnId(history: ChatMessage[]): string | null {
  let latestTurnId: string | null = null;
  let latestKey: bigint | null = null;
  for (const message of history) {
    const turnId = normalizeTurnId(message.turnId);
    if (!turnId) continue;
    const key = snowflakeKey(turnId);
    if (key === null) {
      // 异常数据（非雪花）：退化为「后出现者为准」，不参与雪花比较
      latestTurnId = turnId;
      continue;
    }
    if (latestKey === null || key > latestKey) {
      latestKey = key;
      latestTurnId = turnId;
    }
  }
  return latestTurnId;
}

/**
 * 消息指纹：角色 + 正文。
 *
 * <p>用于把「本地乐观气泡」与「历史里同一条落库消息」对上 —— 两者 id 不同
 * （{@code user-<sessionId>-<ts>} vs 雪花 id），只能按内容认。</p>
 */
function buildFingerprint(message: ChatMessage): string {
  return `${message.role}\u0000${message.content ?? ''}`;
}

/**
 * 本地独有轮次相对「已合并消息数组」的插入位置。
 *
 * <p>按 turnId 的雪花键比较：比现有第一轮晚就插到末尾，否则插到第一个比自己晚的轮次之前。
 * 这样「刚发出的这一轮」不会被塞到会话最末尾（那里通常是更早的历史轮次）。</p>
 */
function resolveInsertIndex(merged: ChatMessage[], turnId: string): number {
  const key = snowflakeKey(turnId);
  if (key === null) return merged.length;
  for (let i = 0; i < merged.length; i++) {
    const currentKey = snowflakeKey(normalizeTurnId(merged[i].turnId));
    if (currentKey !== null && key < currentKey) return i;
  }
  return merged.length;
}

/**
 * 从 edit_file 类工具的执行输出里取出行数增减。
 * 输出不是 JSON 或缺字段时返回 null —— 行数只是卡片上的装饰信息，取不到就不显示。
 */
function extractEditResultLines(toolName: string, outputText: string): { plusLines?: number; minusLines?: number } | null {
  if (!isEditFileTool(toolName) || !outputText) return null;
  try {
    const parsed = JSON.parse(outputText);
    if (parsed.plusLines === undefined && parsed.minusLines === undefined) return null;
    return { plusLines: parsed.plusLines, minusLines: parsed.minusLines };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ToolCallVO → 工具调用展示（历史与实时共用的唯一转换点）              */
/* ------------------------------------------------------------------ */

/**
 * 合并不同分页的原始消息记录（SessionMessageVO）：
 *
 * <p>按记录 ID 强去重，保持服务端历史时间顺序（较早记录在先，较新记录在后）。
 * 重复加载同一页幂等，无 ID 的记录按引用保全。</p>
 */
export function mergeRawRecords(
  olderRecords: SessionMessageVO[] | undefined,
  newerRecords: SessionMessageVO[] | undefined
): SessionMessageVO[] {
  if (!olderRecords || olderRecords.length === 0) {
    return newerRecords ? [...newerRecords] : [];
  }
  if (!newerRecords || newerRecords.length === 0) {
    return [...olderRecords];
  }

  const seen = new Set<string>();
  const merged: SessionMessageVO[] = [];

  for (const r of olderRecords) {
    if (!r) continue;
    const key = r.id != null ? String(r.id) : null;
    if (key) {
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    } else {
      merged.push(r);
    }
  }

  for (const r of newerRecords) {
    if (!r) continue;
    const key = r.id != null ? String(r.id) : null;
    if (key) {
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    } else {
      merged.push(r);
    }
  }

  return merged;
}

/**
 * 过程时间线的槽位步长：同一个 AI 行内按「思考 +0 / 中间文本 +1 / 工具 +2+tIdx」编号，
 * 行的时序基准 = 该行在原始消息列表里的下标 × 本步长。
 *
 * <p>取 100 而不是 10：一行可以并行下发多个工具调用，步长必须容得下单行最多可能的工具数，
 * 否则 `+2+tIdx` 会溢出撞进下一行的槽位，把工具行排到下一轮思考之前。</p>
 */
const TIMELINE_SLOT_STRIDE = 100;

/**
 * 历史分页响应 → 消息列表的**唯一入口**（与实时快照/增量同一条更新规则）。
 *
 * <p><b>为什么不再从原始消息行聚合</b>：后端每一轮都随响应下发完整的
 * {@link TurnViewVO}（含用户提问、块列表、order / placement / status），这正是
 * 实时链路拿到的那份契约。历史侧若再从 {@code records} 自行聚合，就会出现
 * 「一套历史、一套实时」的双口径 —— 那正是本次改造要收掉的东西。
 * 现在两侧共用 {@link upsertTurnViewIntoMessages}：按 {@code sessionId + turnId} 定位、
 * 按 {@code viewVersion} 接受更新。</p>
 *
 * <p><b>为什么仍接收 records 参数</b>：仅为兼容调用点签名与「无视图轮次」的排位参考。
 * 展示内容一律来自 {@code turnViews} —— {@code records} 不参与任何字段构造。</p>
 *
 * <p><b>合页语义</b>：调用方必须把多页的 {@code turnViews} 累积后再调用一次
 * （同一 turnId 横跨两页时，视它们为同一条的更新，按版本取新）。</p>
 *
 * @param sessionId 会话 id，参与气泡身份构造
 * @param turnViews 已累计的块视图表（键 = turnId）；这就是展示内容的唯一来源
 * @param versions  可选：跨调用累计的版本表（翻页场景传入会话级表，避免重复投影）
 */
export function aggregateRecordsByIdentity(
  _earlierRecords: SessionMessageVO[] | undefined,
  _laterRecords: SessionMessageVO[] | undefined,
  sessionId: string | number,
  turnViews?: Record<string, TurnViewVO> | null,
  versions?: Map<string, number>
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!turnViews) return messages;
  const versionTable = versions ?? new Map<string, number>();
  // 依次并入（而非先收集再按 key 遍历）：upsert 内部按雪花键决定插入位次，
  // 顺序无关，且每条视图的版本比较就地生效。
  for (const view of Object.values(turnViews)) {
    if (!view) continue;
    upsertTurnViewIntoMessages(messages, { ...view, sessionId: view.sessionId ?? String(sessionId) }, versionTable);
  }
  return messages;
}

/**
 * 雪花 ID 文本 → 可比较的 BigInt；不是纯数字（异常数据 / 本地假 ID）返回 null。
 *
 * <p>必须用 BigInt：雪花 ID 已超出 {@code Number.MAX_SAFE_INTEGER}，转 Number 会丢低位，
 * 同一轮次内相邻记录的先后直接判不出来。</p>
 */
const snowflakeKey = (raw: unknown): bigint | null => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
};

/**
 * 统一聚合主会话与子会话的历史记录为 ChatMessage[] 展示列表。
 *
 * <p>核心方案（实施计划书 §二）：
 * 1. 原始记录统一合并后统一按 turnId 聚合，避免跨页拆分成多个独立气泡；
 * 2. 每个已知轮次生成唯一的回答组（id 为 stable 的 `msg-${sessionId}-turn-${turnId}`）；
 * 3. 收集该轮全部思考、AI 文本、工具调用与审批卡片；
 * 4. 只有「终结轮次」（该轮没有工具调用）的 AI 文本是正文，其余 AI 文本进入折叠过程区；
 * 5. 聚合过程完全幂等，不因多次加载或跨页产生重复计数或覆盖；
 * 6. 缺少 turnId 的旧消息采用 USER 消息边界降级，不将所有空值消息合并为一组。</p>
 */
export function aggregateSessionMessages(rawMessages: any, sessionId: string | number = 'session'): ChatMessage[] {
  if (!rawMessages) return [];

  const list: SessionMessageVO[] = Array.isArray(rawMessages) ? rawMessages : [];
  if (list.length === 0) return [];

  const sid = String(sessionId);
  const chatMessages: ChatMessage[] = [];
  const turnAssistantMap = new Map<string, ChatMessage>();
  // rowIndex = 该 AI 行在原始消息列表里的下标，即三条过程集合共用的时序基准（见 TIMELINE_SLOT_STRIDE）。
  // 思维链用 rowIndex*stride、工具用 rowIndex*stride+2+tIdx，中间文本必须落在同一基准上（+1），
  // 否则三者的 order 不同量纲，排序结果就不是执行时序（详见 ChatMessageItem#processTimeline）。
  const turnAiTextsMap = new Map<ChatMessage, Array<{ id: string; recordId: string; text: string; thinking?: string; timestamp: number; terminal: boolean; rowIndex: number }>>();

  // 气泡排序键：同一轮次的用户消息与回答组共用「轮次雪花 ID」—— 它按受理先后递增，
  // 与本次拉取到的是哪一页无关。**不能按「该轮次的行在本次 records 里第一次出现的先后」排**：
  // 首屏只取最新一页，窗口滑进某一轮中间时那一轮会晚于更晚的轮次出现，两个气泡随即上下换位
  // （线上事故：并发/相邻两轮随着会话推进反复换位）。缺 turnId 的旧数据回落用该组首条记录 ID
  // （同为雪花，量级可比）；解析不出数字的异常数据不带键，按原始相对序排在最后。
  const sortKeys = new Map<ChatMessage, { turnKey: bigint; roleRank: number }>();

  let currentLegacyAssistant: ChatMessage | null = null;
  let lastKnownTs = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    const parsedTs = parseItemTimestamp(item);
    if (parsedTs !== null) lastKnownTs = parsedTs;
    const ts = parsedTs ?? lastKnownTs;
    const turnId = normalizeTurnId(item.turnId);
    const rawType = String(item.type ?? '').trim().toUpperCase();
    const recordKey = snowflakeKey(item.id);
    const turnKey = turnId === null ? null : snowflakeKey(turnId);

    // 0. 系统提示词不参与对话展示
    if (rawType === 'SYSTEM') {
      continue;
    }

    // 1. 用户消息
    if (rawType === 'USER') {
      currentLegacyAssistant = null;
      const userMessage: ChatMessage = {
        id: String(item.id),
        role: 'user',
        content: item.text ?? '',
        timestamp: ts,
        turnId
      };
      chatMessages.push(userMessage);
      const userKey = turnKey ?? recordKey;
      if (userKey !== null) sortKeys.set(userMessage, { turnKey: userKey, roleRank: 0 });
      continue;
    }

    // 辅助函数：获取或创建属于当前轮次的 assistant 消息
    const getAssistantContainer = (): ChatMessage => {
      if (turnId) {
        let asst = turnAssistantMap.get(turnId);
        if (!asst) {
          asst = {
            id: `msg-${sid}-turn-${turnId}`,
            role: 'assistant',
            content: '',
            timestamp: ts,
            turnId,
            thoughtSteps: [],
            toolCalls: [],
            aiMessages: [],
            isComplete: true
          };
          turnAssistantMap.set(turnId, asst);
          chatMessages.push(asst);
          const asstKey = turnKey ?? recordKey;
          if (asstKey !== null) sortKeys.set(asst, { turnKey: asstKey, roleRank: 1 });
        }
        return asst;
      }

      // turnId 为 null 的旧数据：按 USER 消息边界降级
      if (currentLegacyAssistant) {
        return currentLegacyAssistant;
      }
      const legacyAsst: ChatMessage = {
        id: `msg-${sid}-legacy-${String(item.id ?? `idx-${i}`)}`,
        role: 'assistant',
        content: '',
        timestamp: ts,
        turnId: null,
        thoughtSteps: [],
        toolCalls: [],
        aiMessages: [],
        isComplete: true
      };
      currentLegacyAssistant = legacyAsst;
      chatMessages.push(legacyAsst);
      if (recordKey !== null) sortKeys.set(legacyAsst, { turnKey: recordKey, roleRank: 1 });
      return legacyAsst;
    };

    // 2. 工具结果消息 (TOOL)
    if (rawType === 'TOOL') {
      const callId = item.toolCallId != null ? String(item.toolCallId) : '';
      const toolCall: ToolCallVO | null =
        item.toolCall && typeof item.toolCall === 'object' ? (item.toolCall as ToolCallVO) : null;
      const resolvedCallId = callId || (toolCall?.id != null ? String(toolCall.id) : '');

      // 2a. toolCall 缺行
      if (!toolCall) {
        console.warn('[aggregateSessionMessages] TOOL 消息缺少 tool_call 行，已降级为不可用:', item.id, resolvedCallId);
        continue;
      }

      const asst = getAssistantContainer();

      // 2b. 互动卡片（PROMISE）：保留权威 ToolCallVO 供卡片渲染。
      // 卡片是用户可操作项，必须能在历史/刷新后重建（ToolCallTrace 丢弃了 type/status/content 等字段，
      // 故不能只靠 toolCalls 还原）。已决卡片携带 rawOutput.outcome/answer/stdout，同样由此还原。
      // ⚠️ 落卡走 upsertPromptCard（历史/实时唯一落点），不要在本地再写一份「覆盖或追加」。
      upsertPromptCard(asst, toolCall);

      // 2c. 普通工具调用
      const toolName = toolCall.toolName ?? '';
      const rawOutput = asObject(toolCall.rawOutput);
      const resultValue = rawOutput ? (rawOutput.output !== undefined ? rawOutput.output : rawOutput.stdout) : undefined;
      const resultStr = resultValue === undefined || resultValue === null ? '' : toText(resultValue);
      const outcome = rawOutput && rawOutput.outcome != null ? String(rawOutput.outcome).trim().toUpperCase() : '';
      const execStatus: ToolExecutionState =
        outcome === 'SUCCEEDED' || outcome === 'APPROVED'
          ? 'success'
          : (['FAILED', 'REJECTED', 'TIMED_OUT', 'CANCELLED'].includes(outcome))
            ? 'failed'
            : 'unknown';
      // 仍待决策的 PROMISE 卡片（type=PROMISE）：工具行状态如实标为 pending，
      // 与实时路径 handleExecutionSuspended 的处置一致；否则会落成 unknown，
      // 把「等待人工决策」误显为「状态未知」。
      // 判定：以权威 `status==='pending'` 为准；历史行可能只带 `pending` 布尔，故二者取或。
      const statusNorm = String(toolCall.status ?? '').trim().toLowerCase();
      const isPendingPromise = toolCall.type === 'PROMISE'
        && (statusNorm === 'pending' || toolCall.pending === true);
      const rowStatus: ToolExecutionState = isPendingPromise && execStatus === 'unknown' ? 'pending' : execStatus;
      const editLines = extractEditResultLines(toolName, resultStr);

      if (!asst.toolCalls) asst.toolCalls = [];
      const matched = resolvedCallId ? asst.toolCalls.find(tc => tc.id === resolvedCallId) : undefined;
      if (matched) {
        matched.result = resultStr;
        matched.status = rowStatus;
        if (editLines) {
          matched.plusLines = editLines.plusLines;
          matched.minusLines = editLines.minusLines;
        }
      } else if (resolvedCallId) {
        asst.toolCalls.push({
          id: resolvedCallId,
          toolName: toolName || '',
          category: resolveToolCategory(toolName),
          // 不裸显原生工具名：此处是「结果行找不到起始行」的兜底，拿不到参数可解析，
          // 留空让 UI 回落到分类名（resolveToolCategory 已给出中文名）。
          description: '',
          result: resultStr,
          status: rowStatus,
          plusLines: editLines?.plusLines,
          minusLines: editLines?.minusLines,
          order: i * TIMELINE_SLOT_STRIDE
        });
      }
      continue;
    }

    // 3. AI / Assistant 消息
    if (rawType === 'AI') {
      const text = item.text ?? '';
      const thinking = item.thinking;
      const asst = getAssistantContainer();
      const recordId = String(item.id ?? `idx-${i}`);

      // 处理 AI 文本：只有「终结轮次」的文本才是正文，其余一律进折叠过程。
      //
      // 终结的判据是「该轮没有工具调用」—— 没有工具调用的那一轮就是循环的出口，它的文本是结论；
      // 有工具调用的轮次文本只是中途叙述，哪怕它是最后一行。不能用「最后一条非空文本」按位置切：
      // 末轮可能仍在调工具（那只是过程叙述），也可能整轮没有结论文本（执行被中断/取消），
      // 两种情况都会把过程叙述顶到正文位置。
      if (text && text.trim()) {
        let aiList = turnAiTextsMap.get(asst);
        if (!aiList) {
          aiList = [];
          turnAiTextsMap.set(asst, aiList);
        }
        if (!aiList.some(a => a.recordId === recordId)) {
          aiList.push({
            id: `aimsg-${sid}-${recordId}`,
            recordId,
            text,
            thinking,
            timestamp: ts,
            terminal: !Array.isArray(item.toolCalls) || item.toolCalls.length === 0,
            rowIndex: i
          });
        }
        const terminalMessage = [...aiList].reverse().find(a => a.terminal);
        asst.content = terminalMessage?.text ?? '';
        asst.aiMessages = aiList
          .filter(a => a !== terminalMessage)
          .map(m => ({
            id: m.id,
            text: m.text,
            thinking: m.thinking,
            timestamp: m.timestamp,
            order: m.rowIndex * TIMELINE_SLOT_STRIDE + 1
          }));
      }

      // 处理思维链：**每个 AI 行的思考独立成步，与工具调用同粒度**。
      //
      // 一个轮次里模型持续多轮「思考 → 调工具 → 再思考 → 再调工具」，每个 AI 行各带一段 thinking。
      // 若把整轮思考拼接成一个「深度思考」步骤，用户会看到所有思考挤进同一个折叠框，与工具调用的
      // 逐段交错时序对不上（实拍验收：整轮思考一堵墙，看不出每段思考对应哪次工具）。改为按行拆分，
      // 每步 order 取该 AI 行的时序基准，与工具调用（+2+tIdx）、中间文本（+1）交错还原真实执行顺序。
      if (thinking) {
        if (!asst.thoughtSteps) asst.thoughtSteps = [];
        const stepId = `step-${sid}-${recordId}`;
        // 幂等：同一 AI 行重复加载不重复建步（id 由行 id 派生，天然去重）
        if (!asst.thoughtSteps.some(s => s.id === stepId)) {
          asst.thoughtSteps.push({
            id: stepId,
            title: '深度思考',
            content: thinking,
            status: 'success',
            order: i * TIMELINE_SLOT_STRIDE
          });
        }
      }

      // 处理工具调用（AI 行的 toolCalls 是 ModelToolCallVO）
      if (Array.isArray(item.toolCalls)) {
        if (!asst.toolCalls) asst.toolCalls = [];
        for (let tIdx = 0; tIdx < item.toolCalls.length; tIdx++) {
          const tc = item.toolCalls[tIdx];
          const callId = String(tc.id);
          if (asst.toolCalls.some(t => t.id === callId)) continue;

          const tName = tc.name ?? '';
          const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : '';
          const args = toObject(rawArgs, {});
          const meta = resolveToolMeta({ toolName: tName, args });

          asst.toolCalls.push({
            id: callId,
            toolName: tName,
            category: meta.category,
            description: meta.description,
            target: meta.target,
            command: meta.command,
            subAgentId: args.agentId,
            subTask: args.task,
            subPrompt: args.prompt,
            query: rawArgs,
            status: 'calling',
            order: i * TIMELINE_SLOT_STRIDE + 2 + tIdx
          });
        }
      }

      continue;
    }

    console.warn('[aggregateSessionMessages] 未知消息类型，已忽略:', rawType || '(空)');
  }

  // 历史里未回填结果的工具调用：标记为「状态未知」。
  // 不补 result 文案 —— 那是编造用户可见结论；此处只改状态，具体原因由轮次摘要（turn.errorReason）承载。
  for (const msg of chatMessages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.status === 'calling') {
          tc.status = 'unknown';
        }
      }
    }
  }

  // 按轮次身份重排（见 sortKeys 的说明）：聚合出的先后不能取决于分页窗口落在哪里。
  // 无键的异常数据排在最后并保持原始相对序；同轮内 roleRank 保证用户消息在回答组之前。
  return chatMessages
    .map((message, index) => ({ message, index, key: sortKeys.get(message) }))
    .sort((left, right) => {
      if (!left.key && !right.key) return left.index - right.index;
      if (!left.key) return 1;
      if (!right.key) return -1;
      if (left.key.turnKey !== right.key.turnKey) {
        return left.key.turnKey < right.key.turnKey ? -1 : 1;
      }
      return left.key.roleRank - right.key.roleRank;
    })
    .map(entry => entry.message);
}

/**
 * 为「失败但没有任何 assistant 行」的轮次合成组尾错误气泡。
 *
 * <p>失败轮次（如模型接口 400，一轮输出都没有）在 session_message 里常常只有 USER 行，
 * 而回答组的 FAILED 徽标只挂在 assistant 气泡（组尾）上 —— 缺行即徽标无处渲染，
 * 用户刷新后彻底看不见失败。此函数按 turns 权威数据合成错误气泡，与实时路径
 * （EXECUTION_FAILED 把原因写进气泡）同形；幂等：该轮次已有 assistant 行则不合成。</p>
 */
export function synthesizeFailedTurnBubbles(
  messages: ChatMessage[],
  turns: Record<string, ChatTurn>
): ChatMessage[] {
  const result = [...messages];
  for (const [turnId, turn] of Object.entries(turns || {})) {
    if (turn?.status !== 'FAILED') continue;
    if (result.some(m => m.role === 'assistant' && normalizeTurnId(m.turnId) === turnId)) continue;
    const synthetic: ChatMessage = {
      id: `synthetic-failed-${turnId}`,
      role: 'assistant',
      content: (turn.errorReason || '').trim() || '执行失败',
      turnId,
      timestamp: Date.now(),
      isComplete: true,
      thoughtSteps: [],
      toolCalls: [],
      aiMessages: []
    };
    const lastIdx = result.map(m => normalizeTurnId(m.turnId)).lastIndexOf(turnId);
    if (lastIdx >= 0) result.splice(lastIdx + 1, 0, synthetic);
    else result.push(synthetic);
  }
  return result;
}

/**
 * 把会话消息拼成可下载的 Markdown 正文（导出入口的唯一内容构造点）。
 *
 * <p>抽成纯函数以便回归：导出直接消费 **v3 派生视图**，这里只负责「消息数组 → 文本」，
 * 不碰 Blob / DOM。顺序即派生数组顺序（提问 → 回答），不重排。</p>
 *
 * @param title    会话标题（空串回落「灵犀会话记录」）
 * @param messages v3 派生消息数组（导出时原样传入，不做过滤）
 */
export function buildSessionMarkdown(title: string | undefined, messages: ChatMessage[]): string {
  const lines = [
    `# ${title || '灵犀会话记录'}`,
    `> 导出时间: ${new Date().toLocaleString()}`,
    '',
    ...messages.map(message => {
      const sender = message.role === 'user' ? '👤 用户' : '🤖 灵犀';
      return `### ${sender}\n\n${message.content}\n`;
    }),
  ];
  return lines.join('\n\n');
}
