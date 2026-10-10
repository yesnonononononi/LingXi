import type { ChatMessage, PromptCardData, ToolCallVO } from '../types/chat';
import { asObject, toText } from './json';
import { AgentToolName } from './toolNames';

/**
 * {@link ToolCallVO} → {@link PromptCardData} 的唯一映射点（历史与实时共用）。
 *
 * <p>卡片形态只认 {@code content.kind}（后端唯一判别依据），{@code tool_name} 仅用于展示。
 * {@code kind} 缺失 / 非法（含 {@code EXECUTE}）一律降级为 {@code UNAVAILABLE}，
 * **绝不**回落成 {@code COMMAND} —— 否则语义未知的卡片会被渲染成带「批准并执行」按钮的命令审批卡。</p>
 */

/** 后端可识别的卡片形态（{@code content.kind} 的合法取值）。 */
const KNOWN_CARD_KINDS = ['PLAN', 'CHOICE', 'COMMAND'] as const;

type CardKind = PromptCardData['kind'];

/**
 * 解析卡片形态：仅接受后端 `ToolCallKind` 中的人工/委派形态；
 * 其余（缺失、`EXECUTE`、乱值）统一返回 `UNAVAILABLE`。
 */
export function resolveCardKind(content: unknown): CardKind {
  const node = asObject(content);
  const raw = node && node.kind != null ? String(node.kind).trim().toUpperCase() : '';
  return (KNOWN_CARD_KINDS as readonly string[]).includes(raw) ? (raw as CardKind) : 'UNAVAILABLE';
}

/**
 * 工具名是否可能承载互动卡片（后端 PROMISE 形态的三种工具：计划 / 提问 / 命令审批）。
 *
 * <p>**不包含** {@code call_sub_agent}：异步委派下该工具**不再产生 PROMISE 槽位**
 * （{@code AsyncDelegationResultRenderer} 返回受理即完成的普通 {@code success}）。
 * 若保留该判断，前端会为一个**永远不会存在**的卡片触发 {@code requestPromptCard}，
 * 进而按 {@code CARD_RETRY_MAX} 做 5 次 × 400ms 的无效重试与请求。
 * 去掉后 {@code call_sub_agent} 的工具块照常渲染（它走工具轨迹，不走卡片）。</p>
 */
export function isCardToolName(toolName?: string | null): boolean {
  return toolName === AgentToolName.CreatePlan
    || toolName === AgentToolName.RequireChoice
    || toolName === AgentToolName.ExecuteCommand;
}

/**
 * ★ 唯一可审批判定：`type==='PROMISE' && status==='pending'`（后端权威）。
 * 禁止用 `status` 单字段或 `pending` 布尔自行推断。
 */
export function isApprovableCard(card: ToolCallVO): boolean {
  return card.type === 'PROMISE' && card.status === 'pending';
}

/**
 * 卡片决策动作（与后端 `allowedActions` 元素同集合）。
 */
export type CardDecisionAction = 'APPROVE' | 'REJECT' | 'ANSWER';

/**
 * 卡片操作按钮是否可用：**必须叠加权威 `pending`**（= {@link isApprovableCard}），
 * 再要求后端动作集合含目标动作。只判 `allowedActions` 会被「已决但残留动作」的脏数据骗过，
 * 在已决卡上渲染出可点按钮（A3 纵深防御）。四类卡片的按钮门控统一走此判定。
 */
export function canDecideCard(card: PromptCardData, action: CardDecisionAction): boolean {
  return card.pending === true && card.allowedActions?.includes(action) === true;
}

/** 生命周期状态映射：后端 `preparing/pending/in_progress/completed` → 卡片状态；未知归 `preparing`。 */
function resolveCardStatus(status?: string): PromptCardData['status'] {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'preparing';
  }
}

/** 按形态取卡片正文（PLAN 计划书 / CHOICE 问题 / COMMAND 命令）。 */
function resolveCardContent(kind: CardKind, content: Record<string, any> | null): string {
  if (!content) return '';
  switch (kind) {
    case 'PLAN':
      return content.text != null ? toText(content.text) : '';
    case 'CHOICE':
      return content.question != null ? toText(content.question) : '';
    case 'COMMAND':
      return content.command != null ? toText(content.command) : '';
    default:
      return '';
  }
}

/** CHOICE 候选答案：仅接受字符串数组，逐项去空；非数组返回 undefined。 */
function resolveOptions(content: Record<string, any> | null): string[] | undefined {
  if (!content || !Array.isArray(content.options)) return undefined;
  return content.options.map((item: unknown) => String(item ?? '').trim()).filter(Boolean);
}

