import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { ref, computed, effectScope } from 'vue';
import axios from 'axios';
import { SessionEventStream } from '../src/views/chat/sessionEventStream';
import { useChatSending } from '../src/views/chat/useChatSending';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { mergeMessagesByTurn } from '../src/utils/session';
import type { ChatMessage, ChatSession } from '../src/types/chat';

/**
 * 「单一会话级流」形态的回归守卫。
 *
 * <p>覆盖本期三个易错点，每条都必须能因缺陷变红：</p>
 * <ol>
 *   <li><b>连接共享</b>：同一根会话只开一条连接；一个使用者卸载不 abort，最后一个才 abort。</li>
 *   <li><b>就绪握手</b>：READY 到达前 waitUntilReady 不 resolve；到达后 resolve。</li>
 *   <li><b>健康与失败</b>：心跳超时判定不健康并重挂；重试耗尽暴露「连接失败」，reconnect() 可恢复。</li>
 *   <li><b>生成态</b>：isSubmitting 在受理 POST 未返回期间为 true（禁重复点击），返回后为 false。</li>
 *   <li><b>历史合并</b>：活跃轮正文不被历史覆盖；已终结轮被权威历史替换；不产生重复气泡。</li>
 *   <li><b>版本控制</b>：切换会话前发起的旧回查响应必须被丢弃。</li>
 * </ol>
 */

// ---- 环境桩 ----
const raf = (fn: () => void) => { void fn; return 1; };
(globalThis as any).window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: raf,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
  removeEventListener: () => {},
  alert: () => {},
};
(globalThis as any).requestAnimationFrame = raf;
(globalThis as any).cancelAnimationFrame = () => {};
const ls = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => { ls.set(k, String(v)); },
  removeItem: (k: string) => { ls.delete(k); },
};

const ROOT = '2107364703088017408';
const SUB = '2107364703088017409';
const T1 = '2107364703113183232';
const T2 = '2107364703113183999';

const okEnvelope = (data: unknown) => ({
  data: { code: 1, data, errMsg: null }, status: 200, statusText: 'OK', headers: {}, config: {},
});
axios.defaults.adapter = (async (config: any) => {
  const url = String(config.url || '');
  if (url.includes('/tree')) {
    return okEnvelope({ rootSessionId: ROOT, sessions: [{ id: ROOT, name: '会话', runStatus: 'IDLE', lastOutcome: null, createTime: null, updateTime: null, workspaceId: null }] });
  }
  if (url.includes('/messages')) return okEnvelope({ records: [], turns: {}, nextCursor: null, hasMore: false });
  return okEnvelope({ records: [], total: 0 });
}) as any;

const tick = () => new Promise<void>(r => setImmediate(r));
const frame = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
const encode = (text: string) => new TextEncoder().encode(text);

/** 手动调度器：捕获重挂 / 心跳探测定时器，由测试同步驱动（不依赖真实时间）。 */
function makeManualScheduler() {
  const handlers = new Map<number, { fn: () => void; delayMs: number }>();
  let seq = 0;
  return {
    schedule: (fn: () => void, delayMs: number) => { seq += 1; handlers.set(seq, { fn, delayMs }); return seq; },
    cancel: (timerId: number) => { handlers.delete(timerId); },
    get size(): number { return handlers.size; },
    /** 按延迟从小到大取出第一个（心跳探测 60s > 重挂 1s，重挂应先跑）。 */
    takeByDelay: (delayMs: number) => {
      for (const [id, item] of handlers) {
        if (item.delayMs === delayMs) { handlers.delete(id); item.fn(); return true; }
      }
      return false;
    },
    runAll: () => {
      const items = Array.from(handlers.entries()).sort((a, b) => a[1].delayMs - b[1].delayMs);
      handlers.clear();
      items.forEach(([, item]) => item.fn());
    },
  };
}

