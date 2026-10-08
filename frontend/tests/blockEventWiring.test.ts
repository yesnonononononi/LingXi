/**
 * 实时块事件接入守卫（P3 第一步）。
 *
 * <p>只验证「事件能进、落点正确、乱序被拦」——**不**动既有排序/去重逻辑（那属于下一步）。
 * 这两条是「替换 allocateOrder / 内容指纹」的前提。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types/chat';
import type { AgentEvent } from '../src/types/Event';
import type { Block, TurnViewVO } from '../src/types/block';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';

function view(blocks: Block[], viewVersion: number, status = 'RUNNING'): TurnViewVO {
  return { sessionId: '7', turnId: '900', status, viewVersion, blocks };
}

function snapshotEvent(v: TurnViewVO, viewVersion = v.viewVersion): AgentEvent {
  return {
    type: 'TURN_SNAPSHOT',
    executionId: 'exec-1',
    timestamp: '2026-10-08T00:00:00Z',
    sessionId: v.sessionId,
    turnId: v.turnId,
    viewVersion,
    view: v,
    metaData: { turnId: v.turnId, sessionId: v.sessionId },
  } as unknown as AgentEvent;
}

function upsertEvent(v: TurnViewVO, viewVersion = v.viewVersion): AgentEvent {
  return {
    type: 'BLOCK_UPSERT',
    executionId: 'exec-1',
    timestamp: '2026-10-08T00:00:01Z',
    sessionId: v.sessionId,
    turnId: v.turnId,
    viewVersion,
    view: v,
    metaData: { turnId: v.turnId, sessionId: v.sessionId },
  } as unknown as AgentEvent;
}

const thinking = (): Block => ({ blockId: 'thinking:r1', type: 'THINKING', order: 0, status: 'DONE', content: '想法' });
const toolRunning = (): Block => ({ blockId: 'tool:c1', type: 'TOOL', order: 2, status: 'STREAMING', toolCallId: 'c1', toolName: 'read_file' });
const toolDone = (): Block => ({ blockId: 'tool:c1', type: 'TOOL', order: 2, status: 'DONE', toolCallId: 'c1', toolName: 'read_file' });

function seededReducer(): { reducer: TurnStreamReducer; messages: ChatMessage[] } {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: '7' });
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-1',
    timestamp: '2026-10-08T00:00:00Z',
    metaData: { turnId: '900', sessionId: '7' },
  });
  return { reducer, messages };
}

test('P3-1 TURN_SNAPSHOT 整轮投影到气泡（快照校准路径）', () => {
  const { reducer, messages } = seededReducer();
  reducer.consume(snapshotEvent(view([thinking(), toolRunning()], 3)));

  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.thoughtSteps?.length, 1, '思考块落到 thoughtSteps');
  assert.equal(bubble.toolCalls?.length, 1, '工具块落到 toolCalls');
  assert.equal(bubble.processTimeline?.length, 2, '时间线含两块');
});

test('P3-1 更小的 viewVersion 快照被丢弃（乱序旧帧不覆盖新内容）', () => {
  const { reducer, messages } = seededReducer();
  reducer.consume(snapshotEvent(view([thinking(), toolDone()], 5)));
  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.toolCalls?.length, 1);
  assert.equal(bubble.toolCalls?.[0].status, 'success');

  // 迟到的旧帧（版本 4 < 5）：必须被丢弃，不能把完成态打回 calling。
  reducer.consume(snapshotEvent(view([thinking(), toolRunning()], 4)));
  assert.equal(bubble.toolCalls?.[0].status, 'success', '旧帧必须被丢弃');
});

test('P3-1 BLOCK_UPSERT 按 blockId 覆盖，版本号相等也采纳', () => {
  const { reducer, messages } = seededReducer();
  reducer.consume(snapshotEvent(view([thinking(), toolRunning()], 5)));
  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.toolCalls?.[0].status, 'calling');

  // 同一 viewVersion（工具收尾不改 chat_turn）：必须采纳，且不新增第二条工具。
  reducer.consume(upsertEvent(view([toolDone()], 5)));
  assert.equal(bubble.toolCalls?.length, 1, '同 blockId 覆盖而非追加');
  assert.equal(bubble.toolCalls?.[0].status, 'success');
  assert.equal(bubble.thoughtSteps?.length, 1, '未变化的块保留');
});

test('P3-1 快照的轮次终态对齐气泡标志（WAITING/COMPLETED）', () => {
  const { reducer, messages } = seededReducer();
  const bubble = messages.find(m => m.role === 'assistant')!;

  reducer.consume(snapshotEvent(view([thinking()], 2, 'WAITING')));
  assert.equal(bubble.isSuspended, true, 'WAITING 应置挂起');
  assert.equal(bubble.isThinking, false);

  reducer.consume(snapshotEvent(view([thinking()], 3, 'COMPLETED')));
  assert.equal(bubble.isComplete, true, 'COMPLETED 应置终结');
  assert.equal(bubble.isSuspended, false);
});

test('P3-1 非法载荷（缺 view/blocks）静默忽略，不抛异常', () => {
  const { reducer } = seededReducer();
  assert.doesNotThrow(() => {
    reducer.consume({ type: 'TURN_SNAPSHOT', executionId: 'e', timestamp: '', metaData: { turnId: '900' } } as unknown as AgentEvent);
    reducer.consume({ type: 'BLOCK_UPSERT', executionId: 'e', timestamp: '', metaData: { turnId: '900' } } as unknown as AgentEvent);
  });
});

test('P3-1 无基线时增量不新建气泡（避免同轮两条气泡复发）', () => {
  const { reducer, messages } = seededReducer();
  const before = messages.length;
  // 该轮还没收到任何快照/历史 → 增量应被忽略，不凭空造气泡。
  reducer.consume(upsertEvent({ ...view([toolDone()], 5), turnId: '999' }));
  assert.equal(messages.length, before, '无基线时不得新建气泡');
});
