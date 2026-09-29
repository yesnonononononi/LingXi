import http from './interceptor';
import type { Result } from './types';
import type { AgentStreamEvent, PageResult, AgentVO, CreateAgentRequest } from '../types/chat';
import { toPositiveInt } from '../utils/api';
import { readSseResponse } from '../utils/sse';

const appendFormValue = (form: FormData, key: string, value: string | number | boolean | null | undefined) => {
  if (value !== null && value !== undefined) form.append(key, String(value));
};

const createChatForm = (
  sessionId: string | number | null,
  prompt: string,
  workspaceId?: number | string | null,
  workDir?: string | null,
  modelId?: number | string | null,
  requirePlan?: boolean,
  teamId?: number | string | null,
  agentId?: number | string | null,
  imageFile?: File | null,
  imageUrl?: string | null
) => {
  const form = new FormData();
  appendFormValue(form, 'input', prompt);
  appendFormValue(form, 'sessionId', sessionId);
  appendFormValue(form, 'workDir', workDir);
  appendFormValue(form, 'workspaceId', workspaceId);
  appendFormValue(form, 'modelId', modelId);
  appendFormValue(form, 'teamId', toPositiveInt(teamId, 0) || null);
  appendFormValue(form, 'agentId', toPositiveInt(agentId, 0) || null);
  appendFormValue(form, 'requirePlan', requirePlan === true);
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
    teamId?: number | string | null,
    /** 单 Agent 直聊：指定该 Agent 的人设与工具清单；与 teamId 互斥，后端优先按 teamId 走团队编排 */
    agentId?: number | string | null,
    imageFile?: File | null,
    imageUrl?: string | null
  ): Promise<Result<string>> {
    return http.post<any, Result<string>>('/a/completion', createChatForm(
      sessionId, prompt, workspaceId, workDir, modelId, requirePlan, teamId, agentId, imageFile, imageUrl
    ));
  }

  static async chatStream(
    sessionId: string | number | null,
    prompt: string,
    onEvent: (event: AgentStreamEvent) => void,
    workspaceId?: number | string | null,
    workDir?: string | null,
    modelId?: number | string | null,
    requirePlan?: boolean,
    signal?: AbortSignal,
    teamId?: number | string | null,
    /** 单 Agent 直聊：指定该 Agent 的人设与工具清单；与 teamId 互斥 */
    agentId?: number | string | null,
    imageFile?: File | null,
    imageUrl?: string | null
  ): Promise<void> {
    // 本地单实例（HC-1）：无认证头；不手动设置 Content-Type，
    // 由浏览器生成含 boundary 的 multipart/form-data。
    const response = await fetch('/a/completion/stream', {
      method: 'POST',
      signal,
      // 不手动设置 Content-Type，由浏览器生成含 boundary 的 multipart/form-data。
      body: createChatForm(
        sessionId, prompt, workspaceId, workDir, modelId, requirePlan, teamId, agentId, imageFile, imageUrl
      )
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      throw new Error(`SSE 建立连接失败 (${response.status}): ${errText || response.statusText}`);
    }

    try {
      await readSseResponse(response, { onEvent, rootSessionId: sessionId == null ? null : String(sessionId) });
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return;
      }
      throw err;
    }
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
