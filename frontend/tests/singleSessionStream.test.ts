import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { ref, computed, effectScope } from 'vue';
import axios from 'axios';
import { SessionEventStream } from '../src/views/chat/sessionEventStream';
import { useChatSending } from '../src/views/chat/useChatSending';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { aggregateRecordsByIdentity } from '../src/utils/session';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import type { AgentEvent } from '../src/types/Event';
import type { Block, TurnViewVO } from '../src/types/block';
import type { ChatMessage, ChatSession } from '../src/types/chat';

/**
 * 「单一会话级流」形态的回归守卫。
 *
 * <p>覆盖本期三个易错点，每条都必须能因缺陷变红：</p>
 * <ol>
 *   <li><b>连接共享</b>：同一根会话只开一条连接；一个使用者卸载不 abort，最后一个才 abort。
 *       且<b>发送链路不增加引用计数</b>（1d）、<b>就绪等待作用于被请求的根会话</b>（1e）。</li>
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

test('1d. ★ 发送链路走 ensure（不计数）：多次发送后切走会话必须能真的断开', async () => {
  const endpoint = installEventEndpoint();
  const scheduler = makeManualScheduler();
  const stream = new SessionEventStream({
    onEvent: () => {},
    onConnectionClosed: () => {},
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
  });

  // 进入会话：唯一的使用者（watch 路径）
  stream.acquire(ROOT);
  for (let i = 0; i < 30 && !endpoint.controller; i++) await tick();
  endpoint.send('READY', { rootSessionId: ROOT });
  for (let i = 0; i < 20 && !stream.isReady(ROOT); i++) await tick();

  // 连发 3 次：每次都要「连接在且就绪」，但那是使用前提，不是新增使用者
  for (let i = 0; i < 3; i++) {
    stream.ensure(ROOT);
    assert.equal(await stream.waitUntilReady(ROOT, 60_000), true, '已就绪时应立即 resolve');
  }
  // ★ 若发送链路用 acquire，计数会变成 4 —— 切走时归不了零，旧连接永远滞留（后端 total 只增）
  assert.equal(
    stream.resolveRefCount(ROOT), 1,
    `发送链路不得增加引用计数（那是使用前提，不是新增使用者），实际=${stream.resolveRefCount(ROOT)}`,
  );
  assert.equal(endpoint.fetchCount, 1, '发送链路不得重建连接');

  // ★ 切走会话：计数必须归零并真的断开
  stream.release(ROOT);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(
    stream.isConnected(), false,
    '发送过多次也必须能在切走时释放连接（否则旧连接永远滞留、后端只能靠心跳探测才发现）',
  );
  assert.equal(stream.resolveRefCount(ROOT), 0);
});

test('1e. ★ 就绪等待必须作用于被请求的根会话（多会话并存时不得落到「最近插入」的那条）', async () => {
  const ROOT_B = '2107364703088017499';
  const scheduler = makeManualScheduler();
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  (globalThis as any).fetch = async (url: string) => {
    const text = String(url);
    const body = new ReadableStream<Uint8Array>({ start(c) { controllers.set(text, c); } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const stream = new SessionEventStream({
    onEvent: () => {},
    onConnectionClosed: () => {},
    scheduleRetry: scheduler.schedule,
    cancelRetry: scheduler.cancel,
  });
  const sendTo = (rootId: string, event: string, data: unknown): void => {
    for (const [url, ctl] of controllers) {
      if (url.includes(`/${rootId}/events`)) { ctl.enqueue(encode(frame(event, data))); return; }
    }
    throw new Error(`没有该根会话的连接: ${rootId}`);
  };

  // A 先建并握手；B 后建、永不握手 ⇒「最近插入」的是 B
  stream.acquire(ROOT);
  for (let i = 0; i < 30 && controllers.size < 1; i++) await tick();
  stream.acquire(ROOT_B);
  for (let i = 0; i < 30 && controllers.size < 2; i++) await tick();
  assert.equal(controllers.size, 2, '两个根会话应各有一条连接');
  sendTo(ROOT, 'READY', { rootSessionId: ROOT });
  for (let i = 0; i < 20 && !stream.isReady(ROOT); i++) await tick();
  assert.equal(stream.isReady(ROOT), true, 'A 应已握手');
  assert.equal(stream.isReady(ROOT_B), false, 'B 未握手');

  // ★ A 已就绪 ⇒ 等 A 必须立即成功。若按「最近插入」解析（=B），这里会挂到超时
  let readyA: boolean | null = null;
  void stream.waitUntilReady(ROOT, 100).then(v => { readyA = v; });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(
    readyA, true,
    'waitUntilReady(A) 必须看 A 自己的连接；落到 B 上会误判超时，进而触发整轮重挂',
  );

  // ★ 反向：B 未就绪 ⇒ 等 B 必须超时失败，绝不能因为 A 已就绪而误判成功
  let readyB: boolean | null = null;
  void stream.waitUntilReady(ROOT_B, 100).then(v => { readyB = v; });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(readyB, null, 'B 未握手：不得立即成功');
  assert.equal(scheduler.takeByDelay(100), true, '应安排过就绪等待定时器');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(readyB, false, 'B 未握手：超时后必须失败');

  stream.close();
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
  const waiting = stream.waitUntilReady(ROOT, 60_000).then(v => { resolved = v; return v; });

  // READY 之前：不得 resolve（否则会在「emitter 尚未入桶」时提交发送，首批事件被丢弃）
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(resolved, null, 'READY 到达前 waitUntilReady 不得 resolve');
  assert.equal(stream.isReady(ROOT), false);

  endpoint.send('READY', { rootSessionId: ROOT });

  // ★ READY 到达后必须 resolve（轮询等待真实 resolve，不靠固定 tick 数）
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) { await tick(); ready = resolved === true; }
  assert.equal(ready, true, 'READY 到达后必须 resolve');
  assert.equal(await waiting, true);
  assert.equal(stream.isReady(ROOT), true);

  // 已就绪后再调：立即 resolve
  assert.equal(await stream.waitUntilReady(ROOT, 60_000), true, '已就绪时应立即 resolve');
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
  for (let i = 0; i < 20 && !stream.isReady(ROOT); i++) await tick();
  assert.equal(stream.getHealthState(ROOT), 'READY');
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
  for (let i = 0; i < 20 && !stream.isReady(ROOT); i++) await tick();
  assert.equal(stream.getHealthState(ROOT), 'READY', '重连握手后应恢复健康');
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
  assert.equal(stream.getHealthState(ROOT), 'FAILED', `重试耗尽后必须暴露连接失败，实际=${stream.getHealthState(ROOT)}`);
  assert.ok(states.includes('FAILED'), '必须通过 onHealthChange 通知界面（供显式呈现与重挂入口）');

  // reconnect() 必须能恢复（引用计数保持不变）
  const fetchBefore = endpoint.fetchCount;
  stream.reconnect();
  for (let i = 0; i < 30 && endpoint.fetchCount === fetchBefore; i++) await tick();
  assert.ok(endpoint.fetchCount > fetchBefore, 'reconnect() 必须真的重开连接');
  endpoint.send('READY', { rootSessionId: ROOT });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(stream.getHealthState(ROOT), 'READY', 'reconnect() 后握手成功应恢复 READY');
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
/* 5. 历史合并规则（唯一链路：后端轮次视图 → upsertTurnViewIntoMessages）  */
/* ------------------------------------------------------------------ */

