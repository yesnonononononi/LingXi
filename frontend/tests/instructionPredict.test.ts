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
  turnTerminal: true,
  enabled: true,
};

test('子会话判定：根会话的 rootSessionId 为 0 或等于自身都不算子会话', () => {
  assert.equal(isSubSessionOf('0', '11'), false);
  assert.equal(isSubSessionOf('11', '11'), false);
  assert.equal(isSubSessionOf('11', '22'), true);
  // 未加载出会话（rootSessionId 缺失）时不冤枉成子会话，交给后端裁决。
  assert.equal(isSubSessionOf(null, '22'), false);
});

test('只要有一项不成立就不发请求：功能关闭 / 未终态 / 无轮次 / 子会话', () => {
  assert.deepEqual(resolvePredictTarget(validTarget), {sessionId: '11', turnId: '22'});
  assert.equal(resolvePredictTarget({...validTarget, enabled: false}), null);
  assert.equal(resolvePredictTarget({...validTarget, turnTerminal: false}), null);
  assert.equal(resolvePredictTarget({...validTarget, turnId: null}), null);
  assert.equal(resolvePredictTarget({...validTarget, sessionId: null}), null);
  // 子会话：后端会直接拒绝，前端据此省掉必然失败的请求。
  assert.equal(resolvePredictTarget({...validTarget, rootSessionId: '9'}), null);
});

test('终态后静止 5 秒才请求一次，结果直接来自后端', async context => {
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
    turnTerminal: ref(true),
    enabled: ref(true),
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
    turnTerminal: ref(true),
    enabled: ref(true),
  });
  await tick();
  sessionId.value = '33';
  await tick();

  context.mock.timers.tick(5_000);
  await tick();
  assert.deepEqual(calls, ['33'], '切会话后只允许最新目标发请求');
  assert.equal(suggestion.value, '建议-33');
});

test('后端返回空或业务失败：建议保持为空且不抛错', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let payload: {code: number; data: unknown} = {code: 1, data: null};
  context.mock.method(InstructionAPI, 'next', async () => payload);

  const {suggestion} = useInstructionPredict({
    sessionId: ref<string | null>('11'),
    rootSessionId: ref<string | null>('0'),
    turnId: ref<string | null>('22'),
    turnTerminal: ref(true),
    enabled: ref(true),
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
    turnTerminal: ref(true),
    enabled: ref(true),
  });
  await tick();
  context.mock.timers.tick(5_000);
  await tick();
  assert.equal(second.suggestion.value, '', '业务失败不是建议，别把错误当预测塞给用户');
});