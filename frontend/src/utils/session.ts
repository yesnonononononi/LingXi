import type { ChatMessage, PromptCardData, ToolCallVO } from '../types/chat';
import type { ToolExecutionState } from './toolMeta';
import { isEditFileTool, resolveToolCategory, resolveToolMeta } from './toolMeta';
import { asObject, toObject, toText } from './json';
import { parseTimestamp } from './time';

/**
 * 将后端 SessionMessageVO.records 解析为前端展示所用的标准 ChatMessage[] 结构。
 *
 * 契约来源：GET /session/{id}/messages → SessionMessagePageVO.records（已是结构化 VO）。
 * 消息类型收敛为 USER / AI / TOOL / SYSTEM / ERROR；工具调用状态与卡片载荷来自 TOOL 行携带的
 * 聚合 ToolCallVO（`item.toolCall`），与实时流 CARD_PENDING 拉取的 VO 同源、同形状；
 * ERROR 行是执行失败的落库标注，并入所在轮次的 assistant 气泡的 executionError。
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
 * 归一化 executionId：字符串（雪花 ID 已 Long→String）保留，空值/缺失归为 null。
 *
 * <p>null 表示「归属未知」（旧数据），调用方须走降级路径，**不得**据此伪造统计。</p>
 */
export function normalizeExecutionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** 回答组：以 executionId 为唯一键的一段连续消息。 */
export interface AnswerGroup {
  /** 分组键：executionId；旧数据（归属未知）为 null。 */
  executionId: string | null;
  messages: ChatMessage[];
}

/**
 * 按 executionId 把消息切成回答组（渲染层唯一分组规则，主会话与子会话共用）。
 *
 * <p>规则（务必与后端契约一致）：</p>
 * <ol>
 *   <li>按服务端顺序遍历；USER 消息一律开启新组 —— 用户提问是执行的起点；</li>
 *   <li>非 USER 消息：executionId 与当前组相同则并入，**不同必须拆组**，
 *       绝不能被旧的「USER 边界」逻辑跨执行合并；</li>
 *   <li>executionId 为 null 的旧数据沿用「USER 边界」降级，且不伪造任何统计。</li>
 * </ol>
 */
