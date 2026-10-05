import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { attachStreamV3, detachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot } from './harness/streamV3Harness';

/**
 * 终态对账的三条边界（第二轮复核批次一第 3 点）。
 *
 * <p>D6 只解决了「连续两次完成不触发」—— 把 watch 返回值从布尔换成终态执行 id 集合。
 * 但集合身份还带两个没被验证过的性质：**减员不等于新的收尾**、**跨根不得串扰**。
 * 本文件把这三条钉成回归用例，避免下次改 watch 时又退回「有终态就触发」。</p>
 */

async function attachWithSession(rootId: string) {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3(rootId);
  await flush();
  harness.server.push(rootId, readyFrame(`terminal-${rootId}`));
  await flush();
  harness.bootstrap.resolveNext(bootstrapSnapshot({ rootSessionId: rootId }));
  await flush();
  return { harness, store, finish() { detachStreamV3(session); harness.teardown(); } };
}

/**
 * 装配一个已进入会话的 useChatView。
 *
 * <p><b>为什么在网络边界观察对账而不是替换内部函数</b>：`reconcileSessionAfterStream` 是
 * `useChatHistory` 的闭包，`useChatView` 只是在 setup 时把它取出来；外部往实例上塞同名属性
 * 不会改变 watch 里引用的那个绑定。对账本身的第一件事是 `fetchSessionTree`，因此把该调用
 * 当作「对账已触发」的观测点既准确又不侵入实现。</p>
 */
async function setupChatView() {
  const harness = createHarness();
  const scope = effectScope();
  const originals = {
    detail: chatApi.fetchSessionDetail,
    models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs,
    tree: (chatApi as any).fetchSessionTree,
    messages: (chatApi as any).fetchSessionMessages,
  };
  /** 对账发起次数与根 id：每次对账必然先查一次会话树。 */
  const reconciled: string[] = [];
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;

  (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
    id, title: id, rawRecords: [], turns: {}, subSessions: [], runStatus: 'IDLE' } });
  (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchSessionTree = async (id: string) => {
    reconciled.push(id);
    return { ok: true, data: { rootSessionId: id, root: { id, runStatus: 'IDLE' },
      subSessions: [], tokenUsage: null } };
  };
  (chatApi as any).fetchSessionMessages = async (id: string) => ({ ok: true, data: {
    records: [], turns: {}, nextCursor: null, hasMore: false } });

  return {
    harness, scope, view, reconciled,
    async enter(rootId: string, extraSessions: any[] = []) {
      await view.handleSelectSession(rootId);
      await flush();
      harness.server.push(rootId, readyFrame(`terminal-${rootId}`));
      await flush();
      harness.bootstrap.resolveNext(bootstrapSnapshot({
        rootSessionId: rootId,
        sessions: [{ id: rootId, version: '1', runStatus: 'IDLE' } as any, ...extraSessions],
      }));
      await flush();
    },
    teardown() {
      scope.stop(); harness.teardown();
      chatApi.fetchSessionDetail = originals.detail;
      chatApi.fetchModels = originals.models;
      chatApi.fetchUserConfigs = originals.configs;
      (chatApi as any).fetchSessionTree = originals.tree;
      (chatApi as any).fetchSessionMessages = originals.messages;
    },
  };
}

/**
 * 推一条 EXECUTION_UPDATED 帧，切换某执行的状态。
 *
 * <p>载荷形状必须与后端一致：状态名在 `data.state`，`executionId` / `sessionId` 在帧顶层。</p>
 */
function pushExecution(server: any, rootId: string, executionId: string, sessionId: string, state: string) {
  server.push(rootId, frame('EXECUTION_UPDATED', { state }, { sessionId, executionId }));
}

