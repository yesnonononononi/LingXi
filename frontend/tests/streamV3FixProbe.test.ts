import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { attachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import {
  bootstrapSnapshot,
  createHarness,
  flush,
  frame,
  promiseCard,
  readyFrame,
  subSessionVO,
} from './harness/streamV3Harness';

/**
 * QA 独立反例探针（**不属于 `npm test` 门禁**，需显式指定本文件运行）。
 *
 * 目的不是复述 `streamV3SwitchAudit.test.ts` 的验收场景，而是**尝试打破**这五项修复：
 * 每个用例都钉住一条边界（重复身份、跨根会话、迟到顺序、幂等性、冒泡），
 * 断言的是「修复声称的性质」，而不是「当前实现恰好做的事」。
 *
 * 统一约定：能走生产组合函数（useChatView / attachStreamV3）就走生产路径，
 * 只有网络边界（fetch / bootstrap / 分页）被替换。
 *
 * <p><b>不是浏览器端到端测试</b>：无真实浏览器 DOM、无 Electron、无真实后端。
 * 它验证的是「帧按给定顺序到达时，状态与派生视图是否正确」。</p>
 */

/** 让会话直接进入 live 并带上给定历史行（走生产 attachStreamV3 + 真 bootstrap 时序）。 */
async function enterLive(harness: any, rootId: string, rows: any[] = [], extra: any = {}) {
  attachStreamV3(rootId);
  await flush(8);
  harness.server.push(rootId, readyFrame(`ready-${rootId}`));
  await flush(8);
  assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
    rootSessionId: rootId,
    historyRevision: '1',
    sessions: [{ id: rootId } as any],
    history: { records: rows, turns: {}, hasMore: false, nextCursor: null },
    ...extra,
  })), 'bootstrap 应被消费');
  await flush(8);
}

/**
 * 捕获退避重连的定时器回调，让测试手动触发重连。
 *
 * 只收 `sseRouter#scheduleReconnect` 登记的那一个：`utils/sse.ts` 的读流空闲超时也用
 * `window.setTimeout`（300s），不按来源过滤会把它一并当成重连（实测会多出 2 个），
 * 且误触发它会走 abortSync 路径，把「重连」变成「同步失败」，测出假象。
 */
function captureReconnect() {
  const original = window.setTimeout;
  const scheduled: Array<() => void> = [];
  window.setTimeout = ((cb: () => void, delay: number) => {
    const site = new Error().stack ?? '';
    if (delay >= 1000 && site.includes('scheduleReconnect')) { scheduled.push(cb); return -1 as any; }
    return original(cb, delay);
  }) as any;
  return { scheduled, restore: () => { window.setTimeout = original; } };
}

/* ============================ 缺陷 1：新轮次派生回答气泡 ============================ */

