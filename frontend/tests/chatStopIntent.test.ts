/**
 * 受理窗口内「取消生成」必须真的取消。
 *
 * <p><b>缺陷本体</b>：发送到首字之间，服务端可能还没有任何可取消对象（受理请求尚未到达，
 * 或仍停在 {@code requestPreparer.prepare()}）。旧实现点取消只做两件事：发一次 stop、
 * 并 abort 自己那条受理 POST。前者在空转（随后 {@code beginRoot} 的「新一轮重新开放受理」
 * 会把 cancelled 清掉），后者根本不撤销服务端的受理，还顺手丢掉了唯一能对账的回执 ——
 * 于是「取消按钮没反应」，模型照跑出首字。</p>
 *
 * <p><b>修复后的契约</b>（每条都对应下面一个用例，删掉对应分支即红）：</p>
 * <ol>
 *   <li>受理请求已发出：<b>不得</b> abort（abort 撤不掉服务端的活，只会丢回执）；</li>
 *   <li>回执到手（＝服务端已 beginRoot 登记）：<b>必须补发一次 stop</b>，这一次才必然命中；</li>
 *   <li>受理请求还没发出：本地中止即可，既不发受理也不发 stop；</li>
 *   <li>回执是「待发送」：撤销那条排队项，不留幽灵；</li>
 *   <li>补偿 stop 失败：必须可见，且不得把异常抛给调用链；</li>
 *   <li>视图层：取消导致命令未发出时，乐观气泡必须回滚。</li>
 * </ol>
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createPinia, setActivePinia} from 'pinia';
import {computed, ref, type Ref} from 'vue';
import {AgentAPI} from '../src/services/agent';
import {useChatSending} from '../src/views/chat/useChatSending';
import type {ChatCommand} from '../src/services/dto/chat_command';
import type {ChatSession} from '../src/types/chat';

// ---- 环境桩（与 singleSessionStream.test.ts 同形，Node 里没有浏览器上下文） ----
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
const T1 = '2107364703113183232';

const tick = () => new Promise<void>(r => setImmediate(r));
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await tick(); };

const mkSession = (): Ref<ChatSession> => ref<ChatSession>({
  id: ROOT, title: '会话', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [],
  messages: [], runStatus: 'IDLE',
} as ChatSession);

const command = (): ChatCommand => ({
  input: '你好', sessionId: ROOT, workDir: '', modelId: 1, workspaceId: 1, agentId: 1, requirePlan: false,
} as unknown as ChatCommand);

/** 受理回执（成功）与待发送回执的桩返回值。 */
const accepted = () => ({code: 1, data: {sessionId: ROOT, turnId: T1}, errMsg: null});
const queued = () => ({code: 1, data: {sessionId: ROOT, pendingId: 'p-1'}, errMsg: null});

function mkSending(session: Ref<ChatSession>, ensureSubscribed: () => Promise<boolean>) {
  return useChatSending({
    currentActiveSession: computed(() => session.value),
    ensureSubscribed,
    reconnectStream: () => {},
    reconcileSessionAfterStream: async () => {},
    scrollToBottom: () => {},
  });
}

/* ------------------------------------------------------------------ */

test('1. 受理在途时取消：不 abort 受理请求，回执到手后补发 stop（补偿重放）', async (t) => {
  setActivePinia(createPinia());
  let capturedSignal: AbortSignal | undefined;
  let releaseAccept: (() => void) | null = null;
  const accept = t.mock.method(AgentAPI, 'acceptCommand', async (_cmd: unknown, signal?: AbortSignal) => {
    capturedSignal = signal;
    await new Promise<void>(resolve => { releaseAccept = resolve; });
    return accepted();
  });
  const stop = t.mock.method(AgentAPI, 'stop', async () => {});

  const session = mkSession();
  const sending = mkSending(session, async () => true);

  const pending = sending.handleSendMessage(command());
  await settle();
  assert.equal(accept.mock.callCount(), 1, '受理请求应当已经发出');
  assert.equal(sending.isSubmitting.value, true, '受理在途必须禁重复点击');

  sending.handleStopGeneration();
  await settle();

  // ★ 核心：已发出的受理请求不能被 abort —— 它撤不掉服务端的工作，只会丢掉唯一能对账的回执
  assert.equal(capturedSignal?.aborted, false, '受理请求已发出时取消不得 abort 它');
  assert.equal(stop.mock.callCount(), 1, '取消应当立刻发一次停止（能停住已登记的执行最好）');

  (releaseAccept as unknown as () => void)();
  const receipt = await pending;

  assert.equal(stop.mock.callCount(), 2, '★ 回执到手后必须补发一次停止：这一次必然命中已登记的执行');
  assert.deepEqual(receipt, {sessionId: ROOT, turnId: T1}, '补偿不得改变受理回执');
  assert.equal(session.value.runStatus, 'IDLE', '已被要求停止的轮次不得乐观写成 RUNNING');
  assert.equal(sending.isSending.value, false, '取消后不应停留在生成中');
});

