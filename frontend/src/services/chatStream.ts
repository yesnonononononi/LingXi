/**
 * ⚠️⚠️ 死代码（零引用），**改这里不会生效** ⚠️⚠️
 *
 * 2026-09-30 复核：`api.ts` 的 `export *` 清单不含本文件，全仓（除 `stores/sseRouter.ts:18`
 * 的一句注释外）没有任何 `from './chatStream'` / `chatStreamService` 引用。
 * **活跃实现是 `services/chat.ts`（`export const chatApi`，`chat.ts:171`）**，
 * 入口链：`views/chat/useChatView.ts:2` → `api.ts` → `chat.ts`。
 *
 * 本文件与 `chat.ts` 的 `sendMessageStream` / `decideToolCall` 结构同构（参数表、事件 switch
 * 逐字相同），历史上曾因「结构相同」被误当成活跃实现而把修复打在这里 —— 本次排查
 * 「批准后子代理 SSE 事件丢失」时即中招。建议整个删除；删除前请先跑一次
 * `vue-tsc -b --force` 确认无引用残留。
 */
import { AgentAPI } from './agent';
import { SessionAPI } from './session';
import { ToolCallAPI } from './toolCall';
import { buildPromptCard } from '../utils/session';
import { extractErrorMessage } from '../utils/error';
import { isOk } from '../utils/api';
import { createLocalId, toServerSessionId } from '../utils/ids';
import {
  extractSubAgentParams,
  isEditFileTool,
  isSubAgentTool,
  resolveToolCategory,
  resolveToolExecutionStatus,
  resolveToolMeta,
  TOOL_CATEGORY
} from '../utils/toolMeta';
import { toText } from '../utils/json';
import { parseToolDiffFromResult } from '../utils/toolDiff';
import { extractDirName } from '../utils/path';
import type {
  ChatMessage,
  AgentStreamEvent,
  ThoughtStep,
  ToolCallVO,
  PromptCardData
} from '../types/chat';

function buildUnavailablePromptCard(toolCallId: string): PromptCardData {
  return {
    kind: 'COMMAND',
    toolCallId,
    title: '',
    content: '',
    status: 'pending',
    pending: false,
    unavailable: true
  };
}

/**
 * 追加一条中间轮次 aimessage，并保证「同轮文本只记一次」。
 *
 * 后端 AI_MESSAGE 每个模型轮次发布一次，工具调用轮不含正文（text 为空），
 * 断流恢复（EXECUTION_RESUMED）也可能重放同一事件。若不加判重，折叠区会重复展示同一段文本
 * （正文取 aiMessages 末条、中间区取 slice(0,-1)，重复项必然同时出现在两处）。
 *
 * 规则：文本为空则只补 thinking，不落正文条目；文本与上一条完全相同则视为重放，忽略。
 */
function appendAiMessage(target: ChatMessage, text: string, thinking: string): void {
  if (!target.aiMessages) target.aiMessages = [];
  if (!text.trim()) return;
  const last = target.aiMessages[target.aiMessages.length - 1];
  if (last && last.text === text) return;
  const order = target.aiMessages.reduce((max, m) => Math.max(max, m.order ?? 0), 0) + 1;
  target.aiMessages.push({
    id: createLocalId('aimsg'),
    text,
    thinking,
    timestamp: Date.now(),
    order
  });
}

/**
 * CARD_PENDING 通知处理：拉取工具调用权威数据 → 构建统一 promptCard → 落到目标气泡。
 *
 * 契约来源：SSE 单值事件 CARD_PENDING 只做「有新的 pending 卡片」通知，卡片载荷权威源为
 * tool_call 行（`GET /tool-call/{toolCallId}`）。历史与实时两条路径因此产出同一形状的 promptCard。
 *
 * 返回值：true = 已处理（含「该 tool_call 本就不是 PROMISE 卡片」）；false = 拉取失败。
 * 拉取失败时会在气泡上落一张 `unavailable` 卡片，使失败对用户可见——后端此时可能已暂停等待审批，
 * 若静默吞掉，用户只会看到「AI 卡住不动」。
 */
async function attachPromptCard(
  toolCallId: string,
  target: ChatMessage,
  onProgress: (msg: ChatMessage) => void
): Promise<boolean> {
  try {
    const toolCall: ToolCallVO | null = await ToolCallAPI.find(toolCallId);
    const card = buildPromptCard(toolCall);
    if (card) {
      if (!target.promptCards) target.promptCards = [];
      const idx = target.promptCards.findIndex(c => c.toolCallId === card.toolCallId);
      if (idx >= 0) {
        target.promptCards[idx] = card;
      } else {
        target.promptCards.push(card);
      }
      target.promptCard = target.promptCards[0];

      // 同步当前活跃工具调用的状态为 pending
      if (target.toolCalls) {
        const matched = target.toolCalls.find(tc => tc.id === card.toolCallId);
        if (matched && card.pending) {
          matched.status = 'pending';
        }
      }

      onProgress({ ...target });
      return true;
    }
    console.warn('[attachPromptCard] 工具调用未产生可渲染卡片:', toolCallId);
    return true;
  } catch (err) {
    console.warn('[attachPromptCard] 拉取工具调用卡片失败:', toolCallId, err);
    const unavailableCard = buildUnavailablePromptCard(toolCallId);
    if (!target.promptCards) target.promptCards = [];
    const idx = target.promptCards.findIndex(c => c.toolCallId === toolCallId);
    if (idx >= 0) {
      target.promptCards[idx] = unavailableCard;
    } else {
      target.promptCards.push(unavailableCard);
    }
    target.promptCard = target.promptCards[0];
    onProgress({ ...target });
    return false;
  }
}


