import type {ChatSession} from '../types/chat';

export type SessionIndicator = 'WAITING' | 'COMPLETED' | 'FAILED' | 'RUNNING';

export function resolveSessionIndicator(session: Pick<ChatSession, 'isRead' | 'renderStatus' | 'subSessions'>, active = false): SessionIndicator | null {
  // 根会话选中或已读，也不能掩盖仍在运行的子会话。
  if (session.subSessions?.some(sub => sub.renderStatus === 'RUNNING')) return 'RUNNING';
  if (active) return null;
  if (session.renderStatus === 'RUNNING') return 'RUNNING';

  if (session.isRead !== false) return null;
  return session.renderStatus ?? null;
}
