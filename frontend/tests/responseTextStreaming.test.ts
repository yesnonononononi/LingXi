import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../src/types/Event';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { upsertBlockIntoBubble, upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { applyTextPlacement, getTurnState, writeResponseText } from '../src/views/chat/turnRenderState';
import { AgentToolName } from '../src/utils/toolNames';
import { compareResponsePosition } from '../src/utils/responseOrder';

const metadata = { sessionId: '7', turnId: '900' };
function setup() {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e', timestamp: '', metaData: metadata });
  return { messages, reducer, bubble: messages[0]! };
}
function partial(content: string, offset: number, responseId = '101', thinking = false): AgentEvent {
  return { type: thinking ? 'PARTIAL_THINKING' : 'PARTIAL_TEXT', executionId: 'e', timestamp: '',
    metaData: metadata, responseId, content, offset };
}
function view(text?: string, isBody = true, responseId = '101'): TurnViewVO {
  return { sessionId: '7', turnId: '900', status: 'RUNNING', viewVersion: '2', blocks: text === undefined ? [] : [
    { blockId: `text:${responseId}`, responseId, type: 'TEXT', order: 1, status: 'COMPLETE', isBody, text },
  ] };
}
function snapshot(reducer: TurnStreamReducer, current: TurnViewVO) {
  reducer.consume({ type: 'TURN_SNAPSHOT', executionId: 'e', timestamp: '', sessionId: '7', turnId: '900',
    viewVersion: current.viewVersion, view: current });
}

function assertPendingText(bubble: ChatMessage, text: string, responseId = '101'): void {
  assert.equal(bubble.content, '', '用途未确认时不能进入正文');
  assert.equal(bubble.aiMessages?.find(item => item.id === `text:${responseId}`)?.text, text);
  assert.equal(bubble.turnState?.texts[`text:${responseId}`]?.isBody, undefined);
}

test('框架位置：超安全整数的相邻响应按 BigInt 排序，迟到旧响应不能抢占正文', () => {
  const { reducer, bubble } = setup();
  const earlier = '9007199254740992';
  const later = '9007199254740993';
  reducer.consume({ ...partial('新正文', 0, later), order: 1 });
  reducer.consume({ ...partial('旧正文', 0, earlier), order: 1 });
  assertPendingText(bubble, '新正文', later);
  assert.deepEqual(bubble.aiMessages?.map(item => item.responseId), [earlier, later]);
  reducer.consume({ ...partial('新思考', 0, later, true), order: 0 });
  reducer.consume({ ...partial('旧思考', 0, earlier, true), order: 0 });
  assert.deepEqual(bubble.thoughtSteps?.map(step => step.content), ['旧思考', '新思考']);
  const blocks: TurnViewVO['blocks'] = [
    { blockId: `thinking:${later}`, responseId: later, type: 'THINKING', order: 0, status: 'COMPLETE', text: '新思考' },
    { blockId: `text:${later}`, responseId: later, type: 'TEXT', order: 1, status: 'COMPLETE', isBody: true, text: '新正文' },
    { blockId: `thinking:${earlier}`, responseId: earlier, type: 'THINKING', order: 0, status: 'COMPLETE', text: '旧思考' },
    { blockId: `text:${earlier}`, responseId: earlier, type: 'TEXT', order: 1, status: 'COMPLETE', isBody: false, text: '旧正文' },
    { blockId: 'tool:c2', responseId: earlier, type: 'TOOL', toolCallId: 'c2', toolName: AgentToolName.ReadFile,
      order: 3, status: 'STARTED', arguments: '{"path":"second.md"}' },
    { blockId: 'tool:c1', responseId: earlier, type: 'TOOL', toolCallId: 'c1', toolName: AgentToolName.ReadFile,
      order: 2, status: 'STARTED', arguments: '{"path":"first.md"}' },
  ];
  snapshot(reducer, { ...view(), blocks });
  assert.deepEqual(bubble.processTimeline?.map(item => item.id), [
    `thinking:${earlier}`, `text:${earlier}`, 'tool:c1', 'tool:c2', `thinking:${later}`,
  ]);
  const history: ChatMessage[] = [];
  upsertTurnViewIntoMessages(history, { ...view(), blocks }, new Map());
  assert.equal(history.at(-1)?.content, bubble.content);
  assert.deepEqual(history.at(-1)?.processTimeline, bubble.processTimeline);
});

