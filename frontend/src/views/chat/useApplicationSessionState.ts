import { onScopeDispose, watch, type Ref } from 'vue';
import { useApplicationSessionStore } from '../../stores/applicationSessionStore';
import { SessionAPI } from '../../services/session';
import { isOk } from '../../utils/api';
import type { ChatSession, SessionVO } from '../../types/chat';
import { parseTimestampOr } from '../../utils/time';

export function applySessionState(session: ChatSession, state: SessionVO): void {
  if (session.version !== undefined && BigInt(session.version) > BigInt(state.version)) return;

  session.version = state.version;
  session.isRead = state.isRead;
  session.renderStatus = state.renderStatus;
  session.runStatus = state.runStatus;
  session.lastOutcome = state.lastOutcome;
}

/** 列表重载后也要重放已接收的新版本，避免旧详情覆盖实时已读值。 */
export function useApplicationSessionState(sessions: Ref<ChatSession[]>, activeId: Ref<string | null>) {
  const application = useApplicationSessionStore();
  const pendingReads = new Set<string>();
  const pageDocument = globalThis.document;
  let disposed = false;

  watch(() => [
    Array.from(application.states.values()),
    sessions.value.map(session => [session.id, session.version, session.isRead]),
  ] as const, () => {
    for (const state of application.states.values()) {
      const id = String(state.id);
      const session = sessions.value.find(item => item.id === id);
      if (session) {
        applySessionState(session, state);
      } else if (String(state.rootSessionId) === '0') {
        sessions.value.push({
          id,
          title: state.name || '',
          workspaceId: state.workspaceId,
          workDir: state.workDir,
          teamId: state.teamId,
          createdAt: parseTimestampOr(state.createTime, 0),
          updatedAt: parseTimestampOr(state.updateTime, 0),
          modelId: '',
          activeTools: [],
          messages: [],
          version: state.version,
          isRead: state.isRead,
          renderStatus: state.renderStatus,
          runStatus: state.runStatus,
          lastOutcome: state.lastOutcome,
        });
      }
    }
  }, { immediate: true, deep: true });

  async function readVisibleSession(): Promise<void> {
    const session = sessions.value.find(item => item.id === activeId.value);
    if (!session || session.isRead !== false || !pageDocument || pageDocument.visibilityState === 'hidden') return;

    const key = `${session.id}:${session.version}`;
    if (pendingReads.has(key)) return;
    pendingReads.add(key);

    try {
      const result = await SessionAPI.read(session.id, session.version);
      if (disposed) return;
      if (!isOk(result.code) || !result.data) throw new Error(result.errMsg || '标记会话已读失败');

      application.accept(result.data);
    } catch (error) {
      console.warn('标记会话已读失败:', error);
    } finally {
      pendingReads.delete(key);
    }
  }

  watch(() => {
    const session = sessions.value.find(item => item.id === activeId.value);
    // 当前会话也会收到新版本的未读状态，不能只在切换会话时确认已读。
    return session?.isRead !== undefined && session.version !== undefined
      ? [activeId.value, session.version, session.isRead] as const : null;
  }, () => void readVisibleSession(), { immediate: true, flush: 'post' });

  const onVisible = () => void readVisibleSession();
  pageDocument?.addEventListener('visibilitychange', onVisible);
  onScopeDispose(() => {
    disposed = true;
    pageDocument?.removeEventListener('visibilitychange', onVisible);
  });
}
