import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatSession } from '../src/types/chat';
import type { AgentEvent } from '../src/types/Event';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';

import { AgentToolName } from '../src/utils/toolNames';

function assertPendingText(bubble: ChatMessage, responseId: string, text: string): void {
  assert.equal(bubble.content, '', '用途未确认不能进入正文');
  assert.equal(bubble.aiMessages?.find(item => item.id === `text:${responseId}`)?.text, text, '每次写入同步更新过程文本');
  assert.equal(bubble.turnState?.texts[`text:${responseId}`]?.isBody, undefined);
}

test('1. 流式渲染: 原始增量即时打印，块视图校准身份和位置', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'test-session-1' });

  // 1. 用户提问
  reducer.pushUserMessage('请帮我查询天气并写一份报告');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');

  // 2. 轮次启动
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-101', sessionId: 'test-session-1' }
  });
  assert.equal(messages.length, 2);
  const bubble = messages[1];
  assert.equal(bubble.role, 'assistant');
  assert.equal(bubble.turnId, 'turn-101');
  assert.equal(bubble.isThinking, true);
  assert.equal(bubble.isExploring, true);
  assert.equal(bubble.isComplete, false);

  // 思考与正文使用各自的偏移，完整视图到达前也要可见。
  reducer.consume({
    type: 'PARTIAL_THINKING',
    responseId: '1',
    offset: 0,
    order: 0,
    content: '正在规划查询步骤...',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-101' }
  });
  reducer.flush();
  assert.equal(bubble.isThinking, true, '增量思考维持运行态');
  assert.equal(bubble.thoughtSteps?.[0]?.content, '正在规划查询步骤...', '增量思考立即打印');

  // 工具开始即显示，审批卡片仍从权威接口读取。
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.WebSearch,
    requestId: 'call-weather-1',
    order: 1,
    args: '{"q":"北京天气"}',
    resultStatus: 'STARTED',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-101' }
  });
  assert.equal(bubble.isExploring, false, '工具调用结束「探索中」');
  assert.equal(bubble.toolCalls?.length, 1, '工具开始即显示');
  assert.equal(bubble.toolCalls?.[0]?.status, 'calling');

  // 收尾更新同一调用。
  reducer.consume({
    type: 'TOOL_COMPLETED',
    toolName: AgentToolName.WebSearch,
    requestId: 'call-weather-1',
    output: '晴，22℃',
    resultStatus: 'COMPLETED',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:03Z',
    metaData: { turnId: 'turn-101' }
  });
  assert.equal(bubble.toolCalls?.length, 1, '收尾不创建第二个工具条');
  assert.equal(bubble.toolCalls?.[0]?.result, '晴，22℃');

  // 未确认用途的文本打印不等待快照或对账。
  reducer.consume({
    type: 'PARTIAL_TEXT',
    responseId: '1',
    offset: 0,
    content: '今天北京的天气是晴天，气温约22℃。',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:04Z',
    metaData: { turnId: 'turn-101' }
  });
  reducer.flush();
  assertPendingText(bubble, '1', '今天北京的天气是晴天，气温约22℃。');

  // 7. 权威块视图到达：内容、顺序、状态全部来自后端
  reducer.consume({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-101',
    viewVersion: 3,
    view: {
      sessionId: 'test-session-1',
      turnId: 'turn-101',
      status: 'RUNNING',
      viewVersion: 3,
      blocks: [
        { blockId: 'thinking:1', type: 'THINKING', order: 0, status: 'COMPLETE', text: '正在规划查询步骤...' },
        { blockId: 'tool:call-weather-1', type: 'TOOL', order: 1, status: 'COMPLETED', toolCallId: 'call-weather-1', toolName: AgentToolName.WebSearch },
        { blockId: 'text:1', type: 'TEXT', order: 2, status: 'COMPLETE', isBody: true, text: '今天北京的天气是晴天，气温约22℃。' }
      ]
    }
  });
  assert.equal(bubble.content, '今天北京的天气是晴天，气温约22℃。', '正文来自 BODY 块');
  assert.equal(bubble.thoughtSteps?.[0].content, '正在规划查询步骤...', '思考来自 THINKING 块');
  assert.equal(bubble.toolCalls?.[0].status, 'success', '工具状态来自 TOOL 块');
  assert.equal(bubble.toolCalls?.[0].order, 1, '工具 order 来自后端');

  // 8. 终结结算
  reducer.consume({
    type: 'EXECUTION_COMPLETED',
    tokenInfo: { inputTokenCount: 120, outputTokenCount: 85, totalTokenCount: 205 },
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:05Z',
    metaData: { turnId: 'turn-101' }
  });
  assert.equal(bubble.isComplete, true);
  assert.equal(bubble.isThinking, false);
  assert.equal(bubble.isExploring, false);
  assert.equal(bubble.tokenInfo?.totalTokenCount, 205);
  assert.equal(bubble.content, '今天北京的天气是晴天，气温约22℃。', '终结不得改动块视图内容');
});

