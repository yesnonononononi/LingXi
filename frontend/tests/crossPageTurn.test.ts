import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionMessageVO, ChatMessage, ChatTurn } from '../src/types/chat';
import {
  mergeRawRecords,
  aggregateSessionMessages,
  groupMessagesByTurn
} from '../src/utils/session';
import { mergeAuthoritativeMessages, mergeTurns } from '../src/views/chat/useChatHistory';

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
  assert.strictEqual(msgsTwice[1].content, '你好！');
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

test('5. 流结束权威对账: 相同轮次由服务端落库消息替换本地完成消息，不出现重复气泡', () => {
  const turnId: string = 'turn-reconcile';
  const startedAt: number = 1000;

  // 本地实时流产生的消息（已完成）
  const localMessages: ChatMessage[] = [
    {
      id: `msg-sess-turn-${turnId}`,
      role: 'assistant',
      turnId,
      content: '实时文本',
      timestamp: 1050,
      isComplete: true
    }
  ];

  // 服务端拉取到的落库权威消息
  const serverMessages: ChatMessage[] = [
    {
      id: `msg-sess-turn-${turnId}`,
      role: 'assistant',
      turnId,
      content: '服务端落库权威文本',
      timestamp: 1050,
      isComplete: true
    }
  ];

  const serverTurns: Record<string, ChatTurn> = {
    [turnId]: {
      turnId,
      status: 'COMPLETED',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      elapsedMs: 500
    }
  };

  const reconciled = mergeAuthoritativeMessages(localMessages, serverMessages, startedAt, {}, serverTurns);
  assert.strictEqual(reconciled.messages.length, 1, '对账后同轮次只保留一份服务端权威消息');
  assert.strictEqual(reconciled.messages[0].content, '服务端落库权威文本');
  assert.strictEqual(reconciled.turns[turnId]?.totalTokens, 300);
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
