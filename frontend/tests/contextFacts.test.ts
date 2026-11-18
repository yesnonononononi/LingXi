import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextFactFeed,
  DEFAULT_CONTEXT_FACT_LIMIT,
  DEFAULT_CONTEXT_FACT_TTL_MS,
  toContextFactCard,
  type ContextFactCard,
} from '../src/utils/contextFacts';
import {useContextFacts} from '../src/composables/useContextFacts';

/** 造一条 CONTEXT_CHANGED：动态段被整段替换（框架契约：两侧全文都下发，但前端只留类别）。 */
function changedEvent(overrides: Record<string, unknown> = {}): {type: string} & Record<string, unknown> {
  return {
    type: 'CONTEXT_CHANGED',
    executionId: 'exec-1',
    reasons: ['DYNAMIC_SECTIONS_CHANGED'],
    changedSections: {
      MEMORY: {oldContent: '旧记忆', newContent: '新记忆'},
    },
    currentLiveBlocks: 3,
    maxLiveBlocks: 8,
    prefixPreserved: true,
    ...overrides,
  };
}

test('CONTEXT_CHANGED 被翻译成一张变更卡：只留类别与活片段，两侧全文不进卡片', () => {
  const card = toContextFactCard(changedEvent(), 1000);
  assert.ok(card, 'CONTEXT_CHANGED 必须产出卡片');
  assert.equal(card.kind, 'changed');
  assert.deepEqual(card.changedKinds, ['MEMORY']);
  assert.deepEqual(card.reasons, ['DYNAMIC_SECTIONS_CHANGED']);
  assert.deepEqual(card.liveBlocks, {current: 3, max: 8});
  assert.equal(card.prefixPreserved, true);
  assert.equal(card.createdAt, 1000);
  assert.equal(card.summaryGeneration, null);
  assert.equal(card.messageCount, null);
  // 明细已从上位需求里删掉：卡片对象本身不得再夹带任何一侧正文
  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes('旧记忆'), false);
  assert.equal(serialized.includes('新记忆'), false);
});

test('类别顺序按固定表输出，与后端 Map 的遍历顺序无关', () => {
  const card = toContextFactCard(changedEvent({
    changedSections: {
      TASK: {oldContent: 'a', newContent: 'b'},
      MCP: {oldContent: 'c', newContent: 'd'},
      MEMORY: {oldContent: 'e', newContent: 'f'},
    },
  }), 1);
  assert.deepEqual(card?.changedKinds, ['MCP', 'MEMORY', 'TASK']);
});

test('框架只给理由不给段明细时，类别为空列表而不是 undefined', () => {
  const card = toContextFactCard(changedEvent({changedSections: undefined}), 1);
  assert.deepEqual(card?.changedKinds, []);
});

test('prefixPreserved 缺省按「缓存前缀没了」处理：字段真缺失时不乐观', () => {
  const card = toContextFactCard(changedEvent({prefixPreserved: undefined}), 1);
  assert.equal(card?.prefixPreserved, false);
});

test('CONTEXT_REBUILT 被翻译成重建卡：代数与消息条数，且不给改动类别', () => {
  const card = toContextFactCard({
    type: 'CONTEXT_REBUILT',
    executionId: 'exec-2',
    summaryGeneration: 2,
    messageCount: 7,
  }, 5);
  assert.ok(card);
  assert.equal(card.kind, 'rebuilt');
  assert.equal(card.summaryGeneration, 2);
  assert.equal(card.messageCount, 7);
  assert.deepEqual(card.changedKinds, [], '重建是整份历史被换掉，不是「改了哪几段」');
});

test('不是这两类事实的事件一律返回 null，调用方据此继续走别的分支', () => {
  assert.equal(toContextFactCard({type: 'TEXT_DELTA'}, 1), null);
  assert.equal(toContextFactCard({type: 'CONTEXT_UPDATED'}, 1), null);
});

