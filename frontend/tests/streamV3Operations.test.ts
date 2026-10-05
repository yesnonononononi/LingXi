import test from 'node:test';
import assert from 'node:assert/strict';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { createHarness, flush, frame, readyFrame } from './harness/streamV3Harness';

/**
 * 第 4B 组操作回归：**实际操作入口**读的是 v3 派生视图。
 *
 * <p>store 测试全绿不等于这些操作正常 —— 导出、编辑定位、分页滚动补偿都直接消费派生数组。
 * 这里按「用户会做的事」组织用例：先建流 → bootstrap → 推帧，再对派生结果断言。</p>
 */

/** 建立一条已 bootstrap 完成的会话，返回 store。 */
async function live() {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attach();
  harness.server.push('100', readyFrame('conn-1'));
  await flush();
  return { harness, store, session };
}

import { attachStreamV3 } from '../src/services/streamV3Sync';
function attach() { return attachStreamV3('100'); }

/** 组装一份带两轮历史的 bootstrap 快照。 */
function attachableBootstrap() {
  return {
    rootSessionId: '100',
    historyRevision: '1',
    sessions: [],
    history: {
      records: [
        { id: '1001', sessionId: '100', turnId: 't1', type: 'USER', text: '第一条提问' },
        { id: '1002', sessionId: '100', turnId: 't1', type: 'AI', text: '第一条回答' },
      ],
      turns: {}, nextCursor: '1001', hasMore: true,
    },
    toolCalls: [], turns: [], executions: [],
  };
}

