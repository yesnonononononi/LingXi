import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AgentEvent, InvokeRetryEvent } from '../src/types/Event';
import type { ChatMessage, ChatSession } from '../src/types/chat';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { toAgentEvent } from '../src/views/chat/agentEventNarrowing';
import { upsertBlockIntoBubble } from '../src/views/chat/blockProjection';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';

const metaData = { turnId: '9007199254741000', sessionId: '7' };
const failed = '9007199254740992';
const next = '9007199254740993';

test('真实 HTTP 重试经业务落库生成的事件，可回放为唯一成功正文和权威用量', () => {
  const frames = JSON.parse(readFileSync(new URL('./fixtures/modelRetryFrames.json', import.meta.url), 'utf8')) as AgentEvent[];
  const first = frames.find(frame => frame.type === 'EXECUTION_STARTED')!;
  const root: ChatSession = { id: first.metaData!.sessionId!, title: '回放', createdAt: 0, updatedAt: 0,
    modelId: '7', activeTools: [], messages: [] };
  const router = new StreamSessionRouter();
  router.bindRootSession(root);
  for (const frame of frames) {
    const received = toAgentEvent({ event: frame.type, data: frame, raw: JSON.stringify(frame) });
    assert.ok(received?.data);
    router.dispatch(received.data);
    if (frame.type === 'INVOKE_RETRY') {
      const bubble = root.messages.find(message => message.role === 'assistant')!;
      assert.equal(bubble.isComplete, false);
      assert.equal(bubble.modelRetry?.responseId, frame.responseId);
      assert.equal(typeof bubble.modelRetry?.retryDelay, 'number');
      assert.equal(bubble.aiMessages?.length, 0);
    }
  }
  const replies = root.messages.filter(message => message.role === 'assistant');
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.content, 'recovered');
  assert.equal(replies[0]!.tokenInfo?.totalTokenCount, 5);
  assert.equal(replies[0]!.modelRetry, undefined);
  assert.equal(replies[0]!.isComplete, true);
  assert.equal(replies[0]!.failed, false);
});

test('子会话重试按事件归属路由，不改变根会话的运行状态', () => {
  const root: ChatSession = { id: '7', title: '主会话', createdAt: 0, updatedAt: 0, modelId: '1',
    activeTools: [], messages: [], subSessions: [{ id: '8', rootSessionId: '7', name: '成员', messages: [] }] };
  const router = new StreamSessionRouter();
  router.bindRootSession(root);
  router.dispatch({ type: 'EXECUTION_STARTED', executionId: 'root', timestamp: '', metaData });
  const childMeta = { rootSessionId: '7', sessionId: '8', turnId: '901', parentTurnId: metaData.turnId };
  router.dispatch({ type: 'EXECUTION_STARTED', executionId: 'child', timestamp: '', metaData: childMeta });
  router.dispatch({ ...retry(), executionId: 'child', metaData: childMeta });
  assert.equal(root.messages[0]?.modelRetry, undefined);
  assert.equal(root.messages[0]?.isThinking, true);
  assert.equal(root.subSessions?.[0]?.messages?.[0]?.modelRetry?.responseId, failed);
});
function retry(responseId = failed, retryCount = 1): InvokeRetryEvent {
  return { type: 'INVOKE_RETRY', executionId: 'e', timestamp: '', metaData,
    responseId, retryCount, retryDelay: 750, timeUnit: 'MILLISECONDS' };
}
function partial(responseId = failed, thinking = false): AgentEvent {
  return { type: thinking ? 'PARTIAL_THINKING' : 'PARTIAL_TEXT', executionId: 'e', timestamp: '', metaData,
    responseId, content: thinking ? '思考片段' : '未完成片段', offset: 0, order: thinking ? 0 : 1 };
}
function setup() {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e', timestamp: '', metaData });
  return { reducer, bubble: messages[0]! };
}

