import { ModelAPI } from './model';
import { WorkspaceAPI } from './workspace';
import { UserConfigAPI } from './userConfig';
import { SessionAPI } from './session';
import { AgentAPI } from './agent';
import { TeamAPI } from './team';
import { ToolCallAPI } from './toolCall';
import { ApiError, classifyResult } from './interceptor';
import { parseSessionMessages } from '../utils/session';
import { extractErrorMessage } from '../utils/error';
import { isOk } from '../utils/api';
import { createLocalId, createTempSessionId, toServerSessionId } from '../utils/ids';
import { extractDirName } from '../utils/path';
import {
  extractSubAgentParams,
  isSubAgentTool,
  TOOL_CATEGORY
} from '../utils/toolMeta';
import { parseTimestampOr } from '../utils/time';
import { routeToSession } from '../views/chat/messageRouter';
import type { 
  ChatSession, 
  ModelConfig, 
  ChatMessage, 
  SessionVO, 
  WorkspaceVO, 
  WorkspaceRequest, 
  AgentStreamEvent,
  UserConfigVO,
  TeamVO,
  SubSessionVO,
  AgentVO,
  ToolCallVO,
  ExecutionSummary
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
    onFinish?: () => void,
    /**
     * 会话映射事件 / 子会话事件的路由回调（与 {@link sendMessageStream} 同一契约）。
     *
     * <p>恢复期同样会产生子会话事件（子代理运行时事件、待审批卡片、`SUB_AGENT_SESSION_CREATED`
     * 映射），它们必须由视图层按 sessionId 投递；本方法只负责渲染**本会话（根）**自身的事件。</p>
     *
     * <p>归属由第二参**显式**给出，不读共享的归属快照：decide 前置的 abort 已把
     * `activeStreamOwnerSessionId` 置空，而那份快照有 3 个读取点（被中止原流的 onFinish、
     * 原流 finally 会清空、路由守卫），跨流复用它会让「对账时机」与「归属是否被清空」都变成竞态。</p>
     */
    routeSessionEvent?: (event: AgentStreamEvent, ownerRootSessionId?: string) => boolean
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

    const finalizeLastAiMessage = () => {
      const lastAiMsg = botMessage.aiMessages?.length
        ? botMessage.aiMessages[botMessage.aiMessages.length - 1]
        : null;
      if (lastAiMsg && lastAiMsg.text !== undefined && lastAiMsg.text !== null && lastAiMsg.text !== '') {
        botMessage.content = lastAiMsg.text;
      }
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
              // 会话映射事件与子会话事件先交视图层按 sessionId 路由（与 sendMessageStream 同一契约）。
              // 必须在下面的「只渲染本会话」过滤之前：子会话事件的 sessionId 是**子会话 id**，
              // 会被判为异己直接丢弃 —— 子代理的待审批卡片曾因此既进不了子会话面板、
              // 也进不了根会话气泡，用户无从审批，子执行永久挂起。
              if (routeSessionEvent?.(event, String(conversationId))) {
                return;
              }

              // 只渲染本会话的事件；子会话（委派执行）事件已在上方交给视图层
              const eventSessionId = event.sessionId == null ? null : String(event.sessionId);
              if (eventSessionId !== null && eventSessionId !== sessionIdFilter) {
                return;
              }

              if (!streamEstablished) {
                resolveEstablished(resolve);
              }

              // 统一委托给 messageRouter 核心分发器进行状态推进
              routeToSession(event, { id: conversationId } as SessionVO, {
                onMessageUpdated: (updatedMsg) => {
                  // 钉住本流气泡 id：router 在 EXECUTION_STARTED 时会 initExecution 造出
                  // 新 id 的 store 消息，若放任 assign 覆盖 id，下一次 onProgress 会因
                  // id 失配追加第二条气泡，旧气泡永远停留在「思考中/正在探索中」假象
                  Object.assign(botMessage, updatedMsg, { id: botMsgId });
                  onProgress({ ...botMessage });
                },
                onCompleted: (completedMsg) => {
                  Object.assign(botMessage, completedMsg, { id: botMsgId });
                  onProgress({ ...botMessage });
                }
              });
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
   *
   * @param teamId 建会话时一并绑定的团队（前端团队下拉框当前选中值）；
   *               聊天请求已不再携带 teamId，会话创建是唯一能同步团队绑定的时机之一，
   *               另一个是已有的换绑入口 SessionAPI.bindTeam。
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
   *
   * <p>返回值除 messages 外还透出本页的 executions 摘要字典（键 = executionId）：每条消息的
   * executionId 已由 {@link parseSessionMessages} 落到 ChatMessage 上，调用方据此把
   * token / 模型 / 耗时 / 状态绑定到回答组。</p>
   */
  async fetchSessionMessages(
    id: string | number,
    cursor?: string | null,
    size = 50
  ): Promise<FetchResult<{
    messages: ChatMessage[];
    executions: Record<string, ExecutionSummary>;
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
            // 无执行时后端返回 {} 或缺失 —— 统一归一为 {}，调用方按「无摘要」处理（≠ 用量为 0）
            executions: page.executions ?? {},
            nextCursor: page.nextCursor ?? null,
            hasMore: Boolean(page.hasMore)
          }
        };
      }
      if (isOk(res.code)) {
        // code 成功但无 data：按空页处理（不是失败）
        return { ok: true, data: { messages: [], executions: {}, nextCursor: null, hasMore: false } };
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
          agentName: sub.agentName || agent?.name,
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

          if (params.agentName) {
            tc.subAgentName = params.agentName;
          }
          if (params.agentId) {
            tc.subAgentId = params.agentId;
            const agent = agentMap.get(String(params.agentId));
            if (!tc.subAgentName) {
              tc.subAgentName = agent?.name || `Agent #${params.agentId}`;
            }
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
              if (matchedSub.agentName && (!tc.subAgentName || tc.subAgentName.startsWith('Agent #'))) {
                tc.subAgentName = matchedSub.agentName;
              }
            }
          }
        }
      }

      // 注意：不再把「会话累计 Token」回填到最后一条回答气泡上。
      // 会话累计用量只在会话级位置展示；回答气泡的用量/耗时一律来自该执行自身的 executions 摘要，
      // 否则同一份累计值会被挂到某一条回答上，刷新/分页后错位且掩盖了「本执行未采集」的事实。

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
          // 会话级累计用量（仅用于会话列表/头部展示，不回填到任何消息）
          totalTokens: meta?.totalTokens,
          inputTokens: meta?.inputTokens,
          outputTokens: meta?.outputTokens,
          agentId: meta?.agentId,
          rootSessionId: meta?.rootSessionId,
          subSessions: enrichedSubSessions,
          messages: messages,
          // 首屏执行摘要表：回答组的 token/模型/耗时/状态来源
          executions: pageResult.executions,
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
    let sessionIdNotified = false;

    const finalizeLastAiMessage = () => {
      const lastAiMsg = botMessage.aiMessages?.length
        ? botMessage.aiMessages[botMessage.aiMessages.length - 1]
        : null;
      if (lastAiMsg && lastAiMsg.text !== undefined && lastAiMsg.text !== null && lastAiMsg.text !== '') {
        botMessage.content = lastAiMsg.text;
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

          // 2. 统一委托给 messageRouter 核心分发器进行状态推进与 Pinia 维护
          routeToSession(event, { id: realSessionId } as SessionVO, {
            onMessageUpdated: (updatedMsg) => {
              // 钉住本流气泡 id：router 收到 EXECUTION_STARTED / 首个事件时会 initExecution
              // 造出新 id 的 store 消息，若放任 assign 覆盖 id，本流预建的气泡会成为孤儿
              // （永远停在「思考中/正在探索中」），下一次 onProgress 又追加一条 → 气泡重复
              Object.assign(botMessage, updatedMsg, { id: botMsgId });
              onProgress({ ...botMessage });
            },
            onCompleted: (completedMsg) => {
              Object.assign(botMessage, completedMsg, { id: botMsgId });
              onProgress({ ...botMessage });
              onFinish?.();
            }
          });
          return;
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
  },
};
