import test from 'node:test';
import assert from 'node:assert/strict';
import {createSSRApp, effectScope, nextTick, ref} from 'vue';
import {createPinia, setActivePinia} from 'pinia';
import {createServer} from 'vite';
import {renderToString} from '@vue/server-renderer';
import {resolveSessionIndicator} from '../src/utils/sessionIndicator';
import {ApplicationEventStream} from '../src/services/applicationEventStream';
import type {ChatSession, SessionVO} from '../src/types/chat';

const metadata = (version: number | string, isRead = false): SessionVO => ({
  id: '2107364703088017408', rootSessionId: '0', name: '后台会话', version: String(version), isRead,
  runStatus: 'IDLE', lastOutcome: 'COMPLETED', renderStatus: 'COMPLETED',
});
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('后台运行态始终可见，当前会话隐藏全部状态标记', () => {
  for (const state of ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING'] as const) {
    assert.equal(resolveSessionIndicator({ isRead: false, renderStatus: state }), state);
    assert.equal(resolveSessionIndicator({ isRead: true, renderStatus: state }), state === 'RUNNING' ? 'RUNNING' : null);
    for (const isRead of [true, false]) {
      assert.equal(resolveSessionIndicator({ isRead, renderStatus: state }, true), null);
    }
  }
  assert.equal(resolveSessionIndicator({ isRead: false, renderStatus: null }), null);
  assert.equal(resolveSessionIndicator({ isRead: undefined, renderStatus: 'FAILED' }), null);
});

test('根会话汇总所有子会话的运行图标，全部结束后恢复自身标记', () => {
  const session: Pick<ChatSession, 'isRead' | 'renderStatus' | 'subSessions'> = {
    isRead: true, renderStatus: 'COMPLETED', subSessions: [
      {...metadata(1, true), id: 'child-1'},
      {...metadata(1, true), id: 'child-2', runStatus: 'RUNNING', renderStatus: 'RUNNING'},
    ],
  };
  for (const active of [false, true]) {
    assert.equal(resolveSessionIndicator(session, active), 'RUNNING');
  }
  session.subSessions![0]!.renderStatus = 'RUNNING';
  session.subSessions![1]!.renderStatus = 'COMPLETED';
  assert.equal(resolveSessionIndicator(session, true), 'RUNNING');
  session.subSessions![0]!.renderStatus = 'WAITING';
  assert.equal(resolveSessionIndicator(session), null);
  session.isRead = false;
  session.renderStatus = 'FAILED';
  assert.equal(resolveSessionIndicator(session), 'FAILED');
  assert.equal(resolveSessionIndicator(session, true), null);
});

test('过期快照与已读回执不能覆盖较新的状态，元数据更新保留消息', async () => {
  const { mergeSessionState } = await import('../src/stores/applicationSessionStore');
  const { applySessionState } = await import('../src/views/chat/useApplicationSessionState');
  const states = new Map<string, SessionVO>();
  mergeSessionState(states, metadata(4));
  mergeSessionState(states, metadata(3, true));
  assert.equal(states.get(String(metadata(4).id))?.isRead, false);

  const session = { id: String(metadata(4).id), version: '4', isRead: false, messages: [{ content: '已到达的正文' }] } as ChatSession;
  const messages = session.messages;
  applySessionState(session, metadata(3, true));
  assert.equal(session.isRead, false);
  applySessionState(session, metadata(5, true));
  assert.equal(session.isRead, true);
  assert.equal(session.messages, messages);
});

test('真实字符串版本跨位数和安全整数边界时仍按数值合并', async () => {
  const { mergeSessionState } = await import('../src/stores/applicationSessionStore');
  const { applySessionState } = await import('../src/views/chat/useApplicationSessionState');
  for (const [older, newer] of [['9', '10'], ['9007199254740992', '9007199254740993']]) {
    const states = new Map<string, SessionVO>();
    mergeSessionState(states, metadata(older!, true));
    mergeSessionState(states, metadata(newer!));
    assert.equal(states.get(String(metadata(1).id))?.version, newer);
    mergeSessionState(states, metadata(older!, true));
    assert.equal(states.get(String(metadata(1).id))?.isRead, false);

    const session = { id: String(metadata(1).id), version: older, isRead: true, messages: [] } as ChatSession;
    applySessionState(session, metadata(newer!));
    assert.equal(session.version, newer);
    assert.equal(session.isRead, false);
    applySessionState(session, metadata(older!, true));
    assert.equal(session.version, newer);
    assert.equal(session.isRead, false);
  }
});