test('2. 幂等: 增量与完整文本使用同一响应身份，冲突全文不能覆盖原文', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'test-session-2' });

  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-202' }
  });
  const bubble = messages[0];

  reducer.consume({
    type: 'PARTIAL_TEXT',
    responseId: '102', offset: 0, metaData: { turnId: 'turn-202' },
    content: 'Hello, ',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:01Z'
  });
  reducer.consume({
    type: 'PARTIAL_TEXT',
    responseId: '102', offset: 7, metaData: { turnId: 'turn-202' },
    content: 'world!',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:02Z'
  });
  reducer.flush();
  assertPendingText(bubble, '102', 'Hello, world!');

  // 全文从零偏移校准，不得在已打印内容后再次追加。
  reducer.consume({
    type: 'COMPLETE_TEXT',
    responseId: '102', metaData: { turnId: 'turn-202' },
    content: 'Hello, world! (aligned)',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:03Z'
  });
  assertPendingText(bubble, '102', 'Hello, world! (aligned)');

  // AI_MESSAGE 噪声：内容不应被重复覆盖或篡改
  reducer.consume({
    type: 'AI_MESSAGE',
    responseId: '102', metaData: { turnId: 'turn-202' },
    text: 'NOISE CONTENT THAT SHOULD BE IGNORED',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:04Z'
  });
  assertPendingText(bubble, '102', 'Hello, world! (aligned)');
});

test('3. 根会话与多子会话(1:N)事件路由: 主子独立渲染，主会话协同条状态同步', () => {
  const rootSession: ChatSession = {
    id: 'root-session',
    title: '主会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    modelId: 'gpt-4',
    activeTools: [],
    messages: [],
    subSessions: [
      {
        id: 'sub-agent-1',
        rootSessionId: 'root-session',
        name: '代码审查专家',
        agentName: '代码审查专家',
        messages: []
      }
    ]
  };

  const router = new StreamSessionRouter();
  router.bindRootSession(rootSession);

  // 1. 主会话收到用户提问并派发 call_sub_agent
  router.pushUserMessage('请委派代码审查专家审查 PR #12');
  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-root-1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-root-1', sessionId: 'root-session' }
  });
  router.dispatch({
    type: 'TOOL_CALL',
    toolName: AgentToolName.CallSubAgent,
    requestId: 'call-sub-1',
    args: '{"agentId":"sub-1","task":"审查 PR #12","subSessionId":"sub-agent-1"}',
    resultStatus: 'STARTED',
    executionId: 'exec-root-1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-root-1', sessionId: 'root-session' }
  });

  const rootBubble = rootSession.messages[1];
  assert.equal(rootBubble.toolCalls?.length, 1, '主会话的工具开始即显示');

  // 2. 子会话事件流入（metaData.sessionId = 'sub-agent-1'）
  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-sub-1',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-sub-1', sessionId: 'sub-agent-1', rootSessionId: 'root-session' }
  });
  router.dispatch({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-sub-1',
    viewVersion: 1,
    view: {
      sessionId: 'sub-agent-1',
      turnId: 'turn-sub-1',
      status: 'COMPLETED',
      viewVersion: 1,
      blocks: [
        { blockId: 'text:sub-1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '开始审查 PR #12：第 34 行存在空指针隐患。' }
      ]
    },
    executionId: 'exec-sub-1',
    timestamp: '2026-10-06T06:00:03Z',
    metaData: { turnId: 'turn-sub-1', sessionId: 'sub-agent-1', rootSessionId: 'root-session' }
  } as unknown as AgentEvent);
  router.dispatch({
    type: 'EXECUTION_COMPLETED',
    tokenInfo: { totalTokenCount: 50 },
    executionId: 'exec-sub-1',
    timestamp: '2026-10-06T06:00:04Z',
    metaData: { turnId: 'turn-sub-1', sessionId: 'sub-agent-1', rootSessionId: 'root-session' }
  });
  router.flushAll();

  // 验证子会话消息独立且完整渲染
  const subVO = rootSession.subSessions?.[0];
  assert.ok(subVO);
  assert.equal(subVO.messages?.length, 1);
  assert.equal(subVO.messages?.[0].content, '开始审查 PR #12：第 34 行存在空指针隐患。');
  assert.equal(subVO.messages?.[0].isComplete, true);
  assert.equal(subVO.lastOutcome, 'COMPLETED');
});

