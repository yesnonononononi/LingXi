import http from './interceptor';
import type { Result } from './types';
import { readSseResponse } from '../utils/sse';
import { isOk } from '../utils/api';
import type { AgentStreamEvent, ToolCallVO } from '../types/chat';

/** 提交工具调用决策的载荷（对应后端 ToolCallDecisionRequest） */
export interface ToolCallDecisionPayload {
  /** 归属会话（= session.id）；后端据以校验归属并解析根会话订阅 SSE */
  conversationId: number | string;
  /** 决策锚点：tool_call.id / 模型 call_id */
  toolCallId: string;
  approved: boolean;
  text?: string;
}

/**
 * 工具调用 API（对应后端 ToolCallController）。
 *
 * <p>重构后人工在环的唯一入口：决策端点统一以 `toolCallId`（`call_xxx`）为定位键，
 * 旧 `POST /interaction/decide`、`/interaction-status/*` 已物理下线。</p>
 *
 * <ul>
 *   <li>`POST /tool-call/decide`：入参 `{conversationId, toolCallId, approved, text}`，返回 `text/event-stream`；</li>
 *   <li>`GET /tool-call/{toolCallId}`：返回 `Result<ToolCallVO>`；</li>
 *   <li>`GET /tool-call/query?conversationId=`：返回 `Result<ToolCallVO[]>`。</li>
 * </ul>
 */
export class ToolCallAPI {
  /**
   * 提交决策并消费恢复执行的事件流。
   *
   * <p>决策落库后后端恢复被暂停的执行，期间全部运行时事件以 SSE 下发。建流前的校验失败
   * （tool_call / execution 不存在、归属不符等）返回普通 JSON 的 `Result` 错误体
   * （HTTP 可能为 200），故按 content-type 分流而非只看状态码。</p>
   */
  static async decide(
    payload: ToolCallDecisionPayload,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch('/tool-call/decide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        conversationId: payload.conversationId,
        toolCallId: payload.toolCallId,
        approved: payload.approved,
        text: payload.text || ''
      })
    });

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.errMsg || `提交决策失败 (${response.status})`);
    }
    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      throw new Error(`SSE 建立连接失败 (${response.status}): ${errText || response.statusText}`);
    }

    await readSseResponse(response, {
      onEvent,
      rootSessionId: String(payload.conversationId)
    });
  }

  /**
   * 按 toolCallId 查询聚合工具调用（CARD_PENDING 通知后拉取卡片权威数据）。
   *
   * <p>返回语义：查到返回 VO；「查不到」（业务码非成功或 data 为空）返回 null；
   * **「查失败」（网络/请求异常）直接抛出**，让调用方能区分两种情况——否则审批卡片拉取失败会被
   * 静默吞成 null，而后端此时已暂停等待，用户只会看到「AI 卡住不动」。</p>
   */
  static async find(toolCallId: string): Promise<ToolCallVO | null> {
    if (!toolCallId) return null;
    try {
      const res = await http.get<any, Result<ToolCallVO>>(`/tool-call/${encodeURIComponent(toolCallId)}`);
      if (isOk(res.code) && res.data) {
        return res.data;
      }
      // 查询成功但无数据：如实返回 null（「查不到」，非异常）
      console.warn(`[ToolCallAPI.find] 未查询到工具调用 ${toolCallId}（code=${res.code}）`);
      return null;
    } catch (err) {
      // 请求异常：向上抛出，调用方据此提示「加载失败，可重试」，而不是当作「查不到」
      console.warn(`[ToolCallAPI.find] 查询工具调用失败 ${toolCallId}:`, err);
      throw err;
    }
  }

  /** 按会话查询其全部工具调用（可选能力）。 */
  static async query(conversationId: number | string): Promise<ToolCallVO[]> {
    try {
      const res = await http.get<any, Result<ToolCallVO[]>>(
        `/tool-call/query?conversationId=${encodeURIComponent(String(conversationId))}`
      );
      if (isOk(res.code) && Array.isArray(res.data)) {
        return res.data;
      }
    } catch (err) {
      console.error(`Failed to query tool calls for ${conversationId}:`, err);
    }
    return [];
  }
}
