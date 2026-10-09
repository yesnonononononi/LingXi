import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ToolCallVO } from '../src/types/chat';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { toPromptCardData, resolveCardKind, isApprovableCard, isCardToolName, canDecideCard, buildCardSummary, upsertPromptCard } from '../src/utils/toolCallCard';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { AgentToolName } from '../src/utils/toolNames';

/** 等待 reducer 内部 fire-and-forget 的建卡 promise 落定。 */
const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('1. 轮次视图 + 权威卡片 VO：PLAN / CHOICE / COMMAND 三类 PROMISE 卡片分别还原（含已决状态）', () => {
  const sessionId = 'sess-card';
  const turnId = 'turn-card';

  // 展示结构来自轮次视图（块只给身份与状态）；卡片载荷来自权威 ToolCallVO（审批操作同源）。
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, {
    sessionId,
    turnId,
    status: 'COMPLETED',
    viewVersion: '1',
    userMessage: '执行任务',
    blocks: [
      { blockId: 'tool:call-plan', type: 'TOOL', order: 0, status: 'PROMISED', toolCallId: 'call-plan', toolName: 'create_plan' },
      { blockId: 'tool:call-choice', type: 'TOOL', order: 10, status: 'PROMISED', toolCallId: 'call-choice', toolName: 'require_choice' },
      { blockId: 'tool:call-cmd', type: 'TOOL', order: 20, status: 'COMPLETED', toolCallId: 'call-cmd', toolName: 'execute_command' },
      { blockId: 'text:end', type: 'TEXT', order: 30, status: 'COMPLETE', placement: 'BODY', text: '已完成' },
    ],
  }, new Map());

  const asst = messages.find(m => m.role === 'assistant');
  assert.ok(asst, '应投影出助手回答组');

  // 权威卡片 VO（与实时路径 onResolveCard 拉到的同形状）写入唯一落点
  const planCard = { id: 'call-plan', toolName: 'create_plan', type: 'PROMISE', status: 'pending', pending: true, title: '方案', content: { kind: 'PLAN', title: '方案', text: '# 计划正文' }, allowedActions: ['APPROVE', 'REJECT'] } as unknown as ToolCallVO;
  const choiceCard = { id: 'call-choice', toolName: 'require_choice', type: 'PROMISE', status: 'pending', pending: true, content: { kind: 'CHOICE', question: '选哪个方案？', options: ['方案A', '方案B'] }, allowedActions: ['ANSWER'] } as unknown as ToolCallVO;
  const cmdCard = { id: 'call-cmd', toolName: 'execute_command', type: 'PROMISE', status: 'completed', pending: false, content: { kind: 'COMMAND', command: 'ls -la', workDir: '/workspace', shell: 'bash', intention: '列出目录' }, rawOutput: { outcome: 'APPROVED', stdout: 'a.txt\nb.txt' }, allowedActions: [] } as unknown as ToolCallVO;
  for (const card of [planCard, choiceCard, cmdCard]) upsertPromptCard(asst, card);

  assert.ok(asst.promptCards, 'PROMISE 卡片应保留在 promptCards');
  assert.strictEqual(asst.promptCards?.length, 3, '三类卡片各一张');

  const plan = toPromptCardData(asst.promptCards!.find(c => c.id === 'call-plan')!);
  assert.strictEqual(plan.kind, 'PLAN');
  assert.strictEqual(plan.pending, true, 'pending 卡片可审批');
  assert.strictEqual(plan.content, '# 计划正文');
  assert.strictEqual(plan.title, '方案');
  assert.deepStrictEqual(plan.allowedActions, ['APPROVE', 'REJECT']);

  const choice = toPromptCardData(asst.promptCards!.find(c => c.id === 'call-choice')!);
  assert.strictEqual(choice.kind, 'CHOICE');
  assert.deepStrictEqual(choice.options, ['方案A', '方案B']);
  assert.deepStrictEqual(choice.allowedActions, ['ANSWER']);

  const cmd = toPromptCardData(asst.promptCards!.find(c => c.id === 'call-cmd')!);
  assert.strictEqual(cmd.kind, 'COMMAND');
  assert.strictEqual(cmd.pending, false, '已决卡片不可再审批');
  assert.strictEqual(cmd.command, 'ls -la');
  assert.strictEqual(cmd.workDir, '/workspace');
  assert.strictEqual(cmd.intention, '列出目录');
  assert.strictEqual(cmd.outcome, 'APPROVED');
  assert.strictEqual(cmd.stdout, 'a.txt\nb.txt');
});