test('4B 操作回归：导出读派生视图 —— 用户行在前、助手行在后，正文完整', async () => {
  const { harness, store, session } = await live();
  try {
    harness.bootstrap.resolveNext(attachableBootstrap() as any);
    await flush();
    assert.equal(store.getPhase('100'), 'live');

    const rows = projectSessionMessages('100');
    // 导出按派生数组顺序拼 Markdown：必须保持「提问 → 回答」的可读顺序
    assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
    assert.equal(rows[0].content, '第一条提问');
    assert.equal(rows[1].content, '第一条回答');

    // 追加一轮后，导出内容随之增长且顺序稳定
    store.replaceHistory('100', {
      records: [
        { id: '1001', sessionId: '100', turnId: 't1', type: 'USER', text: '第一条提问' },
        { id: '1002', sessionId: '100', turnId: 't1', type: 'AI', text: '第一条回答' },
        { id: '1003', sessionId: '100', turnId: 't2', type: 'USER', text: '第二条提问' },
        { id: '1004', sessionId: '100', turnId: 't2', type: 'AI', text: '第二条回答' },
      ],
      turns: {}, nextCursor: null, hasMore: false,
    });
    const after = projectSessionMessages('100').filter(m => m.role === 'user' || m.role === 'assistant');
    assert.deepEqual(after.map(r => r.content),
      ['第一条提问', '第一条回答', '第二条提问', '第二条回答']);
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 操作回归：编辑定位用落库消息身份，在派生视图里能找到', async () => {
  const { harness, store, session } = await live();
  try {
    harness.bootstrap.resolveNext(attachableBootstrap() as any);
    await flush();

    // 编辑入口按 id 定位原消息；定位到的 id 必须原样回传给 resendMessageId
    const target = projectSessionMessages('100').find(m => m.id === '1001');
    assert.ok(target, '落库消息必须能在派生视图里按 id 定位');
    assert.equal(target?.role, 'user');
    assert.equal(target?.turnId, 't1');

    // 回答组的气泡 id 是 msg-{session}-turn-{turn}（聚合层钉的稳定 id），不是落库行 id
    const answer = projectSessionMessages('100').find(m => m.role === 'assistant');
    assert.equal(answer?.id, 'msg-100-turn-t1');
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 操作回归：分页前置插入不跳动 —— 旧 id 全部保留、顺序仍为旧→新', async () => {
  const { harness, store, session } = await live();
  try {
    // 首屏（最新页）：只有第二轮
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: {
        records: [
          { id: '1003', sessionId: '100', turnId: 't2', type: 'USER', text: '第二条提问' },
          { id: '1004', sessionId: '100', turnId: 't2', type: 'AI', text: '第二条回答' },
        ],
        turns: {}, nextCursor: '1003', hasMore: true,
      },
      toolCalls: [], turns: [], executions: [],
    } as any);
    await flush();

    const beforeIds = projectSessionMessages('100').map(m => m.id);
    assert.deepEqual(beforeIds, ['1003', 'msg-100-turn-t2']);

    // 触顶加载更早的一页：旧轮次**前置**进来
    store.ingestHistoryPage('100', {
      records: [
        { id: '1001', sessionId: '100', turnId: 't1', type: 'USER', text: '第一条提问' },
        { id: '1002', sessionId: '100', turnId: 't1', type: 'AI', text: '第一条回答' },
      ],
      turns: {}, hasMore: false, nextCursor: null,
    }, '1');
    await flush();

    const after = projectSessionMessages('100');
    // 旧内容全部保留（滚动补偿才能对上位置），顺序仍为「旧 → 新」
    // 用户行保留落库 id；回答组气泡是聚合层钉的稳定 id
    assert.deepEqual(after.map(m => m.id),
      ['1001', 'msg-100-turn-t1', '1003', 'msg-100-turn-t2']);
    assert.deepEqual(after.map(m => m.content),
      ['第一条提问', '第一条回答', '第二条提问', '第二条回答']);
    // 已可见的行不被替换成新对象（避免整列表重渲染导致跳动）
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 操作回归：切走会话不把进行中气泡误判为已完成', async () => {
  const { harness, store, session } = await live();
  try {
    harness.bootstrap.resolveNext(attachableBootstrap() as any);
    await flush();

    // 用户切走（abort 只关前端连接），执行仍在跑：响应保持未定格
    // 该轮已有一条落库回答行（回答组存在），活响应叠加其上
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-1', delta: '写到一半' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    await flush();

    const bubble = projectSessionMessages('100').find(m => m.role === 'assistant' && m.turnId === 't1');
    assert.ok(bubble, '运行中的回答组应存在');
    assert.equal(bubble?.isComplete, false, '切走不得把它就地标成已完成');

    session.detach();
  } finally {
    harness.teardown();
  }
});

/* ─────────────────────────────────────────────────────────────────────────
 * 生产入口回归：直接调用导出 / 加载更多的**生产实现**，而不是只看派生数组。
 * ──────────────────────────────────────────────────────────────────────── */

import { ref, computed } from 'vue';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { chatApi } from '../src/services/chat';
import { buildSessionMarkdown } from '../src/utils/session';
import type { ChatSession } from '../src/types/chat';

const row = (id: string, turnId: string, type: string, text: string) =>
  ({ id, sessionId: '100', turnId, type, text });

test('4B 回归：会话同步完成后，再收到 USER 提交立即入视图（不因缺 streamKey 丢弃）', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  try {
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: { records: [row('1001', 't1', 'USER', '第一条提问'), row('1002', 't1', 'AI', '第一条回答')],
        turns: {}, nextCursor: null, hasMore: false },
      toolCalls: [], turns: [], executions: [],
    } as any);
    await flush();
    assert.equal(store.getPhase('100'), 'live');

    // 已有连接上，用户新提问落库并推送 MESSAGE_COMMITTED —— USER 行本来就没有 streamKey
    harness.server.push('100', frame('MESSAGE_COMMITTED', {
      messageId: '2001', sessionId: '100', turnId: 't2', text: '新提问', type: 'USER',
    }, { sessionId: '100', turnId: 't2' }));
    await flush();

    const rows = projectSessionMessages('100');
    assert.ok(
      rows.some(m => m.id === '2001' && m.role === 'user' && m.content === '新提问'),
      'USER 提交必须立即入视图，实际: ' + JSON.stringify(rows.map(r => [r.id, r.role, r.content]))
    );
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 回归：过期代际的详情/对账快照不抹掉实时写入的新行', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  try {
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: { records: [row('1001', 't1', 'USER', '第一条提问')], turns: {}, nextCursor: null, hasMore: false },
      toolCalls: [], turns: [], executions: [],
    } as any);
    await flush();

    // 重发推进代际
    harness.server.push('100', frame('HISTORY_INVALIDATED',
      { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));
    await flush();
    // 新代际里实时写入一行
    harness.server.push('100', frame('MESSAGE_COMMITTED', {
      messageId: '2002', sessionId: '100', turnId: 't3', text: '新代际行', type: 'USER',
    }, { sessionId: '100', turnId: 't3' }));
    await flush();

    // 迟到的 rev-1 详情快照：必须整体丢弃
    const applied = store.ingestHistoryPage('100', {
      records: [row('1001', 't1', 'USER', '第一条提问')],
      turns: {}, hasMore: false, nextCursor: null,
    }, '1');
    assert.equal(applied, false, '过期代际的快照不得应用');

    const rows = projectSessionMessages('100');
    assert.ok(rows.some(m => m.id === '2002'), '新代际实时行不得被旧快照抹掉');
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 操作回归：加载更多历史走真实入口 —— 写入 → 记录高度 → 渲染后恢复，游标只在同代际推进', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const calls: string[] = [];
  const origIngest = store.ingestHistoryPage.bind(store);
  (store as any).ingestHistoryPage = (...args: any[]) => {
    // 只记录**真正写入**的调用：守卫丢弃（过期代际）不算写入
    const applied = origIngest(...args);
    if (applied) calls.push('写入 v3');
    return applied;
  };
  const container = {
    beforePrepend: () => calls.push('beforePrepend'),
    afterPrepend: () => calls.push('afterPrepend'),
  };
  const session = ref<ChatSession>({
    id: '100', title: '会话', createdAt: 0, updatedAt: 0,
    hasMoreMessages: true, nextMessageCursor: '1003',
  } as unknown as ChatSession);
  const localSessions = ref<ChatSession[]>([session.value]);
  const history = useChatHistory({
    currentActiveSession: computed(() => session.value),
    localSessions,
    messagesContainerRef: { value: container } as any,
    // 同步执行：让 350ms 动画延时与 200ms 收起延时即时完成，loading 态在用例内同步复位
    scheduleTimeout: (handler) => { handler(); return 0; },
  });

  // 先确立代际基线（真实流程里由 bootstrap / HISTORY_INVALIDATED 推进）：
  // 没有基线时 revisionMatches 视为「未启用守卫」，测不出过期丢弃。
  store.applyFrame('100', frame('HISTORY_INVALIDATED',
    { rootSessionId: '100', historyRevision: '1' }, { sessionId: '100' }));

  // 首屏（最新页）只有第二轮
  store.replaceHistory('100', {
    records: [row('1003', 't2', 'USER', '第二条提问'), row('1004', 't2', 'AI', '第二条回答')],
    turns: {}, hasMore: true, nextCursor: '1003',
  });

  (chatApi as any).fetchSessionMessages = async () => ({
    ok: true,
    data: { records: [row('1001', 't1', 'USER', '第一条提问'), row('1002', 't1', 'AI', '第一条回答')],
      turns: {}, hasMore: false, nextCursor: null },
  });

  await history.handleLoadMoreHistory();

  // 顺序：写入 → 记录高度（此刻 DOM 尚未重渲染，位置仍有效）→ 渲染后恢复
  assert.deepEqual(calls, ['写入 v3', 'beforePrepend', 'afterPrepend'],
    '滚动补偿必须夹在写入与渲染之间，实际: ' + JSON.stringify(calls));
  assert.deepEqual(projectSessionMessages('100').map(m => m.id),
    ['1001', 'msg-100-turn-t1', '1003', 'msg-100-turn-t2']);
  assert.equal(session.value.hasMoreMessages, false, '同代际才推进分页游标');
  assert.equal(session.value.nextMessageCursor, null);

  // 过期代际：请求在途时代际被推进（例如重发触发 HISTORY_INVALIDATED）→ 既不写入，也不推进游标
  calls.length = 0;
  session.value.hasMoreMessages = true;
  session.value.nextMessageCursor = '1003';
  (chatApi as any).fetchSessionMessages = async () => {
    store.applyFrame('100', frame('HISTORY_INVALIDATED',
      { rootSessionId: '100', historyRevision: '99' }, { sessionId: '100' }));
    return { ok: true, data: { records: [row('1001', 't1', 'USER', '旧页')], turns: {}, hasMore: false, nextCursor: null } };
  };
  await history.handleLoadMoreHistory();
  // 过期代际：不写入、不补偿、不推进游标（beforePrepend 也一并跳过，因为没有新内容要补偿）
  assert.deepEqual(calls, [], '过期代际不得写入 v3，也不得做滚动补偿');
  assert.equal(session.value.nextMessageCursor, '1003', '过期代际不得推进游标');
});