test('响应身份不是数字时明确失败，不能用本地序号兼容旧 UUID', () => {
  assert.throws(() => compareResponsePosition(
    { responseId: '6f1a1c2e-9b3d-4a5f-8e7c-0d1b2a3c4d5e', order: 0 },
    { responseId: '9007199254740993', order: 1 }), SyntaxError);
});

test('用途统一：持续打印到完整结构确认，finishReason 不能代替后端 isBody', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('检索', 0), order: 1 });
  assertPendingText(bubble, '检索');
  reducer.consume({ ...partial('完成', 2), order: 1 });
  assertPendingText(bubble, '检索完成');
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: '检索完成。', order: 1,
    meta: { finishReason: 'TOOL_EXECUTION' }, executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, undefined);
  assertPendingText(bubble, '检索完成。');
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: '检索完成。', isBody: true, order: 1,
    executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, true);
  assert.equal(bubble.content, '检索完成。');
  assert.equal(bubble.aiMessages?.length, 0);
});

test('用途统一：完整响应在工具启动前归入过程，重复全文不重复打印', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('先读文件', 0), order: 1 });
  assertPendingText(bubble, '先读文件');
  const resolved: AgentEvent = { type: 'AI_MESSAGE', responseId: '101', text: '先读文件', thinking: '分析',
    isBody: false, order: 1, thinkingOrder: 0, executionId: 'e', timestamp: '', metaData: metadata };
  reducer.consume(resolved);
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '先读文件');
  assert.equal(bubble.toolCalls?.length, 0, '用途确认无需等待工具开始或快照');
  reducer.consume(resolved);
  assert.equal(bubble.aiMessages?.length, 1);
  assert.equal(bubble.thoughtSteps?.length, 1);
  reducer.consume({ ...partial('最终结论', 0, '102'), order: 1001 });
  reducer.consume(resolved);
  assertPendingText(bubble, '最终结论', '102');
  snapshot(reducer, view('先读文件', false));
  assert.equal(bubble.aiMessages?.length, 2);
  assertPendingText(bubble, '最终结论', '102');
  reducer.consume({ type: 'AI_MESSAGE', responseId: '102', order: 1001, text: '最终结论', isBody: true,
    executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.content, '最终结论');
  assert.equal(bubble.aiMessages?.length, 1);
});

test('用途统一：工具事件只采用明确字段，不通过工具名或调用状态猜用途', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('未确定用途', 0), order: 1 });
  const tool: AgentEvent = { type: 'TOOL_CALL', responseId: '101', requestId: 'c1', toolName: AgentToolName.ReadFile,
    order: 2, args: '{"path":"a.md"}', executionId: 'e', timestamp: '', metaData: metadata };
  reducer.consume(tool);
  assertPendingText(bubble, '未确定用途');
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, undefined);
  reducer.consume({ ...tool, type: 'TOOL_COMPLETED', resultStatus: 'FAILED', isBody: false, output: '读取失败' });
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '未确定用途');
  assert.equal(bubble.toolCalls?.[0]?.status, 'failed');
});

test('第二版：快照缺少的历史块与实时块都保留在同一份状态', () => {
  const { reducer, bubble } = setup();
  snapshot(reducer, { ...view(), blocks: [
    { blockId: 'thinking:100', responseId: '100', type: 'THINKING', order: 0, status: 'COMPLETE', text: '已有思考' },
    { blockId: 'tool:old', type: 'TOOL', toolCallId: 'old', toolName: AgentToolName.ReadFile, order: 2, status: 'COMPLETED' },
  ] });
  reducer.consume({ ...partial('新思考', 0, '101', true), order: 1000 });
  snapshot(reducer, view());
  assert.deepEqual(bubble.thoughtSteps?.map(step => step.content), ['已有思考', '新思考']);
  assert.equal(bubble.toolCalls?.[0]?.id, 'old');
  assert.equal(Object.keys(bubble.turnState!.texts).length, 2);
  assert.equal(Object.keys(bubble.turnState!.tools).length, 1);
});

