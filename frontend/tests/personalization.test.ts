import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, defineComponent, nextTick } from 'vue';
import { PersonalizationAPI } from '../src/services/personalization';
import type { PersonalizationVO } from '../src/services/personalization';
import { usePersonalizationTab } from '../src/views/settings/tabs/usePersonalizationTab';
import { normalizeSettingsTab } from '../src/utils/enum';

const initial: PersonalizationVO = { id: '9007199254740993', title: '', commonAgentName: '', replyStyle: 'DEFAULT', customInstruction: '' };
const styles = [{ value: 'DEFAULT', label: '默认' }, { value: 'DIRECT', label: '直言不讳' }];
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
function mount() {
  let state!: ReturnType<typeof usePersonalizationTab>;
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
    patchProp() {}, insert() {}, remove() {},
  });
  const app = renderer.createApp(defineComponent({ setup() { state = usePersonalizationTab(); return () => null; } }));
  app.mount({});
  return { state, app };
}

test('加载权威配置，保存原始大整数 ID，清空字段后重载', async t => {
  let stored = { ...initial };
  t.mock.method(PersonalizationAPI, 'current', async () => ({ code: 1, data: { ...stored } }));
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({ code: 1, data: styles }));
  const update = t.mock.method(PersonalizationAPI, 'update', async payload => { stored = { ...stored, ...payload }; return { code: 1 }; });
  const { state, app } = mount(); t.after(() => app.unmount());
  await settle();
  assert.equal(state.config.value?.id, initial.id);
  assert.equal(state.dirty.value, false);
  state.draft.title = '小林'; state.draft.commonAgentName = '灵犀'; state.draft.replyStyle = 'DIRECT'; state.draft.customInstruction = '结论\n解释';
  await state.save();
  assert.equal(update.mock.calls[0]?.arguments[0].id, initial.id);
  assert.equal(state.saved.value, true);
  assert.equal(state.dirty.value, false);
  state.draft.title = ''; state.draft.commonAgentName = ''; state.draft.customInstruction = '';
  await state.save();
  assert.equal(stored.title, ''); assert.equal(stored.customInstruction, ''); assert.equal(stored.replyStyle, 'DIRECT');
  assert.equal(normalizeSettingsTab('personalization'), 'personalization');
});

test('保存中禁止重复提交，失败保留草稿且不宣称已保存', async t => {
  t.mock.method(PersonalizationAPI, 'current', async () => ({ code: 1, data: initial }));
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({ code: 1, data: styles }));
  let finish!: (value: {code: number; errMsg: string}) => void;
  const update = t.mock.method(PersonalizationAPI, 'update', () => new Promise<{code: number; errMsg: string}>(resolve => { finish = resolve; }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  state.draft.title = '保留草稿'; const pending = state.save();
  assert.equal(state.saving.value, true); await state.save(); assert.equal(update.mock.callCount(), 1);
  finish({code: 0, errMsg: '写入失败'}); await pending;
  assert.equal(state.error.value, '写入失败'); assert.equal(state.draft.title, '保留草稿');
  assert.equal(state.config.value?.title, ''); assert.equal(state.saved.value, false); assert.equal(state.saving.value, false);
});

test('缺失真实 ID 时显示错误，不创建前端临时配置', async t => {
  t.mock.method(PersonalizationAPI, 'current', async () => ({ code: 1, data: { ...initial, id: undefined } as unknown as PersonalizationVO }));
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({ code: 1, data: styles }));
  const update = t.mock.method(PersonalizationAPI, 'update', async () => ({code:1}));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.config.value, null); assert.ok(state.error.value); await state.save(); assert.equal(update.mock.callCount(), 0);
});

test('加载失败可重试，风格契约不完整时不能编辑配置', async t => {
  let response = { code: 0, errMsg: '读取失败', data: initial };
  let options = styles;
  t.mock.method(PersonalizationAPI, 'current', async () => response);
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({ code: 1, data: options }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.error.value, '读取失败'); assert.equal(state.loading.value, false); assert.equal(state.config.value, null);
  response = { code: 1, errMsg: '', data: initial }; options = [];
  await state.load(); assert.ok(state.error.value); assert.equal(state.config.value, null);
  options = styles; await state.load();
  assert.equal(state.error.value, ''); assert.equal(state.config.value?.id, initial.id); assert.equal(state.dirty.value, false);
});

test('组件卸载后迟到的加载响应不能更新状态', async t => {
  let finish!: (value: {code: number; data: PersonalizationVO}) => void;
  t.mock.method(PersonalizationAPI, 'current', () => new Promise<{code: number; data: PersonalizationVO}>(resolve => { finish=resolve; }));
  t.mock.method(PersonalizationAPI, 'replyStyles', async () => ({code:1, data:styles}));
  const {state, app}=mount(); app.unmount(); finish({code:1,data:initial}); await settle(); assert.equal(state.config.value,null);
});
