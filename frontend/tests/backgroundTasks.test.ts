import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { useBackgroundTasks } from '../src/views/chat/useBackgroundTasks';
import { BackgroundTaskAPI } from '../src/services/backgroundTask';
import { AgentAPI } from '../src/services/agent';
import { SessionEventStream } from '../src/views/chat/sessionEventStream';
import { BACKGROUND_TASK_CHANGED, type BackgroundTask, type BackgroundTaskChanged } from '../src/types/backgroundTask';
import http from '../src/services/interceptor';
import type { Result } from '../src/services/types';
const ROOT = '9007199254740993';
const OTHER = '9007199254740995';
const ID = '9007199254740997';
const task = (status: BackgroundTask['status'] = 'RUNNING', owner = ROOT, id = ID): BackgroundTask => ({
  id, sessionId: owner, turnId: '9007199254740999', intention: '后台执行全量编译', command: 'mvn verify', status,
  createAt: '2026-10-18T00:00:00Z', output: '', truncated: false,
});
const ok = <T>(data: T): Result<T> => ({ code: 1, data });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(api: typeof BackgroundTaskAPI, id: string | null = ROOT) {
  const session = ref(id); const scope = effectScope();
  const feed = scope.run(() => useBackgroundTasks(session, api))!;
  return { session, scope, feed };
}
function api(list = async (_owner: string): Promise<Result<BackgroundTask[]>> => ok([task()])): typeof BackgroundTaskAPI {
  return { list, read: async (owner, id) => ok(task('RUNNING', owner, id)), stop: async (owner, id) => ok(task('CANCELLED', owner, id)),
    remove: async () => ok(undefined) };
}

test('批量删除只处理已结束记录，保留运行与等待任务，并关闭已删除任务的输出', async context => {
  const finished = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED', 'LOST'] as const;
  const backend = api(async () => ok([task('RUNNING', ROOT, '10'), task('PENDING', ROOT, '11'),
    ...finished.map((status, index) => task(status, ROOT, String(index + 20)))]));
  const remove = context.mock.method(backend, 'remove', async () => ok(undefined));
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  await f.feed.read('20');
  assert.equal(f.feed.finishedCount.value, 5);
  await f.feed.removeFinished();
  assert.deepEqual(remove.mock.calls.map(call => call.arguments.slice(0, 2)), finished.map((_, index) => [ROOT, String(index + 20)]));
  assert.deepEqual(f.feed.tasks.value.map(task => task.id), ['10', '11']);
  assert.equal(f.feed.selectedId.value, null);
  assert.equal(f.feed.deletingFinished.value, false);
});

test('批量删除部分失败时保留失败行，继续删除其他行且不接受重复点击', async context => {
  const gate = deferred<Result<void>>();
  const backend = api(async () => ok([task('SUCCESS', ROOT, '1'), task('FAILED', ROOT, '2'), task('SUCCESS', ROOT, '3')]));
  const remove = context.mock.method(backend, 'remove', async (_owner, id) => id === '1' ? gate.promise
    : id === '2' ? { code: 0, errMsg: '所属执行仍在等待结果' } : ok(undefined));
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  const batch = f.feed.removeFinished();
  assert.equal(f.feed.deletingFinished.value, true);
  await f.feed.removeFinished(); await f.feed.removeTask('3');
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(f.feed.tasks.value.length, 3);
  gate.resolve(ok(undefined)); await batch;
  assert.deepEqual(f.feed.tasks.value.map(task => task.id), ['2']);
  assert.equal(remove.mock.callCount(), 3);
  assert.match(f.feed.deleteError.value, /所属执行仍在等待结果/);
  assert.equal(f.feed.finishedCount.value, 1);
});

test('批量删除在切换会话后终止，不继续发送旧会话剩余删除请求', async context => {
  const gate = deferred<Result<void>>();
  const backend = api(async owner => ok([task('SUCCESS', owner, '1'), task('SUCCESS', owner, '2')]));
  const remove = context.mock.method(backend, 'remove', async () => gate.promise);
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  const batch = f.feed.removeFinished();
  const signal = remove.mock.calls[0]!.arguments[2] as AbortSignal;
  f.session.value = OTHER; await tick();
  assert.equal(signal.aborted, true);
  gate.resolve(ok(undefined)); await batch;
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(f.feed.tasks.value.length, 2);
  assert.equal(f.feed.tasks.value[0]?.sessionId, OTHER);
  assert.equal(f.feed.deletingFinished.value, false);
});

test('删除回执到达后，较早发出的列表请求不能让已删除记录重新出现', async context => {
  const old = deferred<Result<BackgroundTask[]>>(); let count = 0;
  const backend = api(async () => ++count === 1 ? ok([task('SUCCESS')]) : count === 2 ? old.promise : ok([]));
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  const refresh = f.feed.refresh(); await tick();
  await f.feed.removeFinished();
  old.resolve(ok([task('SUCCESS')])); await refresh;
  assert.deepEqual(f.feed.tasks.value, []);
  assert.equal(count, 3);
});

