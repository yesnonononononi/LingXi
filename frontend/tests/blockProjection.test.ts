/**
 * Block 契约投影守卫（P3）。
 *
 * <p>钉住三条不变量：</p>
 * <ol>
 *   <li><b>块 → 气泡的落点由后端 type/placement 唯一决定</b>：THINKING→thoughtSteps、
 *       TEXT+PROCESS→aiMessages、TEXT+BODY→content、TOOL→toolCalls；顺序全来自 {@code order}。</li>
 *   <li><b>增量按 blockId 覆盖而非版本比较</b>：同一 blockId 的第二次 upsert 必须替换掉第一次，
 *       即使 viewVersion 未变（工具收尾不改 chat_turn，版本号相等是合法情形）。</li>
 *   <li><b>唯一展示链路：视图 → reducer → 按后端顺序渲染</b>。历史分页与实时快照共用
 *       {@link upsertTurnViewIntoMessages}；**没有视图就不展示**，不再有「回落旧聚合」的第二条链路。</li>
 * </ol>
 *
 * <p>这三条正是「删掉前端自造 order / 内容指纹去重 / 旧历史聚合」的前提 —— 前提不成立就不能删旧逻辑。</p>
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Block, TurnViewVO } from '../src/types/block';
import { projectTurnView, upsertBlockIntoBubble, upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import type { ChatMessage, SessionMessageVO } from '../src/types/chat';
import { aggregateRecordsByIdentity, mergeTurnViews } from '../src/utils/session';
import { chatApi } from '../src/services/chat';
import { SessionAPI } from '../src/services/session';

function bubble(): ChatMessage {
  return { id: 'b1', role: 'assistant', content: '', timestamp: 0 };
}

function view(blocks: Block[], viewVersion = 1): TurnViewVO {
  return {
    sessionId: '100',
    turnId: '800',
    status: 'RUNNING',
    viewVersion,
    blocks,
  };
}

const thinking = (order: number): Block => ({
  blockId: 'thinking:r1', type: 'THINKING', order, status: 'COMPLETE', text: '想一下',
});
const processText = (order: number): Block => ({
  blockId: 'text:r1', type: 'TEXT', order, status: 'COMPLETE', placement: 'PROCESS', text: '中途叙述',
});
const bodyText = (order: number): Block => ({
  blockId: 'text:r2', type: 'TEXT', order, status: 'COMPLETE', placement: 'BODY', text: '结论正文',
});
const tool = (order: number, status: Block['status'] = 'COMPLETED'): Block => ({
  blockId: 'tool:call-1', type: 'TOOL', order, status, toolCallId: 'call-1', toolName: 'read_file',
});

test('四种块各归其位，正文与过程分离', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0), processText(1), tool(2), bodyText(3000)]));

  assert.equal(b.thoughtSteps?.length, 1, '思考块进 thoughtSteps');
  assert.equal(b.aiMessages?.length, 1, 'PROCESS 正文进 aiMessages');
  assert.equal(b.toolCalls?.length, 1, '工具块进 toolCalls');
  assert.equal(b.content, '结论正文', 'BODY 正文进气泡 content');
});

test('顺序由后端 order 决定，与传入顺序无关', () => {
  const b = bubble();
  // 故意乱序传入：后端已排好序，前端只是防御性再排一次。
  projectTurnView(b, view([tool(2), thinking(0), processText(1)]));

  const kinds = (b.processTimeline ?? []).map(item => item.type);
  assert.deepEqual(kinds, ['thought', 'intermediate_ai', 'tool'], '时间线必须按 order 升序');
});

test('块状态映射到工具四态：completed≠成功、PROMISED→pending、FAILED→failed', () => {
  const cases: Array<[Block['status'], string]> = [
    ['COMPLETED', 'success'],
    ['FAILED', 'failed'],
    ['REJECTED', 'failed'],
    ['TIMED_OUT', 'failed'],
    ['CANCELLED', 'failed'],
    ['PROMISED', 'pending'],
    ['STREAMING', 'calling'],
  ];
  for (const [status, expected] of cases) {
    const b = bubble();
    projectTurnView(b, view([tool(2, status)]));
    assert.equal(b.toolCalls?.[0].status, expected, `块状态 ${status} 应映射为 ${expected}`);
  }
});

test('重复投影同一视图是幂等的（整体重写，不追加）', () => {
  const b = bubble();
  const v = view([thinking(0), tool(2)]);
  projectTurnView(b, v);
  projectTurnView(b, v);

  assert.equal(b.thoughtSteps?.length, 1, '不能因重复投影而翻倍');
  assert.equal(b.toolCalls?.length, 1);
  assert.equal(b.processTimeline?.length, 2);
});

test('增量按 blockId 覆盖，即使 viewVersion 未变（工具收尾不改 chat_turn）', () => {
  const b = bubble();
  // 先整轮：工具还在跑
  projectTurnView(b, view([thinking(0), tool(2, 'STREAMING')], 5));
  assert.equal(b.toolCalls?.[0].status, 'calling');

  // 再增量：同一 blockId、同一 viewVersion（5），状态翻转为完成
  upsertBlockIntoBubble(b, view([tool(2, 'COMPLETED')], 5));

  assert.equal(b.toolCalls?.length, 1, '同 blockId 必须替换而非追加');
  assert.equal(b.toolCalls?.[0].status, 'success', '版本号相等也必须采纳增量');
  assert.equal(b.thoughtSteps?.length, 1, '未变化的块必须保留');
  assert.equal(b.processTimeline?.length, 2, '时间线同 blockId 也必须替换而非重复');
});

test('增量遇到新 blockId 时追加，不改动其它块', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0)], 5));
  upsertBlockIntoBubble(b, view([tool(2, 'COMPLETED')], 5));

  assert.equal(b.thoughtSteps?.length, 1, '原有思考块保留');
  assert.equal(b.toolCalls?.length, 1, '新块追加');
  assert.equal(b.processTimeline?.length, 2);
});

test('空块增量是空操作（不发空帧语义）', () => {
  const b = bubble();
  projectTurnView(b, view([thinking(0)], 5));
  upsertBlockIntoBubble(b, view([], 5));

  assert.equal(b.thoughtSteps?.length, 1);
  assert.equal(b.processTimeline?.length, 1);
});

/* ------------------------------------------------------------------ */
/* 历史路径接线（批次 2a）：分页 turnViews → 已聚合的气泡               */
/* ------------------------------------------------------------------ */

