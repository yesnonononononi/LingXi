import type { ChatMessage, PromptCardData, ToolCallVO, SessionMessageVO } from '../types/chat';
import type { ToolExecutionState } from './toolMeta';
import { isEditFileTool, resolveToolCategory, resolveToolMeta } from './toolMeta';
import { asObject, toObject, toText } from './json';
import { parseTimestamp } from './time';

/**
 * 将后端 SessionMessageVO.records 解析为前端展示所用的标准 ChatMessage[] 结构。
 *
 * 契约来源：GET /session/{id}/messages → SessionMessagePageVO.records（已是结构化 VO）。
 * 消息类型收敛为 USER / AI / TOOL / SYSTEM；工具调用状态与卡片载荷来自 TOOL 行携带的
 * 聚合 ToolCallVO（`item.toolCall`），与实时流 CARD_PENDING 拉取的 VO 同源、同形状。
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
/* ToolCallVO → PromptCardData（历史与实时共用的唯一转换点）            */
/* ------------------------------------------------------------------ */

/** content.kind 合法取值（卡片渲染唯一判别字段） */
const PROMPT_KINDS = ['PLAN', 'CHOICE', 'COMMAND', 'DELEGATION'] as const;
type PromptKind = (typeof PROMPT_KINDS)[number];

/**
 * 归一化生命周期状态。
 * 契约来源：docs/frontend-backend-contract.md §3 —— `ToolCallStatus` 识别不了回落 **PENDING**
 * （「宁可渲染成待处理，也不静默吞掉」），故缺失/非法值一律按 `pending` 处理，不臆断为 `completed`。
 */
function normalizePromptStatus(status: unknown): PromptCardData['status'] {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'pending' || normalized === 'in_progress' || normalized === 'completed') {
    return normalized;
  }
  return 'pending';
}

/**
 * 由聚合工具调用（ToolCallVO）构建统一卡片数据。
 *
 * <p>返回 null 表示该工具调用不是待渲染的 PROMISE 卡片（EXECUTE / 非 PROMISE / 缺失），调用方据此跳过。</p>
 *
 * <p>契约来源（docs/frontend-backend-contract.md §3）：</p>
 * <ul>
 *   <li>`content`/`rawOutput` 是后端**已解析的 `JsonNode` 对象**，解析失败为 `null` → 按对象直接消费，不再字符串解析；</li>
 *   <li>`content.kind` 非法/缺失（后端 `fromName()` 识别不了返回 `null`）→ `unavailable:true`，**绝不回落 `COMMAND`**；</li>
 *   <li>`kind === 'EXECUTE'` 是「无卡片载荷的普通工具」，不渲染为卡片（返回 null）；</li>
 *   <li>`pending` 直接读后端权威下发的 `ToolCallVO.pending`，不再自行用 `status` 推断。</li>
 * </ul>
 */
