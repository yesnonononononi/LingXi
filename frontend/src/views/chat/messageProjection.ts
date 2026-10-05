import { useStreamV3Store, type ResponseSlot } from '../../stores/streamV3Store';
import { aggregateSessionMessages } from '../../utils/session';
import { buildPromptCard } from '../../utils/session';
import type { ChatMessage, ChatTurn, PromptCardData, SessionMessageVO, ToolCallVO } from '../../types/chat';

/**
 * 消息视图适配层：把 v3 唯一状态源（{@link useStreamV3Store}）**派生**成渲染管线消费的
 * `ChatMessage[]`。
 *
 * <h3>为什么是「派生」而不是「搬运」</h3>
 * 批次 A 的硬要求是「消息内容、卡片状态、执行状态都从 v3 读取，不维护第二份消息状态」。
 * 因此本模块**不持有任何状态**：每次调用都从 store 现读现算，返回一份**新的**视图数组。
 *
 * <h3>两个视图维度</h3>
 * 一条根会话 v3 连接承载整棵树的事件，但渲染位置有两个：
 * <ul>
 *   <li><b>主聊天</b>：{@code sessionId} 省略 → 只渲染根会话自身的正文；</li>
 *   <li><b>子面板</b>：传 {@code sessionId} = 子会话 → 渲染该子会话的正文。</li>
 * </ul>
 * 两者共用本函数，靠同一个 store 的不同切片渲染，不各自维护一份消息表。
 *
 * <h3>卡片为什么不能挂在消息上等</h3>
 * 卡片实体（{@code tools[toolCallId]}）与消息是**两个独立到达的流**：卡片可能先于消息到达
 * （模型先要审批、正文稍后才落库）。若只遍历「已有 assistant 消息的 toolCalls」再补卡片，
 * 先到的卡片就没有宿主、永远不显示 —— 这正是历史回放正常、实时不出现的原因。
 * 因此这里**以工具实体为驱动**：找不到宿主就先建一个按 toolCallId 稳定的展示项，
 * 宿主消息到达后自动归位（每次都是重算，不需要手工搬迁）。
 *
 * @param rootSessionId 根会话 ID（连接归属）
 * @param sessionId 要渲染的会话；省略 = 渲染根会话正文
 */
export function projectSessionMessages(rootSessionId: string | number, sessionId?: string | number): ChatMessage[] {
  const store = useStreamV3Store();
  const rootKey = String(rootSessionId);
  const viewKey = sessionId == null ? rootKey : String(sessionId);
  const isRootView = viewKey === rootKey;

  // 第一层：历史 + 工具 + 轮次 → 基底消息。这一层只在这三个槽被整体替换时重算。
  const base = buildBaseMessages(store, viewKey, isRootView, rootKey);

  // 第二层：未提交的活响应按帧叠加。delta 每来一帧只重建**受影响的那条气泡**，
  // 不重新聚合历史、也不复制其余气泡（见 overlayLiveResponses）。
  const live = [...store.responses.values()].filter(
    slot => slot.messageId == null && !slot.discarded && belongsToView(slot, viewKey, isRootView)
  );
  if (live.length === 0) return base;
  return markExploring(overlayLiveResponses(base, live));
}

/**
 * 标记「探索中」气泡（发送后、首个工具调用或首段正文落地前）。
 *
 * <p>为什么在出口统一补而不是在建气泡时写死：置位时机是「该轮还在跑、但还没有任何可见产出」，
 * 而工具实体与正文都是**别的流/别的帧**（`TOOL_CALL_UPDATED` / `TEXT_DELTA`），必然晚于气泡本身。
 * 建气泡时写死 `isExploring` 会在产出已经落地后仍显示「正在探索中」。</p>
 *
 * <p>三条同时成立才算探索中：assistant、未完成、既无工具调用也无正文。任一产出出现即退出
 * —— 有工具调用进入执行态（进度由折叠区的工具条目承载），有正文则进入作答态（正文必须可见，
 * 不能被探索动画栏位顶掉）。</p>
 */
function markExploring(messages: ChatMessage[]): ChatMessage[] {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const hasOutput = Boolean(message.toolCalls?.length) || Boolean(String(message.content ?? '').trim());
    const exploring = !message.isComplete && !hasOutput;
    if (message.isExploring !== exploring) {
      message.isExploring = exploring;
    }
  }
  return messages;
}

/** 基底缓存条目：以槽位 Map 的**引用**为失效判据（store 每次写入整体替换，引用比较即准确）。 */
interface BaseCacheEntry {
  history: unknown;
  tools: unknown;
  turns: unknown;
  sessions: unknown;
  isRootView: boolean;
  rootKey: string;
  messages: ChatMessage[];
}

