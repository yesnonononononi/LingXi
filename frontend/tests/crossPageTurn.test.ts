import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/types/chat';
import type { Block, TurnViewVO } from '../src/types/block';
import { aggregateRecordsByIdentity, groupMessagesByTurn } from '../src/utils/session';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';

/**
 * 跨页 / 幂等 / 排序契约（唯一链路：后端轮次视图 → {@link upsertTurnViewIntoMessages}）。
 *
 * <p>旧实现建立在「原始消息行 → 前端聚合」之上，那条链路已随本次改造删除。
 * 本文件把同一批能力面（跨页合并、重复加载幂等、相邻轮次不误合并、PROMISE 卡片、
 * 恢复流复用、子会话同规则、气泡排序稳定）重新钉在轮次视图契约上。</p>
 */

/** 造一轮视图：思考 / 文本 / 工具都通过 block 表达，order 由调用方决定。 */
function turnView(
  sessionId: string,
  turnId: string,
  opts: { version?: number; user?: string; blocks?: Block[]; status?: string } = {},
): TurnViewVO {
  return {
    sessionId,
    turnId,
    status: opts.status ?? 'COMPLETED',
    viewVersion: String(opts.version ?? 1),
    userMessage: opts.user,
    blocks: opts.blocks ?? [],
  };
}

let orderSeq = 0;
const nextOrder = () => orderSeq++;

function thinking(text: string, order = nextOrder()): Block {
  return { blockId: `thinking:${order}`, type: 'THINKING', order, status: 'COMPLETE', text };
}

function bodyText(text: string, order = nextOrder()): Block {
  return { blockId: `text:${order}`, type: 'TEXT', order, status: 'COMPLETE', isBody: true, text };
}

function processText(text: string, order = nextOrder()): Block {
  return { blockId: `text-p:${order}`, type: 'TEXT', order, status: 'COMPLETE', isBody: false, text };
}

function toolBlock(callId: string, toolName: string, order = nextOrder(), output = 'ok'): Block {
  return {
    blockId: `tool:${callId}`, type: 'TOOL', order, status: 'COMPLETED',
    toolCallId: callId, toolName, output: JSON.stringify({ outcome: 'SUCCEEDED', output }),
  };
}

/** 单一入口：把若干视图并入一个新消息数组。 */
function project(views: TurnViewVO[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();
  for (const view of views) upsertTurnViewIntoMessages(messages, view, versions);
  return messages;
}

test('1. 本次真实会话跨页: 同一轮跨两页合并后只有一个回答组，工具完整', () => {
  const sessionId = '2105536374932451328';
  const turnId = '2105537327467278336';

  // 较早页：14 个工具 + 一段中途叙述
  const olderBlocks: Block[] = [processText('开发完成。我用浏览器实测……')];
  for (let i = 1; i <= 14; i++) olderBlocks.push(toolBlock(`call-tool-${i}`, 'search_code'));

  // 较新页：后续 26 个工具 + 定稿正文
  const newerBlocks: Block[] = [];
  for (let i = 15; i <= 40; i++) newerBlocks.push(toolBlock(`call-tool-${i}`, 'run_command'));
  newerBlocks.push(bodyText('已修复并实测通过 ✅'));

  // 两页下发的是同一轮：较高的版本整轮接管（后端装配器读该轮全部消息）
  const messages = project([
    turnView(sessionId, turnId, { version: 3, user: '请帮我排查并修复会话展示问题', blocks: olderBlocks }),
    turnView(sessionId, turnId, { version: 5, user: '请帮我排查并修复会话展示问题', blocks: [...olderBlocks, ...newerBlocks] }),
  ]);

  assert.strictEqual(messages.length, 2, '应当只有 1 条用户消息和 1 条聚合后的回答消息');
  const userMsg = messages[0];
  const asstMsg = messages[1];

  assert.strictEqual(userMsg.role, 'user');
  assert.strictEqual(asstMsg.role, 'assistant');
  assert.strictEqual(asstMsg.turnId, turnId);
  assert.strictEqual(asstMsg.id, `bubble-${sessionId}-${turnId}`);

  assert.strictEqual(asstMsg.toolCalls?.length, 40, '应当完整包含 40 个工具调用');
  assert.strictEqual(asstMsg.content, '已修复并实测通过 ✅', 'BODY 段文本落正文');
  assert.strictEqual(asstMsg.aiMessages?.length, 1, 'PROCESS 段文本进折叠过程区');
  assert.strictEqual(asstMsg.aiMessages?.[0]?.text, '开发完成。我用浏览器实测……');

  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 1, '同一轮次跨页合并后应仅生成 1 个回答组');
  assert.strictEqual(groups[0].turnId, turnId);
});

