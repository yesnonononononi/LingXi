import type { SessionVO, SubItemStatus } from '../types/chat';

/**
 * 子会话展示态映射（唯一定义处）。
 *
 * <p>输入为后端会话树节点的 {@code runStatus} + {@code lastOutcome}（展示状态唯一来源），
 * 输出为前端统一展示态 {@link SubItemStatus}。前端**不再**接收后端生命周期枚举，
 * 也禁止二次猜测。</p>
 *
 * 映射规则（与后端 docs/frontend-backend-contract.md 词表一致）：
 * - runStatus=RUNNING   → running
 * - runStatus=SUSPENDED → suspended
 * - 无进行中时按最近结果回显（completed/failed/cancelled）
 * - runStatus=IDLE 或缺失 → idle
 * - 其余 → unknown
 */
export const toSubItemStatus = (
  runStatus?: SessionVO['runStatus'],
  lastOutcome?: SessionVO['lastOutcome'],
): SubItemStatus => {
  if (runStatus === 'RUNNING') return 'running';
  if (runStatus === 'SUSPENDED') return 'suspended';
  if (lastOutcome === 'COMPLETED') return 'completed';
  if (lastOutcome === 'FAILED') return 'failed';
  if (lastOutcome === 'CANCELLED') return 'cancelled';
  if (runStatus === 'IDLE' || runStatus === undefined || runStatus === null) return 'idle';
  return 'unknown';
};