test('探针1-1 新轮次正文在 AI 行落库前后始终只有一个气泡（不重复、不消失）', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '第一轮提问' },
      { id: '1002', sessionId: '100', turnId: '100-t1', type: 'AI', text: '第一轮回答' },
    ]);
    const countAnswer = (needle: string) =>
      projectSessionMessages('100').filter(m => m.role === 'assistant' && m.content.includes(needle)).length;

    // 落库前：本轮只有 USER 行，正文必须可见，且恰好一个气泡。
    harness.server.push('100', frame('MESSAGE_COMMITTED',
      { messageId: '1003', sessionId: '100', turnId: '100-t2', type: 'USER', text: '第二轮提问' }),
      frame('RESPONSE_STARTED', { streamKey: 'live-2' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }),
      frame('TEXT_DELTA', { streamKey: 'live-2', delta: '第二轮增量' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush(8);
    assert.equal(store.getResponse('live-2')?.text, '第二轮增量', '正文应已进入唯一状态源');
    assert.equal(countAnswer('第二轮增量'), 1, 'AI 行落库前：正文必须显示且只显示一个气泡');

    // 落库后：AI 行进入历史，实时槽绑定 messageId 并退出 live 集合 → 仍只有一个气泡。
    harness.server.push('100', frame('MESSAGE_COMMITTED',
      { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '第二轮增量已落库', streamKey: 'live-2' },
      { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush(8);
    assert.equal(countAnswer('第二轮增量'), 1,
      'AI 行落库后不得出现「派生气泡 + 真实气泡」两个气泡（旧派生气泡应消失）');
    assert.equal(countAnswer('第二轮增量已落库'), 1, '落库正文本身必须可见');
  } finally {
    harness.teardown();
  }
});

test('探针1-2 同一 turnId 多个 streamKey（分段响应）合并进同一个气泡', async () => {
  const harness = createHarness();
  try {
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' },
    ]);
    // streamKey 是雪花 ID：数值升序即写入序，分段响应按它拼接。
    harness.server.push('100',
      frame('RESPONSE_STARTED', { streamKey: '1000' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }),
      frame('TEXT_DELTA', { streamKey: '1000', delta: '甲段' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }),
      frame('RESPONSE_STARTED', { streamKey: '1001' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }),
      frame('TEXT_DELTA', { streamKey: '1001', delta: '乙段' }, { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush(8);
    const answers = projectSessionMessages('100')
      .filter(m => m.role === 'assistant' && (m.content.includes('甲段') || m.content.includes('乙段')));
    assert.equal(answers.length, 1, '同一轮次的分段响应必须是同一个气泡，不能每个 streamKey 一个气泡');
    assert.match(answers[0]?.content ?? '', /甲段[\s\S]*乙段/, '两段正文应按 streamKey 升序拼接');
  } finally {
    harness.teardown();
  }
});
test('探针1-3 卡片展示气泡不得被当作宿主挂上正文（turnId 未知的活响应）', async () => {
  const harness = createHarness();
  try {
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' },
    ]);
    // 只有一张无宿主卡片（role=assistant、id=msg-card-*），没有任何真实 assistant 气泡。
    harness.server.push('100', frame('TOOL_CALL_UPDATED',
      promiseCard({ id: 'card-x', content: { kind: 'PLAN', title: '计划', text: '计划正文' } })));
    await flush();
    // 一条 turnId 为 null 的活响应（轮次行尚未回填的形态）。
    harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'orphan-1', delta: '孤儿正文' },
      { sessionId: '100', turnId: null, executionId: 'e9' }));
    await flush();

    const cardBubble = projectSessionMessages('100').find(m => String(m.id).startsWith('msg-card-'));
    assert.ok(cardBubble, '应存在卡片展示气泡');
    assert.equal(cardBubble!.content, '', '卡片气泡不得被挂上正文（那会造出「有正文的卡片气泡」）');
    assert.equal(projectSessionMessages('100').filter(m => String(m.id).startsWith('msg-card-')).length, 1,
      '不得因为挂载正文而复制出第二个卡片气泡');
  } finally {
    harness.teardown();
  }
});

test('探针1-4 turnId 为 null 的活响应在流式期间的可见性（后端 publishLegacy 首帧即无 turnId）', async () => {
  const harness = createHarness();
  try {
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' },
    ]);
    // 轮次行尚未回填：帧不带 turnId（后端 SessionStreamHub 的 identityUnknown 形态）。
    harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'orphan-2', delta: '无宿主正文' },
      { sessionId: '100', turnId: null, executionId: 'e9' }));
    await flush();
    const shown = projectSessionMessages('100').some(m => m.content.includes('无宿主正文'));
    // 实测：orphan 只能挂到「已有 assistant 宿主」，本轮 AI 行未落库 ⇒ 无宿主 ⇒ 正文不显示；
    // AI 行落库后自愈（见下方断言）。这是与缺陷 1 同源的残留路径，但影响面小得多：
    // 仅限「轮次未知 + 该轮尚无任何 assistant 气泡」，且随落库自愈。
    assert.equal(shown, false,
      '当前实现里 turnId 未知的活响应在流式期间不显示（orphan 无宿主即丢弃）——若此断言失败说明行为已变化，需重新评估');

    // 自愈：AI 行落库后同一 streamKey 绑定 messageId，正文重新可见。
    harness.server.push('100', frame('MESSAGE_COMMITTED',
      { messageId: '1002', sessionId: '100', turnId: null, type: 'AI', text: '无宿主正文', streamKey: 'orphan-2' },
      { sessionId: '100', turnId: null, executionId: 'e9' }));
    await flush();
    assert.ok(projectSessionMessages('100').some(m => m.content.includes('无宿主正文')),
      'AI 行落库后正文仍未恢复 —— orphan 丢弃不是「暂时」而是永久丢字');
  } finally {
    harness.teardown();
  }
});

