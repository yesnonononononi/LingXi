import type { ChatMessage, ChatSession, SessionVO } from '../types/chat';

/**
 * 会话是否处于「发送中 / 运行中」。
 *
 * <p><b>业务运行态只有一个权威来源：v3 会话实体</b>（`streamV3Store.sessions`）。
 * 传入的 `authoritative` 就是它。本地 `activeStreamCount` 只代表「本端已发出、尚未被受理回执
 * 确认的在途请求」—— 它是一个**乐观占位**，在回执到达那一刻就该归零，不能用它表达业务运行态：
 * 请求发完、回执一到，计数归零，可后端还在跑，界面就会提前退出运行态（发送按钮复位）。</p>
 *
 * <p>反过来，旧快照里 `runStatus` 长期停在 RUNNING（漏收终态事件）时，也只认 v3 实体 ——
 * 那是「帧到达了没有」的问题，不该靠本地计数兜底掩盖。</p>
 *
 * @param authoritative v3 权威会话实体（可能尚未到达）
 * @param activeStreamCount 本端在途请求计数（仅作乐观占位）
 * @param fallback 尚未收到 v3 实体时的兜底（历史 `ChatSession`）；收到实体后不再参与
 */
export function resolveSessionSending(
  authoritative: SessionVO | null | undefined,
  activeStreamCount: number,
  fallback: ChatSession | null | undefined = null
): boolean {
  // 乐观占位优先：用户刚点发送、回执还没回来时，v3 实体尚未进入 RUNNING，必须立刻显示运行态。
  if (activeStreamCount > 0) return true;
  if (authoritative) return authoritative.runStatus === 'RUNNING';
  return fallback?.runStatus === 'RUNNING';
}

/** 重载时还没有回复落库，占位只用于展示，不能进入历史或模型上下文。 */
export function buildSessionDisplayMessages(session: ChatSession | null | undefined): ChatMessage[] {
  const messages = session?.messages ?? [];
  if (!session || session.runStatus !== 'RUNNING') return messages;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role !== 'user') return messages;

  return [...messages, {
    id: `running-${session.id}-${lastMessage?.id ?? 'pending'}`,
    role: 'assistant',
    content: '',
    timestamp: lastMessage?.timestamp ?? session.updatedAt,
    turnId: lastMessage?.turnId,
    isThinking: true,
    isExploring: true,
    isComplete: false,
  }];
}