test('删除后的会话不会被在途快照重新加入列表', async () => {
  const { useApplicationSessionStore } = await import('../src/stores/applicationSessionStore');
  setActivePinia(createPinia());
  const store = useApplicationSessionStore();
  store.accept(metadata(2));
  store.forget(String(metadata(2).id));
  store.accept(metadata(3));
  assert.equal(store.states.size, 0);
});

test('就绪后同步应用快照，旧快照不覆盖同步期间的实时迁移', async () => {
  const { SessionAPI } = await import('../src/services/session');
  const { useApplicationSessionStore } = await import('../src/stores/applicationSessionStore');
  const originalList = SessionAPI.applicationStates;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setActivePinia(createPinia());
  const store = useApplicationSessionStore();
  SessionAPI.applicationStates = async () => {
    calls++;
    await gate;
    return { code: 1, data: [metadata(3, true), { ...metadata(1, true), id: '22' }] };
  };
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: APPLICATION_READY\ndata: {}\n\n'));
    controller.enqueue(new TextEncoder().encode(`event: SESSION_STATE\ndata: ${JSON.stringify(metadata(4))}\n\n`));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    store.start();
    await turn();
    release();
    await turn(); await turn();
    assert.equal(calls, 1);
    assert.equal(store.states.get(String(metadata(4).id))?.version, '4');
    assert.equal(store.states.get(String(metadata(4).id))?.isRead, false);
    assert.ok(store.states.has('22'));
  } finally {
    release();
    store.close();
    SessionAPI.applicationStates = originalList;
    globalThis.fetch = originalFetch;
  }
});

test('挂载和切换当前未读会话调用已读接口，失败不伪造成功', async () => {
  const originalDocument = globalThis.document;
  (globalThis as any).document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const { SessionAPI } = await import('../src/services/session');
  const { useApplicationSessionState } = await import('../src/views/chat/useApplicationSessionState');
  const { useApplicationSessionStore } = await import('../src/stores/applicationSessionStore');
  const originalRead = SessionAPI.read;
  const calls: Array<[string, string | undefined]> = [];
  const scope = effectScope();
  try {
    setActivePinia(createPinia());
    const store = useApplicationSessionStore();
    SessionAPI.read = async (id, version) => {
      calls.push([id, version]);
      return { code: 1, data: metadata(String(BigInt(version ?? '0') + 1n), true) };
    };
    const sessions = ref([{ id: String(metadata(2).id), version: '2', isRead: false, messages: [] }] as ChatSession[]);
    const active = ref<string | null>(sessions.value[0]!.id);
    scope.run(() => useApplicationSessionState(sessions, active));
    await nextTick(); await turn(); await nextTick();
    assert.deepEqual(calls, [[active.value, '2']]);
    assert.equal(sessions.value[0]?.isRead, true);

    SessionAPI.read = async (id, version) => {
      calls.push([id, version]);
      return { code: 500, errMsg: '写入失败' };
    };
    store.accept(metadata(4));
    await nextTick(); await turn();
    assert.equal(calls.length, 2);
    assert.equal(sessions.value[0]?.isRead, false);
    active.value = null;
    await nextTick();
    active.value = sessions.value[0]!.id;
    await nextTick(); await turn(); await nextTick();
    assert.equal(sessions.value[0]?.isRead, false);
    assert.equal(calls.length, 3);
  } finally {
    scope.stop();
    SessionAPI.read = originalRead;
    (globalThis as any).document = originalDocument;
  }
});

