import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, effectScope, nextTick, ref } from 'vue';
import { useChatOutcomeNotifications } from '../src/views/chat/useChatOutcomeNotifications';
import type { AgentEvent } from '../src/types/Event';
import type { ChatSession, ToolCallVO } from '../src/types/chat';

function card(overrides: Partial<ToolCallVO> = {}): ToolCallVO {
  return { id: '401', type: 'PROMISE', status: 'pending', content: { kind: 'CHOICE', question: '请选择' },
    allowedActions: ['ANSWER'], ...overrides } as ToolCallVO;
}
function event(type: string, owner = '7', turnId = '301'): AgentEvent {
  return { type, executionId: '901', timestamp: '', metaData: { sessionId: owner, rootSessionId: '7', turnId } } as AgentEvent;
}
function fixture(t: test.TestContext) {
  const session = ref<ChatSession>({ id: '7', title: '主任务', createdAt: 0, updatedAt: 0, modelId: '1', activeTools: [],
    runStatus: 'SUSPENDED', messages: [{ id: 'answer', role: 'assistant', content: '', timestamp: 0, turnId: '301' }],
    subSessions: [{ id: '8', rootSessionId: '7', runStatus: 'RUNNING', name: '工程师', messages: [] }] });
  const notifications: unknown[][] = [];
  const scope = effectScope();
  const listener = scope.run(() => useChatOutcomeNotifications({ session: computed(() => session.value),
    notify: async (...args) => { notifications.push(args); return true; } }))!;
  t.after(() => scope.stop());
  return { session, notifications, listener, scope };
}

test('根执行驻留等待子会话和协作输入时，不提示用户确认', async t => {
  const f = fixture(t);
  f.listener.onEvent(event('EXECUTION_STARTED', '8', '302'));
  f.listener.onEvent(event('EXECUTION_SUSPENDED'));
  await nextTick();
  assert.equal(f.notifications.length, 0);
  // 同一根执行随后出现真实提问，证明静默不是因为通知接线失效。
  f.session.value.messages[0]!.promptCards = [card()];
  await nextTick();
  assert.deepEqual(f.notifications, [['7', 'suspended', '主任务']]);
});

for (const candidate of [
  card({ status: 'preparing' }), card({ status: 'in_progress' }), card({ status: 'completed' }),
  card({ allowedActions: [] }), card({ allowedActions: undefined }), card({ type: 'EXECUTE' }),
  card({ content: { kind: 'UNKNOWN' } }), card({ content: { kind: 'CHOICE' }, allowedActions: ['APPROVE'] }),
]) {
  test(`未可操作卡片不触发确认：${JSON.stringify(candidate)}`, async t => {
    const f = fixture(t);
    f.session.value.messages[0]!.promptCards = [candidate];
    f.listener.onEvent(event('EXECUTION_SUSPENDED'));
    await nextTick();
    assert.equal(f.notifications.length, 0);
  });
}

for (const kind of ['PLAN', 'CHOICE', 'COMMAND']) {
  test(`${kind} 就绪后才提醒，子代理仍运行也不能屏蔽真实确认`, async t => {
    const f = fixture(t);
    f.session.value.messages[0]!.promptCards = [card({ status: 'preparing', content: { kind },
      allowedActions: kind === 'CHOICE' ? ['ANSWER'] : ['APPROVE', 'REJECT'] })];
    f.listener.onEvent(event('EXECUTION_SUSPENDED'));
    await nextTick();
    assert.equal(f.notifications.length, 0);
    f.session.value.messages[0]!.promptCards![0]!.status = 'pending';
    await nextTick();
    assert.equal(f.notifications.length, 1);
    f.session.value.messages[0]!.promptCards!.push(card());
    await nextTick();
    assert.equal(f.notifications.length, 1, '同一挂起的多张卡片只触发一次通知');
  });
}

test('旧轮卡片和子执行自己的挂起不能冒充根执行的确认', async t => {
  const f = fixture(t);
  f.session.value.messages[0]!.promptCards = [card()];
  f.listener.onEvent(event('EXECUTION_SUSPENDED', '8', '302'));
  await nextTick();
  assert.equal(f.notifications.length, 0);
  f.listener.onEvent(event('EXECUTION_SUSPENDED', '7', '303'));
  await nextTick();
  assert.equal(f.notifications.length, 0);
  f.session.value.messages.push({ id: 'new', role: 'assistant', content: '', timestamp: 0, turnId: '303', promptCards: [card()] });
  await nextTick();
  assert.equal(f.notifications.length, 1);
});

for (const type of ['EXECUTION_RESUME', 'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_CANCELLED']) {
  test(`${type} 后迟到卡片不再发确认通知`, async t => {
    const f = fixture(t);
    f.listener.onEvent(event('EXECUTION_SUSPENDED'));
    await nextTick();
    f.listener.onEvent(event(type));
    await nextTick();
    f.session.value.messages[0]!.promptCards = [card()];
    await nextTick();
    assert.equal(f.notifications.some(args => args[1] === 'suspended'), false);
    if (type === 'EXECUTION_COMPLETED') assert.equal(f.notifications[0]?.[1], 'completed');
    if (type === 'EXECUTION_FAILED') assert.equal(f.notifications[0]?.[1], 'failed');
    if (type === 'EXECUTION_CANCELLED') assert.equal(f.notifications[0]?.[1], 'cancelled');
  });
}

test('切走会话或权威状态恢复运行，取消尚未就绪的确认通知', async t => {
  const f = fixture(t);
  f.listener.onEvent(event('EXECUTION_SUSPENDED'));
  await nextTick();
  f.session.value.runStatus = 'RUNNING';
  await nextTick();
  f.session.value.runStatus = 'SUSPENDED';
  f.session.value.messages[0]!.promptCards = [card()];
  await nextTick();
  assert.equal(f.notifications.length, 0);
  f.session.value.messages[0]!.promptCards = [];
  f.listener.onEvent(event('EXECUTION_SUSPENDED'));
  await nextTick();
  f.session.value = { ...f.session.value, id: '9', title: '另一会话', messages: [{ ...f.session.value.messages[0]!, promptCards: [card()] }] };
  await nextTick();
  assert.equal(f.notifications.length, 0);
});
