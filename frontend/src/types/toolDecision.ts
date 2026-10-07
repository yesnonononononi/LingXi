import type { InjectionKey } from 'vue';
import type { ToolCallAction, ToolCallDecisionReceipt } from './chat';

/** 卡片决策提交载荷（由卡片组件构造，视图层补齐会话 id 后提交）。 */
export interface ToolDecisionPayload {
  /** 归属会话（= session.id） */
  conversationId: string;
  /** 决策锚点：tool_call.id / 模型 call_id */
  toolCallId: string;
  action: ToolCallAction;
  /** 用户答复原文（ANSWER 必填，PLAN/COMMAND 的补充建议选填） */
  text?: string;
  /** 卡片当前版本；提交给后端做冲突判定，避免过期界面覆盖先到的结论 */
  expectedVersion?: string | number | null;
}

/**
 * 卡片决策提交器。成功返回后端回执（携带权威 {@code toolCall}），失败抛异常。
 *
 * <p>由 ChatView 通过 {@link DECIDE_TOOL_CALL_KEY} 注入。卡片组件是深层消费者，改注入后
 * 不必再把「批准 / 拒绝 / 作答」事件一层层冒泡到视图层；决策链路统一收敛到
 * {@code ToolCallAPI.decide}（幂等 commandId + expectedVersion 冲突判定）。</p>
 */
export type ToolDecisionHandler = (payload: ToolDecisionPayload) => Promise<ToolCallDecisionReceipt>;

/** 卡片决策提交能力的注入键。 */
export const DECIDE_TOOL_CALL_KEY: InjectionKey<ToolDecisionHandler> = Symbol('decide-tool-call');
