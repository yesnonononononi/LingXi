import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, nextTick } from 'vue';
import axios from 'axios';
import { AgentToolName } from '../src/utils/toolNames';
import type { AgentEvent } from '../src/types/Event';
import type { ChatMessage, ToolCallVO } from '../src/types/chat';

/**
 * 本次修复的回归守卫：
 * <ol>
 *   <li><b>缺陷 A</b>：后端 {@code PREPARING → PENDING} 晚于 SSE 挂起事件，前端只在 TOOL_CALL /
 *       EXECUTION_SUSPENDED 两处拉卡 → 卡片永远停在「准备中」。修复＝就绪有界重试。</li>
 *   <li><b>缺陷 B</b>：页面重载 / 切走后请求级流已断，审批恢复事件推给空桶被丢弃。修复＝挂会话级流。</li>
 * </ol>
 *
 * <p>注意：任何会拉起 {@code services/interceptor}（进而 {@code axios.create()}）的模块都必须
 * 动态 import —— 实例在创建时快照 {@code axios.defaults.adapter}，必须先装好桩再创建实例。</p>
 */

// ---- 环境桩（与 chatLiveRenderFixes.test.ts 同口径） ----
const raf = (fn: () => void) => { void fn; return 1; };
(globalThis as any).window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: raf,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as any).requestAnimationFrame = raf;
(globalThis as any).cancelAnimationFrame = () => {};
const localStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (localStore.has(k) ? localStore.get(k)! : null),
  setItem: (k: string, v: string) => { localStore.set(k, String(v)); },
  removeItem: (k: string) => { localStore.delete(k); },
};

const SID = '2107364703088017408';
const ROOT_TID = '2107364703113183232';

// 必须在任何拉起 interceptor 的模块被 import 之前装好（axios 实例会快照 adapter）
const okEnvelope = (data: unknown) => ({ data: { code: 1, data, errMsg: null }, status: 200, statusText: 'OK', headers: {}, config: {} });
// tree 下发的权威 runStatus：axios 实例在创建时快照 adapter，运行期只能靠这个可变开关切换
let treeRunStatus = 'SUSPENDED';
axios.defaults.adapter = (async (config: any) => {
  const url = String(config.url || '');
  if (url.includes('/tree')) return okEnvelope({ rootSessionId: SID, sessions: [{ id: SID, name: '会话', runStatus: treeRunStatus, lastOutcome: null, createTime: null, updateTime: null, workspaceId: null }] });
  if (url.includes('/messages')) return okEnvelope({ records: [], turns: {}, nextCursor: null, hasMore: false });
  return okEnvelope({ records: [], total: 0 });
}) as any;

const tick = () => new Promise<void>(r => setImmediate(r));
const flushAsync = () => new Promise<void>(r => setTimeout(r, 0));
const frame = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
const encode = (text: string) => new TextEncoder().encode(text);

