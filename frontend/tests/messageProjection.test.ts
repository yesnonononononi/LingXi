import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { buildPromptCard } from '../src/utils/session';
import { STREAM_V3_SCHEMA_VERSION } from '../src/utils/streamV3';
import type { StreamV3Event } from '../src/utils/streamV3';
import type { ToolCallVO } from '../src/types/chat';

/**
 * 视图适配层的验收测试。
 *
 * 覆盖的是「迁移后最容易静默失败」的几条：卡片先于消息到达、子会话卡片在根界面可审批、
 * 主聊天不混入子会话正文、以及 delta 不做全量重算。
 */

function freshStore() {
  setActivePinia(createPinia());
  return useStreamV3Store();
}

function frame(type: StreamV3Event['type'], data: unknown, identity: Partial<StreamV3Event> = {}): StreamV3Event {
  return {
    schemaVersion: STREAM_V3_SCHEMA_VERSION,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    rootSessionId: identity.rootSessionId ?? '100',
    sessionId: identity.sessionId ?? '100',
    turnId: identity.turnId ?? null,
    executionId: identity.executionId ?? null,
    historyRevision: identity.historyRevision ?? null,
    streamKey: identity.streamKey ?? null,
    type,
    timestamp: identity.timestamp ?? null,
    data,
  };
}

/** 一张 COMMAND 审批卡（PROMISE + pending）。 */
function commandCard(overrides: Partial<ToolCallVO> = {}): ToolCallVO {
  return {
    id: 'call_1',
    conversationId: '100',
    type: 'PROMISE',
    status: 'pending',
    pending: true,
    allowedActions: ['APPROVE', 'REJECT'],
    version: '1',
    title: '命令审批',
    content: { kind: 'COMMAND', command: 'ls -la', workDir: '/tmp', shell: 'bash' },
    ...overrides,
  };
}

test('卡片先于消息到达：仍能展示，且展示项按 toolCallId 稳定', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', commandCard()));

  const first = projectSessionMessages('100');
  assert.equal(first.length, 1, '无宿主消息时也要为卡片建展示项');
  assert.equal(first[0].id, 'msg-card-call_1', '展示项 id 由 toolCallId 决定');
  assert.equal(first[0].promptCards?.[0]?.toolCallId, 'call_1');
  assert.equal(first[0].promptCards?.[0]?.kind, 'COMMAND', '形态由 content.kind 分派');

  // 再投影一次不得多出第二张（卡片与消息是两个独立到达的流，重复投影必须幂等）。
  const second = projectSessionMessages('100');
  assert.equal(second.length, 1);
  assert.equal(second.filter(m => m.promptCards?.length).length, 1);
});

test('卡片按 content.kind 分派，按钮权限读 allowedActions', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', commandCard({
    id: 'call_plan',
    title: '',
    content: { kind: 'PLAN', title: '计划', text: '第一步' },
  })));

  const card = projectSessionMessages('100')[0].promptCards?.[0];
  assert.equal(card?.kind, 'PLAN');
  assert.equal(card?.content, '第一步');
  assert.deepEqual(card?.allowedActions, ['APPROVE', 'REJECT']);
});

test('决策回执与事件更新同一实体：卡片随之刷新，不新增展示项', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', commandCard()));
  assert.equal(projectSessionMessages('100')[0].promptCards?.[0]?.pending, true);

  // 决策落库后的最新版本（回执与 v3 事件共用同一个 tools[toolCallId]）。
  store.ingestToolCall(commandCard({
    status: 'completed',
    pending: false,
    allowedActions: [],
    version: '2',
    rawOutput: { outcome: 'APPROVED', stdout: 'ok' },
  }));

  const after = projectSessionMessages('100');
  assert.equal(after.length, 1, '同一条卡片不得变成两条');
  const card = after[0].promptCards?.[0];
  assert.equal(card?.pending, false);
  assert.equal(card?.outcome, 'APPROVED');
  assert.equal(card?.version, '2');
});

test('子会话待审批卡片冒泡到根视图（同一实体），非待审批卡片不冒泡', () => {
  const store = freshStore();
  store.applyFrame('100', frame('SESSION_UPDATED', { id: '200', rootSessionId: '100', name: '研究员' }));

  // 子会话里的待审批卡 → 根视图可见（否则用户不打开子面板就无法恢复子执行）。
  store.ingestToolCall(commandCard({ id: 'call_sub_pending', conversationId: '200' }));
  // 子会话里的已决断卡 → 不冒泡（不需要在根界面重复展示）。
  store.ingestToolCall(commandCard({
    id: 'call_sub_done', conversationId: '200', status: 'completed', pending: false,
    allowedActions: [], rawOutput: { outcome: 'APPROVED' },
  }));

  const rootCards = projectSessionMessages('100')
    .flatMap(m => m.promptCards ?? [])
    .map(c => c.toolCallId);
  assert.deepEqual(rootCards, ['call_sub_pending']);

  // 子面板则能看到子会话自己的两张卡。
  const subCards = projectSessionMessages('100', '200')
    .flatMap(m => m.promptCards ?? [])
    .map(c => c.toolCallId)
    .sort();
  assert.deepEqual(subCards, ['call_sub_done', 'call_sub_pending']);
});