test('2. kind 缺失 / 非法 → 状态不可用，绝不回落成 COMMAND', () => {
  assert.strictEqual(resolveCardKind({ command: 'rm -rf /' }), 'UNAVAILABLE', '缺 kind');
  assert.strictEqual(resolveCardKind({ kind: 'UNKNOWN_KIND' }), 'UNAVAILABLE', '乱值');
  assert.strictEqual(resolveCardKind({ kind: 'EXECUTE' }), 'UNAVAILABLE', 'EXECUTE 不是卡片形态');
  assert.strictEqual(resolveCardKind(null), 'UNAVAILABLE', 'content 缺失');
  assert.strictEqual(resolveCardKind({ kind: 'plan' }), 'PLAN', '大小写不敏感');

  const card = toPromptCardData({
    id: 'x',
    type: 'PROMISE',
    status: 'pending',
    pending: true,
    content: { command: 'rm -rf /' }
  } as ToolCallVO);
  assert.strictEqual(card.kind, 'UNAVAILABLE');
  assert.strictEqual(card.unavailable, true, '降级标记置位，供视图渲染「状态不可用」');
});

test('3. 唯一可审批判定 + allowedActions 驱动按钮集合', () => {
  assert.equal(isApprovableCard({ type: 'PROMISE', status: 'pending' } as ToolCallVO), true);
  assert.equal(isApprovableCard({ type: 'PROMISE', status: 'completed' } as ToolCallVO), false);
  assert.equal(isApprovableCard({ type: 'EXECUTE', status: 'pending' } as ToolCallVO), false);
  assert.equal(isApprovableCard({ type: 'PROMISE', status: 'in_progress' } as ToolCallVO), false);

  assert.equal(isCardToolName(AgentToolName.CreatePlan), true);
  assert.equal(isCardToolName(AgentToolName.RequireChoice), true);
  assert.equal(isCardToolName(AgentToolName.ExecuteCommand), true);
  // A4：子代理委派工具也承载 DELEGATION 卡片，实时路径据此建卡
  assert.equal(isCardToolName(AgentToolName.CallSubAgent), true);
  assert.equal(isCardToolName(AgentToolName.ReadFile), false);

  // 按钮集合来自后端 allowedActions：CHOICE 只有 ANSWER，PLAN/COMMAND 是 APPROVE|REJECT
  const choice = toPromptCardData({
    id: 'c', type: 'PROMISE', status: 'pending', pending: true,
    content: { kind: 'CHOICE', question: 'q', options: [] },
    allowedActions: ['ANSWER']
  } as ToolCallVO);
  assert.deepStrictEqual(choice.allowedActions, ['ANSWER']);
});

test('4. 实时建卡：PROMISE 工具调用 + 挂起 → 拉权威 ToolCallVO 建卡', async () => {
  const messages: ChatMessage[] = [];
  const requested: string[] = [];
  const reducer = new TurnStreamReducer(messages, {
    sessionId: 'sess-rt-card',
    onResolveCard: async (toolCallId) => {
      requested.push(toolCallId);
      return {
        id: toolCallId,
        type: 'PROMISE',
        status: 'pending',
        pending: true,
        title: '任务计划',
        content: { kind: 'PLAN', title: '任务计划', text: '# 正文' },
        allowedActions: ['APPROVE', 'REJECT']
      } as ToolCallVO;
    }
  });

  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 't1' }
  });
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.CreatePlan,
    requestId: 'call-plan-1',
    args: '{"title":"任务计划","text":"# 正文"}',
    resultStatus: 'STARTED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 't1' }
  });
  reducer.consume({
    type: 'EXECUTION_SUSPENDED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 't1' }
  });
  await flushAsync();

  const bubble = messages[0];
  assert.equal(bubble.isSuspended, true);
  assert.ok(bubble.promptCards && bubble.promptCards.length === 1, '应建出且只建出一张卡片（幂等）');
  assert.ok(requested.includes('call-plan-1'), '应以 toolCallId 拉取权威 VO');
  const card = toPromptCardData(bubble.promptCards![0]);
  assert.equal(card.kind, 'PLAN');
  assert.equal(card.pending, true);
  assert.equal(card.toolCallId, 'call-plan-1');
});

test('5. 实时建卡：查不到 / 查失败都不建卡、不伪造状态', async () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, {
    sessionId: 'sess-rt-miss',
    onResolveCard: async () => {
      throw new Error('network down');
    }
  });
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 't1' }
  });
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.CreatePlan,
    requestId: 'call-x',
    args: '{}',
    resultStatus: 'STARTED',
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 't1' }
  });
  await flushAsync();

  const bubble = messages[0];
  assert.ok(!bubble.promptCards || bubble.promptCards.length === 0, '拉取失败不得伪造卡片');
});