/** 可控 SSE 端点：记录每次建流，按需推送帧。 */
function installEventEndpoint() {
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  let fetchCount = 0;
  (globalThis as any).fetch = async (url: string) => {
    if (!String(url).includes('/events')) {
      return new Response(JSON.stringify({ code: 0, data: null, errMsg: '未打桩' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    fetchCount += 1;
    const body = new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return {
    get fetchCount() { return fetchCount; },
    get controller() { return controllers[controllers.length - 1] ?? null; },
    send(event: string, data: unknown): void {
      const ctl = controllers[controllers.length - 1];
      ctl?.enqueue(encode(frame(event, data)));
    },
    closeAll(): void {
      controllers.forEach(c => { try { c.close(); } catch { /* 已关闭 */ } });
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. 连接共享与引用计数                                               */
/* ------------------------------------------------------------------ */

test('1. 两个使用者共享同一条根会话连接：一个卸载不 abort，最后一个卸载才 abort', async () => {
  const endpoint = installEventEndpoint();
  const scheduler = makeManualScheduler();
  const events: string[] = [];
  const stream = new SessionEventStream({
    onEvent: (e) => events.push(e.type),
    onConnectionClosed: () => {},
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
  });

  // 使用者 A：主视图；使用者 B：子会话抽屉。两者看的根会话相同。
  stream.acquire(ROOT);
  for (let i = 0; i < 30 && !endpoint.controller; i++) await tick();
  assert.equal(endpoint.fetchCount, 1, '第一个使用者应建流');

  stream.acquire(ROOT);
  for (let i = 0; i < 10; i++) await tick();
  // ★ 同根第二个使用者必须复用同一条连接：再建一条会让同一事件双投、正文增量双写
  assert.equal(endpoint.fetchCount, 1, '同一根会话的第二个使用者必须复用连接，不得再开一条');
  assert.equal(stream.resolveRefCount(ROOT), 2, '引用计数应为 2');

  stream.release(ROOT);
  for (let i = 0; i < 10; i++) await tick();
  // ★ 一个使用者卸载不得 abort：另一个还在看同一条流
  assert.equal(stream.isConnected(), true, '一个使用者卸载不得 abort（另一个还在看）');
  assert.equal(stream.resolveRefCount(ROOT), 1);

  stream.release(ROOT);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(stream.isConnected(), false, '最后一个使用者卸载才 abort');
  assert.equal(stream.resolveRefCount(ROOT), 0);
});

test('1b. ★ 子会话场景：订阅键必须是 rootSessionId（子会话 id ≠ 根 id）', async () => {
  setActivePinia(createPinia());
  const eventUrls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    const text = String(url);
    if (text.includes('/events')) {
      eventUrls.push(text);
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encode(frame('READY', { rootSessionId: ROOT }))); },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    // 受理成功
    return new Response(JSON.stringify({ code: 1, data: { sessionId: SUB, turnId: T1 }, errMsg: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');
  let view: any;
  scope.run(() => { view = useChatView(); });
  await tick();

  assert.notEqual(SUB, ROOT, '本用例的前提：子会话 id 与根 id 不同');
  // 当前看的会话是子会话：自身 id = SUB，根在 rootSessionId 上
  view.localSessions.value = [{
    id: SUB, rootSessionId: ROOT, title: '子会话', messages: [], createdAt: 0, updatedAt: 0,
    modelId: '', activeTools: [], runStatus: 'IDLE',
  }];
  view.localActiveId.value = SUB;
  for (let i = 0; i < 20 && eventUrls.length < 1; i++) await tick();

  // ★ 走真实的 ensureSubscribed（不是测试里复刻一份逻辑）：
  //   若根键解析被去掉，这里会请求 /a/completion/{SUB}/events
  assert.ok(eventUrls.length > 0, '看子会话时应订阅会话级流');
  assert.ok(
    eventUrls.every(url => url.includes(`/${ROOT}/events`)),
    `订阅键必须是 rootSessionId（子会话 id ≠ 根 id），实际请求=${JSON.stringify(eventUrls)}`,
  );
  assert.ok(
    !eventUrls.some(url => url.includes(`/${SUB}/events`)),
    `绝不能按子会话 id 建键（会与主视图的根连接投到同一桶 → 事件双投），实际=${JSON.stringify(eventUrls)}`,
  );

  // 发送时同样必须解析到根（受理走子会话 id，订阅走根 id）
  await view.handleSendMessage('你好', false, null, null, null);
  for (let i = 0; i < 30; i++) await tick();
  assert.ok(
    eventUrls.every(url => url.includes(`/${ROOT}/events`)),
    `发送前的就绪等待也必须用根键，实际请求=${JSON.stringify(eventUrls)}`,
  );

  scope.stop();
});

test('1c. ★ 根会话场景：rootSessionId 为 "0" 时订阅键必须是会话自身 id（绝不能是 /0/events）', async () => {
  setActivePinia(createPinia());
  const eventUrls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    const text = String(url);
    if (text.includes('/events')) {
      eventUrls.push(text);
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encode(frame('READY', { rootSessionId: ROOT }))); },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    // 受理成功
    return new Response(JSON.stringify({ code: 1, data: { sessionId: ROOT, turnId: T1 }, errMsg: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');
  let view: any;
  scope.run(() => { view = useChatView(); });
  await tick();

  // 根会话：后端 SessionVO.rootSessionId 经 ToStringSerializer 下发为字符串 "0"，表示「自身即根」。
  // 若把 "0" 当连接键，会请求 /a/completion/0/events → 后端 resolveRootSessionId(0) 抛
  // IllegalStateException("Unknown session: 0") → HTTP 500「系统繁忙，请稍后再试」。
  view.localSessions.value = [{
    id: ROOT, rootSessionId: '0', title: '根会话', messages: [], createdAt: 0, updatedAt: 0,
    modelId: '', activeTools: [], runStatus: 'IDLE',
  }];
  view.localActiveId.value = ROOT;
  for (let i = 0; i < 20 && eventUrls.length < 1; i++) await tick();

  // ★ 订阅键必须是会话自身 id（进入会话的 watch 路径）
  assert.ok(eventUrls.length > 0, '进入根会话时应订阅会话级流');
  assert.ok(
    eventUrls.every(url => url.includes(`/${ROOT}/events`)),
    `根会话（rootSessionId="0"）的订阅键必须是自身 id，实际请求=${JSON.stringify(eventUrls)}`,
  );
  assert.ok(
    !eventUrls.some(url => url.includes('/0/events')),
    `绝不能把 rootSessionId=0 当连接键（后端 Unknown session: 0 → HTTP 500），实际=${JSON.stringify(eventUrls)}`,
  );

  // ★ 发送前的就绪等待（ensureSubscribed 路径）同样必须解析到会话自身 id
  await view.handleSendMessage('你好', false, null, null, null);
  for (let i = 0; i < 30; i++) await tick();
  assert.ok(
    eventUrls.every(url => url.includes(`/${ROOT}/events`)),
    `发送前的就绪等待也必须用会话自身 id，实际请求=${JSON.stringify(eventUrls)}`,
  );
  assert.ok(
    !eventUrls.some(url => url.includes('/0/events')),
    `发送链路绝不能请求 /0/events，实际=${JSON.stringify(eventUrls)}`,
  );

  scope.stop();
});

/* ------------------------------------------------------------------ */
/* 2. 就绪握手                                                         */
/* ------------------------------------------------------------------ */

test('2. READY 到达前 waitUntilReady 不 resolve；到达后 resolve', async () => {
  const endpoint = installEventEndpoint();
  const scheduler = makeManualScheduler();
  const stream = new SessionEventStream({
    onEvent: () => {},
    onConnectionClosed: () => {},
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
  });

  stream.acquire(ROOT);
  for (let i = 0; i < 30 && !endpoint.controller; i++) await tick();

  let resolved: boolean | null = null;
  const waiting = stream.waitUntilReady(60_000).then(v => { resolved = v; return v; });

  // READY 之前：不得 resolve（否则会在「emitter 尚未入桶」时提交发送，首批事件被丢弃）
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(resolved, null, 'READY 到达前 waitUntilReady 不得 resolve');
  assert.equal(stream.isReady(), false);

  endpoint.send('READY', { rootSessionId: ROOT });

  // ★ READY 到达后必须 resolve（轮询等待真实 resolve，不靠固定 tick 数）
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await tick(); ready = resolved === true; }
  assert.equal(ready, true, 'READY 到达后必须 resolve');
  assert.equal(await waiting, true);
  assert.equal(stream.isReady(), true);

  // 已就绪后再调：立即 resolve
  assert.equal(await stream.waitUntilReady(60_000), true, '已就绪时应立即 resolve');
  stream.close();
});

/* ------------------------------------------------------------------ */
/* 3. 心跳健康与重试耗尽                                               */
/* ------------------------------------------------------------------ */

test('3. 心跳超时判定为不健康 → 触发重挂', async () => {
  const endpoint = installEventEndpoint();
  const scheduler = makeManualScheduler();
  let closedCount = 0;
  let clock = 1_000;
  const stream = new SessionEventStream({
    onEvent: () => {},
    onConnectionClosed: () => { closedCount += 1; },
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
    heartbeatTimeoutMs: 60_000,
    now: () => clock,
  });

  stream.acquire(ROOT);
  for (let i = 0; i < 30 && !endpoint.controller; i++) await tick();
  endpoint.send('READY', { rootSessionId: ROOT });
  for (let i = 0; i < 20 && !stream.isReady(); i++) await tick();
  assert.equal(stream.getHealthState(), 'READY');
  const fetchBefore = endpoint.fetchCount;

  // 时间推进但一帧未收：心跳探测应判定不健康并重挂
  clock += 61_000;
  assert.equal(scheduler.takeByDelay(60_000), true, '应安排过心跳探测定时器');
  // 不健康判定走「连接结束」收口：先回读权威状态，再安排重挂
  let reconnected = false;
  for (let i = 0; i < 40 && !reconnected; i++) {
    await tick();
    if (scheduler.takeByDelay(1_000)) reconnected = true;
  }
  assert.ok(reconnected, '心跳超时必须触发重挂（重连）');
  for (let i = 0; i < 40 && endpoint.fetchCount === fetchBefore; i++) await tick();
  assert.ok(endpoint.fetchCount > fetchBefore, '重挂必须真的重新发起 /events 请求');
  assert.ok(closedCount >= 1, '不健康判定走的是「连接结束」收口，必须回读权威状态');

  // 新连接重新握手后恢复健康
  endpoint.send('READY', { rootSessionId: ROOT });
  for (let i = 0; i < 20 && !stream.isReady(); i++) await tick();
  assert.equal(stream.getHealthState(), 'READY', '重连握手后应恢复健康');
  stream.close();
});

test('3b. 重试耗尽 → 暴露「连接失败」，reconnect() 可恢复', async () => {
  const endpoint = installEventEndpoint();
  const scheduler = makeManualScheduler();
  const states: string[] = [];
  const stream = new SessionEventStream({
    onEvent: () => {},
    onConnectionClosed: () => {},
    onHealthChange: (_root, state) => states.push(state),
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
  });

  stream.acquire(ROOT);
  for (let i = 0; i < 30 && !endpoint.controller; i++) await tick();

  // 反复掉线 6 次（上限 5 次重挂），每次都推进重挂定时器
  for (let round = 0; round < 8; round++) {
    endpoint.closeAll();
    for (let i = 0; i < 10; i++) await tick();
    // 只推进「重挂」定时器（1s），不动心跳探测
    scheduler.takeByDelay(1_000);
    for (let i = 0; i < 10; i++) await tick();
  }

  // ★ 重试耗尽不得静默：必须暴露「连接失败」供界面呈现
  assert.equal(stream.getHealthState(), 'FAILED', `重试耗尽后必须暴露连接失败，实际=${stream.getHealthState()}`);
  assert.ok(states.includes('FAILED'), '必须通过 onHealthChange 通知界面（供显式呈现与重挂入口）');

  // reconnect() 必须能恢复（引用计数保持不变）
  const fetchBefore = endpoint.fetchCount;
  stream.reconnect();
  for (let i = 0; i < 30 && endpoint.fetchCount === fetchBefore; i++) await tick();
  assert.ok(endpoint.fetchCount > fetchBefore, 'reconnect() 必须真的重开连接');
  endpoint.send('READY', { rootSessionId: ROOT });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(stream.getHealthState(), 'READY', 'reconnect() 后握手成功应恢复 READY');
  assert.equal(stream.resolveRefCount(ROOT), 1, 'reconnect 不得破坏引用计数');
  stream.close();
});

/* ------------------------------------------------------------------ */
/* 4. 生成态：isSubmitting 独立于「生成中」                              */
/* ------------------------------------------------------------------ */

test('4. isSubmitting 在受理 POST 未返回期间为 true（禁重复点击），resolve 后为 false', async () => {
  setActivePinia(createPinia());
  const endpoint = installEventEndpoint();

  let releasePost: ((value: unknown) => void) | null = null;
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/completion/commands')) {
      // 受理请求挂起，由测试手动 resolve —— 精确观察「POST 在途」窗口
      return new Promise<Response>(resolve => {
        releasePost = () => resolve(new Response(
          JSON.stringify({ code: 1, data: { sessionId: ROOT, turnId: T1 }, errMsg: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encode(frame('READY', { rootSessionId: ROOT }))); },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const session = ref<ChatSession>({
    id: ROOT, title: '会话', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [],
    messages: [], runStatus: 'IDLE',
  });
  let streamReady = true;
  const sending = useChatSending({
    currentActiveSession: computed(() => session.value),
    ensureSubscribed: async () => streamReady,
    reconnectStream: () => {},
    reconcileSessionAfterStream: async () => {},
    scrollToBottom: () => {},
  });

  const command = { input: '你好', sessionId: ROOT, workDir: '', modelId: 1, workspaceId: 1, agentId: 1, requirePlan: false };

  const pending = sending.handleSendMessage(command);
  for (let i = 0; i < 20; i++) await tick();

  // ★ POST 未返回期间：isSubmitting 必须为 true，否则用户连点会重复提交
  assert.equal(sending.isSubmitting.value, true, '受理 POST 在途时必须禁重复点击');
  assert.equal(
    await sending.handleSendMessage(command), null,
    'POST 在途期间重复发送必须被拒绝（不得二次提交）',
  );

  (releasePost as unknown as (v: unknown) => void)(null);
  const acceptance = await pending;

  // ★ POST 返回后：isSubmitting 必须回落，且拿到权威 sessionId / turnId
  assert.equal(sending.isSubmitting.value, false, '受理返回后必须解除提交中');
  assert.deepEqual(acceptance, { sessionId: ROOT, turnId: T1 }, '必须用回执里的权威 id');
  assert.equal(session.value.runStatus, 'RUNNING', '受理成功后应进入运行中');
  assert.equal(sending.isSending.value, true, '受理返回后仍应显示生成中（不能只看 POST）');
});

test('4b. 订阅不就绪时先重挂再重试；仍不就绪则显式失败（不得静默发出）', async () => {
  setActivePinia(createPinia());
  let ensureCalls = 0;
  let reconnectCalls = 0;
  let postCalls = 0;
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/completion/commands')) {
      postCalls += 1;
      return new Response(JSON.stringify({ code: 1, data: { sessionId: ROOT, turnId: T1 }, errMsg: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  };

  const session = ref<ChatSession>({
    id: ROOT, title: '会话', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [],
    messages: [], runStatus: 'IDLE',
  });
  const sending = useChatSending({
    currentActiveSession: computed(() => session.value),
    ensureSubscribed: async () => { ensureCalls += 1; return false; },
    reconnectStream: () => { reconnectCalls += 1; },
    reconcileSessionAfterStream: async () => {},
    scrollToBottom: () => {},
  });

  const result = await sending.handleSendMessage({ input: '你好', sessionId: ROOT, workDir: '', modelId: 1, workspaceId: 1, agentId: 1, requirePlan: false });

  assert.equal(result, null, '订阅不就绪时不得视为发送成功');
  assert.equal(ensureCalls, 2, '第一次不就绪必须重挂后再试一次');
  assert.equal(reconnectCalls, 1, '必须显式重挂后再重试');
  assert.equal(postCalls, 0, '未就绪时绝不能提交（受理落库的事件会推给空桶被丢弃）');
  assert.ok(sending.sendFailureNotice.value, '不就绪必须给出可见失败提示，不得静默');
  assert.equal(sending.isSubmitting.value, false, '失败后必须解除提交中');
});

/* ------------------------------------------------------------------ */
/* 5. 历史合并规则                                                     */
/* ------------------------------------------------------------------ */

/** 实时助手气泡：id 形如 bubble-<sessionId>-<turnId>（与历史 id 不同）。 */
const liveBubble = (turnId: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `bubble-${ROOT}-${turnId}`,
  role: 'assistant',
  content,
  timestamp: 2,
  turnId,
  isComplete: false,
  isThinking: false,
  toolCalls: [],
  ...extra,
});

/** 历史助手气泡：id 形如 msg-<sessionId>-turn-<turnId>。 */
const historyBubble = (turnId: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `msg-${ROOT}-turn-${turnId}`,
  role: 'assistant',
  content,
  timestamp: 2,
  turnId,
  isComplete: true,
  toolCalls: [],
  ...extra,
});

test('5a. 未终结轮的实时正文不被历史覆盖；历史只补齐缺失的过程数据', () => {
  const local = [
    { id: 'u1', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    liveBubble(T1, '这是正在逐字输出的正文', { toolCalls: [{ id: 'c1', toolName: 'read_file', status: 'calling' }] }),
  ];
  const history = [
    { id: 'srv-u1', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    // 历史里这一轮只落了半截（正在生成的片段不保证已落库），且工具轨迹比本地全
    historyBubble(T1, '这是正在逐', {
      toolCalls: [
        { id: 'c1', toolName: 'read_file', status: 'success' },
        { id: 'c2', toolName: 'write_file', status: 'success' },
      ],
    }),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  const assistants = merged.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, `同一轮不得出现两个助手气泡，实际=${merged.map(m => m.id).join(',')}`);
  // ★ 核心：实时正文不被历史半截覆盖
  assert.equal(assistants[0].content, '这是正在逐字输出的正文', '未终结轮正文必须保留本地实时内容');
  // 历史补齐了本地没有的工具轨迹
  assert.deepEqual(
    assistants[0].toolCalls?.map(tc => tc.id).sort(),
    ['c1', 'c2'],
    '历史应补齐本地缺失的工具轨迹',
  );
  // 不产生重复用户气泡
  assert.equal(merged.filter(m => m.role === 'user').length, 1, '不得产生重复用户气泡');
});

test('5b. ★ 不产生重复气泡：实时气泡与历史气泡 id 不同也只留一个（按 turnId 归并）', () => {
  const local = [
    { id: 'u1', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    liveBubble(T1, '完整正文'),
  ];
  const history = [
    { id: 'srv-u1', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '完整正文'),
  ];

  // 终结后回查：权威历史整体替换该轮
  const merged = mergeMessagesByTurn({ local, history, terminalTurnIds: [T1] });

  assert.equal(merged.length, 2, `同一轮只能留下 user+assistant 两条，实际=${merged.length}：${merged.map(m => m.id).join(',')}`);
  assert.equal(merged.filter(m => m.role === 'assistant').length, 1, '实时气泡与历史气泡 id 不同，但按 turnId 只能留一个');
  assert.equal(merged[1].id, `msg-${ROOT}-turn-${T1}`, '已终结轮应以权威历史整体替换');
});

test('5c. 已终结轮用权威历史整体替换；未终结轮保留本地正文，本地独有轮次按序插入', () => {
  const local = [
    { id: 'u1', role: 'user', content: '第一问', timestamp: 1, turnId: T1 } as ChatMessage,
    liveBubble(T1, '第一轮本地半截正文'),
    // 本地独有：刚发出、还没落库的第二轮
    { id: 'u2', role: 'user', content: '第二问', timestamp: 3, turnId: T2 } as ChatMessage,
    liveBubble(T2, '第二轮实时正文'),
  ];
  const history = [
    { id: 'srv-u1', role: 'user', content: '第一问', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '第一轮权威完整正文'),
  ];

  const merged = mergeMessagesByTurn({ local, history, terminalTurnIds: [T1] });

  // 第一轮已终结 → 权威历史整体替换（本地半截不得留下）
  const firstAssistant = merged.filter(m => m.role === 'assistant' && m.turnId === T1);
  assert.equal(firstAssistant.length, 1);
  assert.equal(firstAssistant[0].content, '第一轮权威完整正文', '已终结轮必须用权威历史整体替换');

  // 第二轮未终结 → 保留实时正文
  const secondAssistant = merged.filter(m => m.role === 'assistant' && m.turnId === T2);
  assert.equal(secondAssistant.length, 1);
  assert.equal(secondAssistant[0].content, '第二轮实时正文', '未终结轮必须保留实时正文');

  // 本地独有轮次按雪花键排在更早轮次之后，不得被塞到会话最末尾之前
  const order = merged.filter(m => m.turnId).map(m => m.turnId);
  assert.deepEqual(order, [T1, T1, T2, T2], `轮次顺序必须按 turnId 递增，实际=${order.join(',')}`);
});

test('5d. ★ 用户消息归位：本地该轮只有助手气泡时，补齐的用户消息必须排在助手之前', () => {
  // 构造：用户气泡还没绑定 turnId（bindUserMessageTurn 未执行），本地该轮只有助手气泡
  const local = [liveBubble(T1, '本地正文')];
  const history = [
    { id: 'srv-user', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '权威正文'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  // ★ 角色顺序：同一轮内 user 必须先于 assistant
  assert.deepEqual(
    merged.map(m => m.role), ['user', 'assistant'],
    `用户消息必须归位到助手之前，实际顺序=${merged.map(m => `${m.role}:${m.id}`).join(',')}`,
  );
  // 正文仍取本地实时内容
  assert.equal(merged[1].content, '本地正文', '未终结轮正文必须保留本地实时内容');
});

test('5e. ★ 乐观气泡去重：本地 turnId 为 null 的用户气泡若历史已落库，不得渲染两条', () => {
  // 构造：bindUserMessageTurn 还没执行 / 执行失败，乐观气泡 turnId 仍为 null，
  // 而历史已把该用户消息落库并带上 turnId —— 两者 id 不同但内容相同
  const local = [
    { id: 'user-optimistic', role: 'user', content: '问题', timestamp: 1, turnId: null } as ChatMessage,
    liveBubble(T1, '本地正文'),
  ];
  const history = [
    { id: 'srv-user', role: 'user', content: '问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '权威正文'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  const users = merged.filter(m => m.role === 'user');
  assert.equal(
    users.length, 1,
    `乐观气泡与历史同一条用户消息只能留一条（历史权威），实际=${users.map(u => u.id).join(',')}`,
  );
  assert.equal(users[0].id, 'srv-user', '命中时应保留历史那条（权威），删掉本地乐观气泡');
});

test('5f. 未落库的乐观气泡必须保留（对账不能把用户刚发的消息吃掉）', () => {
  // 反向：历史里没有这条用户消息（还没落库），不能被对账删掉
  const local = [
    { id: 'user-optimistic', role: 'user', content: '刚发的问题', timestamp: 1, turnId: null } as ChatMessage,
    liveBubble(T2, '实时正文'),
  ];
  const history = [
    { id: 'srv-user', role: 'user', content: '更早的问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '更早的权威正文'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  assert.ok(
    merged.some(m => m.id === 'user-optimistic'),
    `历史里没有的乐观气泡必须保留，否则用户刚发的消息会消失，实际=${merged.map(m => m.id).join(',')}`,
  );
});

test('5g. ★ 用户重复发送相同内容：新乐观气泡不得被更早轮次的同内容消息吞掉', () => {
  // 反例（QA 提出）：本地乐观气泡「重复的问题」turnId 仍为 null，
  // 历史里存在**异轮次**的同 role+content 消息 —— 全历史指纹比对会把它误删。
  // 本例历史只有一轮（且它就是最后一轮），考验的是「本地没有那一轮的任何消息 ⇒ 不得删」。
  const local = [
    { id: 'user-new', role: 'user', content: '重复的问题', timestamp: 2, turnId: null } as ChatMessage,
  ];
  const history = [
    { id: 'srv-other', role: 'user', content: '重复的问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '上一轮的回答'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  assert.ok(
    merged.some(m => m.id === 'user-new'),
    `异轮次的同内容消息不得吞掉本地乐观气泡（用户重复发相同内容），实际=${merged.map(m => m.id).join(',')}`,
  );
  assert.ok(
    merged.some(m => m.id === 'srv-other'),
    '上一轮的同内容历史消息必须保留',
  );
});

test('5i. ★ 指纹只比「历史最后一轮」：更早轮次的同内容消息必须被忽略', () => {
  // 本例本地**已有**最后一轮的消息（只有这种情况才允许走删除分支），
  // 因此能否正确保留完全取决于「比对范围是否收紧到最后一轮」。
  // 若把范围改回全历史，T1 的同内容消息会误命中 → 本地乐观气泡被吞 → 变红。
  const local = [
    { id: 'user-new', role: 'user', content: '重复的问题', timestamp: 3, turnId: null } as ChatMessage,
    // 本地已有最后一轮（T2）的助手气泡
    liveBubble(T2, '最后一轮的回答'),
  ];
  const history = [
    // 更早一轮：同 role + 同 content，但不是同一轮
    { id: 'srv-u1', role: 'user', content: '重复的问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '更早轮的回答'),
    // 最后一轮：内容不同
    { id: 'srv-u2', role: 'user', content: '换个问题', timestamp: 2, turnId: T2 } as ChatMessage,
    historyBubble(T2, '最后一轮的回答'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  assert.ok(
    merged.some(m => m.id === 'user-new'),
    `更早轮次的同内容消息必须被忽略（比对范围只取最后一轮），实际=${merged.map(m => m.id).join(',')}`,
  );
});

test('5j. ★ 已知边界（v1 接受，不当 bug 改）：上一轮助手气泡在本地 + 内容完全相同 ⇒ 乐观气泡被去重', () => {
  // 触发需三条同时成立：内容与上一轮完全相同 + 恰好落在「POST 在途、
  // bindUserMessageTurn 未执行」的窗口内发生一次对账 + 本地已保留上一轮助手气泡。
  // 为何接受：概率低；下一轮对账自愈（届时气泡已带 turnId，按轮归并会正确保留），
  // 属瞬态而非持久丢失。消除它要先拿到 turnId，而那正是该窗口存在的原因（鸡生蛋）。
  // 本用例把「有意接受的边界」钉住，防止它被当 bug 顺手改掉、或当 bug 报回来。
  const local = [
    { id: 'srv-u1', role: 'user', content: '继续', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '第一轮回答'),
    { id: 'user-new', role: 'user', content: '继续', timestamp: 2, turnId: null } as ChatMessage,
  ];
  const history = [
    { id: 'srv-u1', role: 'user', content: '继续', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '第一轮回答'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  assert.equal(
    merged.filter(m => m.role === 'user').length, 1,
    `v1 已知边界：此构造下乐观气泡会被去重（下一轮对账自愈），实际=${merged.map(m => m.id).join(',')}`,
  );
  assert.ok(
    !merged.some(m => m.id === 'user-new'),
    'v1 已知边界：此构造下乐观气泡会被去重',
  );
});

test('5k. ★ 轮次先后必须按雪花键判定：历史数组倒序时仍取雪花键最大的那一轮', () => {
  // resolveLatestHistoryTurnId 若退化成「按数组下标取最后一条有 turnId 的消息」，
  // 倒序历史会选错轮次 ⇒ 指纹比对范围与「本地是否有该轮消息」两个判断同时失效。
  // 构造：T2（雪花键更大）排在数组前面；本地乐观气泡与 T1 的 user 同内容。
  // 只有正确按雪花键取到 T2，才会因「T2 的指纹里没有该内容」而保留乐观气泡。
  const local = [
    { id: 'user-new', role: 'user', content: '重复的问题', timestamp: 3, turnId: null } as ChatMessage,
    // 本地已有 T1 与 T2 的助手气泡（满足「本地已有该轮消息」的前置条件）
    historyBubble(T1, '第一轮回答'),
    historyBubble(T2, '第二轮回答'),
  ];
  const history = [
    // 故意倒序：较新的 T2 在数组前面
    { id: 'srv-u2', role: 'user', content: '换个问题', timestamp: 2, turnId: T2 } as ChatMessage,
    historyBubble(T2, '第二轮回答'),
    { id: 'srv-u1', role: 'user', content: '重复的问题', timestamp: 1, turnId: T1 } as ChatMessage,
    historyBubble(T1, '第一轮回答'),
  ];

  const merged = mergeMessagesByTurn({ local, history });

  assert.ok(
    merged.some(m => m.id === 'user-new'),
    `轮次先后必须按雪花键判定（历史倒序时取雪花键最大的那轮），实际=${merged.map(m => m.id).join(',')}`,
  );
});

/* ------------------------------------------------------------------ */
/* 6. 查询响应版本控制                                                 */
/* ------------------------------------------------------------------ */

test('6. 切换会话前发起的旧回查响应必须被版本控制丢弃', async () => {
  setActivePinia(createPinia());
  const localSessions = ref<ChatSession[]>([
    { id: ROOT, title: 'A', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [], messages: [] },
    { id: SUB, title: 'B', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [], messages: [] },
  ]);
  const currentActiveSession = computed(() => localSessions.value[0]);

  // 手动控制两个会话的回查响应先后：让 A 的响应最后才回来
  let resolveA: (() => void) | null = null;
  const gateA = new Promise<void>(resolve => { resolveA = resolve; });

  const { chatApi } = await import('../src/services/chat');
  const originalTree = chatApi.fetchSessionTree;
  const originalMessages = chatApi.fetchSessionMessages;

  (chatApi as any).fetchSessionTree = async (id: string) => {
    if (String(id) === ROOT) await gateA;
    return originalTree(id);
  };
  (chatApi as any).fetchSessionMessages = async (id: string) => ({
    ok: true,
    data: {
      records: [],
      messages: [{ id: `srv-${id}`, role: 'assistant', content: `权威-${id}`, timestamp: 1, turnId: T1 }],
      turns: {},
      nextCursor: null,
      hasMore: false,
    },
  });

  const history = useChatHistory({
    currentActiveSession,
    localSessions,
    messagesContainerRef: ref(null),
    scheduleTimeout: ((handler: () => void) => setTimeout(handler, 0)) as any,
  });

  // 发起对 A 的回查（会被 gate 卡住）
  const pendingA = history.reconcileSessionAfterStream(ROOT);
  await tick();

  // 切换会话：作废在途响应，并发起对 B 的回查
  history.invalidateReconcile();
  const pendingB = history.reconcileSessionAfterStream(SUB);
  await pendingB;
  assert.equal(localSessions.value[1].messages.length, 1, 'B 的回查应正常写回');
  assert.equal(localSessions.value[1].messages[0].content, `权威-${SUB}`);

  // A 的迟到响应现在才回来
  (resolveA as unknown as () => void)();
  await pendingA;
  for (let i = 0; i < 10; i++) await tick();

  // ★ 旧响应必须被丢弃：不能把 A 的历史写回（切走后又串回来）
  assert.equal(
    localSessions.value[0].messages.length, 0,
    `切换会话前发起的旧回查响应必须丢弃，实际写入了 ${JSON.stringify(localSessions.value[0].messages)}`,
  );

  (chatApi as any).fetchSessionTree = originalTree;
  (chatApi as any).fetchSessionMessages = originalMessages;
});

/* ------------------------------------------------------------------ */
/* 7. 执行生命周期事件 → runStatus                                       */
/* ------------------------------------------------------------------ */

test('7. ★ 挂起事件必须把 runStatus 写成 SUSPENDED（挂起态卡片可达性的前提）', async () => {
  setActivePinia(createPinia());
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  (globalThis as any).fetch = async (url: string) => {
    if (String(url).includes('/completion/commands')) {
      return new Response(JSON.stringify({ code: 1, data: { sessionId: ROOT, turnId: T1 }, errMsg: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controllers.push(c);
        c.enqueue(encode(frame('READY', { rootSessionId: ROOT })));
      }
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  // 回查链路一并打桩：终态会触发回查，回查读回的 runStatus 会覆盖事件写入的值。
  // 本文件顶部的 axios adapter 在 import 阶段就失效了（interceptor 随 import 先加载），
  // 故直接打桩 chatApi（与用例 6 同口径）。
  const { chatApi } = await import('../src/services/chat');
  const originalTree = chatApi.fetchSessionTree;
  const originalMessages = chatApi.fetchSessionMessages;
  (chatApi as any).fetchSessionTree = async () => ({
    ok: true,
    data: { rootSessionId: ROOT, root: { id: ROOT, name: '会话', runStatus: 'IDLE', lastOutcome: 'COMPLETED' }, subSessions: [] },
  });
  (chatApi as any).fetchSessionMessages = async () => ({
    ok: true,
    data: { records: [], messages: [], turns: {}, nextCursor: null, hasMore: false },
  });

  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');
  let view: any;
  scope.run(() => { view = useChatView(); });
  await tick();

  view.localSessions.value = [{
    id: ROOT, title: '会话', messages: [], createdAt: 0, updatedAt: 0,
    modelId: '', activeTools: [], runStatus: 'IDLE',
  }];
  view.localActiveId.value = ROOT;
  for (let i = 0; i < 20 && controllers.length < 1; i++) await tick();
  assert.ok(controllers.length > 0, '进入会话应建立会话级流');
  assert.equal(view.currentActiveSession.value?.runStatus, 'IDLE');

  const meta = { sessionId: ROOT, rootSessionId: ROOT, turnId: T1 };
  /** 轮询等待 runStatus 变成期望值（事件消费是异步的，固定 tick 数会竞态）。 */
  const waitRunStatus = async (expected: string): Promise<void> => {
    for (let i = 0; i < 40; i++) {
      if (view.currentActiveSession.value?.runStatus === expected) return;
      await tick();
    }
  };

  // 先跑起来
  controllers[0].enqueue(encode(frame('EXECUTION_STARTED', {
    type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: 't', metaData: meta,
  })));
  await waitRunStatus('RUNNING');
  assert.equal(view.currentActiveSession.value?.runStatus, 'RUNNING', 'EXECUTION_STARTED 应写成 RUNNING');

  // ★ 挂起：等人工审批。runStatus 必须是 SUSPENDED —— 审批卡片与恢复入口都依赖它，
  //   漏写会让界面停在「生成中」，用户看不到「等待你审批」
  controllers[0].enqueue(encode(frame('EXECUTION_SUSPENDED', {
    type: 'EXECUTION_SUSPENDED', executionId: 'e1', timestamp: 't', metaData: meta,
  })));
  await waitRunStatus('SUSPENDED');
  assert.equal(
    view.currentActiveSession.value?.runStatus, 'SUSPENDED',
    'EXECUTION_SUSPENDED 必须把 runStatus 写成 SUSPENDED（挂起事件漏写会让界面卡在「生成中」）',
  );

  // 恢复 → 回到 RUNNING
  controllers[0].enqueue(encode(frame('EXECUTION_RESUME', {
    type: 'EXECUTION_RESUME', executionId: 'e1', timestamp: 't', metaData: meta,
  })));
  await waitRunStatus('RUNNING');
  assert.equal(view.currentActiveSession.value?.runStatus, 'RUNNING', 'EXECUTION_RESUME 应写成 RUNNING');

  // 终态 → 回到 IDLE
  controllers[0].enqueue(encode(frame('EXECUTION_COMPLETED', {
    type: 'EXECUTION_COMPLETED', executionId: 'e1', timestamp: 't', metaData: meta,
  })));
  await waitRunStatus('IDLE');
  assert.equal(view.currentActiveSession.value?.runStatus, 'IDLE', 'EXECUTION_COMPLETED 应写成 IDLE');

  controllers.forEach(c => { try { c.close(); } catch { /* 已关闭 */ } });
  scope.stop();
  (chatApi as any).fetchSessionTree = originalTree;
  (chatApi as any).fetchSessionMessages = originalMessages;
});