import { ModelAPI } from './model';
import { WorkspaceAPI } from './workspace';
import { UserConfigAPI } from './userConfig';
import { SessionAPI } from './session';
import { AgentAPI } from './agent';
import { TeamAPI } from './team';
import { ToolCallAPI } from './toolCall';
import { ApiError, classifyResult } from './interceptor';
import { buildPromptCard, parseSessionMessages } from '../utils/session';
import { extractErrorMessage } from '../utils/error';
import { isOk } from '../utils/api';
import { createLocalId, createTempSessionId, toServerSessionId } from '../utils/ids';
import { extractDirName } from '../utils/path';
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
import { parseTimestampOr } from '../utils/time';
import type { 
  ChatSession, 
  ModelConfig, 
  ChatMessage, 
  SessionVO, 
  WorkspaceVO, 
  WorkspaceRequest, 
  AgentStreamEvent,
  ThoughtStep,
  UserConfigVO,
  TeamVO,
  SubSessionVO,
  AgentVO,
  ToolCallVO,
  PromptCardData
} from '../types/chat';

/**
 * fetch* 的判别结果：让调用方能区分「加载失败（可重试）」与「确实为空」。
 *
 * 背景（contract §7）：后端宕机 / 403 / 404 / 500 等此前被 `catch → return []/null` 吞成空数据，
 * 与「本来就没有数据」不可区分，还会把 403 当空数据而掩盖安全事件。现改为显式区分。
 */
export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** 把加载失败统一转为产品化文案（不直接暴露后端原始 errMsg）。 */
function describeFetchFailure(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'forbidden':
        return '无权限访问该资源';
      case 'notFound':
        return '请求的资源不存在';
      case 'server':
        return '服务端异常，请稍后重试';
      case 'network':
        return '无法连接后端服务，请确认服务已启动';
      default:
        return '加载失败，请稍后重试';
    }
  }
  return '加载失败，请稍后重试';
}

/**
 * 拉取失败时使用的「不可用」卡片：复用 PromptCard 既有的 `unavailable` 降级渲染，
 * 让用户看到「卡片状态不可用」而不是空等（无需新增消息字段）。
 */
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

