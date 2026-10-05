import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import type { SessionBootstrapVO } from '../src/types/chat';

/**
 * 缺陷 1 派生回答气泡的边界核验（纯派生层，不经 SSE 接线）。
 *
 * <p>派生气泡是本轮全新代码路径：锚点插入逻辑一旦错位会出现「一条回答两个气泡」，
 * 而这类错位在主路径（base 非空、USER 行已落库）上看不出来。</p>
 */
function setupStore() {
  setActivePinia(createPinia());
  return useStreamV3Store();
}

function snapshot(overrides: Partial<SessionBootstrapVO> = {}): SessionBootstrapVO {
  return {
    rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [], executions: [], ...overrides,
  };
}

const userRow = (id: string, turnId: string, text: string) =>
  ({ id, sessionId: '100', turnId, type: 'USER', text }) as any;
const aiRow = (id: string, turnId: string, text: string) =>
  ({ id, sessionId: '100', turnId, type: 'AI', text }) as any;

test('边界：空历史下派生一条，反复重算不增加', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot());
  store.applyFrame('100', { type: 'RESPONSE_STARTED', streamKey: 'k1', sessionId: '100', turnId: 't1', executionId: 'e1', data: { streamKey: 'k1' } } as any);
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'k1', sessionId: '100', turnId: 't1', executionId: 'e1', data: { streamKey: 'k1', delta: '正文' } } as any);

  const first = projectSessionMessages('100');
  const second = projectSessionMessages('100');
  const third = projectSessionMessages('100');
  assert.equal(first.filter(m => m.content.includes('正文')).length, 1);
  assert.equal(second.filter(m => m.content.includes('正文')).length, 1, '重算后气泡数变了');
  assert.equal(third.filter(m => m.content.includes('正文')).length, 1, '重算后气泡数变了');
});

test('边界：锚在末尾哨兵时（base 为空）只出现一次', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot());
  // 两个不同轮次同时在流：分别锚在末尾，验证不会互相吞掉或重复
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'k1', sessionId: '100', turnId: 't1', executionId: 'e1', data: { streamKey: 'k1', delta: '甲' } } as any);
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'k2', sessionId: '100', turnId: 't2', executionId: 'e2', data: { streamKey: 'k2', delta: '乙' } } as any);
  const messages = projectSessionMessages('100');
  assert.equal(messages.filter(m => m.content === '甲').length, 1, '轮次 t1 气泡数不对');
  assert.equal(messages.filter(m => m.content === '乙').length, 1, '轮次 t2 气泡数不对');
});

test('边界：派生气泡紧跟本轮 USER 行，不跨轮串位', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot({ history: { records: [userRow('1', 't1', '问一'), aiRow('2', 't1', '答一'), userRow('3', 't2', '问二')], turns: {}, nextCursor: null, hasMore: false } }));
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'k9', sessionId: '100', turnId: 't2', executionId: 'e9', data: { streamKey: 'k9', delta: '答二正文' } } as any);
  const messages = projectSessionMessages('100');
  const idxUser2 = messages.findIndex(m => m.content === '问二');
  const idxAnswer2 = messages.findIndex(m => m.content === '答二正文');
  assert.ok(idxUser2 >= 0 && idxAnswer2 >= 0, '本轮气泡缺失');
  assert.equal(idxAnswer2, idxUser2 + 1, '派生回答气泡没有紧跟本轮提问');
  assert.equal(messages.filter(m => m.content === '答二正文').length, 1);
});

test('边界：AI 行落库后归并为一条，不出现两个气泡', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot({ history: { records: [userRow('1', 't1', '问一')], turns: {}, nextCursor: null, hasMore: false } }));
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'k1', sessionId: '100', turnId: 't1', executionId: 'e1', data: { streamKey: 'k1', delta: '流式正文' } } as any);
  assert.equal(projectSessionMessages('100').filter(m => m.content.includes('流式正文')).length, 1);

  // AI 行落库：响应被绑定 messageId 退出活响应集合
  store.applyFrame('100', { type: 'MESSAGE_COMMITTED', streamKey: 'k1', sessionId: '100', turnId: 't1', executionId: 'e1', data: { messageId: '2', sessionId: '100', turnId: 't1', type: 'AI', text: '流式正文', streamKey: 'k1' } } as any);
  const after = projectSessionMessages('100');
  assert.equal(after.filter(m => m.content.includes('流式正文')).length, 1, '落库后出现重复气泡');
});

test('边界：同轮次两个 streamKey 合并进同一个气泡', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot({ history: { records: [userRow('1', 't1', '问一'), aiRow('2', 't1', '已提交段')], turns: {}, nextCursor: null, hasMore: false } }));
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'kA', sessionId: '100', turnId: 't1', executionId: 'eA', data: { streamKey: 'kA', delta: '续写段' } } as any);
  const messages = projectSessionMessages('100');
  const host = messages.filter(m => m.content.includes('续写段'));
  assert.equal(host.length, 1, '同轮次两个 streamKey 未合并到同一气泡');
  assert.ok(host[0].content.includes('已提交段'), '追加语义丢失：已提交段被覆盖');
});

test('边界：卡片气泡不被当成回答宿主挂上正文', () => {
  const store = setupStore();
  store.beginSync('100');
  store.onStreamReady('100', { type: 'STREAM_READY', data: { connectionId: 'c1', schemaVersion: 3 } } as any);
  store.applyBootstrap('100', snapshot({ history: { records: [userRow('1', 't1', '问一')], turns: {}, nextCursor: null, hasMore: false } }));
  // 先到一张无宿主卡片（气泡 id 以 msg-card- 开头）
  store.applyFrame('100', { type: 'TOOL_CALL_UPDATED', sessionId: '100', turnId: 't1', data: { id: 'card-1', conversationId: '100', type: 'PROMISE', status: 'pending', pending: true, allowedActions: ['APPROVE'], version: '1', title: '审批', content: { kind: 'PLAN', title: '计划', text: '计划正文' } } } as any);
  // turnId 未知的活响应：应挂到真实回答，不能挂到卡片气泡
  store.applyFrame('100', { type: 'TEXT_DELTA', streamKey: 'kX', sessionId: '100', turnId: null, executionId: 'eX', data: { streamKey: 'kX', delta: '无归属正文' } } as any);
  const messages = projectSessionMessages('100');
  const cardBubble = messages.find(m => m.id.startsWith('msg-card-'));
  assert.ok(cardBubble, '卡片气泡未生成');
  assert.equal(cardBubble.content, '', '正文被挂到了卡片气泡上');
});
