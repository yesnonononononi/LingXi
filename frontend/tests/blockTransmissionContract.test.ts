/**
 * 真实传输链路的端到端回归（F01/F02/F04/F05 守卫）。
 *
 * <p><b>为什么必须单列一个文件</b>：`blockEventWiring.test.ts` 直接构造带 {@code type}
 * 的 {@code AgentEvent} 喂给 reducer —— 它验证的是「reducer 收到合法事件后的行为」，
 * 而**真实链路上事件根本没有 {@code type}**（后端 {@code BlockEventPayload} 不含该字段），
 * 判别式只在 SSE 的 {@code event:} 行。既有测试因此绕过了整条传输断点。</p>
 *
 * <p>本文件用**从真实后端抓取的帧体**（见 {@code target/block-completion-audit/}）走
 * {@code parseSseBlock → toAgentEvent → StreamSessionRouter.dispatch → TurnStreamReducer}，
 * 覆盖：事件体自述类型、状态取值、版本号字符串比较、块视图会话归属。任一环节回退即变红。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSession, ChatMessage } from '../src/types/chat';
import type { Block, TurnViewVO } from '../src/types/block';
import { parseSseBlock } from '../src/services/sse';
import { toAgentEvent } from '../src/views/chat/agentEventNarrowing';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';

/** 真实帧体的形状（取自后端实际序列化，注意 viewVersion 是**字符串**、无 type 字段）。 */
function realSnapshotFrame(opts: {
  sessionId: string;
  turnId: string;
  viewVersion: number;
  status?: string;
  blocks: Block[];
}): string {
  return JSON.stringify({
    sessionId: opts.sessionId,
    turnId: opts.turnId,
    viewVersion: String(opts.viewVersion),
    view: {
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      status: opts.status ?? 'RUNNING',
      viewVersion: String(opts.viewVersion),
      userMessage: '你好',
      blocks: opts.blocks,
    },
  });
}

const realThinking = (): Block => ({
  blockId: 'thinking:148580f1',
  type: 'THINKING',
  responseId: '148580f1',
  order: 1000,
  status: 'COMPLETE',
  text: '让我先看看目录',
});

const realToolDone = (): Block => ({
  blockId: 'tool:call_00_LaBfo',
  type: 'TOOL',
  responseId: null,
  order: 1002,
  status: 'COMPLETED',
  toolCallId: 'call_00_LaBfo',
  toolName: 'execute_command',
  arguments: '{"command":"ls"}',
  output: '{"outcome":"SUCCEEDED","output":"AGENTS.md","exitCode":0}',
});

const realToolFailed = (): Block => ({
  blockId: 'tool:call_00_ET_v4',
  type: 'TOOL',
  responseId: null,
  order: 2,
  status: 'FAILED',
  toolCallId: 'call_00_ET_v4',
  toolName: 'execute_command',
  output: '{"outcome":"FAILED","output":"Exiting code :255"}',
});

const realTextDone = (): Block => ({
  blockId: 'text:77515012',
  type: 'TEXT',
  responseId: '77515012',
  order: 2001,
  status: 'COMPLETE',
  text: '当前目录的前三个文件是…',
  placement: 'BODY',
});

/** 建一个绑定到根会话的路由 + 根消息数组。 */
function routerWithRoot(sessionId = '7'): { router: StreamSessionRouter; messages: ChatMessage[] } {
  const messages: ChatMessage[] = [];
  const session = { id: sessionId, messages, subSessions: [] } as unknown as ChatSession;
  const router = new StreamSessionRouter({});
  router.bindRootSession(session);
  return { router, messages };
}

/** 从原始 SSE 文本帧走完整收窄 → 分派。 */
function feedRawFrame(router: StreamSessionRouter, frame: string): void {
  const raw = parseSseBlock(frame);
  assert.ok(raw, 'SSE 块应解析成功');
  const event = toAgentEvent(raw);
  assert.ok(event && event.data, '收窄后应有事件体');
  router.dispatch(event.data);
}

test('F01 真实帧体（无 type 字段）经收窄后仍能进入 reducer 分支', () => {
  const raw = parseSseBlock(`event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
    sessionId: '7',
    turnId: '900',
    viewVersion: 3,
    blocks: [realThinking(), realToolDone()],
  })}`);
  assert.ok(raw);
  const event = toAgentEvent(raw);
  assert.ok(event && event.data, '收窄应产出事件体');
  // 核心断言：事件体必须自述类型，否则 reducer 的 switch 拿 undefined。
  assert.equal((event.data as { type?: string }).type, 'TURN_SNAPSHOT', '事件体必须带 type');
});

