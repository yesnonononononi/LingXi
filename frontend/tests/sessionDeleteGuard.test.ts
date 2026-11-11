import test from 'node:test';
import assert from 'node:assert/strict';
import {ref} from 'vue';
import {createPinia, setActivePinia} from 'pinia';
import {isSessionActive} from '../src/utils/session';
import {useChatSessionList} from '../src/views/chat/useChatSessionList';
import {useConfirm} from '../src/composables/useConfirm';
import {chatApi} from '../src/services/chat';
import type {ChatSession} from '../src/types/chat';

test('isSessionActive: 各种边界与活跃态判定正确', () => {
  // 1. 空对象或无有效 id
  assert.equal(isSessionActive(null), false, 'null 应判定为未活跃');
  assert.equal(isSessionActive(undefined), false, 'undefined 应判定为未活跃');
  assert.equal(isSessionActive({ id: '' } as any), false, '无有效 id 应为未活跃');

  // 2. 正常空闲会话
  const idleSession: ChatSession = {
    id: 's-idle',
    title: '空闲会话',
    runStatus: 'IDLE',
    renderStatus: 'COMPLETED',
    createdAt: 1000,
    updatedAt: 1000,
    modelId: 'm1',
    activeTools: [],
    messages: []
  };
  assert.equal(isSessionActive(idleSession), false, 'IDLE 会话应为未活跃');

  // 3. 根会话自身处于 RUNNING
  const runningSession = { ...idleSession, id: 's-run', runStatus: 'RUNNING' as const };
  assert.equal(isSessionActive(runningSession), true, 'runStatus=RUNNING 应判定为活跃');

  // 4. 根会话处于 SUSPENDED 挂起状态（等待审批/回复，属于执行生命周期活跃）
  const suspendedSession = { ...idleSession, id: 's-suspend', runStatus: 'SUSPENDED' as const };
  assert.equal(isSessionActive(suspendedSession), true, 'runStatus=SUSPENDED 应判定为活跃');

  // 5. renderStatus 处于 RUNNING
  const renderRunningSession = { ...idleSession, id: 's-render-run', runStatus: 'IDLE' as const, renderStatus: 'RUNNING' as const };
  assert.equal(isSessionActive(renderRunningSession), true, 'renderStatus=RUNNING 应判定为活跃');

  // 6. 子会话处于 RUNNING 或 SUSPENDED
  const sessionWithRunningSub: ChatSession = {
    ...idleSession,
    id: 's-sub-run',
    subSessions: [
      { id: 'sub-1', renderStatus: 'RUNNING', isRead: true, version: '1' } as any
    ]
  };
  assert.equal(isSessionActive(sessionWithRunningSub), true, '子会话运行中，根会话应判定为活跃');

  const sessionWithSuspendedSub: ChatSession = {
    ...idleSession,
    id: 's-sub-suspend',
    subSessions: [
      { id: 'sub-2', runStatus: 'SUSPENDED', isRead: true, version: '1' } as any
    ]
  };
  assert.equal(isSessionActive(sessionWithSuspendedSub), true, '子会话挂起中，根会话应判定为活跃');

  // 7. 当前激活且正在流式生成中
  assert.equal(
    isSessionActive(idleSession, { isGenerating: true, activeSessionId: 's-idle' }),
    true,
    '当前选中且正在生成中的会话应判定为活跃'
  );
  assert.equal(
    isSessionActive(idleSession, { isGenerating: true, activeSessionId: 'other-session' }),
    false,
    '正在生成但非当前会话时不应误判为活跃'
  );

  // 8. applicationStates 全局权威状态
  const appStates = new Map<string, any>();
  appStates.set('s-idle', { id: 's-idle', runStatus: 'RUNNING', renderStatus: 'RUNNING' });
  assert.equal(
    isSessionActive(idleSession, { applicationStates: appStates }),
    true,
    'applicationStates 处于 RUNNING 应判定为活跃'
  );

  const subAppStates = new Map<string, any>();
  subAppStates.set('sub-99', { id: 'sub-99', rootSessionId: 's-idle', runStatus: 'SUSPENDED' });
  assert.equal(
    isSessionActive(idleSession, { applicationStates: subAppStates }),
    true,
    'applicationStates 中挂在当前根会话下的子会话处于活跃时应判定为活跃'
  );
});

