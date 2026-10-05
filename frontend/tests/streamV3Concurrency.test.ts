import test from 'node:test';
import assert from 'node:assert/strict';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { createHarness, frame, promiseCard, subSessionVO } from './harness/streamV3Harness';

/**
 * 场景 3：根与子执行并发。
 *
 * 并发下最容易错的两件事：① 按「最新一个」推断归属（多执行并行时必错）；
 * ② 一个执行结束就把整个会话的进行态收掉（截断别人正在写的正文）。
 * 因此这里一律用**固定身份**（sessionId + executionId + turnId）驱动，并按执行断言。
 */

/** 建立根 + 两个子会话的现场。 */
function setup() {
  const harness = createHarness();
  const store = useStreamV3Store();
  store.applyFrame('100', frame('SESSION_UPDATED', subSessionVO('200', '100', '研究员')));
  store.applyFrame('100', frame('SESSION_UPDATED', subSessionVO('300', '100', '审校员')));
  return { harness, store };
}

test('场景3-1 交错发送正文与思考：各归其会话与执行，互不串写', () => {
  const { harness, store } = setup();
  try {
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-root', delta: '根' }, { sessionId: '100', executionId: '1', turnId: 't1' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s1', delta: '子一' }, { sessionId: '200', executionId: '2', turnId: 't2' }));
    store.applyFrame('100', frame('THINKING_DELTA', { streamKey: 'sk-s1', delta: '子一想' }, { sessionId: '200', executionId: '2', turnId: 't2' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s2', delta: '子二' }, { sessionId: '300', executionId: '3', turnId: 't3' }));
    store.applyFrame('100', frame('THINKING_DELTA', { streamKey: 'sk-root', delta: '根想' }, { sessionId: '100', executionId: '1', turnId: 't1' }));

    assert.equal(store.getResponse('sk-root')?.sessionId, '100');
    assert.equal(store.getResponse('sk-root')?.executionId, '1');
    assert.equal(store.getResponse('sk-s1')?.sessionId, '200');
    assert.equal(store.getResponse('sk-s1')?.executionId, '2');
    assert.equal(store.getResponse('sk-s2')?.sessionId, '300');

    assert.equal(store.getResponse('sk-root')?.text, '根');
    assert.equal(store.getResponse('sk-root')?.thinking, '根想');
    assert.equal(store.getResponse('sk-s1')?.text, '子一');
    assert.equal(store.getResponse('sk-s1')?.thinking, '子一想');
    assert.equal(store.getResponse('sk-s2')?.text, '子二');
  } finally {
    harness.teardown();
  }
});

test('场景3-2 一个执行结束不截断其他执行', () => {
  const { harness, store } = setup();
  try {
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-root', delta: '根' }, { sessionId: '100', executionId: '1', turnId: 't1' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s1', delta: '子一' }, { sessionId: '200', executionId: '2', turnId: 't2' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s2', delta: '子二' }, { sessionId: '300', executionId: '3', turnId: 't3' }));

    // 只有执行 2 结束
    store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { sessionId: '200', executionId: '2' }));

    assert.equal(store.getResponse('sk-s1')?.finalized, true, '结束的执行应定格');
    assert.equal(store.getResponse('sk-root')?.finalized, false, '别的执行不得被一起截断');
    assert.equal(store.getResponse('sk-s2')?.finalized, false);

    // 定格的那个丢弃迟到增量，未定格的继续追加
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s1', delta: 'X' }, { sessionId: '200', executionId: '2' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-root', delta: '继续' }, { sessionId: '100', executionId: '1' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-s2', delta: '也在写' }, { sessionId: '300', executionId: '3' }));

    assert.equal(store.getResponse('sk-s1')?.text, '子一', '已结束的执行不得再收正文');
    assert.equal(store.getResponse('sk-root')?.text, '根继续', '并发中的执行必须继续收正文');
    assert.equal(store.getResponse('sk-s2')?.text, '子二也在写');
  } finally {
    harness.teardown();
  }
});

test('场景3-3 视图分离：主聊天只读根正文，子面板只读该子会话正文', () => {
  const { harness, store } = setup();
  try {
    store.replaceHistory('100', {
      records: [{ id: '1', sessionId: '100', turnId: 't1', type: 'AI', text: '根正文' }],
      turns: {}, hasMore: false, nextCursor: null,
    });
    store.replaceHistory('200', {
      records: [{ id: '2', sessionId: '200', turnId: 't2', type: 'AI', text: '子一正文' }],
      turns: {}, hasMore: false, nextCursor: null,
    });
    store.replaceHistory('300', {
      records: [{ id: '3', sessionId: '300', turnId: 't3', type: 'AI', text: '子二正文' }],
      turns: {}, hasMore: false, nextCursor: null,
    });

    const contents = (messages: { content: string }[]) => messages.map(m => m.content).filter(Boolean);

    assert.deepEqual(contents(projectSessionMessages('100')), ['根正文'], '主聊天不得混入子会话正文');
    assert.deepEqual(contents(projectSessionMessages('100', '200')), ['子一正文']);
    assert.deepEqual(contents(projectSessionMessages('100', '300')), ['子二正文']);
  } finally {
    harness.teardown();
  }
});

