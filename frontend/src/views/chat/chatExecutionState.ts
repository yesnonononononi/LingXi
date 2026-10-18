import type { AgentEvent } from '../../types/Event';
import type { ChatAcceptance, ChatSession } from '../../types/chat';
import { t } from '../../i18n';

/** 作废范围必须来自重发回执，不能按前端气泡顺序猜测。 */
export function applyResendAcceptance(session: ChatSession, receipt: ChatAcceptance): void {
  if (receipt.sessionId !== String(session.id) || !receipt.historyRevision || !Array.isArray(receipt.invalidatedTurnIds)) {
    throw new Error(t('chat.controls.receiptInvalid'));
  }
  const removed = new Set(receipt.invalidatedTurnIds);
  session.invalidatedTurnIds = new Set([...(session.invalidatedTurnIds ?? []), ...removed]);
  session.historyRevision = receipt.historyRevision;
  session.messages = session.messages.filter(message => !message.turnId || !removed.has(message.turnId));
  session.turns = Object.fromEntries(Object.entries(session.turns ?? {}).filter(([id]) => !removed.has(id)));
  session.turnViews = Object.fromEntries(Object.entries(session.turnViews ?? {}).filter(([id]) => !removed.has(id)));
  session.turnViewVersions = new Map([...(session.turnViewVersions ?? [])].filter(([id]) => !removed.has(id)));
}

export function acceptsChatEvent(session: ChatSession | null | undefined, event: AgentEvent): boolean {
  const removed = session?.invalidatedTurnIds;
  if (!removed?.size) return true;
  const turnId = event.type === 'TURN_SNAPSHOT' || event.type === 'BLOCK_UPSERT'
    ? event.turnId : event.metaData?.turnId;
  return !(turnId && removed.has(String(turnId)))
    && !(event.metaData?.parentTurnId && removed.has(String(event.metaData.parentTurnId)));
}