test('第二版：工具先于文本先归过程，终态快照 isBody:true 升级为正文', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ type: 'TOOL_CALL', responseId: '101', requestId: 'c1', toolName: AgentToolName.ReadFile,
    order: 2, isBody: false, executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ ...partial('先读文件', 0), order: 1 });
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '先读文件');
  snapshot(reducer, view('先读文件', true));
  assert.equal(bubble.content, '先读文件', 'false → true 升级：终态快照把过程文本提升为正文');
  assert.equal(bubble.aiMessages?.length, 0, '升级后必须从过程区移出');
});

test('第二版：较早响应的迟到增量不能抢占较新正文', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('旧', 0), order: 1 });
  reducer.consume({ ...partial('新正文', 0, '102'), order: 1001 });
  reducer.consume({ ...partial('响应', 1), order: 1 });
  assertPendingText(bubble, '新正文', '102');
  assert.equal(bubble.turnState?.texts['text:101']?.text, '旧响应');
  reducer.consume({ type: 'AI_MESSAGE', responseId: '102', order: 1001, text: '新正文', isBody: true,
    executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ ...partial('迟到', 3), order: 1 });
  assert.equal(bubble.content, '新正文', '旧响应的迟到片段不能覆盖已确认正文');
  assert.equal(bubble.aiMessages?.[0]?.text, '旧响应迟到');
});

test('第二版：旧运行快照不能重开终态或解除挂起，恢复事件之后继续打印', () => {
  for (const type of ['EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_CANCELLED', 'EXECUTION_SUSPENDED'] as const) {
    const { reducer, bubble } = setup();
    reducer.consume({ ...partial('已打印', 0), order: 1 });
    reducer.consume({ type, executionId: 'e', timestamp: '', metaData: metadata });
    snapshot(reducer, view());
    reducer.consume({ ...partial('迟到', 3), order: 1 });
    assertPendingText(bubble, '已打印');
    assert.equal(bubble.isThinking, false);
    if (type === 'EXECUTION_SUSPENDED') {
      assert.equal(bubble.isSuspended, true);
      reducer.consume({ type: 'EXECUTION_RESUME', executionId: 'e', timestamp: '', metaData: metadata });
      reducer.consume({ ...partial('恢复正文', 0, '102'), order: 1001 });
      assertPendingText(bubble, '恢复正文', '102');
    } else assert.equal(bubble.isComplete, true);
  }
});

test('第二版：流式、块更新和刷新历史生成相同展示', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('分析', 0, '101', true), order: 0 });
  reducer.consume({ ...partial('先读', 0), order: 1 });
  reducer.consume({ ...partial('文件', 2), order: 1 });
  reducer.consume({ type: 'TOOL_CALL', responseId: '101', requestId: 'c1', toolName: AgentToolName.EditFile,
    order: 2, isBody: false, args: '{"path":"a.md"}', executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ ...partial('最终结论', 0, '102'), order: 1001 });
  const finalView: TurnViewVO = { ...view(), status: 'COMPLETED', blocks: [
    { blockId: 'thinking:101', responseId: '101', type: 'THINKING', order: 0, status: 'COMPLETE', text: '分析' },
    { blockId: 'text:101', responseId: '101', type: 'TEXT', order: 1, status: 'COMPLETE', isBody: false, text: '先读文件' },
    { blockId: 'tool:c1', responseId: '101', type: 'TOOL', toolCallId: 'c1', toolName: AgentToolName.EditFile, order: 2, status: 'COMPLETED',
      arguments: '{"path":"a.md"}', output: '{"outcome":"SUCCEEDED","output":"{\\"plusLines\\":2,\\"minusLines\\":0}"}' },
    { blockId: 'text:102', responseId: '102', type: 'TEXT', order: 1001, status: 'COMPLETE', isBody: true, text: '最终结论' },
  ] };
  upsertBlockIntoBubble(bubble, finalView);
  const history: ChatMessage[] = [];
  upsertTurnViewIntoMessages(history, finalView, new Map());
  const rendered = (current: ChatMessage) => ({ content: current.content, thoughtSteps: current.thoughtSteps,
    aiMessages: current.aiMessages, toolCalls: current.toolCalls, processTimeline: current.processTimeline });
  assert.deepEqual(rendered(bubble), rendered(history[0]!));
});