/** 把权威 {@link ToolCallVO} 映射为卡片展示数据。 */
export function toPromptCardData(card: ToolCallVO): PromptCardData {
  const content = asObject(card.content);
  const rawOutput = asObject(card.rawOutput);
  const kind = resolveCardKind(card.content);

  const planTitle = content && content.title != null ? toText(content.title) : '';
  const title = planTitle || card.title || '';

  const exitCodeRaw = rawOutput ? rawOutput.exitCode : undefined;
  const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : undefined;

  return {
    kind,
    toolCallId: card.id != null ? String(card.id) : '',
    conversationId: card.conversationId != null ? String(card.conversationId) : undefined,
    title,
    content: resolveCardContent(kind, content),
    options: kind === 'CHOICE' ? resolveOptions(content) : undefined,
    workDir: content && content.workDir != null ? toText(content.workDir) : undefined,
    shell: content && content.shell != null ? toText(content.shell) : undefined,
    command: content && content.command != null ? toText(content.command) : undefined,
    intention: content && content.intention != null ? toText(content.intention) : undefined,
    status: resolveCardStatus(card.status),
    version: card.version != null ? String(card.version) : undefined,
    allowedActions: card.allowedActions,
    unavailableReason: card.unavailableReason,
    pending: isApprovableCard(card),
    outcome: rawOutput && rawOutput.outcome != null ? String(rawOutput.outcome) : undefined,
    answer: rawOutput && rawOutput.answer != null ? toText(rawOutput.answer) : undefined,
    stdout: rawOutput && rawOutput.stdout != null ? toText(rawOutput.stdout) : undefined,
    exitCode,
    unavailable: kind === 'UNAVAILABLE'
  };
}

/**
 * ★ 把权威卡片 VO 写入气泡的 `promptCards`（按 id 覆盖 / 追加）—— 历史与实时的**唯一落点**。
 *
 * <p>为什么必须收敛成一处：历史路径（`utils/session.ts` 的聚合器，卡片随原始行重建）与
 * 实时路径（`views/chat/turnStreamReducer.ts` 的 {@code resolvePromptCard}，异步拉权威 VO）
 * 原本各写了一份「按 id 覆盖否则 push」的逻辑。两份实现的差异是**静默**的 ——
 * 只有「历史刷新后卡片状态和实时不一致」这种事后才发现的现象，没有任何编译期或测试期的提示。
 * 历史上已经因为这种漂移出过问题（`toolCallCard.ts` 是后来才补的第三处映射点）。</p>
 *
 * <p>幂等语义（两条路径都依赖）：同 id 覆盖而非追加，保证「重试拉取」「对账重放」
 * 不会在同一气泡里堆出多张同 id 卡片。</p>
 *
 * @param bubble 目标气泡（就地修改其 promptCards）
 * @param card   权威 ToolCallVO
 * @returns 是否发生写入（`card.type !== 'PROMISE'` 时不写入，调用方可据此判断）
 */
export function upsertPromptCard(
  bubble: { promptCards?: ToolCallVO[] },
  card: ToolCallVO | null | undefined
): boolean {
  // 只有 PROMISE 才是人工在环卡片；其余形态（含 EXECUTE）不入 promptCards
  if (!card || card.type !== 'PROMISE') return false;
  if (!bubble.promptCards) bubble.promptCards = [];
  const idx = bubble.promptCards.findIndex(c => String(c.id) === String(card.id));
  if (idx >= 0) {
    bubble.promptCards[idx] = card;
  } else {
    bubble.promptCards.push(card);
  }
  return true;
}

/** 只给块视图已确认的工具调用补齐权威卡片，不从原始消息重建气泡或审批内容。 */
export function attachPromptCards(messages: ChatMessage[], cards: readonly ToolCallVO[]): void {
  const owners = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const tool of message.toolCalls ?? []) owners.set(String(tool.id), message);
  }
  for (const card of cards) {
    const owner = owners.get(String(card.id));
    if (owner) upsertPromptCard(owner, card);
  }
}

/** 卡片类型标签（已决卡片折叠摘要用）。 */
const CARD_KIND_LABEL: Record<CardKind, string> = {
  PLAN: '计划',
  CHOICE: '提问',
  COMMAND: '命令审批',
  UNAVAILABLE: '互动卡片'
};

/** 结论标签（已决卡片折叠摘要用）。 */
const CARD_OUTCOME_LABEL: Record<string, string> = {
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  ANSWERED: '已答复',
  CANCELLED: '已取消',
  SUCCEEDED: '已执行',
  FAILED: '已失败',
  TIMED_OUT: '已超时'
};

/**
 * 卡片阶段标签（无结论时摘要尾巴）。
 *
 * <p>与卡内状态文案同口径。**禁止用「缺 outcome」推断已结束**：后端 PREPARING 时
 * {@code pending=true}（未终结），前端就绪位为 false → 卡片走折叠摘要，若据此标「已结束」，
 * 就会出现外层「已结束」、展开后卡内「准备中」的自相矛盾。</p>
 */
const CARD_STATUS_LABEL: Record<PromptCardData['status'], string> = {
  preparing: '准备中',
  pending: '等待审批',
  in_progress: '执行中',
  completed: '已结束'
};

/** 卡片单行摘要文案：有结论按结论，无结论按生命周期阶段。 */
export function buildCardSummary(card: PromptCardData): string {
  const kind = CARD_KIND_LABEL[card.kind];
  const tail = card.outcome
    ? (CARD_OUTCOME_LABEL[card.outcome] ?? card.outcome)
    : CARD_STATUS_LABEL[card.status];
  return `${kind}${card.title ? `：${card.title}` : ''} · ${tail}`;
}