test('2. 重复投递同一视图: 幂等，消息 / 工具 / 文本不重复计数', () => {
  const sessionId = 'sess-100';
  const turnId = 'turn-200';

  const view = turnView(sessionId, turnId, {
    version: 2,
    user: '你好',
    blocks: [bodyText('你好！'), toolBlock('call-1', 'calc', undefined, '42')],
  });

  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();
  upsertTurnViewIntoMessages(messages, view, versions);
  const snapshot = JSON.stringify(messages);
  upsertTurnViewIntoMessages(messages, view, versions);
  upsertTurnViewIntoMessages(messages, view, versions);

  assert.strictEqual(messages.length, 2, '重复投递不增加消息条数');
  assert.strictEqual(messages[1].toolCalls?.length, 1, '重复投递不增加工具条数');
  assert.strictEqual(messages[1].content, '你好！');
  assert.strictEqual(JSON.stringify(messages), snapshot, '重复投影输出严格一致（幂等）');
});

test('3. 不同轮次相邻: 分别展示，不误合并，且按雪花键升序', () => {
  const sessionId = 'sess-multi';
  const turn1 = '2106057094397558784';
  const turn2 = '2106057227516379136';

  const messages = project([
    turnView(sessionId, turn1, { user: '问题 1', blocks: [bodyText('回答 1')] }),
    turnView(sessionId, turn2, { user: '问题 2', blocks: [bodyText('回答 2')] }),
  ]);

  assert.strictEqual(messages.length, 4, '两个轮次应有 4 条消息');
  assert.strictEqual(messages[0].turnId, turn1);
  assert.strictEqual(messages[1].id, `bubble-${sessionId}-${turn1}`);
  assert.strictEqual(messages[1].content, '回答 1');
  assert.strictEqual(messages[2].turnId, turn2);
  assert.strictEqual(messages[3].id, `bubble-${sessionId}-${turn2}`);
  assert.strictEqual(messages[3].content, '回答 2');

  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 2, '应分为两个独立的回答组');
  assert.strictEqual(groups[0].turnId, turn1);
  assert.strictEqual(groups[1].turnId, turn2);
});

test('4. 视图缺 userMessage: 只投影助手气泡，不造空用户气泡', () => {
  const sessionId = 'sess-legacy';
  const turnId = '2106057094397558784';

  const messages = project([turnView(sessionId, turnId, { blocks: [bodyText('旧回答 1')] })]);

  assert.strictEqual(messages.length, 1, '缺 userMessage 时不应造用户气泡');
  assert.strictEqual(messages[0].role, 'assistant');
  assert.strictEqual(messages[0].content, '旧回答 1');

  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 1);
});

