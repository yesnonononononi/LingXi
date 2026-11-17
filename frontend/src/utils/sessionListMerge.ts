import type {ChatSession} from '../types/chat';

/**
 * 用后端列表快照重排本地会话数组（次序与元数据取后端，正文留在本地）。
 *
 * <p><b>为什么不能直接赋值</b>：`GET /session/list` 只回会话元数据，`messages` 恒为空数组。
 * 会话已打开时整体替换会把已加载的正文、轮次摘要、块视图、子会话树全部清空 ——
 * 表现是「pin 一下，当前对话内容消失了」。</p>
 *
 * <p><b>为什么不在这里排</b>：置顶优先、进行中优先、更新时间倒序这一整套次序是后端
 * `ORDER BY` 的唯一职责。前端再写一份比较器，两份规则迟早各说各话。</p>
 *
 * @param local    当前本地会话（含未落库的临时会话与已加载正文）
 * @param snapshot 后端返回的首页快照，顺序即权威顺序
 * @returns 按快照顺序排好、正文保留、快照里没有的会话追加在末尾的新数组
 */
export function mergeSessionListSnapshot(
  local: ChatSession[],
  snapshot: ChatSession[]
): ChatSession[] {
  const remaining = new Map(local.map(session => [session.id, session]));

  const merged = snapshot.map(remote => {
    const current = remaining.get(remote.id);
    if (!current) return remote;
    remaining.delete(remote.id);
    return {
      ...current,
      ...remote,
      // 列表接口不携带正文：这些字段一旦被快照的空值覆盖，已加载的对话就没了。
      messages: current.messages,
      turns: current.turns,
      turnViews: current.turnViews,
      subSessions: current.subSessions,
      hasMoreMessages: current.hasMoreMessages,
      nextMessageCursor: current.nextMessageCursor,
    };
  });

  // 快照里没有的会话不能凭空丢掉：未落库的临时会话、超出首页窗口的旧会话都属于这一类。
  return [...merged, ...remaining.values()];
}
