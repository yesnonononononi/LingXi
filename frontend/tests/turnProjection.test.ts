import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { AgentToolName } from '../src/utils/toolNames';

function view(turnVersion: string, toolVersion: string, output: string): TurnViewVO {
  return { sessionId: '7', turnId: '900', viewVersion: turnVersion, status: 'COMPLETED',
    blocks: [{ blockId: 'tool:c1', type: 'TOOL', responseId: '101', order: 2,
      toolCallId: 'c1', toolName: AgentToolName.ReadFile, status: 'COMPLETED', version: toolVersion, output }] };
}

test('历史与 SSE 共用版本：两种到达顺序都不能让旧终态结果覆盖新结果', () => {
  for (const historyFirst of [true, false]) {
    const messages: ChatMessage[] = [];
    const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
    const newer = view('10', '4', '新结果');
    const older = view('9', '3', '旧结果');
    const feed = (current: TurnViewVO) => reducer.consume({ type: 'TURN_SNAPSHOT',
      sessionId: '7', turnId: '900', viewVersion: current.viewVersion, view: current });
    if (historyFirst) {
      upsertTurnViewIntoMessages(messages, newer);
      feed(older);
    } else {
      feed(newer);
      upsertTurnViewIntoMessages(messages, older);
    }
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.toolCalls?.[0]?.result, '新结果');
    assert.equal(messages[0]?.turnState?.viewVersion, 10);
    reducer.dispose();
  }
});

test('轮次版本相等时，工具按持久化版本推进，旧终态和原始工具事件均不覆盖权威结果', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  upsertTurnViewIntoMessages(messages, view('5', '1', '初始结果'));
  const newer = view('5', '3', '权威结果');
  reducer.consume({ type: 'BLOCK_UPSERT', sessionId: '7', turnId: '900', viewVersion: '5', view: newer });
  assert.equal(messages[0]?.toolCalls?.[0]?.result, '权威结果');
  upsertTurnViewIntoMessages(messages, view('5', '2', '过期结果'));
  reducer.consume({ type: 'TOOL_COMPLETED', executionId: 'e', timestamp: '',
    metaData: { sessionId: '7', turnId: '900' }, requestId: 'c1', toolName: AgentToolName.ReadFile,
    resultStatus: 'COMPLETED', output: '原始事件结果' });
  assert.equal(messages[0]?.toolCalls?.[0]?.result, '权威结果');
  assert.equal(messages[0]?.toolCalls?.[0]?.version, 3);
  reducer.dispose();
});

test('快照与历史走同一用户气泡更新入口，补齐图片与消息主键', () => {
  const messages: ChatMessage[] = [{ id: 'user', role: 'user', turnId: '900', content: '问题', timestamp: 0 }];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  const current = { ...view('2', '1', '结果'), userMessageId: '901', userImageUrls: ['/image.png'] };
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '2', view: current });
  assert.equal(messages[0]?.serverMessageId, '901');
  assert.deepEqual(messages[0]?.imageUrls, ['/image.png']);
  reducer.dispose();
});