test('4B 操作回归：导出正文由派生视图构造（提问在前，回答在后）', () => {
  const md = buildSessionMarkdown('我的会话', [
    { id: '1', role: 'user', content: '问一下', timestamp: 1 },
    { id: '2', role: 'assistant', content: '答一下', timestamp: 2 },
  ] as any);
  assert.ok(md.includes('# 我的会话'));
  assert.ok(md.indexOf('问一下') < md.indexOf('答一下'), '顺序必须保持提问在前');

  // 空标题回落默认；空数组只出头部
  assert.ok(buildSessionMarkdown(undefined, []).includes('# 灵犀会话记录'));
});

/* ─────────────────────────────────────────────────────────────────────────
 * 时序回归（评审复现固化）：迟到提交复活作废回答 / 终态对账清掉在途新行。
 * 两条都必须走**真实入口**（SSE ingress 与 reconcileSessionAfterStream），
 * 直接调 store 的用例测不出这两条。
 * ──────────────────────────────────────────────────────────────────────── */

test('4B 时序回归：已作废响应的迟到提交必须整条丢弃，不得复活旧回答', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  try {
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: { records: [row('1001', 't1', 'USER', '提问')], turns: {}, nextCursor: null, hasMore: false },
      toolCalls: [], turns: [], executions: [],
    } as any);
    await flush();

    // 第一段回答：流式 → 落库
    harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'sk-1', delta: '旧回答' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    harness.server.push('100', frame('MESSAGE_COMMITTED', {
      streamKey: 'sk-1', messageId: '1002', sessionId: '100', turnId: 't1', text: '旧回答', type: 'AI',
    }, { sessionId: '100', turnId: 't1', executionId: '900', streamKey: 'sk-1' }));
    await flush();
    assert.ok(projectSessionMessages('100').some(m => m.content === '旧回答'));

    // 重发：代际推进，sk-1 成墓碑、历史清空
    harness.server.push('100', frame('HISTORY_INVALIDATED',
      { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));
    await flush();
    assert.equal(projectSessionMessages('100').filter(m => m.content === '旧回答').length, 0,
      '作废后旧回答不得再显示');

    // 网络上迟到的旧提交：墓碑必须阻断**整条**提交（含历史行写入）
    harness.server.push('100', frame('MESSAGE_COMMITTED', {
      streamKey: 'sk-1', messageId: '1002', sessionId: '100', turnId: 't1', text: '旧回答', type: 'AI',
    }, { sessionId: '100', turnId: 't1', executionId: '900', streamKey: 'sk-1' }));
    await flush();

    assert.equal(
      projectSessionMessages('100').filter(m => m.content === '旧回答').length, 0,
      '迟到提交不得复活已作废的回答，实际: ' + JSON.stringify(projectSessionMessages('100').map(m => m.content))
    );
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 时序回归：终态对账（真实入口）在途时收到新提交，不得被旧快照清掉', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const sessionRow = ref<ChatSession>({ id: '100', title: '会话', createdAt: 0, updatedAt: 0 } as unknown as ChatSession);
  const history = useChatHistory({
    currentActiveSession: computed(() => sessionRow.value),
    localSessions: ref([sessionRow.value]),
    messagesContainerRef: { value: null } as any,
    scheduleTimeout: (handler) => { handler(); return 0; },
  });
  const session = attachStreamV3('100');
  try {
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: { records: [row('1', 't1', 'USER', '一'), row('2', 't1', 'AI', '二')],
        turns: {}, nextCursor: null, hasMore: false },
      toolCalls: [], turns: [], executions: [],
    } as any);
    await flush();

    //
    // 可控 Promise：**先挂起历史请求**，让测试主体能在「请求在途」期间推 SSE 帧、断言、再放行。
    //
    // ⚠️ 断言必须放在测试主体里 —— 放进 fetchSessionMessages 桩内会被
    // reconcileSessionAfterStream 的 try/catch 吞掉（只打日志，用例照样绿），
    // 那样这条时序保障就不是验收证据。
    //
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });

    (chatApi as any).fetchSessionTree = async () => ({
      ok: true,
      data: { rootSessionId: '100', root: sessionRow.value, subSessions: [] },
    });
    (chatApi as any).fetchSessionMessages = async () => {
      // 在途：新提交先到达并应用进 store（推帧后排空 SSE 读取循环）
      harness.server.push('100', frame('MESSAGE_COMMITTED', {
        messageId: '3', sessionId: '100', turnId: 't2', text: '三', type: 'USER',
      }, { sessionId: '100', turnId: 't2' }));
      await flush();
      await historyGate;   // ← 挂起，等测试主体断言完再放行旧快照
      return { ok: true, data: { records: [row('1', 't1', 'USER', '一')], turns: {}, hasMore: false, nextCursor: null } };
    };

    const reconcile = history.reconcileSessionAfterStream('100');
    // 让对账推进到「历史请求挂起」为止
    await flush(8);

    // ★ 断言在测试主体：新行必须已写入 store（这里失败 = 用例真正失败）
    assert.ok(store.getHistory('100').get('3'),
      '在途新行必须先于旧快照进入 store');

    // 放行旧快照（不含新行）
    releaseHistory();
    await reconcile;
    await flush();

    const contents = projectSessionMessages('100').map(m => m.content);
    assert.deepEqual(contents, ['一', '二', '三'],
      '旧快照不得清掉在途写入的新行，实际: ' + JSON.stringify(contents));
    session.detach();
  } finally {
    harness.teardown();
  }
});

