import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../src/types/Event';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { consumeToolEvent } from '../src/views/chat/toolStream';
import { applyTextPlacement, getTurnState } from '../src/views/chat/turnRenderState';
import { AgentToolName } from '../src/utils/toolNames';

/**
 * QA2 独立验证：前端只按后端 {@code isBody} 分流，且方向单一（false → true 可升级，true → false 不可降级）。
 *
 * <p>与实现者的 {@code responseTextStreaming.test.ts} 分离，重点攻击：</p>
 * <ul>
 *   <li>C1 true 不可降级（迟到事件 + 快照重放两条途径）；</li>
 *   <li>C2 false → true 升级（过程区 → 正文区，且从过程时间线移出）；</li>
 *   <li>C3 undefined 不写字段（不伪造后端用途）；</li>
 *   <li>C4 {@code toolStream.ts:30} 用「存在性判断」而非真值判断 —— 构造 {@code isBody:false}
 *       的工具事件，验证该分支确实被执行（实现者未对此写判别性断言，属覆盖盲区）；</li>
 *   <li>C5 语义翻转：旧「PROCESS 黏性」不变量已被<b>有意反转</b>为「允许升级」。</li>
 * </ul>
 */

const metadata = { sessionId: '7', turnId: '900' };

function setup() {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e', timestamp: '', metaData: metadata });
  return { messages, reducer, bubble: messages[0]! };
}

function partial(content: string, offset: number, responseId = '101'): AgentEvent {
  return { type: 'PARTIAL_TEXT', executionId: 'e', timestamp: '', metaData: metadata, responseId, content, offset };
}

function aiMessage(text: string, isBody: boolean | undefined, responseId = '101', order = 1): AgentEvent {
  return { type: 'AI_MESSAGE', executionId: 'e', timestamp: '', metaData: metadata, responseId, text, isBody, order };
}

function toolCall(isBody: boolean, responseId = '101', requestId = 'c1'): AgentEvent {
  return { type: 'TOOL_CALL', executionId: 'e', timestamp: '', metaData: metadata, responseId, requestId,
    toolName: AgentToolName.ReadFile, order: 2, isBody, args: '{"path":"a.md"}' };
}

function view(text: string, isBody: boolean, responseId = '101'): TurnViewVO {
  return { sessionId: '7', turnId: '900', status: 'RUNNING', viewVersion: '2', blocks: [
    { blockId: `text:${responseId}`, responseId, type: 'TEXT', order: 1, status: 'COMPLETE', isBody, text },
  ] };
}

function snapshot(reducer: TurnStreamReducer, current: TurnViewVO): void {
  reducer.consume({ type: 'TURN_SNAPSHOT', executionId: 'e', timestamp: '', sessionId: '7', turnId: '900',
    viewVersion: current.viewVersion, view: current });
}

// ─────────────────────────── C1 ───────────────────────────

test('C1 ★ true 不可降级：迟到 false 事件与快照重放都不得把正文拉回过程区', () => {
  const { reducer, bubble } = setup();
  reducer.consume(aiMessage('正文', true));
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true);
  assert.equal(bubble.content, '正文');

  // 途径 (a)：同一 responseId 的迟到 / 乱序 false 事件
  reducer.consume(aiMessage('正文', false));
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true, 'true 不接受事件降级');
  assert.equal(bubble.content, '正文', '正文内容不得改变');
  assert.equal(bubble.aiMessages?.length, 0, '不得回落到过程区');

  // 途径 (b)：整轮快照重放（携带 false）
  snapshot(reducer, view('正文', false));
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true, 'true 不接受快照降级');
  assert.equal(bubble.content, '正文');
  assert.equal(bubble.aiMessages?.length, 0);
});

// ─────────────────────────── C2 ───────────────────────────

test('C2 ★ false → true 升级：终态快照把过程文本提升为正文，并移出过程时间线', () => {
  const { reducer, bubble } = setup();
  reducer.consume(aiMessage('过程文本', false));
  assert.equal(bubble.content, '');
  assert.equal(bubble.aiMessages?.[0]?.text, '过程文本');
  assert.ok((bubble.processTimeline ?? []).some(item => item.id === 'text:101'), '升级前在过程时间线');

  snapshot(reducer, view('过程文本', true));
  assert.equal(getTurnState(bubble).texts['text:101']?.isBody, true);
  assert.equal(bubble.content, '过程文本', '升级后进入正文');
  assert.equal(bubble.aiMessages?.length, 0, '升级后从 aiMessages 移出');
  assert.ok(!(bubble.processTimeline ?? []).some(item => item.id === 'text:101'), '升级后从过程时间线移出');
});

// ─────────────────────────── C3 ───────────────────────────

test('C3 ★ undefined 不写字段：不伪造后端用途', () => {
  const { reducer, bubble } = setup();
  reducer.consume(partial('未定', 0));
  assert.equal('isBody' in getTurnState(bubble).texts['text:101']!, false, '缺失即尚未确定，绝不写入字段');

  // COMPLETE_TEXT 也不带 isBody
  reducer.consume({ type: 'COMPLETE_TEXT', responseId: '101', content: '未定', order: 1,
    executionId: 'e', timestamp: '', metaData: metadata });
  assert.equal('isBody' in getTurnState(bubble).texts['text:101']!, false);
  assert.equal(bubble.content, '', '用途未定仍在过程区');

  // 直接调用：undefined 不得覆盖、也不得写入
  applyTextPlacement(bubble, 'text:101', undefined);
  assert.equal('isBody' in getTurnState(bubble).texts['text:101']!, false);
});

// ─────────────────────────── C4 ───────────────────────────

test('C4 ★ toolStream 存在性判断：isBody:false 的工具事件必须走进分支（不是被真值判断吞掉）', () => {
  // 直接单测 consumeToolEvent：无任何前置文本，工具事件带 isBody:false。
  // 若该处写成真值判断（event.isBody），false 为 falsy → 分支被跳过 → 缓冲不会被创建。
  const bubble: ChatMessage = { id: 'b', role: 'assistant', content: '', timestamp: 0 };
  const consumed = consumeToolEvent(bubble, toolCall(false));
  assert.equal(consumed, true, '工具事件应被消费');
  const buffer = getTurnState(bubble).texts['text:101'];
  assert.ok(buffer, 'isBody:false 必须写出文本缓冲，证明走的是 event.isBody !== undefined 分支');
  assert.equal(buffer.isBody, false);
});

test('C4 ★ 经由真实 reducer：TOOL_CALL isBody:false 亦写入 false（端到端）', () => {
  const { reducer, bubble } = setup();
  reducer.consume(toolCall(false));
  const buffer = getTurnState(bubble).texts['text:101'];
  assert.ok(buffer, '工具事件应创建该响应的文本缓冲');
  assert.equal(buffer.isBody, false, 'false 是有效值，必须写入而非被跳过');
});

// ─────────────────────────── C5 ───────────────────────────

test('C5 ★ 语义翻转证据：旧「PROCESS 黏性」被有意反转 —— 现在允许 false → true 升级', () => {
  // 旧 cjs 用例断言「工具先置 PROCESS 后，快照 BODY 不得搬回正文」；新语义下同一序列必须升级。
  const { reducer, bubble } = setup();
  reducer.consume(toolCall(false));
  reducer.consume(partial('先读文件', 0));
  assert.equal(bubble.content, '');
  snapshot(reducer, view('先读文件', true));
  assert.equal(bubble.content, '先读文件', '反转后允许升级为正文（旧守卫已不存在）');
});