test('6. PROMISE 工具跨页: 审批卡片按 blockId 就地更新，不新增气泡', () => {
  const sessionId = 'sess-card';
  const turnId = '2106057094397558784';
  const callId = 'call-promise-1';

  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();

  // 第一阶段：待决策（同一轮，版本 1）
  upsertTurnViewIntoMessages(messages, turnView(sessionId, turnId, {
    version: 1,
    blocks: [{
      blockId: `tool:${callId}`, type: 'TOOL', order: 0, status: 'PROMISED',
      toolCallId: callId, toolName: 'execute_command',
    }],
  }), versions);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].toolCalls?.length, 1);

  // 第二阶段：审批通过并收尾（同一轮，版本 2）；该轮多了一段正文
  upsertTurnViewIntoMessages(messages, turnView(sessionId, turnId, {
    version: 2,
    blocks: [
      {
        blockId: `tool:${callId}`, type: 'TOOL', order: 0, status: 'COMPLETED',
        toolCallId: callId, toolName: 'execute_command',
        output: JSON.stringify({ outcome: 'SUCCEEDED', output: 'File1.txt' }),
      },
      bodyText('命令已执行', 1),
    ],
  }), versions);

  assert.strictEqual(messages.length, 1, '同一轮不得裂出第二条气泡');
  assert.strictEqual(messages[0].content, '命令已执行');
  assert.strictEqual(messages[0].toolCalls?.length, 1, 'PROMISE 工具仍作为普通工具调用聚合');
  assert.strictEqual(messages[0].toolCalls?.[0]?.id, callId);
  assert.strictEqual(messages[0].toolCalls?.[0]?.status, 'success', '审批通过后工具调用状态应为 success');
});

test('7. 相同轮次恢复（审批恢复/暂停恢复/重新订阅）: 复用原有回答气泡', () => {
  const sessionId = 'sess-resume';
  const turnId = '2106057094397558784';
  const callId = 'call-cmd';

  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();

  // 第一阶段：触发审批并暂停
  upsertTurnViewIntoMessages(messages, turnView(sessionId, turnId, {
    version: 1,
    status: 'WAITING',
    user: '执行危险命令',
    blocks: [{
      blockId: `tool:${callId}`, type: 'TOOL', order: 0, status: 'PROMISED',
      toolCallId: callId, toolName: 'execute_command',
    }],
  }), versions);

  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[1].id, `bubble-${sessionId}-${turnId}`);
  assert.strictEqual(messages[1].toolCalls?.[0]?.id, callId);
  // 待决策的 PROMISE 卡片（status=STARTED/PROMISED 且无终态 outcome）标为 pending（等待人工决策）。
  assert.strictEqual(messages[1].toolCalls?.[0]?.status, 'pending', '待决策的 PROMISE 工具调用应标记为 pending');

  // 第二阶段：审批通过后恢复流并完成（同一轮，版本 2）
  upsertTurnViewIntoMessages(messages, turnView(sessionId, turnId, {
    version: 2,
    user: '执行危险命令',
    blocks: [
      {
        blockId: `tool:${callId}`, type: 'TOOL', order: 0, status: 'COMPLETED',
        toolCallId: callId, toolName: 'execute_command',
        output: JSON.stringify({ outcome: 'APPROVED', stdout: 'done' }),
      },
      bodyText('已处理完毕', 1),
    ],
  }), versions);

  assert.strictEqual(messages.length, 2, '恢复后应沿用同一个回答组，不生成新气泡');
  assert.strictEqual(messages[1].id, `bubble-${sessionId}-${turnId}`);
  assert.strictEqual(messages[1].content, '已处理完毕');
  assert.strictEqual(messages[1].toolCalls?.[0]?.status, 'success', '审批通过后同一条工具调用被就地更新为 success');
});

test('8. 子会话历史跨页: 与主会话采用同一投影规则', () => {
  const subSessionId = '2106057094397558785';
  const subTurnId = '2106057227516379137';

  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();

  upsertTurnViewIntoMessages(messages, turnView(subSessionId, subTurnId, {
    version: 3,
    user: '子任务指令',
    blocks: [
      processText('准备处理数据...', 0),
      toolBlock('sub-call-1', 'read_file', 1, 'a,b,c'),
    ],
  }), versions);
  // 同一轮更全的一页
  upsertTurnViewIntoMessages(messages, turnView(subSessionId, subTurnId, {
    version: 4,
    user: '子任务指令',
    blocks: [
      processText('准备处理数据...', 0),
      toolBlock('sub-call-1', 'read_file', 1, 'a,b,c'),
      bodyText('子任务完成', 2),
    ],
  }), versions);

  assert.strictEqual(messages.length, 2);
  const subAsst = messages[1];
  assert.strictEqual(subAsst.id, `bubble-${subSessionId}-${subTurnId}`);
  assert.strictEqual(subAsst.content, '子任务完成');
  assert.strictEqual(subAsst.aiMessages?.length, 1);
  assert.strictEqual(subAsst.aiMessages?.[0]?.text, '准备处理数据...');
  assert.strictEqual(subAsst.toolCalls?.length, 1);
  assert.strictEqual(subAsst.toolCalls?.[0]?.status, 'success');
});