/** 7. 统一 chatApi 导出，供 UI 层直接调用 */
export const chatApi = {
  async stopGeneration(sessionId: string | number): Promise<void> {
    await AgentAPI.stop(sessionId);
  },

  /**
   * 提交工具调用决策结论并消费恢复执行的事件流。
   *
   * 批准/否决/作答后后端恢复被暂停的执行，期间的全部运行时事件（思考、流式正文、工具调用、终态、
   * 新的 pending 卡片通知）以本方法创建的 assistant 气泡为载体经 onProgress 实时渲染——契约与
   * sendMessageStream 一致。
   *
   * 返回值语义：true = 决策已落库且事件流已建立（此后流在后台继续消费直至执行终态）；
   * false 不会出现——校验失败直接抛错（tool_call/执行不存在、归属不符等），由调用方展示错误。
   * 本方法只在流建立时 resolve，不等执行完成，调用方可立即更新卡片状态。
   *
   * onFinish：恢复执行流到达终态（正常结束或中途异常，abort 除外）时回调一次，
   * 供调用方做消息级权威对账；abort 场景（用户主动停止/切换会话）不回调。
   *
   * @param conversationId 归属会话 id（= session.id），后端据以校验归属并解析根会话订阅 SSE
   * @param toolCallId     决策锚点（tool_call.id / 模型 call_id）
   */
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
                  const messageText = event.text ?? currentTurnText;
                  if (messageText !== undefined && messageText !== null) {
                    currentTurnText = messageText;
                    botMessage.content = messageText;
                  }
                  if (!botMessage.aiMessages) botMessage.aiMessages = [];
                  botMessage.aiMessages.push({
                    id: createLocalId('aimsg'),
                    text: messageText || '',
                    thinking: event.thinking || '',
                    timestamp: Date.now(),
                    order: timelineSeq++
                  });
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
  },

  /**
   * 按 toolCallId 拉取聚合工具调用（CARD_PENDING 通知后取卡片权威数据）。
   * 供 ChatView 的根会话/子会话事件分支使用。
   */
  async fetchToolCall(toolCallId: string): Promise<ToolCallVO | null> {
    return ToolCallAPI.find(toolCallId);
  },

  async suspendGeneration(sessionId: string | number): Promise<void> {
    await AgentAPI.suspend(sessionId);
  },

  async resumeGeneration(sessionId: string | number): Promise<string> {
    const res = await AgentAPI.resume(sessionId);
    if (!isOk(res.code)) {
      throw new Error(res.errMsg || '恢复执行失败');
    }
    return res.data ?? '';
  },

  /**
   * 调用 session 模块的 create 接口新建会话
   * 对应后端 POST /session/create
   */
  async createSession(
    name: string,
    workspaceId?: string | number | null
  ): Promise<string> {
    const trimmedName = name.trim() || '新对话';
    const res = await SessionAPI.create({
      name: trimmedName,
      workspaceId,
    });
    if (!isOk(res.code) || res.data === undefined || res.data === null) {
      throw new Error(res.errMsg || '创建会话失败');
    }
    return String(res.data);
  },

  /** 分页获取 Team 列表 */
  async fetchTeams(page = 1, pageSize = 50): Promise<FetchResult<TeamVO[]>> {
    try {
      const res = await TeamAPI.list(page, pageSize);
      if (isOk(res.code)) {
        return { ok: true, data: res.data?.records ?? [] };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error('Failed to fetch teams from server:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },
  /** 取当前登录用户的通用配置（含选中的 modelId）；保持数组返回以兼容调用方。 */
  async fetchUserConfigs(): Promise<FetchResult<UserConfigVO[]>> {
    try {
      const res = await UserConfigAPI.current();
      if (isOk(res.code)) {
        return { ok: true, data: res.data ? [res.data] : [] };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error('Failed to fetch current common config:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },
  async fetchModels(): Promise<FetchResult<ModelConfig[]>> {
    try {
      const res = await ModelAPI.list(1, 100);
      if (isOk(res.code)) {
        const records = res.data?.records ?? [];
        return {
          ok: true,
          data: records.map((item: any) => ({
            id: item.id,
            name: item.modelName || `模型 #${item.id}`,
            modelName: item.modelName,
            description: item.baseUrl ? `接口: ${item.baseUrl}` : '系统内置模型',
            baseUrl: item.baseUrl,
            apiKey: item.apiKey
          }))
        };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error('Failed to fetch models from server:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  async fetchWorkspaces(): Promise<FetchResult<WorkspaceVO[]>> {
    try {
      const res = await WorkspaceAPI.list(1, 100);
      if (isOk(res.code)) {
        return { ok: true, data: res.data?.records ?? [] };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.warn('Failed to fetch workspaces:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  async createWorkspace(data: WorkspaceRequest): Promise<WorkspaceVO | null> {
    try {
      const res = await WorkspaceAPI.add(data);
      if (isOk(res.code)) {
        if (res.data) {
          try {
            const detail = await WorkspaceAPI.findById(res.data);
            if (isOk(detail.code) && detail.data) {
              return detail.data;
            }
          } catch (err) {
            console.warn('[createWorkspace] 查询工作空间详情失败，回落本地组装:', err);
          }
        }
        // 后端未返回 id 时不再伪造 `ws-<时间戳>`：伪造 id 会让后续请求全部打在不存在的工作空间上
        if (res.data === null || res.data === undefined) {
          console.error('[createWorkspace] 后端未返回工作空间 id，无法组装本地数据');
          return null;
        }
        const hostDir = data.hostDir || '';
        const folderName = extractDirName(hostDir);
        const derivedName = data.name || folderName || '工作空间';
        // 契约 §5：WorkspaceVO 不含 type（环境类型来源是 user_configs）；此处仅据其推导 workDir。
        const derivedType = await UserConfigAPI.currentWorkspaceType();
        return {
          id: res.data,
          name: derivedName,
          workDir: derivedType === 'LOCAL' ? hostDir : (folderName ? `/${folderName}` : '/workspace'),
          hostDir: hostDir
        };
      }
      throw new Error(res.errMsg || '创建工作空间失败');
    } catch (err) {
      console.error('Failed to create workspace:', err);
      throw err;
    }
  },

  async deleteWorkspace(id: number | string): Promise<boolean> {
    try {
      const res = await WorkspaceAPI.del(id);
      return isOk(res.code);
    } catch (err) {
      // 删除失败必须如实上报，不能为了让列表"看起来已删除"而返回 true
      console.error('Failed to delete workspace:', err);
      return false;
    }
  },

  async fetchSessions(): Promise<FetchResult<ChatSession[]>> {
    try {
      const res = await SessionAPI.list(1, 100);
      if (isOk(res.code)) {
        const records = res.data?.records ?? [];
        return {
          ok: true,
          data: records.map((item: SessionVO) => {
            // 后端 SessionVO 不含消息正文与更新时间：消息按需走 /session/{id}/messages，
            // 更新时间只能用后端下发的创建时间，不能用 Date.now() 冒充。
            const createdAt = parseTimestampOr(item.createTime, Date.now());
            return {
              id: String(item.id),
              title: item.name || '新对话',
              workspaceId: item.workspaceId ? String(item.workspaceId) : undefined,
              workDir: item.workDir || undefined,
              createdAt,
              updatedAt: createdAt,
              modelId: '',
              activeTools: [],
              messages: []
            };
          })
        };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error('Failed to fetch sessions from server:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  /**
   * 按 ID 查询单个会话元数据（包含 totalTokens, inputTokens, outputTokens 等）
   * 对应后端 @GetMapping("/{id}")
   */
  async fetchSessionMeta(id: string | number): Promise<FetchResult<SessionVO>> {
    try {
      const res = await SessionAPI.findById(id);
      if (isOk(res.code) && res.data) {
        return { ok: true, data: res.data };
      }
      if (isOk(res.code)) {
        // code 成功但无数据：按「查不到」处理（区别于请求失败）
        return { ok: false, error: '未查询到会话' };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error(`Failed to fetch session meta for ${id}:`, err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  /**
   * 按游标分页拉取会话消息历史
   * 对应后端 @GetMapping("/{id}/messages")
   */
  async fetchSessionMessages(
    id: string | number,
    cursor?: string | null,
    size = 50
  ): Promise<FetchResult<{
    messages: ChatMessage[];
    nextCursor: string | null;
    hasMore: boolean;
  }>> {
    try {
      const res = await SessionAPI.messages(id, cursor, size);
      if (isOk(res.code) && res.data) {
        const page = res.data;
        const parsedMsgs = parseSessionMessages(page.records, String(id));
        return {
          ok: true,
          data: {
            messages: parsedMsgs,
            nextCursor: page.nextCursor ?? null,
            hasMore: Boolean(page.hasMore)
          }
        };
      }
      if (isOk(res.code)) {
        // code 成功但无 data：按空页处理（不是失败）
        return { ok: true, data: { messages: [], nextCursor: null, hasMore: false } };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error(`Failed to fetch session messages for ${id}:`, err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  /** 分页获取 Agent 角色列表 */
  async fetchAgents(page = 1, pageSize = 100): Promise<FetchResult<AgentVO[]>> {
    try {
      const res = await AgentAPI.list(page, pageSize);
      if (isOk(res.code)) {
        return { ok: true, data: res.data?.records ?? [] };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error('Failed to fetch agents from server:', err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  /**
   * 会话树：一次拿到根会话与其下全部子会话（平铺列表）。
   * 前端按 id === rootSessionId 判定哪条是根会话，其余为子会话。
   */
  async fetchSessionTree(id: string | number): Promise<FetchResult<{
    rootSessionId: string | number | null;
    root: SessionVO | null;
    subSessions: SubSessionVO[];
  }>> {
    try {
      const res = await SessionAPI.tree(id);
      if (isOk(res.code) && res.data?.sessions) {
        const rootId = String(res.data.rootSessionId);
        const sessions = res.data.sessions || [];
        return {
          ok: true,
          data: {
            rootSessionId: res.data.rootSessionId,
            root: sessions.find(s => String(s.id) === rootId) || null,
            subSessions: sessions.filter(s => String(s.id) !== rootId)
          }
        };
      }
      if (isOk(res.code)) {
        return { ok: false, error: '会话树数据不完整' };
      }
      return { ok: false, error: describeFetchFailure(classifyResult(res)) };
    } catch (err) {
      console.error(`Failed to fetch session tree for ${id}:`, err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  /**
   * 获取会话详情并加载历史消息：
   * 并发发起请求：
   * 1. tree 获取会话元数据（Token 消耗、工作空间等）+ 当前会话委派产生的子会话列表
   * 2. messages 游标分页拉取首屏历史消息（最新的一页）
   * 3. agents 用于补全子会话的 Agent 名称
   */
  async fetchSessionDetail(id: string | number): Promise<FetchResult<ChatSession>> {
    try {
      const [treeRes, pageRes, agentsRes] = await Promise.all([
        this.fetchSessionTree(id),
        this.fetchSessionMessages(id, null, 50),
        this.fetchAgents(1, 100)
      ]);
      // 任一子请求失败即整体失败，让调用方展示可重试的失败态（而非静默空会话）
      if (!treeRes.ok) return treeRes;
      if (!pageRes.ok) return pageRes;
      if (!agentsRes.ok) return agentsRes;

      const tree = treeRes.data;
      const pageResult = pageRes.data;
      const agents = agentsRes.data;
      const meta = tree.root;
      const rawSubSessions = tree.subSessions;

      const agentMap = new Map<string, AgentVO>();
      agents.forEach(a => {
        if (a && a.id !== undefined) agentMap.set(String(a.id), a);
      });

      const enrichedSubSessions: SubSessionVO[] = rawSubSessions.map(sub => {
        const agent = sub.agentId !== undefined ? agentMap.get(String(sub.agentId)) : undefined;
        return {
          ...sub,
          agentName: agent?.name,
          agentDescription: agent?.description
          // 不再硬编码 status: 'success' —— 后端未下发执行状态时如实留空，由 UI 决定展示形式
        };
      });

      const messages = pageResult.messages;

      // 关联消息中的 call_sub_agent toolCalls 与子会话元数据
      for (const msg of messages) {
        if (!msg.toolCalls || msg.toolCalls.length === 0) continue;
        for (const tc of msg.toolCalls) {
          if (!isSubAgentTool(tc.toolName, tc.category)) continue;

          tc.category = TOOL_CATEGORY.SUB_AGENT;
          const params = extractSubAgentParams(tc);

          if (params.agentId) {
            tc.subAgentId = params.agentId;
            const agent = agentMap.get(String(params.agentId));
            tc.subAgentName = agent?.name || `Agent #${params.agentId}`;
          }
          if (params.task) {
            tc.subTask = params.task;
            tc.description = params.task;
          }
          // 只接受明确的 sessionId 关联；同一 Agent 可被多次委派，不能按 agentId 猜测。
          if (params.subSessionId !== undefined && params.subSessionId !== null) {
            const matchedSub = enrichedSubSessions.find(s => String(s.id) === String(params.subSessionId));
            if (matchedSub) {
              tc.subSessionId = matchedSub.id;
            }
          }
        }
      }

      // 将会话的 Token 元数据注入到历史消息中（挂载到最新的 assistant 消息上，使其在消息底栏正确展示）
      if (meta && (meta.totalTokens !== undefined || meta.inputTokens !== undefined || meta.outputTokens !== undefined)) {
        const assistantMsgs = messages.filter(m => m.role === 'assistant');
        if (assistantMsgs.length > 0) {
          const target = assistantMsgs[assistantMsgs.length - 1];
          if (!target.tokens && !target.tokenInfo) {
            target.tokens = meta.totalTokens;
            target.tokenInfo = {
              inputTokenCount: meta.inputTokens,
              outputTokenCount: meta.outputTokens,
              totalTokenCount: meta.totalTokens
            };
          }
        }
      }

      return {
        ok: true,
        data: {
          id: String(id),
          title: meta?.name || '对话',
          createdAt: parseTimestampOr(meta?.createTime, Date.now()),
          // 列表、详情与会话树共用 SessionVO，优先使用更新时间
          updatedAt: parseTimestampOr(meta?.updateTime ?? meta?.createTime, Date.now()),
          modelId: '',
          activeTools: [],
          workspaceId: meta?.workspaceId !== undefined && meta?.workspaceId !== null ? String(meta.workspaceId) : undefined,
          workDir: meta?.workDir,
          totalTokens: meta?.totalTokens,
          inputTokens: meta?.inputTokens,
          outputTokens: meta?.outputTokens,
          agentId: meta?.agentId,
          rootSessionId: meta?.rootSessionId,
          subSessions: enrichedSubSessions,
          messages: messages,
          hasMoreMessages: pageResult.hasMore,
          nextMessageCursor: pageResult.nextCursor
        }
      };
    } catch (err) {
      console.error(`Failed to fetch session detail for ${id}:`, err);
      return { ok: false, error: describeFetchFailure(err) };
    }
  },

  async createNewSession(
    modelId: string | number,
    activeTools: string[] = [],
    workspaceId?: string | number | null,
    workDir?: string
  ): Promise<ChatSession> {
    return {
      id: createTempSessionId(),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId,
      activeTools,
      workspaceId: workspaceId ?? undefined,
      workDir: workDir,
      messages: []
    };
  },

  async deleteSession(id: string): Promise<boolean> {
    try {
      const res = await SessionAPI.del(id);
      return isOk(res.code);
    } catch {
      return false;
    }
  },

  async renameSession(id: string, name: string): Promise<boolean> {
    try {
      const res = await SessionAPI.update(id, name);
      return isOk(res.code);
    } catch {
      return false;
    }
  },

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
    teamId?: number | string | null,
    routeSessionEvent?: (event: AgentStreamEvent) => boolean,
    /** 单 Agent 直聊的 Agent ID；与 teamId 互斥，后端优先走团队编排 */
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
        const createdId = await this.createSession(content, workspaceId);
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
              const messageText = event.text ?? currentTurnText;
              if (messageText !== undefined && messageText !== null) {
                currentTurnText = messageText;
                botMessage.content = messageText;
              }

              if (!botMessage.aiMessages) botMessage.aiMessages = [];
              botMessage.aiMessages.push({
                id: createLocalId('aimsg'),
                text: messageText || '',
                thinking: event.thinking || '',
                timestamp: Date.now(),
                order: timelineSeq++
              });

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
        teamId,
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
  },
};