test('4B 回归：子会话代次守卫按根会话校验 —— 代际推进后旧页不得写入', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  try {
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext({
      rootSessionId: '100', historyRevision: '1', sessions: [],
      history: { records: [row('1001', 't1', 'USER', '根提问')], turns: {}, nextCursor: null, hasMore: false },
      toolCalls: [], turns: [], executions: [],
    } as any);
    // 子会话实体到达（声明的根是 100）—— SESSION_UPDATED 把它写进 sessions 槽
    harness.server.push('100', frame('SESSION_UPDATED', { id: '200', rootSessionId: '100', name: '子代理' }));
    await flush();

    // 子会话的代际校验必须**归根**（bootstrap 把代际记在根会话键下）；
    // 若用子会话 id 读会得到 undefined，被 revisionMatches 解释成「不检查」→ 守卫整体失效。
    const captured = store.currentHistoryRevision('200');
    assert.equal(captured, '1', '子会话代际必须归根读取，实际: ' + JSON.stringify(captured));

    const subPage = { records: [row('2001', 't1', 'USER', '子会话行')], turns: {}, hasMore: true, nextCursor: '2001' };
    assert.equal(store.ingestHistoryPage('200', subPage, captured), true, '同代际首屏应写入子会话槽');
    assert.ok(store.getHistory('200').get('2001'));

    // 根代际推进（重发触发 HISTORY_INVALIDATED）
    harness.server.push('100', frame('HISTORY_INVALIDATED',
      { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));
    await flush();
    assert.equal(store.currentHistoryRevision('200'), '2', '代际推进必须已生效');

    // 旧子会话页（捕获于代际 1）：必须整体丢弃
    assert.equal(store.ingestHistoryPage('200', subPage, captured), false,
      '代际推进后旧子会话页不得写入');

    // 用**当前**代际捕获后才能写入
    const current = store.currentHistoryRevision('200');
    assert.equal(current, '2');
    assert.equal(store.ingestHistoryPage('200', subPage, current), true);

    session.detach();
  } finally {
    harness.teardown();
  }
});