test('事实签名：同轮同类别同计数算同一事实，类别或活片段变了就是另一条', () => {
  const base = toContextFactCard(changedEvent(), 1);
  const sameFactLater = toContextFactCard(changedEvent(), 999);
  const otherKind = toContextFactCard(changedEvent({
    changedSections: {SKILL: {oldContent: 'x', newContent: 'y'}},
  }), 1);
  const otherLive = toContextFactCard(changedEvent({currentLiveBlocks: 4}), 1);

  assert.equal(base?.id, sameFactLater?.id, '时间戳不参与签名，否则同一事实会被当成两条');
  assert.notEqual(base?.id, otherKind?.id);
  assert.notEqual(base?.id, otherLive?.id, '同一轮里再改一次记忆，活片段计数变了必须另行提示');
  assert.notEqual(
    toContextFactCard({type: 'CONTEXT_REBUILT', executionId: 'e', summaryGeneration: 1, messageCount: 2}, 1)?.id,
    toContextFactCard({type: 'CONTEXT_REBUILT', executionId: 'e', summaryGeneration: 2, messageCount: 2}, 1)?.id,
  );
});

test('重复投递的同一份事实不会叠出第二张卡', () => {
  const feed = new ContextFactFeed(3);
  const card = toContextFactCard(changedEvent(), 1) as ContextFactCard;
  assert.equal(feed.push(card), true);
  assert.equal(feed.push({...card, createdAt: 2}), false, '内容相同即同一事实，连卡片都不该重建');
  assert.equal(feed.list().length, 1);
});

test('超出上限时淘汰最旧的那张：新事实永远比旧事实更值得看', () => {
  const feed = new ContextFactFeed(2);
  for (const generation of [1, 2, 3]) {
    const card = toContextFactCard({
      type: 'CONTEXT_REBUILT', executionId: 'e', summaryGeneration: generation, messageCount: generation,
    }, generation) as ContextFactCard;
    feed.push(card);
  }
  assert.deepEqual(feed.list().map(card => card.summaryGeneration), [2, 3]);
  assert.equal(DEFAULT_CONTEXT_FACT_LIMIT, 3);
});

test('过期只按创建时刻算：到点即移除，未到点一律保留', () => {
  const feed = new ContextFactFeed(3);
  const card = toContextFactCard(changedEvent(), 0) as ContextFactCard;
  feed.push(card);
  feed.expire(DEFAULT_CONTEXT_FACT_TTL_MS - 1);
  assert.equal(feed.list().length, 1, '还没到寿命不能提前消失');
  feed.expire(DEFAULT_CONTEXT_FACT_TTL_MS);
  assert.equal(feed.list().length, 0);
});

test('dismiss 只拿掉指定那张，别的提示不受牵连', () => {
  const feed = new ContextFactFeed(3);
  const first = toContextFactCard(changedEvent(), 1) as ContextFactCard;
  const second = toContextFactCard({
    type: 'CONTEXT_REBUILT', executionId: 'e', summaryGeneration: 1, messageCount: 1,
  }, 2) as ContextFactCard;
  feed.push(first);
  feed.push(second);
  feed.dismiss(first.id);
  assert.deepEqual(feed.list().map(card => card.id), [second.id]);
});

test('Vue 外壳只对上下文事实返回 true，重复事实也算已消费', () => {
  const scheduled: number[] = [];
  const facts = useContextFacts({scheduleTimeout: (_handler, delayMs) => {
    scheduled.push(delayMs);
    return scheduled.length;
  }});

  assert.equal(facts.accept({type: 'TEXT_DELTA'}), false, '无关事件必须放行给聊天状态机');
  assert.equal(facts.accept(changedEvent(), 10), true);
  assert.equal(facts.cards.value.length, 1);
  assert.deepEqual(scheduled, [DEFAULT_CONTEXT_FACT_TTL_MS], '入队即登记一次过期回收');

  assert.equal(facts.accept(changedEvent(), 11), true, '重复事实不呈现，但它确实是上下文事实');
  assert.equal(facts.cards.value.length, 1);
  assert.equal(scheduled.length, 1, '重复事实不该再登记一次回收');

  facts.dismiss(facts.cards.value[0].id);
  assert.equal(facts.cards.value.length, 0);
});