const HISTORY_SESSION = '100';
const HISTORY_TURN = '800';

/**
 * 一轮历史记录：USER + 「带工具请求的 AI 行」+ 工具结果行。
 *
 * <p>故意让 AI 行的**文本是中途叙述**（该行带 toolCalls，按契约不是结论）—— 于是旧口径下
 * 气泡正文为空、过程项 order = 行下标 × 100。新口径（视图）给的是后端 order 与 BODY 正文，
 * 两者必须可区分，否则「投影没生效」这条回退根本测不出来。</p>
 */
function historyRecords(): SessionMessageVO[] {
  return [
    { id: '1', turnId: HISTORY_TURN, type: 'USER', text: '帮我看下 a.ts', createTime: '2026-10-08T10:00:00Z' },
    {
      id: '2',
      turnId: HISTORY_TURN,
      type: 'AI',
      text: '先读文件',
      thinking: '想一下',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
      createTime: '2026-10-08T10:00:01Z'
    },
    {
      id: '3',
      turnId: HISTORY_TURN,
      type: 'TOOL',
      toolCallId: 'call-1',
      toolCall: {
        id: 'call-1',
        toolName: 'read_file',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: 'file body' }
      },
      createTime: '2026-10-08T10:00:02Z'
    }
  ];
}

/** 后端装配器给出的同一轮块视图：顺序与落点全由后端决定。 */
function historyView(): TurnViewVO {
  return {
    sessionId: HISTORY_SESSION,
    turnId: HISTORY_TURN,
    status: 'COMPLETED',
    viewVersion: 7,
    userMessage: '帮我看下 a.ts',
    blocks: [thinking(0), processText(1), tool(2), bodyText(3000)]
  };
}