test('应用流共享连接、断线重试、心跳超时及关闭清理', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { run: () => void; delay: number }>();
  const signals: AbortSignal[] = [];
  let nextId = 0;
  (globalThis as any).setTimeout = (run: () => void, delay: number) => {
    const id = ++nextId;
    timers.set(id, { run, delay });
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => timers.delete(id);
  globalThis.fetch = async (_url, options) => {
    signals.push(options!.signal!);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: APPLICATION_READY\ndata: {}\n\n'));
      if (signals.length === 1) controller.close();
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const events: string[] = [];
  const stream = new ApplicationEventStream(event => events.push(event.event));
  try {
    stream.start(); stream.start();
    await turn(); await turn();
    assert.equal(signals.length, 1);
    assert.deepEqual(events, ['APPLICATION_READY']);
    const retry = [...timers.entries()].find(([, timer]) => timer.delay === 1000)!;
    assert.ok(retry);
    timers.delete(retry[0]); retry[1].run();
    await turn(); await turn();
    assert.equal(signals.length, 2);

    const heartbeat = [...timers.entries()].find(([, timer]) => timer.delay === 45000)!;
    timers.delete(heartbeat[0]); heartbeat[1].run();
    await turn(); await turn();
    assert.equal(signals[1]?.aborted, true);
    assert.ok([...timers.values()].some(timer => timer.delay === 1000));
    stream.close();
    assert.equal(timers.size, 0);
  } finally {
    stream.close();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('实际侧栏的亮暗主题、工作区与历史列表均隐藏当前会话状态', async () => {
  const server = await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), optimizeDeps: { noDiscovery: true, include: [], entries: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { default: Tree } = await server.ssrLoadModule('/src/components/chat/SidebarWorkspaceTree.vue');
    const sessions = ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING'].map((renderStatus, index) => ({
      id: String(index), title: renderStatus, isRead: false, renderStatus,
    }));
    sessions.push({ id: 'read', title: '已读', isRead: true, renderStatus: 'FAILED' });
    sessions.find(session => session.renderStatus === 'RUNNING')!.isRead = true;
    for (const isDark of [false, true]) {
      for (const grouped of [false, true]) {
      for (const activeSessionId of [null, ...sessions.map(session => session.id)]) {
      const html = await renderToString(createSSRApp(Tree, {
        projectGroups: grouped ? [{ workspace: { id: 'workspace', name: '工作区' }, sessions }] : [],
        unassignedSessions: grouped ? [] : sessions, expandedWorkspaces: { workspace: true },
        branchedMenuItems: [{ label: '历史对话', children: [...sessions.map(session => ({ label: session.title, value: session.id, raw: session })), { label: '展开显示', value: 'more' }] }],
        branchedOpenIndices: [0], editingSessionId: null, editingTitle: ref(''), activeMenuWorkspaceId: null,
        activeSessionId, isCollapsed: false, isDark, limitSessions: (_key: string, items: unknown[]) => items,
        isFullyExpanded: () => true, toggleFullyExpanded() {}, toggleWorkspaceExpand() {}, isWorkspaceActive: () => false,
        handleSelectWorkspace() {}, handleNewSessionInProject() {}, toggleProjectMenu() {}, handleDeleteProject() {},
        startEdit() {}, saveEdit() {}, handleBranchedSelect() {}, handleBranchedToggle() {}, actions: {},
      }));
      for (const state of ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING']) {
        const activeState = sessions.find(session => session.id === activeSessionId)?.renderStatus;
        const expected = activeState === state && activeSessionId !== 'read' ? 0 : 1;
        assert.equal(html.split(`data-state="${state}"`).length - 1, expected, `${isDark}:${grouped}:${activeSessionId}:${state}`);
      }
      assert.equal(html.includes('session-running-bars'), activeSessionId !== '3');
      }
      }
    }
  } finally {
    await server.close();
  }
});