export function groupMessagesByExecution(messages: ChatMessage[]): AnswerGroup[] {
  const groups: AnswerGroup[] = [];
  let current: AnswerGroup | null = null;
  for (const msg of messages) {
    const executionId = normalizeExecutionId(msg.executionId);
    // USER 开新组；executionId 变化也开新组（含旧数据 null 的边界降级）。
    if (!current || msg.role === 'user' || current.executionId !== executionId) {
      current = { executionId, messages: [] };
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
  // 当前 assistant 容器归属的执行 id（null = 归属未知）。回答组以 executionId 为唯一键：
  // 只有 executionId 相同的连续消息才能并入同一容器，变化必须拆组。
  let currentAssistantExecutionId: string | null = null;
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
    const executionId = normalizeExecutionId(item.executionId);

    // 契约来源：SessionMessageVO.type ∈ { USER, AI, TOOL, SYSTEM, ERROR }（SessionMessageType 枚举名）。
    const rawType = String(item.type ?? '').trim().toUpperCase();

    // 0. 系统提示词不参与对话展示
    if (rawType === 'SYSTEM') {
      continue;
    }

    /**
     * 取「本执行」的 assistant 气泡：executionId 相同则复用，不同（或尚无容器）则新建一个。
     *
     * 锚点用触发本容器的行 id（后端行 id 全局唯一且稳定）：跨页不碰撞（页内下标 i 会撞），
     * 重复解析同一页时幂等（同一行 → 同一容器 id）。刻意**不**用 executionId 直接做容器 id ——
     * 同一 executionId 的消息可能跨页（页首 TOOL 行、其 AI 行落在下一页），若容器 id 只由
     * executionId 决定，跨页两段会被按 id 误判为重复而整块丢弃，反而丢消息。
     *
     * 之所以需要它：游标分页从最新往回取，页首往往就是某个执行的 TOOL / ERROR 行，
     * 其 AI 行落在下一页。不补容器就只能静默丢弃，历史里会凭空少掉工具执行记录或失败提示。
     */
    const openAssistant = (executionIdForMsg: string | null): ChatMessage => {
      if (currentAssistantMsg && currentAssistantExecutionId === executionIdForMsg) {
        return currentAssistantMsg;
      }
      // executionId 变化必须拆组：绝不沿用上一个执行的气泡（否则跨执行内容会被错误合并）
      const created: ChatMessage = {
        id: `msg-${sessionId}-orphan-${String(item.id ?? `idx-${i}`)}`,
        role: 'assistant',
        content: '',
        timestamp: ts,
        executionId: executionIdForMsg,
        thoughtSteps: [],
        toolCalls: [],
        aiMessages: [],
        isComplete: true
      };
      currentAssistantMsg = created;
      currentAssistantExecutionId = executionIdForMsg;
      chatMessages.push(created);
      return created;
    };

    // 1. 用户消息
    if (rawType === 'USER') {
      // 开启新一轮对话：用户提问是执行的起点，下一个非 USER 行必然开新容器。
      currentAssistantMsg = null;
      currentAssistantExecutionId = executionId;
      chatMessages.push({
        id: String(item.id),
        role: 'user',
        content: item.text ?? '',
        timestamp: ts,
        executionId
      });
      continue;
    }

    // 2. 工具结果消息 (TOOL)
    if (rawType === 'TOOL') {
      // 契约来源：SessionMessageVO.toolCallId（= 模型 call_id）+ toolCall（ToolCallVO 聚合；缺行时 null）。
      const callId = item.toolCallId != null ? String(item.toolCallId) : '';
      const toolCall: ToolCallVO | null =
        item.toolCall && typeof item.toolCall === 'object' ? (item.toolCall as ToolCallVO) : null;

      const type = String(toolCall?.type ?? '').trim().toUpperCase();
      const resolvedCallId = callId || (toolCall?.id != null ? String(toolCall.id) : '');

      // 2a. PROMISE：人工在环卡片 → 构建统一 promptCard（历史权威来源，与实时同形状）
      if (toolCall && type === 'PROMISE') {
        const card = buildPromptCard(toolCall);
        if (card) {
          const asst = openAssistant(executionId);
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
      const assistant = openAssistant(executionId);
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

    // 3. 执行失败标注行 (ERROR)：标注所在轮次。
    //    标注字段必须与实时渲染同形——实时路径（applyStreamMessage）遇到执行失败时同时写
    //    assistant 气泡的 executionError 与本轮用户气泡的 sendError。漏写任一，流结束的消息级
    //    对账用落库行重建列表后，那个标识就会凭空消失（＝「错误一闪即逝」）。
    if (rawType === 'ERROR') {
      const errorText = typeof item.text === 'string' ? item.text.trim() : '';
      if (errorText) {
        openAssistant(executionId).executionError = errorText;
        // 列表此刻尚未解析到本行之后的消息，从末尾回溯命中的即本轮的最近一条用户消息。
        for (let prev = chatMessages.length - 1; prev >= 0; prev--) {
          if (chatMessages[prev].role === 'user') {
            chatMessages[prev].sendError = errorText;
            break;
          }
        }
      } else {
        console.warn('[parseSessionMessages] ERROR 消息正文为空，已忽略:', item.id);
      }
      continue;
    }

    // 4. AI / Assistant 消息
    if (rawType === 'AI') {
      const text = item.text ?? '';
      const thinking = item.thinking;
      // 注意：SessionMessageVO 不承载 token / 模型 / 耗时统计，这些信息由分页接口的
      // executions 字典（按 executionId 绑定到回答组）提供；这里不再逐条读取，也不回填会话累计值。

      // 取「本执行」的 assistant 容器：executionId 相同则并入，变化则拆出新容器（绝不跨执行合并）。
      const asst = openAssistant(executionId);

      if (!asst.aiMessages) asst.aiMessages = [];
      if (text) {
        // 同一执行内相邻 AI 行文本相同视为重复（如断流恢复重放过的事件），只保留第一条，
        // 否则正文（末条）与折叠区（slice(0,-1) 的非末条）会同时出现同一段文本。
        const lastAi = asst.aiMessages[asst.aiMessages.length - 1];
        if (!lastAi || lastAi.text !== text) {
          asst.aiMessages.push({
            id: `aimsg-${sessionId}-${i}`,
            text,
            thinking,
            timestamp: ts,
            order: i * 10 + 1
          });
        }
        // 始终保持展示最后一条 aimessage 的正文
        asst.content = text;
      }
      asst.isComplete = true;

      // 处理思维链
      if (thinking) {
        if (!asst.thoughtSteps) asst.thoughtSteps = [];
        asst.thoughtSteps.push({
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
        if (!asst.toolCalls) asst.toolCalls = [];
        for (let tIdx = 0; tIdx < item.toolCalls.length; tIdx++) {
          const tc = item.toolCalls[tIdx];
          const callId = String(tc.id);
          const tName = tc.name ?? 'tool';
          // 契约 §2：ModelToolCallVO.arguments 是 **JSON 字符串**（与 ToolCallVO 的已解析对象不同），故这里保留字符串解析。
          const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : '';
          const args = toObject(rawArgs, {});

          const meta = resolveToolMeta({ toolName: tName, args, rawArgs });

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
            status: 'calling', // 等待随后的 TOOL 消息按 toolCallId 回填结果
            order: i * 10 + 2 + tIdx
          });
        }
      }

      continue;
    }

    // 5. 未知类型：SessionMessageType 只有 USER/AI/TOOL/SYSTEM/ERROR，出现其他值即契约变更，告警并忽略。
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
