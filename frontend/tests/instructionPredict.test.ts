import assert from 'node:assert/strict';
import test from 'node:test';
import {ref} from 'vue';
import {InstructionAPI} from '../src/services/instruction';
import {
  isSubSessionOf,
  resolvePredictTarget,
  useInstructionPredict,
} from '../src/composables/useInstructionPredict';

/** 让 watch 的调度与请求的 Promise 都跑完，再断言。 */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
};

/** 一段「功能开启 + 根会话 + 已终态」的合法输入，各用例只改自己关心的那一项。 */
const validTarget = {
  sessionId: '11',
  rootSessionId: '0',
  turnId: '22',
  turnCompleted: true,
  enabled: true,
  inputEmpty: true,
};

test('子会话判定：根会话的 rootSessionId 为 0 或等于自身都不算子会话', () => {
  assert.equal(isSubSessionOf('0', '11'), false);
  assert.equal(isSubSessionOf('11', '11'), false);
  assert.equal(isSubSessionOf('11', '22'), true);
  // 未加载出会话（rootSessionId 缺失）时不冤枉成子会话，交给后端裁决。
  assert.equal(isSubSessionOf(null, '22'), false);
});

test('只要有一项不成立就不发请求：功能关闭 / 未正常完成 / 无轮次 / 子会话 / 有草稿', () => {
  assert.deepEqual(resolvePredictTarget(validTarget), {sessionId: '11', turnId: '22'});
  assert.equal(resolvePredictTarget({...validTarget, enabled: false}), null);
  // 失败/取消虽然也是终态，但下文不可信：只有正常完成才算「会话空闲」。
  assert.equal(resolvePredictTarget({...validTarget, turnCompleted: false}), null);
  assert.equal(resolvePredictTarget({...validTarget, turnId: null}), null);
  assert.equal(resolvePredictTarget({...validTarget, sessionId: null}), null);
  // 输入框有草稿：用户已经在写了，预测没有意义。
  assert.equal(resolvePredictTarget({...validTarget, inputEmpty: false}), null);
  // 子会话：后端会直接拒绝，前端据此省掉必然失败的请求。
  assert.equal(resolvePredictTarget({...validTarget, rootSessionId: '9'}), null);
});

test('正常完成后静止 5 秒才请求一次，结果直接来自后端', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const calls: string[] = [];
  context.mock.method(InstructionAPI, 'next', async (sessionId: unknown, turnId: unknown) => {
    calls.push(`${sessionId}/${turnId}`);
    return {code: 1, data: {sessionId: 11, turnId: 22, nextInstruction: '  继续跑测试  '}};
  });

  const sessionId = ref<string | null>('11');
  const {suggestion} = useInstructionPredict({
    sessionId,
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnCompleted: ref(true),
    enabled: ref(true),
    inputEmpty: ref(true),
  });
  await tick();
  assert.deepEqual(calls, [], '刚终态时不能立刻发请求：用户可能正在自己打字');

  context.mock.timers.tick(4_999);
  await tick();
  assert.deepEqual(calls, [], '未静止满 5 秒不发请求');

  context.mock.timers.tick(1);
  await tick();
  assert.deepEqual(calls, ['11/22']);
  assert.equal(suggestion.value, '继续跑测试', '结果只做 trim，不改写后端内容');
});

test('静止期内切换会话：旧请求不再发出，迟到结果也不覆盖新建议', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const calls: string[] = [];
  context.mock.method(InstructionAPI, 'next', async (sessionId: unknown) => {
    calls.push(String(sessionId));
    return {code: 1, data: {sessionId, turnId: 22, nextInstruction: `建议-${sessionId}`}};
  });

  const sessionId = ref<string | null>('11');
  const {suggestion} = useInstructionPredict({
    sessionId,
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnCompleted: ref(true),
    enabled: ref(true),
    inputEmpty: ref(true),
  });
  await tick();
  sessionId.value = '33';
  await tick();

  context.mock.timers.tick(5_000);
  await tick();
  assert.deepEqual(calls, ['33'], '切会话后只允许最新目标发请求');
  assert.equal(suggestion.value, '建议-33');
});

