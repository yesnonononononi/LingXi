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
  return { list, read: async (owner, id) => ok(task('RUNNING', owner, id)), stop: async (owner, id) => ok(task('CANCELLED', owner, id)) };
}

test('任务 API 全程保留雪花字符串和取消信号', async context => {
  const get = context.mock.method(http, 'get', async () => ok([]));
  const post = context.mock.method(http, 'post', async () => ok(task('CANCELLED')));
  const signal = new AbortController().signal;
  await BackgroundTaskAPI.list(ROOT, signal); await BackgroundTaskAPI.read(ROOT, ID, signal);
  await BackgroundTaskAPI.stop(ROOT, ID, signal);
  assert.deepEqual(get.mock.calls[0]!.arguments, ['/task/runtime/list', { params: { sessionId: ROOT }, signal }]);
  assert.deepEqual(get.mock.calls[1]!.arguments, [`/task/runtime/${ID}`, { params: { sessionId: ROOT }, signal }]);
  assert.deepEqual(post.mock.calls[0]!.arguments, [`/task/runtime/${ID}/stop`, null, { params: { sessionId: ROOT }, signal, timeout: 30_000 }]);
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
