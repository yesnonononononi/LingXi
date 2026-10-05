import type { ChatTurn } from '../types/chat';

/**
 * 轮次业务状态判定（唯一定义处）。
 *
 * <p>来源：后端 `TurnVO.status`（`types/chat.ts` 的 `ChatTurn['status']`）。此前同一组字面量
 * `'ACCEPTED' | 'RUNNING' | 'WAITING'` 与 `'FAILED'` 在 `ChatMessageItem.vue` 散落三处分别硬编码，
 * 改词表时必然漏改。这里收成一张表，判定语义与展示文案绑定，避免两处各自维护。</p>
 *
 * <p>为什么用 `as const` + 派生联合类型而不是 `enum`：项目 `tsconfig` 开了
 * `erasableSyntaxOnly`，`enum` 属于不可擦除语法，编译不通过。</p>
 */

/** 「进行中」三态：已受理未开始 / 执行中 / 挂起等审批。后端尚未下发终结事件。 */
export const ACTIVE_TURN_STATUSES = ['ACCEPTED', 'RUNNING', 'WAITING'] as const;

/** 轮次状态 → 用户可见文案。`Record` 而非 Map：键集合由 `TurnVO['status']` 约束，漏词编译即报错。 */
const TURN_STATUS_LABELS: Record<ChatTurn['status'], string> = {
  ACCEPTED: '已受理',
  RUNNING: '执行中',
  WAITING: '等待审批',
  COMPLETED: '已完成',
  FAILED: '已失败',
  CANCELLED: '已取消'
};

/** 该轮次是否处于「后端尚未下发终结事件」的活跃期。 */
export const isActiveTurnStatus = (status: string): boolean =>
  (ACTIVE_TURN_STATUSES as readonly string[]).includes(status);

/** 该轮次是否已失败（用于附上失败原因全文）。 */
export const isFailedTurnStatus = (status: string): boolean => status === 'FAILED';

/** 轮次状态文案；未收录的未知状态原样回显，不臆断。 */
export const turnStatusLabel = (status: ChatTurn['status']): string =>
  TURN_STATUS_LABELS[status] ?? status;