test('6. 思考分段与交错顺序由后端块视图给出（前端不再自行分段）', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'sess-think' });

  const evt = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    executionId: 'e1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 't1' },
    ...extra
  });

  reducer.consume(evt('EXECUTION_STARTED') as any);
  reducer.consume(evt('PARTIAL_THINKING', { responseId: '1', offset: 0, order: 0, content: '思考一' }) as any);
  reducer.consume(evt('TOOL_CALL', { order: 10, toolName: AgentToolName.ReadFile, requestId: 'c1', args: '{"path":"a"}', resultStatus: 'STARTED' }) as any);
  reducer.consume(evt('PARTIAL_THINKING', { responseId: '2', offset: 0, order: 20, content: '思考二' }) as any);
  reducer.consume(evt('TOOL_CALL', { order: 30, toolName: AgentToolName.ReadFile, requestId: 'c2', args: '{"path":"b"}', resultStatus: 'STARTED' }) as any);
  reducer.consume(evt('PARTIAL_THINKING', { responseId: '3', offset: 0, order: 40, content: '思考三' }) as any);
  reducer.flush();

  const bubble = messages[0];
  assert.equal(bubble.thoughtSteps?.length, 3, '思考即时分段打印');
  assert.equal(bubble.toolCalls?.length, 2, '工具开始即时展示');
  assert.deepEqual(bubble.processTimeline?.map(item => item.order), [0, 10, 20, 30, 40]);

  // 后端块视图给出三段思考与两个工具，严格交错
  reducer.consume(evt('TURN_SNAPSHOT', {
    turnId: 't1',
    viewVersion: '1',
    view: {
      sessionId: 'sess-think', turnId: 't1', status: 'COMPLETED', viewVersion: '1',
      blocks: [
        { blockId: 'thinking:1', type: 'THINKING', order: 0, status: 'COMPLETE', text: '思考一' },
        { blockId: 'tool:c1', type: 'TOOL', order: 10, status: 'COMPLETED', toolCallId: 'c1', toolName: AgentToolName.ReadFile },
        { blockId: 'thinking:2', type: 'THINKING', order: 20, status: 'COMPLETE', text: '思考二' },
        { blockId: 'tool:c2', type: 'TOOL', order: 30, status: 'COMPLETED', toolCallId: 'c2', toolName: AgentToolName.ReadFile },
        { blockId: 'thinking:3', type: 'THINKING', order: 40, status: 'COMPLETE', text: '思考三' }
      ]
    }
  }) as any);

  assert.equal(bubble.thoughtSteps?.length, 3, '三段思考来自后端块');
  assert.deepStrictEqual(bubble.thoughtSteps?.map(s => s.content), ['思考一', '思考二', '思考三']);
  assert.equal(bubble.toolCalls?.length, 2);

  // 交错顺序完全由后端 order 决定
  const orders = {
    t0: bubble.thoughtSteps![0].order ?? -1,
    tool0: bubble.toolCalls![0].order ?? -1,
    t1: bubble.thoughtSteps![1].order ?? -1,
    tool1: bubble.toolCalls![1].order ?? -1,
    t2: bubble.thoughtSteps![2].order ?? -1
  };
  assert.ok(orders.t0 < orders.tool0, '段1 思考在工具1 之前');
  assert.ok(orders.tool0 < orders.t1, '工具1 在段2 思考之前');
  assert.ok(orders.t1 < orders.tool1, '段2 思考在工具2 之前');
  assert.ok(orders.tool1 < orders.t2, '工具2 在段3 思考之前');
});

test('7. 决策回执驱动卡片状态收敛：pending → 已决（outcome/status 由权威 VO 表达）', () => {
  const pending: ToolCallVO = {
    id: 'c1',
    type: 'PROMISE',
    status: 'pending',
    pending: true,
    content: { kind: 'COMMAND', command: 'ls' },
    allowedActions: ['APPROVE', 'REJECT']
  };
  assert.equal(toPromptCardData(pending).pending, true);

  // 决策后回执携带的权威 VO（服务端状态）
  const decided: ToolCallVO = {
    ...pending,
    status: 'completed',
    pending: false,
    allowedActions: [],
    rawOutput: { outcome: 'APPROVED', stdout: 'ok' }
  };
  const card = toPromptCardData(decided);
  assert.equal(card.pending, false, '已决卡片不再开放审批');
  assert.equal(card.status, 'completed');
  assert.equal(card.outcome, 'APPROVED');
  assert.equal(card.stdout, 'ok');

  // 拒绝也是同一收敛路径：结论由 outcome 表达，未知状态禁止默认成功
  const rejected = toPromptCardData({ ...pending, status: 'completed', pending: false, allowedActions: [], rawOutput: { outcome: 'REJECTED' } });
  assert.equal(rejected.pending, false);
  assert.equal(rejected.outcome, 'REJECTED');

  const unknown = toPromptCardData({ ...pending, status: 'completed', pending: false, allowedActions: [], rawOutput: {} });
  assert.equal(unknown.outcome, undefined, '结论缺失 = 状态未知，不得默认成功');
});