test('输入框有草稿就不计时；清空草稿后重新计时 5 秒', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const calls: string[] = [];
  context.mock.method(InstructionAPI, 'next', async () => {
    calls.push('call');
    return {code: 1, data: {sessionId: 11, turnId: 22, nextInstruction: '继续'}};
  });

  const inputEmpty = ref(false);
  const {suggestion} = useInstructionPredict({
    sessionId: ref<string | null>('11'),
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnCompleted: ref(true),
    enabled: ref(true),
    inputEmpty,
  });
  await tick();
  context.mock.timers.tick(60_000);
  await tick();
  assert.deepEqual(calls, [], '用户正在打草稿，一条预测都不该发');

  // 用户放弃草稿（清空）→ 从零重新计时，而不是把之前的 60 秒算进去。
  inputEmpty.value = true;
  await tick();
  context.mock.timers.tick(4_999);
  await tick();
  assert.deepEqual(calls, [], '清空草稿也要重新等满 5 秒');
  context.mock.timers.tick(1);
  await tick();
  assert.deepEqual(calls, ['call']);
  assert.equal(suggestion.value, '继续');
});

test('目标反复切换：旧计时器必须被回收，只在最后一次目标上发一次请求', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const calls: string[] = [];
  context.mock.method(InstructionAPI, 'next', async (sessionId: unknown) => {
    calls.push(String(sessionId));
    return {code: 1, data: {sessionId, turnId: 22, nextInstruction: '建议'}};
  });

  const sessionId = ref<string | null>('11');
  const turnCompleted = ref(true);
  const inputEmpty = ref(true);
  useInstructionPredict({
    sessionId,
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnCompleted,
    enabled: ref(true),
    inputEmpty,
  });
  await tick();
  // 5 秒内来回切 10 次：如果每次切换都留下一个计时器，下面的 tick 会打出 10 个请求。
  for (const id of ['22', '33', '44', '55', '66', '77', '88', '99', '111', '222']) {
    sessionId.value = id;
    await tick();
  }
  assert.deepEqual(calls, [], '切换期间的计时器都得被回收');

  context.mock.timers.tick(5_000);
  await tick();
  assert.deepEqual(calls, ['222'], '只有最后一个目标计时到点，且只发一次');
});

test('输入区接线契约：建议走占位文本、Tab 补全、空态上抛给宿主当闸门', async () => {
  // 这三处是「看得见的界面」，跑不起 DOM 的用例只能钉源码接线：任何一处被删掉，
  // 功能都会静默退化成「预测拿到但用户永远看不见」，比报错更难发现。
  const fs = await import('node:fs/promises');
  const input = await fs.readFile(new URL('../src/components/chat/ChatInputArea.vue', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../src/views/chat/ChatView.vue', import.meta.url), 'utf8');
  const i18n = await fs.readFile(new URL('../src/i18n/messages.ts', import.meta.url), 'utf8');

  assert.match(input, /predictionHint/, '占位文本必须由预测建议构成');
  assert.match(input, /placeholder="inputPlaceholder"/);
  assert.match(input, /e\.key === 'Tab'[\s\S]{0,160}applyPrediction\(\)/, 'Tab 必须触发补全');
  assert.match(input, /updateDraftEmpty/, '输入框空态必须上抛');
  assert.match(view, /inputEmpty: computed\(\(\) => draftEmpty\.value\)/, '空态必须接进预测闸门');
  // 闸门是「正常完成」而不是「终态」：失败/取消不能触发预测。
  assert.match(view, /isCompletedTurnStatus\(String\(turn\.status\)\)/, '必须按 COMPLETED 判定，不能用终态');
  assert.doesNotMatch(view, /isTerminalTurnStatus\(String\(turn\.status\)\)/, '别把闸门悄悄退回终态');
  assert.match(i18n, /predictionHint: '\(tab补全\)'/);
});

test('后端返回空或业务失败：建议保持为空且不抛错', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let payload: {code: number; data: unknown} = {code: 1, data: null};
  context.mock.method(InstructionAPI, 'next', async () => payload);

  const {suggestion} = useInstructionPredict({
    sessionId: ref<string | null>('11'),
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnCompleted: ref(true),
    enabled: ref(true),
    inputEmpty: ref(true),
  });
  await tick();
  context.mock.timers.tick(5_000);
  await tick();
  assert.equal(suggestion.value, '');

  payload = {code: 0, data: {sessionId: 11, turnId: 22, nextInstruction: '不该显示'}};
  const second = useInstructionPredict({
    sessionId: ref<string | null>('44'),
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('55'),
    turnCompleted: ref(true),
    enabled: ref(true),
    inputEmpty: ref(true),
  });
  await tick();
  context.mock.timers.tick(5_000);
  await tick();
  assert.equal(second.suggestion.value, '', '业务失败不是建议，别把错误当预测塞给用户');
});