test('没有完成事件、快照和对账时，每个片段到达立即打印', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('检索', 0));
  assertPendingText(bubble, '检索');
  reducer.consume(partial('完成', 2));
  assertPendingText(bubble, '检索完成');
  reducer.consume(partial('。', 4));
  assertPendingText(bubble, '检索完成。');
  assert.equal(bubble.isComplete, false);
});

test('重复片段、全文完成和历史回查共用 offset 写入，不重复打印', () => {
  const { reducer, bubble, messages } = setup();
  const event = partial('检索', 0);
  reducer.consume(event);
  reducer.consume(event);
  assertPendingText(bubble, '检索');
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: '检索完成。',
    executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: '检索完成。', thinking: '查询资料',
    executionId: 'e', timestamp: '', metaData: metadata });
  upsertTurnViewIntoMessages(messages, view('检索完成。'), new Map());
  snapshot(reducer, view('检索完成。'));
  assert.equal(bubble.content, '检索完成。');
  assert.equal(bubble.thoughtSteps?.[0]?.content, '查询资料');
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1);
});

test('慢历史缺少当前响应或只带较短前缀时，不清空已打印文本', () => {
  const { reducer, bubble, messages } = setup();
  reducer.consume(partial('检索完成。', 0));
  snapshot(reducer, view());
  assertPendingText(bubble, '检索完成。');
  upsertTurnViewIntoMessages(messages, view('检索'), new Map());
  assert.equal(bubble.content, '检索完成。');
  reducer.consume(partial('继续', 5));
  assert.equal(bubble.content, '检索完成。继续', '较短历史不能提前结束流式响应');
});

test('思考与正文的偏移独立，新模型响应使用自己的身份', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('分析', 0, '101', true));
  reducer.consume(partial('问题', 2, '101', true));
  reducer.consume(partial('先查资料', 0));
  assert.equal(bubble.thoughtSteps?.[0]?.content, '分析问题');
  assertPendingText(bubble, '先查资料');
  reducer.consume({ type: 'TOOL_CALL', responseId: '101', requestId: 'c1', toolName: AgentToolName.WebSearch,
    isBody: false, executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '先查资料');
  reducer.consume(partial('查询结论', 0, '102'));
  snapshot(reducer, view('先查资料', 'PROCESS'));
  assertPendingText(bubble, '查询结论', '102');
  assert.equal(bubble.aiMessages?.length, 2);
});

test('缺口补齐后打印连续文本，emoji 使用 UTF-16 偏移', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('完成', 2));
  assert.equal(bubble.content, '');
  reducer.consume(partial('🔎', 0));
  assertPendingText(bubble, '🔎完成');
});

test('同一响应出现不一致的重叠文本时告警并保留原文', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { bubble } = setup();
  writeResponseText(bubble, 'text:101', 'TEXT', 0, '检索');
  assert.equal(writeResponseText(bubble, 'text:101', 'TEXT', 0, '错误'), null);
  assert.equal(bubble.turnState?.texts['text:101']?.text, '检索');
  assert.equal(warn.mock.callCount(), 1);
});

test('挂起和终态之后的迟到片段不能恢复运行或创建第二个气泡', () => {
  for (const type of ['EXECUTION_SUSPENDED', 'EXECUTION_COMPLETED', 'EXECUTION_CANCELLED', 'EXECUTION_FAILED'] as const) {
    const { reducer, bubble, messages } = setup();
    reducer.consume(partial('已打印', 0));
    reducer.consume({ type, executionId: 'e', timestamp: '', metaData: metadata });
    reducer.consume(partial('迟到', 3));
    assertPendingText(bubble, '已打印');
    assert.equal(messages.length, 1);
    assert.equal(bubble.isThinking, false);
  }
});

test('挂起恢复后的新响应继续打印，已完成响应拒绝迟到片段', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('第一段', 0));
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: '第一段', executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume(partial('迟到', 3));
  assertPendingText(bubble, '第一段');
  reducer.consume({ type: 'EXECUTION_SUSPENDED', executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ type: 'EXECUTION_RESUME', executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume(partial('恢复后的正文', 0, '102'));
  assertPendingText(bubble, '恢复后的正文', '102');
});

