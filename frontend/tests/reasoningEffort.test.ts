import test from 'node:test';
import assert from 'node:assert/strict';
import { setActivePinia, createPinia } from 'pinia';
import { UserConfigAPI } from '../src/services/userConfig';
import { useReasoningEffort } from '../src/composables/useReasoningEffort';
import { useUserConfigStore } from '../src/stores/userConfigStore';
import { t as translate } from '../src/i18n';
import type { ReasoningEffort } from '../src/types/chat';
import type { Result } from '../src/services/types';

test.beforeEach(() => setActivePinia(createPinia()));

function restoreEffort(value?: ReasoningEffort): void {
  const store = useUserConfigStore();
  store.applyConfig({ reasoningEffort: value } as Parameters<typeof store.applyConfig>[0]);
  store.loaded = true;
}

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
    restoreEffort(value);
    assert.equal(state.reasoningEffort.value, value);
    assert.equal(state.reasoningEffortPending.value, false);
  }
  restoreEffort(undefined);
  assert.equal(state.reasoningEffort.value, 'low');
  assert.deepEqual(writes, []);
});

test('连续选择串行保存最终档位，已加载配置不重复读取', async (t) => {
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
  restoreEffort('low');
  const save = state.handleUpdateReasoningEffort('high');
  await state.handleUpdateReasoningEffort('medium');
  await state.handleUpdateReasoningEffort('xhigh');
  const current = t.mock.method(UserConfigAPI, 'current', async () => ({ code: 1 }));
  await useUserConfigStore().load();
  assert.equal(current.mock.callCount(), 0);
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
  restoreEffort('medium');
  await state.handleUpdateReasoningEffort('max');
  assert.equal(state.reasoningEffort.value, 'medium');
  assert.equal(state.reasoningEffortError.value, translate('reasoning.saveFailed'));
  assert.equal(state.reasoningEffortPending.value, false);
  await state.handleUpdateReasoningEffort('max');
  assert.equal(state.reasoningEffort.value, 'max');
  assert.equal(state.reasoningEffortError.value, '');
});

test('网络异常恢复已保存的档位并解除发送禁用', async (t) => {
  t.mock.method(UserConfigAPI, 'updateCurrent', async () => { throw new Error('连接失败'); });
  t.mock.method(console, 'error', () => {});
  const state = useReasoningEffort();
  restoreEffort('none');
  await state.handleUpdateReasoningEffort('high');
  assert.equal(state.reasoningEffort.value, 'none');
  assert.equal(state.reasoningEffortPending.value, false);
  assert.equal(state.reasoningEffortError.value, translate('reasoning.saveFailed'));
});
