import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { PromptOptimizationAPI } from '../src/services/promptOptimization';
import { isPromptOptimizationCommand, usePromptOptimization } from '../src/composables/usePromptOptimization';
import { useConfirm } from '../src/composables/useConfirm';
import http from '../src/services/interceptor';
import { t as translate } from '../src/i18n';
import type { Result } from '../src/services/types';

function fixture(initial = '保留原文\n不增加任务') {
  const input = ref(initial);
  const scope = effectScope();
  let focusCount = 0;
  const optimizer = scope.run(() => usePromptOptimization(input, () => '9007199254740993', () => { focusCount += 1; }))!;
  return { input, optimizer, scope, get focusCount() { return focusCount; } };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

test('API 保留模型雪花 ID，使用独立超时并传递取消信号', async t => {
  const post = t.mock.method(http, 'post', async () => ({ code: 1, data: '优化结果' }));
  const controller = new AbortController();
  await PromptOptimizationAPI.optimize('原文', '9007199254740993', controller.signal);
  assert.equal(post.mock.calls[0]!.arguments[0], '/model/optimize-prompt');
  assert.deepEqual(post.mock.calls[0]!.arguments[1], { prompt: '原文', modelId: '9007199254740993' });
  assert.deepEqual(post.mock.calls[0]!.arguments[2], { timeout: 70_000, signal: controller.signal });
});

test('只有完整的斜杠命令才进入优化，前缀相似的普通文本不触发', () => {
  assert.equal(isPromptOptimizationCommand('/optimize-prompt'), true);
  assert.equal(isPromptOptimizationCommand('/optimize-prompt\n原文'), true);
  assert.equal(isPromptOptimizationCommand('/optimize-prompt 原文'), true);
  assert.equal(isPromptOptimizationCommand('/optimize-prompts 原文'), false);
  assert.equal(isPromptOptimizationCommand('解释 /optimize-prompt'), false);
});

test('结果必须经过确认才替换，预览保留 Markdown 和 HTML 字面量', async t => {
  t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '# 标题\n<script>原样文本</script>' }));
  const f = fixture();
  t.after(() => f.scope.stop());
  const pending = f.optimizer.optimize();
  await flush();
  const confirmation = useConfirm();
  assert.equal(f.input.value, '保留原文\n不增加任务');
  assert.equal(confirmation.state.value.options.preview, '# 标题\n<script>原样文本</script>');
  assert.equal(f.optimizer.isOptimizing.value, true);
  confirmation.handleConfirm();
  await pending;
  assert.equal(f.input.value, '# 标题\n<script>原样文本</script>');
  assert.equal(f.optimizer.isOptimizing.value, false);
});

test('取消确认框保留原文', async t => {
  t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '新草稿' }));
  const f = fixture();
  t.after(() => f.scope.stop());
  const pending = f.optimizer.optimize();
  await flush();
  useConfirm().handleCancel();
  await pending;
  assert.equal(f.input.value, '保留原文\n不增加任务');
});

test('带正文的命令只优化正文，取消后保留正文且不重复携带命令', async t => {
  const call = t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '新草稿' }));
  const f = fixture('/optimize-prompt 原文\n保留约束');
  t.after(() => f.scope.stop());
  const pending = f.optimizer.optimize();
  await flush();
  assert.equal(call.mock.calls[0]!.arguments[0], '原文\n保留约束');
  useConfirm().handleCancel();
  await pending;
  assert.equal(f.input.value, '原文\n保留约束');
});

test('空输入和超长输入不调用接口', async t => {
  const call = t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '新草稿' }));
  const f = fixture('/optimize-prompt');
  t.after(() => f.scope.stop());
  await f.optimizer.optimize();
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.empty'));
  f.input.value = 'x'.repeat(20001);
  await f.optimizer.optimize();
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.tooLong'));
  assert.equal(call.mock.calls.length, 0);
});

test('失败码、空输出和网络失败都保留原文且不弹替换框', async t => {
  const call = t.mock.method(PromptOptimizationAPI, 'optimize', async (): Promise<Result<string>> => ({ code: 0 }));
  const f = fixture();
  t.after(() => f.scope.stop());
  for (const result of [{ code: 0 }, { code: 1, data: '' }, { code: 1, data: ' \n ' }]) {
    call.mock.mockImplementation(async () => result);
    await f.optimizer.optimize();
    assert.equal(f.input.value, '保留原文\n不增加任务');
    assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.failed'));
    assert.equal(useConfirm().state.value.isOpen, false);
  }
  call.mock.mockImplementation(async () => { throw new Error('secret-provider-message'); });
  await f.optimizer.optimize();
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.failed'));
});

test('等待期间修改后又改回原文，旧结果仍不能生效，重复触发不重复请求', async t => {
  let finish!: (value: Result<string>) => void;
  const gate = new Promise<Result<string>>(resolve => { finish = resolve; });
  const call = t.mock.method(PromptOptimizationAPI, 'optimize', async () => gate);
  const f = fixture('原文');
  t.after(() => f.scope.stop());
  const pending = f.optimizer.optimize();
  await f.optimizer.optimize();
  assert.equal(call.mock.calls.length, 1);
  f.input.value = '新输入';
  f.input.value = '原文';
  finish({ code: 1, data: '过期结果' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(useConfirm().state.value.isOpen, false);
  await pending;
  assert.equal(f.input.value, '原文');
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.changed'));
  assert.equal(useConfirm().state.value.isOpen, false);
});

test('确认期间输入已变化时，即使确认也不能覆盖新草稿', async t => {
  t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '过期结果' }));
  const f = fixture();
  t.after(() => f.scope.stop());
  const pending = f.optimizer.optimize();
  await flush();
  f.input.value = '新的用户输入';
  useConfirm().handleConfirm();
  await pending;
  assert.equal(f.input.value, '新的用户输入');
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.changed'));
});

test('卸载时取消请求，迟到的结果不弹框', async t => {
  let finish!: (value: Result<string>) => void;
  const gate = new Promise<Result<string>>(resolve => { finish = resolve; });
  const call = t.mock.method(PromptOptimizationAPI, 'optimize', async () => gate);
  const f = fixture();
  const pending = f.optimizer.optimize();
  const signal = call.mock.calls[0]!.arguments[2]!;
  f.scope.stop();
  assert.equal(signal.aborted, true);
  finish({ code: 1, data: '迟到结果' });
  await pending;
  assert.equal(useConfirm().state.value.isOpen, false);
  assert.equal(f.focusCount, 0);
});

test('卸载关闭自己创建的确认框并保留原文', async t => {
  t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '结果' }));
  const f = fixture();
  const pending = f.optimizer.optimize();
  await flush();
  f.scope.stop();
  await pending;
  assert.equal(useConfirm().state.value.isOpen, false);
  assert.equal(f.input.value, '保留原文\n不增加任务');
});

test('其他确认框未处理时不抢占', async t => {
  t.mock.method(PromptOptimizationAPI, 'optimize', async () => ({ code: 1, data: '结果' }));
  const f = fixture();
  t.after(() => f.scope.stop());
  const confirmation = useConfirm();
  const other = confirmation.confirm('其他操作');
  await f.optimizer.optimize();
  assert.equal(confirmation.state.value.options.content, '其他操作');
  assert.equal(f.optimizer.error.value, translate('chat.optimizePrompt.confirmBusy'));
  confirmation.handleCancel();
  assert.equal(await other, false);
});
