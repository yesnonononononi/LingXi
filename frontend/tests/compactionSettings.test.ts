import assert from 'node:assert/strict';
import test from 'node:test';
import { setActivePinia, createPinia } from 'pinia';
import { UserConfigAPI } from '../src/services/userConfig';
import { ModelAPI } from '../src/services/model';
import { CompactionSettingsAPI } from '../src/services/compaction';
import { useCompactionTab } from '../src/views/settings/tabs/useCompactionTab';
import { t as translate } from '../src/i18n';
import { messages } from '../src/i18n/messages';

test.beforeEach(() => setActivePinia(createPinia()));

/** 一个「有密钥」+ 一个「没密钥」的模型：后者不得出现在压缩模型下拉里。 */
const catalog = {
  code: 1,
  data: [
    {
      providerConfigId: 1,
      providerName: 'DeepSeek',
      providerIcon: null,
      baseUrl: 'https://api.deepseek.com/v1',
      modelCount: 2,
      models: [
        { id: 11, modelName: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', credentialConfigured: true },
        { id: 12, modelName: 'no-key', baseUrl: 'https://api.deepseek.com/v1', credentialConfigured: false },
      ],
    },
  ],
};

function mockReads(t: any, compaction: unknown) {
  t.mock.method(UserConfigAPI, 'current', async () => ({ code: 1, data: { compactModelId: null } }));
  t.mock.method(ModelAPI, 'catalog', async () => catalog);
  t.mock.method(CompactionSettingsAPI, 'params', async () => ({ code: 1, data: compaction }));
}

test('压缩参数与模型选项全部来自后端，且只列凭据齐备的模型', async (t) => {
  mockReads(t, { modelThreshold: 0.72, maxSummaryAttempts: 3, compactMaxTokens: 4096 });
  const state = useCompactionTab();

  await state.load();

  assert.deepEqual(state.options.value.map(option => option.label), ['DeepSeek/deepseek-flash']);
  // 阈值/尝试次数/输出上限一律读后端真值，前端不得自带默认值。
  assert.equal(state.params.value?.modelThreshold, 0.72);
  assert.equal(state.params.value?.maxSummaryAttempts, 3);
  assert.equal(state.params.value?.compactMaxTokens, 4096);
  assert.equal(state.enabled.value, false);
});

test('打开开关选中第一个可用模型，关闭开关显式提交 null', async (t) => {
  const writes: unknown[] = [];
  mockReads(t, { modelThreshold: 0.85, maxSummaryAttempts: 2, compactMaxTokens: 32768 });
  t.mock.method(UserConfigAPI, 'updateCurrent', async (payload: unknown) => {
    writes.push(payload);
    return { code: 1 };
  });
  const state = useCompactionTab();
  await state.load();

  await state.toggle(true);
  assert.deepEqual(writes, [{ compactModelId: '11' }]);
  assert.equal(state.enabled.value, true);

  await state.toggle(false);
  assert.deepEqual(writes[1], { compactModelId: null });
  assert.equal(state.enabled.value, false);
});

test('没有可用模型时开关不落库，避免存下一个必然失败的配置', async (t) => {
  const writes: unknown[] = [];
  t.mock.method(UserConfigAPI, 'current', async () => ({ code: 1, data: { compactModelId: null } }));
  t.mock.method(ModelAPI, 'catalog', async () => ({ code: 1, data: [] }));
  t.mock.method(CompactionSettingsAPI, 'params', async () => ({ code: 1, data: {} }));
  t.mock.method(UserConfigAPI, 'updateCurrent', async (payload: unknown) => {
    writes.push(payload);
    return { code: 1 };
  });
  const state = useCompactionTab();
  await state.load();

  await state.toggle(true);

  assert.deepEqual(writes, []);
  assert.equal(state.enabled.value, false);
});

test('保存失败回滚到原值并给出可见错误', async (t) => {
  mockReads(t, { modelThreshold: 0.85, maxSummaryAttempts: 2, compactMaxTokens: 32768 });
  t.mock.method(UserConfigAPI, 'updateCurrent', async () => ({ code: 0 }));
  const state = useCompactionTab();
  await state.load();

  await state.toggle(true);

  assert.equal(state.enabled.value, false);
  assert.equal(state.saveError.value, translate('settings.compaction.saveFailed'));
});

test('参数请求异常只影响高级设置，模型仍可选择和取消，重试能恢复', async (t) => {
  mockReads(t, { modelThreshold: 0.85, maxSummaryAttempts: 2, compactMaxTokens: 32768 });
  let failure = false;
  t.mock.method(CompactionSettingsAPI, 'params', async () => {
    if (failure) throw new Error('HTTP 500');
    return { code: 1, data: { modelThreshold: 0.72, maxSummaryAttempts: 3, compactMaxTokens: 4096 } };
  });
  const writes: unknown[] = [];
  t.mock.method(UserConfigAPI, 'updateCurrent', async (payload: unknown) => {
    writes.push(payload);
    return { code: 1 };
  });
  const state = useCompactionTab();
  await state.load();
  assert.equal(state.params.value?.compactMaxTokens, 4096);
  failure = true;
  await state.load();
  assert.equal(state.loadError.value, '');
  assert.equal(state.params.value, null);
  assert.equal(state.paramsError.value, translate('settings.compaction.loadFailed'));
  assert.equal(state.options.value.length, 1);
  assert.equal(state.disabled.value, false);
  await state.choose('11');
  await state.toggle(false);
  assert.deepEqual(writes, [{ compactModelId: '11' }, { compactModelId: null }]);
  failure = false;
  await state.load();
  assert.equal(state.paramsError.value, '');
  assert.equal(state.params.value?.compactMaxTokens, 4096);
});

test('参数业务错误局部展示，模型目录业务错误不能伪装为空目录', async (t) => {
  mockReads(t, {});
  t.mock.method(CompactionSettingsAPI, 'params', async () => ({ code: 0 }));
  const state = useCompactionTab();
  await state.load();
  assert.equal(state.loadError.value, '');
  assert.notEqual(state.paramsError.value, '');
  assert.equal(state.options.value.length, 1);
  t.mock.method(ModelAPI, 'catalog', async () => ({ code: 0 }));
  await state.load();
  assert.notEqual(state.loadError.value, '');
});

test('压缩模型的文案在中英两套里都有真值，没有漏键', () => {
  const keys = [    'title',
    'subtitle',
    'back',
    'toggleLabel',
    'sectionModel',
    'sectionModelDesc',
    'enabled',
    'disabled',
    'choose',
    'empty',
    'emptyHelp',
    'addModel',
    'sectionAdvanced',
    'sectionAdvancedDesc',
    'threshold',
    'thresholdHelp',
    'attempts',
    'attemptsHelp',
    'maxTokens',
    'maxTokensHelp',
    'unitTimes',
    'unitTokens',
    'loading',
    'loadFailed',
    'retry',
    'saveFailed',
    'missingKey',
    'unavailable',
  ];
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const dict = (messages[locale] as any).settings?.compaction as Record<string, string> | undefined;
    for (const key of keys) {
      assert.ok(dict && typeof dict[key] === 'string' && dict[key].length > 0,
        `缺少 ${locale} 的 settings.compaction.${key}`);
    }
  }
  assert.notEqual(translate('settings.compaction.title'), 'settings.compaction.title');
});
