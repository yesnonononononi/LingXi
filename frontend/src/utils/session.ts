import type { ChatMessage, ChatSession, ChatTurn, SubSessionVO } from '../types/chat';
import type { TurnViewVO } from '../types/block';
import { isTempSessionId } from './ids';
import { upsertTurnViewIntoMessages } from '../views/chat/blockProjection';

/**
 * 会话历史的纯函数工具集（分组 / 摘要 / 树对账 / 视图投影 / 失败轮合成 / 导出）。
 *
 * <p><b>展示内容的唯一来源是后端轮次视图</b>：历史分页与实时快照共用
 * {@link upsertTurnViewIntoMessages}，本模块不再从原始消息行聚合任何字段。
 * 消息的分组（{@link groupMessagesByTurn}）与轮次摘要绑定（{@link buildMessageTurnMap}）
 * 仍按 turnId 进行 —— 它们只负责「把已是权威的气泡归组」，不产生内容。</p>
 */

/**
 * 归一化 turnId：字符串（雪花 ID 已 Long→String）保留，空值/缺失归为 null。
 *
 * <p>null 表示「归属未知」（旧数据），调用方须走降级路径，**不得**据此伪造统计。</p>
 */
function normalizeTurnId(value: unknown): string | null {
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
 * 历史分页响应 → 消息列表的**唯一入口**（与实时快照/增量同一条更新规则）。
 *
 * <p><b>为什么不做「从原始消息行聚合」</b>：后端每一轮都随响应下发完整的
 * {@link TurnViewVO}（含用户提问、块列表、order / isBody / status），这正是
 * 实时链路拿到的那份契约。现在两侧共用 {@link upsertTurnViewIntoMessages}：
 * 按 {@code sessionId + turnId} 定位、按 {@code viewVersion} 接受更新。</p>
 *
 * <p><b>合页语义</b>：调用方必须把多页的 {@code turnViews} 累积后再调用一次
 * （同一 turnId 横跨两页时，视它们为同一条的更新，按版本取新）。</p>
 *
 * @param sessionId 会话 id，参与气泡身份构造
 * @param turnViews 已累计的块视图表（键 = turnId）；这就是展示内容的唯一来源
 * @param versions  可选：跨调用累计的版本表（翻页场景传入会话级表，避免重复投影）
 */
export function aggregateRecordsByIdentity(
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
