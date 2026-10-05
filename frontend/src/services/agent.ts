import http from './interceptor';
import type { Result } from './types';
import type {
  AgentVO,
  CommandAcceptanceVO,
  CreateAgentRequest,
  PageResult,
  ResendCommandAcceptanceVO,
} from '../types/chat';
import { toPositiveInt } from '../utils/api';

const appendFormValue = (form: FormData, key: string, value: string | number | boolean | null | undefined) => {
  if (value !== null && value !== undefined) form.append(key, String(value));
};

/**
 * 组装聊天请求表单。
 *
 * <p>不含 {@code teamId}：团队是会话绑定（{@code session.team_id}）的属性，后端按会话记录
 * 解析本轮编排身份，请求不再携带。团队选择由前端在会话创建/换绑时同步
 * （{@code SessionAPI.create} / {@code SessionAPI.bindTeam}）。</p>
 */
const createChatForm = (
  sessionId: string | number | null,
  prompt: string,
  workspaceId?: number | string | null,
  workDir?: string | null,
  modelId?: number | string | null,
  requirePlan?: boolean,
  agentId?: number | string | null,
  imageFile?: File | null,
  imageUrl?: string | null,
  /** 重发专用：要改写的那条历史提问；普通对话不传。 */
  messageId?: number | string | null
) => {
  const form = new FormData();
  appendFormValue(form, 'input', prompt);
  appendFormValue(form, 'sessionId', sessionId);
  appendFormValue(form, 'workDir', workDir);
  appendFormValue(form, 'workspaceId', workspaceId);
  appendFormValue(form, 'modelId', modelId);
  appendFormValue(form, 'agentId', toPositiveInt(agentId, 0) || null);
  appendFormValue(form, 'requirePlan', requirePlan === true);
  appendFormValue(form, 'messageId', messageId);
  if (imageFile) form.append('image', imageFile, imageFile.name);
  if (imageUrl) appendFormValue(form, 'imageUrl', imageUrl);
  return form;
};


/** 6. Agent 对话 API (对应后端 Agent/Chat Controller: /a/completion) */
export class AgentAPI {
  static async stop(sessionId: string | number): Promise<void> {
    await http.post(`/a/completion/${sessionId}/stop`);
  }

  static async suspend(sessionId: string | number): Promise<void> {
    await http.post(`/a/completion/${sessionId}/suspend`);
  }

  static async resume(sessionId: string | number): Promise<Result<string>> {
    return http.post<any, Result<string>>(`/a/completion/${sessionId}/resume`);
  }

  static async chat(
    sessionId: string | number | null,
    prompt: string,
    workspaceId?: number | string | null,
    workDir?: string | null,
    modelId?: number | string | null,
    requirePlan?: boolean,
    /** 单 Agent 直聊：指定该 Agent 的人设与工具清单；团队身份由会话绑定决定，后端优先走团队编排 */
    agentId?: number | string | null,
    imageFile?: File | null,
    imageUrl?: string | null
  ): Promise<Result<string>> {
    return http.post<any, Result<string>>('/a/completion', createChatForm(
      sessionId, prompt, workspaceId, workDir, modelId, requirePlan, agentId, imageFile, imageUrl
    ));
  }

  /**
   * v3 发送受理：JSON 回执，**不建请求级 SSE**。
   *
   * <p>回执只承诺「命令被受理成了哪一轮」—— 它不携带 assistant 内容，也不能用作「模型执行完成」
   * 的判据（见后端 {@code CommandAcceptanceVO} 的说明）。执行产生的实时事实统一走会话级 v3 流，
   * 回执与事件按业务身份 + 版本合并，允许事件先到。</p>
   *
   * @param commandId 命令身份；同 ID 重试由后端查回首轮受理结果（幂等键）
   */
  static async sendCommand(
    commandId: string,
    sessionId: string | number | null,
    prompt: string,
    workspaceId?: number | string | null,
    workDir?: string | null,
    modelId?: number | string | null,
    requirePlan?: boolean,
    agentId?: number | string | null,
    imageFile?: File | null
  ): Promise<Result<CommandAcceptanceVO>> {
    const form = createChatForm(
      sessionId, prompt, workspaceId, workDir, modelId, requirePlan, agentId, imageFile
    );
    return http.post<any, Result<CommandAcceptanceVO>>(
      `/a/completion/commands?commandId=${encodeURIComponent(commandId)}`,
      form
    );
  }

  /**
   * v3 重发受理：与 {@link sendCommand} 同一形态，额外回被作废的轮次/执行范围与新的 historyRevision。
   *
   * <p>重发会物理删除目标轮次及其之后的历史，前端必须按回执给出的 id 精确移除实体，
   * 否则会留下一批指向已删除数据的空壳卡片。</p>
   */
  static async resendCommand(
    commandId: string,
    sessionId: string | number,
    messageId: string | number,
    prompt: string,
    workspaceId?: number | string | null,
    workDir?: string | null,
    modelId?: number | string | null,
    requirePlan?: boolean,
    agentId?: number | string | null,
    imageFile?: File | null
  ): Promise<Result<ResendCommandAcceptanceVO>> {
    const form = createChatForm(
      sessionId, prompt, workspaceId, workDir, modelId, requirePlan, agentId,
      imageFile, undefined, messageId
    );
    return http.post<any, Result<ResendCommandAcceptanceVO>>(
      `/a/completion/resend/commands?commandId=${encodeURIComponent(commandId)}`,
      form
    );
  }

  /** 分页获取 Agent 列表 (GET /agent/list?page=1&pageSize=100) */
  static async list(page = 1, pageSize = 100): Promise<Result<PageResult<AgentVO>>> {
    return http.get<any, Result<PageResult<AgentVO>>>(`/agent/list?page=${page}&pageSize=${pageSize}`);
  }

  /** 根据 ID 查询 Agent 详情 (GET /agent/find/{id}) */
  static async findById(id: number | string): Promise<Result<AgentVO>> {
    return http.get<any, Result<AgentVO>>(`/agent/find/${id}`);
  }

  /** 创建 Agent (POST /agent/add) */
  static async add(data: CreateAgentRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/agent/add', data);
  }

  /** 更新 Agent (POST /agent/update) */
  static async update(data: Partial<CreateAgentRequest> & { id: number | string }): Promise<Result<void>> {
    return http.post<any, Result<void>>('/agent/update', data);
  }

  /** 删除 Agent (GET /agent/del/{id}) */
  static async delById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/agent/del/${id}`);
  }
}