test('纯工具响应允许空正文，下一响应仍能流式打印', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: null,
    executionId: 'e', timestamp: '', metaData: metadata, meta: { finishReason: 'TOOL_EXECUTION' } });
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: null, thinking: null,
    executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume(partial('工具之后的正文', 0, '102'));
  assertPendingText(bubble, '工具之后的正文', '102');
});

test('较早响应的迟到全文不能抢占当前正在打印的正文', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('先查资料', 0));
  reducer.consume(partial('查询结论', 0, '102'));
  reducer.consume({ type: 'AI_MESSAGE', responseId: '102', order: 1, text: '查询结论', isBody: true,
    executionId: 'e', timestamp: '', metaData: metadata });
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: '先查资料',
    executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.content, '查询结论');
});

test('未提供增量的下一响应也能通过全文显示', () => {
  const { reducer, bubble } = setup();
  for (const responseId of ['101', '102']) {
    reducer.consume({ type: 'COMPLETE_TEXT', responseId, content: responseId,
      executionId: 'e', timestamp: '', metaData: metadata });
    assert.equal(bubble.aiMessages?.find(item => item.id === `text:${responseId}`)?.text, responseId);
    reducer.consume({ type: 'AI_MESSAGE', responseId, text: responseId, isBody: true,
      executionId: 'e', timestamp: '', metaData: metadata });
    assert.equal(bubble.content, responseId);
  }
});

test('失败提示在后续快照和块更新后仍然只显示一次', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('已打印', 0));
  reducer.consume({ type: 'EXECUTION_FAILED', errMsg: '模型请求失败', executionId: 'e', timestamp: '', metaData: metadata });
  snapshot(reducer, { ...view(), status: 'FAILED' });
  upsertBlockIntoBubble(bubble, view('已打印'));
  assert.equal(bubble.content, '已打印\n\n模型请求失败');
});

test('慢快照缺少实时工具或仅有较早运行态时，不清空工具也不回退结论', () => {
  const { reducer, bubble } = setup();
  const call: AgentEvent = { type: 'TOOL_CALL', responseId: '101', requestId: 'c1', toolName: AgentToolName.ReadFile,
    order: 2, args: '{"path":"a.md"}', executionId: 'e', timestamp: '', metaData: metadata };
  reducer.consume(call);
  snapshot(reducer, view());
  assert.equal(bubble.toolCalls?.[0]?.status, 'calling');
  reducer.consume({ ...call, type: 'TOOL_COMPLETED', resultStatus: 'COMPLETED', output: '实际结果' });
  const slow: TurnViewVO = { ...view(), blocks: [{ type: 'TOOL', blockId: 'tool:c1', toolCallId: 'c1',
    order: 2, status: 'STARTED', toolName: AgentToolName.ReadFile }] };
  snapshot(reducer, slow);
  assert.equal(bubble.toolCalls?.[0]?.status, 'success');
  assert.equal(bubble.toolCalls?.[0]?.result, '实际结果');
  assert.equal(bubble.toolCalls?.[0]?.query, '{"path":"a.md"}');
  upsertBlockIntoBubble(bubble, slow);
  assert.equal(bubble.toolCalls?.length, 1);
  assert.equal(bubble.toolCalls?.[0]?.status, 'success');
});

test('仅有收尾事件也显示真实调用，PROMISED 和未知状态不冒充成功', () => {
  for (const [resultStatus, expected] of [['PROMISED', 'pending'], ['FAILED', 'failed'], [undefined, 'unknown']] as const) {
    const { reducer, bubble } = setup();
    reducer.consume({ type: 'TOOL_COMPLETED', requestId: 'c1', responseId: '101', order: 2,
      toolName: AgentToolName.ExecuteCommand, args: '{"command":"pwd"}', output: '结果', resultStatus,
      executionId: 'e', timestamp: '', metaData: metadata });
    assert.equal(bubble.toolCalls?.[0]?.status, expected);
    if (resultStatus === 'PROMISED') {
      reducer.consume({ type: 'TOOL_CALL', requestId: 'c1', toolName: AgentToolName.ExecuteCommand,
        executionId: 'e', timestamp: '', metaData: metadata });
      assert.equal(bubble.toolCalls?.[0]?.status, 'pending');
    }
  }
});