/* ============================ 缺陷 2：自动重连重新 bootstrap ============================ */

test('探针2-1 同一连接上重复 STREAM_READY 不得重复 bootstrap', async () => {
  const harness = createHarness();
  try {
    await enterLive(harness, '100', []);
    const before = harness.bootstrap.calls.length;
    harness.server.push('100', readyFrame('ready-100'), readyFrame('ready-100'), readyFrame('ready-100'));
    await flush();
    assert.equal(harness.bootstrap.calls.length, before,
      '同一 connectionId 的重复 READY 是幂等控制帧，不得重复拉快照');
  } finally {
    harness.teardown();
  }
});

test('探针2-2 真正的新连接 READY 必须重新 bootstrap 并进入 live', async () => {
  const harness = createHarness();
  const cap = captureReconnect();
  try {
    await enterLive(harness, '100', []);
    harness.server.closeFromServer('100');
    await flush();
    assert.equal(cap.scheduled.length, 1, '断流应登记一次退避重连');
    cap.scheduled[0]!();
    await flush();
    assert.equal(harness.server.openCount('100'), 2, '应真正建立第二条连接');
    harness.server.push('100', readyFrame('reconnected-100'));
    await flush();
    assert.equal(harness.bootstrap.calls.length, 2, '新连接 READY 必须重新 bootstrap');
    harness.bootstrap.resolveNext(bootstrapSnapshot({ rootSessionId: '100', historyRevision: '1' }));
    await flush();
    assert.equal(useStreamV3Store().getPhase('100'), 'live');
  } finally {
    cap.restore();
    harness.teardown();
  }
});

test('探针2-3 在途重连：新连接必须拿到自己的 bootstrap，且上一代在途响应不得污染新代际', async () => {
  const harness = createHarness();
  const cap = captureReconnect();
  try {
    const store = useStreamV3Store();
    attachStreamV3('100');
    await flush(8);
    // 第一条连接 READY，bootstrap#1 发出但**不返回**（在途）。
    harness.server.push('100', readyFrame('conn-1'));
    await flush(8);
    assert.equal(harness.bootstrap.calls.length, 1);
    assert.equal(harness.bootstrap.pendingCount, 1, 'bootstrap#1 应仍在途');

    // 在途期间断流重连 → 新连接 READY。
    harness.server.closeFromServer('100');
    await flush(8);
    cap.scheduled[0]!();
    await flush(10);
    assert.equal(harness.server.openCount('100'), 2, '前置：应真正建立第二条连接');
    harness.server.push('100', readyFrame('conn-2'));
    await flush(8);

    // 断言 A：新连接不能被「上一代还在途」挡掉 —— 断流窗口内漏掉的事件只能靠这次 bootstrap 补齐。
    assert.equal(harness.bootstrap.calls.length, 2,
      'bootstrap 在途时重连，新连接未发起自己的 bootstrap：新连接将永久缺失断流窗口内的事件');

    // 断言 B：上一代在途请求迟到返回，必须因代次不符被整体丢弃。
    harness.bootstrap.resolveAt(0, bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '2',
      history: {
        records: [{ id: '9001', sessionId: '100', turnId: 'stale-t', type: 'AI', text: '旧代际正文' }],
        turns: {}, hasMore: false, nextCursor: null,
      },
    }));
    await flush(8);
    const texts = [...store.getHistory('100').values()].map(r => String(r.text ?? ''));
    assert.ok(!texts.some(t => t.includes('旧代际正文')),
      '上一代连接的 bootstrap 迟到返回污染了新代际（同步代次未在新连接 READY 时推进）');

    // 断言 C：新连接自己的 bootstrap 返回后正常进入 live（代次链自洽）。
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '2', sessions: [{ id: '100' } as any],
      history: {
        records: [{ id: '9100', sessionId: '100', turnId: 'new-t', type: 'AI', text: '新代际正文' }],
        turns: {}, hasMore: false, nextCursor: null,
      },
    })), '新连接的 bootstrap 应仍在途');
    await flush(8);
    assert.equal(store.getPhase('100'), 'live', '新连接同步完成后应进入 live');
    assert.ok([...store.getHistory('100').values()].some(r => String(r.text ?? '').includes('新代际正文')),
      '新代际正文未落地');
  } finally {
    cap.restore();
    harness.teardown();
  }
});