export function buildPromptCard(toolCall?: ToolCallVO | null): PromptCardData | null {
  if (!toolCall) return null;
  const type = String(toolCall.type ?? '').trim().toUpperCase();
  if (type !== 'PROMISE') return null;

  // 契约 §3：ToolCallVO.content 已是解析后的对象（解析失败为 null）→ 按对象消费，禁止字符串 JSON.parse。
  const content = asObject(toolCall.content);
  const kindRaw = content ? String(content.kind ?? '').trim().toUpperCase() : '';
  // EXECUTE：无卡片载荷的普通工具，不渲染为卡片。
  if (kindRaw === 'EXECUTE') return null;
  const kindValid = (PROMPT_KINDS as readonly string[]).includes(kindRaw);
  // 非法/缺失 → 不可用态，绝不回落 COMMAND。
  const kind: PromptCardData['kind'] = kindValid ? (kindRaw as PromptKind) : 'UNAVAILABLE';

  // 契约 §3：rawOutput 同为已解析对象；结论唯一依据是 rawOutput.outcome。
  const rawOutput = asObject(toolCall.rawOutput);
  const outcome = rawOutput && rawOutput.outcome != null ? String(rawOutput.outcome) : undefined;
  // 契约 §3：pending 是前端唯一可审批判定，后端权威下发 —— 直接读该字段，禁止自行用 status 推断。
  const pending = toolCall.pending === true;

  const card: PromptCardData = {
    kind,
    toolCallId: toolCall.id != null ? String(toolCall.id) : '',
    conversationId: toolCall.conversationId != null ? String(toolCall.conversationId) : undefined,
    title: toolCall.title != null ? String(toolCall.title) : '',
    content: '',
    status: normalizePromptStatus(toolCall.status),
    pending,
    outcome,
    answer: rawOutput && rawOutput.answer != null ? String(rawOutput.answer) : undefined,
    stdout: rawOutput && rawOutput.stdout != null ? String(rawOutput.stdout) : undefined,
    exitCode: rawOutput && typeof rawOutput.exitCode === 'number' ? rawOutput.exitCode : undefined,
    unavailable: !kindValid
  };

  if (kindValid && content && kind === 'PLAN') {
    card.title = card.title || (content.title != null ? String(content.title) : '') || '任务计划';
    card.content = content.text != null ? String(content.text) : '';
  } else if (kindValid && content && kind === 'CHOICE') {
    card.content = content.question != null ? String(content.question) : '';
    card.title = card.title || card.content || '需要您的进一步确认';
    card.options = Array.isArray(content.options)
      ? content.options.map((o: unknown) => String(o ?? ''))
      : [];
  } else if (kindValid && content && kind === 'COMMAND') {
    card.command = content.command != null ? String(content.command) : '';
    card.content = card.command;
    card.workDir = content.workDir != null ? String(content.workDir) : undefined;
    card.shell = content.shell != null ? String(content.shell) : undefined;
    card.title = card.title || '命令审批';
  } else if (kindValid && content && kind === 'DELEGATION') {
    // 委派等待卡：标题 = 子代理名（登记时写入 tool_call.title），正文 = 委派任务。
    card.subSessionId = content.subSessionId != null ? String(content.subSessionId) : undefined;
    card.content = content.text != null ? String(content.text) : '';
    card.title = card.title || '子代理';
  }

  return card;
}

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
 * 统一聚合主会话与子会话的历史记录为 ChatMessage[] 展示列表。
 *
 * <p>核心方案（实施计划书 §二）：
 * 1. 原始记录统一合并后统一按 turnId 聚合，避免跨页拆分成多个独立气泡；
 * 2. 每个已知轮次生成唯一的回答组（id 为 stable 的 `msg-${sessionId}-turn-${turnId}`）；
 * 3. 收集该轮全部思考、AI 文本、工具调用与审批卡片；
 * 4. 最后一条非空 AI 文本作为正文，之前的 AI 文本进入折叠过程；
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
  const turnAiTextsMap = new Map<ChatMessage, Array<{ id: string; recordId: string; text: string; thinking?: string; timestamp: number }>>();

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

    // 0. 系统提示词不参与对话展示
    if (rawType === 'SYSTEM') {
      continue;
    }

    // 1. 用户消息
    if (rawType === 'USER') {
      currentLegacyAssistant = null;
      chatMessages.push({
        id: String(item.id),
        role: 'user',
        content: item.text ?? '',
        timestamp: ts,
        turnId
      });
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
            promptCards: [],
            isComplete: true
          };
          turnAssistantMap.set(turnId, asst);
          chatMessages.push(asst);
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
        promptCards: [],
        isComplete: true
      };
      currentLegacyAssistant = legacyAsst;
      chatMessages.push(legacyAsst);
      return legacyAsst;
    };

    // 2. 工具结果消息 (TOOL)
    if (rawType === 'TOOL') {
      const callId = item.toolCallId != null ? String(item.toolCallId) : '';
      const toolCall: ToolCallVO | null =
        item.toolCall && typeof item.toolCall === 'object' ? (item.toolCall as ToolCallVO) : null;
      const type = String(toolCall?.type ?? '').trim().toUpperCase();
      const resolvedCallId = callId || (toolCall?.id != null ? String(toolCall.id) : '');

      // 2a. PROMISE：人工在环卡片 → 构建统一 promptCard
      if (toolCall && type === 'PROMISE') {
        const card = buildPromptCard(toolCall);
        if (card) {
          const asst = getAssistantContainer();
          if (!asst.promptCards) asst.promptCards = [];
          const existingIdx = asst.promptCards.findIndex(c => c.toolCallId === card.toolCallId);
          if (existingIdx >= 0) {
            asst.promptCards[existingIdx] = card;
          } else {
            asst.promptCards.push(card);
          }
          asst.promptCard = asst.promptCards[0];

          if (asst.toolCalls && resolvedCallId) {
            const matched = asst.toolCalls.find(tc => tc.id === resolvedCallId);
            if (matched) {
              if (card.pending) {
                matched.status = 'pending';
                if (!matched.result) {
                  matched.result = card.command
                    ? `命令尚未执行，正在等待用户批准: ${card.command}`
                    : '工具尚未执行，正在等待用户批准';
                }
              } else if (card.outcome) {
                matched.status = (card.outcome === 'APPROVED' || card.outcome === 'SUCCEEDED') ? 'success' : 'failed';
              }
            }
          }
        }
        continue;
      }

      // 2b. toolCall 缺行
      if (!toolCall) {
        console.warn('[aggregateSessionMessages] TOOL 消息缺少 tool_call 行，已降级为不可用:', item.id, resolvedCallId);
        continue;
      }

      // 2c. EXECUTE：普通工具调用
      const asst = getAssistantContainer();
      const toolName = toolCall.toolName ?? '';
      const rawOutput = asObject(toolCall.rawOutput);
      const resultValue = rawOutput ? (rawOutput.output !== undefined ? rawOutput.output : rawOutput.stdout) : undefined;
      const resultStr = resultValue === undefined || resultValue === null ? '' : toText(resultValue);
      const outcome = rawOutput && rawOutput.outcome != null ? String(rawOutput.outcome).trim().toUpperCase() : '';
      const execStatus: ToolExecutionState =
        outcome === 'SUCCEEDED'
          ? 'success'
          : (['FAILED', 'REJECTED', 'TIMED_OUT', 'CANCELLED'].includes(outcome))
            ? 'failed'
            : 'unknown';
      const editLines = extractEditResultLines(toolName, resultStr);

      if (!asst.toolCalls) asst.toolCalls = [];
      const matched = resolvedCallId ? asst.toolCalls.find(tc => tc.id === resolvedCallId) : undefined;
      if (matched) {
        matched.result = resultStr;
        matched.status = execStatus;
        if (editLines) {
          matched.plusLines = editLines.plusLines;
          matched.minusLines = editLines.minusLines;
        }
      } else if (resolvedCallId) {
        asst.toolCalls.push({
          id: resolvedCallId,
          toolName: toolName || 'tool',
          category: resolveToolCategory(toolName),
          description: toolName,
          result: resultStr,
          status: execStatus,
          plusLines: editLines?.plusLines,
          minusLines: editLines?.minusLines,
          order: i * 10
        });
      }
      continue;
    }

    // 3. AI / Assistant 消息
    if (rawType === 'AI') {
      const text = item.text ?? '';
      const thinking = item.thinking;
      const asst = getAssistantContainer();

      // 处理 AI 文本：最后一条非空 AI 文本作为正文，之前的 AI 文本进入折叠过程
      if (text && text.trim()) {
        const recordId = String(item.id ?? `idx-${i}`);
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
            timestamp: ts
          });
        }
        const lastAi = aiList[aiList.length - 1];
        asst.content = lastAi.text;
        asst.aiMessages = aiList.slice(0, -1).map((m, idx) => ({
          id: m.id,
          text: m.text,
          thinking: m.thinking,
          timestamp: m.timestamp,
          order: idx * 10 + 1
        }));
      }

      // 处理思维链
      if (thinking) {
        if (!asst.thoughtSteps) asst.thoughtSteps = [];
        const stepId = `step-${sid}-${String(item.id ?? `idx-${i}`)}`;
        if (!asst.thoughtSteps.some(s => s.id === stepId)) {
          asst.thoughtSteps.push({
            id: stepId,
            title: 'Thought for',
            content: thinking,
            status: 'success',
            order: i * 10
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

          const tName = tc.name ?? 'tool';
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
            order: i * 10 + 2 + tIdx
          });
        }
      }

      continue;
    }

    console.warn('[aggregateSessionMessages] 未知消息类型，已忽略:', rawType || '(空)');
  }

  // 历史里未回填结果的工具调用：检查匹配卡片或标记为 unknown
  for (const msg of chatMessages) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.status === 'calling') {
          const matchingCard = msg.promptCards?.find(c => c.toolCallId === tc.id)
            || (msg.promptCard?.toolCallId === tc.id ? msg.promptCard : null);
          if (matchingCard) {
            if (matchingCard.pending) {
              tc.status = 'pending';
              if (!tc.result) {
                tc.result = matchingCard.command
                  ? `命令尚未执行，正在等待用户批准: ${matchingCard.command}`
                  : '工具尚未执行，正在等待用户批准';
              }
            } else if (matchingCard.outcome) {
              tc.status = (matchingCard.outcome === 'APPROVED' || matchingCard.outcome === 'SUCCEEDED') ? 'success' : 'failed';
            }
            continue;
          }
          tc.status = 'unknown';
          if (!tc.result) tc.result = '[状态未知] 后端未保留该工具的执行结果';
        }
      }
    }
  }

  return chatMessages;
}

export function parseSessionMessages(rawMessages: any, sessionId: string | number = 'session'): ChatMessage[] {
  return aggregateSessionMessages(rawMessages, sessionId);
}