test('★ 历史轮次只走视图：整轮按后端 order / 落点重写（不再有 rowIndex*100 旧口径）', () => {
  const messages = aggregateRecordsByIdentity(undefined, historyRecords(), HISTORY_SESSION, {
    [HISTORY_TURN]: historyView()
  });

  const asst = messages.find(m => m.role === 'assistant');

  // 正文来自 BODY 块、顺序与身份全来自后端 —— 前端不再从原始记录推导任何 order
  assert.equal(asst?.content, '结论正文', 'BODY 块必须落到气泡正文');
  assert.equal(asst?.thoughtSteps?.[0].order, 0, '思考 order 取后端值，不是 rowIndex*100');
  assert.equal(asst?.thoughtSteps?.[0].id, 'thinking:r1', '块身份是 blockId');
  assert.equal(asst?.aiMessages?.[0].order, 1, 'PROCESS 文本 order 也取后端值');
  assert.equal(asst?.toolCalls?.[0].order, 2, '工具 order 取后端值（旧口径是 102）');
  assert.equal(asst?.toolCalls?.[0].status, 'success');
  assert.deepEqual(
    (asst?.processTimeline ?? []).map(item => item.type),
    ['thought', 'intermediate_ai', 'tool'],
    '时间线按后端 order 升序'
  );

  const user = messages.find(m => m.role === 'user');
  assert.equal(user?.content, '帮我看下 a.ts', '用户气泡来自视图 userMessage');
});

test('视图缺失即无气泡：不再有「回落旧聚合」这条第二链路', () => {
  const noViews = aggregateRecordsByIdentity(undefined, historyRecords(), HISTORY_SESSION, {});
  const otherTurnOnly = aggregateRecordsByIdentity(undefined, historyRecords(), HISTORY_SESSION, {
    '999': { ...historyView(), turnId: '999' }
  });

  assert.deepEqual(noViews, [], '无视图 = 该轮不展示，不从前端推导');

  // 只有别的轮次有视图时：只渲染那一轮，原始记录里的 800 轮不得凭前端推导冒出来
  assert.equal(otherTurnOnly.length, 2, '只渲染 999 轮（用户 + 助手）');
  assert.deepEqual(
    otherTurnOnly.map(m => m.turnId),
    ['999', '999'],
    '不得出现 800 轮的气泡'
  );
});

test('★ 跨页累计：mergeTurnViews 后到覆盖先到，聚合用合并后的视图', () => {
  const earlier: TurnViewVO = {
    sessionId: HISTORY_SESSION,
    turnId: HISTORY_TURN,
    status: 'RUNNING',
    viewVersion: 3,
    blocks: [thinking(0)]
  };
  const later: TurnViewVO = {
    sessionId: HISTORY_SESSION,
    turnId: HISTORY_TURN,
    status: 'COMPLETED',
    viewVersion: 7,
    blocks: [thinking(0), bodyText(3000)]
  };
  const untouched: TurnViewVO = {
    sessionId: HISTORY_SESSION,
    turnId: '999',
    status: 'COMPLETED',
    viewVersion: 1,
    blocks: []
  };

  const merged = mergeTurnViews({ [HISTORY_TURN]: earlier, '999': untouched }, { [HISTORY_TURN]: later });
  assert.equal(merged[HISTORY_TURN].viewVersion, 7, '后发起的页看到更新的库状态，必须覆盖');
  assert.equal(merged['999'].viewVersion, 1, '本页未出现的轮次不得丢');
  assert.equal(Object.keys(merged).length, 2);

  const messages = aggregateRecordsByIdentity(undefined, historyRecords(), HISTORY_SESSION, merged);
  assert.equal(
    messages.find(m => m.role === 'assistant')?.content,
    '结论正文',
    '合并后的视图（含 BODY 块）必须生效'
  );
});