test('实际侧栏在子会话重跑时显示根会话运行图标，亮暗主题与分组路径一致', async () => {
  const server = await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), optimizeDeps: { noDiscovery: true, include: [], entries: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { default: Tree } = await server.ssrLoadModule('/src/components/chat/SidebarWorkspaceTree.vue');
    const child = {...metadata(1, true), id: 'child', name: '运行子会话'};
    const session = {id: 'root', title: '根会话', isRead: true, renderStatus: 'COMPLETED', subSessions: [child]};
    for (const isDark of [false, true]) {
      for (const grouped of [false, true]) {
        for (const activeSessionId of [null, 'root']) {
          for (const activeSubSessionId of [null, 'child']) {
            for (const running of [true, false, true]) {
              child.runStatus = running ? 'RUNNING' : 'IDLE';
              child.renderStatus = running ? 'RUNNING' : 'COMPLETED';
              const html = await renderToString(createSSRApp(Tree, {
                projectGroups: grouped ? [{workspace: {id: 'workspace', name: '工作区'}, sessions: [session]}] : [],
                unassignedSessions: grouped ? [] : [session], expandedWorkspaces: {workspace: true},
                branchedMenuItems: [{label: '分组', children: [{label: session.title, value: session.id, raw: session,
                  children: [{label: child.name, value: child.id, raw: child, ownerSessionId: session.id}]}]}],
                branchedOpenIndices: [0], editingSessionId: null, editingTitle: ref(''), activeMenuWorkspaceId: null,
                activeSessionId, activeSubSessionId, isCollapsed: false, isDark,
                limitSessions: (_key: string, items: unknown[]) => items,
                isFullyExpanded: () => true, toggleFullyExpanded() {}, toggleWorkspaceExpand() {}, isWorkspaceActive: () => false,
                handleSelectWorkspace() {}, handleNewSessionInProject() {}, toggleProjectMenu() {}, handleDeleteProject() {},
                startEdit() {}, saveEdit() {}, handleBranchedSelect() {}, handleBranchedToggle() {}, actions: {},
              }));
              // 子会话行只在**它所属分支展开时**才在 DOM 里：分支展开态由「激活会话 / 激活子会话的所属根会话」
              // 自动推导（见 useSessionBranchExpansion）。两边都没激活时整条分支折叠，DOM 里只有根会话那一行。
              // 所以期望值不是恒定的 2：
              //   分支展开 ⇒ 根 + 子两行（2）；子会话自己是激活态 ⇒ 它隐藏标记 ⇒ 只剩根（1）；
              //   分支折叠 ⇒ 只有根那一行（1）。而根那一行**始终**在子会话运行时报 RUNNING（聚合）。
              const branchExpanded = activeSessionId !== null || activeSubSessionId === 'child';
              const childRowStart = html.indexOf(child.name);
              const rootHtml = branchExpanded ? html.slice(0, childRowStart) : html;
              assert.equal(rootHtml.includes('data-state="RUNNING"'), running,
                `根会话图标: dark=${isDark}, grouped=${grouped}, active=${activeSessionId}, sub=${activeSubSessionId}, running=${running}`);
              const expected = running
                ? (!branchExpanded || activeSubSessionId === 'child' ? 1 : 2)
                : 0;
              assert.equal(html.split('data-state="RUNNING"').length - 1, expected,
                `dark=${isDark}, grouped=${grouped}, active=${activeSessionId}, sub=${activeSubSessionId}, running=${running}`);
              assert.equal(html.includes(child.name), branchExpanded,
                `子会话行渲染与分支展开态一致: dark=${isDark}, grouped=${grouped}, active=${activeSessionId}, sub=${activeSubSessionId}`);
            }
          }
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('当前会话收到完成事件后再次确认已读，切走后保留后台未读事实', async context => {
  const originalDocument = globalThis.document;
  (globalThis as any).document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const { SessionAPI } = await import('../src/services/session');
  const { useApplicationSessionState } = await import('../src/views/chat/useApplicationSessionState');
  const { useApplicationSessionStore } = await import('../src/stores/applicationSessionStore');
  const read = context.mock.method(SessionAPI, 'read', async (_id: string, version?: string) => ({
    code: 1, data: metadata(String(BigInt(version ?? '0') + 1n), true),
  }));
  setActivePinia(createPinia());
  const store = useApplicationSessionStore();
  const sessions = ref([{ id: String(metadata(1).id), version: '1', isRead: true, messages: [] }] as ChatSession[]);
  const active = ref<string | null>(sessions.value[0]!.id);
  const scope = effectScope();
  try {
    scope.run(() => useApplicationSessionState(sessions, active));
    await nextTick(); await turn();
    assert.equal(read.mock.callCount(), 0);
    store.accept(metadata(2));
    await nextTick(); await turn(); await nextTick();
    assert.deepEqual(read.mock.calls[0]?.arguments, [active.value, '2']);
    assert.equal(sessions.value[0]?.isRead, true);
    assert.equal(read.mock.callCount(), 1);
    active.value = null; await nextTick();
    store.accept(metadata(4)); await nextTick(); await turn();
    assert.equal(read.mock.callCount(), 1);
    assert.equal(sessions.value[0]?.isRead, false);
  } finally {
    scope.stop();
    (globalThis as any).document = originalDocument;
  }
});


test('应用状态把子会话挂到真实根会话，重载与迟到回执不能回退未读版本', async () => {
  const {useApplicationSessionStore} = await import('../src/stores/applicationSessionStore');
  const {useApplicationSessionState} = await import('../src/views/chat/useApplicationSessionState');
  setActivePinia(createPinia());
  const application = useApplicationSessionStore();
  const rootId = String(metadata(1).id);
  const child = {...metadata(4), id: '2107364703088017410', rootSessionId: rootId, name: '实现代理'};
  application.accept(child);
  application.accept({...metadata(1, true)});
  const sessions = ref<ChatSession[]>([]);
  const scope = effectScope();
  try {
    scope.run(() => useApplicationSessionState(sessions, ref(null)));
    await nextTick();
    assert.equal(sessions.value.length, 1, '子会话不能被登记成根会话');
    assert.equal(sessions.value[0]?.subSessions?.[0]?.id, child.id);
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, false);
    const sub = sessions.value[0]!.subSessions![0]!;
    sub.messages = [{id: 'retained', role: 'assistant', content: '保留轨迹', timestamp: 1}];
    const messages = sub.messages;
    application.accept({...child, version: '5', isRead: true});
    await nextTick();
    assert.equal(sub.messages, messages);
    assert.equal(sub.isRead, true);
    application.accept({...child, version: '4', isRead: false});
    await nextTick();
    assert.equal(sub.isRead, true);
    sessions.value[0]!.subSessions = [{...child, version: '3', isRead: false}];
    await nextTick();
    assert.equal(sessions.value[0]?.subSessions?.[0]?.version, '5');
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, true);
  } finally { scope.stop(); }
});

test('仅可见子会话确认已读，兄弟隔离，后台新版本保留未读，隐藏页面不确认', async context => {
  const originalDocument = globalThis.document;
  const listeners = new Map<string, () => void>();
  const page = {visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name)};
  (globalThis as any).document = page;
  const {SessionAPI} = await import('../src/services/session');
  const {useApplicationSessionState} = await import('../src/views/chat/useApplicationSessionState');
  const {useApplicationSessionStore} = await import('../src/stores/applicationSessionStore');
  setActivePinia(createPinia());
  const application = useApplicationSessionStore();
  const rootId = String(metadata(1).id);
  const child = {...metadata(2), id: '2107364703088017410', rootSessionId: rootId};
  const sibling = {...child, id: '2107364703088017411'};
  const sessions = ref([{id: rootId, version: '1', isRead: true, messages: [], subSessions: [child, sibling]}] as ChatSession[]);
  const visibleSubId = ref<string | null>(null);
  let fail = false;
  const read = context.mock.method(SessionAPI, 'read', async (id: string, version?: string) => fail
    ? {code: 500, errMsg: '写入失败'}
    : {code: 1, data: {...child, id, version: String(BigInt(version!) + 1n), isRead: true}});
  const scope = effectScope();
  try {
    scope.run(() => useApplicationSessionState(sessions, ref(rootId), visibleSubId));
    await nextTick(); await turn();
    assert.equal(read.mock.callCount(), 0, '显示分支不代表阅读子会话');
    visibleSubId.value = String(child.id);
    await nextTick(); await turn(); await nextTick();
    assert.deepEqual(read.mock.calls[0]?.arguments, [child.id, '2']);
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, true);
    assert.equal(sessions.value[0]?.subSessions?.[1]?.isRead, false);
    application.accept({...child, version: '4', isRead: false});
    await nextTick(); await turn(); await nextTick();
    assert.equal(read.mock.callCount(), 2, '正在阅读时自动确认新版本');
    visibleSubId.value = null; await nextTick();
    application.accept({...child, version: '6', isRead: false});
    await nextTick(); await turn();
    assert.equal(read.mock.callCount(), 2);
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, false);
    page.visibilityState = 'hidden';
    visibleSubId.value = String(child.id);
    await nextTick(); await turn();
    assert.equal(read.mock.callCount(), 2, '页面隐藏时不能确认子会话');
    fail = true;
    page.visibilityState = 'visible'; listeners.get('visibilitychange')?.();
    await turn(); await nextTick();
    assert.equal(read.mock.callCount(), 3);
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, false, '失败不能伪造已读');
    fail = false;
    listeners.get('visibilitychange')?.();
    await turn(); await nextTick();
    assert.equal(sessions.value[0]?.subSessions?.[0]?.isRead, true);
  } finally {
    scope.stop();
    assert.equal(listeners.size, 0);
    (globalThis as any).document = originalDocument;
  }
});