test('探针2-4 beginResync 既有语义未被破坏：重挂到在跑连接不得停在 awaiting-ready', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    await enterLive(harness, '100', []);
    attachStreamV3('100');           // 重挂到已 READY 的连接
    await flush();
    assert.notEqual(store.getPhase('100'), 'awaiting-ready',
      '重挂不得进入等待 READY（复用连接不会再发 READY，会导致帧被无限暂存）');
    assert.equal(harness.bootstrap.calls.length, 2, '重挂应重新拉一次 bootstrap 补齐缺口');
  } finally {
    harness.teardown();
  }
});

/* ============================ 缺陷 3 / 4：组合层（useChatView） ============================ */

function setupView() {
  const harness = createHarness();
  const scope = effectScope();
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  const store = useStreamV3Store();
  const originals = {
    detail: chatApi.fetchSessionDetail,
    models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs,
    command: chatApi.sendCommand,
  };
  const buildRows = (id: string) => [
    { id: `${id}1`, sessionId: id, turnId: `${id}-t1`, type: 'USER', text: `${id}提问` },
    { id: `${id}2`, sessionId: id, turnId: `${id}-t1`, type: 'AI', text: `${id}已提交回答` },
  ];
  view.localSessions.value = ['100', '300'].map(id => ({
    id, title: id, createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE',
  })) as any;
  (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
    id, title: id, rawRecords: buildRows(id), turns: {}, subSessions: [],
    runStatus: 'IDLE', hasMoreMessages: false, nextMessageCursor: null,
  } });
  (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });

  async function enter(id: string, overrides: any = {}) {
    await view.handleSelectSession(id);
    await flush();
    harness.server.push(id, readyFrame(`ready-${id}`));
    await flush();
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: id, historyRevision: '1', sessions: [{ id } as any],
      history: { records: buildRows(id), turns: {}, hasMore: false, nextCursor: null },
      ...overrides,
    })));
    await flush();
    assert.equal(store.getPhase(id), 'live');
  }

  return {
    harness, view, store, enter,
    cleanup() {
      scope.stop();
      harness.teardown();
      chatApi.fetchSessionDetail = originals.detail;
      chatApi.fetchModels = originals.models;
      chatApi.fetchUserConfigs = originals.configs;
      chatApi.sendCommand = originals.command;
    },
  };
}