test('任务 API 全程保留雪花字符串和取消信号', async context => {
  const get = context.mock.method(http, 'get', async () => ok([]));
  const post = context.mock.method(http, 'post', async () => ok(task('CANCELLED')));
  const remove = context.mock.method(http, 'delete', async () => ok(undefined));
  const signal = new AbortController().signal;
  await BackgroundTaskAPI.list(ROOT, signal); await BackgroundTaskAPI.read(ROOT, ID, signal);
  await BackgroundTaskAPI.stop(ROOT, ID, signal);
  await BackgroundTaskAPI.remove(ROOT, ID, signal);
  assert.deepEqual(get.mock.calls[0]!.arguments, ['/task/runtime/list', { params: { sessionId: ROOT }, signal }]);
  assert.deepEqual(get.mock.calls[1]!.arguments, [`/task/runtime/${ID}`, { params: { sessionId: ROOT }, signal }]);
  assert.deepEqual(post.mock.calls[0]!.arguments, [`/task/runtime/${ID}/stop`, null, { params: { sessionId: ROOT }, signal, timeout: 30_000 }]);
  assert.deepEqual(remove.mock.calls[0]!.arguments, [`/task/runtime/${ID}`, { params: { sessionId: ROOT }, signal }]);
});

test('删除成功后只移除该行并关掉它的输出，失败则保留原行', async context => {
  const backend = api(async () => ok([task('SUCCESS')]));
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  await f.feed.read(ID); assert.equal(f.feed.selectedId.value, ID);
  await f.feed.removeTask(ID);
  assert.deepEqual(f.feed.tasks.value, []); assert.equal(f.feed.selectedId.value, null);
  assert.equal(f.feed.deletingId.value, null); assert.equal(f.feed.deleteError.value, '');
});

test('删除被拒绝时保留原行并给出服务端原因', async context => {
  const backend = api(async () => ok([task('RUNNING')]));
  backend.remove = async () => ({ code: 0, errMsg: '任务仍在运行，请先停止再删除' });
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  await f.feed.removeTask(ID);
  assert.equal(f.feed.tasks.value.length, 1); assert.match(f.feed.deleteError.value, /任务仍在运行/);
  assert.equal(f.feed.deletingId.value, null);
});

test('任务计数区分运行、等待和终态，不跟随模型结束清空', async context => {
  const f = fixture(api(async () => ok([task(), task('PENDING', ROOT, '2'), task('SUCCESS', ROOT, '3')])));
  context.after(() => f.scope.stop()); await tick();
  assert.equal(f.feed.tasks.value.length, 3); assert.equal(f.feed.runningCount.value, 1); assert.equal(f.feed.pendingCount.value, 1);
  f.feed.onTaskChanged({ rootSessionId: ROOT, sessionId: ROOT, taskId: ID, status: 'SUCCESS' });
  await tick(); assert.equal(f.feed.tasks.value.length, 3);
});

test('切换会话后迟到的旧响应不能写入新会话，缺失会话不会请求临时标识', async context => {
  const old = deferred<Result<BackgroundTask[]>>(); const owners: string[] = [];
  const f = fixture(api(async owner => { owners.push(owner); return owner === ROOT ? old.promise : ok([task('SUCCESS', OTHER)]); }));
  context.after(() => f.scope.stop()); await tick();
  f.session.value = OTHER; await tick(); assert.equal(f.feed.tasks.value[0]!.sessionId, OTHER);
  old.resolve(ok([task()])); await tick(); assert.equal(f.feed.tasks.value[0]!.sessionId, OTHER);
  f.session.value = null; await tick(); assert.deepEqual(f.feed.tasks.value, []); assert.deepEqual(owners, [ROOT, OTHER]);
});

test('请求途中收到结束事件必须再次回查，旧快照不能覆盖新状态', async context => {
  const first = deferred<Result<BackgroundTask[]>>(); let calls = 0;
  const f = fixture(api(async () => ++calls === 1 ? first.promise : ok([task('SUCCESS')])));
  context.after(() => f.scope.stop()); await tick();
  f.feed.onTaskChanged({ rootSessionId: ROOT, sessionId: ROOT, taskId: ID, status: 'SUCCESS' });
  first.resolve(ok([task()])); await tick();
  assert.equal(calls, 2); assert.equal(f.feed.tasks.value[0]!.status, 'SUCCESS'); assert.equal(f.feed.runningCount.value, 0);
});

test('其他会话的事件不会触发当前会话回查', async context => {
  let calls = 0; const f = fixture(api(async () => { calls++; return ok([task()]); }));
  context.after(() => f.scope.stop()); await tick();
  f.feed.onTaskChanged({ rootSessionId: OTHER, sessionId: OTHER, taskId: ID, status: 'FAILED' });
  await tick(); assert.equal(calls, 1); assert.equal(f.feed.tasks.value[0]!.status, 'RUNNING');
});