/** 手动调度器：捕获 reducer / 流管理器安排的重试，由测试同步驱动（不依赖真实定时器）。 */
function makeManualScheduler() {
  const handlers = new Map<number, () => void>();
  let seq = 0;
  return {
    schedule: (handler: () => void) => { seq += 1; handlers.set(seq, handler); return seq; },
    cancel: (timerId: number) => { handlers.delete(timerId); },
    get size(): number { return handlers.size; },
    runNext: () => {
      const first = handlers.entries().next();
      if (first.done) return;
      handlers.delete(first.value[0]);
      first.value[1]();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 缺陷 A                                                              */
/* ------------------------------------------------------------------ */

test('A. 挂起后卡片未就绪（PREPARING）→ 有界重试直到权威 pending=true', async () => {
  const { TurnStreamReducer } = await import('../src/views/chat/turnStreamReducer');
  const messages: ChatMessage[] = [];
  const scheduler = makeManualScheduler();
  let callCount = 0;

  const reducer = new TurnStreamReducer(messages, {
    sessionId: 'sess-a',
    onResolveCard: async (toolCallId) => {
      callCount += 1;
      // 前两次仍是后端 PREPARING（尚未 markReady）；第三次才就绪
      if (callCount < 3) {
        return {
          id: toolCallId, type: 'PROMISE', status: 'preparing', pending: false,
          content: { kind: 'PLAN', title: '方案', text: '# 正文' }
        } as ToolCallVO;
      }
      return {
        id: toolCallId, type: 'PROMISE', status: 'pending', pending: true,
        content: { kind: 'PLAN', title: '方案', text: '# 正文' },
        allowedActions: ['APPROVE', 'REJECT']
      } as ToolCallVO;
    },
    scheduleCardRetry: scheduler.schedule,
    cancelCardRetry: scheduler.cancel
  });

  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' } });
  reducer.consume({
    type: 'TOOL_CALL', toolName: AgentToolName.CreatePlan, requestId: 'call-plan-1',
    args: '{"title":"方案"}', resultStatus: 'STARTED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' }
  });
  reducer.consume({ type: 'EXECUTION_SUSPENDED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' } });
  await flushAsync();

  // ★ 未就绪必须安排重试；若去掉重试逻辑（回退修复），此处恒为 0 → 测试变红
  assert.ok(scheduler.size >= 1, '卡片未就绪时必须安排重试，否则卡片永远停在「准备中」');

  scheduler.runNext();
  await flushAsync();
  assert.ok(scheduler.size >= 1, '第二次仍 PREPARING，应继续重试');

  scheduler.runNext();
  await flushAsync();

  const bubble = messages[0];
  assert.ok(bubble.promptCards && bubble.promptCards.length === 1, '最终应建出（且只建出一张）卡片');
  assert.equal(bubble.promptCards![0].pending, true, '就绪后卡片必须为权威 pending=true');
  assert.equal(scheduler.size, 0, '就绪后必须停止重试');
});

test('A2. 执行终结时取消未决重试，不再空转', async () => {
  const { TurnStreamReducer } = await import('../src/views/chat/turnStreamReducer');
  const messages: ChatMessage[] = [];
  const scheduler = makeManualScheduler();
  const reducer = new TurnStreamReducer(messages, {
    sessionId: 'sess-a2',
    onResolveCard: async (toolCallId) => ({
      id: toolCallId, type: 'PROMISE', status: 'preparing', pending: false,
      content: { kind: 'PLAN', text: 'x' }
    } as ToolCallVO),
    scheduleCardRetry: scheduler.schedule,
    cancelCardRetry: scheduler.cancel
  });

  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' } });
  reducer.consume({
    type: 'TOOL_CALL', toolName: AgentToolName.CreatePlan, requestId: 'c1', args: '{}',
    resultStatus: 'STARTED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' }
  });
  reducer.consume({ type: 'EXECUTION_SUSPENDED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' } });
  await flushAsync();
  assert.ok(scheduler.size >= 1, '未就绪应先安排重试');

  reducer.consume({ type: 'EXECUTION_COMPLETED', executionId: 'e1', timestamp: 't', metaData: { turnId: 't1' } });
  assert.equal(scheduler.size, 0, '执行终结必须取消全部未决重试');
});

/* ------------------------------------------------------------------ */
/* 缺陷 B                                                              */
/* ------------------------------------------------------------------ */