/**
 * 过程时间线的时序契约：思维链 / 中间文本 / 工具调用三条集合的 order 必须同基准。
 * 新口径下 order **完全来自后端 block.order**，前端不参与任何排序推断 ——
 * 这里验证「后端的 order 原样还原成交错时序」。
 */
test('9. 过程时间线时序: 思考 / 中间文本 / 工具按后端 order 逐段交错', () => {
  const sessionId = 'sess-timeline';
  const turnId = '2106057094397558784';

  // 后端给出的 order 故意交错：思考(0) 文本(10) 工具(20) 思考(30) 工具(40) 思考(50)
  const messages = project([turnView(sessionId, turnId, {
    user: '按团队流程实现',
    blocks: [
      thinking('先读代码摸清现状', 0),
      processText('现有工程是移动竖屏 H5，与截图冲突，先确认方向。', 10),
      toolBlock('call-1', 'execute_command', 20, 'ok'),
      thinking('方向已确认，直接委派', 30),
      toolBlock('call-2', 'read_file', 40, 'code'),
      thinking('汇总交付结论', 50),
      bodyText('已完成交付。', 60),
    ],
  })]);

  const asst = messages[1];
  assert.strictEqual(asst.content, '已完成交付。', 'BODY 文本落正文');
  assert.strictEqual(asst.aiMessages?.length, 1, '仅 PROCESS 文本进过程区');
  assert.strictEqual(asst.thoughtSteps?.length, 3, '多段思考各成一step');
  assert.deepStrictEqual(
    asst.thoughtSteps?.map(s => s.content),
    ['先读代码摸清现状', '方向已确认，直接委派', '汇总交付结论'],
    '每段思考独立成步，内容不再拼接',
  );
  assert.strictEqual(asst.toolCalls?.length, 2);

  // 还原 ChatMessageItem#processTimeline 的排序（order 升序），检查三类条目的交替顺序
  type Entry = { order: number; kind: string };
  const entries: Entry[] = [];
  (asst.thoughtSteps || []).forEach(s => entries.push({ order: s.order ?? 0, kind: 'thought' }));
  (asst.aiMessages || []).forEach(m => entries.push({ order: m.order ?? 0, kind: 'text' }));
  (asst.toolCalls || []).forEach(t => entries.push({ order: t.order ?? 0, kind: 'tool' }));
  entries.sort((a, b) => a.order - b.order);

  assert.deepStrictEqual(
    entries.map(e => e.kind),
    ['thought', 'text', 'tool', 'thought', 'tool', 'thought'],
    '思考与工具 / 中间文本按真实执行顺序逐段交错',
  );
});

/**
 * 槽位契约：并行工具在同 order 段内的相对次序由后端给定，前端不得重排。
 * 这里验证「单行 10 个并行工具」全部保留、且都早于后一段思考。
 */
test('10. 过程时间线槽位: 单行 10 个并行工具全部保留且早于后续思考', () => {
  const sessionId = 'sess-slot';
  const turnId = '2106057094397558784';

  const blocks: Block[] = [processText('并行读取多个文件。', 0)];
  for (let k = 0; k < 10; k++) blocks.push(toolBlock(`call-p${k}`, 'read_file', 10 + k, `f${k}.ts`));
  blocks.push(thinking('汇总读取结果', 100));
  blocks.push(bodyText('读取完毕。', 110));

  const messages = project([turnView(sessionId, turnId, { user: '并行读取', blocks })]);
  const asst = messages[1];
  const tools = asst.toolCalls || [];
  assert.strictEqual(tools.length, 10, '10 个并行工具全部保留');

  const lastToolOrder = Math.max(...tools.map(t => t.order));
  const nextStepOrder = Math.min(...(asst.thoughtSteps || []).map(s => s.order));
  assert.ok(
    lastToolOrder < nextStepOrder,
    `第 10 个工具 (order=${lastToolOrder}) 必须仍早于后续思考 (order=${nextStepOrder})`,
  );
});