test('探针3-1 A 回执迟到：A 的轮次/卡片实体事实仍被更新，且不夺走 B 的展示连接', async () => {
  const v = setupView();
  try {
    await v.enter('100');
    // A 上先有一张待审批卡与一个轮次实体（切走时 resetSession 只清 responses/history，turns/tools 保留）。
    v.harness.server.push('100',
      frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-a', executionId: 'e1' })),
      frame('TURN_UPDATED', { turnId: '100-t1', status: 'COMPLETED', totalTokens: 11 } as any,
        { sessionId: '100', turnId: '100-t1' }));
    await flush();
    assert.ok(v.store.getTool('card-a'), '前置：卡应存在');
    assert.ok(v.store.getTurn('100-t1'), '前置：轮次实体应存在');

    await v.view.handleModelUpdated();
    let release!: (value: any) => void;
    (chatApi as any).sendCommand = () => new Promise(resolve => { release = resolve; });
    const resending = v.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    await flush();

    // 回执到达前切到 B。
    await v.enter('300');
    // 迟到的 A 回执：A 的轮次 t1 与执行 e1 已被后端物理作废。
    release({ sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'], invalidatedExecutionIds: ['e1'] });
    await resending;
    await flush();

    assert.ok(v.harness.server.connection('300'), '迟到回执关闭了正在查看的 B 的展示连接');
    assert.equal(v.view.currentActiveSession.value?.id, '300', '展示会话不得被迟到回执切走');
    assert.equal(v.store.getTurn('100-t1'), undefined,
      'A 的轮次实体事实未被更新 —— 迟到回执只保住了连接，却没保住实体（resetSession 不清 turns/tools）');
    assert.equal(v.store.getTool('card-a'), undefined,
      'A 的卡片实体事实未被更新：被作废执行的待审批卡仍留在唯一工具槽里');
  } finally {
    v.cleanup();
  }
});

test('探针4-1 重发回执先到、HISTORY_INVALIDATED 后到（与审查用例相反顺序）', async () => {
  const v = setupView();
  try {
    await v.enter('100');
    await v.view.handleModelUpdated();
    let release!: (value: any) => void;
    (chatApi as any).sendCommand = () => new Promise(resolve => { release = resolve; });
    const resending = v.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    await flush();

    // 回执先到：此时新代际正文尚未到达。
    release({ sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'], invalidatedExecutionIds: ['e1'] });
    await resending;
    await flush();
    assert.ok(!v.view.displayedMessages.value.some(m => m.content.includes('100已提交回答')),
      '被作废轮次的旧正文应已消失');

    // 随后失效事件与新代际提交到达。
    v.harness.server.push('100',
      frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }),
      frame('MESSAGE_COMMITTED', { messageId: '1003', sessionId: '100', turnId: '100-t2', type: 'USER', text: '重发提问' },
        { turnId: '100-t2' }),
      frame('MESSAGE_COMMITTED', { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '重发后的正文', streamKey: 'resend-live' },
        { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush();
    assert.ok(v.view.displayedMessages.value.some(m => m.content.includes('重发后的正文')),
      '回执先到、失效事件后到的顺序下，新代际正文丢失');
  } finally {
    v.cleanup();
  }
});

test('探针4-2 同一份重发回执重复到达两次必须幂等', async () => {
  const v = setupView();
  try {
    await v.enter('100');
    v.harness.server.push('100',
      frame('MESSAGE_COMMITTED', { messageId: '1003', sessionId: '100', turnId: '100-t2', type: 'USER', text: '重发提问' },
        { turnId: '100-t2' }),
      frame('MESSAGE_COMMITTED', { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '重发后的正文', streamKey: 'resend-live' },
        { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush();
    const snapshot = () => JSON.stringify({
      msgs: v.view.displayedMessages.value.map(m => [m.id, m.content]),
      turns: [...v.store.turns.keys()].sort(),
      tools: [...v.store.tools.keys()].sort(),
    });
    const before = snapshot();

    // 同一回执投递两次（HTTP 重试 / 双通道竞态）。
    const receipt = { sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'], invalidatedExecutionIds: ['e1'] };
    v.store.discardByInvalidation('100', receipt.invalidatedTurnIds, receipt.invalidatedExecutionIds);
    const once = snapshot();
    v.store.discardByInvalidation('100', receipt.invalidatedTurnIds, receipt.invalidatedExecutionIds);
    assert.equal(snapshot(), once, '重发回执重复投递不幂等：第二次改变了状态');
    assert.ok(once.includes('重发后的正文'), '作废不得波及新代际正文');
    assert.notEqual(before, once, '本用例前置无效：第一次作废应当改变状态');
  } finally {
    v.cleanup();
  }
});

test('探针4-3 只带 invalidatedTurnIds（不带 invalidatedExecutionIds）时作废范围', async () => {
  const v = setupView();
  try {
    await v.enter('100');
    v.harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-a', executionId: 'e1' })));
    await flush();
    assert.ok(v.store.getTool('card-a'), '前置：卡应存在');

    v.store.discardByInvalidation('100', ['100-t1'], []);

    // 卡片保留与后端删除口径一致：ConversationRollbackService 也是按 executionId 删卡
    // （deleteByExecutionIds），回执不带 executionIds 即表示后端同样没删这张卡。
    // 前端不得单方面把它清掉 —— 那会造成「卡片消失但服务端仍在等审批」。
    assert.ok(v.store.getTool('card-a'),
      '回执未点名 executionId 时前端单方面删卡，与后端删除口径不一致');
    // 但轮次级作废必须照做：响应槽立墓碑，轮次实体移除。
    assert.equal(v.store.getTurn('100-t1'), undefined, '轮次实体未被按 turnId 作废');
  } finally {
    v.cleanup();
  }
});

/* ============================ 缺陷 5：未决集合对账的跨根边界 ============================ */

test('探针5-1 对 A 做未决集合对账时，另一个根会话 B 的未决卡不得被误删', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    // 两条根会话的连接同时活着。
    await enterLive(harness, '100', [], { sessions: [{ id: '100' } as any] });
    attachStreamV3('300');
    await flush();
    harness.server.push('300', readyFrame('ready-300'));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '300', historyRevision: '1', sessions: [{ id: '300' } as any],
    }));
    await flush();

    // A 与 B 各有一张未决卡；B 的会话实体明确声明自己的根（让归属判定真的被执行，而不是靠「实体缺失」侥幸）。
    harness.server.push('300', frame('SESSION_UPDATED', { id: '300', rootSessionId: '300', name: 'B' } as any,
      { sessionId: '300' }));
    harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-a', conversationId: '100', executionId: 'e1' })));
    harness.server.push('300', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-b', conversationId: '300', executionId: 'e2' })));
    await flush();
    assert.ok(store.getTool('card-a') && store.getTool('card-b'), '前置：两张卡都应存在');

    // 对 A 做对账：A 的未决集合为空（card-a 已在别处决断），B 的连接完全不受影响。
    const token = store.beginResync('100');
    store.applyBootstrap('100', bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any], toolCalls: [],
    }), token);
    await flush();

    assert.equal(store.getTool('card-a'), undefined, 'A 自己已决断的卡应被对账清掉');
    assert.ok(store.getTool('card-b'), '对 A 对账误删了另一个根会话 B 的未决卡（跨根误伤）');
  } finally {
    harness.teardown();
  }
});

test('探针5-2 子会话的待审批卡在根视图仍能冒泡，且不被对账清掉', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    await enterLive(harness, '100', [], {
      sessions: [{ id: '100' } as any, subSessionVO('101', '100', '子代理')],
    });
    // 子会话的未决卡（会话树内 → bootstrap.toolCalls 应包含它）。
    harness.server.push('100',
      frame('SESSION_UPDATED', { id: '101', rootSessionId: '100', name: '子代理' } as any, { sessionId: '101' }),
      frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-sub', conversationId: '101', executionId: 'e1' })));
    await flush();
    assert.ok(store.getTool('card-sub'), '前置：子会话卡片实体应存在');

    // 一次完整的对账：未决集合里仍然包含这张卡。
    const token = store.beginResync('100');
    store.applyBootstrap('100', bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1',
      sessions: [{ id: '100' } as any, subSessionVO('101', '100', '子代理')],
      toolCalls: [promiseCard({ id: 'card-sub', conversationId: '101', executionId: 'e1' })],
    }), token);
    await flush();

    assert.ok(store.getTool('card-sub'), '未决集合内的子会话卡片被对账误删');
    const bubbled = projectSessionMessages('100').flatMap(m => m.promptCards ?? [])
      .filter(c => c.toolCallId === 'card-sub');
    assert.equal(bubbled.length, 1, '子会话待审批卡未能在根视图冒泡（跨会话冒泡被破坏）');
    assert.equal(bubbled[0]?.pending, true);
  } finally {
    harness.teardown();
  }
});

