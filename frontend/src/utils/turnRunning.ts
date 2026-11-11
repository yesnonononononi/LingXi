import type {ChatMessage, ToolCallTrace} from '../types/chat';
import {isActiveTurnStatus, isTerminalTurnStatus} from './turnStatus';

/**
 * 「轮次是否仍在运行」的唯一判据（纯函数，逐条可证）。
 *
 * <p><b>为什么单独成模块</b>：这段判定同时决定终态底栏、产物清单卡片、过程框展开态与
 * 「正在等待模型响应」占位，是消息渲染里最贵也最容易改错的一条。它以前写在
 * {@code ChatMessageItem.vue} 的 computed 里，只能靠读源码推断口径，回归用例无处落脚。
 * 挪成纯函数后，组件只负责把 props 喂进来，判定顺序与每一道守卫都能被单独钉住。</p>
 */
export type TurnRunningMessage = Pick<
  ChatMessage,
  'isThinking' | 'isExploring' | 'isComplete' | 'cancelled' | 'failed' | 'durationMs' | 'tokenInfo' | 'tokens' | 'toolCalls'
>;

export interface TurnRunningFacts {
  message: TurnRunningMessage;
  /** 本条消息所属轮次的摘要状态；null / 缺失 = 历史行没有轮次摘要。 */
  turnStatus?: string | null;
  /** 全局「生成中」（受理在途或会话运行中）。注意它是**会话级**状态，不是轮次级。 */
  isSending: boolean;
  /** 是否为列表中最后一条 assistant 消息。 */
  isLastAssistant: boolean;
}

/**
 * 本气泡是否自带**本条轮次的终态证据**。
 *
 * <p>三个字段都只由终结事件写入（终止帧携带的 tokenInfo，或历史投影带来的 durationMs / tokens），
 * 流式过程中的任何一帧都不会写它们。因此它是一枚「这一轮已经收尾」的硬证据，
 * 比会话级的 {@code isSending} 更能代表本条消息自己。</p>
 */
export function hasTerminalEvidence(message: Pick<ChatMessage, 'durationMs' | 'tokenInfo' | 'tokens'>): boolean {
  return message.durationMs != null || message.tokenInfo != null || message.tokens != null;
}

/**
 * 是否还有工具停在「未收尾」态（调用中 / 待定）。
 *
 * <p>「未收尾」= 工具已经发起但还没拿到终态。只看这两种状态，不看成功/失败：
 * 历史行里工具恒为 success/failed，不会命中，因此不会把已完成的历史轮次误判成运行中。</p>
 */
export function hasPendingTool(toolCalls?: ToolCallTrace[]): boolean {
  if (!toolCalls || toolCalls.length === 0) return false;
  return toolCalls.some(call => call != null && (call.status === 'calling' || call.status === 'pending'));
}

/**
 * 轮次是否仍在运行。
 *
 * <p>判定顺序按「最便宜且最强」排：终态优先、然后是只有实时流才有的思考/探索标记，
 * 最后才落到需要推断的兜底判据。</p>
 *
 * @param facts 全部来自组件 props，函数本身不感知 Vue
 * @returns true = 仍在运行（终态底栏与产物清单必须隐藏）
 */
export function resolveTurnRunning(facts: TurnRunningFacts): boolean {
  const {message} = facts;
  const status = String(facts.turnStatus ?? '').toUpperCase();

  // 1. 轮次终态已落定：历史工具残留与迟到的流状态都不能再隐藏终态底栏。
  if (isTerminalTurnStatus(status) || message.cancelled === true || message.failed === true) return false;

  // 2. 实时流标记：历史消息从存储重建时永远没有这两个标记。
  if (message.isThinking || message.isExploring) return true;

  // 3. 本端明确收到「未完成」（受理即建的行、被重试打断的行）。
  if (message.isComplete === false) return true;

  // 4. 兜底：全局生成中 + 本条是末条回答 ⇒ 猜它还在跑。
  //
  //    ⚠️ 这一步必须被「本条自带终态证据」否掉。待发送消息（pendingChat）投递后会紧接着开
  //    下一轮，会话在「上一轮刚收尾 → 下一轮接管」的窗口里始终是运行态，而末条 assistant
  //    仍是**上一轮**那条 —— 兜底会把已收尾的轮次也当成在跑，终态底栏与产物清单被整段藏起来，
  //    直到待发送轮次跑完、末条回答移位才恢复。
  if (facts.isSending && facts.isLastAssistant && !hasTerminalEvidence(message)) return true;

  // 5. 轮次摘要仍在活跃态，事实层面这一轮没结束。
  if (isActiveTurnStatus(status)) return true;

  // 6. 多轮工具调用期间「守卫真空」的补丁：只要有工具停在调用中/待定，轮次就没结束。
  return hasPendingTool(message.toolCalls);
}
