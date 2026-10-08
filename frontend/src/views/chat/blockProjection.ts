/**
 * {@link TurnViewVO} → 助手气泡的**唯一投影**（历史与实时共用）。
 *
 * <p><b>为什么单独成模块</b>：历史查询（分页返回 {@code turnViews}）与实时 SSE
 * （{@code TURN_SNAPSHOT}/{@code BLOCK_UPSERT}）拿到的是同一份后端契约。把投影收在一处，
 * 两侧就必然一致 —— 此前「历史用 rowIndex*100 排序、实时用 allocateOrder 排序」的分叉
 * 正是双气泡 / 思考插错位的根因。</p>
 *
 * <p><b>纯函数</b>：不读时钟、不查仓储、不改入参。渲染位置与顺序全来自后端
 * {@link Block#order}，本模块只做「块 → 前端过程项」的形状转换。</p>
 */

import type { Block, BlockStatus, ToolBlock, TurnViewVO } from '../../types/block';
import type { AiMessageItem, ChatMessage, ProcessTimelineItem, ThoughtStep, ToolCallTrace } from '../../types/chat';
import { resolveToolCategory } from '../../utils/toolMeta';
import { toObject } from '../../utils/json';
import { parseToolDiff } from '../../utils/toolDiff';

/** 块状态 → 思维步骤状态（ThoughtStep 只区分三态）。 */
function thinkingStatus(status: BlockStatus): ThoughtStep['status'] {
  if (status === 'DONE') return 'success';
  if (status === 'STREAMING') return 'running';
  return 'failed';
}

/** 块状态 → 工具执行状态（与 {@code utils/toolMeta.ts#resolveToolExecutionStatus} 的四态对齐）。 */
function toolStatus(status: BlockStatus): ToolCallTrace['status'] {
  switch (status) {
    case 'DONE':
      return 'success';
    case 'FAILED':
    case 'REJECTED':
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'failed';
    case 'PROMISED':
      return 'pending';
    case 'STREAMING':
    default:
      // 未收尾：本地「已请求、等待结果」态。绝不显示成成功或失败。
      return 'calling';
  }
}

/** 思考块 → 思维步骤。 */
function toThoughtStep(block: Block): ThoughtStep {
  return {
    id: block.blockId,
    title: '思考',
    content: block.type === 'THINKING' ? block.text : '',
    status: thinkingStatus(block.status),
    order: block.order,
  };
}

/** 正文块 → AI 中间叙述项。 */
function toAiMessage(block: Block): AiMessageItem {
  return {
    id: block.blockId,
    text: block.type === 'TEXT' ? block.text : '',
    order: block.order,
  };
}

/** 工具块 → 工具调用轨迹。 */
function toToolTrace(block: ToolBlock): ToolCallTrace {
  const argsObj = toObject(block.arguments ?? '{}', {});
  const diff = parseToolDiff({ toolName: block.toolName, result: block.output ?? undefined });
  return {
    id: block.toolCallId,
    toolName: block.toolName,
    args: argsObj,
    query: block.arguments ?? undefined,
    result: block.output ?? undefined,
    status: toolStatus(block.status),
    category: resolveToolCategory(block.toolName),
    plusLines: block.plusLines ?? diff?.plusLines ?? undefined,
    minusLines: block.minusLines ?? diff?.minusLines ?? undefined,
    order: block.order,
  };
}

/** 由单块构建它对应的时间线项（渲染位置的唯一落点）。 */
function toTimelineItem(block: Block): ProcessTimelineItem {
  switch (block.type) {
    case 'THINKING':
      return { id: block.blockId, type: 'thought', order: block.order, step: toThoughtStep(block) };
    case 'TEXT':
      return { id: block.blockId, type: 'intermediate_ai', order: block.order, message: toAiMessage(block) };
    case 'TOOL':
      return { id: block.blockId, type: 'tool', order: block.order, tool: toToolTrace(block) };
  }
}

/** 按 blockId 从数组内删除（不存在则无操作）。 */
function removeById<T>(list: T[], id: string): void {
  const index = list.findIndex(item => String((item as { id?: unknown }).id) === id);
  if (index >= 0) list.splice(index, 1);
}

