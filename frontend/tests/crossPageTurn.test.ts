import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMessageVO, ChatMessage, ChatTurn } from '../src/types/chat';
import {
  mergeRawRecords,
  aggregateSessionMessages,
  groupMessagesByTurn
} from '../src/utils/session';

test('1. 本次真实会话跨两页: 一个回答组，合并 40 个工具调用，最终正文为"已修复并实测通过 ✅"', () => {
  const sessionId: string = '2105536374932451328';
  const turnId: string = '2105537327467278336';

  // 模拟较早页（Page 2，游标更早拉取到的消息：包含 14 个工具调用及较早 AI 文本）
  const olderPageRecords: SessionMessageVO[] = [];
  olderPageRecords.push({
    id: 'msg-user-1',
    turnId,
    type: 'USER',
    text: '请帮我排查并修复会话展示问题',
    createTime: '2026-10-01T06:00:00Z'
  });

  for (let i = 1; i <= 14; i++) {
    const callId: string = `call-tool-${i}`;
    olderPageRecords.push({
      id: `ai-tool-req-${i}`,
      turnId,
      type: 'AI',
      toolCalls: [{ id: callId, name: 'search_code', arguments: '{"q":"fix"}' }],
      createTime: '2026-10-01T06:00:01Z'
    });
    olderPageRecords.push({
      id: `tool-res-${i}`,
      turnId,
      type: 'TOOL',
      toolCallId: callId,
      toolCall: {
        id: callId,
        toolName: 'search_code',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: `result ${i}` }
      },
      createTime: '2026-10-01T06:00:02Z'
    });
  }

  olderPageRecords.push({
    id: 'ai-intermediate-text',
    turnId,
    type: 'AI',
    text: '开发完成。我用浏览器实测……',
    createTime: '2026-10-01T06:00:15Z'
  });

  // 模拟最新页（Page 1，最初拉取到的消息：包含后续 26 个工具调用及最终定稿 AI 文本）
  const newerPageRecords: SessionMessageVO[] = [];
  for (let i = 15; i <= 40; i++) {
    const callId: string = `call-tool-${i}`;
    newerPageRecords.push({
      id: `ai-tool-req-${i}`,
      turnId,
      type: 'AI',
      toolCalls: [{ id: callId, name: 'run_command', arguments: '{"cmd":"npm test"}' }],
      createTime: '2026-10-01T06:00:20Z'
    });
    newerPageRecords.push({
      id: `tool-res-${i}`,
      turnId,
      type: 'TOOL',
      toolCallId: callId,
      toolCall: {
        id: callId,
        toolName: 'run_command',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: `pass ${i}` }
      },
      createTime: '2026-10-01T06:00:21Z'
    });
  }

  newerPageRecords.push({
    id: 'ai-final-text',
    turnId,
    type: 'AI',
    text: '已修复并实测通过 ✅',
    createTime: '2026-10-01T06:00:40Z'
  });

  // 按照实施方案：mergeRawRecords(older, newer) -> aggregateSessionMessages
  const combinedRecords: SessionMessageVO[] = mergeRawRecords(olderPageRecords, newerPageRecords);
  const messages: ChatMessage[] = aggregateSessionMessages(combinedRecords, sessionId);

  // 验证结果：1 条 USER 消息 + 1 条 ASSISTANT 消息，共 2 条消息（同一个回答组）
  assert.strictEqual(messages.length, 2, '应当只有 1 条用户消息和 1 条聚合后的回答消息');

  const userMsg: ChatMessage = messages[0];
  const asstMsg: ChatMessage = messages[1];

  assert.strictEqual(userMsg.role, 'user');
  assert.strictEqual(asstMsg.role, 'assistant');
  assert.strictEqual(asstMsg.turnId, turnId);
  assert.strictEqual(asstMsg.id, `msg-${sessionId}-turn-${turnId}`);

  // 验证工具数量：完整合并 40 个工具调用
  assert.strictEqual(asstMsg.toolCalls?.length, 40, '应当完整包含 40 个工具调用');

  // 验证正文：最后一条非空 AI 文本作为正文
  assert.strictEqual(asstMsg.content, '已修复并实测通过 ✅', '最终正文应为最新页的定稿文本');

  // 验证折叠过程：较早页的非空 AI 文本进入折叠过程
  assert.strictEqual(asstMsg.aiMessages?.length, 1, '较早页的文本应进入 aiMessages 折叠列表');
  assert.strictEqual(asstMsg.aiMessages?.[0]?.text, '开发完成。我用浏览器实测……');

  // 验证回答分组
  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 1, '同一轮次跨页合并后应仅生成 1 个回答组');
  assert.strictEqual(groups[0].turnId, turnId);
});

