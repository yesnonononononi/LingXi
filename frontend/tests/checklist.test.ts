import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { useChecklist } from '../src/views/chat/useChecklist';
import { ChecklistAPI } from '../src/services/checklist';
import { isChecklistSnapshot, type ChecklistSnapshot } from '../src/types/checklist';
import { AgentToolName } from '../src/utils/toolNames';
import http from '../src/services/interceptor';
import type { Result } from '../src/services/types';

const ROOT = '9007199254740993';
const OTHER = '9007199254740995';
const createSnapshot = (sessionId = ROOT): ChecklistSnapshot => ({ checklistId: '9007199254741001', sessionId,
  title: '验证改动', status: 'ACTIVE', steps: [
    { stepId: '9007199254741011', seq: 1, content: '编译', status: 'IN_PROGRESS' },
    { stepId: '9007199254741013', seq: 2, content: '回归', status: 'PENDING' },
  ] });
const ok = <T>(data: T): Result<T> => ({ code: 1, data });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(api: typeof ChecklistAPI, id: string | null = ROOT) {
  const session = ref(id); const scope = effectScope();
  return { session, scope, feed: scope.run(() => useChecklist(session, api))! };
}

test('清单 API 保留雪花字符串和请求取消信号，并走常驻展示口径', async context => {
  const get = context.mock.method(http, 'get', async () => ok(null));
  const signal = new AbortController().signal;
  await ChecklistAPI.latest(ROOT, signal);
  assert.deepEqual(get.mock.calls[0]!.arguments, ['/checklist/latest', { params: { sessionId: ROOT }, signal }]);
});

test('快照校验先做有效样本正对照，再拒绝重复标识、顺序与未知状态', () => {
  assert.equal(isChecklistSnapshot(createSnapshot()), true);
  for (const alter of [
    (value: ChecklistSnapshot) => { value.steps[1]!.stepId = value.steps[0]!.stepId; },
    (value: ChecklistSnapshot) => { value.steps[1]!.seq = 1; },
    (value: ChecklistSnapshot) => { (value.steps[0] as any).status = 'RUNNING'; },
    (value: ChecklistSnapshot) => { (value as any).sessionId = 9007199254740993; },
  ]) {
    const value = createSnapshot(); alter(value); assert.equal(isChecklistSnapshot(value), false);
  }
});

test('后端失败、跳过与已删除结案状态保留原样，不伪造成功也不隐藏历史', async context => {
  for (const status of ['FAILED', 'CLOSED', 'DELETED'] as const) {
    const snapshot: ChecklistSnapshot = { ...createSnapshot(), status };
    assert.equal(isChecklistSnapshot(snapshot), true);
    const f = fixture({ latest: async () => ok(snapshot) });
    context.after(() => f.scope.stop());
    await tick();
    assert.equal(f.feed.snapshot.value?.status, status);
    assert.equal(f.feed.error.value, '');
  }
});

test('空会话不请求，权威空值删除胶囊，失败保留原快照并展示错误', async context => {
  let calls = 0; let response: Result<ChecklistSnapshot | null> = ok(createSnapshot());
  const f = fixture({ latest: async () => { calls++; return response; } }, null);
  context.after(() => f.scope.stop()); await tick(); assert.equal(calls, 0);
  f.session.value = ROOT; await tick(); assert.equal(f.feed.snapshot.value?.sessionId, ROOT);
  response = { code: 0, errMsg: '清单读取失败' }; await f.feed.refresh();
  assert.equal(f.feed.snapshot.value?.checklistId, createSnapshot().checklistId); assert.equal(f.feed.error.value, '清单读取失败');
  response = ok(null); await f.feed.refresh(); assert.equal(f.feed.snapshot.value, null); assert.equal(f.feed.error.value, '');
});

test('切换会话会取消旧请求，迟到结果不得回写；错误归属也被拒绝', async context => {
  const old = deferred<Result<ChecklistSnapshot | null>>(); let oldSignal: AbortSignal | undefined;
  const f = fixture({ latest: async (owner, signal) => {
    if (owner === ROOT) { oldSignal = signal; return old.promise; }
    return ok(createSnapshot(OTHER));
  } });
  context.after(() => f.scope.stop()); await tick();
  f.session.value = OTHER; await tick(); assert.equal(oldSignal?.aborted, true);
  old.resolve(ok(createSnapshot())); await tick(); assert.equal(f.feed.snapshot.value?.sessionId, OTHER);
  const wrong = fixture({ latest: async () => ok(createSnapshot(OTHER)) });
  context.after(() => wrong.scope.stop()); await tick(); assert.equal(wrong.feed.snapshot.value, null); assert.ok(wrong.feed.error.value);
});

test('清单工具事件只触发所属会话回查，请求中变化必须二次回查', async context => {
  const first = deferred<Result<ChecklistSnapshot | null>>(); let calls = 0;
  const f = fixture({ latest: async () => ++calls === 1 ? first.promise : ok(null) });
  context.after(() => f.scope.stop()); await tick();
  const event = { type: 'TOOL_COMPLETED' as const, executionId: '21', timestamp: '', toolName: AgentToolName.DeleteChecklist,
    metaData: { sessionId: OTHER } };
  f.feed.onEvent(event); await tick(); assert.equal(calls, 1);
  f.feed.onEvent({ ...event, metaData: { sessionId: ROOT } });
  first.resolve(ok(createSnapshot())); await tick(); assert.equal(calls, 2); assert.equal(f.feed.snapshot.value, null);
  f.feed.onEvent({ ...event, toolName: AgentToolName.ReadFile, metaData: { sessionId: ROOT } });
  await tick(); assert.equal(calls, 2);
});

test('卸载后响应不能回写，未知数据不会生成临时清单', async () => {
  const pending = deferred<Result<ChecklistSnapshot | null>>();
  const f = fixture({ latest: async () => pending.promise }); await tick(); f.scope.stop();
  pending.resolve(ok(createSnapshot())); await tick(); assert.equal(f.feed.snapshot.value, null);
});