test('2. 受理还没发出时取消：中止本地请求，既不提交也不发 stop', async (t) => {
  setActivePinia(createPinia());
  let releaseReady: (() => void) | null = null;
  const accept = t.mock.method(AgentAPI, 'acceptCommand', async () => accepted());
  const stop = t.mock.method(AgentAPI, 'stop', async () => {});

  const session = mkSession();
  const sending = mkSending(session, () => new Promise<boolean>(resolve => {
    releaseReady = () => resolve(true);
  }));

  const pending = sending.handleSendMessage(command());
  await settle();
  assert.equal(accept.mock.callCount(), 0, '就绪等待期间不应发出受理请求');

  sending.handleStopGeneration();
  await settle();
  assert.equal(stop.mock.callCount(), 0, '命令还没发出，不需要任何服务端停止请求');

  (releaseReady as unknown as () => void)();
  assert.equal(await pending, null, '取消后的发送不得被视为成功');
  assert.equal(accept.mock.callCount(), 0, '★ 取消后绝不能把命令补发出去');
  assert.equal(sending.cancelRequested.value, true, '视图层据此回滚乐观气泡');
  assert.equal(sending.isSubmitting.value, false, '取消后必须解除提交中');
});

test('3. 未点取消：不发任何停止请求，受理后进入运行中（回归保护）', async (t) => {
  setActivePinia(createPinia());
  const accept = t.mock.method(AgentAPI, 'acceptCommand', async () => accepted());
  const stop = t.mock.method(AgentAPI, 'stop', async () => {});

  const session = mkSession();
  const sending = mkSending(session, async () => true);

  const receipt = await sending.handleSendMessage(command());

  assert.deepEqual(receipt, {sessionId: ROOT, turnId: T1});
  assert.equal(accept.mock.callCount(), 1);
  assert.equal(stop.mock.callCount(), 0, '没有取消就不许发停止请求');
  assert.equal(session.value.runStatus, 'RUNNING', '正常受理必须进入运行中');
  assert.equal(sending.cancelRequested.value, false);
});

test('4. 取消时回执是「待发送」：撤销那条排队项，不留幽灵', async (t) => {
  setActivePinia(createPinia());
  let releaseAccept: (() => void) | null = null;
  t.mock.method(AgentAPI, 'acceptCommand', async () => {
    await new Promise<void>(resolve => { releaseAccept = resolve; });
    return queued();
  });
  const stop = t.mock.method(AgentAPI, 'stop', async () => {});
  const cancelPending = t.mock.method(AgentAPI, 'cancelPendingCommand', async () => ({code: 1, data: undefined}));

  const session = mkSession();
  const sending = mkSending(session, async () => true);

  const pending = sending.handleSendMessage(command());
  await settle();
  sending.handleStopGeneration();
  await settle();
  assert.equal(stop.mock.callCount(), 1, '取消仍应立即请求停止（会话可能正忙）');

  (releaseAccept as unknown as () => void)();
  const receipt = await pending;

  assert.deepEqual(receipt, {sessionId: ROOT, pendingId: 'p-1'}, '待发送回执原样返回');
  assert.equal(cancelPending.mock.callCount(), 1, '★ 被取消的那条不得留在待发送队列里');
  assert.deepEqual(cancelPending.mock.calls[0].arguments, [ROOT, 'p-1']);
});

test('5. 补偿 stop 失败：必须可见，且不得把异常抛给调用链', async (t) => {
  setActivePinia(createPinia());
  const consoleError = t.mock.method(console, 'error', () => {});
  let releaseAccept: (() => void) | null = null;
  let stopCalls = 0;
  t.mock.method(AgentAPI, 'acceptCommand', async () => {
    await new Promise<void>(resolve => { releaseAccept = resolve; });
    return accepted();
  });
  // 只有补发那一次失败：即时那次是空转（服务端可能还没有对象），不构成提示来源
  t.mock.method(AgentAPI, 'stop', async () => {
    stopCalls += 1;
    if (stopCalls === 1) return;
    throw new Error('boom');
  });

  const session = mkSession();
  const sending = mkSending(session, async () => true);

  const pending = sending.handleSendMessage(command());
  await settle();
  sending.handleStopGeneration();
  await settle();
  assert.equal(sending.sendFailureNotice.value, null, '第一次（即时）停止成功时不得提前报警');

  (releaseAccept as unknown as () => void)();
  const receipt = await pending;

  assert.equal(stopCalls, 2, '必须补发一次停止');
  assert.deepEqual(receipt, {sessionId: ROOT, turnId: T1}, '停止失败不得吞掉受理回执');
  assert.ok(sending.sendFailureNotice.value, '补偿停止失败必须给出可见提示，不得静默');
  assert.equal(sending.sendFailureNotice.value?.message.includes('停止'), true);
  assert.ok(consoleError.mock.callCount() >= 1, '失败必须留排查日志');
});

test('6. 视图层：取消导致命令未发出时必须回滚乐观气泡', () => {
  const source = readFileSync(new URL('../src/views/chat/useChatView.ts', import.meta.url), 'utf8');
  assert.match(source, /const dropOptimisticMessage = /, '缺少乐观气泡回滚helper');
  assert.match(
    source,
    /if \(sending\.cancelRequested\.value && optimistic\) dropOptimisticMessage\(/,
    '★ 取消后必须撤掉乐观气泡，否则留下一条永远等不到回答的幽灵提问',
  );
});