test('2. 重复加载同一页: 幂等性去重，消息、工具与卡片不重复计数', () => {
  const sessionId: string = 'sess-100';
  const turnId: string = 'turn-200';

  const singlePage: SessionMessageVO[] = [
    {
      id: 'msg-u1',
      turnId,
      type: 'USER',
      text: '你好',
      createTime: '2026-10-01T00:00:00Z'
    },
    {
      id: 'msg-ai-1',
      turnId,
      type: 'AI',
      text: '你好！',
      toolCalls: [{ id: 'call-1', name: 'calc', arguments: '{}' }],
      createTime: '2026-10-01T00:00:01Z'
    },
    {
      id: 'msg-tool-1',
      turnId,
      type: 'TOOL',
      toolCallId: 'call-1',
      toolCall: {
        id: 'call-1',
        toolName: 'calc',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: '42' }
      },
      createTime: '2026-10-01T00:00:02Z'
    }
  ];

  // 模拟同一页被加载两次
  const mergedOnce: SessionMessageVO[] = mergeRawRecords(singlePage, []);
  const mergedTwice: SessionMessageVO[] = mergeRawRecords(singlePage, mergedOnce);

  assert.strictEqual(mergedTwice.length, singlePage.length, '重复合并同一页原始记录长度不变');

  const msgsOnce: ChatMessage[] = aggregateSessionMessages(mergedOnce, sessionId);
  const msgsTwice: ChatMessage[] = aggregateSessionMessages(mergedTwice, sessionId);

  assert.strictEqual(msgsTwice.length, 2);
  assert.strictEqual(msgsTwice[1].toolCalls?.length, 1);
  // 该 AI 行仍带工具调用 = 这一轮没有结论（终结判据「该轮无工具调用」，见 session.ts），
  // 因此它的文本属于中途叙述，进折叠过程区而不是正文。
  assert.strictEqual(msgsTwice[1].content, '');
  assert.strictEqual(msgsTwice[1].aiMessages?.length, 1);
  assert.strictEqual(msgsTwice[1].aiMessages?.[0]?.text, '你好！');
  assert.deepStrictEqual(msgsOnce, msgsTwice, '重复解析输出严格一致');
});

test('3. 不同轮次相邻: 分别展示，不误合并', () => {
  const sessionId: string = 'sess-multi';
  const turn1: string = 'turn-1';
  const turn2: string = 'turn-2';

  const records: SessionMessageVO[] = [
    { id: 'u1', turnId: turn1, type: 'USER', text: '问题 1' },
    { id: 'a1', turnId: turn1, type: 'AI', text: '回答 1' },
    { id: 'u2', turnId: turn2, type: 'USER', text: '问题 2' },
    { id: 'a2', turnId: turn2, type: 'AI', text: '回答 2' }
  ];

  const messages: ChatMessage[] = aggregateSessionMessages(records, sessionId);
  assert.strictEqual(messages.length, 4, '两个轮次应有 4 条消息');

  assert.strictEqual(messages[0].turnId, turn1);
  assert.strictEqual(messages[1].id, `msg-${sessionId}-turn-${turn1}`);
  assert.strictEqual(messages[1].content, '回答 1');

  assert.strictEqual(messages[2].turnId, turn2);
  assert.strictEqual(messages[3].id, `msg-${sessionId}-turn-${turn2}`);
  assert.strictEqual(messages[3].content, '回答 2');

  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 2, '应分为两个独立的回答组');
  assert.strictEqual(groups[0].turnId, turn1);
  assert.strictEqual(groups[1].turnId, turn2);
});