test('取消请求失败保持运行事实，重复点击不产生两次停止请求', async context => {
  const response = deferred<Result<BackgroundTask>>(); let calls = 0; const backend = api();
  backend.stop = async () => { calls++; return response.promise; };
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  const stopping = f.feed.stop(ID); await f.feed.stop(ID);
  assert.equal(calls, 1); assert.equal(f.feed.tasks.value[0]!.status, 'RUNNING');
  response.resolve({ code: 0, errMsg: '停止未获确认' }); await stopping;
  assert.equal(f.feed.tasks.value[0]!.status, 'RUNNING'); assert.match(f.feed.stopError.value, /停止未获确认/);
  assert.equal(f.feed.stoppingId.value, null);
});

test('自然退出的停止回执保留 FAILED，不强制改成 CANCELLED', async context => {
  let status: BackgroundTask['status'] = 'RUNNING'; const backend = api(async () => ok([task(status)]));
  backend.stop = async () => { status = 'FAILED'; return ok({ ...task(status), exitCode: 7 }); };
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick(); await f.feed.stop(ID);
  assert.equal(f.feed.tasks.value[0]!.status, 'FAILED'); assert.equal(f.feed.runningCount.value, 0);
});

test('输出使用当前会话真实 ID，关闭后的迟到读取不能重新打开输出', async context => {
  const pending = deferred<Result<BackgroundTask>>(); let args: unknown[] = []; const backend = api();
  backend.read = async (...input) => { args = input; return pending.promise; };
  const f = fixture(backend); context.after(() => f.scope.stop()); await tick();
  const reading = f.feed.read(ID); assert.equal(args[0], ROOT); assert.equal(args[1], ID);
  f.feed.closeOutput(); pending.resolve(ok({ ...task(), output: '<script>纯文本</script>' })); await reading;
  assert.equal(f.feed.selectedId.value, null); assert.equal(f.feed.detail.value, null);
});

test('越权会话和数值任务 ID 是契约错误，不构造替代记录', async context => {
  const f = fixture(api(async () => ok([task('RUNNING', OTHER)]))); context.after(() => f.scope.stop()); await tick();
  assert.deepEqual(f.feed.tasks.value, []); assert.ok(f.feed.error.value);
  f.scope.stop();
  const invalid = fixture(api(async () => ok([{ ...task(), id: Number(ID) } as unknown as BackgroundTask])));
  context.after(() => invalid.scope.stop()); await tick(); assert.deepEqual(invalid.feed.tasks.value, []); assert.ok(invalid.feed.error.value);
});

test('卸载后在途请求不会再写入状态', async () => {
  const pending = deferred<Result<BackgroundTask[]>>(); const f = fixture(api(async () => pending.promise));
  await tick(); f.scope.stop(); pending.resolve(ok([task()])); await tick(); assert.deepEqual(f.feed.tasks.value, []);
});

test('后台任务事件经过真实 SSE 入口独立路由，根身份不符和损坏事件被忽略', async context => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  context.mock.method(AgentAPI, 'subscribeSessionEvents', async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  const tasks: BackgroundTaskChanged[] = []; const chat: string[] = [];
  const stream = new SessionEventStream({ onEvent: event => chat.push(event.type), onConnectionClosed: () => {},
    onBackgroundTaskChanged: event => tasks.push(event), scheduleRetry: () => 0, cancelRetry: () => {} });
  context.after(() => { stream.close(); try { controller.close(); } catch {} });
  stream.acquire(ROOT); await tick();
  const frame = (name: string, data: unknown) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const event = { rootSessionId: ROOT, sessionId: ROOT, taskId: ID, status: 'RUNNING' };
  controller.enqueue(frame('READY', { rootSessionId: ROOT }));
  controller.enqueue(frame(BACKGROUND_TASK_CHANGED, event));
  controller.enqueue(frame(BACKGROUND_TASK_CHANGED, { ...event, rootSessionId: OTHER }));
  controller.enqueue(frame(BACKGROUND_TASK_CHANGED, { ...event, taskId: Number(ID) }));
  await tick(); assert.deepEqual(tasks, [event]); assert.deepEqual(chat, []);
});

test('空闲 15 秒才兜底回查，有活跃任务回到 5 秒', async context => {
  // 事件（backgroundTaskChanged）是主路径，轮询只是漏事件时的兜底 —— 所以没有任何任务时
  // 不该按活跃节奏打请求。变异：把空闲间隔也写成 5 → 第二条断言变红。
  context.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let payload: BackgroundTask[] = [];
  const f = fixture(api(async () => { calls++; return ok(payload); }));
  context.after(() => f.scope.stop());
  await tick();
  assert.equal(calls, 1, '挂载即回查一次');

  context.mock.timers.tick(14_000); await tick();
  assert.equal(calls, 1, '空闲期 14 秒内不得回查');

  context.mock.timers.tick(1_000); await tick();
  assert.equal(calls, 2, '空闲 15 秒兜底一次');

  payload = [task('RUNNING')];
  context.mock.timers.tick(15_000); await tick();
  assert.equal(calls, 3, '下一次兜底要把活跃任务拉上来');

  context.mock.timers.tick(5_000); await tick();
  assert.equal(calls, 4, '有活跃任务时按 5 秒回查');
});
