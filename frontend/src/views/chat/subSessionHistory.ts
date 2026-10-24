/**
 * 子会话历史分页 → **会话 VO 上那份实时数组**的唯一吸收入口。
 *
 * <p>为什么要收敛：子会话内容有三个入口（右侧面板选中、详情抽屉打开、翻页），
 * 三处原来各写一遍「mergeTurns → mergeTurnViews → 逐轮 upsert → attachPromptCards →
 * synthesizeFailedTurnBubbles」，任何一处漏一步就会出现「同一轮两条气泡」或
 * 「抽屉里有、面板里没有」。更关键的是：**必须写进 {@code subSession.messages} 这个数组本身**，
 * 因为实时 reducer 也往同一个数组里追加 —— 抽屉如果自己 holding 一份副本，
 * 就永远看不到实时状态（重试提示消失的直接原因）。</p>
 *
 * <p>顺序也有硬约束：{@code turns} 必须先于消息落定（合成失败气泡要读 turns 判 FAILED）。</p>
 */
import type { chatApi } from '../../services/chat';
import type { ChatMessage, SubSessionVO } from '../../types/chat';
import { mergeTurns, mergeTurnViews, synthesizeFailedTurnBubbles } from '../../utils/session';
import { attachPromptCards } from '../../utils/toolCallCard';
import { upsertTurnViewIntoMessages } from './blockProjection';

/** 消息分页接口的 data 段（只取投影需要的字段，避免复制一份接口定义）。 */
export type SubSessionHistoryPage =
  Extract<Awaited<ReturnType<typeof chatApi.fetchSessionMessages>>, { ok: true }>['data'];

/**
 * 把一页历史并入子会话 VO（就地修改，数组引用保持稳定）。
 *
 * @param sub  目标子会话；缺失时不做任何事
 * @param page 分页响应 data
 * @returns 并入后的消息数组（就是 {@code sub.messages} 本身）；无目标时返回 null
 */
export function absorbSubSessionHistory(
  sub: SubSessionVO | null | undefined,
  page: SubSessionHistoryPage
): ChatMessage[] | null {
  if (!sub) return null;
  sub.turns = mergeTurns(sub.turns, page.turns);
  sub.turnViews = mergeTurnViews(sub.turnViews, page.turnViews);
  sub.turnViewVersions ??= new Map<string, number>();
  // 请求在途期间可能已有实时内容：历史只按 turnId + 版本补齐，绝不新建第二套数组。
  const messages: ChatMessage[] = sub.messages ?? [];
  for (const view of Object.values(page.turnViews ?? {})) {
    if (view) upsertTurnViewIntoMessages(messages, view, sub.turnViewVersions);
  }
  attachPromptCards(messages, page.records.flatMap(record => record.toolCall ? [record.toolCall] : []));
  sub.messages = synthesizeFailedTurnBubbles(messages, sub.turns);
  return sub.messages;
}