/**
 * 负责 Agent 会话流式事件处理与恢复执行的流式服务功能类
 */
export class ChatStreamService {
  /** 创建会话辅助方法
   *
   * @param teamId 建会话时一并绑定的团队；聊天请求不带 teamId，
   *               团队绑定只能在此（建会话）或 SessionAPI.bindTeam（换绑）落库。
   */
  async createSession(
    name: string,
    workspaceId?: string | number | null,
    teamId?: string | number | null
  ): Promise<string> {
    const trimmedName = name.trim() || '新对话';
    const res = await SessionAPI.create({
      name: trimmedName,
      workspaceId,
      teamId,
    });
    if (!isOk(res.code) || res.data === undefined || res.data === null) {
      throw new Error(res.errMsg || '创建会话失败');
    }
    return String(res.data);
  }

  async decideToolCall(
    conversationId: string | number,
    toolCallId: string,
    approved: boolean,
    text: string,
    onProgress: (msg: ChatMessage) => void,
    signal?: AbortSignal,
    onFinish?: () => void
  ): Promise<boolean> {
    const streamStartTime = Date.now();
    const botMsgId = createLocalId('msg-bot-resume');
    const botMessage: ChatMessage = {
      id: botMsgId,
      role: 'assistant',
      model: 'AI',
      content: '',
      timestamp: streamStartTime,
      isThinking: true,
      isExploring: true,
      isComplete: false,
      thoughtSteps: [],
      toolCalls: [],
      aiMessages: []
    };

    const sessionIdFilter = String(conversationId);
    let thinkingStartTime = 0;
    let currentThinkingStep: ThoughtStep | null = null;
    let currentTurnText = '';
    let timelineSeq = 0;

    const finalizeLastAiMessage = () => {
      const lastAiMsg = botMessage.aiMessages?.length
        ? botMessage.aiMessages[botMessage.aiMessages.length - 1]
        : null;
      if (lastAiMsg && lastAiMsg.text !== undefined && lastAiMsg.text !== null && lastAiMsg.text !== '') {
        botMessage.content = lastAiMsg.text;
      } else if (currentTurnText) {
        botMessage.content = currentTurnText;
      }
    };

    const finishThinkingStep = () => {
      if (currentThinkingStep && currentThinkingStep.status === 'running') {
        currentThinkingStep.status = 'success';
        currentThinkingStep.durationMs = Math.max(Date.now() - thinkingStartTime, 1);
        currentThinkingStep = null;
      }
      botMessage.isThinking = false;
    };

    const settleComplete = () => {
      const runningStep = botMessage.thoughtSteps?.find(s => s.status === 'running');
      if (runningStep) {
        runningStep.status = 'success';
        runningStep.durationMs = Math.max(Date.now() - thinkingStartTime, 1);
      }
      finalizeLastAiMessage();
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isComplete = true;
      if (!botMessage.durationMs) {
        botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
      }
    };

    let streamEstablished = false;
    const resolveEstablished = (resolve: (v: boolean) => void) => {
      if (!streamEstablished) {
        streamEstablished = true;
        onProgress({ ...botMessage });
        resolve(true);
      }
    };

    return new Promise<boolean>((resolve, reject) => {
      void (async () => {
        try {
          await ToolCallAPI.decide(
            { conversationId, toolCallId, approved, text },
            (event: AgentStreamEvent) => {
              // 只渲染本会话的事件；子会话（委派执行）事件由视图层 routeSessionEvent 接入
              const eventSessionId = event.sessionId == null ? null : String(event.sessionId);
              if (eventSessionId !== null && eventSessionId !== sessionIdFilter) {
                return;
              }

              if (!streamEstablished) {
                resolveEstablished(resolve);
              }

              if (event.type !== 'PARTIAL_THINKING' && currentThinkingStep) {
                finishThinkingStep();
              }

              switch (event.type) {
                case 'EXECUTION_STARTED': {
                  botMessage.isThinking = true;
                  botMessage.isExploring = true;
                  onProgress({ ...botMessage });
                  break;
                }

                case 'PARTIAL_THINKING': {
                  botMessage.isThinking = true;
                  if (!currentThinkingStep) {
                    thinkingStartTime = Date.now();
                    currentThinkingStep = {
                      id: createLocalId('step'),
                      title: 'Thought for',
                      content: '',
                      status: 'running',
                      durationMs: 0,
                      order: timelineSeq++,
                      timestamp: Date.now()
                    };
                    if (!botMessage.thoughtSteps) botMessage.thoughtSteps = [];
                    botMessage.thoughtSteps.push(currentThinkingStep);
                  }
                  if (event.content) {
                    currentThinkingStep.content += event.content;
                  }
                  currentThinkingStep.durationMs = Math.max(Date.now() - thinkingStartTime, 1);
                  onProgress({ ...botMessage });
                  break;
                }

                case 'TOOL_CALL': {
                  botMessage.isExploring = false;
                  if (currentTurnText && currentTurnText.trim()) {
                    if (!botMessage.aiMessages) botMessage.aiMessages = [];
                    const existing = botMessage.aiMessages.find(m => m.text === currentTurnText);
                    if (!existing) {
                      botMessage.aiMessages.push({
                        id: createLocalId('aimsg-turn'),
                        text: currentTurnText,
                        timestamp: Date.now(),
                        order: timelineSeq++
                      });
                    }
                  }
                  currentTurnText = '';
                  finishThinkingStep();

                  const rawArgs = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
                  const toolName = event.toolName || 'tool';
                  const meta = resolveToolMeta({ toolName, args: event.args, rawArgs });
                  if (!botMessage.toolCalls) botMessage.toolCalls = [];
                  const existingTool = botMessage.toolCalls.find(t => t.toolName === event.toolName && t.query === rawArgs);
                  if (!existingTool) {
                    botMessage.toolCalls.push({
                      id: event.requestId || createLocalId('tool'),
                      toolName,
                      category: meta.category,
                      description: meta.description,
                      target: meta.target,
                      command: meta.command,
                      query: rawArgs,
                      status: 'calling',
                      order: timelineSeq++,
                      timestamp: Date.now()
                    });
                  }
                  onProgress({ ...botMessage });
                  break;
                }

                case 'TOOL_COMPLETED': {
                  botMessage.isExploring = false;
                  if (!botMessage.toolCalls) botMessage.toolCalls = [];
                  const rawArgs = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
                  const resultStr = toText(event.output);

                  let targetTool = event.requestId
                    ? botMessage.toolCalls.find(t => t.id === event.requestId)
                    : undefined;
                  if (!targetTool) {
                    targetTool = botMessage.toolCalls.find(t => t.toolName === event.toolName && t.query === rawArgs && t.status === 'calling');
                  }
                  if (!targetTool) {
                    targetTool = botMessage.toolCalls.slice().reverse().find(t => t.toolName === event.toolName && t.status === 'calling');
                  }

                  const completedStatus = resolveToolExecutionStatus(event.resultStatus);
                  if (targetTool) {
                    targetTool.result = resultStr;
                    targetTool.status = completedStatus;
                    if (isEditFileTool(targetTool.toolName) || event.toolName === 'edit_file') {
                      const diff = parseToolDiffFromResult(resultStr, `toolCall ${targetTool.id}`);
                      if (diff.plusLines !== null) targetTool.plusLines = diff.plusLines;
                      if (diff.minusLines !== null) targetTool.minusLines = diff.minusLines;
                    }
                  } else {
                    let plusLines: number | undefined;
                    let minusLines: number | undefined;
                    if (isEditFileTool(event.toolName)) {
                      const diff = parseToolDiffFromResult(resultStr, `toolCall ${event.requestId || event.toolName || 'unknown'}`);
                      plusLines = diff.plusLines ?? undefined;
                      minusLines = diff.minusLines ?? undefined;
                    }
                    botMessage.toolCalls.push({
                      id: event.requestId || createLocalId('tool'),
                      toolName: event.toolName || 'tool',
                      category: resolveToolCategory(event.toolName),
                      description: event.toolName || '',
                      query: rawArgs,
                      result: resultStr,
                      status: completedStatus,
                      plusLines,
                      minusLines,
                      order: timelineSeq++,
                      timestamp: Date.now()
                    });
                  }
                  onProgress({ ...botMessage });
                  break;
                }

                case 'PARTIAL_TEXT': {
                  botMessage.isExploring = false;
                  finishThinkingStep();
                  if (event.content) {
                    currentTurnText += event.content;
                    botMessage.content = currentTurnText;
                  }
                  onProgress({ ...botMessage });
                  break;
                }

                case 'CARD_PENDING': {
                  // 单值事件只做通知：拉取 tool_call 权威数据 → 构建统一 promptCard（与历史同形状）
                  const cardToolCallId = event.toolCallId != null ? String(event.toolCallId) : '';
                  if (cardToolCallId) {
                    void attachPromptCard(cardToolCallId, botMessage, onProgress);
                  }
                  break;
                }

                case 'AI_MESSAGE': {
                  if ((!botMessage.thoughtSteps || botMessage.thoughtSteps.length === 0) && event.thinking) {
                    botMessage.thoughtSteps = [{
                      id: createLocalId('step'),
                      title: 'Thought for',
                      content: event.thinking,
                      status: 'success',
                      durationMs: 0,
                      order: timelineSeq++,
                      timestamp: Date.now()
                    }];
                  }
                  const messageText = typeof event.text === 'string' ? event.text : '';
                  if (messageText) {
                    currentTurnText = messageText;
                    botMessage.content = messageText;
                  }
                  appendAiMessage(botMessage, messageText, event.thinking || '');
                  botMessage.isThinking = false;
                  onProgress({ ...botMessage });
                  break;
                }

                case 'EXECUTION_FAILED': {
                  settleComplete();
                  // 契约 §2.2：ExecutionErrorEvent 主文案恒在 errMsg（extraDes 仅作补充，不作为主文案来源）
                  const errMsg = event.errMsg?.trim() || '恢复执行异常';
                  botMessage.executionError = errMsg;
                  if (botMessage.toolCalls) {
                    botMessage.toolCalls.forEach(t => {
                      if (t.status === 'calling') {
                        t.status = 'failed';
                        if (!t.result) t.result = `[失败] ${errMsg}`;
                      }
                    });
                  }
                  onProgress({ ...botMessage });
                  break;
                }

                case 'EXECUTION_CANCELLED':
                case 'EXECUTION_COMPLETED': {
                  const tokenInfo = event.tokenInfo;
                  if (tokenInfo) {
                    botMessage.tokenInfo = {
                      inputTokenCount: tokenInfo.inputTokenCount,
                      outputTokenCount: tokenInfo.outputTokenCount,
                      totalTokenCount: tokenInfo.totalTokenCount
                    };
                    if (tokenInfo.totalTokenCount !== undefined && tokenInfo.totalTokenCount !== null) {
                      botMessage.tokens = tokenInfo.totalTokenCount;
                    }
                  }
                  if (event.type === 'EXECUTION_CANCELLED' && botMessage.toolCalls) {
                    botMessage.toolCalls.forEach(t => {
                      if (t.status === 'calling') {
                        t.status = 'failed';
                        if (!t.result) t.result = '[已取消]';
                      }
                    });
                  }
                  settleComplete();
                  onProgress({ ...botMessage });
                  break;
                }

                default: {
                  // 只打印事件类型与字段名列表，避免把工具 args/output 等完整载荷写入日志
                  console.warn('[decideToolCall] 收到未处理的事件类型:', event.type, Object.keys(event));
                  break;
                }
              }
            },
            signal
          );

          // 流读取完毕（终态事件或服务端关流）：若从未建立过流（如空响应），按失败处理
          if (!streamEstablished) {
            reject(new Error('审批请求未返回事件流'));
            return;
          }
          settleComplete();
          onProgress({ ...botMessage });
          onFinish?.();
        } catch (err: any) {
          if (!streamEstablished) {
            // 建流前的校验失败（互动/执行不存在等）：如实抛给调用方展示
            reject(err);
            return;
          }
          if ((err instanceof DOMException && err.name === 'AbortError') || signal?.aborted) {
            settleComplete();
            onProgress({ ...botMessage });
            return;
          }
          // 流中途异常：把气泡置为失败态，不再向上抛（决策已落库，不能让卡片回退到待审）
          botMessage.executionError = extractErrorMessage(err?.message || err) || '恢复执行流中断';
          settleComplete();
          onProgress({ ...botMessage });
          onFinish?.();
        }
      })();
    });
  }