test('4. 旧消息无 turnId: 正常降级，按用户消息边界分组，无跨用户提问误合并', () => {
  const sessionId: string = 'sess-legacy';

  const legacyRecords: SessionMessageVO[] = [
    { id: 'leg-u1', turnId: null, type: 'USER', text: '旧提问 1' },
    { id: 'leg-a1', turnId: null, type: 'AI', text: '旧回答 1' },
    { id: 'leg-u2', turnId: null, type: 'USER', text: '旧提问 2' },
    { id: 'leg-a2', turnId: null, type: 'AI', text: '旧回答 2' }
  ];

  const messages: ChatMessage[] = aggregateSessionMessages(legacyRecords, sessionId);
  assert.strictEqual(messages.length, 4);

  assert.strictEqual(messages[0].content, '旧提问 1');
  assert.strictEqual(messages[1].id, `msg-${sessionId}-legacy-leg-a1`);
  assert.strictEqual(messages[1].content, '旧回答 1');

  assert.strictEqual(messages[2].content, '旧提问 2');
  assert.strictEqual(messages[3].id, `msg-${sessionId}-legacy-leg-a2`);
  assert.strictEqual(messages[3].content, '旧回答 2');

  const groups = groupMessagesByTurn(messages);
  assert.strictEqual(groups.length, 2, '无 turnId 的旧消息应按 USER 消息边界拆分为两个独立组');
  assert.strictEqual(groups[0].messages.length, 2);
  assert.strictEqual(groups[1].messages.length, 2);
});

test('6. PROMISE 人工在环卡片跨页: 审批状态与结果与工具调用正确同步', () => {
  const sessionId: string = 'sess-card';
  const turnId: string = 'turn-card';
  const callId: string = 'call-promise-1';

  const olderPage: SessionMessageVO[] = [
    {
      id: 'ai-req',
      turnId,
      type: 'AI',
      toolCalls: [{ id: callId, name: 'execute_command', arguments: '{"command":"dir"}' }]
    }
  ];

  const newerPage: SessionMessageVO[] = [
    {
      id: 'tool-card',
      turnId,
      type: 'TOOL',
      toolCallId: callId,
      toolCall: {
        id: callId,
        toolName: 'execute_command',
        type: 'PROMISE',
        title: '命令审批',
        content: { kind: 'COMMAND', command: 'dir' },
        rawOutput: { outcome: 'APPROVED', stdout: 'File1.txt' },
        pending: false
      }
    },
    {
      id: 'ai-end',
      turnId,
      type: 'AI',
      text: '命令已执行'
    }
  ];

  const combined = mergeRawRecords(olderPage, newerPage);
  const msgs = aggregateSessionMessages(combined, sessionId);

  assert.strictEqual(msgs.length, 1);
  const asst = msgs[0];
  assert.strictEqual(asst.content, '命令已执行');
  assert.strictEqual(asst.promptCards?.length, 1);
  assert.strictEqual(asst.promptCards[0].kind, 'COMMAND');
  assert.strictEqual(asst.promptCards[0].outcome, 'APPROVED');
  assert.strictEqual(asst.toolCalls?.[0]?.status, 'success', '审批通过后工具调用状态应更新为 success');
});