test('场景3-4 根与子并发时子卡片在根界面可审批（同一实体）', () => {
  const { harness, store } = setup();
  try {
    // 根自己的卡片 + 子 200 的待审批卡 + 子 300 的已决断卡
    store.applyFrame('100', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'call_root', executionId: '1', conversationId: '100' })));
    store.applyFrame('100', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'call_sub', executionId: '2', conversationId: '200' })));
    store.applyFrame('100', frame('TOOL_CALL_UPDATED', promiseCard({
      id: 'call_sub_done', executionId: '3', conversationId: '300',
      status: 'completed', pending: false, allowedActions: [], rawOutput: { outcome: 'APPROVED' },
    })));

    const rootCards = projectSessionMessages('100').flatMap(m => m.promptCards ?? []).map(c => c.toolCallId).sort();
    assert.deepEqual(rootCards, ['call_root', 'call_sub'], '根界面应能直接审批子卡片，但不重复展示已决断的');

    // 审批后同一实体更新：子卡片不再「待审批」，因此不再冒泡到根界面（根只冒泡待审批的子卡），
    // 而子面板读的是同一份实体，显示为已决断。
    store.ingestToolCall(promiseCard({
      id: 'call_sub', executionId: '2', conversationId: '200',
      status: 'completed', pending: false, allowedActions: [], version: '2', rawOutput: { outcome: 'APPROVED' },
    }));

    const afterRoot = projectSessionMessages('100').flatMap(m => m.promptCards ?? []);
    assert.equal(
      afterRoot.filter(c => c.toolCallId === 'call_sub').length, 0,
      '已决断的子卡片不再冒泡（根界面只展示待审批的子卡）'
    );
    assert.equal(afterRoot.filter(c => c.toolCallId === 'call_root').length, 1, '根自己的卡片不受影响');

    const subCards = projectSessionMessages('100', '200').flatMap(m => m.promptCards ?? []);
    const subCard = subCards.find(c => c.toolCallId === 'call_sub');
    assert.ok(subCard, '子面板仍能看到该卡片');
    assert.equal(subCard?.pending, false, '子面板读的是同一份实体，显示为已决断');
  } finally {
    harness.teardown();
  }
});

test('场景3-5 恢复语义：同一执行暂停后恢复沿用回答组，已提交内容保留、新段落追加', () => {
  const { harness, store } = setup();
  try {
    // 只放用户行：assistant 内容**只能**来自落库行，避免「未提交槽里也有一份副本」把断言蒙过去。
    store.replaceHistory('100', {
      records: [{ id: '1', sessionId: '100', turnId: 't1', type: 'USER', text: '继续' }],
      turns: {}, hasMore: false, nextCursor: null,
    });

    // 第一段：流式 → 落库。落库后该段不再走未提交槽，内容只由历史行提供。
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-1', delta: '已有内容' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    store.applyFrame('100', frame('MESSAGE_COMMITTED', {
      streamKey: 'sk-1', messageId: '2', sessionId: '100', turnId: 't1', text: '已有内容', type: 'AI',
    }, { sessionId: '100', turnId: 't1', executionId: '900', streamKey: 'sk-1' }));

    const committed = projectSessionMessages('100').filter(message => message.role === 'assistant');
    assert.equal(committed.length, 1, '落库后应只有一个回答组');
    assert.equal(committed[0].content, '已有内容', '落库内容来自历史行');

    // ── 挂起语义（§8.1 路径 2 + 路径 4）─────────────────────────────────────
    // 挂起结束**这一段响应**的进行态：定格为「未接收完整」、保留已收片段、拒绝迟到帧。
    // 它不代表执行终结（还会恢复），但当前 streamKey 确实停收了。
    // 注意第一段落库后槽已被 MESSAGE_COMMITTED 定格（那段有它自己的收敛方式），
    // 所以挂起定格必须另起一个**活的**槽来观察。
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-live', delta: '暂停前正文' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    assert.equal(store.getResponse('sk-live')?.finalized, false, '新槽初始是活的');

    store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'SUSPENDED' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    assert.equal(store.getResponse('sk-live')?.finalized, true, '挂起后该片段停收增量');
    assert.equal(store.getResponse('sk-live')?.text, '暂停前正文', '已收片段保留');

    // §8.1 路径 4：定格之后的迟到增量不得复活这一段。
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-live', delta: '迟到正文' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    assert.equal(store.getResponse('sk-live')?.text, '暂停前正文', '迟到增量不得追加');

    // 恢复：**同一个执行、同一个轮次**，用**新 streamKey** 追加到同一回答组（旧片段不重新开放）。
    store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'RUNNING' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-2', delta: '恢复后新增' },
      { sessionId: '100', turnId: 't1', executionId: '900' }));

    const bubbles = projectSessionMessages('100').filter(message => message.role === 'assistant');
    assert.equal(bubbles.length, 1, '恢复必须沿用同一回答组，不得新起一条气泡');
    assert.ok(bubbles[0].content.includes('已有内容'), '已提交内容必须保留，实际: ' + bubbles[0].content);
    assert.ok(bubbles[0].content.includes('恢复后新增'), '恢复后的新段落必须正常展示，实际: ' + bubbles[0].content);
    assert.equal(bubbles[0].isComplete, false, '暂停不是完成：恢复后仍是进行中');
    // 旧片段保持定格：恢复不得把 sk-live 重新开放（否则它又会收增量、把两段搅在一起）。
    assert.equal(store.getResponse('sk-live')?.finalized, true, '恢复不得重新开放旧片段');
  } finally {
    harness.teardown();
  }
});