test('4. 动态子代理注册: 收到未预注册的子会话事件时自动登记容器并渲染', () => {
  const rootSession: ChatSession = {
    id: 'root-dynamic',
    title: '主会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    modelId: 'gpt-4',
    activeTools: [],
    messages: [],
    subSessions: []
  };

  let discoveredId = '';
  const router = new StreamSessionRouter({
    onSubSessionDiscovered: (sub) => {
      discoveredId = String(sub.id);
    }
  });
  router.bindRootSession(rootSession);

  // 派发动态子会话事件（sub-999 不在原有 subSessions 中）
  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-dynamic-1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-dyn-1', sessionId: 'sub-999', rootSessionId: 'root-dynamic', agentName: '动态专家' }
  });
  router.dispatch({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-dyn-1',
    viewVersion: 1,
    view: {
      sessionId: 'sub-999',
      turnId: 'turn-dyn-1',
      status: 'COMPLETED',
      viewVersion: 1,
      blocks: [
        { blockId: 'text:dyn-1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '动态专家报告生成完毕' }
      ]
    },
    executionId: 'exec-dynamic-1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-dyn-1', sessionId: 'sub-999', rootSessionId: 'root-dynamic' }
  } as unknown as AgentEvent);
  router.flushAll();

  assert.equal(discoveredId, 'sub-999');
  assert.equal(rootSession.subSessions?.length, 1);
  assert.equal(rootSession.subSessions?.[0].id, 'sub-999');
  assert.equal(rootSession.subSessions?.[0].messages?.[0].content, '动态专家报告生成完毕');
});

test('5. 暂停与恢复(Human-in-the-Loop): 挂起后不拆分新气泡，恢复后原地接续当前 Turn', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'test-session-hil' });

  // 1. 启动
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-hil-1' }
  });
  assert.equal(messages.length, 1);
  const bubble = messages[0];

  // 2. 工具调用需要审批 (PROMISE)：原始事件不建卡（审批卡由 onResolveCard 拉取权威数据）
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.ExecuteCommand,
    requestId: 'cmd-delete-1',
    args: '{"command":"rm -rf /tmp/build"}',
    resultStatus: 'STARTED',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-hil-1' }
  });

  // 3. 后端协作式挂起
  reducer.consume({
    type: 'EXECUTION_SUSPENDED',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-hil-1' }
  });

  assert.equal(bubble.isSuspended, true);
  assert.equal(bubble.isComplete, false); // 绝不提前标记为已结束
  assert.equal(bubble.isThinking, false);

  // 4. 用户放行后，后端下发恢复事件
  reducer.consume({
    type: 'EXECUTION_RESUME',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:10Z',
    metaData: { turnId: 'turn-hil-1' }
  });

  assert.equal(bubble.isSuspended, false);
  assert.equal(bubble.isThinking, true);
  assert.equal(messages.length, 1); // 严格复用同一个气泡，不裂变！

  // 5. 权威块视图补齐内容（工具终态 + 正文），再由终结事件收尾
  reducer.consume({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-hil-1',
    viewVersion: 2,
    view: {
      sessionId: 'test-session-hil',
      turnId: 'turn-hil-1',
      status: 'COMPLETED',
      viewVersion: 2,
      blocks: [
        { blockId: 'tool:cmd-delete-1', type: 'TOOL', order: 0, status: 'COMPLETED', toolCallId: 'cmd-delete-1', toolName: AgentToolName.ExecuteCommand },
        { blockId: 'text:hil-1', type: 'TEXT', order: 1, status: 'COMPLETE', isBody: true, text: '临时构建文件已成功清理完毕。' }
      ]
    },
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:11Z',
    metaData: { turnId: 'turn-hil-1' }
  } as unknown as AgentEvent);
  reducer.consume({
    type: 'EXECUTION_COMPLETED',
    tokenInfo: { totalTokenCount: 150 },
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:13Z',
    metaData: { turnId: 'turn-hil-1' }
  });
  reducer.flush();

  assert.equal(messages.length, 1);
  assert.equal(bubble.isComplete, true);
  assert.equal(bubble.content, '临时构建文件已成功清理完毕。');
  assert.equal(bubble.toolCalls?.[0].status, 'success');
});

