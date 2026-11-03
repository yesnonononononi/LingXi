import test from 'node:test';
import assert from 'node:assert/strict';
import {setActivePinia, createPinia} from 'pinia';
import {UserConfigAPI} from '../src/services/userConfig';
import {
  notifySettingsChanged,
  onSettingsChanged,
  resetSettingsBroadcastForTest,
} from '../src/services/settingsBroadcast';
import {useUserConfigStore} from '../src/stores/userConfigStore';
import {attachSettingsSync} from '../src/composables/useSettingsSync';
import type {UserConfigVO} from '../src/types/chat';

/**
 * 设置在服务端只有一份，每个窗口各持一份镜像：一个窗口改完，另一个窗口必须跟上，
 * 否则滑杆显示旧值而实际按新值执行 —— 显示与实际不一致比不显示更坏。
 */
test.beforeEach(() => setActivePinia(createPinia()));

function loadConfig(store: ReturnType<typeof useUserConfigStore>, config: Partial<UserConfigVO>): void {
  store.applyConfig(config as UserConfigVO);
  store.loaded = true;
}

test('回读把另一个窗口改过的档位对齐过来', async (t) => {
  const store = useUserConfigStore();
  loadConfig(store, {reasoningEffort: 'low'});
  t.mock.method(UserConfigAPI, 'current', async () => ({code: 1, data: {reasoningEffort: 'max'} as UserConfigVO}));

  await store.reconcile();

  assert.equal(store.reasoningEffort, 'max');
});

test('保存进行中不回读，避免把用户刚选的档位打回去', async (t) => {
  const store = useUserConfigStore();
  loadConfig(store, {reasoningEffort: 'low'});
  let finishSave!: (result: {code: number}) => void;
  t.mock.method(UserConfigAPI, 'updateCurrent', () =>
    new Promise<{code: number}>(resolve => { finishSave = resolve; }));
  const reads: number[] = [];
  t.mock.method(UserConfigAPI, 'current', async () => {
    reads.push(1);
    return {code: 1, data: {reasoningEffort: 'none'} as UserConfigVO};
  });

  const saving = store.setReasoningEffort('xhigh');
  await store.reconcile();
  assert.equal(store.reasoningEffort, 'xhigh', '保存中的本地值不许被回读覆盖');
  assert.deepEqual(reads, [], '保存中不该发起回读');

  finishSave({code: 1});
  await saving;
  await store.reconcile();
  assert.equal(store.reasoningEffort, 'none', '保存结束后才允许对齐');
});

test('未载入完成时不回读', async (t) => {
  const store = useUserConfigStore();
  let reads = 0;
  t.mock.method(UserConfigAPI, 'current', async () => { reads += 1; return {code: 1, data: {}}; });

  await store.reconcile();

  assert.equal(reads, 0);
});

test('焦点与广播两个触发点都能拉回真值，退订后都不再拉', async () => {
  resetSettingsBroadcastForTest();
  const instances: {onmessage: ((event: {data: unknown}) => void) | null}[] = [];
  class FakeChannel {
    onmessage: ((event: {data: unknown}) => void) | null = null;
    constructor(_name: string) { instances.push(this); }
    postMessage(_message: unknown) { /* noop */ }
    close() { /* noop */ }
  }
  const globalAny = globalThis as unknown as {window?: unknown; BroadcastChannel?: unknown};
  globalAny.window = {};
  globalAny.BroadcastChannel = FakeChannel;

  try {
    const handlers: Record<string, () => void> = {};
    const target = {
      addEventListener: (type: string, handler: () => void) => { handlers[type] = handler; },
      removeEventListener: (type: string) => { delete handlers[type]; },
    };
    let reconciled = 0;
    const detach = attachSettingsSync(() => { reconciled += 1; }, target as unknown as Window);

    handlers.focus?.();
    assert.equal(reconciled, 1, '窗口获得焦点必须回读');
    instances[0]?.onmessage?.({data: {type: 'changed'}});
    assert.equal(reconciled, 2, '收到广播必须回读');

    detach();
    assert.equal(handlers.focus, undefined, '退订必须摘掉焦点监听');
    instances[0]?.onmessage?.({data: {type: 'changed'}});
    assert.equal(reconciled, 2, '退订后广播不再触发回读');
  } finally {
    delete globalAny.window;
    delete globalAny.BroadcastChannel;
    resetSettingsBroadcastForTest();
  }
});

test('保存成功后广播；收到广播方回读（广播不传值）', async (t) => {
  resetSettingsBroadcastForTest();
  // 用假通道替身：Node 下的 BroadcastChannel 不会跨进程送达，真通道只会让测试进程退不出去
  const posted: unknown[] = [];
  const listeners: ((event: {data: unknown}) => void)[] = [];
  class FakeChannel {
    onmessage: ((event: {data: unknown}) => void) | null = null;
    constructor(_name: string) { listeners.push(this as unknown as {onmessage: typeof this.onmessage} as never); }
    postMessage(message: unknown) { posted.push(message); }
    close() { /* noop */ }
  }
  const globalAny = globalThis as unknown as {window?: unknown; BroadcastChannel?: unknown};
  globalAny.window = {};
  globalAny.BroadcastChannel = FakeChannel;

  try {
    const store = useUserConfigStore();
    loadConfig(store, {reasoningEffort: 'low'});
    t.mock.method(UserConfigAPI, 'updateCurrent', async () => ({code: 1}));
    const readValues: unknown[] = [];
    t.mock.method(UserConfigAPI, 'current', async () => {
      readValues.push(1);
      return {code: 1, data: {reasoningEffort: 'medium'} as UserConfigVO};
    });
    let reconciled = 0;
    const off = onSettingsChanged(() => {
      reconciled += 1;
      void store.reconcile();
    });

    await store.setReasoningEffort('high');
    assert.deepEqual(posted, [{type: 'changed'}], '保存成功后必须广播一次');
    // 模拟其它窗口收到广播：只有通知，值由收方自己回读
    for (const listener of listeners) listener.onmessage?.({data: {type: 'changed'}});
    await Promise.resolve();
    assert.equal(reconciled, 1);
    assert.ok(readValues.length >= 1, '收到广播必须回读后端，而不是从广播里取值');
    off();
    // 退订后再广播也不该再通知到已退订的一方
    const postedBefore = posted.length;
    notifySettingsChanged();
    assert.equal(posted.length, postedBefore + 1, '广播本身仍然发出，只是没人订阅了');
  } finally {
    delete globalAny.window;
    delete globalAny.BroadcastChannel;
    resetSettingsBroadcastForTest();
  }
});