test('终态对账：SUSPENDED 不是终态，不得触发对账', async () => {
  const ctx = await setupChatView();
  try {
    await ctx.enter('100');
    const baseline = ctx.reconciled.length;
    pushExecution(ctx.harness.server, '100', 'e1', '100', 'SUSPENDED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline, '挂起只是暂停等待审批，本轮并未收尾');
  } finally { ctx.teardown(); }
});

test('终态对账：SUSPENDED → RUNNING → COMPLETED 只在真正终结时收尾一次', async () => {
  const ctx = await setupChatView();
  try {
    await ctx.enter('100');
    const baseline = ctx.reconciled.length;

    pushExecution(ctx.harness.server, '100', 'e1', '100', 'SUSPENDED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline, '挂起不得收尾');

    pushExecution(ctx.harness.server, '100', 'e1', '100', 'RUNNING');
    await flush();
    assert.equal(ctx.reconciled.length, baseline, '恢复运行不得收尾');

    pushExecution(ctx.harness.server, '100', 'e1', '100', 'COMPLETED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 1, '进入终态必须恰好收尾一次');
  } finally { ctx.teardown(); }
});

test('终态对账：多执行并发时各自终结各触发一次（覆盖新增，不含减员）', async () => {
  const ctx = await setupChatView();
  try {
    await ctx.enter('100');
    const baseline = ctx.reconciled.length;

    pushExecution(ctx.harness.server, '100', 'e1', '100', 'COMPLETED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 1, '第一个执行终结收尾一次');

    // e2 仍在跑：终态集合从 {e1} 变 {e1}（e2 未终结），不应触发。
    pushExecution(ctx.harness.server, '100', 'e2', '100', 'RUNNING');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 1, '另一个执行启动不改终态集合');

    pushExecution(ctx.harness.server, '100', 'e2', '100', 'COMPLETED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 2, '第二个执行终结必须再收尾一次');

    // ⚠️ 范围声明：本用例只覆盖「终态集合递增」。**没有**构造减员（如某执行被重新标回 RUNNING
    //    导致集合变小）—— 那种情况下 watch 返回值同样变化、也会触发一次对账，但语义属于
    //    「状态回退后的重新对齐」，与「新执行收尾」不是一回事，未在此验证。
  } finally { ctx.teardown(); }
});

test('终态对账：别的根会话的执行终结，不得触发本会话对账', async () => {
  const ctx = await setupChatView();
  try {
    // 子会话 200 归属根 100；另一个根 300 及其子会话 400 与本会话无关。
    await ctx.enter('100', [{ id: '200', rootSessionId: '100', version: '1' } as any]);
    const baseline = ctx.reconciled.length;

    // 子会话 200（同根）：应当触发。
    pushExecution(ctx.harness.server, '100', 'child-e1', '200', 'COMPLETED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 1, '同根子会话终结应触发对账');

    // 根 300 的执行：不同根，不得触发。
    pushExecution(ctx.harness.server, '100', 'other-root-e1', '300', 'COMPLETED');
    await flush();
    assert.equal(ctx.reconciled.length, baseline + 1, '别的根会话的终态不得触发本会话对账');
  } finally { ctx.teardown(); }
});

test('终态对账：切回同一根时身份串重放，触发次数可精确预期（不是"不重复"）', async () => {
  const ctx = await setupChatView();
  try {
    await ctx.enter('100');
    pushExecution(ctx.harness.server, '100', 'e1', '100', 'COMPLETED');
    await flush();
    const afterFirst = ctx.reconciled.length;
    assert.equal(afterFirst, 1, '旧根收尾一次');

    // 切到另一个空闲会话：根变了，身份串从 `100:e1` 变成空串（无终态）。
    // 空串不触发回调，所以这一次切换不该产生对账。
    await ctx.enter('300');
    await flush();
    assert.equal(ctx.reconciled.length, afterFirst, '进入无终态的新会话不得补一次收尾');

    // ── 诚实说明当前语义 ────────────────────────────────────────────────────
    // 切回 100 时身份串从「空」变回 `100:e1`，watch 认为返回值**变化**，于是再对账一次。
    // 这是**显示恢复带来的重放**，不是「新执行收尾」—— 同一个 e1 没有第二次终结。
    // 本用例不声称「不重复」，而是把次数钉死：若将来改成「已对账过的 (根,集合) 不重放」，
    // 下面的期望值会失败，改动者必须显式确认这是有意为之。
    await ctx.enter('100');
    await flush();
    assert.equal(ctx.reconciled.length, afterFirst + 1,
      '切回同一根会重放一次对账（身份串由空变回）；这是恢复显示，不是新的执行收尾');
  } finally { ctx.teardown(); }
});

test('终态对账：同一根连续三个执行终结，每次都必须收尾', async () => {
  const ctx = await setupChatView();
  try {
    await ctx.enter('100');
    const baseline = ctx.reconciled.length;
    for (const id of ['e1', 'e2', 'e3']) {
      pushExecution(ctx.harness.server, '100', id, '100', 'COMPLETED');
      await flush();
    }
    assert.equal(ctx.reconciled.length, baseline + 3, '三连终结必须收尾三次（集合身份而非布尔）');
  } finally { ctx.teardown(); }
});
