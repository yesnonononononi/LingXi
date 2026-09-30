/**
 * 消息通用路由器 (messageRouter)
 *
 * 核心职责：
 * 1. resolveSession: 会话解析与父子分流，判断主会话与子会话归属。
 * 2. routeToSession: 严格按照 12 种运行时事件规范执行事件分发与状态流转，驱动 Pinia 状态更新与视图渲染。
 */

import type { AgentStreamEvent, SessionVO, ChatSession, ChatMessage } from "../../types/chat";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { createLocalId } from "../../utils/ids";
import {
  resolveToolMeta,
  resolveToolExecutionStatus,
  isEditFileTool,
  TOOL_CATEGORY
} from "../../utils/toolMeta";
import { parseToolDiffFromResult } from "../../utils/toolDiff";
import { toText } from "../../utils/json";
import { buildPromptCard } from "../../utils/session";
import { chatApi } from "../../services/chat";

export interface ResolvedSessionInfo {
  sessionId: string;
  rootSessionId: string | null;
  isSubSession: boolean;
  executionId: string;
}

/**
 * 1. resolveSession:
 * Map<sessionId:str, rootSessionId:str> 中找到对应 session
 * 若 rsid !== null && !rsid.isEmpty() && rsid !== sid === 这是子会话
 */
export const resolveSession = (
  event: AgentStreamEvent,
  fallbackSession?: SessionVO | ChatSession | null
): ResolvedSessionInfo => {
  const sessionStore = useChatSessionStore();

  // 提取当前目标 sessionId：优先从 event 提取，否则回落到当前活跃会话
  const eventSid = event.sessionId != null ? String(event.sessionId) : null;
  const fallbackSid = fallbackSession?.id != null ? String(fallbackSession.id) : null;
  const sessionId = eventSid || fallbackSid || 'default';

  // 提取 rootSessionId
  const eventRootSid = event.rootSessionId != null ? String(event.rootSessionId) : null;
  const fallbackRootSid = fallbackSession && 'rootSessionId' in fallbackSession && fallbackSession.rootSessionId != null
    ? String(fallbackSession.rootSessionId)
    : null;

  if (eventRootSid) {
    sessionStore.bindSessionRoot(sessionId, eventRootSid);
  } else if (fallbackRootSid) {
    sessionStore.bindSessionRoot(sessionId, fallbackRootSid);
  }

  const rootSessionId = sessionStore.getRootSessionId(sessionId);
  const isSubSession = sessionStore.isSubSession(sessionId);

  // 提取 executionId
  const executionId = event.executionId || sessionStore.getActiveExecutionId(sessionId);

  return {
    sessionId,
    rootSessionId,
    isSubSession,
    executionId
  };
};

/** 计算或递增时序序号 */
const getNextOrder = (msg: ChatMessage): number => {
  let max = 0;
  if (msg.thoughtSteps) {
    for (const s of msg.thoughtSteps) max = Math.max(max, s.order ?? 0);
  }
  if (msg.toolCalls) {
    for (const t of msg.toolCalls) max = Math.max(max, t.order ?? 0);
  }
  if (msg.aiMessages) {
    for (const a of msg.aiMessages) max = Math.max(max, a.order ?? 0);
  }
  return max + 1;
};

/** 结束正在运行的 thinking 步骤 */
const settleRunningThinking = (botMessage: ChatMessage, store: ReturnType<typeof useChatSessionStore>, executionId: string) => {
  if (botMessage.thoughtSteps) {
    const running = botMessage.thoughtSteps.find(s => s.status === 'running');
    if (running) {
      running.status = 'success';
      const duration = store.getTimerDuration(executionId);
      if (duration > 0 && !running.durationMs) {
        running.durationMs = duration;
      }
    }
  }
  botMessage.isThinking = false;
};

/**
 * 2. routeToSession:
 * 按照事件类型严丝合缝进行状态流转与渲染
 */
