import {onScopeDispose, type Ref, watch} from 'vue';
import {useApplicationSessionStore} from '../../stores/applicationSessionStore';
import {SessionAPI} from '../../services/session';
import {isOk} from '../../utils/api';
import type {ChatSession, SessionVO, SubSessionVO} from '../../types/chat';
import {parseTimestampOr} from '../../utils/time';

export function applySessionState(session: ChatSession | SubSessionVO, state: SessionVO): void {
  if (session.version !== undefined && BigInt(session.version) > BigInt(state.version)) return;

  session.version = state.version;
  session.isRead = state.isRead;
  session.renderStatus = state.renderStatus;
  session.runStatus = state.runStatus;
  session.lastOutcome = state.lastOutcome;
}

/** 列表重载后也要重放已接收的新版本，避免旧详情覆盖实时已读值。 */
export function useApplicationSessionState(sessions: Ref<ChatSession[]>, activeId: Ref<string | null>, visibleSubId?: Readonly<Ref<string | number | null>>) {
  const application = useApplicationSessionStore();
  const pendingReads = new Set<string>();
  const pageDocument = globalThis.document;
  let disposed = false;

  watch(() => [
    Array.from(application.states.values()),
    sessions.value.map(session => [session.id, session.version, session.isRead,
      session.subSessions?.map(sub => [sub.id, sub.version, sub.isRead])]),
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
    // 先登记根会话，再挂载权威子会话，快照的返回顺序不影响归属。
    for (const state of application.states.values()) {
      if (String(state.rootSessionId) === '0') continue;
      const owner = sessions.value.find(item => item.id === String(state.rootSessionId));
      if (!owner) continue;
      const sub = owner.subSessions?.find(item => String(item.id) === String(state.id));
      if (sub) {
        applySessionState(sub, state);
      } else {
        (owner.subSessions ??= []).push({...state});
      }
    }
  }, { immediate: true, deep: true });

  async function readSession(session: ChatSession | SubSessionVO | undefined): Promise<void> {
    if (!session || session.isRead !== false || !pageDocument || pageDocument.visibilityState === 'hidden') return;
    if (session.version === undefined) return;

    const key = `${session.id}:${session.version}`;
    if (pendingReads.has(key)) return;
    pendingReads.add(key);

    try {
      const result = await SessionAPI.read(String(session.id), session.version);
      if (disposed) return;
      if (!isOk(result.code) || !result.data) throw new Error(result.errMsg || '标记会话已读失败');

      application.accept(result.data);
    } catch (error) {
      console.warn('标记会话已读失败:', error);
    } finally {
      pendingReads.delete(key);
    }
  }

  const findVisibleSessions = () => {
    const root = sessions.value.find(item => item.id === activeId.value);
    const sub = visibleSubId?.value == null ? undefined
      : root?.subSessions?.find(item => String(item.id) === String(visibleSubId.value));
    return [root, sub];
  };
  const readVisibleSessions = () => { findVisibleSessions().forEach(session => void readSession(session)); };

  // 可见会话收到新版本也要确认，收起的分支和面板不能代替用户阅读。
  watch(() => findVisibleSessions().map(session => [session?.id, session?.version, session?.isRead]),
    readVisibleSessions, { immediate: true, flush: 'post' });

  const onVisible = readVisibleSessions;
  pageDocument?.addEventListener('visibilitychange', onVisible);
  onScopeDispose(() => {
    disposed = true;
    pageDocument?.removeEventListener('visibilitychange', onVisible);
  });
}