/**
 * 块对应的**行内身份**：过程项数组里元素自身的 `id` 取值。
 *
 * <p>⚠️ 不等于 {@link Block#blockId}：工具块的 blockId 是 {@code tool:<toolCallId>}，
 * 而 {@code ToolCallTrace.id} 是裸的 {@code <toolCallId>}（与 {@code ToolCallVO.id} 同源，
 * 卡片/审批链路都按它查）。替换时必须按各列的真实身份清，不能拿 blockId 一律比对。</p>
 */
function rowIdsOf(block: Block): { thought?: string; ai?: string; tool?: string; timeline: string } {
  switch (block.type) {
    case 'THINKING':
      return { thought: block.blockId, timeline: block.blockId };
    case 'TEXT':
      return { ai: block.blockId, timeline: block.blockId };
    case 'TOOL':
      // 时间线项用 blockId 作 id，工具列用裸 toolCallId。
      return { tool: (block as ToolBlock).toolCallId, timeline: block.blockId };
  }
}

/**
 * 把一轮完整视图投影到助手气泡上（原地写入传入的 bubble）。
 *
 * <p>块的落点规则由后端给出，前端只按 {@link Block#type} 分流：</p>
 * <ul>
 *   <li>THINKING → {@code thoughtSteps}</li>
 *   <li>TEXT + PROCESS → {@code aiMessages}（中途叙述）</li>
 *   <li>TEXT + BODY → 气泡 {@code content}（本轮结论正文）</li>
 *   <li>TOOL → {@code toolCalls}</li>
 * </ul>
 *
 * <p><b>覆盖语义</b>：本函数以视图为权威**整体重写**上述四列（不是追加）。
 * 因此它天然幂等 —— 同一视图重复投影结果相同，乱序到达的旧帧由调用方按 viewVersion 拦截。</p>
 */
export function projectTurnView(bubble: ChatMessage, view: TurnViewVO): void {
  const thoughtSteps: ThoughtStep[] = [];
  const aiMessages: AiMessageItem[] = [];
  const toolCalls: ToolCallTrace[] = [];
  const timeline: ProcessTimelineItem[] = [];
  let bodyText = '';

  // blocks 已由后端按 order 升序；此处再排一次仅作防御，绝不改变相对次序。
  const ordered = [...view.blocks].sort((a, b) => a.order - b.order);

  for (const block of ordered) {
    if (block.type === 'TEXT' && block.placement === 'BODY') {
      bodyText = block.text;
      continue;
    }
    timeline.push(toTimelineItem(block));
    if (block.type === 'THINKING') thoughtSteps.push(toThoughtStep(block));
    else if (block.type === 'TEXT') aiMessages.push(toAiMessage(block));
    else toolCalls.push(toToolTrace(block));
  }

  bubble.thoughtSteps = thoughtSteps;
  bubble.aiMessages = aiMessages;
  bubble.toolCalls = toolCalls;
  bubble.processTimeline = timeline;
  bubble.content = bodyText;
}

/**
 * 气泡内已出现过的**最大 order**（无任何过程项时返回 -1）。
 *
 * <p>实时路径的职责边界：块顺序由后端给定，但「尚未被任何快照覆盖」的本地新项
 * （刚推入的思考步 / 工具卡 / 中间叙述）必须被放到已有序列表的**末尾**，
 * 否则渲染层升序排序会把它插进已有块中间。此函数只读不写，供
 * {@link nextOrderFor} 取「当前最大值」。</p>
 *
 * <p>四列必须全部计入，漏掉任何一类都会让新项拿到与旧项相同或更小的 order。
 * {@code promptCards} 是审批卡片不是时间线项，契约上没有 order，读到 undefined 即跳过 ——
 * 不要为了「凑齐四类」给它造字段。</p>
 */
export function maxOrderInBubble(bubble: ChatMessage): number {
  let maxOrder = -1;
  const consider = (order?: number): void => {
    if (typeof order === 'number' && order > maxOrder) maxOrder = order;
  };
  (bubble.thoughtSteps ?? []).forEach(step => consider(step.order));
  (bubble.toolCalls ?? []).forEach(call => consider(call.order));
  (bubble.aiMessages ?? []).forEach(message => consider(message.order));
  (bubble.processTimeline ?? []).forEach(item => consider(item.order));
  return maxOrder;
}