/** 实时助手气泡：id 形如 bubble-<sessionId>-<turnId>（与历史投影同 id）。 */
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

/**
 * 造一个 `TURN_SNAPSHOT` 事件。
 *
 * <p>后端把载荷平铺在事件体顶层：{@code turnId / viewVersion / view}，
 * 其中 {@code view} 才是 {@link TurnViewVO}。</p>
 */
function snapshotEvent(view: TurnViewVO): AgentEvent {
  return {
    type: 'TURN_SNAPSHOT',
    turnId: view.turnId,
    viewVersion: view.viewVersion,
    view,
    executionId: 'execution-1',
    timestamp: '2026-10-08T08:56:01Z',
    metaData: { sessionId: view.sessionId, rootSessionId: ROOT, turnId: view.turnId },
  } as unknown as AgentEvent;
}

/** 一轮的权威视图：正文写在 BODY 段，工具写在 TOOL 段。 */
const turnView = (
  turnId: string,
  opts: { version?: number; user?: string; text?: string; tools?: string[] } = {},
): TurnViewVO => {
  const blocks: Block[] = [];
  let order = 0;
  if (opts.text !== undefined) {
    blocks.push({ blockId: `text:${turnId}`, type: 'TEXT', order: order++, status: 'COMPLETE', placement: 'BODY', text: opts.text });
  }
  for (const callId of opts.tools ?? []) {
    blocks.push({
      blockId: `tool:${callId}`, type: 'TOOL', order: order++, status: 'COMPLETED',
      toolCallId: callId, toolName: 'read_file',
    });
  }
  return {
    sessionId: ROOT, turnId, status: 'COMPLETED',
    viewVersion: String(opts.version ?? 1),
    userMessage: opts.user, blocks,
  };
};

