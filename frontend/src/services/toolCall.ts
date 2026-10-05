import http from './interceptor';
import type { Result } from './types';
import { isOk } from '../utils/api';
import type { ToolCallAction, ToolCallDecisionReceipt, ToolCallVO } from '../types/chat';

/** 提交工具调用决策的载荷（对应后端 ToolCallDecisionCommand）。 */
export interface ToolCallDecisionPayload {
  /** 归属会话（= session.id），用于归属校验 */
  conversationId?: number | string;
  /** 决策锚点：tool_call.id / 模型 call_id */
  toolCallId: string;
  /** 决策命令身份；同 ID 重试由后端查回首轮结论，不会重复提交 */
  commandId: string;
  /** 客户端看到的卡片版本；与库中不符即 STATE_CONFLICT（可判定，而非静默覆盖） */
  expectedVersion?: string | number | null;
  /** 动作判别：APPROVE 放行 / REJECT 终态拒绝 / ANSWER 作答 */
  action: ToolCallAction;
  /** 用户答复原文（ANSWER 必填） */
  text?: string;
}

/**
 * 工具调用 API（对应后端 ToolCallController）。
 *
 * <p>重构后人工在环的唯一入口：决策端点统一以 `toolCallId`（`call_xxx`）为定位键。
 * v3 前端**不再建立请求级 SSE** —— 决策走 JSON 回执，恢复期的实时事实统一由会话级 v3 流下发；
 * 同一根会话同时消费两种协议会把同一批事件渲染两遍。</p>
 *
 * <ul>
 *   <li>`POST /tool-call/decisions`：入参 `{conversationId, toolCallId, commandId, expectedVersion, action, text}`，返回 `Result<ToolCallDecisionReceipt>`；</li>
 *   <li>`GET /tool-call/{toolCallId}`：返回 `Result<ToolCallVO>`；</li>
 *   <li>`GET /tool-call/query?conversationId=`：返回 `Result<ToolCallVO[]>`。</li>
 * </ul>
 */
export class ToolCallAPI {
  /**
   * 提交决策（v3 版本化 JSON 回执，不建 SSE）。
   *
   * <p>回执只承诺「决策已落库 + 恢复意图被怎么处理了」。请求失败**不得**擅自改动卡片的业务状态
   * —— 卡片状态一律以回执携带的 `toolCall` 与后续 v3 事件为准。</p>
   */
  static async decide(payload: ToolCallDecisionPayload): Promise<ToolCallDecisionReceipt> {
    const res = await http.post<any, Result<ToolCallDecisionReceipt>>('/tool-call/decisions', {
      conversationId: payload.conversationId ?? null,
      toolCallId: payload.toolCallId,
      commandId: payload.commandId,
      expectedVersion: payload.expectedVersion ?? null,
      action: payload.action,
      text: payload.text ?? ''
    });
    if (!isOk(res.code) || !res.data) {
      // 后端把「卡片不存在 / 版本冲突」等业务拒绝放在 Result 里，文案直接透出给用户。
      throw new Error(res.errMsg || '提交决策失败');
    }
    return res.data;
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