test('探针5-3 历史 TOOL 行的权威工具事实按 version 并入唯一工具槽后，对账不得让已决断卡复活', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    const decided = promiseCard({
      id: 'card-x', version: '5', pending: false, status: 'completed',
      allowedActions: [], rawOutput: { outcome: 'APPROVED' },
    });
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' },
      { id: '1002', sessionId: '100', turnId: '100-t1', type: 'TOOL', toolCallId: 'card-x', toolCall: decided },
    ], { toolCalls: [] });
    await flush();
    const cards = projectSessionMessages('100').flatMap(m => m.promptCards ?? []).filter(c => c.toolCallId === 'card-x');
    assert.equal(cards.length, 1, '已决断卡应作为历史事实保留展示');
    assert.equal(cards[0]?.pending, false, '已决断卡不得仍以待审批悬挂');
    // 10-05 契约变更：历史 TOOL 行的权威事实**必须并入**唯一工具槽。
    //   旧口径（对账只清 pending、不并入历史 v2）会让「暂存/迟到的旧 pending 帧」因为槽里
    //   没有版本基线而被当新实体接纳，把审批按钮在已审批之后又复活（见 D3 反例）。
    //   并入后：已决断 v2 成为基线，更旧的 v1 覆盖不了它。
    assert.ok(store.getTool('card-x'), '历史 TOOL 行的已决断事实应并入唯一工具槽，作为版本比较基线');
    assert.equal(store.getTool('card-x')?.pending, false, '并入的基线必须是已决断态（v5）');
  } finally {
    harness.teardown();
  }
});

/* ====== 针对「以连接身份建代次」这版实现本身的重反例（试图打破新修的代码） ====== */

