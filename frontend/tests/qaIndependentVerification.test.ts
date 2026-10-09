import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { ref, effectScope, nextTick, watchEffect } from 'vue';
import axios from 'axios';

/**
 * QA 独立验证（gstack-qa-lead）。
 *
 * <p>不复用实现者的 chatLiveRenderFixes.test.ts —— 目的是以「独立观测」复核两条缺陷，
 * 并补测实现者未覆盖的边界。缺陷1 一律通过 watchEffect 观察**渲染副作用**
 * （等价模板订阅），绝不靠手动重读 computed（那会因惰性求值造成假性通过）。</p>
 *
 * <p><b>协议形态</b>：发送已切到「单一会话级流」——事件走
 * {@code GET /a/completion/{id}/events}（握手发 {@code READY}），发送是
 * {@code POST /a/completion/commands} 同步受理、不带流。</p>
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
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const SID = '2107364703088017408';
const TID = '2107364703113183232';
const TID2 = '2107364703113183999';

let mode: 'normal' | 'emptyList' | 'listFail' = 'normal';
let listCalls = 0;

const ok = (data: any, config: any) => ({ data: { code: 1, data, errMsg: null }, status: 200, statusText: 'OK', headers: {}, config });
const bizFail = (config: any) => ({ data: { code: 0, data: null, errMsg: 'boom' }, status: 200, statusText: 'OK', headers: {}, config });

axios.defaults.adapter = (async (config: any) => {
  const url = String(config.url || '');
  if (url.includes('/session/list')) {
    listCalls += 1;
    if (mode === 'listFail') return bizFail(config);
    if (mode === 'emptyList') return ok({ records: [], total: 0 }, config);
    return ok({ records: [{ id: SID, name: '历史会话', workspaceId: null, workDir: null, createTime: null, runStatus: 'IDLE', lastOutcome: null }], total: 1 }, config);
  }
  if (url.includes('/session/create')) return ok(SID, config);
  if (url.includes('/tree')) return ok({ rootSessionId: SID, sessions: [{ id: SID, name: '新对话', runStatus: 'IDLE', lastOutcome: null, createTime: null, updateTime: null, workspaceId: null }] }, config);
  if (url.includes('/messages')) return ok({ records: [], turns: {}, nextCursor: null, hasMore: false }, config);
  return ok({ records: [], total: 0 }, config);
}) as any;

const enc = (s: string) => new TextEncoder().encode(s);
const frame = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
/** 受理 POST 每次返回的轮次 id：逐轮递增，便于断言第 2 轮的独立 turnId。 */
let acceptTurnSeq = 0;
(globalThis as any).fetch = async (url: string) => {
  const text = String(url);
  if (text.includes('/completion/commands')) {
    acceptTurnSeq += 1;
    const turnId = acceptTurnSeq === 1 ? TID : TID2;
    return new Response(JSON.stringify({ code: 1, data: { sessionId: SID, turnId }, errMsg: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  // 会话级流：握手后发 READY（真实协议如此），随后保持打开
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      streamCtl = c;
      c.enqueue(enc(frame('READY', { rootSessionId: SID })));
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const tick = () => new Promise<void>(r => setImmediate(r));

const meta = (turnId: string) => ({ sessionId: SID, rootSessionId: SID, turnId });

test('QA-1 缺陷1：首轮发消息——渲染副作用必须由流式写入驱动（观察 watchEffect，非手动读）', async () => {
  setActivePinia(createPinia());
  mode = 'normal';
  streamCtl = null;
  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');

  let view: any;
  scope.run(() => { view = useChatView(); });
  view.localActiveId.value = null;

  const sigs: string[] = [];
  // 模拟模板订阅：只有依赖真正变更（走响应式代理）才会重跑
  scope.run(() => {
    watchEffect(() => {
      sigs.push(view.displayedMessages.value.map((m: any) => `${m.role}${m.content ? ':' + m.content : ''}`).join('|'));
    });
  });
  await nextTick();
  console.log('[QA-1] 初始渲染序列:', JSON.stringify(sigs));

  const sendPromise = view.handleSendMessage('1', false, null, null, null);
  for (let i = 0; i < 50 && !streamCtl; i++) await tick();
  assert.ok(streamCtl, '会话级事件流应已建立');
  await sendPromise;

  (streamCtl as any).enqueue(enc(frame('EXECUTION_STARTED', { type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: '2026-10-06T06:57:56.135Z', metaData: meta(TID) })));
  (streamCtl as any).enqueue(enc(frame('TURN_SNAPSHOT', {
    type: 'TURN_SNAPSHOT', turnId: TID, viewVersion: '1',
    view: {
      sessionId: SID, turnId: TID, status: 'RUNNING', viewVersion: '1',
      blocks: [{ blockId: 'text:1', type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: '你发送的是「1」' }]
    },
    executionId: 'e1', timestamp: '2026-10-06T06:57:57.000Z', metaData: meta(TID)
  })));
  (streamCtl as any).enqueue(enc(frame('EXECUTION_COMPLETED', { type: 'EXECUTION_COMPLETED', executionId: 'e1', timestamp: '2026-10-06T06:57:58.000Z', metaData: meta(TID) })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();

  console.log('[QA-1] 流式后渲染序列:', JSON.stringify(sigs));
  const last = sigs[sigs.length - 1] ?? '';
  assert.ok(last.includes('user:1'), `渲染副作用应看到用户气泡，实际=${last}；序列=${JSON.stringify(sigs)}`);
  assert.ok(last.includes('assistant'), `渲染副作用应看到助手气泡，实际=${last}`);
  assert.ok(last.includes('你发送的是「1」'), `助手正文必须由流式写入驱动渲染副作用，实际=${last}`);

  scope.stop();
});

test('QA-2 缺陷2：loadInitialData 必须把 /session/list 结果写回 localSessions（独立复核）', async () => {
  setActivePinia(createPinia());
  mode = 'normal';
  listCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData();
  console.log('[QA-2] listCalls=', listCalls, 'len=', localSessions.value.length, 'id=', localSessions.value[0]?.id, 'err=', JSON.stringify(ws.initLoadError.value));

  assert.ok(listCalls >= 1, '初始化必须请求 /session/list');
  assert.equal(localSessions.value.length, 1, 'localSessions 应写入 1 条');
  assert.equal(localSessions.value[0].id, SID);
  assert.ok(/^\d+$/.test(String(localSessions.value[0].id)), 'id 应为有效雪花数字串');
  assert.equal(ws.initLoadError.value, '', '正常路径不应有可见错误');
});

test('QA-3 边界：会话列表为空——不报错，且用空数组覆盖旧数据', async () => {
  setActivePinia(createPinia());
  mode = 'emptyList';
  listCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([{ id: 'stale-1' }, { id: 'stale-2' }]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData();
  console.log('[QA-3] listCalls=', listCalls, 'len=', localSessions.value.length, 'err=', JSON.stringify(ws.initLoadError.value));

  assert.equal(localSessions.value.length, 0, '空列表应如实写回空数组（覆盖旧值）');
  assert.equal(ws.initLoadError.value, '', '「确实为空」不是错误');
});

test('QA-4 边界：列表请求失败（code!=1）——保留旧数据、给出可见错误、不抛异常', async () => {
  setActivePinia(createPinia());
  mode = 'listFail';
  listCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([{ id: 'keep-me' }]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData(); // 不得抛出
  console.log('[QA-4] listCalls=', listCalls, 'len=', localSessions.value.length, 'id=', localSessions.value[0]?.id, 'err=', JSON.stringify(ws.initLoadError.value));

  assert.equal(localSessions.value.length, 1, '失败时不得清空旧列表');
  assert.equal(localSessions.value[0].id, 'keep-me');
  assert.equal(ws.initLoadError.value, '会话数据加载失败，请检查后端服务', '应给出可见失败态（与「确实为空」区分）');
});

test('QA-5 边界：同一会话内发第 2 条消息——仍实时渲染', async () => {
  setActivePinia(createPinia());
  mode = 'normal';
  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');

  let view: any;
  scope.run(() => { view = useChatView(); });
  view.localActiveId.value = null;

  const sigs: string[] = [];
  scope.run(() => {
    watchEffect(() => {
      sigs.push(view.displayedMessages.value.map((m: any) => `${m.role}${m.content ? ':' + m.content : ''}`).join('|'));
    });
  });
  await nextTick();

  // 第一条（连接由进入会话时的订阅建立，发送复用它）
  const p1 = view.handleSendMessage('第一条', false, null, null, null);
  for (let i = 0; i < 50 && !streamCtl; i++) await tick();
  await p1;
  (streamCtl as any).enqueue(enc(frame('EXECUTION_STARTED', { type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: '2026-10-06T06:57:56Z', metaData: meta(TID) })));
  (streamCtl as any).enqueue(enc(frame('TURN_SNAPSHOT', {
    type: 'TURN_SNAPSHOT', turnId: TID, viewVersion: '1',
    view: { sessionId: SID, turnId: TID, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:101', type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: '回复一' }] },
    executionId: 'e1', timestamp: '2026-10-06T06:57:57Z', metaData: meta(TID)
  })));
  (streamCtl as any).enqueue(enc(frame('EXECUTION_COMPLETED', { type: 'EXECUTION_COMPLETED', executionId: 'e1', timestamp: '2026-10-06T06:57:58Z', metaData: meta(TID) })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();
  console.log('[QA-5] 第一条后渲染序列:', JSON.stringify(sigs));

  // 第二条（同一持久化会话）：新模型下终态不关流，复用同一条会话级流
  const p2 = view.handleSendMessage('第二条', false, null, null, null);
  await p2;
  assert.ok(streamCtl, '第 2 轮应复用同一条会话级流（终态不关流）');
  (streamCtl as any).enqueue(enc(frame('EXECUTION_STARTED', { type: 'EXECUTION_STARTED', executionId: 'e2', timestamp: '2026-10-06T06:58:00Z', metaData: meta(TID2) })));
  (streamCtl as any).enqueue(enc(frame('TURN_SNAPSHOT', {
    type: 'TURN_SNAPSHOT', turnId: TID2, viewVersion: '1',
    view: { sessionId: SID, turnId: TID2, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:102', type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: '回复二' }] },
    executionId: 'e2', timestamp: '2026-10-06T06:58:01Z', metaData: meta(TID2)
  })));
  (streamCtl as any).enqueue(enc(frame('EXECUTION_COMPLETED', { type: 'EXECUTION_COMPLETED', executionId: 'e2', timestamp: '2026-10-06T06:58:02Z', metaData: meta(TID2) })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();

  console.log('[QA-5] 第二条后渲染序列:', JSON.stringify(sigs));
  const last = sigs[sigs.length - 1] ?? '';
  assert.ok(last.includes('user:第二条'), `第 2 条用户气泡应实时渲染，实际=${last}；序列=${JSON.stringify(sigs)}`);
  assert.ok(last.includes('回复二'), `第 2 条助手正文应由流式驱动，实际=${last}`);

  scope.stop();
});

test('QA-6 边界：选中历史会话后再发送——仍实时渲染', async () => {
  setActivePinia(createPinia());
  mode = 'normal';
  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');

  let view: any;
  scope.run(() => { view = useChatView(); });
  // 模拟初始化已把列表灌入
  view.localSessions.value = [{
    id: SID, title: '历史会话', messages: [], createdAt: 0, updatedAt: 0,
    modelId: '', activeTools: [], runStatus: 'IDLE',
  }];
  view.localActiveId.value = null;

  const sigs: string[] = [];
  scope.run(() => {
    watchEffect(() => {
      sigs.push(view.displayedMessages.value.map((m: any) => `${m.role}${m.content ? ':' + m.content : ''}`).join('|'));
    });
  });
  await nextTick();

  await view.handleSelectSession(SID);
  await nextTick();
  console.log('[QA-6] 选中历史会话后渲染序列:', JSON.stringify(sigs));

  // 连接在 handleSelectSession 时已建立（进入会话即订阅），发送复用同一条流，
// 故这里不再重置 streamCtl —— 新模型下终态不关流，连接跟页面走。
const p = view.handleSendMessage('历史会话里发一条', false, null, null, null);
  for (let i = 0; i < 50 && !streamCtl; i++) await tick();
  assert.ok(streamCtl, '会话级事件流应已建立');
  await p;
  (streamCtl as any).enqueue(enc(frame('EXECUTION_STARTED', { type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: '2026-10-06T07:00:00Z', metaData: meta(TID) })));
  (streamCtl as any).enqueue(enc(frame('TURN_SNAPSHOT', {
    type: 'TURN_SNAPSHOT', turnId: TID, viewVersion: '1',
    view: { sessionId: SID, turnId: TID, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:h1', type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: '收到' }] },
    executionId: 'e1', timestamp: '2026-10-06T07:00:01Z', metaData: meta(TID)
  })));
  (streamCtl as any).enqueue(enc(frame('EXECUTION_COMPLETED', { type: 'EXECUTION_COMPLETED', executionId: 'e1', timestamp: '2026-10-06T07:00:02Z', metaData: meta(TID) })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();

  console.log('[QA-6] 发送后渲染序列:', JSON.stringify(sigs));
  const last = sigs[sigs.length - 1] ?? '';
  assert.ok(last.includes('user:历史会话里发一条'), `选中历史会话后发送应实时渲染，实际=${last}`);
  assert.ok(last.includes('收到'), `助手正文应由流式驱动，实际=${last}`);

  scope.stop();
});