/**
 * 按会话缓存的基底构建。
 *
 * <p><b>为什么必须缓存</b>：`computed` 只保证「依赖不变就不重算」，而 delta 会替换 `responses`，
 * 若聚合与响应叠加写在同一个 computed 里，**每一个 token 都会重新聚合整段历史**并重建全部气泡。
 * 拆成两层后，聚合只在 history/tools/turns 变化时发生，delta 走 O(受影响气泡) 的局部更新。</p>
 *
 * <p>缓存键是视图会话 + 槽位引用：store 用 `shallowRef` 整体替换 Map，引用相同即内容相同。</p>
 */
function buildBaseMessages(
  store: ReturnType<typeof useStreamV3Store>,
  viewKey: string,
  isRootView: boolean,
  rootKey: string
): ChatMessage[] {
  const cached = baseCache.get(viewKey);
  if (cached
      && cached.history === store.history
      && cached.tools === store.tools
      && cached.turns === store.turns
      && cached.sessions === store.sessions
      && cached.isRootView === isRootView
      && cached.rootKey === rootKey) {
    return cached.messages;
  }

  const rows: SessionMessageVO[] = collectRows(viewKey, store);
  const messages = aggregateSessionMessages(rows, viewKey);
  applyToolOutcomes(messages, store);
  applyTurnSummaries(messages, store);
  applyCards(messages, store, viewKey, isRootView, rootKey);

  baseCache.set(viewKey, {
    history: store.history,
    tools: store.tools,
    turns: store.turns,
    sessions: store.sessions,
    isRootView,
    rootKey,
    messages,
  });
  return messages;
}

/** 基底缓存；键 = 视图会话 id。会话数量级很小，不设上限。 */
const baseCache = new Map<string, BaseCacheEntry>();

/** 取某会话自身的持久化历史行（不做跨会话合并）。 */
function collectRows(sessionId: string, store: ReturnType<typeof useStreamV3Store>): SessionMessageVO[] {
  const rows = [...store.getHistory(sessionId).values()];
  // 稳定排序：aggregateSessionMessages 依赖行序推 order，按 id（雪花，单调递增）升序还原写入序。
  rows.sort((left, right) => compareSnowflake(String(left.id ?? ''), String(right.id ?? '')));
  return rows;
}