test('7. 相同轮次恢复（审批恢复/暂停恢复/重新订阅）: 复用原有回答气泡组', () => {
  const sessionId: string = 'sess-resume';
  const turnId: string = 'turn-resume-1';

  // 模拟第一阶段：触发审批并暂停
  const initialRecords: SessionMessageVO[] = [
    { id: 'u-res', turnId, type: 'USER', text: '执行危险命令' },
    {
      id: 'ai-promise',
      turnId,
      type: 'AI',
      toolCalls: [{ id: 'call-cmd', name: 'execute_command', arguments: '{"command":"rm -rf"}' }]
    },
    {
      id: 'tool-pending',
      turnId,
      type: 'TOOL',
      toolCallId: 'call-cmd',
      toolCall: {
        id: 'call-cmd',
        toolName: 'execute_command',
        type: 'PROMISE',
        content: { kind: 'COMMAND', command: 'rm -rf' },
        pending: true
      }
    }
  ];

  const initialMsgs = aggregateSessionMessages(initialRecords, sessionId);
  assert.strictEqual(initialMsgs.length, 2);
  assert.strictEqual(initialMsgs[1].id, `msg-${sessionId}-turn-${turnId}`);
  assert.strictEqual(initialMsgs[1].promptCard?.pending, true);

  // 模拟第二阶段：用户审批通过后恢复流并完成
  const resumedRecords: SessionMessageVO[] = [
    {
      id: 'tool-approved',
      turnId,
      type: 'TOOL',
      toolCallId: 'call-cmd',
      toolCall: {
        id: 'call-cmd',
        toolName: 'execute_command',
        type: 'PROMISE',
        content: { kind: 'COMMAND', command: 'rm -rf' },
        rawOutput: { outcome: 'APPROVED', stdout: 'done' },
        pending: false
      }
    },
    {
      id: 'ai-done',
      turnId,
      type: 'AI',
      text: '已处理完毕'
    }
  ];

  const merged = mergeRawRecords(initialRecords, resumedRecords);
  const finalMsgs = aggregateSessionMessages(merged, sessionId);

  assert.strictEqual(finalMsgs.length, 2, '恢复后应沿用同一个回答组，不生成新气泡');
  assert.strictEqual(finalMsgs[1].id, `msg-${sessionId}-turn-${turnId}`);
  assert.strictEqual(finalMsgs[1].content, '已处理完毕');
  assert.strictEqual(finalMsgs[1].promptCard?.pending, false);
  assert.strictEqual(finalMsgs[1].promptCard?.outcome, 'APPROVED');
});

test('8. 子会话历史跨页聚合: 与主会话采用相同聚合规则', () => {
  const subSessionId: string = 'sub-4001';
  const subTurnId: string = 'sub-turn-888';

  const subOlderPage: SessionMessageVO[] = [
    { id: 'sub-u1', turnId: subTurnId, type: 'USER', text: '子任务指令' },
    {
      id: 'sub-ai-1',
      turnId: subTurnId,
      type: 'AI',
      text: '准备处理数据...',
      toolCalls: [{ id: 'sub-call-1', name: 'read_file', arguments: '{"path":"data.csv"}' }]
    },
    {
      id: 'sub-tool-1',
      turnId: subTurnId,
      type: 'TOOL',
      toolCallId: 'sub-call-1',
      toolCall: {
        id: 'sub-call-1',
        toolName: 'read_file',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: 'a,b,c' }
      }
    }
  ];

  const subNewerPage: SessionMessageVO[] = [
    {
      id: 'sub-ai-2',
      turnId: subTurnId,
      type: 'AI',
      text: '子任务完成'
    }
  ];

  const subCombined = mergeRawRecords(subOlderPage, subNewerPage);
  const subMsgs = aggregateSessionMessages(subCombined, subSessionId);

  assert.strictEqual(subMsgs.length, 2);
  const subAsst = subMsgs[1];
  assert.strictEqual(subAsst.id, `msg-${subSessionId}-turn-${subTurnId}`);
  assert.strictEqual(subAsst.content, '子任务完成');
  assert.strictEqual(subAsst.aiMessages?.length, 1);
  assert.strictEqual(subAsst.aiMessages?.[0]?.text, '准备处理数据...');
  assert.strictEqual(subAsst.toolCalls?.length, 1);
  assert.strictEqual(subAsst.toolCalls?.[0]?.status, 'success');
});

/**
 * 过程时间线的时序契约：思维链 / 中间文本 / 工具调用三条集合的 order 必须同基准，
 * 否则 ChatMessageItem#processTimeline 的排序结果不是执行时序。
 *
 * 回归的是真实事故：中间文本曾用「AI 文本列表内下标 * 10 + 1」、思维链与工具用「原始消息行下标 * 10」，
 * 前者增长远慢于后者，于是整轮的过程文本被整体排到思维链与工具之前 —— 表现为
 * 「AI 文本被堆砌在过程消息区顶部，深度思考挤成一堵墙」。
 *
 * <p><b>10-05 契约变更</b>：同一轮次的多段思考**合并为一个「深度思考」步骤**（见下条断言）。
 * 取舍：实测一轮可达 10 段思考，若各建一步会渲染出 10 个同名下拉框，既看不出是同一段推理，
 * 也把工具行挤出视口（用户实拍验收：10 个「深度思考」排队，找不到任何工具痕迹）。
 * 合并后思考落在**首段位置**（工具之前），牺牲「思考与工具逐段交错」换取可读性 ——
 * 这是产品决策，不是回归。中间文本与工具调用仍严格按各自 order 交错。</p>
 */