test('★ 版本拦截：更旧的视图不再覆盖已接受的更新', () => {
  const versions = new Map<string, number>();
  const newer = historyView();          // viewVersion = 7
  const older: TurnViewVO = { ...historyView(), viewVersion: 3, blocks: [thinking(0)] };

  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, newer, versions);
  upsertTurnViewIntoMessages(messages, older, versions);

  const asst = messages.find(m => m.role === 'assistant');
  assert.equal(asst?.content, '结论正文', '旧帧必须被 version 拦截，正文保持新值');
  assert.equal(versions.get(HISTORY_TURN), 7, '累计版本保持最大值');
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1, '同一轮只有一个气泡');
});

test('用户气泡与助手气泡成对出现，且用户气泡在助手气泡之前', () => {
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, historyView(), new Map<string, number>());

  assert.equal(messages.length, 2, '一轮 = 用户提问 + 助手回答');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[0].turnId, HISTORY_TURN);
  assert.equal(messages[1].turnId, HISTORY_TURN);
  assert.equal(messages[1].id, `bubble-${HISTORY_SESSION}-${HISTORY_TURN}`, '气泡身份是 bubble-<sessionId>-<turnId>');
});

test('重复 upsert 同一视图是幂等的，不会重复插入用户消息', () => {
  const versions = new Map<string, number>();
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, historyView(), versions);
  upsertTurnViewIntoMessages(messages, historyView(), versions);

  assert.equal(messages.filter(m => m.role === 'user').length, 1, '用户消息不得重复');
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1, '助手气泡不得重复');
});

/* ------------------------------------------------------------------ */
/* 分页响应透出块视图 —— 2a 的真实断点就在这里                          */
/* ------------------------------------------------------------------ */

/**
 * 打桩 `SessionAPI.messages`（唯一一次网络出口），把一页响应喂进 `chatApi.fetchSessionMessages`。
 *
 * <p>为什么要单独守这一条：2a 排查时发现「`turnViews` 全仓零消费」的真正原因是
 * **`fetchSessionMessages` 的返回对象里根本没有 `turnViews` 字段** —— 后端一直在下发，
 * 前端把它丢了。这种漏字段不报错、不影响既有测试，正是最容易被再次写回去的一类回退。</p>
 */
async function withStubbedPage<T>(
  page: Record<string, unknown>,
  run: (result: Awaited<ReturnType<typeof chatApi.fetchSessionMessages>>) => T
): Promise<T> {
  const original = SessionAPI.messages;
  SessionAPI.messages = (async () => ({ code: 1, data: page })) as unknown as typeof SessionAPI.messages;
  try {
    return run(await chatApi.fetchSessionMessages(HISTORY_SESSION));
  } finally {
    SessionAPI.messages = original;
  }
}

test('★ 分页响应必须透出后端 turnViews，并据此投影单页 messages', async () => {
  await withStubbedPage(
    {
      records: historyRecords(),
      turns: {},
      turnViews: { [HISTORY_TURN]: historyView() },
      nextCursor: null,
      hasMore: false
    },
    res => {
      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.equal(res.data.turnViews[HISTORY_TURN]?.viewVersion, 7, 'API 层不得丢弃 turnViews');
      const asst = res.data.messages.find(m => m.role === 'assistant');
      assert.equal(asst?.content, '结论正文', '单页 messages 也必须已投影');
      assert.equal(asst?.thoughtSteps?.[0].order, 0, '顺序取后端 order');
    }
  );
});

test('分页响应缺 turnViews 字段时归一为 {}，且不再凭空造出气泡', async () => {
  await withStubbedPage(
    { records: historyRecords(), turns: {}, nextCursor: null, hasMore: false },
    res => {
      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.deepEqual(res.data.turnViews, {}, '缺失必须归一为空对象（无视图 ≠ 报错）');
      assert.deepEqual(res.data.messages, [], '无视图即无气泡：唯一链路是视图 → reducer');
    }
  );
});