/** 按雪花 ID（十进制字符串）比大小；不可解析时按字典序兜底（保持稳定）。 */
function compareSnowflake(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 把未提交的活响应叠加到基底消息上（**局部更新**）。
 *
 * <p>只克隆被命中的那几条气泡：其余气泡按引用透传，数组本身浅拷贝一次。
 * 因此一帧 delta 的开销是 O(气泡数) 的浅拷贝 + O(该气泡文本) 的拼接，
 * 与历史长度无关 —— 这正是「按帧刷新、局部更新」的落点。</p>
 *
 * <p>克隆时必须连 `thoughtSteps` 一起复制：叠加会往里面 push 思考步骤，
 * 直接改缓存基底会把上一帧的中间态固化下来。</p>
 */
function overlayLiveResponses(base: ChatMessage[], live: ResponseSlot[]): ChatMessage[] {
  const byTurn = new Map<string, ResponseSlot[]>();
  const orphan: ResponseSlot[] = [];
  for (const slot of live) {
    if (slot.turnId != null) {
      const list = byTurn.get(slot.turnId) ?? [];
      list.push(slot);
      byTurn.set(slot.turnId, list);
    } else {
      orphan.push(slot);
    }
  }

  // 目标气泡下标 → 要叠加的槽位与叠加方式（追加 / 覆盖）。只克隆被命中的那几条气泡。
  const patches = new Map<number, { slots: ResponseSlot[]; append: boolean }>();
  // 锚点下标 → 该位置后要插入的派生回答气泡（尚无 assistant 宿主的轮次）。
  const derived = new Map<number, Array<{ turnId: string; slots: ResponseSlot[] }>>();
  const mergePatch = (index: number, slots: ResponseSlot[], append: boolean) => {
    const existing = patches.get(index);
    if (existing) {
      existing.slots.push(...slots);
      existing.append = existing.append || append;
    } else {
      patches.set(index, { slots: [...slots], append });
    }
  };

  for (const [turnId, slots] of byTurn) {
    const index = base.findIndex(message => message.role === 'assistant' && message.turnId === turnId);
    // 同一轮次的活响应：已提交段落来自历史行，而恢复后换的是 streamKey（executionId / turnId 不变），
    // 因此这是**另一段** —— 追加而不是覆盖，覆盖会把已提交内容从视图里抹掉。
    if (index >= 0) {
      mergePatch(index, slots, true);
      continue;
    }
    // 本轮还没有 assistant 宿主：新轮次此刻只有 USER 落库行（AI 行要等回答结束才落库），
    // 不派生气泡的话正文会一直卡在状态源里不显示。锚点取本轮 USER 气泡之后 ——
    // 回答必须紧跟自己的提问，且派生气泡的 id 由 turnId 稳定派生，AI 行落库后
    // 第 1 条分支自然命中真实气泡，不会出现「一条回答两个气泡」。
    // 本轮连 USER 行都还没有（帧比落库快）：挂到列表末尾，哨兵 = base.length。
    const userIndex = base.findIndex(message => message.role === 'user' && message.turnId === turnId);
    const anchor = userIndex >= 0 ? userIndex : base.length;
    const pending = derived.get(anchor) ?? [];
    pending.push({ turnId, slots });
    derived.set(anchor, pending);
  }

  // turnId 未知的活响应：挂到「最后一个 assistant 气泡」（活响应建立时轮次行可能尚未回填）。
  // 跳过卡片展示气泡：它不是真实回答，把正文挂上去会造出一个「有正文的卡片气泡」。
  // 归属不确定 → 覆盖而非追加，避免把别轮的内容拼进来。
  if (orphan.length > 0) {
    let index = -1;
    for (let i = base.length - 1; i >= 0; i--) {
      if (base[i].role === 'assistant' && !String(base[i].id).startsWith(CARD_BUBBLE_PREFIX)) {
        index = i;
        break;
      }
    }
    if (index >= 0) mergePatch(index, orphan, false);
  }
  if (patches.size === 0 && derived.size === 0) return base;

  // 单趟重建：按 base 顺序逐条输出（补丁后就地插入该锚点的派生气泡），
  // 这样插入不会让后续下标错位，其余气泡仍按引用透传。
  const next: ChatMessage[] = [];
  for (let index = 0; index < base.length; index++) {
    const patch = patches.get(index);
    if (patch) {
      const copy: ChatMessage = {
        ...base[index],
        thoughtSteps: base[index].thoughtSteps ? [...base[index].thoughtSteps!] : [],
      };
      overlayResponses(copy, patch.slots, patch.append);
      next.push(copy);
    } else {
      next.push(base[index]);
    }
    for (const item of derived.get(index) ?? []) {
      next.push(buildLiveAnswerBubble(item.turnId, item.slots));
    }
  }
  // 锚点是末尾哨兵（该轮还没有任何落库行）：追加到列表尾部。
  for (const item of derived.get(base.length) ?? []) {
    next.push(buildLiveAnswerBubble(item.turnId, item.slots));
  }
  return next;
}

/** 派生回答气泡的 id 前缀；由 turnId 决定，保证同一轮次反复重算都是同一个展示身份。 */
const LIVE_ANSWER_PREFIX = 'msg-live-';

/**
 * 由活响应派生的回答气泡（该轮次尚无已落库的 assistant 行）。
 *
 * <p>id 只由 turnId 派生：AI 行落库后基底里出现真实 assistant 气泡，上层就走「追加到宿主」
 * 分支，本函数不再被调用 —— 于是不会出现「一条回答两个气泡」。</p>
 */
function buildLiveAnswerBubble(turnId: string, slots: ResponseSlot[]): ChatMessage {
  const bubble: ChatMessage = {
    id: `${LIVE_ANSWER_PREFIX}${turnId}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    turnId,
    thoughtSteps: [],
    toolCalls: [],
    aiMessages: [],
    isComplete: false,
  };
  // 覆盖语义：派生气泡的全部内容就来自这些活响应槽，不存在已提交段落需要保留。
  overlayResponses(bubble, slots, false);
  return bubble;
}

/**
 * 一个响应槽是否属于该视图会话。
 *
 * <p>归属未知（无 `sessionId`）的响应**只有根视图认领**：它是「当前活跃会话的活响应」，
 * 若子面板也认领，同一段正文会在每个打开过的子面板里各渲染一遍。</p>
 */
function belongsToView(slot: ResponseSlot, viewKey: string, isRootView: boolean): boolean {
  if (slot.sessionId == null) return isRootView;
  return slot.sessionId === viewKey;
}

/** 把一组响应槽的正文/思考合并进一个 assistant 气泡（正文取各槽拼接、思考同理）。 */
function overlayResponses(assistant: ChatMessage, slots: ResponseSlot[], append: boolean): void {
  const ordered = [...slots].sort((left, right) => compareSnowflake(left.streamKey, right.streamKey));
  const text = ordered.map(slot => slot.text).filter(part => part && part.length > 0).join('');
  const thinking = ordered.map(slot => slot.thinking).filter(part => part && part.length > 0).join('');

  if (text) {
    // 追加语义用于「同一轮次的后续段落」（恢复后换 streamKey）；覆盖用于归属不确定的兜底挂载。
    assistant.content = append && assistant.content ? assistant.content + text : text;
  }
  if (thinking) {
    // 思考进 thoughtSteps（与实时 PARTIAL_THINKING 投影同一形状），不是正文。
    const running = ordered.some(slot => !slot.finalized);
    if (!assistant.thoughtSteps) assistant.thoughtSteps = [];
    const existing = assistant.thoughtSteps.find(step => step.title === THINKING_STEP_TITLE);
    if (existing) {
      existing.content = thinking;
      existing.status = running ? 'running' : 'success';
    } else {
      assistant.thoughtSteps.push({
        id: `step-${ordered[0].streamKey}`,
        title: THINKING_STEP_TITLE,
        content: thinking,
        status: running ? 'running' : 'success',
        timestamp: Date.now(),
      });
    }
    assistant.isThinking = running;
  }
  // 未提交 = 进行中：气泡不得标记完成，否则渲染会收起进行态。
  assistant.isComplete = false;
}

/** 思考步骤的固定标题，与实时 PARTIAL_THINKING 投影一致（见 messageRouter）。 */
const THINKING_STEP_TITLE = '深度思考';

/**
 * 用工具实体刷新消息里 `toolCalls` 的执行结果（状态/输出）。
 *
 * <p>实体是权威：历史行只是它在写入时刻的快照。消息里只保留**引用结果**，
 * 不复制卡片的可变状态（否则两处各自更新必然分叉）。</p>
 */
function applyToolOutcomes(messages: ChatMessage[], store: ReturnType<typeof useStreamV3Store>): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    for (const trace of message.toolCalls) {
      const tool = store.getTool(trace.id);
      if (!tool) continue;
      const outcome = resolveToolOutcome(tool);
      if (outcome) {
        trace.status = outcome.status;
        if (outcome.result !== undefined) {
          trace.result = outcome.result;
        }
      }
    }
  }
}

/** 从工具实体解析执行结果；无 rawOutput 时返回 null（不改动历史快照）。 */
function resolveToolOutcome(tool: ToolCallVO): { status: 'success' | 'failed' | 'unknown'; result?: string } | null {
  const output = tool.rawOutput;
  if (!output || typeof output !== 'object') return null;
  const outcome = output.outcome != null ? String(output.outcome).trim().toUpperCase() : '';
  if (!outcome && output.output === undefined && output.stdout === undefined) return null;
  const value = output.output !== undefined ? output.output : output.stdout;
  const result = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const status: 'success' | 'failed' | 'unknown' =
    outcome === 'SUCCEEDED' ? 'success'
      : ['FAILED', 'REJECTED', 'TIMED_OUT', 'CANCELLED'].includes(outcome) ? 'failed'
        : 'unknown';
  return { status, result };
}

/**
 * 卡片展示：**以工具实体为驱动**，而不是以消息为驱动。
 *
 * <p>规则（对应「卡片先于消息到达」的验收场景）：</p>
 * <ol>
 *   <li>遍历本视图会话的全部工具实体，按 `content.kind` 分派卡片形态、按 `allowedActions` 决定按钮；</li>
 *   <li>能找到宿主气泡（该气泡的 `toolCalls` 里有这个 id）→ 把卡片挂进去；</li>
 *   <li>找不到宿主（卡片先到、正文未落库）→ 建一个按 `toolCallId` 稳定的展示气泡；</li>
 *   <li>宿主稍后到达时，第 2 条自然命中，第 3 条的展示气泡随之消失 —— 不新增第二张。</li>
 * </ol>
 *
 * <p><b>根视图额外规则</b>：子会话里等待审批的卡片必须能在主聊天直接审批，否则用户不打开子面板
 * 就无法恢复子执行。这里只**引用同一个工具实体**（不把子会话对话混进主聊天），
 * 卡片仍是那一份 `tools[toolCallId]`，审批后两边同时更新。</p>
 */
function applyCards(
  messages: ChatMessage[],
  store: ReturnType<typeof useStreamV3Store>,
  viewKey: string,
  isRootView: boolean,
  rootKey: string
): void {
  const scoped = [...store.tools.values()].filter(tool => ownsSession(tool, viewKey));
  const crossSession = isRootView
    ? [...store.tools.values()].filter(tool => isPendingCard(tool) && isSubSessionTool(tool, rootKey, store))
    : [];
  const entityIds = new Set([...scoped, ...crossSession].map(tool => String(tool.id)));

  // 历史聚合**已经**按 TOOL 行产出过卡片（那是写库时刻的快照，见 aggregateSessionMessages）。
  // 工具实体是权威，所以有实体的卡片先摘掉、稍后按实体重挂 —— 直接 push 会让同一张卡出现两次。
  // 没有对应实体的（更早的历史行）保持原样，不因为本轮派生而丢卡片。
  for (const message of messages) {
    const cards = message.promptCards;
    if (!cards?.length) continue;
    const kept = cards.filter(card => !entityIds.has(card.toolCallId));
    if (kept.length !== cards.length) {
      message.promptCards = kept;
      message.promptCard = kept[0];
    }
  }

  // 宿主索引：气泡的 toolCalls 里出现该 id，说明卡片与它同属一个回答组。
  const hostByToolCallId = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const trace of message.toolCalls ?? []) {
      hostByToolCallId.set(String(trace.id), message);
    }
  }

  const seen = new Set<string>();
  const orphans: PromptCardData[] = [];
  for (const tool of [...scoped, ...crossSession]) {
    const card = buildPromptCard(tool);
    if (!card || !card.toolCallId || seen.has(card.toolCallId)) continue;
    seen.add(card.toolCallId);
    const host = hostByToolCallId.get(card.toolCallId);
    if (host) {
      if (!host.promptCards) host.promptCards = [];
      host.promptCards.push(card);
      host.promptCard = host.promptCard ?? card;
    } else {
      orphans.push(card);
    }
  }

  // 无宿主卡片 → 稳定的独立展示气泡（id 由 toolCallId 决定，重算不会产生第二张）。
  for (const card of orphans) {
    messages.push(buildCardBubble(card));
  }
}

/** 无宿主卡片的展示气泡 id 前缀；这类气泡不是真实回答，正文叠加时必须跳过。 */
const CARD_BUBBLE_PREFIX = 'msg-card-';

/** 无宿主卡片的最小气泡：只承载卡片，不冒充 assistant 正文。 */
function buildCardBubble(card: PromptCardData): ChatMessage {
  return {
    id: `${CARD_BUBBLE_PREFIX}${card.toolCallId}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isComplete: true,
    thoughtSteps: [],
    toolCalls: [],
    aiMessages: [],
    promptCards: [card],
    promptCard: card,
  };
}

/** 工具实体是否属于该会话（`conversationId` 即 `session.id`）。 */
function ownsSession(tool: ToolCallVO, sessionId: string): boolean {
  if (tool.conversationId == null) return false;
  return String(tool.conversationId) === sessionId;
}

/** 是否可审批的 PROMISE 卡片（只有这类才值得跨会话冒泡到根视图）。 */
function isPendingCard(tool: ToolCallVO): boolean {
  return String(tool.type ?? '').toUpperCase() === 'PROMISE' && tool.pending === true;
}

/** 工具实体是否属于该根会话的某个子会话。 */
function isSubSessionTool(tool: ToolCallVO, rootKey: string, store: ReturnType<typeof useStreamV3Store>): boolean {
  if (tool.conversationId == null) return false;
  const sessionId = String(tool.conversationId);
  if (sessionId === rootKey) return false;
  const session = store.getSession(sessionId);
  if (!session) return false;
  const declaredRoot = session.rootSessionId != null ? String(session.rootSessionId) : null;
  return declaredRoot === rootKey;
}

/** 轮次摘要（token/模型/耗时/状态）按 turnId 引用补齐到 assistant 气泡。 */
function applyTurnSummaries(messages: ChatMessage[], store: ReturnType<typeof useStreamV3Store>): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.turnId) continue;
    const turn: ChatTurn | undefined = store.getTurn(message.turnId);
    if (!turn) continue;
    message.model = turn.modelName ?? message.model;
    message.tokens = turn.totalTokens ?? message.tokens;
    message.durationMs = turn.elapsedMs ?? message.durationMs;
    if (turn.status === 'FAILED') {
      message.sendError = turn.errorReason ?? message.sendError;
      message.isComplete = true;
    } else if (turn.status === 'COMPLETED' || turn.status === 'CANCELLED') {
      message.isComplete = true;
    } else {
      // ACCEPTED / RUNNING / WAITING 均为进行中：不得标记完成。
      message.isComplete = false;
    }
  }
}
