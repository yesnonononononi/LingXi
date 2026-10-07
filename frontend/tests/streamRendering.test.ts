import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatSession } from '../src/types/chat';
import type { AgentEvent } from '../src/types/Event';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';
import { StreamFrameBuffer } from '../src/views/chat/streamFrameBuffer';
import { AgentToolName } from '../src/utils/toolNames';

test('1. 流式渲染状态机: 思考 -> 工具调用 -> 增量正文 -> 终结用量聚合为单一助手气泡', () => {
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

  // 3. 增量思考吐字
  reducer.consume({
    type: 'PARTIAL_THINKING',
    content: '正在规划查询步骤...',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-101' }
  });
  reducer.flush();
  assert.equal(bubble.thoughtSteps?.length, 1);
  assert.equal(bubble.thoughtSteps?.[0].content, '正在规划查询步骤...');

  // 4. 工具发起
  reducer.consume({
    type: 'TOOL_CALL',
    toolName: AgentToolName.WebSearch,
    requestId: 'call-weather-1',
    args: '{"q":"北京天气"}',
    resultStatus: 'STARTED',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-101' }
  });
  assert.equal(bubble.isExploring, false);
  assert.equal(bubble.toolCalls?.length, 1);
  assert.equal(bubble.toolCalls?.[0].toolName, AgentToolName.WebSearch);
  assert.equal(bubble.toolCalls?.[0].status, 'calling');

  // 5. 工具执行结束
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
  assert.equal(bubble.toolCalls?.[0].result, '晴，22℃');
  assert.equal(bubble.toolCalls?.[0].status, 'success');

  // 6. 增量正文输出
  reducer.consume({
    type: 'PARTIAL_TEXT',
    content: '今天北京的天气是晴天，气温约22℃。',
    executionId: 'exec-1',
    timestamp: '2026-10-06T06:00:04Z',
    metaData: { turnId: 'turn-101' }
  });
  reducer.flush();
  assert.equal(bubble.content, '今天北京的天气是晴天，气温约22℃。');

  // 7. 终结结算
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
});

test('2. 降噪与幂等: AI_MESSAGE 冗余包被安全丢弃，COMPLETE_TEXT 正确对齐', () => {
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
    content: 'Hello, ',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:01Z'
  });
  reducer.consume({
    type: 'PARTIAL_TEXT',
    content: 'world!',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:02Z'
  });
  reducer.flush();
  assert.equal(bubble.content, 'Hello, world!');

  // COMPLETE_TEXT 对齐
  reducer.consume({
    type: 'COMPLETE_TEXT',
    content: 'Hello, world! (aligned)',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:03Z'
  });
  assert.equal(bubble.content, 'Hello, world! (aligned)');

  // AI_MESSAGE 噪声：内容不应被重复覆盖或篡改
  reducer.consume({
    type: 'AI_MESSAGE',
    text: 'NOISE CONTENT THAT SHOULD BE IGNORED',
    executionId: 'exec-2',
    timestamp: '2026-10-06T06:00:04Z'
  });
  assert.equal(bubble.content, 'Hello, world! (aligned)');
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
  assert.equal(rootBubble.toolCalls?.[0].toolName, AgentToolName.CallSubAgent);
  assert.equal(rootBubble.toolCalls?.[0].status, 'calling');

  // 2. 子会话事件流入（metaData.sessionId = 'sub-agent-1'）
  router.dispatch({
    type: 'EXECUTION_STARTED',
    executionId: 'exec-sub-1',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-sub-1', sessionId: 'sub-agent-1', rootSessionId: 'root-session' }
  });
  router.dispatch({
    type: 'PARTIAL_TEXT',
    content: '开始审查 PR #12：第 34 行存在空指针隐患。',
    executionId: 'exec-sub-1',
    timestamp: '2026-10-06T06:00:03Z',
    metaData: { turnId: 'turn-sub-1', sessionId: 'sub-agent-1', rootSessionId: 'root-session' }
  });
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

  // 验证主会话中的委派工具状态自动同步为 success
  assert.equal(rootBubble.toolCalls?.[0].status, 'success');
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
    type: 'PARTIAL_TEXT',
    content: '动态专家报告生成完毕',
    executionId: 'exec-dynamic-1',
    timestamp: '2026-10-06T06:00:01Z',
    metaData: { turnId: 'turn-dyn-1', sessionId: 'sub-999', rootSessionId: 'root-dynamic' }
  });
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

  // 2. 工具调用需要审批 (PROMISE)
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
  assert.equal(bubble.toolCalls?.[0].status, 'pending'); // 标记为等待决策

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

  // 5. 工具执行完成并继续输出正文
  reducer.consume({
    type: 'TOOL_COMPLETED',
    toolName: AgentToolName.ExecuteCommand,
    requestId: 'cmd-delete-1',
    output: 'Removed 120 files.',
    resultStatus: 'COMPLETED',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:11Z',
    metaData: { turnId: 'turn-hil-1' }
  });
  reducer.consume({
    type: 'PARTIAL_TEXT',
    content: '临时构建文件已成功清理完毕。',
    executionId: 'exec-hil',
    timestamp: '2026-10-06T06:00:12Z',
    metaData: { turnId: 'turn-hil-1' }
  });
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

test('6. 帧缓冲器(StreamFrameBuffer): 高频文本片段在同一批次中合并', () => {
  let flushedText = '';
  const buffer = new StreamFrameBuffer((textBatch) => {
    flushedText += textBatch.get('b-1') || '';
  });

  buffer.pushText('b-1', 'A');
  buffer.pushText('b-1', 'B');
  buffer.pushText('b-1', 'C');

  // 立即刷新
  buffer.flushImmediate();
  assert.equal(flushedText, 'ABC');
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

  // 3. 接下来服务端推送正文
  router.dispatch({
    type: 'PARTIAL_TEXT',
    content: '你发送的是「1」，请问有什么可以帮您？',
    executionId: '2107364703104794624',
    timestamp: '2026-10-06T06:57:57.000Z',
    metaData: {
      sessionId: '2107364703088017408',
      rootSessionId: '2107364703088017408',
      turnId: '2107364703113183232'
    }
  });
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

  // 正文增量到达
  reducer.consume({
    type: 'PARTIAL_TEXT',
    content: '测试前置更新成功',
    executionId: 'exec-pre',
    timestamp: '2026-10-06T06:00:02Z',
    metaData: { turnId: 'turn-pre-1' }
  });
  reducer.flush();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '测试前置更新成功');
});