test('9. 过程时间线时序: 思维链 → 中间文本 → 工具调用 按真实执行顺序交替，文本不再被顶到过程区顶部', () => {
  const sessionId: string = 'sess-timeline';
  const turnId: string = 'turn-timeline-1';

  const records: SessionMessageVO[] = [
    { id: 'u1', turnId, type: 'USER', text: '按团队流程实现' },
    // 第 1 轮：思考 + 叙述文本 + 委派工具
    {
      id: 'ai-r1',
      turnId,
      type: 'AI',
      text: '现有工程是移动竖屏 H5，与截图冲突，先确认方向。',
      thinking: '先读代码摸清现状',
      toolCalls: [{ id: 'call-1', name: 'execute_command', arguments: '{"command":"ls"}' }]
    },
    {
      id: 'tool-r1',
      turnId,
      type: 'TOOL',
      toolCallId: 'call-1',
      toolCall: {
        id: 'call-1',
        toolName: 'execute_command',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: 'ok' }
      }
    },
    // 第 2 轮：只有思考 + 工具，没有叙述文本
    {
      id: 'ai-r2',
      turnId,
      type: 'AI',
      thinking: '方向已确认，直接委派',
      toolCalls: [{ id: 'call-2', name: 'read_file', arguments: '{"path":"a.tsx"}' }]
    },
    {
      id: 'tool-r2',
      turnId,
      type: 'TOOL',
      toolCallId: 'call-2',
      toolCall: {
        id: 'call-2',
        toolName: 'read_file',
        type: 'EXECUTE',
        rawOutput: { outcome: 'SUCCEEDED', output: 'code' }
      }
    },
    // 第 3 轮：终结轮次（无工具调用）→ 它的文本是正文
    { id: 'ai-r3', turnId, type: 'AI', text: '已完成交付。', thinking: '汇总交付结论' }
  ];

  const msgs = aggregateSessionMessages(records, sessionId);
  const asst = msgs[1];

  assert.strictEqual(asst.content, '已完成交付。', '终结轮次文本落正文');
  assert.strictEqual(asst.aiMessages?.length, 1, '仅中途叙述进过程区');
  assert.strictEqual(asst.thoughtSteps?.length, 1, '同一轮多段思考合并为一个步骤');
  assert.strictEqual(
    asst.thoughtSteps?.[0].content,
    '先读代码摸清现状\n\n方向已确认，直接委派\n\n汇总交付结论',
    '合并内容按行序拼接，保留完整推理轨迹'
  );
  assert.strictEqual(asst.toolCalls?.length, 2);

  // 还原 ChatMessageItem#processTimeline 的排序（order 升序），检查三类条目的交替顺序
  type Entry = { order: number; kind: string };
  const entries: Entry[] = [];
  (asst.thoughtSteps || []).forEach(s => entries.push({ order: s.order, kind: 'thought' }));
  (asst.aiMessages || []).forEach(m => entries.push({ order: m.order, kind: 'text' }));
  (asst.toolCalls || []).forEach(t => entries.push({ order: t.order, kind: 'tool' }));
  entries.sort((a, b) => a.order - b.order);

  assert.deepStrictEqual(
    entries.map(e => e.kind),
    ['thought', 'text', 'tool', 'tool'],
    '合并后的思考落在首段位置，中间文本与工具仍按真实时序排列'
  );
});

/**
 * 槽位步长的容量契约：单行并行下发多个工具调用时，`+2+tIdx` 不得溢出到下一行的槽位。
 * 溢出会让该工具行排到下一轮思考之前（步长 10 时，第 9 个并行工具即撞位）。
 */
