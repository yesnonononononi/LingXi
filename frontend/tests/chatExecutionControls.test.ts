import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, effectScope, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { AgentAPI } from '../src/services/agent';
import http from '../src/services/interceptor';
import { useChatExecutionControls } from '../src/views/chat/useChatExecutionControls';
import { acceptsChatEvent, applyResendAcceptance } from '../src/views/chat/chatExecutionState';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { chatApi } from '../src/services/chat';
import type { ChatAcceptance, ChatMessage, ChatSession, ToolCallVO } from '../src/types/chat';
import type { AgentEvent } from '../src/types/Event';
import type { TurnViewVO } from '../src/types/block';

const original: ChatMessage = { id: 'display-user-1', serverMessageId: '9007199254740993',
  role: 'user', turnId: '101', content: '原问题', timestamp: 1, imageUrls: ['data:image/png;base64,cHJvYmU='] };
function session(): ChatSession {
  return { id: '500', title: '验证会话', modelId: '7', createdAt: 1, updatedAt: 1, activeTools: [], runStatus: 'IDLE',
    messages: [{ ...original }, { id: 'answer-1', role: 'assistant', turnId: '101', content: '旧回答', timestamp: 2 },
      { id: 'user-2', role: 'user', turnId: '102', content: '后续问题', timestamp: 3 }],
    turns: {}, turnViews: {}, turnViewVersions: new Map([['101', 2], ['102', 1]]) };
}
function receipt(): ChatAcceptance {
  return { sessionId: '500', turnId: '103', historyRevision: '2', invalidatedTurnIds: ['101', '102'], invalidatedExecutionIds: ['901', '902'] };
}
function fixture() {
  const current = ref<ChatSession>(session());
  const scope = effectScope();
  const reconciled: string[] = [];
  let ready: (id: string) => Promise<boolean> = async () => true;
  const controls = scope.run(() => useChatExecutionControls({
    session: computed(() => current.value), isSubmitting: computed(() => false),
    ensureSubscribed: id => ready(id), reconcile: async id => { reconciled.push(id); },
    buildCommand: input => ({ input, sessionId: current.value.id, modelId: '7', workspaceId: 0, agentId: 0, workDir: '', requirePlan: false }),
    onResendAccepted: () => {},
  }))!;
  return { current, scope, controls, reconciled, setReady: (fn: typeof ready) => { ready = fn; } };
}

test('暂停识别业务失败，恢复长请求显式关闭默认超时', async t => {
  const post = t.mock.method(http, 'post', async () => ({ code: 0, errMsg: '不能暂停' }));
  await assert.rejects(AgentAPI.suspend('500'), /不能暂停/);
  post.mock.mockImplementation(async () => '');
  await AgentAPI.suspend('500');
  post.mock.mockImplementation(async () => ({ code: 1, data: '完成' }));
  await AgentAPI.resume('500');
  assert.equal(post.mock.calls.at(-1)!.arguments[0], '/a/completion/500/resume');
  assert.deepEqual(post.mock.calls.at(-1)!.arguments[2], { timeout: 0 });
});

test('历史重发表单带服务端消息 ID 与原图片，雪花 ID 不转 Number', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 1, data: receipt() }));
  await AgentAPI.resendCommand({ input: '改写问题', messageId: original.serverMessageId!, sessionId: '500',
    modelId: '9007199254740995', workspaceId: 0, agentId: 0, workDir: '', requirePlan: false, imageUrl: original.imageUrls });
  assert.match(String(fetch.mock.calls[0]!.arguments[0]), /\/a\/completion\/resend$/);
  const body = fetch.mock.calls[0]!.arguments[1]!.body as FormData;
  assert.equal(body.get('messageId'), '9007199254740993');
  assert.equal(body.get('modelId'), '9007199254740995');
  assert.deepEqual(body.getAll('imageUrl'), original.imageUrls);
});

test('视图补入真实消息 ID，更新已有乐观气泡而不把展示 ID 当服务端 ID', () => {
  const messages: ChatMessage[] = [{ id: 'local-display', role: 'user', content: '原问题', turnId: '101', timestamp: 1 }];
  const view: TurnViewVO = { sessionId: '500', turnId: '101', status: 'COMPLETED', viewVersion: '1',
    userMessage: '原问题', userMessageId: original.serverMessageId, blocks: [] };
  upsertTurnViewIntoMessages(messages, view, new Map());
  assert.equal(messages[0]!.id, 'local-display');
  assert.equal(messages[0]!.serverMessageId, '9007199254740993');
});

