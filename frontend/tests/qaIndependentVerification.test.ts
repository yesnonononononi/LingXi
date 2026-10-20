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

let mode: 'normal' | 'emptyList' | 'listFail' | 'configFail' | 'modelFail' = 'normal';
let listCalls = 0;
let configCalls = 0;
let modelCalls = 0;

const ok = (data: any, config: any) => ({ data: { code: 1, data, errMsg: null }, status: 200, statusText: 'OK', headers: {}, config });
const bizFail = (config: any) => ({ data: { code: 0, data: null, errMsg: 'boom' }, status: 200, statusText: 'OK', headers: {}, config });

/**
 * 合法的 UserConfigVO 桩（字段取自 `src/types/chat.ts:685` 的真实定义）。
 *
 * <p>早先桩里没有这个分支，`/config/current` 落到兜底 `ok({records:[],total:0})`，
 * 配置拿到分页结构后解析不出配置项 ⇒ 初始化失败被判为「配置读取失败」。</p>
 */
const userConfigVO = {
  id: 1,
  type: 'LOCAL',
  modelId: 1001,
  agentId: null,
  commandApprovalPolicy: 'PRE_EXEC_CONFIRM',
  accessMode: 'IN_WORKSPACE',
  planMaxReminders: 3,
  maxTokens: 8192,
  reasoningEffort: 'medium',
  renderTheme: 'LIGHT',
  dataDir: 'C:/data/lingxi',
  skillDir: 'C:/data/lingxi/skills',
  teamSize: 5,
  dataDirRestartRequired: false,
};

/**
 * 合法的 ProviderModelGroupVO[] 桩（字段取自 `src/types/chat.ts:327`）。
 *
 * <p>{@code chatApi.fetchModels} 实际打的是 {@code GET /model/catalog}（不是 /model/list），
 * 且对返回值直接做 `for (const group of groups)` 遍历 —— 兜底的 `{records,total}` 对象
 * 会抛 {@code TypeError: groups is not iterable}，被 catch 成 modelsRes.ok=false。</p>
 */
const modelCatalog = [
  {
    providerConfigId: 'p1',
    providerName: 'DeepSeek',
    providerIcon: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    modelCount: 1,
    models: [
      {
        id: 1001,
        modelName: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-te***1234',
        vision: false,
        provider: 'DEEPSEEK',
      },
    ],
  },
];

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
  // 现状契约：loadInitialData 会额外依赖用户配置与模型目录，二者失败都会置 initLoadError。
  if (url.includes('/config/current')) {
    configCalls += 1;
    if (mode === 'configFail') return bizFail(config);
    return ok(userConfigVO, config);
  }
  if (url.includes('/model/catalog')) {
    modelCalls += 1;
    if (mode === 'modelFail') return bizFail(config);
    return ok(modelCatalog, config);
  }
  if (url.includes('/workspace/list')) return ok({ records: [], total: 0 }, config);
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
      blocks: [{ blockId: 'text:1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '你发送的是「1」' }]
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
  configCalls = 0;
  modelCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData();
  console.log('[QA-2] listCalls=', listCalls, 'configCalls=', configCalls, 'modelCalls=', modelCalls, 'len=', localSessions.value.length, 'id=', localSessions.value[0]?.id, 'err=', JSON.stringify(ws.initLoadError.value));

  // 桩覆盖度守卫：初始化依赖的每个接口都必须被桩命中。
  // 漏桩时请求会落到兜底 {records,total}，症状是「数据对了但错误文案被置」——
  // 这里直接钉住命中次数，桩再陈旧会立刻红，不必等到断言文案对不上。
  assert.ok(configCalls >= 1, '桩未覆盖 /config/current —— loadInitialData 依赖它');
  assert.ok(modelCalls >= 1, '桩未覆盖 /model/catalog —— loadInitialData 依赖它');

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

test('QA-4b 契约守卫：/config/current 业务失败时必须置 initLoadError（configOk 不是摆设）', async () => {
  setActivePinia(createPinia());
  mode = 'configFail';
  listCalls = 0;
  configCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData();
  console.log('[QA-4b] listCalls=', listCalls, 'configCalls=', configCalls, 'err=', JSON.stringify(ws.initLoadError.value));

  // 前置：确实走到了配置接口（否则「报错」可能是别的分支给的，断言不成立）
  assert.ok(configCalls >= 1, '初始化必须请求 /config/current——否则下面的断言与配置无关');
  // 核心契约：配置失败 ⇒ 可见错误。若未来源码删掉 configOk 判定，本用例必须变红。
  assert.equal(
    ws.initLoadError.value,
    '会话数据加载失败，请检查后端服务',
    '配置读取失败必须置 initLoadError（证明 configOk 参与了成功判定，不是摆设）'
  );
  // 同时证明：此时会话本身是成功的，错误只可能来自配置或模型
  assert.equal(listCalls, 1, '会话列表应只请求一次');
});

test('QA-4c 契约守卫：/model/catalog 业务失败时必须置 initLoadError，且不得抛出', async () => {
  setActivePinia(createPinia());
  mode = 'modelFail';
  listCalls = 0;
  modelCalls = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData(); // 不得抛出
  console.log('[QA-4c] listCalls=', listCalls, 'modelCalls=', modelCalls, 'err=', JSON.stringify(ws.initLoadError.value));

  assert.ok(modelCalls >= 1, '初始化必须请求 /model/catalog（fetchModels 的真实路径）');
  assert.equal(
    ws.initLoadError.value,
    '会话数据加载失败，请检查后端服务',
    '模型目录读取失败必须置 initLoadError（modelsRes.ok 参与了成功判定）'
  );
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
    view: { sessionId: SID, turnId: TID, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:101', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '回复一' }] },
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
    view: { sessionId: SID, turnId: TID2, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:102', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '回复二' }] },
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
    view: { sessionId: SID, turnId: TID, status: 'RUNNING', viewVersion: '1', blocks: [{ blockId: 'text:h1', type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: '收到' }] },
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