  async sendMessageStream(
    sessionId: string | number | null, 
    content: string, 
    onProgress: (msg: ChatMessage) => void,
    workspaceId?: number | string | null,
    workDir?: string | null,
    modelId?: number | string | null,
    modelName?: string,
    onSessionCreated?: (sessionId: string) => void,
    requirePlan?: boolean,
    signal?: AbortSignal,
    onFinish?: () => void,
    /** 当前选中的团队：仅用于新建会话时的首次绑定；已有会话的团队换绑走 SessionAPI.bindTeam */
    teamId?: number | string | null,
    routeSessionEvent?: (event: AgentStreamEvent) => boolean,
    /** 单 Agent 直聊的 Agent ID */
    agentId?: number | string | null,
    imageFile?: File | null
  ): Promise<void> {
    const streamStartTime = Date.now();
    const botMsgId = createLocalId('msg-bot');
    const botMessage: ChatMessage = {
      id: botMsgId,
      role: 'assistant',
      model: modelName || 'AI',
      content: '',
      timestamp: streamStartTime,
      isThinking: true,
      isExploring: true,
      isComplete: false,
      thoughtSteps: [],
      toolCalls: [],
      aiMessages: []
    };

    onProgress({ ...botMessage });

    let thinkingStartTime = 0;
    let currentThinkingStep: ThoughtStep | null = null;
    let sessionIdNotified = false;
    let currentTurnText = '';
    let timelineSeq = 0;

    const finalizeLastAiMessage = () => {
      const lastAiMsg = botMessage.aiMessages?.length
        ? botMessage.aiMessages[botMessage.aiMessages.length - 1]
        : null;
      if (lastAiMsg && lastAiMsg.text !== undefined && lastAiMsg.text !== null && lastAiMsg.text !== '') {
        botMessage.content = lastAiMsg.text;
      } else if (currentTurnText) {
        botMessage.content = currentTurnText;
      }
    };

    // 若当前会话尚未入库（新会话），在发送 chat 请求之前，先请求 session 模块的 create 接口新建 session 会话
    let realSessionId = toServerSessionId(sessionId);
    if (!realSessionId) {
      try {
        // 新建会话是唯一能带上团队绑定的时机（之后换绑走 SessionAPI.bindTeam）。
        const createdId = await this.createSession(content, workspaceId, teamId);
        realSessionId = createdId;
        sessionIdNotified = true;
        onSessionCreated?.(String(createdId));
      } catch (createErr) {
        console.error('[sendMessageStream] 自动创建会话失败:', createErr);
        throw createErr;
      }
    }
    // 请求自身已携带真实会话 ID 时，SSE 下发的 sessionId 一律不采纳：
    // REST 返回的 ID 是字符串（精度安全），而 SSE 事件曾以 JSON 数字下发雪花 ID，
    // JS 解析即丢精度；采纳会把会话绑定到错误 ID 上，后续请求全部落空，
    // 表现为「空对话仍旧按上次的失真 sessionId 发请求」。
    const sentRealSessionId = !sessionIdNotified && realSessionId != null ? String(realSessionId) : null;

    try {
      await AgentAPI.chatStream(
        realSessionId,
        content,
        (event: AgentStreamEvent) => {
          // 1. 仅当本次请求没有携带真实会话 ID 时，才采纳后端 SSE 推送的 sessionId。
          //    契约 §2：sessionId 恒为信封顶层字段（后端刻意写成字符串，避免雪花 ID 数字丢精度），
          //    禁止读 event.data?.sessionId 兜底。
          const incomingSessionId = event.sessionId;
          if (incomingSessionId !== undefined && incomingSessionId !== null
              && !sessionIdNotified && !sentRealSessionId) {
            sessionIdNotified = true;
            onSessionCreated?.(String(incomingSessionId));
          }

          // 会话映射事件和子会话运行时事件由视图层按 sessionId 独立消费。
          if (routeSessionEvent?.(event)) {
            return;
          }

          // 核心机制：遇到下一个非 PARTIAL_THINKING 事件即视为当前 thinking 结束，下一次监听到 PARTIAL_THINKING 时另起新步骤
          if (event.type !== 'PARTIAL_THINKING' && currentThinkingStep) {
            if (currentThinkingStep.status === 'running') {
              currentThinkingStep.status = 'success';
              currentThinkingStep.durationMs = Math.max(Date.now() - thinkingStartTime, 1);
            }
            currentThinkingStep = null;
            botMessage.isThinking = false;
          }

          // 2. 分事件类型精准消费
          switch (event.type) {
            case 'EXECUTION_STARTED': {
              botMessage.isThinking = true;
              botMessage.isExploring = true;
              onProgress({ ...botMessage });
              break;
            }

            case 'PARTIAL_THINKING': {
              botMessage.isThinking = true;
              // 每次监听到 partialThinking（且当前无活跃 thinking 步骤）时，另起一个 thinking 消息在列表底部
              if (!currentThinkingStep) {
                thinkingStartTime = Date.now();
                currentThinkingStep = {
                  id: createLocalId('step'),
                  title: 'Thought for',
                  content: '',
                  status: 'running',
                  durationMs: 0,
                  order: timelineSeq++,
                  timestamp: Date.now()
                };
                if (!botMessage.thoughtSteps) botMessage.thoughtSteps = [];
                botMessage.thoughtSteps.push(currentThinkingStep);
              }
              if (event.content) {
                currentThinkingStep.content += event.content;
              }
              currentThinkingStep.durationMs = Math.max(Date.now() - thinkingStartTime, 1);
              onProgress({ ...botMessage });
              break;
            }

            case 'TOOL_CALL': {
              botMessage.isExploring = false; // 接收到首个工具调用事件，结束探索状态
              // 如果在工具调用前有中间文本（例如模型的中间说明），保存为中间 AI 消息，以便按时序在折叠区展示
              if (currentTurnText && currentTurnText.trim()) {
                if (!botMessage.aiMessages) botMessage.aiMessages = [];
                const existing = botMessage.aiMessages.find(m => m.text === currentTurnText);
                if (!existing) {
                  botMessage.aiMessages.push({
                    id: createLocalId('aimsg-turn'),
                    text: currentTurnText,
                    timestamp: Date.now(),
                    order: timelineSeq++
                  });
                }
              }
              currentTurnText = ''; // 启动工具调用，重置当前轮次文本流缓冲区
              if (currentThinkingStep && currentThinkingStep.status === 'running') {
                currentThinkingStep.status = 'success';
                currentThinkingStep.durationMs = Date.now() - thinkingStartTime;
                currentThinkingStep = null;
              }
              const rawArgs = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
              const toolName = event.toolName || 'tool';

              // 分类与展示元数据统一由 toolMeta 解析（不再按工具名子串猜测）
              const meta = resolveToolMeta({ toolName, args: event.args, rawArgs });
              const subAgentParams = isSubAgentTool(toolName, meta.category)
                ? extractSubAgentParams({ args: event.args, query: rawArgs })
                : {};

              if (!botMessage.toolCalls) botMessage.toolCalls = [];
              // 匹配策略与 TOOL_COMPLETED 同源：先按 requestId 精确匹配（同名同参并发调用不串位），
              // 未命中再按名称+参数降级；requestId 命中后绝不因名称/参数不同而新建第二条。
              const byRequestId = event.requestId
                ? botMessage.toolCalls.find(t => t.id === event.requestId)
                : undefined;
              const existing = byRequestId
                || botMessage.toolCalls.find(t => t.toolName === event.toolName && t.query === rawArgs);
              if (!existing) {
                const out = event.output;
                botMessage.toolCalls.push({
                  id: event.requestId || createLocalId('tool'),
                  toolName,
                  category: meta.category,
                  description: meta.description,
                  target: meta.target,
                  command: meta.command,
                  subAgentId: subAgentParams.agentId,
                  subTask: subAgentParams.task,
                  subPrompt: subAgentParams.prompt,
                  workDir: extractDirName(workDir) || undefined,
                  query: rawArgs,
                  result: out === undefined || out === null ? undefined : toText(out),
                  status: 'calling',
                  order: timelineSeq++,
                  timestamp: Date.now()
                });
              } else if (event.output) {
                existing.result = toText(event.output);
                existing.status = 'success';
              }
              onProgress({ ...botMessage });
              break;
            }

            case 'TOOL_COMPLETED': {
              botMessage.isExploring = false;
              if (!botMessage.toolCalls) botMessage.toolCalls = [];
              const rawArgs = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
              const out = event.output;
              const resultStr = toText(out);

              // 优先按工具名和参数匹配，或匹配最后一个处于 calling 状态的同名工具
              let targetTool = event.requestId
                ? botMessage.toolCalls.find(t => t.id === event.requestId)
                : undefined;
              if (!targetTool) {
                targetTool = botMessage.toolCalls.find(t => t.toolName === event.toolName && t.query === rawArgs && t.status === 'calling');
              }
              if (!targetTool) {
                targetTool = botMessage.toolCalls.slice().reverse().find(t => t.toolName === event.toolName && t.status === 'calling');
              }
              if (!targetTool && botMessage.toolCalls.length > 0) {
                targetTool = botMessage.toolCalls.slice().reverse().find(t => t.status === 'calling');
              }

              const completedStatus = resolveToolExecutionStatus(event.resultStatus);
              if (targetTool) {
                targetTool.result = resultStr;
                targetTool.status = completedStatus;
                if (isEditFileTool(targetTool.toolName) || event.toolName === 'edit_file') {
                  const diff = parseToolDiffFromResult(resultStr, `toolCall ${targetTool.id}`);
                  if (diff.plusLines !== null) targetTool.plusLines = diff.plusLines;
                  if (diff.minusLines !== null) targetTool.minusLines = diff.minusLines;
                }
                if (isSubAgentTool(targetTool.toolName, targetTool.category)) {
                  targetTool.category = TOOL_CATEGORY.SUB_AGENT;
                }
              } else {
                let plusLines: number | undefined;
                let minusLines: number | undefined;
                if (isEditFileTool(event.toolName)) {
                  const diff = parseToolDiffFromResult(resultStr, `toolCall ${event.requestId || event.toolName || 'unknown'}`);
                  plusLines = diff.plusLines ?? undefined;
                  minusLines = diff.minusLines ?? undefined;
                }
                botMessage.toolCalls.push({
                  id: event.requestId || createLocalId('tool'),
                  toolName: event.toolName || 'tool',
                  category: resolveToolCategory(event.toolName),
                  description: event.toolName || '',
                  workDir: extractDirName(workDir) || undefined,
                  query: rawArgs,
                  result: resultStr,
                  status: completedStatus,
                  plusLines,
                  minusLines,
                  order: timelineSeq++,
                  timestamp: Date.now()
                });
              }

              onProgress({ ...botMessage });
              break;
            }

            case 'FILE_EDIT': {
              botMessage.isExploring = false;
              if (!botMessage.fileEdits) botMessage.fileEdits = [];
              botMessage.fileEdits.push({
                turnId: event.turnId,
                recordId: event.recordId,
                filePath: event.filePath || '',
                oldContent: event.oldContent,
                newContent: event.newContent,
                plusLines: event.plusLines,
                minusLines: event.minusLines
              });

              // 优先关联已存在的 edit_file 工具调用条目
              const fileTarget = event.filePath || '未命名文件';
              const existingEditTool = botMessage.toolCalls?.find(t =>
                (isEditFileTool(t.toolName) || t.toolName === 'edit_file') &&
                (!t.target || t.target === fileTarget)
              );

              if (existingEditTool) {
                existingEditTool.plusLines = event.plusLines;
                existingEditTool.minusLines = event.minusLines;
                if (!existingEditTool.target) existingEditTool.target = fileTarget;
              } else {
                if (!botMessage.toolCalls) botMessage.toolCalls = [];
                const diffDesc = (event.plusLines !== undefined || event.minusLines !== undefined)
                  ? `+${event.plusLines ?? 0} -${event.minusLines ?? 0}`
                  : '文件修改';
                botMessage.toolCalls.push({
                  id: createLocalId('edit'),
                  toolName: 'edit_file',
                  category: TOOL_CATEGORY.WRITE,
                  target: fileTarget,
                  description: fileTarget,
                  command: `edit ${fileTarget}`,
                  workDir: extractDirName(workDir) || undefined,
                  result: event.newContent || event.oldContent || `[文件修改] ${diffDesc}`,
                  plusLines: event.plusLines,
                  minusLines: event.minusLines,
                  status: 'success',
                  order: timelineSeq++,
                  timestamp: Date.now()
                });
              }
              onProgress({ ...botMessage });
              break;
            }

            case 'CONTEXT_UPDATE': {
              // 契约 §2.2：phase ∈ {UPDATE, SQUEEZE_STARTED, SQUEEZE_COMPLETED}。
              // 未知 phase 不再伪装成 'UPDATE' —— 记录告警并忽略，避免污染上下文用量展示。
              const phase = event.phase;
              if (phase === 'SQUEEZE_STARTED') {
                botMessage.isCompressingContext = true;
                botMessage.contextUsage = {
                  phase: 'SQUEEZE_STARTED',
                  tokenCount: event.usage?.tokenCount,
                  maxTokens: event.usage?.maxTokens,
                  ratio: event.usage?.ratio,
                  message: event.message || '正在压缩上下文'
                };
                onProgress({ ...botMessage });
              } else if (phase === 'SQUEEZE_COMPLETED') {
                botMessage.isCompressingContext = false;
                if (botMessage.contextUsage) {
                  botMessage.contextUsage.phase = 'SQUEEZE_COMPLETED';
                  botMessage.contextUsage.tokenCount = event.usage?.tokenCount;
                  botMessage.contextUsage.maxTokens = event.usage?.maxTokens;
                  botMessage.contextUsage.ratio = event.usage?.ratio;
                  botMessage.contextUsage.message = undefined;
                }
                onProgress({ ...botMessage });
              } else if (phase === 'UPDATE') {
                if (!botMessage.contextUsage) botMessage.contextUsage = {};
                botMessage.contextUsage.phase = 'UPDATE';
                if (event.usage?.tokenCount !== undefined) botMessage.contextUsage.tokenCount = event.usage.tokenCount;
                if (event.usage?.maxTokens !== undefined) botMessage.contextUsage.maxTokens = event.usage.maxTokens;
                if (event.usage?.ratio !== undefined) botMessage.contextUsage.ratio = event.usage.ratio;
                onProgress({ ...botMessage });
              } else {
                console.warn('[sendMessageStream] CONTEXT_UPDATE 收到未知 phase，已忽略:', phase);
              }
              break;
            }

            case 'PARTIAL_TEXT': {
              botMessage.isExploring = false;
              if (currentThinkingStep && currentThinkingStep.status === 'running') {
                currentThinkingStep.status = 'success';
                currentThinkingStep.durationMs = Date.now() - thinkingStartTime;
                currentThinkingStep = null;
              }
              botMessage.isThinking = false;
              if (event.content) {
                currentTurnText += event.content;
                botMessage.content = currentTurnText;
              }
              onProgress({ ...botMessage });
              break;
            }

            case 'CARD_PENDING': {
              // 单值事件只做通知：拉取 tool_call 权威数据 → 构建统一 promptCard（与历史同形状）
              if (currentThinkingStep && currentThinkingStep.status === 'running') {
                currentThinkingStep.status = 'success';
                currentThinkingStep.durationMs = Date.now() - thinkingStartTime;
                currentThinkingStep = null;
              }
              botMessage.isThinking = false;
              const cardToolCallId = event.toolCallId != null ? String(event.toolCallId) : '';
              if (cardToolCallId) {
                void attachPromptCard(cardToolCallId, botMessage, onProgress);
              }
              break;
            }

            case 'AI_MESSAGE': {
              // 1. 处理思维链 thinking 内容：
              // 流式过程已由 PARTIAL_THINKING 独立追加步骤，此处绝不重复创建；
              // 仅当从未收到过任何 PARTIAL_THINKING（如非流式调用）且 event.thinking 存在时，才补入单条兜底。
              if ((!botMessage.thoughtSteps || botMessage.thoughtSteps.length === 0) && event.thinking) {
                botMessage.thoughtSteps = [{
                  id: createLocalId('step'),
                  title: 'Thought for',
                  content: event.thinking,
                  status: 'success',
                  durationMs: 0,
                  order: timelineSeq++,
                  timestamp: Date.now()
                }];
              }

              // 2. 处理回复正文内容 (非思考)
              // 只有本轮的 event.text 才算新正文：工具调用轮不含文本（text=null），
              // 此时沿用 currentTurnText 会把上一轮文本再记一次，造成折叠区重复展示。
              const messageText = typeof event.text === 'string' ? event.text : '';
              if (messageText) {
                currentTurnText = messageText;
                botMessage.content = messageText;
              }
              appendAiMessage(botMessage, messageText, event.thinking || '');

              botMessage.isThinking = false;
              onProgress({ ...botMessage });
              break;
            }

            case 'EXECUTION_FAILED': {
              finalizeLastAiMessage();
              botMessage.isThinking = false;
              botMessage.isExploring = false;
              botMessage.isCompressingContext = false;
              botMessage.isComplete = true;
              if (!botMessage.durationMs) {
                botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
              }
              // 契约 §2.2：ExecutionErrorEvent 主文案恒在 errMsg（extraDes 仅作补充，不作为主文案来源）
              const errMsg = event.errMsg?.trim() || '执行异常';
              botMessage.executionError = errMsg;
              // 将仍处于 calling 状态的工具标记为 failed
              if (botMessage.toolCalls) {
                botMessage.toolCalls.forEach(t => {
                  if (t.status === 'calling') {
                    t.status = 'failed';
                    if (!t.result) t.result = `[失败] ${errMsg}`;
                  }
                });
              }
              onProgress({ ...botMessage });
              onFinish?.();
              break;
            }

            case 'EXECUTION_CANCELLED': {
              finalizeLastAiMessage();
              botMessage.isThinking = false;
              botMessage.isExploring = false;
              botMessage.isCompressingContext = false;
              botMessage.isComplete = true;
              if (!botMessage.durationMs) {
                botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
              }
              if (botMessage.toolCalls) {
                botMessage.toolCalls.forEach(t => {
                  if (t.status === 'calling') {
                    t.status = 'failed';
                    if (!t.result) t.result = '[已取消]';
                  }
                });
              }
              onProgress({ ...botMessage });
              onFinish?.();
              break;
            }

            case 'EXECUTION_COMPLETED': {
              // 契约来源：ExecutionCompleteEvent.tokenInfo.{input,output,total}TokenCount。
              const tokenInfo = event.tokenInfo;
              if (tokenInfo) {
                botMessage.tokenInfo = {
                  inputTokenCount: tokenInfo.inputTokenCount,
                  outputTokenCount: tokenInfo.outputTokenCount,
                  totalTokenCount: tokenInfo.totalTokenCount
                };
                if (tokenInfo.totalTokenCount !== undefined && tokenInfo.totalTokenCount !== null) {
                  botMessage.tokens = tokenInfo.totalTokenCount;
                }
              }
              finalizeLastAiMessage();
              botMessage.isThinking = false;
              botMessage.isExploring = false;
              botMessage.isCompressingContext = false;
              botMessage.isComplete = true;
              if (!botMessage.durationMs) {
                botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
              }
              onProgress({ ...botMessage });
              onFinish?.();
              break;
            }

            default: {
              // 未知事件不再静默拼进正文：记录告警，便于后端补齐事件类型后定位。
              // 只打印事件类型与字段名列表，避免把工具 args/output 等完整载荷写入日志。
              console.warn('[sendMessageStream] 收到未处理的事件类型:', event.type, Object.keys(event));
              break;
            }
          }
        },
        workspaceId,
        workDir,
        modelId,
        requirePlan === true,
        signal,
        agentId,
        imageFile,
        undefined
      );

      // 流结束后的收尾状态与耗时结算
      const runningStep = botMessage.thoughtSteps?.find(s => s.status === 'running');
      if (runningStep) {
        runningStep.status = 'success';
        runningStep.durationMs = Date.now() - thinkingStartTime;
      }
      finalizeLastAiMessage();
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isComplete = true;
      if (!botMessage.durationMs) {
        botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
      }
      // 流正常结束但工具仍停留在 calling：若有待审批卡片则置为 pending，否则如实保留为 failed
      if (botMessage.toolCalls) {
        for (const tc of botMessage.toolCalls) {
          if (tc.status === 'calling') {
            const hasPendingCard = botMessage.promptCards?.some(c => c.toolCallId === tc.id && c.pending)
              || (botMessage.promptCard?.toolCallId === tc.id && botMessage.promptCard?.pending);
            if (hasPendingCard) {
              tc.status = 'pending';
            } else {
              tc.status = 'failed';
              if (!tc.result) tc.result = '[无结果] 后端未返回该工具的执行结果';
            }
          }
        }
      }
      onProgress({ ...botMessage });
      onFinish?.();
    } catch (err: any) {
      if ((err instanceof DOMException && err.name === 'AbortError') || signal?.aborted) {
        const runningStep = botMessage.thoughtSteps?.find(s => s.status === 'running');
        if (runningStep) {
          runningStep.status = 'success';
          runningStep.durationMs = Date.now() - thinkingStartTime;
        }
        finalizeLastAiMessage();
        botMessage.isThinking = false;
        botMessage.isExploring = false;
        botMessage.isComplete = true;
        if (!botMessage.durationMs) {
          botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
        }
        onProgress({ ...botMessage });
        onFinish?.();
        return;
      }
      const runningStep = botMessage.thoughtSteps?.find(s => s.status === 'running');
      if (runningStep) {
        runningStep.status = 'failed';
        runningStep.durationMs = Date.now() - thinkingStartTime;
      }
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isComplete = true;
      if (!botMessage.durationMs) {
        botMessage.durationMs = Math.max(Date.now() - streamStartTime, 1000);
      }
      const cleanErr = extractErrorMessage(err?.message || err) || '与后端 Agent 服务通信异常';
      botMessage.executionError = cleanErr;
      onProgress({ ...botMessage });
      onFinish?.();
      throw err;
    }
  }
}

export const chatStreamService = new ChatStreamService();