test('主聊天不混入子会话正文：子会话工具不进根视图普通卡片集', () => {
  const store = freshStore();
  store.applyFrame('100', frame('SESSION_UPDATED', { id: '200', rootSessionId: '100', name: '研究员' }));
  // 子会话里的普通工具（非 PROMISE）不产生卡片，也不应出现在根视图。
  store.ingestToolCall({ id: 'exec_1', conversationId: '200', type: 'EXECUTE', status: 'completed' });

  assert.deepEqual(projectSessionMessages('100'), []);
});

test('delta 只做局部更新：槽位未变时基底消息按引用复用（不全量重算）', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', commandCard()));

  const first = projectSessionMessages('100');
  const second = projectSessionMessages('100');
  assert.equal(second, first, 'history/tools/turns 未变时必须复用基底，不重新聚合');
});

test('宿主消息后到达：卡片归位到该气泡，不残留独立展示项也不重复', () => {
  const store = freshStore();
  // 1) 卡片先到 → 独立展示项
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', commandCard()));
  assert.equal(projectSessionMessages('100')[0].id, 'msg-card-call_1');

  // 2) 宿主消息（AI 行带同名 toolCalls）后到
  store.replaceHistory('100', {
    records: [
      { id: '1', sessionId: '100', turnId: '9001', type: 'USER', text: '执行一下' },
      {
        id: '2', sessionId: '100', turnId: '9001', type: 'AI',
        toolCalls: [{ id: 'call_1', name: 'execute_command', arguments: '{}' }],
      },
      { id: '3', sessionId: '100', turnId: '9001', type: 'TOOL', toolCallId: 'call_1' },
    ],
    turns: {},
    hasMore: false,
    nextCursor: null,
  });

  const messages = projectSessionMessages('100');
  assert.equal(messages.filter(m => String(m.id).startsWith('msg-card-')).length, 0,
    '宿主到达后不得再有独立展示项');

  const cards = messages.flatMap(m => m.promptCards ?? []);
  assert.equal(cards.length, 1, '卡片只出现一次');
  assert.equal(cards[0].toolCallId, 'call_1');
});

test('历史行自带 toolCall 载荷时卡片不重复（实体是唯一来源，不是第二份）', () => {
  const store = freshStore();
  // 生产的历史 TOOL 行**带** toolCall 载荷，聚合阶段就会产出卡片；
  // 若派生阶段再按实体挂一次，同一张卡会出现两遍。
  store.replaceHistory('100', {
    records: [
      { id: '1', sessionId: '100', turnId: '9001', type: 'USER', text: '执行一下' },
      {
        id: '2', sessionId: '100', turnId: '9001', type: 'AI',
        toolCalls: [{ id: 'call_1', name: 'execute_command', arguments: '{}' }],
      },
      {
        id: '3', sessionId: '100', turnId: '9001', type: 'TOOL', toolCallId: 'call_1',
        toolCall: commandCard(),
      },
    ],
    turns: {},
    hasMore: false,
    nextCursor: null,
  });
  // 工具实体与历史同源（version 相同）
  store.ingestToolCall(commandCard());

  const cards = projectSessionMessages('100').flatMap(m => m.promptCards ?? []);
  assert.equal(cards.filter(c => c.toolCallId === 'call_1').length, 1,
    '同一 toolCallId 只能出现一次');
});

test('历史卡片无对应工具实体时保留（不因本轮派生而丢卡）', () => {
  const store = freshStore();
  store.replaceHistory('100', {
    records: [
      { id: '1', sessionId: '100', turnId: '9001', type: 'USER', text: '执行一下' },
      {
        id: '2', sessionId: '100', turnId: '9001', type: 'AI',
        toolCalls: [{ id: 'call_old', name: 'execute_command', arguments: '{}' }],
      },
      {
        id: '3', sessionId: '100', turnId: '9001', type: 'TOOL', toolCallId: 'call_old',
        toolCall: commandCard({ id: 'call_old' }),
      },
    ],
    turns: {},
    hasMore: false,
    nextCursor: null,
  });
  // 工具槽里没有 call_old（更早的历史，不在 bootstrap 的未决卡片集合里）

  const cards = projectSessionMessages('100').flatMap(m => m.promptCards ?? []);
  assert.deepEqual(cards.map(c => c.toolCallId), ['call_old']);
});

