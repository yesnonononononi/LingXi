/**
 * 审批结论（`raw_output.outcome`）判定（唯一定义处）。
 *
 * <p>后端下发的 `outcome` 是**字符串**，取值词表：
 * `APPROVED / REJECTED / ANSWERED / CANCELLED / SUCCEEDED / FAILED / TIMED_OUT`。
 * 这里收成两张常量表，避免调用方各写一条 if 链、改词表时漏改。</p>
 */

/** 归为「已批准」侧的结论。`SUCCEEDED` 表示命令执行成功，与 `APPROVED` 同侧。 */
export const APPROVED_OUTCOMES = ['APPROVED', 'SUCCEEDED'] as const;

/** 归为「已拒绝」侧的结论：主动拒绝、被取消、执行失败、超时。 */
export const REJECTED_OUTCOMES = ['REJECTED', 'CANCELLED', 'FAILED', 'TIMED_OUT'] as const;

/** 卡片最终展示态；`null` = 仍待决断。 */
export type ApprovalDisplayState = 'approved' | 'rejected' | 'unknown' | null;

/**
 * 归一化后端结论：去空白、转大写。
 * 前端收到的大小写不保证统一，判定前必须过这里。
 */
export const normalizeOutcome = (raw?: string | null): string =>
  String(raw ?? '').trim().toUpperCase();

/**
 * 由结论推导展示态。
 *
 * @param outcome 已 {@link normalizeOutcome} 的结论
 * @param pending 是否仍待决断；仅在结论无法识别时用于区分 `null`（待决）与 `unknown`（已决但认不出）
 *
 * <p>契约 §3：结论缺失/无法识别 = 状态未知，绝不臆断为「已批准」。</p>
 */
export const resolveApprovalState = (
  outcome: string,
  pending: boolean,
): ApprovalDisplayState => {
  if ((APPROVED_OUTCOMES as readonly string[]).includes(outcome)) return 'approved';
  if ((REJECTED_OUTCOMES as readonly string[]).includes(outcome)) return 'rejected';
  return pending ? null : 'unknown';
};

/** 审批动作字面量，与后端 `allowedActions` 元素类型同源。 */
export const APPROVE_ACTION = 'APPROVE' as const;