test('5a. ★ 原始增量在权威响应身份下立即在过程区打印', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: ROOT });
  reducer.consume({ type: 'PARTIAL_TEXT', responseId: T1, offset: 0, content: '这是正在逐字输出的正文', metaData: { sessionId: ROOT, rootSessionId: ROOT, turnId: T1 } } as unknown as AgentEvent);
  reducer.flush();

  const assistants = messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, `同一轮不得出现两个助手气泡，实际=${messages.map(m => m.id).join(',')}`);
  assert.equal(assistants[0].content, '', '用途未确认不能进入正文');
  assert.equal(assistants[0].aiMessages?.find(item => item.id === `text:${T1}`)?.text, '这是正在逐字输出的正文', '片段到达后即显示');
  assert.equal(assistants[0].toolCalls?.length, 0, '工具轨迹只等视图，原始事件不建工具项');
  assert.equal(assistants[0].isThinking, true, '增量事件把气泡维持在生成态');
});

test('5b. ★ 不产生重复气泡：视图到达后该轮只有一条助手气泡，且正文/工具整体来自视图', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: ROOT });
  reducer.consume({ type: 'PARTIAL_TEXT', responseId: T1, offset: 0, content: '权威', metaData: { sessionId: ROOT, rootSessionId: ROOT, turnId: T1 } } as unknown as AgentEvent);
  reducer.flush();
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1);

  // 权威视图到达：整轮重投影（正文、工具全以后端为准），不得裂出第二条气泡
  reducer.consume(snapshotEvent(turnView(T1, { version: 2, user: '问题', text: '权威完整正文', tools: ['c1', 'c2'] })));
  const assistants = messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, `同一轮只能有一条助手气泡，实际=${messages.map(m => m.id).join(',')}`);
  assert.equal(assistants[0].content, '权威完整正文', '视图到达后正文以后端为准');
  assert.deepEqual(assistants[0].toolCalls?.map(tc => tc.id).sort(), ['c1', 'c2'], '工具轨迹来自后端视图');
  assert.equal(messages.filter(m => m.role === 'user').length, 1, '用户提问由视图补齐，且只有一条');
});

test('5c. ★ 轮次视图驱动展示：用户提问归位到助手之前，正文与工具全来自后端', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: ROOT });
  reducer.consume(snapshotEvent(turnView(T1, { version: 1, user: '第一问', text: '第一轮权威正文', tools: ['c1'] })));
  reducer.consume(snapshotEvent(turnView(T2, { version: 1, user: '第二问', text: '第二轮权威正文' })));

  assert.deepEqual(
    messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant'],
    `用户消息必须归位到助手之前，实际顺序=${messages.map(m => `${m.role}:${m.id}`).join(',')}`,
  );
  assert.deepEqual(
    messages.filter(m => m.turnId).map(m => m.turnId), [T1, T1, T2, T2],
    `轮次顺序必须按 turnId 递增，实际=${messages.map(m => m.turnId).join(',')}`,
  );
  assert.equal(messages[1].content, '第一轮权威正文');
  assert.equal(messages[3].content, '第二轮权威正文');
});

