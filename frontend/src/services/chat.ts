import { ModelAPI } from './model';
import { WorkspaceAPI } from './workspace';
import { SessionAPI } from './session';
import { AgentAPI } from './agent';
import { TeamAPI } from './team';
import { ToolCallAPI } from './toolCall';
import { ApiError, classifyResult } from './interceptor';
import { aggregateRecordsByIdentity } from '../utils/session';
import { isOk } from '../utils/api';
import { createLocalId, createTempSessionId } from '../utils/ids';
import { extractDirName } from '../utils/path';
import {
  extractSubAgentParams,
  isSubAgentTool,
  TOOL_CATEGORY
} from '../utils/toolMeta';
import { parseTimestampOr } from '../utils/time';
import type { 
  ChatSession, 
  ModelConfig, 
  ChatMessage, 
  SessionVO, 
  WorkspaceVO, 
  WorkspaceRequest,
  WorkspaceEnvType,
  TeamVO,
  SubSessionVO,
  AgentVO,
  ToolCallVO,
  ChatTurn,
  SessionMessageVO,
  ToolCallDecisionReceipt
} from '../types/chat';
import type { TurnViewVO } from '../types/block';

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
  /**
   * 提交工具调用决策（v3 JSON 回执，**不建请求级 SSE**）。
   *
   * <p><b>为什么不再建流</b>：恢复期的实时事实全部由会话级 v3 流下发。请求级 SSE 与会话级流
   * 会各渲染一遍同一批事件（子会话思考/正文逐字双写）。回执只承诺「决策已落库 + 恢复处置」，
   * 供调用方控制按钮等待/错误提示；请求失败**不得**擅自改动卡片的业务状态。</p>
   *
   * @param conversationId 归属会话 id（= session.id）
   * @param toolCallId     决策锚点（tool_call.id / 模型 call_id）
   * @param action         动作判别：APPROVE / REJECT / ANSWER
   * @param expectedVersion 客户端看到的卡片版本（可空）；与库中不符即冲突
   * @param commandId      决策命令身份；同 ID 重试不重复提交
   */
  async decideToolCall(
    conversationId: string | number,
    toolCallId: string,
    action: 'APPROVE' | 'REJECT' | 'ANSWER',
    text: string,
    expectedVersion?: string | number | null,
    commandId?: string
  ): Promise<ToolCallDecisionReceipt> {
    return ToolCallAPI.decide({
      conversationId,
      toolCallId,
      commandId: commandId ?? createLocalId('cmd-decision'),
      expectedVersion: expectedVersion ?? null,
      action,
      text
    });
  },

  /**
   * 按 toolCallId 拉取聚合工具调用（工具调用详情的权威数据源）。
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

  /**
   * 新建工作空间。
   *
   * @param envType 当前环境类型（来自 {@code user_configs.type}）——
   *   沙箱下 workDir 是容器内路径，本地才是宿主机目录。不传时按沙箱推导。
   */
  async createWorkspace(data: WorkspaceRequest, envType: WorkspaceEnvType = 'SAND_BOX'): Promise<WorkspaceVO | null> {
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
        return {
          id: res.data,
          name: derivedName,
          workDir: envType === 'LOCAL' ? hostDir : (folderName ? `/${folderName}` : '/workspace'),
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
              runStatus: item.runStatus,
              lastOutcome: item.lastOutcome,
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
   * 按 ID 查询单个会话元数据
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
   * <p><b>本页的 {@code messages} 只是「仅本页记录」的派生视图，仅当调用方确实只加载一页时才可用。</b>
   * 后端的页按原始消息行切、不按轮次切，同一 turnId 可横跨两页；逐页聚合会为同一轮各建一个助手气泡。
   * 多页入口必须自行累积 {@code records}，再用 {@link aggregateRecordsByIdentity} 一次性聚合。</p>
   *
   * <p>返回值除 messages 外还透出本页的 turns 摘要字典（键 = turnId）：每条消息的
   * turnId 已由聚合器落到 ChatMessage 上，调用方据此把 token / 模型 / 耗时 / 状态绑定到回答组。</p>
   *
   * <p>同时透出本页的 {@code turnViews} 块视图字典（键 = turnId）：多页入口必须与 records 一样
   * **逐页累计**再一并传入 {@link aggregateRecordsByIdentity}，否则重新聚合时那一轮的块顺序
   * 会退回前端自造口径。</p>
   */
  async fetchSessionMessages(
    id: string | number,
    cursor?: string | null,
    size = 50
  ): Promise<FetchResult<{
    records: SessionMessageVO[];
    messages: ChatMessage[];
    turns: Record<string, ChatTurn>;
    turnViews: Record<string, TurnViewVO>;
    nextCursor: string | null;
    hasMore: boolean;
  }>> {
    try {
      const res = await SessionAPI.messages(id, cursor, size);
      if (isOk(res.code) && res.data) {
        const page = res.data;
        const pageRecords = page.records ?? [];
        // 单页入口（首屏详情、子会话抽屉）直接可用 messages；多页入口用 records + turnViews 自聚合。
        const pageTurnViews = page.turnViews ?? {};
        const parsedMsgs = aggregateRecordsByIdentity(undefined, pageRecords, String(id), pageTurnViews);
        return {
          ok: true,
          data: {
            records: pageRecords,
            messages: parsedMsgs,
            // 无轮次时后端返回 {} 或缺失 —— 统一归一为 {}，调用方按「无摘要」处理（≠ 用量为 0）
            turns: page.turns ?? {},
            turnViews: pageTurnViews,
            nextCursor: page.nextCursor ?? null,
            hasMore: Boolean(page.hasMore)
          }
        };
      }
      if (isOk(res.code)) {
        // code 成功但无 data：按空页处理（不是失败）
        return { ok: true, data: { records: [], messages: [], turns: {}, turnViews: {}, nextCursor: null, hasMore: false } };
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
      // 会话累计用量只在会话级位置展示；回答气泡的用量/耗时一律来自该轮次自身的 turns 摘要，
      // 否则同一份累计值会被挂到某一条回答上，刷新/分页后错位且掩盖了「本轮次未采集」的事实。

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
          // 会话级团队绑定必须透出：切回该会话时输入区据此恢复团队下拉选中项，
          // 漏传即表现为「重新加载会话后团队变未指定」。后端序列化为字符串，统一归一 null。
          teamId: meta?.teamId ?? null,
          agentId: meta?.agentId,
          rootSessionId: meta?.rootSessionId,
          runStatus: meta?.runStatus,
          lastOutcome: meta?.lastOutcome,
          subSessions: enrichedSubSessions,
          messages: messages,
          // 上下文用量快照（root 来自 tree.root 的会话表快照）：供指示器在无事件空窗展示
          contextTokenCount: meta?.contextTokenCount ?? null,
          contextMaxTokens: meta?.contextMaxTokens ?? null,
          contextRatio: meta?.contextRatio ?? null,
          // 首屏轮次摘要表：回答组的 token/模型/耗时/状态来源
          turns: pageResult.turns,
          // 首屏块视图表：翻页 / 对账重新聚合时必须一并传入（见 ChatSession.turnViews）
          turnViews: pageResult.turnViews,
          // 版本表起点：实时快照与后续翻页共用同一张表，缺表会让旧帧重新被接受
          turnViewVersions: new Map<string, number>(),
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
};
