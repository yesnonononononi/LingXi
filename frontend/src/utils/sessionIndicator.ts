import type { ChatSession } from '../types/chat';

export type SessionIndicator = 'WAITING' | 'COMPLETED' | 'FAILED' | 'RUNNING';

export function resolveSessionIndicator(session: Pick<ChatSession, 'isRead' | 'renderStatus'>, active = false): SessionIndicator | null {
  if (active) return null;
  if (session.renderStatus === 'RUNNING') return 'RUNNING';

  if (session.isRead !== false) return null;
  return session.renderStatus ?? null;
}
