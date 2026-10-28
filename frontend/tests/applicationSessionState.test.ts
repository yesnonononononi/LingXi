import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, ref, nextTick, effectScope } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createServer } from 'vite';
import { renderToString } from '@vue/server-renderer';
import { resolveSessionIndicator } from '../src/utils/sessionIndicator';
import { ApplicationEventStream } from '../src/services/applicationEventStream';
import type { ChatSession, SessionVO } from '../src/types/chat';

const metadata = (version: number, isRead = false): SessionVO => ({
  id: '2107364703088017408', rootSessionId: '0', name: '后台会话', version, isRead,
  runStatus: 'IDLE', lastOutcome: 'COMPLETED', renderStatus: 'COMPLETED',
});
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('运行态始终可见，其他三态只渲染未读权威状态', () => {
  for (const state of ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING'] as const) {
    assert.equal(resolveSessionIndicator({ isRead: false, renderStatus: state }), state);
    assert.equal(resolveSessionIndicator({ isRead: true, renderStatus: state }), state === 'RUNNING' ? 'RUNNING' : null);
  }
  assert.equal(resolveSessionIndicator({ isRead: false, renderStatus: null }), null);
  assert.equal(resolveSessionIndicator({ isRead: undefined, renderStatus: 'FAILED' }), null);
});

test('过期快照与已读回执不能覆盖较新的状态，元数据更新保留消息', async () => {
  const { mergeSessionState } = await import('../src/stores/applicationSessionStore');
  const { applySessionState } = await import('../src/views/chat/useApplicationSessionState');
  const states = new Map<string, SessionVO>();
  mergeSessionState(states, metadata(4));
  mergeSessionState(states, metadata(3, true));
  assert.equal(states.get(String(metadata(4).id))?.isRead, false);

  const session = { id: String(metadata(4).id), version: 4, isRead: false, messages: [{ content: '已到达的正文' }] } as ChatSession;
  const messages = session.messages;
  applySessionState(session, metadata(3, true));
  assert.equal(session.isRead, false);
  applySessionState(session, metadata(5, true));
  assert.equal(session.isRead, true);
  assert.equal(session.messages, messages);
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
    assert.equal(store.states.get(String(metadata(4).id))?.version, 4);
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
  const calls: Array<[string, number | undefined]> = [];
  const scope = effectScope();
  try {
    setActivePinia(createPinia());
    const store = useApplicationSessionStore();
    SessionAPI.read = async (id, version) => {
      calls.push([id, version]);
      return { code: 1, data: metadata((version ?? 0) + 1, true) };
    };
    const sessions = ref([{ id: String(metadata(2).id), version: 2, isRead: false, messages: [] }] as ChatSession[]);
    const active = ref<string | null>(sessions.value[0]!.id);
    scope.run(() => useApplicationSessionState(sessions, active));
    await nextTick(); await turn(); await nextTick();
    assert.deepEqual(calls, [[active.value, 2]]);
    assert.equal(sessions.value[0]?.isRead, true);

    SessionAPI.read = async (id, version) => {
      calls.push([id, version]);
      return { code: 500, errMsg: '写入失败' };
    };
    store.accept(metadata(4));
    await nextTick(); await turn();
    assert.equal(calls.length, 1);
    assert.equal(sessions.value[0]?.isRead, false);
    active.value = null;
    await nextTick();
    active.value = sessions.value[0]!.id;
    await nextTick(); await turn(); await nextTick();
    assert.equal(sessions.value[0]?.isRead, false);
    assert.equal(calls.length, 2);
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

test('实际侧栏亮暗两种分支都渲染四态，并隐藏已读标记', async () => {
  const server = await createServer({ root: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), optimizeDeps: { noDiscovery: true, include: [], entries: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { default: Tree } = await server.ssrLoadModule('/src/components/chat/SidebarWorkspaceTree.vue');
    const sessions = ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING'].map((renderStatus, index) => ({
      id: String(index), title: renderStatus, isRead: false, renderStatus,
    }));
    sessions.push({ id: 'read', title: '已读', isRead: true, renderStatus: 'FAILED' });
    sessions.find(session => session.renderStatus === 'RUNNING')!.isRead = true;
    for (const isDark of [false, true]) {
      const html = await renderToString(createSSRApp(Tree, {
        projectGroups: [], unassignedSessions: sessions, expandedWorkspaces: {},
        branchedMenuItems: [{ label: '历史对话', children: [...sessions.map(session => ({ label: session.title, value: session.id, raw: session })), { label: '展开显示', value: 'more' }] }],
        branchedOpenIndices: [0], editingSessionId: null, editingTitle: ref(''), activeMenuWorkspaceId: null,
        activeSessionId: null, isCollapsed: false, isDark, limitSessions: (_key: string, items: unknown[]) => items,
        isFullyExpanded: () => true, toggleFullyExpanded() {}, toggleWorkspaceExpand() {}, isWorkspaceActive: () => false,
        handleSelectWorkspace() {}, handleNewSessionInProject() {}, toggleProjectMenu() {}, handleDeleteProject() {},
        startEdit() {}, saveEdit() {}, handleBranchedSelect() {}, handleBranchedToggle() {}, actions: {},
      }));
      for (const state of ['WAITING', 'COMPLETED', 'FAILED', 'RUNNING']) {
        assert.equal(html.split(`data-state="${state}"`).length - 1, 1, `${isDark}:${state}`);
      }
      assert.ok(html.includes('session-running-bars'));
    }
  } finally {
    await server.close();
  }
});