/**
 * A3：按钮门控必须与权威 `pending` 取与，而不能只判 allowedActions。
 * 回归：`type=PROMISE, status=completed, pending=false, allowedActions=['APPROVE','REJECT']`
 * 这种「已决但残留动作」的脏数据，曾让已决卡渲染出可点按钮。
 */
test('8. 按钮门控叠加权威 pending：已决卡即使残留 allowedActions 也不开放操作', () => {
  // 待决策：pending 且动作集合含目标动作 → 可用
  const pendingCard = toPromptCardData({
    id: 'c1', type: 'PROMISE', status: 'pending', pending: true,
    content: { kind: 'COMMAND', command: 'ls' },
    allowedActions: ['APPROVE', 'REJECT']
  } as ToolCallVO);
  assert.equal(canDecideCard(pendingCard, 'APPROVE'), true);
  assert.equal(canDecideCard(pendingCard, 'REJECT'), true);
  assert.equal(canDecideCard(pendingCard, 'ANSWER'), false, '动作不在集合内不可用');

  // 已决但残留动作：pending=false → 一律不可用（纵深防御）
  const staleCard = toPromptCardData({
    id: 'c2', type: 'PROMISE', status: 'completed', pending: false,
    content: { kind: 'COMMAND', command: 'ls' },
    rawOutput: { outcome: 'APPROVED' },
    allowedActions: ['APPROVE', 'REJECT']
  } as ToolCallVO);
  assert.equal(staleCard.pending, false);
  assert.equal(canDecideCard(staleCard, 'APPROVE'), false, '已决卡残留动作不得渲染可点按钮');
  assert.equal(canDecideCard(staleCard, 'REJECT'), false);

  // CHOICE：只有 ANSWER 动作，且仍需 pending
  const choiceCard = toPromptCardData({
    id: 'c3', type: 'PROMISE', status: 'pending', pending: true,
    content: { kind: 'CHOICE', question: 'q', options: [] },
    allowedActions: ['ANSWER']
  } as ToolCallVO);
  assert.equal(canDecideCard(choiceCard, 'ANSWER'), true);
  assert.equal(canDecideCard(choiceCard, 'APPROVE'), false);
});

/**
 * A5：无结论 ≠ 已结束。
 *
 * <p>后端 PREPARING 时 {@code pending=true}（isUnresolved），而前端就绪位（`PromptCardData.pending`
 * = {@link isApprovableCard}）为 false → 卡片走「折叠摘要」分支。摘要必须按生命周期状态显示，
 * 不能用「没有 outcome」推断成「已结束」，否则外层「已结束」与展开后卡内「准备中」自相矛盾。</p>
 */
test('9. 折叠摘要按生命周期状态显示，缺 outcome 不得标成「已结束」', () => {
  // 后端真实形态：PREPARING 且 pending=true（未终结）
  const preparing = toPromptCardData({
    id: 'c1', type: 'PROMISE', status: 'preparing', pending: true,
    content: { kind: 'COMMAND', command: 'ls' }
  } as ToolCallVO);
  assert.equal(preparing.pending, false, 'PREPARING 不可审批（就绪位 false）→ 走折叠摘要分支');
  assert.equal(preparing.status, 'preparing');
  const preparingSummary = buildCardSummary(preparing);
  assert.ok(preparingSummary.includes('准备中'), `PREPARING 摘要应为「准备中」，实际=${preparingSummary}`);
  assert.ok(!preparingSummary.includes('已结束'), '缺 outcome 不得推断成「已结束」');

  // 已放行执行中：同样是「未终结」但摘要应显示「执行中」
  const running = toPromptCardData({
    id: 'c2', type: 'PROMISE', status: 'in_progress', pending: true,
    content: { kind: 'COMMAND', command: 'ls' }
  } as ToolCallVO);
  assert.ok(buildCardSummary(running).includes('执行中'), '执行中按状态显示「执行中」');

  // 真正结束且无结论，才显示「已结束」
  const finished = toPromptCardData({
    id: 'c3', type: 'PROMISE', status: 'completed', pending: false,
    content: { kind: 'COMMAND', command: 'ls' }, rawOutput: {}
  } as ToolCallVO);
  assert.ok(buildCardSummary(finished).includes('已结束'), 'completed 无结论显示「已结束」');

  // 已决且带结论时结论优先，不被状态文案盖住
  const approved = toPromptCardData({
    id: 'c4', type: 'PROMISE', status: 'completed', pending: false,
    content: { kind: 'COMMAND', command: 'ls' }, rawOutput: { outcome: 'APPROVED' }
  } as ToolCallVO);
  assert.ok(buildCardSummary(approved).includes('已批准'), '有结论时摘要显示结论');
});
