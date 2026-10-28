import type { ChatSession } from '../types/chat';

export type SessionIndicator = 'WAITING' | 'COMPLETED' | 'FAILED' | 'RUNNING';

export function resolveSessionIndicator(session: Pick<ChatSession, 'isRead' | 'renderStatus'>): SessionIndicator | null {
  if (session.isRead !== false) return null;
  return session.renderStatus ?? null;
}