test('handleDeleteSession: 活跃会话硬性拦截，不弹确认框且不调后端删除', async () => {
  setActivePinia(createPinia());
  const alerts: string[] = [];
  const originalAlert = globalThis.window?.alert;
  (globalThis as any).window = { alert: (msg: string) => alerts.push(msg) };

  const { state: confirmState } = useConfirm();
  confirmState.value.isOpen = false;

  let deleteApiCalled = false;
  const originalDelete = chatApi.deleteSession;
  chatApi.deleteSession = async () => {
    deleteApiCalled = true;
    return true;
  };

  try {
    const runningSession: ChatSession = {
      id: 'active-session-1',
      title: '进行中的会话',
      runStatus: 'RUNNING',
      renderStatus: 'RUNNING',
      createdAt: 1000,
      updatedAt: 1000,
      modelId: 'm1',
      activeTools: [],
      messages: []
    };

    const localSessions = ref<ChatSession[]>([runningSession]);
    const localActiveId = ref<string | null>('active-session-1');

    const sessionList = useChatSessionList({
      localSessions,
      localActiveId,
      currentActiveSession: ref(runningSession) as any,
      displayedMessages: ref([]) as any,
      localActiveWorkspaceId: ref(null),
      localSelectedTeamId: ref(null),
      beforeSwitchSession: () => {},
      isGenerating: () => false,
      scrollToBottomForce: () => {},
      seedContextUsageFromTree: () => {},
      resetScrollAnchors: () => {},
      onNewSession: () => {}
    });

    await sessionList.handleDeleteSession('active-session-1');

    assert.equal(alerts.length, 1, '活跃会话应触发拦截提示');
    assert.match(alerts[0], /无法删除|进行中/, '提示文案应说明活跃中无法删除');
    assert.equal(confirmState.value.isOpen, false, '活跃会话不应弹出确认框');
    assert.equal(deleteApiCalled, false, '活跃会话不应调用后端删除接口');
    assert.equal(localSessions.value.length, 1, '会话列表中该条目未被删除');
  } finally {
    chatApi.deleteSession = originalDelete;
    if (originalAlert) (globalThis as any).window.alert = originalAlert;
  }
});

test('handleDeleteSession: 未活跃会话弹确认框，取消则不删除，确认后完成删除', async () => {
  setActivePinia(createPinia());
  const { state: confirmState, handleCancel, handleConfirm } = useConfirm();
  confirmState.value.isOpen = false;

  let deleteApiSessionId: string | null = null;
  const originalDelete = chatApi.deleteSession;
  chatApi.deleteSession = async (id: string) => {
    deleteApiSessionId = id;
    return true;
  };

  try {
    const idleSession: ChatSession = {
      id: 'idle-session-1',
      title: '已完成的会话',
      runStatus: 'IDLE',
      renderStatus: 'COMPLETED',
      createdAt: 1000,
      updatedAt: 1000,
      modelId: 'm1',
      activeTools: [],
      messages: []
    };

    const localSessions = ref<ChatSession[]>([idleSession]);
    const localActiveId = ref<string | null>('idle-session-1');

    const sessionList = useChatSessionList({
      localSessions,
      localActiveId,
      currentActiveSession: ref(idleSession) as any,
      displayedMessages: ref([]) as any,
      localActiveWorkspaceId: ref(null),
      localSelectedTeamId: ref(null),
      beforeSwitchSession: () => {},
      isGenerating: () => false,
      scrollToBottomForce: () => {},
      seedContextUsageFromTree: () => {},
      resetScrollAnchors: () => {},
      onNewSession: () => {}
    });

    // 1. 用户取消分支
    const cancelPromise = sessionList.handleDeleteSession('idle-session-1');
    assert.equal(confirmState.value.isOpen, true, '应弹出确认框');
    assert.match(confirmState.value.options.content || '', /已完成的会话/, '确认框内容应包含会话标题');
    assert.equal(confirmState.value.options.type, 'danger', '确认框类型应为 danger');
    handleCancel();
    await cancelPromise;

    assert.equal(deleteApiSessionId, null, '取消后不应调用后端删除');
    assert.equal(localSessions.value.length, 1, '取消后会话仍保留在列表');

    // 2. 用户确认分支
    const confirmPromise = sessionList.handleDeleteSession('idle-session-1');
    assert.equal(confirmState.value.isOpen, true, '应再次弹出确认框');
    handleConfirm();
    await confirmPromise;

    assert.equal(deleteApiSessionId, 'idle-session-1', '确认后应调用后端删除对应 id');
    assert.equal(localSessions.value.length, 0, '确认后会话应从列表中移除');
    assert.equal(localActiveId.value, null, '当前激活会话被删除后激活 id 应置 null');
  } finally {
    chatApi.deleteSession = originalDelete;
  }
});