test('B-unit. 会话级流：挂上后把业务事件派发给出口；READY 在传输层被消费', async () => {
  const { SessionEventStream } = await import('../src/views/chat/sessionEventStream');
  const holder: { ctl: ReadableStreamDefaultController<Uint8Array> | null } = { ctl: null };
  let fetchCount = 0;
  (globalThis as any).fetch = async (url: string) => {
    fetchCount += 1;
    assert.ok(String(url).includes('/events'), `会话级流端点应为 GET /events，实际=${url}`);
    const body = new ReadableStream<Uint8Array>({ start(c) { holder.ctl = c; } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const events: AgentEvent[] = [];
  let closedCount = 0;
  const stream = new SessionEventStream({
    onEvent: (event) => events.push(event),
    onConnectionClosed: () => { closedCount += 1; },
  });

  stream.acquire(SID);
  for (let i = 0; i < 30 && !holder.ctl; i++) await tick();
  assert.ok(holder.ctl, '应已建立会话级事件流');
  assert.equal(stream.isConnected(), true);
  assert.equal(fetchCount, 1);

  // READY 是传输层信号，不是 AgentEvent：必须在传输层拦下，绝不能流进 dispatch
  holder.ctl!.enqueue(encode(frame('READY', { rootSessionId: SID })));
  await tick(); await tick();
  assert.equal(events.length, 0, 'READY 不得当作业务事件派发（会被 Router 当业务事件处理）');
  assert.equal(stream.isReady(SID), true, '收到 READY 后才算就绪');

  holder.ctl!.enqueue(encode(frame('EXECUTION_RESUME', {
    type: 'EXECUTION_RESUME', executionId: 'e1', timestamp: 't',
    metaData: { sessionId: SID, rootSessionId: SID, turnId: 't1' }
  })));
  await tick(); await tick();

  assert.equal(events.length, 1, '会话级事件应派发到出口');
  assert.equal(events[0].type, 'EXECUTION_RESUME');

  // HEARTBEAT 同样在传输层消费，只刷新健康时间戳
  holder.ctl!.enqueue(encode(frame('HEARTBEAT', { timestamp: 1 })));
  await tick(); await tick();
  assert.equal(events.length, 1, 'HEARTBEAT 不得当作业务事件派发');

  stream.close();
  assert.equal(stream.isConnected(), false);
  assert.equal(closedCount, 0, '主动关闭不应触发「连接结束」回调（不重挂、不回读）');
});

test('B-wiring. 打开会话 → useChatView 自动订阅会话级事件流（流跟页面走，不再只挂起时订阅）', async () => {
  setActivePinia(createPinia());
  const fetchCalls: string[] = [];
  let eventsCtl: ReadableStreamDefaultController<Uint8Array> | null = null;

  (globalThis as any).fetch = async (url: string) => {
    fetchCalls.push(String(url));
    if (String(url).includes('/events')) {
      const body = new ReadableStream<Uint8Array>({ start(c) { eventsCtl = c; } });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  };

  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');
  let view: any;
  scope.run(() => { view = useChatView(); });
  await nextTick();

  assert.equal(fetchCalls.filter(u => u.includes('/events')).length, 0, '无会话不得订阅会话级流');

  // 打开一个已落库会话：发送不再自带流，会话级流是唯一实时通道，必须自动订阅
  view.localSessions.value = [{
    id: SID, title: '会话', messages: [], runStatus: 'IDLE', lastOutcome: null,
    activeTools: [], modelId: '', createdAt: 0, updatedAt: 0
  }];
  view.localActiveId.value = SID;

  for (let i = 0; i < 40 && !fetchCalls.some(u => u.includes('/events')); i++) await tick();

  assert.ok(
    fetchCalls.some(u => u.includes('/events')),
    `进入会话必须自动订阅会话级流，实际 fetch=${JSON.stringify(fetchCalls)}`
  );

  eventsCtl?.close();
  scope.stop();
});

test('B2. 受理被拒 → 回读权威状态纠正 runStatus，不得卡在生成中；给出可见失败提示', async () => {
  setActivePinia(createPinia());
  const holders: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  // 受理被拒前服务端还是 IDLE（乐观窗口），被拒后才权威地变成 SUSPENDED
  treeRunStatus = 'IDLE';
  (globalThis as any).fetch = async (url: string) => {
    const text = String(url);
    if (text.includes('/completion/commands')) {
      treeRunStatus = 'SUSPENDED';
      return new Response(JSON.stringify({ code: 0, data: null, errMsg: '该会话正在执行中，请等待本轮结束或先停止' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    // 会话级 /events：握手后立即发 READY（真实协议如此），随后保持打开
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        holders.push(c);
        c.enqueue(encode(frame('READY', { rootSessionId: SID })));
      }
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');
  let view: any;
  scope.run(() => { view = useChatView(); });
  await nextTick();

  view.localSessions.value = [{
    id: SID, title: '会话', messages: [], runStatus: 'IDLE', lastOutcome: null,
    activeTools: [], modelId: '', createdAt: 0, updatedAt: 0
  }];
  view.localActiveId.value = SID;
  for (let i = 0; i < 10 && view.streamHealthState.value !== 'READY'; i++) await tick();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(view.currentActiveSession.value?.runStatus, 'IDLE', '受理前本地按 IDLE，允许发送');

  await view.handleSendMessage('再发一条', false);
  for (let i = 0; i < 80; i++) await tick();

  // ★ 关键：受理失败后必须按权威状态纠正。若不纠正，界面会永远显示「生成中」，
  //   用户再也发不出下一条（后端仍在执行，本地却说空闲）。
  assert.equal(
    view.currentActiveSession.value?.runStatus, 'SUSPENDED',
    '受理失败后必须回读权威状态，不得留下乐观 RUNNING'
  );
  assert.ok(view.sendFailureNotice.value, '受理失败应给出可见提示（提示链路要通）');
  assert.equal(view.isSubmitting.value, false, '受理窗口结束后必须解除提交中（否则永远禁重复点击）');
  holders.forEach(c => { try { c.close(); } catch { /* 已关闭 */ } });
  scope.stop();
});
