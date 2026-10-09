import http from './interceptor';
import type { Result } from './types';
import type {
  AgentVO,
  ChatAcceptance,
  CreateAgentRequest,
  PageResult,
} from '../types/chat';
import { toPositiveInt } from '../utils/api';
import { toServerSessionId } from '../utils/ids';
import { getApiBaseUrl } from '../utils/apiConfig';
import type { ChatCommand } from './dto/chat_command';

const appendFormValue = (form: FormData, key: string, value: string | number | boolean | null | undefined) => {
  if (value !== null && value !== undefined) form.append(key, String(value));
};

/**
 * 是否为「主动中止」引起的错误。
 *
 * <p>{@code AbortSignal} 触发后 {@code fetch} 会以 {@link DOMException}（name=AbortError）拒绝，
 * 调用方据此把「用户点了停止」与「真实网络故障」区分开，不要弹失败提示。</p>
 */
export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;



/**
 * 组装聊天请求表单。
 *
 * <p>不含 {@code teamId}：团队是会话绑定（{@code session.team_id}）的属性，后端按会话记录
 * 解析本轮编排身份，请求不再携带。团队选择由前端在会话创建/换绑时同步
 * （{@code SessionAPI.create} / {@code SessionAPI.bindTeam}）。</p>
 */
const toChatForm = (command: ChatCommand): FormData => {
  const form = new FormData();
  appendFormValue(form, 'input', command.input);
  const serverSessionId = toServerSessionId(command.sessionId);
  if (serverSessionId !== null && serverSessionId !== undefined) {
    appendFormValue(form, 'sessionId', serverSessionId);
  }
  appendFormValue(form, 'workDir', command.workDir);
  appendFormValue(form, 'workspaceId', command.workspaceId);
  appendFormValue(form, 'modelId', command.modelId);
  appendFormValue(form, 'agentId', toPositiveInt(command.agentId, 0) || null);
  appendFormValue(form, 'requirePlan', command.requirePlan === true);
  for (const image of command.image ?? []) form.append('image', image, image.name);
  for (const url of command.imageUrl ?? []) appendFormValue(form, 'imageUrl', url);
  return form;
};


/** 6. Agent 对话 API (对应后端 Agent/Chat Controller: /a/completion) */
export class AgentAPI {
  static async chatLimits(): Promise<Result<{ maxImages: number }>> {
    return http.get<any, Result<{ maxImages: number }>>('/a/completion/limits');
  }

  static async stop(sessionId: string | number): Promise<void> {
    await http.post(`/a/completion/${sessionId}/stop`);
  }

  static async suspend(sessionId: string | number): Promise<void> {
    await http.post(`/a/completion/${sessionId}/suspend`);
  }

  static async resume(sessionId: string | number): Promise<Result<string>> {
    return http.post<any, Result<string>>(`/a/completion/${sessionId}/resume`);
  }

  /**
   * 受理聊天请求：{@code POST /a/completion/commands}。
   *
   * <p><b>同步受理</b>：请求线程内同事务落库（轮次 + 用户消息 + 执行行）后立即返回权威
   * {@code sessionId} / {@code turnId}，模型调用异步进行。该端点<b>不返回流、不建 emitter</b>，
   * 实时事件一律由会话级订阅（{@link #subscribeSessionEvents}）承载。</p>
   *
   * <p>走原生 fetch 而非 axios：请求体是 FormData（multipart），交给浏览器生成 boundary；
   * 响应体是普通 JSON，用原生 fetch 反而少一层包装。</p>
   */
  static async acceptCommand(form: ChatCommand, signal?: AbortSignal): Promise<Result<ChatAcceptance>> {
    const response = await fetch(`${getApiBaseUrl()}/a/completion/commands`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: toChatForm(form),
      signal,
    });
    if (!response.ok) {
      throw new Error(`受理请求失败：HTTP ${response.status}`);
    }
    return response.json() as Promise<Result<ChatAcceptance>>;
  }

  /**
   * 订阅会话级事件流：{@code GET /a/completion/{sessionId}/events}。
   *
   * <p>发送不再自带流，本流是唯一的实时通道：连接建立后服务端立即发一帧命名事件
   * {@code READY}（emitter 先入桶再发帧），此后每 30s 一帧 {@code HEARTBEAT}。
   * 二者是传输层信号、不是框架 {@code AgentEvent}，必须由 {@code SessionEventStream}
   * 在传输层按事件名消费。</p>
   *
   * <p>走原生 {@code fetch}（拿到 {@code response.body} 交给 {@code readSseStream}），
   * 不用 {@code EventSource}：它只支持 GET 且会自行重连，重连时机不可控。</p>
   *
   * <p>不回放历史：只投递挂上之后的事件，切走期间的缺口由会话历史接口对齐。</p>
   */
  static async subscribeSessionEvents(sessionId: string | number, signal?: AbortSignal): Promise<Response> {
    return fetch(`${getApiBaseUrl()}/a/completion/${sessionId}/events`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal,
    });
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