test('归属未知的活响应只被根视图认领，不在子面板重复渲染', () => {
  const store = freshStore();
  store.applyFrame('100', frame('SESSION_UPDATED', { id: '200', rootSessionId: '100', name: '研究员' }));
  store.replaceHistory('100', {
    records: [
      { id: '1', sessionId: '100', turnId: '9001', type: 'USER', text: '你好' },
      { id: '2', sessionId: '100', turnId: '9001', type: 'AI', text: '历史正文' },
    ],
    turns: {},
    hasMore: false,
    nextCursor: null,
  });
  // 归属未知（sessionId 为 null）的活响应
  store.applyFrame('100', {
    schemaVersion: STREAM_V3_SCHEMA_VERSION,
    eventId: 'evt-null-sid',
    rootSessionId: '100',
    sessionId: null,
    turnId: '9001',
    executionId: null,
    historyRevision: null,
    streamKey: 'sk-x',
    type: 'TEXT_DELTA',
    timestamp: null,
    data: { streamKey: 'sk-x', delta: '实时正文' },
  });

  const rootTexts = projectSessionMessages('100')
    .filter(m => m.role === 'assistant' && m.content)
    .map(m => m.content);
  // 该活响应虽无 sessionId，但带 turnId → 按轮次归位并**追加**到同一回答组（同轮后续段落语义）。
  assert.deepEqual(rootTexts, ['历史正文实时正文'], '根视图认领归属未知的响应');

  const sub = projectSessionMessages('100', '200');
  assert.equal(sub.length, 0, '子面板不得认领归属未知的响应');
});

/**
 * 卡片形态与动作权限的派生契约（原 toolCallState 用例，随旧消息同步写入一并归位）。
 *
 * <p>「准备中」的卡片不得开放任何人工动作：委派等待（DELEGATION）由挂起链路自动回填，
 * 用户无从操作；PLAN / CHOICE / COMMAND 在 preparing 阶段也还没有可点的选项。</p>
 */
test('准备中的卡片不开放动作，委派等待没有人工动作', () => {
  for (const kind of ['PLAN', 'CHOICE', 'COMMAND', 'DELEGATION']) {
    const card = buildPromptCard({ id: kind, type: 'PROMISE', status: 'preparing',
      content: { kind }, pending: true, allowedActions: [] });
    assert.equal(card?.status, 'preparing');
    assert.equal(card?.pending, false);
  }
});

/**
 * 回归：AI 行提交后思考过程必须保留。
 *
 * <p>拦截的缺陷：MESSAGE_COMMITTED 载荷不带 thinking，若提交时不把活响应槽里的思考写进历史行，
 * 活响应一绑定 messageId 就被排除出 live，思考过程在提交那一刻整段消失
 * （现象：流式时能看到「深度思考」，回答一完成就没了）。</p>
 */
test('AI 行提交后思考过程保留在历史行', () => {
  const store = freshStore();
  const streamKey = 'sk-think';

  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey }, { streamKey, turnId: '9001' }));
  store.applyFrame('100', frame('THINKING_DELTA', { streamKey, delta: '让我想想' }, { streamKey, turnId: '9001' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey, delta: '答案是 42。' }, { streamKey, turnId: '9001' }));
  store.applyFrame('100', frame('RESPONSE_FINALIZED',
    { streamKey, text: '答案是 42。', thinking: '让我想想', purpose: null }, { streamKey, turnId: '9001' }));

  // 提交帧不带 thinking（与真实后端一致），靠 store 从活响应槽补写进历史行
  store.applyFrame('100', frame('MESSAGE_COMMITTED',
    { streamKey, messageId: 'a-1', sessionId: '100', turnId: '9001', text: '答案是 42。', type: 'AI' },
    { streamKey, turnId: '9001' }));

  const assistant = projectSessionMessages('100').find(m => m.role === 'assistant');
  assert.ok(assistant, '提交后应存在 assistant 气泡');
  assert.equal(assistant!.content, '答案是 42。');
  const thoughts = (assistant!.thoughtSteps ?? []).map(s => s.content);
  assert.deepEqual(thoughts, ['让我想想'], '提交后思考过程不得丢失');
});

/**
 * 回归：探索态气泡（发送后、首个产出前）必须可被「正在探索中」动画识别。
 *
 * <p>拦截的缺陷：派生回答气泡从不设 isExploring，发送后模型首 token 前的空白窗口没有任何反馈。
 * 判据必须是「未完成且无任何产出」——正文或工具调用一出现即退出探索态。</p>
 */
test('探索态只在无正文无工具时成立，产出落地即退出', () => {
  const store = freshStore();
  const streamKey = 'sk-explore';

  store.applyFrame('100', frame('MESSAGE_COMMITTED',
    { streamKey: null, messageId: 'u-1', sessionId: '100', turnId: '9001', text: '你好', type: 'USER' },
    { turnId: '9001' }));
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey }, { streamKey, turnId: '9001' }));

  let assistant = projectSessionMessages('100').find(m => m.role === 'assistant');
  assert.equal(assistant?.isExploring, true, '响应已开始但无产出 → 探索中');

  store.applyFrame('100', frame('THINKING_DELTA', { streamKey, delta: '思考中' }, { streamKey, turnId: '9001' }));
  assistant = projectSessionMessages('100').find(m => m.role === 'assistant');
  assert.equal(assistant?.isExploring, true, '只有思考、还没有正文/工具 → 仍是探索中');

  store.applyFrame('100', frame('TEXT_DELTA', { streamKey, delta: '正文来了' }, { streamKey, turnId: '9001' }));
  assistant = projectSessionMessages('100').find(m => m.role === 'assistant');
  assert.equal(assistant?.isExploring, false, '正文出现后退出探索态，不得盖住作答');
  assert.equal(assistant?.content, '正文来了');
});