test('10. 过程时间线槽位: 单行 10 个并行工具调用不溢出到下一轮', () => {
  const sessionId: string = 'sess-slot';
  const turnId: string = 'turn-slot-1';

  const parallelTools = Array.from({ length: 10 }, (_, k) => ({
    id: `call-p${k}`,
    name: 'read_file',
    arguments: `{"path":"f${k}.ts"}`
  }));

  const records: SessionMessageVO[] = [
    { id: 'u1', turnId, type: 'USER', text: '并行读取' },
    { id: 'ai-p', turnId, type: 'AI', text: '并行读取多个文件。', toolCalls: parallelTools },
    { id: 'ai-end', turnId, type: 'AI', text: '读取完毕。', thinking: '汇总读取结果' }
  ];

  const msgs = aggregateSessionMessages(records, sessionId);
  const asst = msgs[1];
  const tools = asst.toolCalls || [];
  assert.strictEqual(tools.length, 10);

  const lastToolOrder = Math.max(...tools.map(t => t.order));
  const nextStepOrder = Math.max(...(asst.thoughtSteps || []).map(s => s.order));
  assert.ok(
    lastToolOrder < nextStepOrder,
    `同一行第 10 个工具 (order=${lastToolOrder}) 必须仍排在本行槽位内、早于后续行 (order=${nextStepOrder})`
  );
});

/**
 * 气泡顺序的稳定性：聚合顺序**不能**取决于「该轮次的行在本次 records 里第一次出现在哪」。
 * 首屏只取最新一页，窗口滑进某一轮中间时，那一轮会晚于更晚的轮次出现 —— 按首次出现排序，
 * 两个气泡就会上下换位（线上事故：并发/相邻两轮随会话推进反复换位）。
 * 顺序改由轮次雪花 ID（受理先后）决定后，与拉的是哪一页无关。
 */
test('11. 首屏窗口切在轮次中间: 气泡顺序仍按轮次先后，不随分页窗口漂移', () => {
  const sessionId: string = 'sess-order';
  const earlierTurn: string = '2106057094397558784';
  const laterTurn: string = '2106057227516379136';

  // 模拟真实首屏：最新的 50 条里，较晚的那一轮（laterTurn）的行排在更前面，
  // 较早那一轮（earlierTurn）只剩后半段 —— 它的首条已落在窗口之外。
  const page: SessionMessageVO[] = [
    {
      id: '2106057986672820224',
      turnId: laterTurn,
      type: 'AI',
      text: '继续收尾。先让 QA 对修复版本复测。',
      toolCalls: [{ id: 'c-l1', name: 'call_sub_agent', arguments: '{}' }]
    },
    {
      id: '2106058112480968704',
      turnId: earlierTurn,
      type: 'AI',
      text: 'QA 复测：BUG-01 已关闭。',
      toolCalls: [{ id: 'c-e1', name: 'call_sub_agent', arguments: '{}' }]
    },
    { id: '2106060153068584960', turnId: laterTurn, type: 'AI', text: '交付闭环完成。' },
    { id: '2106059701899886592', turnId: earlierTurn, type: 'AI', text: '团队协作流程已完整走完。' }
  ];

  const msgs = aggregateSessionMessages(page, sessionId);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].turnId, earlierTurn, '较早的轮次必须排在前面');
  assert.strictEqual(msgs[1].turnId, laterTurn, '较晚的轮次必须排在后面');
  assert.strictEqual(msgs[0].content, '团队协作流程已完整走完。');
  assert.strictEqual(msgs[1].content, '交付闭环完成。');
});

/**
 * 同一轮次只允许一条 assistant 气泡：审批恢复流的调用方给气泡钉的是本地 id
 * （msg-bot-resume-*），与服务端落库行 id 不同源，对账时按 id 收编拦不住它 ——
 * 两条并存就是一个轮次两个「已思考并调用」头。
 *
 * 保留**本地在途**那条：它的正文来自实时事件（会话级流现在直接渲染根事件），比落库行新；
 * 服务端那条收尾后（isComplete 转 true）自然会在下一轮对账里收编。
 */