/**
 * ★ 语义翻转护栏 1：正文黏性 —— 只允许 false → true 升级，一旦定正文（true）不接受任何降级。
 *
 * <p>true 只在终态快照时由后端给出；迟到的 / 乱序的 false 帧绝不能把已定正文拉回过程区。
 * 这条正是从旧的「PROCESS 黏性」翻转过来的核心不变量。</p>
 */
test('★ 正文黏性：isBody:true 一旦确定不接受任何降级（迟到的旧帧不得拉回过程区）', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('正文', 0), order: 1 });
  const resolved: AgentEvent = { type: 'AI_MESSAGE', responseId: '101', text: '正文', isBody: true,
    order: 1, executionId: 'e', timestamp: '', metaData: metadata };
  reducer.consume(resolved);
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, true);
  assert.equal(bubble.content, '正文');

  // 迟到 / 乱序的同 responseId false 帧到达：绝不降级
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: '正文', isBody: false,
    order: 1, executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, true, 'true 不可降级');
  assert.equal(bubble.content, '正文', '正文保持');
  assert.equal(bubble.aiMessages?.length, 0, '正文不得回落到过程区');

  // 即便经过快照整轮重放（含 false）也不降级
  snapshot(reducer, view('正文', false));
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, true, '快照携带 false 也不得降级');
  assert.equal(bubble.content, '正文');
});

/**
 * ★ 语义翻转护栏 2：false → true 可升级 —— 终态快照把过程文本提升为正文。
 */
test('★ 正文升级：false → true 允许（终态快照把过程文本提升为正文）', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('过程文本', 0), order: 1 });
  reducer.consume({ type: 'AI_MESSAGE', responseId: '101', text: '过程文本', isBody: false,
    order: 1, executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '过程文本');
  assert.ok((bubble.processTimeline ?? []).some(item => item.id === 'text:101'), '升级前在过程时间线');

  snapshot(reducer, view('过程文本', true));
  assert.equal(bubble.turnState?.texts['text:101']?.isBody, true);
  assert.equal(bubble.content, '过程文本', '升级后进入正文');
  assert.equal(bubble.aiMessages?.length, 0, '升级后从过程区移出');
  assert.ok(!(bubble.processTimeline ?? []).some(item => item.id === 'text:101'), '升级后从过程时间线移出');
});

/**
 * ★ 反向保障：isBody 缺失（undefined）时不写字段 —— 不伪造后端用途。
 */
test('★ 不伪造后端用途：isBody 缺失时不写字段（保持 undefined）', () => {
  const { reducer, bubble } = setup();
  reducer.consume({ ...partial('未确定', 0), order: 1 });
  const buffer = bubble.turnState?.texts['text:101'];
  assert.ok(buffer);
  assert.equal('isBody' in buffer, false, '缺失即尚未确定，绝不写入字段');
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: '未确定', order: 1,
    meta: { finishReason: 'TOOL_EXECUTION' }, executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal('isBody' in (bubble.turnState?.texts['text:101'] ?? {}), false);
  assert.equal(bubble.content, '', '未确定用途仍在过程区');
});

/**
 * ★ applyTextPlacement 直接单测：true 不可降级、false 可升级、undefined 不写。
 */
test('★ applyTextPlacement 直接单测：true 不可降级，false 可升级，undefined 不写', () => {
  const bubble: ChatMessage = { id: 'b', role: 'assistant', content: '', timestamp: 0 };
  writeResponseText(bubble, 'text:101', 'TEXT', 0, '正文');
  applyTextPlacement(bubble, 'text:101', true);
  applyTextPlacement(bubble, 'text:101', false);
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true, 'true 不接受降级');
  applyTextPlacement(bubble, 'text:101', undefined);
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true, 'undefined 不覆盖已确定值');

  writeResponseText(bubble, 'text:202', 'TEXT', 0, '待定');
  applyTextPlacement(bubble, 'text:202', undefined);
  assert.equal('isBody' in getTurnState(bubble).texts['text:202']!, false, '缺失不写字段');
  applyTextPlacement(bubble, 'text:202', false);
  assert.equal(getTurnState(bubble).texts['text:202']?.isBody, false);
  applyTextPlacement(bubble, 'text:202', true);
  assert.equal(getTurnState(bubble).texts['text:202']?.isBody, true, 'false → true 可升级');
});