test('重试事件通过流入口收窄，保留权威响应和轮次身份', () => {
  const event = toAgentEvent({ event: 'INVOKE_RETRY', data: retry(), raw: '' });
  assert.equal(event?.data.type, 'INVOKE_RETRY');
  assert.equal((event?.data as InvokeRetryEvent).responseId, failed);
  assert.equal(event?.data.metaData?.turnId, metaData.turnId);
});

test('等待重试仍在运行，撤下失败尝试的正文与思考，保留先前成功轮次', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('9007199254740991'));
  reducer.consume(partial());
  reducer.consume(partial(failed, true));
  reducer.consume(retry());
  assert.equal(bubble.isComplete, false);
  assert.equal(bubble.isThinking, true);
  assert.equal(bubble.failed, undefined);
  assert.deepEqual(bubble.modelRetry, { responseId: failed, retryCount: 1, retryDelay: 750 });
  assert.equal(bubble.turnState?.texts[`text:${failed}`], undefined);
  assert.equal(bubble.turnState?.texts[`thinking:${failed}`], undefined);
  assert.equal(bubble.aiMessages?.length, 1);
  assert.equal(bubble.aiMessages?.[0]?.responseId, '9007199254740991');
});

test('失败尝试的迟到文本与快照不能复活，新响应可正常接续并清除提示', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial());
  reducer.consume(retry());
  reducer.consume(partial());
  reducer.consume(partial(failed, true));
  upsertBlockIntoBubble(bubble, { sessionId: '7', turnId: metaData.turnId, status: 'RUNNING', viewVersion: '2', blocks: [
    { blockId: `text:${failed}`, responseId: failed, type: 'TEXT', order: 1, status: 'COMPLETE', text: '迟到旧快照' },
  ] });
  assert.equal(bubble.aiMessages?.length, 0);
  reducer.consume(partial(next));
  assert.equal(bubble.modelRetry, undefined);
  assert.equal(bubble.aiMessages?.[0]?.responseId, next);
});

test('重复与乱序重试事件不会覆盖较新等待状态', () => {
  const { reducer, bubble } = setup();
  reducer.consume(retry());
  reducer.consume(retry(next, 2));
  reducer.consume(retry());
  assert.equal(bubble.modelRetry?.responseId, next);
  assert.equal(bubble.modelRetry?.retryCount, 2);
});

test('新响应先到时，迟到重试只撤下旧尝试，不重开等待提示', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial(next));
  reducer.consume(retry());
  assert.equal(bubble.modelRetry, undefined);
  assert.equal(bubble.aiMessages?.[0]?.responseId, next);
});

test('新尝试的空流片段不能撤下重试提示，也不能阻挡随后到达的重试事件', () => {
  const { reducer, bubble } = setup();
  reducer.consume(retry());
  for (const type of ['PARTIAL_TEXT', 'PARTIAL_THINKING'] as const) {
    reducer.consume({ ...partial(next), type, content: '' });
    assert.equal(bubble.modelRetry?.responseId, failed);
    assert.equal(bubble.turnState?.texts[`text:${next}`], undefined);
    assert.equal(bubble.turnState?.texts[`thinking:${next}`], undefined);
  }
  reducer.consume(retry(next, 2));
  assert.equal(bubble.modelRetry?.responseId, next);
  reducer.consume(partial('9007199254740994', true));
  assert.equal(bubble.modelRetry, undefined);
});

for (const type of ['EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_CANCELLED', 'EXECUTION_SUSPENDED'] as const) {
  test(`${type} 清除重试提示，迟到重试不能重开运行态`, () => {
    const { reducer, bubble } = setup();
    reducer.consume(retry());
    reducer.consume({ type, executionId: 'e', timestamp: '', metaData });
    assert.equal(bubble.modelRetry, undefined);
    reducer.consume(retry(next, 2));
    assert.equal(bubble.modelRetry, undefined);
    assert.equal(bubble.isThinking, false);
  });
}