test('实时快照给已有用户气泡补齐真实消息 ID，首个回答到达时也不重复用户气泡', () => {
  for (const hasAnswer of [false, true]) {
    const current = session();
    current.messages = [{ ...original, serverMessageId: undefined }];
    if (hasAnswer) current.messages.push({ id: 'answer', role: 'assistant', turnId: '101', content: '', timestamp: 2 });
    const router = new StreamSessionRouter();
    router.bindRootSession(current);
    const user = current.messages[0]!;
    const snapshot: AgentEvent = { type: 'TURN_SNAPSHOT', timestamp: '', executionId: '901', sessionId: '500',
      turnId: '101', viewVersion: '2', view: { sessionId: '500', turnId: '101', viewVersion: '2', status: 'COMPLETED',
        userMessage: '原问题', userMessageId: original.serverMessageId, blocks: [] } };
    router.dispatch(snapshot);
    assert.equal(user.serverMessageId, original.serverMessageId);
    assert.deepEqual(current.messages.filter(message => message.role === 'user'), [user]);
    router.dispatch({ ...snapshot, viewVersion: '1', view: { ...snapshot.view, userMessageId: '1' } });
    assert.equal(user.serverMessageId, original.serverMessageId);
    router.dispose();
  }
});

test('恢复等待权威事件，不伪造执行状态，恢复前先等订阅就绪', async t => {
  const resume = t.mock.method(AgentAPI, 'resume', async () => ({ code: 1, data: '不是消息正文' }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.current.value.runStatus = 'SUSPENDED';
  f.setReady(async () => false);
  await f.controls.resume();
  assert.equal(resume.mock.calls.length, 0);
  f.setReady(async () => true);
  await f.controls.resume();
  assert.equal(resume.mock.calls.length, 1);
  assert.equal(f.current.value.runStatus, 'SUSPENDED');
  assert.equal(f.current.value.messages[1]!.content, '旧回答');
});

test('未决卡片禁止普通恢复，必须走原卡片决策链路', async t => {
  const resume = t.mock.method(AgentAPI, 'resume', async () => ({ code: 1, data: '' }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.current.value.runStatus = 'SUSPENDED';
  f.current.value.messages[1]!.promptCards = [{ id: 'choice', type: 'PROMISE', status: 'pending' } as ToolCallVO];
  assert.equal(f.controls.canResume.value, false);
  await f.controls.resume();
  assert.equal(resume.mock.calls.length, 0);
});

test('取消编辑不调用接口，缺少真实消息 ID 时不提供历史重发', async t => {
  const resend = t.mock.method(AgentAPI, 'resendCommand', async () => ({ code: 1, data: receipt() }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.controls.edit({ ...original, serverMessageId: undefined });
  assert.equal(f.controls.editTarget.value, null);
  f.controls.edit({ ...original, unsent: true });
  assert.equal(f.controls.editTarget.value, null);
  f.controls.edit(f.current.value.messages[0]!);
  f.controls.draft.value = '改写';
  f.controls.cancelEdit();
  await f.controls.resend();
  assert.equal(resend.mock.calls.length, 0);
  assert.equal(f.current.value.messages[0]!.content, '原问题');
});

test('受理成功后才按回执作废原轮次及后续轮次，保留已经到达的新轮次', async t => {
  const resend = t.mock.method(AgentAPI, 'resendCommand', async () => ({ code: 1, data: receipt() }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.current.value.messages.push({ id: 'new-answer', role: 'assistant', turnId: '103', content: '新的输出', timestamp: 4 });
  f.controls.edit(f.current.value.messages[0]!);
  f.controls.draft.value = '改写后的问题';
  await f.controls.resend();
  const command = resend.mock.calls[0]!.arguments[0];
  assert.equal(command.messageId, original.serverMessageId);
  assert.equal(command.input, '改写后的问题');
  assert.deepEqual(command.imageUrl, original.imageUrls);
  assert.deepEqual(f.current.value.messages.map(message => message.turnId), ['103']);
  assert.equal(f.current.value.historyRevision, '2');
  assert.equal(f.controls.editTarget.value, null);
  assert.equal(f.current.value.turnViewVersions?.has('101'), false);
});

test('重发失败保留原对话和编辑稿，不乐观删除历史', async t => {
  t.mock.method(AgentAPI, 'resendCommand', async () => ({ code: 0, errMsg: '执行登记失败' }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.controls.edit(f.current.value.messages[0]!);
  f.controls.draft.value = '仍需保留的编辑稿';
  await f.controls.resend();
  assert.equal(f.current.value.messages.length, 3);
  assert.equal(f.controls.draft.value, '仍需保留的编辑稿');
  assert.ok(f.controls.editTarget.value);
  assert.equal(f.controls.error.value, '执行登记失败');
});

test('在途重发禁止重复提交，等待订阅期间切换会话不提交旧编辑', async t => {
  let finish!: (value: boolean) => void;
  const gate = new Promise<boolean>(resolve => { finish = resolve; });
  const resend = t.mock.method(AgentAPI, 'resendCommand', async () => ({ code: 1, data: receipt() }));
  const f = fixture(); t.after(() => f.scope.stop());
  f.setReady(async () => gate);
  f.controls.edit(f.current.value.messages[0]!);
  const pending = f.controls.resend();
  await f.controls.resend();
  f.current.value = { ...session(), id: '600' };
  await nextTick();
  finish(true);
  await pending;
  assert.equal(resend.mock.calls.length, 0);
  assert.equal(f.controls.editTarget.value, null);
});

test('作废轮次的迟到块与生命周期帧不能恢复旧气泡，合法新轮次仍可显示', () => {
  const current = session();
  applyResendAcceptance(current, receipt());
  const router = new StreamSessionRouter();
  router.bindRootSession(current);
  const snapshot = (turnId: string): AgentEvent => ({ type: 'TURN_SNAPSHOT', timestamp: '', executionId: '901',
    sessionId: '500', turnId, viewVersion: '1', view: { sessionId: '500', turnId, viewVersion: '1',
      status: 'COMPLETED', userMessage: '旧帧或新帧', blocks: [] } });
  router.dispatch(snapshot('101'));
  assert.deepEqual(current.messages, []);
  assert.equal(acceptsChatEvent(current, { type: 'EXECUTION_COMPLETED', timestamp: '', executionId: '901',
    metaData: { sessionId: '500', turnId: '101' } }), false);
  router.dispatch(snapshot('103'));
  assert.ok(current.messages.some(message => message.turnId === '103'));
  router.dispose();
});

test('缺少作废范围的回执不能被前端猜测补齐', () => {
  const current = session();
  assert.throws(() => applyResendAcceptance(current, { sessionId: '500', turnId: '103' }));
  assert.equal(current.messages.length, 3);
});

test('重发期间历史翻页已返回但还在等待动画，旧页不能补回作废轮次', async t => {
  setActivePinia(createPinia());
  const current = ref(session());
  current.value.hasMoreMessages = true;
  current.value.nextMessageCursor = '100';
  t.mock.method(chatApi, 'fetchSessionMessages', async () => ({ ok: true as const, data: {
    records: [], turns: {}, turnViews: { '101': { sessionId: '500', turnId: '101', status: 'COMPLETED',
      viewVersion: '3', userMessage: '已经作废的旧问题', blocks: [] } }, hasMore: false, nextCursor: null,
  } }));
  let release!: () => void;
  let notifyScheduled!: () => void;
  const scheduled = new Promise<void>(resolve => { notifyScheduled = resolve; });
  const history = useChatHistory({ currentActiveSession: computed(() => current.value), localSessions: ref([current.value]),
    messagesContainerRef: ref(null), scheduleTimeout: handler => { release = handler; notifyScheduled(); return 0; } });
  const pending = history.handleLoadMoreHistory();
  await scheduled;
  applyResendAcceptance(current.value, receipt());
  release();
  await pending;
  assert.deepEqual(current.value.messages, []);
  assert.equal(current.value.turnViews?.['101'], undefined);
});
