import type { ChatMessage, PromptCardData, ToolCallVO } from '../types/chat';
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
const PROMPT_KINDS = ['PLAN', 'CHOICE', 'COMMAND'] as const;
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
  }

  return card;
}

export function parseSessionMessages(rawMessages: any, sessionId = 'session'): ChatMessage[] {
  if (!rawMessages) return [];

  // 契约来源：GET /session/{id}/messages 返回 SessionMessagePageVO.records，
  // 已是解析好的 SessionMessageVO 数组（后端不再下发 JSON 字符串）。
  const list: any[] = Array.isArray(rawMessages) ? rawMessages : [];
  if (list.length === 0) return [];

  const chatMessages: ChatMessage[] = [];
  let currentAssistantMsg: ChatMessage | null = null;
  // 展示用时间戳：契约 §6 禁止客户端排序，但消息仍需一个展示时间。
  // createTime 解析不出来时沿用上一条已知时间（绝不 Date.now() 冒充历史），仍无参照则退化为 0。
  let lastKnownTs = 0;

  // 契约 §6：CursorResult.records 已按「旧 → 新」排序（id 为排序键与游标键），前端**禁止**再排序，直接信任返回顺序。
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item) continue;
    const parsedTs = parseItemTimestamp(item);
    if (parsedTs !== null) lastKnownTs = parsedTs;
    const ts = parsedTs ?? lastKnownTs;

    // 契约来源：SessionMessageVO.type ∈ { USER, AI, TOOL, SYSTEM }（SessionMessageType 枚举名）。
    const rawType = String(item.type ?? '').trim().toUpperCase();

    // 0. 系统提示词不参与对话展示
    if (rawType === 'SYSTEM') {
      continue;
    }

    // 1. 用户消息
    if (rawType === 'USER') {
      currentAssistantMsg = null; // 开启新一轮对话
      chatMessages.push({
        id: String(item.id),
        role: 'user',
        content: item.text ?? '',
        timestamp: ts
      });
      continue;
    }

    // 2. 工具结果消息 (TOOL)
    if (rawType === 'TOOL') {
      // 契约来源：SessionMessageVO.toolCallId（= 模型 call_id）+ toolCall（ToolCallVO 聚合；缺行时 null）。
      const callId = item.toolCallId != null ? String(item.toolCallId) : '';
      const toolCall: ToolCallVO | null =
        item.toolCall && typeof item.toolCall === 'object' ? (item.toolCall as ToolCallVO) : null;

      // 页首可能是 TOOL 消息：游标分页从最新往回取，加载更早历史时本页第一条往往是某个轮次的
      // 工具结果，其 AI 调用消息落在下一页。这里补一个 assistant 容器把它挂上，而不是静默丢弃
      // （丢弃会让历史里凭空少掉工具执行记录）。
      const ensureAssistant = (): ChatMessage => {
        if (!currentAssistantMsg) {
          const created: ChatMessage = {
            // 锚点用触发本容器的 TOOL 行 id（后端行 id 全局唯一且稳定）：
            // 跨页不碰撞（页内下标 i 会撞），重复解析同一页时幂等（同一条 TOOL 行 → 同一容器 id）。
            id: `msg-${sessionId}-orphan-${String(item.id ?? `idx-${i}`)}`,
            role: 'assistant',
            content: '',
            timestamp: ts,
            thoughtSteps: [],
            toolCalls: [],
            aiMessages: [],
            isComplete: true
          };
          currentAssistantMsg = created;
          chatMessages.push(created);
          return created;
        }
        return currentAssistantMsg;
      };

      const type = String(toolCall?.type ?? '').trim().toUpperCase();
      const resolvedCallId = callId || (toolCall?.id != null ? String(toolCall.id) : '');

      // 2a. PROMISE：人工在环卡片 → 构建统一 promptCard（历史权威来源，与实时同形状）
      if (toolCall && type === 'PROMISE') {
        const card = buildPromptCard(toolCall);
        if (card) {
          const asst = ensureAssistant();
          if (!asst.promptCards) asst.promptCards = [];
          const existingIdx = asst.promptCards.findIndex(c => c.toolCallId === card.toolCallId);
          if (existingIdx >= 0) {
            asst.promptCards[existingIdx] = card;
          } else {
            asst.promptCards.push(card);
          }
          asst.promptCard = asst.promptCards[0];

          // 同步工具调用轨迹的状态与结果，避免在历史展示中落为 unknown
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

      // 2b. toolCall 缺行：无锚点数据，诚实降级（消息保留，收尾逻辑标记为不可用）
      if (!toolCall) {
        console.warn('[parseSessionMessages] TOOL 消息缺少 tool_call 行，已降级为不可用:', item.id, resolvedCallId);
        continue;
      }

      // 2c. EXECUTE：普通工具调用 → 按 callId 合并结果到当前 assistant 的 toolCalls
      const assistant = ensureAssistant();
      const toolName = toolCall.toolName ?? '';
      // 契约 §3：ToolCallVO.rawOutput 已是解析后的对象（解析失败为 null）→ 按对象消费。
      const rawOutput = asObject(toolCall.rawOutput);
      const resultValue = rawOutput ? (rawOutput.output !== undefined ? rawOutput.output : rawOutput.stdout) : undefined;
      const resultStr = resultValue === undefined || resultValue === null ? '' : toText(resultValue);
      // 契约 §3：结论唯一判别字段是 raw_output.outcome；缺失/未知 = 状态未知，禁止默认成功或失败。
      const outcome = rawOutput && rawOutput.outcome != null ? String(rawOutput.outcome).trim().toUpperCase() : '';
      const execStatus: ToolExecutionState =
        outcome === 'SUCCEEDED'
          ? 'success'
          : (outcome === 'FAILED' || outcome === 'REJECTED' || outcome === 'TIMED_OUT' || outcome === 'CANCELLED')
            ? 'failed'
            : 'unknown';
      const editLines = extractEditResultLines(toolName, resultStr);

      if (!assistant.toolCalls) assistant.toolCalls = [];
      const matched = resolvedCallId ? assistant.toolCalls.find(tc => tc.id === resolvedCallId) : undefined;
      if (matched) {
        matched.result = resultStr;
        matched.status = execStatus;
        if (editLines) {
          matched.plusLines = editLines.plusLines;
          matched.minusLines = editLines.minusLines;
        }
      } else if (resolvedCallId) {
        assistant.toolCalls.push({
          id: resolvedCallId,
          toolName: toolName || 'tool',
          category: resolveToolCategory(toolName),
          description: toolName,
          result: resultStr,
          status: execStatus,
          plusLines: editLines?.plusLines,
          minusLines: editLines?.minusLines
        });
      }
      continue;
    }

    // 3. AI / Assistant 消息
    if (rawType === 'AI') {
      const text = item.text ?? '';
      const thinking = item.thinking;
      // 注意：SessionMessageVO 不含 token 字段，令牌统计只在会话元数据（SessionVO）上，
      // 由 fetchSessionDetail 回填到最新的一条 assistant 消息，这里不再逐条读取。

      // 如果当前轮次已有 assistant 消息（例如之前是工具调用步骤），则进行同轮次合并
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          id: String(item.id),
          role: 'assistant',
          content: text || '',
          timestamp: ts,
          thoughtSteps: [],
          toolCalls: [],
          aiMessages: text ? [{ id: `aimsg-${sessionId}-${i}`, text, thinking, timestamp: ts, order: i * 10 + 1 }] : [],
          isComplete: true
        };
        chatMessages.push(currentAssistantMsg);
      } else {
        if (!currentAssistantMsg.aiMessages) currentAssistantMsg.aiMessages = [];
        if (text) {
          // 同一轮内相邻 AI 行文本相同视为重复（如断流恢复重放过的事件），只保留第一条，
          // 否则正文（末条）与折叠区（slice(0,-1) 的非末条）会同时出现同一段文本。
          const lastAi = currentAssistantMsg.aiMessages[currentAssistantMsg.aiMessages.length - 1];
          if (!lastAi || lastAi.text !== text) {
            currentAssistantMsg.aiMessages.push({
              id: `aimsg-${sessionId}-${i}`,
              text,
              thinking,
              timestamp: ts,
              order: i * 10 + 1
            });
          }
          // 始终保持展示最后一条 aimessage 的正文
          currentAssistantMsg.content = text;
        }
        currentAssistantMsg.isComplete = true;
      }

      // 处理思维链
      if (thinking) {
        if (!currentAssistantMsg.thoughtSteps) currentAssistantMsg.thoughtSteps = [];
        currentAssistantMsg.thoughtSteps.push({
          id: `step-${sessionId}-${i}`,
          title: 'Thought for',
          content: thinking,
          status: 'success',
          order: i * 10
        });
      }

      // 处理工具调用（AI 行的 toolCalls 是「模型请求视图」ModelToolCallVO：{id,name,arguments}）。
      // 人工在环卡片不在此处预置——其权威来源是随后的 TOOL 行携带的聚合 toolCall（2a 分支）。
      if (Array.isArray(item.toolCalls)) {
        if (!currentAssistantMsg.toolCalls) currentAssistantMsg.toolCalls = [];
        for (let tIdx = 0; tIdx < item.toolCalls.length; tIdx++) {
          const tc = item.toolCalls[tIdx];
          const callId = String(tc.id);
          const tName = tc.name ?? 'tool';
          // 契约 §2：ModelToolCallVO.arguments 是 **JSON 字符串**（与 ToolCallVO 的已解析对象不同），故这里保留字符串解析。
          const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : '';
          const args = toObject(rawArgs, {});

          const meta = resolveToolMeta({ toolName: tName, args, rawArgs });

          currentAssistantMsg.toolCalls.push({
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
            status: 'calling', // 等待随后的 TOOL 消息按 toolCallId 回填结果
            order: i * 10 + 2 + tIdx
          });
        }
      }

      continue;
    }

    // 4. 未知类型：SessionMessageType 只有 USER/AI/TOOL/SYSTEM，出现其他值即契约变更，告警并忽略。
    console.warn('[parseSessionMessages] 未知消息类型，已忽略:', rawType || '(空)');
  }

  // 历史里仍未回填结果的工具调用：检查是否有对应的人工在环卡片；若无则标记为 unknown
  // 契约 §3：结论缺失 = 状态未知，既不是成功也不是失败 —— 标记为 unknown，绝不臆断为 failed 或 success。
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