test('6. 连续原始片段无需 flush 即可打印', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'test-session-buffer' });
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-b1',
    timestamp: '2026-10-06T06:00:00Z',
    metaData: { turnId: 'turn-b1' }
  });
  const bubble = messages[0];

  reducer.consume({ type: 'PARTIAL_TEXT', responseId: '106', offset: 0, metaData: { turnId: 'turn-b1' }, content: 'A', executionId: 'exec-b1', timestamp: '' });
  assertPendingText(bubble, '106', 'A');
  reducer.consume({ type: 'PARTIAL_TEXT', responseId: '106', offset: 1, metaData: { turnId: 'turn-b1' }, content: 'B', executionId: 'exec-b1', timestamp: '' });
  assertPendingText(bubble, '106', 'AB');
  reducer.consume({ type: 'PARTIAL_TEXT', responseId: '106', offset: 2, metaData: { turnId: 'turn-b1' }, content: 'C', executionId: 'exec-b1', timestamp: '' });
  reducer.flush();

  assertPendingText(bubble, '106', 'ABC');
});

test('7. 服务端雪花 ID 驱动的根会话流式路由: 根会话绑定持久化雪花 ID，流式事件准确注入根会话气泡，不误判为子会话', () => {
  const rootSession: ChatSession = {
    id: '2107364703088017408',
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    modelId: 'gpt-4',
    activeTools: [],
    messages: [],
    subSessions: []
  };

  const router = new StreamSessionRouter();
  router.bindRootSession(rootSession);

  // 1. 用户提问上屏
  router.pushUserMessage('1');
  assert.equal(rootSession.messages.length, 1);
  assert.equal(rootSession.messages[0].content, '1');

  // 2. 服务端首个事件到来（例如 CONTEXT_UPDATE，携带服务端雪花 ID）
  router.dispatch({
    type: 'CONTEXT_UPDATE',
    executionId: '2107364703104794624',
    timestamp: '2026-10-06T06:57:56.135Z',
    usage: { tokenCount: 1199, maxTokens: 393200, ratio: 0.003 },
    message: '',
    metaData: {
      sessionId: '2107364703088017408',
      rootSessionId: '2107364703088017408',
      turnId: '2107364703113183232',
      historyRevision: '1'
    }
  });

  // 验证绝未被误注册为子会话！
  assert.equal(rootSession.subSessions?.length, 0);

  // 3. 接下来服务端推送权威块视图
  router.dispatch({
    type: 'TURN_SNAPSHOT',
    turnId: '2107364703113183232',
    viewVersion: 1,
    view: {
      sessionId: '2107364703088017408',
      turnId: '2107364703113183232',
      status: 'COMPLETED',
      viewVersion: 1,
      blocks: [
        { blockId: 'text:1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '你发送的是「1」，请问有什么可以帮您？' }
      ]
    },
    executionId: '2107364703104794624',
    timestamp: '2026-10-06T06:57:57.000Z',
    metaData: {
      sessionId: '2107364703088017408',
      rootSessionId: '2107364703088017408',
      turnId: '2107364703113183232'
    }
  } as unknown as AgentEvent);
  router.flushAll();

  // 验证主消息列表正确渲染出回复气泡
  assert.equal(rootSession.messages.length, 2);
  const assistantBubble = rootSession.messages[1];
  assert.equal(assistantBubble.role, 'assistant');
  assert.equal(assistantBubble.turnId, '2107364703113183232');
  assert.equal(assistantBubble.content, '你发送的是「1」，请问有什么可以帮您？');
  assert.equal(assistantBubble.contextUsage?.tokenCount, 1199);
});

test('8. CONTEXT_UPDATE 前置到达: 助手气泡稳定复用，不分裂空气泡', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: '2107364703088017408' });

  // CONTEXT_UPDATE 先于 EXECUTION_STARTED 到达
  reducer.consume({
    type: 'CONTEXT_UPDATE',
    executionId: 'exec-pre',
    timestamp: '2026-10-06T06:00:00Z',
    usage: { tokenCount: 500, maxTokens: 10000, ratio: 0.05 },
    metaData: { turnId: 'turn-pre-1' }
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].turnId, 'turn-pre-1');

  // EXECUTION_STARTED 随后到达，必须复用同一个气泡
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-pre',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-pre-1' }
  });
  assert.equal(messages.length, 1);

  // 正文经权威块视图到达
  reducer.consume({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-pre-1',
    viewVersion: 1,
    view: {
      sessionId: '2107364703088017408',
      turnId: 'turn-pre-1',
      status: 'COMPLETED',
      viewVersion: 1,
      blocks: [
        { blockId: 'text:pre-1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '测试前置更新成功' }
      ]
    },
    executionId: 'exec-pre',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-pre-1' }
  } as unknown as AgentEvent);
  reducer.flush();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '测试前置更新成功');
});