test('5d. ★ 低版本视图不得回退高版本：同一轮按 viewVersion 只接受更新', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: ROOT });
  reducer.consume(snapshotEvent(turnView(T1, { version: 10, user: '问题', text: '新正文', tools: ['c1', 'c2'] })));
  assert.equal(messages[1].content, '新正文');

  // 迟到的旧版本（十进制字符串不能按字典序比较：'9' > '10' 是假命题，必须转数值）
  reducer.consume(snapshotEvent(turnView(T1, { version: 9, user: '问题', text: '旧正文', tools: ['c1'] })));
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1, '不得裂出第二条气泡');
  assert.equal(messages[1].content, '新正文', '低版本视图必须被拒绝');
  assert.deepEqual(messages[1].toolCalls?.map(tc => tc.id).sort(), ['c1', 'c2'], '低版本工具不得回退');
});

test('5e. ★ 视图内块按 blockId 幂等覆盖：重复投递同一视图不翻倍', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: ROOT });
  const view = turnView(T1, { version: 4, user: '问题', text: '正文', tools: ['c1', 'c2'] });
  reducer.consume(snapshotEvent(view));
  const before = messages[1].toolCalls?.length;

  reducer.consume(snapshotEvent(view));
  assert.equal(messages[1].toolCalls?.length, before, '重复投影不得翻倍');
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1, '不得裂出第二条气泡');
});

test('5f. ★ 视图按 turnId 定位：同一轮跨页多次下发只保留一条气泡', () => {
  const messages: ChatMessage[] = [];
  // 第一页：该轮只落了部分块（版本 3）；第二页：同一轮更全（版本 5）
  upsertTurnViewIntoMessages(messages, turnView(T1, { version: 3, user: '问题', text: '完整', tools: ['c1'] }), new Map());
  upsertTurnViewIntoMessages(messages, turnView(T1, { version: 5, user: '问题', text: '完整正文', tools: ['c1', 'c2', 'c3'] }), new Map());

  const assistants = messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, `同一轮跨页只能有一条气泡，实际=${messages.map(m => m.id).join(',')}`);
  assert.equal(assistants[0].content, '完整正文', '按版本取新');
  assert.equal(assistants[0].toolCalls?.length, 3, '同一轮按版本更新后必须含全部工具');
});

test('5g. ★ 无视图即无气泡：缺 turnViews 时不从原始记录聚合', () => {
  const merged = aggregateRecordsByIdentity(ROOT, undefined);
  assert.equal(merged.length, 0, '没有轮次视图就没有任何气泡');
});

test('5h. ★ 视图缺 userMessage 时不伪造用户气泡，只投影助手气泡', () => {
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, turnView(T1, { version: 1, text: '只有回答' }), new Map());
  assert.equal(messages.filter(m => m.role === 'user').length, 0, '视图未给 userMessage 就不应造用户气泡');
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1);
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
      // 唯一展示链路是「轮次视图 → reducer」：想让它写出气泡就必须给 turnViews。
      records: [],
      messages: [],
      turns: {},
      turnViews: {
        [T1]: {
          sessionId: String(id),
          turnId: T1,
          status: 'COMPLETED',
          viewVersion: 1,
          userMessage: '提问',
          blocks: [{ blockId: `text:${id}`, type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: `权威-${id}` }],
        },
      },
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
  assert.equal(localSessions.value[1].messages.length, 2, 'B 的回查应正常写回（用户提问 + 助手回答）');
  assert.equal(localSessions.value[1].messages[1].content, `权威-${SUB}`);

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
