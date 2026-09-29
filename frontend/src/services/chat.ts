import { ModelAPI } from './model';
import { WorkspaceAPI } from './workspace';
import { UserConfigAPI } from './userConfig';
import { SessionAPI } from './session';
import { AgentAPI } from './agent';
import { TeamAPI } from './team';
import { ToolCallAPI } from './toolCall';
import { ApiError, classifyResult } from './interceptor';
import { parseSessionMessages } from '../utils/session';
import { isOk } from '../utils/api';
import { createTempSessionId } from '../utils/ids';
import { extractDirName } from '../utils/path';
import { isSubAgentTool, TOOL_CATEGORY, extractSubAgentParams } from '../utils/toolMeta';
import { parseTimestampOr } from '../utils/time';
import type { 
  ChatSession, 
  ModelConfig, 
  ChatMessage, 
  SessionVO, 
  WorkspaceVO, 
  WorkspaceRequest, 
  UserConfigVO,
  TeamVO,
  SubSessionVO,
  AgentVO,
  ToolCallVO
} from '../types/chat';
import { chatStreamService, ChatStreamService } from './chatStream';

export { ChatStreamService, chatStreamService };

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

/** 统一 chatApi 导出，供 UI 层直接调用 */
export const chatApi = {
  async stopGeneration(sessionId: string | number): Promise<void> {
    await AgentAPI.stop(sessionId);
  },

  /**
   * 提交工具调用决策结论并消费恢复执行的事件流（委托给 ChatStreamService）
   */
  decideToolCall: chatStreamService.decideToolCall.bind(chatStreamService),

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


  /**
   * 发送聊天消息并流式处理 SSE 响应事件（委托给 ChatStreamService）
   */
  sendMessageStream: chatStreamService.sendMessageStream.bind(chatStreamService),
};