/**
 * ★ 唯一展示链路：过程项的 order 与分桶全部来自后端块视图。
 *
 * <p>改造后前端**不再**参与时序与状态推断：没有 `nextOrderFor`、没有「工具调用即断句」、
 * 没有「工具收尾即终结」。中间叙述（PROCESS）与正文（BODY）的分桶、以及每一项的 order，
 * 都由后端 isBody / order 唯一决定。本用例锁住这条不变量。</p>
 */
test('★ 过程项分桶与 order 完全来自后端块视图，前端不做任何推断', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: 'test-session-order' });

  reducer.pushUserMessage('看看这个文件');
  reducer.consume({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-o1',
    timestamp: '2026-10-08T09:00:00Z',
    metaData: { turnId: 'turn-o1', sessionId: 'test-session-order' }
  });
  const bubble = messages[1];

  // 后端给出交错的过程项：PROCESS 文本 与 TOOL 拿到的 order 由后端排定（不是前端递增）
  reducer.consume({
    type: 'TURN_SNAPSHOT',
    turnId: 'turn-o1',
    viewVersion: 1,
    view: {
      sessionId: 'test-session-order',
      turnId: 'turn-o1',
      status: 'COMPLETED',
      viewVersion: 1,
      blocks: [
        { blockId: 'text:p1', type: 'TEXT', order: 1000, status: 'COMPLETE', isBody: false, text: '先看一下这个文件的实现。' },
        { blockId: 'tool:call-o1', type: 'TOOL', order: 2000, status: 'COMPLETED', toolCallId: 'call-o1', toolName: AgentToolName.ReadFile },
        { blockId: 'text:b1', type: 'TEXT', order: 3000, status: 'COMPLETE', isBody: true, text: '这个文件做了三件事。' }
      ]
    },
    executionId: 'exec-o1',
    timestamp: '2026-10-08T09:00:02Z',
    metaData: { turnId: 'turn-o1' }
  } as unknown as AgentEvent);

  assert.equal(bubble.content, '这个文件做了三件事。', 'BODY 块进正文');
  assert.equal(bubble.aiMessages?.length, 1, 'PROCESS 块进中间叙述');
  assert.equal(bubble.aiMessages?.[0].text, '先看一下这个文件的实现。');
  assert.equal(bubble.aiMessages?.[0].order, 1000, '中间叙述 order 取后端值');
  assert.equal(bubble.toolCalls?.[0].order, 2000, '工具 order 取后端值');
  assert.ok(
    !String(bubble.content).includes('先看一下'),
    '中间叙述绝不能留在正文里（分桶由后端 isBody 决定）'
  );

  // 时间线顺序 = 后端 order 升序，与传入顺序无关
  assert.deepEqual(
    (bubble.processTimeline ?? []).map(item => item.type),
    ['intermediate_ai', 'tool'],
    '时间线按后端 order 升序'
  );

  // 原始事件之后再到达也不得改变任何过程项（展示内容只认块视图）
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.WebSearch,
    requestId: 'call-late',
    args: '{"q":"y"}',
    resultStatus: 'STARTED',
    executionId: 'exec-o1',
    timestamp: '2026-10-08T09:00:03Z',
    metaData: { turnId: 'turn-o1' }
  });
  reducer.consume({
    type: 'PARTIAL_TEXT',
    content: '追加的正文',
    executionId: 'exec-o1',
    timestamp: '2026-10-08T09:00:04Z',
    metaData: { turnId: 'turn-o1' }
  });
  reducer.flush();

  assert.equal(bubble.toolCalls?.length, 1, '原始 TOOL_CALL 不得新增工具项');
  assert.equal(bubble.content, '这个文件做了三件事。', '原始正文增量不得改写正文');
});