/**
 * 气泡顺序的稳定性：顺序由轮次雪花 id 决定，与「视图并入的先后」无关。
 * 翻旧页把较晚轮次先并入时，较早轮次必须插到它前面（而不是一律追加到末尾）。
 */
test('11. 视图乱序并入: 气泡顺序仍按轮次雪花键升序，不随并入先后漂移', () => {
  const sessionId = 'sess-order';
  const earlierTurn = '2106057094397558784';
  const laterTurn = '2106057227516379136';

  // 故意倒序并入：较晚的轮次先来
  const messages = project([
    turnView(sessionId, laterTurn, { user: '继续收尾', blocks: [bodyText('交付闭环完成。')] }),
    turnView(sessionId, earlierTurn, { user: '走团队流程', blocks: [bodyText('团队协作流程已完整走完。')] }),
  ]);

  assert.strictEqual(messages.length, 4);
  assert.strictEqual(messages[0].turnId, earlierTurn, '较早的轮次必须排在前面');
  assert.strictEqual(messages[2].turnId, laterTurn, '较晚的轮次必须排在后面');
  assert.strictEqual(messages[1].content, '团队协作流程已完整走完。');
  assert.strictEqual(messages[3].content, '交付闭环完成。');

  const groups = groupMessagesByTurn(messages);
  assert.deepStrictEqual(groups.map(g => g.turnId), [earlierTurn, laterTurn]);
});

/**
 * 共享版本表：一次「多页累计投影」里，同一轮的低版本不得覆盖高版本。
 *
 * <p>{@link aggregateRecordsByIdentity} 是纯函数 —— 每次调用从零重建完整投影。
 * 翻页入口的正确用法是「先把多页 turnViews 累计成一张表再调用一次」，因此同一 turnId
 * 在一张累计表里只会留下装配器写入的那一份；若调用方额外保留了旧版本（如手工合并的
 * 两页 map），共享版本表负责把旧版本挡掉，不让它回退已投影的新内容。</p>
 *
 * <p>两条断言：① 同一调用内高版本先入、低版本后入被拒；② 版本表在调用外可复用，
 * 低版本视图被整体跳过（返回空投影而非回退内容）。</p>
 */
test('12. 共享版本表: 同一轮的低版本不得回退高版本内容', () => {
  const sessionId = 'sess-version';
  const turnId = '2106057094397558784';

  // ① 同一调用内：高版本先并入，随后并入同一轮的低版本 —— 必须被拒
  const messages: ChatMessage[] = [];
  const versions = new Map<string, number>();
  upsertTurnViewIntoMessages(
    messages,
    turnView(sessionId, turnId, { version: 5, user: '提问', blocks: [bodyText('定稿正文')] }),
    versions,
  );
  upsertTurnViewIntoMessages(
    messages,
    turnView(sessionId, turnId, { version: 3, user: '提问', blocks: [bodyText('中途稿正文')] }),
    versions,
  );
  assert.strictEqual(messages[1]?.content, '定稿正文', '低版本视图不得覆盖高版本内容');
  assert.strictEqual(versions.get(turnId), 5, '版本表保留已接受的高水位');

  // ② 跨调用复用同一版本表：低版本视图被整体跳过，返回空投影（而非回退内容）
  const stale = aggregateRecordsByIdentity(
    sessionId,
    { [turnId]: turnView(sessionId, turnId, { version: 3, user: '提问', blocks: [bodyText('中途稿正文')] }) },
    versions,
  );
  assert.strictEqual(stale.length, 0, '版本表已记录更高水位时，低版本视图被跳过');

  // ③ 纯函数性：不带版本表调用时，单次投影按视图自身内容完整重建
  const fresh = aggregateRecordsByIdentity(sessionId, {
    [turnId]: turnView(sessionId, turnId, { version: 9, user: '提问', blocks: [bodyText('最终正文')] }),
  });
  assert.strictEqual(fresh[1]?.content, '最终正文');
});
