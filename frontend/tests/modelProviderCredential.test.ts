import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelAPI, ProviderAPI } from '../src/services/api';
import { useModelsTab } from '../src/views/settings/tabs/useModelsTab';
import { t as translate } from '../src/i18n';

test.beforeEach(t => {
  t.mock.method(ModelAPI, 'catalog', async () => ({ code: 1, data: [] }));
  t.mock.method(ProviderAPI, 'list', async () => ({ code: 1, data: [] }));
  t.mock.method(globalThis, 'setTimeout', (() => 1) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
});

test('新增默认使用提供方密钥，保存显式来源且不回传密钥副本', async t => {
  const writes: unknown[] = [];
  t.mock.method(ModelAPI, 'add', async payload => { writes.push(payload); return { code: 1 }; });
  const state = useModelsTab(() => {});
  state.providers.value = [{ id: '9007199254740993', name: '提供方', baseUrl: 'https://provider.invalid', credentialConfigured: true }];
  state.startAddModel('9007199254740993');
  assert.equal(state.modelForm.value.useProvider, true);
  state.modelForm.value.modelName = 'model';
  state.modelForm.value.apiKey = 'must-not-send';
  await state.saveModelForm();
  assert.deepEqual(writes, [{ modelName: 'model', baseUrl: 'https://provider.invalid', vision: false,
    apiKey: undefined, providerConfigId: '9007199254740993', useProvider: true }]);
});

test('编辑读取后端来源，关闭时显式提交 false 与独立密钥', async t => {
  const writes: unknown[] = [];
  t.mock.method(ModelAPI, 'update', async payload => { writes.push(payload); return { code: 1 }; });
  const state = useModelsTab(() => {});
  state.startEditModel({ id: '12', modelName: 'model', baseUrl: 'https://provider.invalid',
    providerConfigId: '10', vision: false, useProvider: true, apiKey: 'ma***sk' });
  assert.equal(state.modelForm.value.useProvider, true);
  assert.equal(state.modelForm.value.apiKey, '');
  state.modelForm.value.useProvider = false;
  state.modelForm.value.apiKey = 'own-key';
  await state.saveModelForm();
  assert.deepEqual(writes, [{ id: '12', modelName: 'model', baseUrl: 'https://provider.invalid',
    providerConfigId: '10', vision: false, useProvider: false, apiKey: 'own-key' }]);
  state.startEditModel({ id: '13', vision: false, useProvider: false });
  assert.equal(state.modelForm.value.useProvider, false);
});

test('提供方无密钥或已删除时保留开关，后端错误直接展示', async t => {
  t.mock.method(ModelAPI, 'add', async () => ({ code: 0, errMsg: '提供方未配置 API Key: 10' }));
  const state = useModelsTab(() => {});
  state.startAddModel('10');
  state.modelForm.value.modelName = 'model';
  state.modelForm.value.baseUrl = 'https://provider.invalid';
  state.handleProviderChange('20');
  assert.equal(state.modelForm.value.useProvider, true);
  state.handleProviderChange('10');
  await state.saveModelForm();
  assert.equal(state.modelFormError.value, '提供方未配置 API Key: 10');
  assert.equal(state.mode.value, 'model-form');
});

test('未选提供方时明确提示，解除归属必须提交 0', async t => {
  const writes: unknown[] = [];
  t.mock.method(ModelAPI, 'update', async payload => { writes.push(payload); return { code: 1 }; });
  const state = useModelsTab(() => {});
  state.startEditModel({ id: '12', vision: false, useProvider: true,
    modelName: 'model', baseUrl: 'https://provider.invalid', providerConfigId: '10' });
  state.handleProviderChange(null);
  await state.saveModelForm();
  assert.deepEqual(writes, []);
  assert.equal(state.modelFormError.value, translate('settings.models.errProviderRequired'));
  state.modelForm.value.useProvider = false;
  state.modelForm.value.apiKey = 'own-key';
  await state.saveModelForm();
  assert.equal((writes[0] as { providerConfigId: number }).providerConfigId, 0);
});

test('模型发现按来源提交提供方标识，不混入独立密钥', async t => {
  const requests: unknown[] = [];
  t.mock.method(ProviderAPI, 'discoverModels', async payload => { requests.push(payload); return { code: 1, data: [] }; });
  const state = useModelsTab(() => {});
  state.startAddModel('9007199254740993');
  state.modelForm.value.baseUrl = 'https://provider.invalid';
  state.modelForm.value.apiKey = 'stale-key';
  await state.handleFetchRemoteModels();
  assert.deepEqual(requests, [{ providerConfigId: '9007199254740993', baseUrl: 'https://provider.invalid', apiKey: undefined }]);
  state.modelForm.value.useProvider = false;
  await state.handleFetchRemoteModels();
  assert.deepEqual(requests[1], { providerConfigId: undefined, baseUrl: 'https://provider.invalid', apiKey: 'stale-key' });
});