/**
 * 本地新项的 order：在气泡当前最大 order 上**跨槽步进一位**。
 *
 * <p>改用「继承后端 order」后不再需要 {@code allocateOrder} 那种「按项数重新编号」——
 * 后者会与后端千位步长的槽位（THINKING=0 / TEXT=1 / TOOL=2..）碰撞：
 * 后端第 N 轮工具 order 是 {@code N*1000+2}，而本地按项数编号会给出 4、5、6，
 * 两者混在一条列表里就会出现「本地工具跑到后端第一轮工具前面」的错位。</p>
 *
 * <p><b>跨槽不跨轮</b>：{@code STEP} 取 {@code RESPONSE_ORDER_STRIDE} 的十分之一，
 * 只用于把本地新项排在「已见过的一切」之后；下一帧快照到达时整轮会被后端 order 重投影覆盖，
 * 本地这个临时值随之作废 —— 它只需保证「在快照到达前不错位」。</p>
 */
const LOCAL_ORDER_STEP = 100;

export function nextOrderFor(bubble: ChatMessage): number {
  return maxOrderInBubble(bubble) + LOCAL_ORDER_STEP;
}

/**
 * 把一批轮次视图投影到**已聚合的历史消息**上 —— 历史路径的唯一接线点。
 *
 * <p>后端按页随分页响应下发 {@code turnViews}（键 = turnId，见 {@code SessionMessagePageVO}），
 * 每个键的视图是该轮的**完整**块列表（装配器按 turnId 查全部消息，与本页切在哪无关），
 * 因此整页一次性投影即可，无需像实时那样比 {@code viewVersion}。</p>
 *
 * <p><b>只认「助手气泡 + 该轮有视图」</b>：视图缺失的轮次保持聚合器的原样 ——
 * 旧数据、装配返回空、或后端未下发时，界面回落到原历史聚合结果，不会因为「没有视图」而变空。</p>
 */
export function projectTurnViews(messages: ChatMessage[], turnViews?: Record<string, TurnViewVO> | null): void {
  if (!turnViews) return;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const turnId = message.turnId;
    if (turnId === null || turnId === undefined) continue;
    const view = turnViews[String(turnId)];
    if (view) projectTurnView(message, view);
  }
}

/**
 * 把单块增量（{@code BLOCK_UPSERT}）并入现有气泡。
 *
 * <p><b>为什么不重投影整轮</b>：增量事件的 {@code blocks} 只含变化的那一块，无法整体重写。
 * 按 {@link Block#blockId} 替换/追加，保留其余块的原状。</p>
 *
 * <p>⚠️ <b>不做版本比较</b>：{@code BLOCK_UPSERT} 的 {@code viewVersion} 可能与前一次相等
 * （工具收尾不改 chat_turn），按版本丢弃会误杀合法增量。按 blockId 覆盖本身即幂等。</p>
 */
export function upsertBlockIntoBubble(bubble: ChatMessage, view: TurnViewVO): void {
  if (view.blocks.length === 0) return;

  const thoughtSteps = [...(bubble.thoughtSteps ?? [])];
  const aiMessages = [...(bubble.aiMessages ?? [])];
  const toolCalls = [...(bubble.toolCalls ?? [])];
  const timeline = [...(bubble.processTimeline ?? [])];
  let bodyText = bubble.content;

  for (const block of view.blocks) {
    // 四个落点都先按各列的真实身份清掉旧项，再按类型追加新项 —— 等价于「替换」，且天然幂等。
    const rowIds = rowIdsOf(block);
    if (rowIds.thought) removeById(thoughtSteps, rowIds.thought);
    if (rowIds.ai) removeById(aiMessages, rowIds.ai);
    if (rowIds.tool) removeById(toolCalls, rowIds.tool);
    removeById(timeline, rowIds.timeline);

    if (block.type === 'TEXT' && block.placement === 'BODY') {
      bodyText = block.text;
      continue;
    }
    timeline.push(toTimelineItem(block));
    if (block.type === 'THINKING') thoughtSteps.push(toThoughtStep(block));
    else if (block.type === 'TEXT') aiMessages.push(toAiMessage(block));
    else toolCalls.push(toToolTrace(block));
  }

  bubble.thoughtSteps = thoughtSteps;
  bubble.aiMessages = aiMessages;
  bubble.toolCalls = toolCalls;
  bubble.processTimeline = timeline;
  bubble.content = bodyText;
}
