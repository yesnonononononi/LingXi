import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatSession, ChatTurn } from '../src/types/chat';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';
import { buildMessageTurnMap, mergeTurns } from '../src/utils/session';
import { formatDurationOrPlaceholder } from '../src/utils/format';

/**
 * 缺陷 2：同一会话发第二条消息时，用户气泡不立即渲染，要等 AI 完成才随结果一起出现。
 *
 * 根因：会话对账 / 分页加载会把 {@code session.messages} 整体替换为新数组，而 reducer 在 bind
 * 时捕获了旧数组引用，第二轮 pushUserMessage 落在已脱离渲染的旧数组上。修复后 reducer 通过
 * 访问器始终作用于「当前」数组。
 */
test('1. 会话对账替换 messages 数组后：pushUserMessage 仍进入当前数组，第二轮用户气泡立即可见', () => {
  const session: ChatSession = {
    id: 'root-1',
    title: '会话',
    createdAt: 0,
    updatedAt: 0,
    modelId: 'm',
    activeTools: [],
    messages: []
  };
  const router = new StreamSessionRouter();
  router.bindRootSession(session);

  // 第一轮：用户乐观气泡进入当前数组
  router.pushUserMessage('第一条');
  assert.equal(session.messages.length, 1);

  // 模拟 reconcileSessionAfterStream：用服务端权威消息整体替换数组引用（不再是同一个数组）
  const reconciled: ChatMessage[] = [
    { id: 'srv-u1', role: 'user', content: '第一条', timestamp: 1, turnId: 't1' },
    { id: 'srv-a1', role: 'assistant', content: '回答一', timestamp: 2, turnId: 't1', isComplete: true }
  ];
  session.messages = reconciled;

  // 第二轮：用户气泡必须立即进入「当前」数组
  router.pushUserMessage('第二条');
  assert.equal(session.messages.length, 3, '第二条用户气泡应立刻进入当前数组');
  const last = session.messages[session.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, '第二条');
});

/** 缺陷 2（子会话）：reconcile 把 root.subSessions 整体替换后，子 reducer 同样要写入当前数组。 */
test('2. 子会话对账替换 subSessions 后：子 reducer 仍写入当前子会话消息数组', () => {
  const session: ChatSession = {
    id: 'root-2',
    title: '会话',
    createdAt: 0,
    updatedAt: 0,
    modelId: 'm',
    activeTools: [],
    messages: [],
    subSessions: [{ id: 'sub-1', name: '子代理', messages: [] }]
  };
  const router = new StreamSessionRouter();
  router.bindRootSession(session);

  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'st1', sessionId: 'sub-1', rootSessionId: 'root-2' }
  });
  router.flushAll();
  assert.equal(session.subSessions?.[0].messages?.length, 1);

  // 模拟对账：subSessions 被整体替换为新对象（messages 为空数组）
  session.subSessions = [{ id: 'sub-1', name: '子代理', messages: [] }];

  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'e2',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'st2', sessionId: 'sub-1', rootSessionId: 'root-2' }
  });
  router.flushAll();
  assert.equal(session.subSessions?.[0].messages?.length, 1, '子气泡应进入被替换后的当前数组');
  assert.equal(session.subSessions?.[0].messages?.[0].turnId, 'st2');
});

/**
 * 缺陷 1：回答气泡底部工具条（token / 耗时 / 模型 / 状态）不显示。
 *
 * 根因：buildTurnMap 把每条消息的 turn 硬编码为 null，从未按 turnId 从 session.turns 解析。
 */
test('3. 工具条绑定：按 turnId 从会话轮次表解析权威摘要，缺失保持 null（未采集 ≠ 0）', () => {
  const turns: Record<string, ChatTurn> = {
    t1: {
      turnId: 't1',
      status: 'COMPLETED',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      elapsedMs: 2500,
      modelName: 'gpt-4'
    }
  };
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: '你好', timestamp: 0, turnId: 't1' },
    { id: 'a1', role: 'assistant', content: '你好！', timestamp: 0, turnId: 't1', isComplete: true }
  ];

  const map = buildMessageTurnMap(messages, turns);
  const binding = map.get('a1');
  assert.ok(binding);
  assert.equal(binding.turn?.totalTokens, 150);
  assert.equal(binding.turn?.elapsedMs, 2500);
  assert.equal(binding.turn?.modelName, 'gpt-4');
  assert.equal(binding.isGroupTail, true, '助手为回答组组尾');
  assert.equal(map.get('u1')?.turn, binding.turn, '同组消息共享同一轮次摘要');
  assert.equal(map.get('u1')?.isGroupTail, false);

  // 轮次表无该 turnId → null（不得回落成会话累计或 0）
  const missing = buildMessageTurnMap(
    [{ id: 'a2', role: 'assistant', content: '', timestamp: 0, turnId: 'unknown' }],
    turns
  );
  assert.equal(missing.get('a2')?.turn, null);

  // 旧数据 turnId 缺失 → null
  const legacy = buildMessageTurnMap(
    [{ id: 'a3', role: 'assistant', content: '', timestamp: 0, turnId: null }],
    turns
  );
  assert.equal(legacy.get('a3')?.turn, null);

  // 无轮次表 → 全部 null
  const empty = buildMessageTurnMap(messages, undefined);
  assert.equal(empty.get('a1')?.turn, null);
});

/** 缺陷 1（对账/分页）：每页下发的 turns 逐页 union 进会话表，键=turnId，后到覆盖先到。 */
test('4. 轮次摘要逐页 union：同键后到覆盖先到，缺失归一为空对象', () => {
  const t1a: ChatTurn = { turnId: 't1', status: 'RUNNING', totalTokens: 10 };
  const t1b: ChatTurn = { turnId: 't1', status: 'COMPLETED', totalTokens: 120, elapsedMs: 800 };
  const t2: ChatTurn = { turnId: 't2', status: 'COMPLETED', totalTokens: 30 };

  const merged = mergeTurns({ t1: t1a }, { t1: t1b, t2 });
  assert.equal(merged.t1.totalTokens, 120, '同键后到覆盖先到');
  assert.equal(merged.t1.status, 'COMPLETED');
  assert.equal(merged.t2, t2);

  assert.deepEqual(mergeTurns(undefined, undefined), {});
  assert.deepEqual(mergeTurns({ t1: t1a }, undefined), { t1: t1a });
  assert.deepEqual(mergeTurns(undefined, { t2 }), { t2 });
});

/**
 * 缺陷 1（耗时兜底）：displayDuration 在无摘要且无自带耗时时曾因缺少兜底分支渲染出 undefined。
 * 现统一走 formatDurationOrPlaceholder，保证任何输入都返回字符串。
 */
test('5. displayDuration 兜底：耗时缺失（null/undefined）返回「暂无统计」，绝不返回 undefined', () => {
  assert.equal(formatDurationOrPlaceholder(undefined), '暂无统计');
  assert.equal(formatDurationOrPlaceholder(null), '暂无统计');
  assert.equal(typeof formatDurationOrPlaceholder(undefined), 'string');
  assert.notEqual(formatDurationOrPlaceholder(undefined), undefined);
  assert.equal(formatDurationOrPlaceholder(5000), '5秒');
});