export const routeToSession = (
  event: AgentStreamEvent,
  sessionContext?: SessionVO | ChatSession | null,
  callbacks?: {
    onMessageUpdated?: (msg: ChatMessage) => void;
    onCompleted?: (msg: ChatMessage) => void;
  }
): void => {
  const sessionStore = useChatSessionStore();
  const { sessionId, isSubSession, executionId } = resolveSession(event, sessionContext);

  // 获取当前 assistant 消息体
  let botMessage = sessionStore.getLatestAssistantMessage(sessionId, executionId);

  // 实时回答组绑定 executionId：已有气泡补盖（首次可能建于 executionId 未知时），
  // 保证同一执行的实时事件始终写入同一个回答组，重连/审批恢复不会新起一组。
  // 'default'/空表示归属未知，不写（渲染层按旧数据降级，不伪造统计）。
  const realExecutionId = executionId && executionId !== 'default' ? executionId : null;
  if (botMessage && realExecutionId && botMessage.executionId !== realExecutionId) {
    botMessage.executionId = realExecutionId;
  }

  switch (event.type) {
    // 新一轮请求
    case 'EXECUTION_STARTED': {
      // 1. 当前会话列表, 新增一个 AI 消息体
      // 2. 初始化一个计时器, 记录时间
      // 3. 上一轮兜底清理干净, 避免污染
      botMessage = sessionStore.initExecution(sessionId, executionId);
      sessionStore.setSessionSending(sessionId, true);
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'PARTIAL_THINKING': {
      if (!botMessage) {
        botMessage = sessionStore.initExecution(sessionId, executionId);
      }
      botMessage.isThinking = true;

      // 1. 叠加到当前最后一个 thinking 消息中 (按 executionId or sessionId)
      // 2. 如果当前最后一轮消息不是 thinking, 则另起一个 thinking 气泡
      if (!botMessage.thoughtSteps) botMessage.thoughtSteps = [];
      let currentStep = botMessage.thoughtSteps.find(item => item.status === 'running');
      if (!currentStep) {
        currentStep = {
          id: createLocalId('step'),
          title: 'Thought for',
          content: '',
          status: 'running',
          durationMs: 0,
          order: getNextOrder(botMessage),
          timestamp: Date.now()
        };
        botMessage.thoughtSteps.push(currentStep);
      }

      const content = event.content || event.thinking || '';
      currentStep.content += content;
      currentStep.durationMs = sessionStore.getTimerDuration(sessionId, executionId);

      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'PARTIAL_TEXT': {
      if (!botMessage) {
        botMessage = sessionStore.initExecution(sessionId, executionId);
      }
      botMessage.isExploring = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      // 1. 如果当前会话最后一个消息不是 text, 另起 text 气泡 (更新正文内容)
      const textChunk = event.content || event.text || '';
      botMessage.content += textChunk;

      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'COMPLETE_TEXT': {
      if (!botMessage) return;
      botMessage.isExploring = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      const finishReason = event.meta?.finishReason;
      const textContent = (event.content || event.text || botMessage.content || '').trim();

      // 若为工具执行 (TOOL_EXECUTION)，说明该轮文本是模型调用工具前的中间解释过程，必须归档为过程文本块，绝不能在正文中持续叠加
      if (finishReason === 'TOOL_EXECUTION') {
        if (textContent) {
          if (!botMessage.aiMessages) botMessage.aiMessages = [];
          const existing = botMessage.aiMessages.find(m => m.text === textContent);
          if (!existing) {
            botMessage.aiMessages.push({
              id: createLocalId('aimsg'),
              text: textContent,
              timestamp: Date.now(),
              order: getNextOrder(botMessage)
            });
          }
        }
        // 清空当前正文，等待后续轮次或最终结论
        botMessage.content = '';
      } else {
        // 终结态（如 STOP 等）：确认为最终定稿正文
        botMessage.content = textContent;
      }

      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'AI_MESSAGE': {
      if (!botMessage) return;
      botMessage.isThinking = false;
      botMessage.isExploring = false;

      // 1. 执行中间逻辑 (不必可视化), 舍弃或作为中间文本折叠保留
      const messageText = typeof event.text === 'string' ? event.text : (typeof event.content === 'string' ? event.content : '');
      if (messageText && messageText.trim() && messageText !== botMessage.content) {
        if (!botMessage.aiMessages) botMessage.aiMessages = [];
        const existing = botMessage.aiMessages.find(m => m.text === messageText);
        if (!existing) {
          botMessage.aiMessages.push({
            id: createLocalId('aimsg'),
            text: messageText,
            thinking: event.thinking || '',
            timestamp: Date.now(),
            order: getNextOrder(botMessage)
          });
        }
      }
      // 仅在无工具调用且没有中间文本时，作为最终正文兜底
      if (!botMessage.content && messageText && (!botMessage.toolCalls || botMessage.toolCalls.length === 0)) {
        botMessage.content = messageText;
      }
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'TOOL_CALL': {
      if (!botMessage) {
        botMessage = sessionStore.initExecution(sessionId, executionId);
      }
      botMessage.isExploring = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      // 防守兜底：若工具调用发生时正文中仍有前置说明文本未被清除，自动归档并清空正文，避免与最终结论串联
      if (botMessage.content && botMessage.content.trim()) {
        const residualText = botMessage.content.trim();
        if (!botMessage.aiMessages) botMessage.aiMessages = [];
        const existing = botMessage.aiMessages.find(m => m.text === residualText);
        if (!existing) {
          botMessage.aiMessages.push({
            id: createLocalId('aimsg'),
            text: residualText,
            timestamp: Date.now(),
            order: getNextOrder(botMessage)
          });
        }
        botMessage.content = '';
      }

      // 1. 分辨 tool_call 的类型, 按类型渲染消息
      // 2. case toolType -> 展示 依次左边到右边 'loading动画' 'svgtool图标' '执行命令' '命令substring(0,10)+...'
      const rawArgs = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
      const toolName = event.toolName || 'tool';
      const meta = resolveToolMeta({ toolName, args: event.args, rawArgs });

      if (!botMessage.toolCalls) botMessage.toolCalls = [];
      const toolId = event.requestId || event.id ? String(event.requestId || event.id) : createLocalId('tool');
      const existing = botMessage.toolCalls.find(t => t.id === toolId);

      if (!existing) {
        // 命令截取展示: substring(0, 10) + '...'
        const cmd = meta.command || meta.target || meta.description || toolName;
        const shortCmd = cmd.length > 10 ? `${cmd.substring(0, 10)}...` : cmd;

        botMessage.toolCalls.push({
          id: toolId,
          toolName,
          category: meta.category,
          description: meta.description || shortCmd,
          target: meta.target,
          command: meta.command,
          query: rawArgs,
          status: 'calling', // loading 动画
          order: getNextOrder(botMessage),
          timestamp: Date.now()
        });
      }
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'TOOL_COMPLETED': {
      if (!botMessage) return;
      botMessage.isExploring = false;

      // 1. 按 `tool_call_id` or `message_id` 查 `tool_call`, 将 `loading动画` 去掉, 表示已完成
      if (!botMessage.toolCalls) botMessage.toolCalls = [];
      const toolId = event.requestId || event.id ? String(event.requestId || event.id) : undefined;
      const targetTool = toolId
        ? botMessage.toolCalls.find(t => t.id === toolId)
        : [...botMessage.toolCalls].reverse().find(t => t.status === 'calling');

      const completedStatus = resolveToolExecutionStatus(event.resultStatus);
      const resultStr = toText(event.output ?? event.result);

      if (targetTool) {
        targetTool.result = resultStr;
        targetTool.status = completedStatus; // 移除 loading 动画
        if (isEditFileTool(targetTool.toolName) || event.toolName === 'edit_file') {
          const diff = parseToolDiffFromResult(resultStr, `toolCall ${targetTool.id}`);
          if (diff.plusLines !== null) targetTool.plusLines = diff.plusLines;
          if (diff.minusLines !== null) targetTool.minusLines = diff.minusLines;
        }
      } else {
        botMessage.toolCalls.push({
          id: toolId || createLocalId('tool'),
          toolName: event.toolName || 'tool',
          category: resolveToolMeta({ toolName: event.toolName || '' }).category,
          status: completedStatus,
          result: resultStr,
          order: getNextOrder(botMessage),
          timestamp: Date.now()
        });
      }
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'FILE_EDIT': {
      if (!botMessage) {
        botMessage = sessionStore.initExecution(sessionId, executionId);
      }
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

      // 1. 按 `tool_call_id` or `message_id` 查 `tool_call`, 没查到, 兜底添加一条消息
      // 2. 展示效果从左到右: 'svg图标' '编辑文件' '文件名' 'diff such as: +1 -12'
      const filePath = event.filePath || '文件';
      let editTool = botMessage.toolCalls?.find(t =>
        isEditFileTool(t.toolName) && (!t.target || t.target === filePath)
      );

      if (editTool) {
        editTool.plusLines = event.plusLines;
        editTool.minusLines = event.minusLines;
        editTool.status = 'success';
      } else {
        if (!botMessage.toolCalls) botMessage.toolCalls = [];
        const diffText = (event.plusLines != null || event.minusLines != null)
          ? `+${event.plusLines ?? 0} -${event.minusLines ?? 0}`
          : '文件修改';

        botMessage.toolCalls.push({
          id: createLocalId('edit'),
          toolName: 'edit_file',
          category: TOOL_CATEGORY.WRITE,
          target: filePath,
          description: `编辑文件 ${filePath} (${diffText})`,
          command: `edit ${filePath}`,
          result: event.newContent || `[文件修改完成] ${diffText}`,
          plusLines: event.plusLines,
          minusLines: event.minusLines,
          status: 'success',
          order: getNextOrder(botMessage),
          timestamp: Date.now()
        });
      }
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'CARD_PENDING': {
      if (!botMessage) {
        botMessage = sessionStore.initExecution(sessionId, executionId);
      }
      settleRunningThinking(botMessage, sessionStore, executionId);
      botMessage.isThinking = false;

      // 1. 按卡片类型 switch 新增卡片消息在列表底部, 等待选择, 内容根据 case 进行 JSON.parse() 或 fetchToolCall 权威拉取
      const toolCallId = event.toolCallId ? String(event.toolCallId) : '';
      if (toolCallId) {
        void (async () => {
          try {
            const vo = await chatApi.fetchToolCall(toolCallId);
            const card = buildPromptCard(vo);
            if (card && botMessage) {
              if (!botMessage.promptCards) botMessage.promptCards = [];
              const idx = botMessage.promptCards.findIndex(c => c.toolCallId === card.toolCallId);
              if (idx >= 0) botMessage.promptCards[idx] = card;
              else botMessage.promptCards.push(card);
              botMessage.promptCard = card;
              callbacks?.onMessageUpdated?.({ ...botMessage });
            }
          } catch (err) {
            console.warn('[messageRouter] 拉取 CARD_PENDING 卡片详情失败:', err);
          }
        })();
      }
      break;
    }

    case 'CONTEXT_UPDATE': {
      if (!botMessage) return;
      // 1. 新增一条样式形如: '------- loading 图标 / 完成图标 上下文压缩中/ 压缩完成 ---------'
      const phase = event.phase;
      if (phase === 'SQUEEZE_STARTED') {
        botMessage.isCompressingContext = true;
      } else if (phase === 'SQUEEZE_COMPLETED') {
        botMessage.isCompressingContext = false;
      }
      botMessage.contextUsage = {
        phase: phase || 'UPDATE',
        tokenCount: event.usage?.tokenCount,
        maxTokens: event.usage?.maxTokens,
        ratio: event.usage?.ratio,
        message: event.message || (phase === 'SQUEEZE_STARTED' ? '正在压缩上下文' : '上下文已压缩')
      };
      sessionStore.setContextUsage(sessionId, botMessage.contextUsage);
      callbacks?.onMessageUpdated?.({ ...botMessage });
      break;
    }

    case 'EXECUTION_COMPLETED': {
      if (!botMessage) return;
      // 1. 关闭计时器, 展示整个消息流的底部元信息如 'svg复制图标' '点赞' 'token用量' '用时'
      const totalDuration = sessionStore.stopTimer(sessionId, executionId);
      botMessage.durationMs = totalDuration > 0 ? totalDuration : Math.max(1000, botMessage.durationMs || 0);

      const tokenInfo = event.tokenInfo;
      if (tokenInfo) {
        botMessage.tokenInfo = {
          inputTokenCount: tokenInfo.inputTokenCount,
          outputTokenCount: tokenInfo.outputTokenCount,
          totalTokenCount: tokenInfo.totalTokenCount
        };
        botMessage.tokens = tokenInfo.totalTokenCount;
      }

      botMessage.isComplete = true;
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isCompressingContext = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      // 2. 如果是子会话, 标识状态为已完成
      if (isSubSession) {
        sessionStore.setSessionRunStatus(sessionId, 'IDLE', 'COMPLETED');
      } else {
        sessionStore.setSessionRunStatus(sessionId, 'IDLE', 'COMPLETED');
      }
      sessionStore.setSessionSending(sessionId, false);

      // 3. 其它清理逻辑
      callbacks?.onMessageUpdated?.({ ...botMessage });
      callbacks?.onCompleted?.({ ...botMessage });
      break;
    }

    case 'EXECUTION_FAILED': {
      if (!botMessage) return;
      // 1. 增加一行消息, 红色字体标识 消息原因 || '执行发生错误'
      const errMsg = event.errMsg?.trim() || event.error?.trim() || '执行发生错误';
      botMessage.executionError = errMsg;

      // 标记未完成工具为 failed
      if (botMessage.toolCalls) {
        botMessage.toolCalls.forEach(t => {
          if (t.status === 'calling') {
            t.status = 'failed';
            if (!t.result) t.result = `[失败] ${errMsg}`;
          }
        });
      }

      // 2. 剩余逻辑参考 EXECUTION_COMPLETED
      const totalDuration = sessionStore.stopTimer(sessionId, executionId);
      botMessage.durationMs = totalDuration > 0 ? totalDuration : Math.max(1000, botMessage.durationMs || 0);
      botMessage.isComplete = true;
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isCompressingContext = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      sessionStore.setSessionRunStatus(sessionId, 'IDLE', 'FAILED');
      sessionStore.setSessionSending(sessionId, false);

      callbacks?.onMessageUpdated?.({ ...botMessage });
      callbacks?.onCompleted?.({ ...botMessage });
      break;
    }

    case 'EXECUTION_CANCELLED': {
      if (!botMessage) return;
      // 1. 改变输入框发送按钮的样式为 红色暂停按钮 -> 待发送按钮
      sessionStore.setSessionSending(sessionId, false);

      // 标记未完成工具为已取消
      if (botMessage.toolCalls) {
        botMessage.toolCalls.forEach(t => {
          if (t.status === 'calling') {
            t.status = 'failed';
            if (!t.result) t.result = '[已取消]';
          }
        });
      }

      // 2. 剩余逻辑参考 EXECUTION_COMPLETED
      const totalDuration = sessionStore.stopTimer(sessionId, executionId);
      botMessage.durationMs = totalDuration > 0 ? totalDuration : Math.max(1000, botMessage.durationMs || 0);
      botMessage.isComplete = true;
      botMessage.isThinking = false;
      botMessage.isExploring = false;
      botMessage.isCompressingContext = false;
      settleRunningThinking(botMessage, sessionStore, executionId);

      sessionStore.setSessionRunStatus(sessionId, 'IDLE', 'CANCELLED');

      callbacks?.onMessageUpdated?.({ ...botMessage });
      callbacks?.onCompleted?.({ ...botMessage });
      break;
    }

    case 'TERMINAL_TOOL_CALL': {
        //1, 解析tool_call的`intention`字段
        //2, 渲染样式: 'svg图标' 'intention',loading结束的标志是{@link TOOL_COMPLETED},按`tool_call_id`寻找终端命令,然后结束loading
        // loading样式参考{@link FILE_EDIT}
        // 该事件不在后端 RuntimeEventType 中（占位分支，暂无实现），显式 break 以消除 case 穿透告警。
        break;
    }

    default: {
      console.warn('[messageRouter] 未知事件类型:', event.type);
      break;
    }
  }
};