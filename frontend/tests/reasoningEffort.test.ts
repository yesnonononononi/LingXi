import test from 'node:test';
import assert from 'node:assert/strict';
import { setActivePinia, createPinia } from 'pinia';
import { UserConfigAPI } from '../src/services/userConfig';
import { useReasoningEffort } from '../src/composables/useReasoningEffort';
import type { ReasoningEffort } from '../src/types/chat';
import type { Result } from '../src/services/types';

setActivePinia(createPinia());

test('恢复后端档位不触发保存，未加载前禁止发送', async (t) => {
  const writes: unknown[] = [];
  t.mock.method(UserConfigAPI, 'updateCurrent', async (payload: unknown) => {
    writes.push(payload);
    return { code: 1 };
  });
  const state = useReasoningEffort();
  assert.equal(state.reasoningEffortPending.value, true);
  await state.handleUpdateReasoningEffort('max');
  for (const value of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    state.syncReasoningEffort(value);
    assert.equal(state.reasoningEffort.value, value);
    assert.equal(state.reasoningEffortPending.value, false);
  }
  state.syncReasoningEffort(undefined);
  assert.equal(state.reasoningEffort.value, 'low');
  assert.deepEqual(writes, []);
});

test('连续选择串行保存最终档位，保存期间不采纳旧的配置响应', async (t) => {
  const writes: ReasoningEffort[] = [];
  let finishFirst!: (result: Result<void>) => void;
  t.mock.method(UserConfigAPI, 'updateCurrent', (payload: { reasoningEffort: ReasoningEffort }) => {
    writes.push(payload.reasoningEffort);
    if (writes.length === 1) {
      return new Promise<Result<void>>(resolve => { finishFirst = resolve; });
    }
    return Promise.resolve({ code: 1 });
  });
  const state = useReasoningEffort();
  state.syncReasoningEffort('low');
  const save = state.handleUpdateReasoningEffort('high');
  await state.handleUpdateReasoningEffort('medium');
  await state.handleUpdateReasoningEffort('xhigh');
  state.syncReasoningEffort('low');
  assert.equal(state.reasoningEffort.value, 'xhigh');
  assert.equal(state.reasoningEffortPending.value, true);
  assert.deepEqual(writes, ['high']);
  finishFirst({ code: 1 });
  await save;
  assert.deepEqual(writes, ['high', 'xhigh']);
  assert.equal(state.reasoningEffortPending.value, false);
});

test('业务错误回退至最后保存成功的档位，允许重新选择', async (t) => {
  let calls = 0;
  t.mock.method(UserConfigAPI, 'updateCurrent', async () => ({ code: ++calls === 1 ? 0 : 1 }));
  t.mock.method(console, 'error', () => {});
  const state = useReasoningEffort();
  state.syncReasoningEffort('medium');
  await state.handleUpdateReasoningEffort('max');
  assert.equal(state.reasoningEffort.value, 'medium');
  assert.match(state.reasoningEffortError.value, /保存失败/);
  assert.equal(state.reasoningEffortPending.value, false);
  await state.handleUpdateReasoningEffort('max');
  assert.equal(state.reasoningEffort.value, 'max');
  assert.equal(state.reasoningEffortError.value, '');
});

test('网络异常恢复已保存的档位并解除发送禁用', async (t) => {
  t.mock.method(UserConfigAPI, 'updateCurrent', async () => { throw new Error('连接失败'); });
  t.mock.method(console, 'error', () => {});
  const state = useReasoningEffort();
  state.syncReasoningEffort('none');
  await state.handleUpdateReasoningEffort('high');
  assert.equal(state.reasoningEffort.value, 'none');
  assert.equal(state.reasoningEffortPending.value, false);
  assert.match(state.reasoningEffortError.value, /保存失败/);
});