test('F01 未收窄的原始帧体确实没有 type（复现断点前提）', () => {
  const body = JSON.parse(
    realSnapshotFrame({ sessionId: '7', turnId: '900', viewVersion: 3, blocks: [realThinking()] })
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, 'type'),
    false,
    '真实帧体不含 type —— 这正是断点：只要收窄层不补，reducer 必然走 default'
  );
});

test('F01 真实链路：快照块必须落入气泡（端到端）', () => {
  const { router, messages } = routerWithRoot('7');
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '900',
      viewVersion: 3,
      blocks: [realThinking(), realToolDone(), realTextDone()],
    })}`
  );

  const bubble = messages.find(m => m.role === 'assistant');
  assert.ok(bubble, '必须产生助手气泡（未被 default 分支跳过）');
  assert.equal(bubble.thoughtSteps?.length, 1, '思考块落落点');
  assert.equal(bubble.toolCalls?.length, 1, '工具块落落点');
  assert.equal(bubble.content, '当前目录的前三个文件是…', '正文块写入气泡正文');
});

test('F02 后端状态 COMPLETE/COMPLETED 必须被正确解释（不是 DONE）', () => {
  const { router, messages } = routerWithRoot('7');
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '901',
      viewVersion: 2,
      blocks: [realThinking(), realToolDone(), realToolFailed()],
    })}`
  );

  const bubble = messages.find(m => m.role === 'assistant');
  assert.ok(bubble);
  // 思考块 COMPLETE → success（若前端只认 'DONE' 会判成 failed）
  assert.equal(bubble.thoughtSteps?.[0].status, 'success', 'COMPLETE 应解释为已完成');
  // 工具 COMPLETED → success（若只认 'DONE' 会落 default 被当成 calling）
  const done = bubble.toolCalls?.find(t => t.id === 'call_00_LaBfo');
  assert.equal(done?.status, 'success', 'COMPLETED 应解释为成功收尾');
  // 工具 FAILED → failed
  const failed = bubble.toolCalls?.find(t => t.id === 'call_00_ET_v4');
  assert.equal(failed?.status, 'failed', 'FAILED 应解释为失败');
});

test('F04 字符串版本号必须按数值比较（第 10 帧不被第 9 帧挡住）', () => {
  const { router, messages } = routerWithRoot('7');
  // 先到版本 9
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '902',
      viewVersion: 9,
      blocks: [realToolDone()],
    })}`
  );
  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.toolCalls?.length, 1);

  // 版本 10 必须被采纳。字典序比较下 "10" < "9" 为真 → 会被误丢弃并保持旧内容。
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '902',
      viewVersion: 10,
      status: 'COMPLETED',
      blocks: [realToolDone(), realTextDone()],
    })}`
  );
  assert.equal(bubble.content, '当前目录的前三个文件是…', '版本 10 的新正文必须落地');
});

test('F04 真正的旧帧（版本回退）仍必须被丢弃', () => {
  const { router, messages } = routerWithRoot('7');
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '903',
      viewVersion: 12,
      status: 'COMPLETED',
      blocks: [realToolDone(), realTextDone()],
    })}`
  );
  const bubble = messages.find(m => m.role === 'assistant')!;
  assert.equal(bubble.content, '当前目录的前三个文件是…');

  // 迟到旧帧版本 11：必须被丢弃，正文不能被清空
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '903',
      viewVersion: 11,
      blocks: [realThinking()],
    })}`
  );
  assert.equal(bubble.content, '当前目录的前三个文件是…', '旧帧不得覆盖新内容');
});

test('F05 块视图事件的归属取自顶层 sessionId（子会话不污染根）', () => {
  const { router, messages } = routerWithRoot('7');
  // 根会话的流承载了一条**归属子会话**的块快照
  const session = { id: '7', messages, subSessions: [{ id: '88', messages: [] }] } as unknown as ChatSession;
  router.bindRootSession(session);

  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '88',
      turnId: '910',
      viewVersion: 1,
      blocks: [realThinking()],
    })}`
  );

  assert.equal(messages.length, 0, '子会话的块不得写入根会话气泡');
  const subBubble = (session.subSessions![0].messages || []).find(m => m.role === 'assistant');
  assert.ok(subBubble, '子会话应收到自己的块视图');
  assert.equal(subBubble.thoughtSteps?.length, 1);
});

test('F05 根会话自己的块视图正常落入根消息数组', () => {
  const { router, messages } = routerWithRoot('7');
  feedRawFrame(
    router,
    `event: TURN_SNAPSHOT\ndata: ${realSnapshotFrame({
      sessionId: '7',
      turnId: '911',
      viewVersion: 1,
      blocks: [realThinking()],
    })}`
  );
  const bubble = messages.find(m => m.role === 'assistant');
  assert.ok(bubble, '根会话的块视图必须落入根消息数组');
});
