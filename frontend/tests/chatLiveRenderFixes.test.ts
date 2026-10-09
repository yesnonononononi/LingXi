import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { ref, effectScope, nextTick, watchEffect } from 'vue';
import axios from 'axios';
import { AgentToolName } from '../src/utils/toolNames';

/**
 * 会话实时渲染 / 会话列表加载回归守卫。
 *
 * <p>守护两个由「简流」重构引入、且单靠肉眼「重读一次 computed」无法发现的缺陷：</p>
 * <ol>
 *   <li><b>首轮发消息不渲染</b>：{@code ensureBoundSession} 曾把「新建的裸会话对象」交给
 *       {@code StreamSessionRouter}，流式写入落到未被 Vue 代理的 messages 上，触发不了重渲染。
 *       本用例用一个真实订阅 computed 的渲染副作用（{@code watchEffect}）来观测，
 *       只有依赖真正变更才会重跑——重读 {@code .value} 会因惰性求值假性通过。</li>
 *   <li><b>左侧会话列表不加载</b>：{@code loadInitialData} 拿到 {@code fetchSessions()} 结果后
 *       只做了 ok 判断、漏了写回 {@code localSessions}。</li>
 * </ol>
 *
 * <p><b>协议形态</b>：发送已切到「单一会话级流」——事件全部走
 * {@code GET /a/completion/{id}/events}（握手发 {@code READY}），发送本身是
 * {@code POST /a/completion/commands} 同步受理、不带流。故这里要打桩两处。</p>
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
const sessions: string[] = [];

axios.defaults.adapter = (async (config: any) => {
  const url = String(config.url || '');
  const ok = (data: any) => ({ data: { code: 1, data, errMsg: null }, status: 200, statusText: 'OK', headers: {}, config });
  if (url.includes('/session/list')) {
    sessions.push('list');
    return ok({ records: [{ id: SID, name: '历史会话', workspaceId: null, workDir: null, createTime: null, runStatus: 'IDLE', lastOutcome: null }], total: 1 });
  }
  if (url.includes('/session/create')) return ok(SID);
  if (url.includes('/tree')) return ok({ rootSessionId: SID, sessions: [{ id: SID, name: '新对话', runStatus: 'IDLE', lastOutcome: null, createTime: null, updateTime: null, workspaceId: null }] });
  if (url.includes('/messages')) return ok({ records: [], turns: {}, nextCursor: null, hasMore: false });
  return ok({ records: [], total: 0 });
}) as any;

const frame = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
(globalThis as any).fetch = async (url: string) => {
  const text = String(url);
  // 发送：同步受理，不带流
  if (text.includes('/completion/commands')) {
    return new Response(JSON.stringify({ code: 1, data: { sessionId: SID, turnId: TID }, errMsg: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  // 会话级流：握手后发 READY（真实协议如此），随后保持打开
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      streamCtl = c;
      c.enqueue(new TextEncoder().encode(frame('READY', { rootSessionId: SID })));
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const tick = () => new Promise<void>(r => setImmediate(r));

test('缺陷1：首轮发消息时，流式事件必须驱动渲染副作用更新（而非仅能惰性重读）', async () => {
  setActivePinia(createPinia());
  const scope = effectScope();
  const { useChatView } = await import('../src/views/chat/useChatView');

  let view: any;
  scope.run(() => { view = useChatView(); });
  view.localActiveId.value = null;

  // 模拟真实模板：渲染副作用订阅 displayedMessages，只有依赖变更才会重跑
  const rendered: number[] = [];
  const renderedTexts: string[] = [];
  const renderedProcess: string[][] = [];
  scope.run(() => { watchEffect(() => {
    rendered.push(view.displayedMessages.value.length);
    renderedTexts.push(view.displayedMessages.value.filter((message: any) => message.role === 'assistant').map((message: any) => message.content).join(''));
    renderedProcess.push(view.displayedMessages.value.filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => message.processTimeline ?? [])
      .map((item: any) => `${item.id}:${item.tool?.status ?? item.step?.content ?? item.message?.text}`));
  }); });
  // 首屏渲染先读一次，缓存 computed
  assert.equal(view.displayedMessages.value.length, 0);

  const sendPromise = view.handleSendMessage('1', false, null, null, null);
  for (let i = 0; i < 50 && !streamCtl; i++) await tick();
  assert.ok(streamCtl, '会话级事件流应已建立');
  await sendPromise;

  (streamCtl as any).enqueue(new TextEncoder().encode(frame('EXECUTION_STARTED', { type: 'EXECUTION_STARTED', executionId: 'e1', timestamp: '2026-10-06T06:57:56.135Z', metaData: { sessionId: SID, rootSessionId: SID, turnId: TID } })));
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('PARTIAL_TEXT', { type: 'PARTIAL_TEXT', responseId: '101', order: 1, offset: 0, content: '你发送的是「1」', executionId: 'e1', timestamp: '2026-10-06T06:57:57.000Z', metaData: { sessionId: SID, rootSessionId: SID, turnId: TID } })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();
  assert.equal(renderedTexts.at(-1), '', '未确认用途不能进入正文');
  assert.deepEqual(renderedProcess.at(-1), ['text:101:你发送的是「1」'], '首段文本在完成前可见');
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('PARTIAL_TEXT', { type: 'PARTIAL_TEXT', responseId: '101', order: 1, offset: 8, content: '，收到', executionId: 'e1', timestamp: '', metaData: { sessionId: SID, rootSessionId: SID, turnId: TID } })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();
  assert.equal(renderedTexts.at(-1), '');
  assert.deepEqual(renderedProcess.at(-1), ['text:101:你发送的是「1」，收到'], '第二段触发真实 Vue 渲染更新');

  const runtime = { executionId: 'e1', timestamp: '', metaData: { sessionId: SID, rootSessionId: SID, turnId: TID } };
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('AI_MESSAGE', { ...runtime, type: 'AI_MESSAGE', responseId: '101',
    order: 1, placement: 'PROCESS', text: '你发送的是「1」，收到' })));
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('TOOL_CALL', { ...runtime, type: 'TOOL_CALL', responseId: '101',
    requestId: 'c-live', toolName: AgentToolName.ReadFile, order: 2, args: '{"path":"input.md"}' })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();
  assert.ok(renderedProcess.at(-1)?.includes('tool:c-live:calling'), 'SSE 工具开始在快照前触发渲染');
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('TOOL_COMPLETED', { ...runtime, type: 'TOOL_COMPLETED', responseId: '101',
    requestId: 'c-live', toolName: AgentToolName.ReadFile, order: 2, resultStatus: 'COMPLETED', output: '读取结果' })));
  (streamCtl as any).enqueue(new TextEncoder().encode(frame('PARTIAL_THINKING', { ...runtime, type: 'PARTIAL_THINKING',
    responseId: '102', order: 1000, offset: 0, content: '末尾的新思考' })));
  for (let i = 0; i < 20; i++) await tick();
  await nextTick();
  assert.equal(renderedTexts.at(-1), '', '过程用途确认后仍不进入正文');
  assert.deepEqual(renderedProcess.at(-1), ['text:101:你发送的是「1」，收到', 'tool:c-live:success', 'thinking:102:末尾的新思考'],
    '后续思考在工具之后打印，收尾更新原工具条');

  const lastRendered = rendered[rendered.length - 1];
  assert.ok(lastRendered >= 2, `渲染副作用应看到 user+assistant 两条，实际最后渲染=${lastRendered}，序列=${JSON.stringify(rendered)}`);

  scope.stop();
});

test('缺陷2：loadInitialData 必须把会话列表写回 localSessions（左侧列表数据源）', async () => {
  setActivePinia(createPinia());
  sessions.length = 0;
  const { useChatWorkspace } = await import('../src/views/chat/useChatWorkspace');

  const localSessions = ref<any[]>([]);
  const ws = useChatWorkspace({
    localSessions: localSessions as any,
    localModels: ref([]) as any,
    localWorkspaces: ref([]) as any,
    localActiveWorkspaceId: ref(null),
  });

  await ws.loadInitialData();

  assert.ok(sessions.includes('list'), '初始化应请求会话列表接口');
  assert.equal(localSessions.value.length, 1, '初始化后左侧会话列表应包含 1 条');
  assert.equal(localSessions.value[0].id, SID);
});