test('探针6-1 bootstrap 失败后同一条连接再来 READY 必须能重试（abortSync 的新 token 须被接住）', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    attachStreamV3('100');
    await flush(8);
    harness.server.push('100', readyFrame('conn-1'));
    await flush(8);
    assert.equal(harness.bootstrap.calls.length, 1);

    // 第一次 bootstrap 失败 → abortSync（内部换代次并清暂存）
    assert.ok(harness.bootstrap.rejectNext('会话同步失败'));
    await flush(8);
    assert.equal(store.getPhase('100'), 'idle', '失败后应回到 idle');

    // 同一条连接重试：若调用方没接住 abortSync 的返回值，本地 token 停在作废值 → 这次成功会被自己丢弃
    harness.server.push('100', readyFrame('conn-1'));
    await flush(8);
    assert.equal(harness.bootstrap.calls.length, 2, '同连接在失败后再次 READY 必须能重试 bootstrap');
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any],
    })));
    await flush(8);
    assert.equal(store.getPhase('100'), 'live',
      '重试的 bootstrap 被自身作废（abortSync 返回的新 token 未被接住）');
  } finally {
    harness.teardown();
  }
});

test('探针6-2 失败后重试期间到达的帧不得被静默丢弃（暂存屏障必须已就位）', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    attachStreamV3('100');
    await flush(8);
    harness.server.push('100', readyFrame('conn-1'));
    await flush(8);
    assert.ok(harness.bootstrap.rejectNext('会话同步失败'));
    await flush(8);

    // 重试的 READY 之后、bootstrap 返回之前到达的帧
    harness.server.push('100', readyFrame('conn-1'),
      frame('TEXT_DELTA', { streamKey: 'retry-live', delta: '重试期间正文' },
        { sessionId: '100', turnId: '100-t9', executionId: 'e9' }));
    await flush(8);
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any],
    })));
    await flush(8);
    assert.equal(store.getResponse('retry-live')?.text, '重试期间正文',
      '重试同步期间到达的帧被静默丢弃（abortSync 清了暂存且重试未补位）');
    assert.ok(projectSessionMessages('100').some(m => m.content.includes('重试期间正文')),
      '重试期间到达的正文未进入派生视图');
  } finally {
    harness.teardown();
  }
});

test('探针6-3 换连接走 beginResync：新连接不得停在 awaiting-ready（否则后续帧被无限暂存）', async () => {
  const harness = createHarness();
  const cap = captureReconnect();
  try {
    const store = useStreamV3Store();
    await enterLive(harness, '100', []);
    harness.server.closeFromServer('100');
    await flush(8);
    cap.scheduled[0]!();
    await flush(10);
    harness.server.push('100', readyFrame('conn-2'));
    await flush(8);
    assert.equal(store.getPhase('100'), 'bootstrapping',
      '换连接后不得退回 awaiting-ready：新连接不会再发 READY，帧会被无限暂存');
    assert.equal(harness.bootstrap.calls.length, 2, '换连接必须重新 bootstrap');
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({ rootSessionId: '100', historyRevision: '1' })));
    await flush(8);
    assert.equal(store.getPhase('100'), 'live');
  } finally {
    cap.restore();
    harness.teardown();
  }
});

test('探针6-4 新连接同步期间到达的实时帧必须在快照合并后回放（断流后界面要继续更新）', async () => {
  const harness = createHarness();
  const cap = captureReconnect();
  try {
    const store = useStreamV3Store();
    await enterLive(harness, '100', [
      { id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' },
    ]);
    harness.server.closeFromServer('100');
    await flush(8);
    cap.scheduled[0]!();
    await flush(10);
    harness.server.push('100', readyFrame('conn-2'),
      frame('TEXT_DELTA', { streamKey: 'after-reconnect', delta: '重连后增量' },
        { sessionId: '100', turnId: '100-t1', executionId: 'e1' }));
    await flush(8);
    assert.ok(harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any],
      history: { records: [{ id: '1001', sessionId: '100', turnId: '100-t1', type: 'USER', text: '提问' }],
                 turns: {}, hasMore: false, nextCursor: null },
    })));
    await flush(8);
    assert.equal(store.getResponse('after-reconnect')?.text, '重连后增量',
      '新连接同步期间到达的帧未在快照合并后回放');
    assert.ok(projectSessionMessages('100').some(m => m.content.includes('重连后增量')),
      '重连后的实时正文未进入派生视图（界面从此不再更新）');
  } finally {
    cap.restore();
    harness.teardown();
  }
});
