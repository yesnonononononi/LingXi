import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { AgentToolName } from '../src/utils/toolNames';
import { buildProcessTimeline } from '../src/utils/processTimeline';
import { summarizeProcess } from '../src/utils/processSegments';
import { effect, reactive, stop } from 'vue';

function view(turnVersion: string, toolVersion: string, output: string): TurnViewVO {
  return { sessionId: '7', turnId: '900', viewVersion: turnVersion, status: 'COMPLETED',
    blocks: [{ blockId: 'tool:c1', type: 'TOOL', responseId: '101', order: 2,
      toolCallId: 'c1', toolName: AgentToolName.ReadFile, status: 'COMPLETED', version: toolVersion, output }] };
}

test('命令批准后的新版本块解除待确认，旧快照与无版本事件不能回退状态', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  const commandView = (version: string, status: 'PROMISED' | 'STARTED' | 'COMPLETED'): TurnViewVO => ({
    sessionId: '7', turnId: '900', viewVersion: '5', status: 'RUNNING',
    blocks: [{ blockId: 'tool:command', type: 'TOOL', responseId: '101', order: 2,
      toolCallId: 'command', toolName: AgentToolName.ExecuteCommand, status, version }],
  });
  const feed = (current: TurnViewVO) => reducer.consume({ type: 'BLOCK_UPSERT',
    sessionId: '7', turnId: '900', viewVersion: current.viewVersion, view: current });
  try {
    upsertTurnViewIntoMessages(messages, commandView('1', 'PROMISED'));
    const summary = () => summarizeProcess(buildProcessTimeline(messages[0]!));
    assert.equal(summary().pendingCount, 1);
    feed(commandView('2', 'STARTED'));
    assert.equal(messages[0]!.toolCalls![0]!.status, 'calling');
    assert.equal(summary().pendingCount, 0);
    assert.equal(summary().runningCount, 1);
    feed(commandView('1', 'PROMISED'));
    upsertTurnViewIntoMessages(messages, commandView('1', 'PROMISED'));
    reducer.consume({ type: 'TOOL_COMPLETED', executionId: 'e', timestamp: '',
      metaData: { sessionId: '7', turnId: '900' }, requestId: 'command',
      toolName: AgentToolName.ExecuteCommand, resultStatus: 'PROMISED' });
    assert.equal(summary().pendingCount, 0);
    assert.equal(summary().runningCount, 1);
    feed(commandView('3', 'COMPLETED'));
    assert.equal(messages[0]!.toolCalls![0]!.status, 'success');
    assert.equal(summary().pendingCount, 0);
    assert.equal(summary().runningCount, 0);
  } finally {
    reducer.dispose();
  }
});

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

test('连续文本只修改原条目，工具数组与对象保持稳定，新增与迟到位置仍按后端顺序展示', () => {
  const messages = reactive<ChatMessage[]>([]);
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  const metadata = { sessionId: '7', turnId: '900' };
  reducer.consume({ type: 'PARTIAL_THINKING', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', order: 0, offset: 0, content: '先检查' });
  reducer.consume({ type: 'TOOL_CALL', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', order: 3, requestId: 'later', toolName: AgentToolName.ReadFile, args: '{}' });
  const bubble = messages[0]!;
  const tools = bubble.toolCalls;
  const tool = tools![0];
  const thoughts = bubble.thoughtSteps;
  const thought = thoughts![0];
  let toolProjectionRuns = 0;
  const observer = effect(() => {
    bubble.toolCalls?.map(item => item.id);
    toolProjectionRuns++;
  });
  reducer.consume({ type: 'PARTIAL_THINKING', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', order: 0, offset: 3, content: '文件' });
  assert.equal(bubble.toolCalls, tools);
  assert.equal(bubble.toolCalls![0], tool);
  assert.equal(bubble.thoughtSteps, thoughts);
  assert.equal(bubble.thoughtSteps![0], thought);
  assert.equal(thought?.content, '先检查文件');
  assert.equal(toolProjectionRuns, 1, '文本增长不能使只订阅工具集合的投影失效');
  reducer.consume({ type: 'TOOL_COMPLETED', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', order: 3, requestId: 'later', toolName: AgentToolName.ReadFile,
    resultStatus: 'COMPLETED', output: '结果' });
  assert.equal(bubble.toolCalls, tools);
  assert.equal(bubble.toolCalls![0], tool);
  assert.equal(tool?.status, 'success');
  reducer.consume({ type: 'TOOL_CALL', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', order: 2, requestId: 'earlier', toolName: AgentToolName.ReadFile, args: '{}' });
  assert.deepEqual(buildProcessTimeline(bubble).map(item => item.id), ['thinking:101', 'earlier', 'later']);
  assert.equal(toolProjectionRuns, 2, '新增工具必须触发集合更新');
  stop(observer);
  reducer.dispose();
});
