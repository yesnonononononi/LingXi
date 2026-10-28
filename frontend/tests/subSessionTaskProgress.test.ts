import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectScope, ref } from 'vue';
import { useSubSessionTaskProgress } from '../src/views/chat/useSubSessionTaskProgress';
import { BackgroundTaskAPI } from '../src/services/backgroundTask';
import { ChecklistAPI } from '../src/services/checklist';
import type { SubSessionVO } from '../src/types/chat';
import type { ChecklistSnapshot } from '../src/types/checklist';
import type { BackgroundTask } from '../src/types/backgroundTask';
import type { AgentEvent } from '../src/types/Event';
import type { Result } from '../src/services/types';
import { AgentToolName } from '../src/utils/toolNames';

const ROOT = '9007199254740993';
const SUB = '9007199254740995';
const OTHER = '9007199254740997';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const ok = <T>(data: T): Result<T> => ({ code: 1, data });
const task = (owner: string): BackgroundTask => ({ id: '11', sessionId: owner, turnId: '12',
  command: 'npm test', status: 'RUNNING', truncated: false, createAt: '2026-10-28T00:00:00Z' });
const snapshot = (owner: string): ChecklistSnapshot => ({ checklistId: owner, sessionId: owner,
  title: '验证子会话', status: 'ACTIVE', steps: [{ stepId: '13', seq: 1, content: '运行测试', status: 'IN_PROGRESS' }] });
const event = (owner: string): AgentEvent => ({ type: 'TOOL_COMPLETED', executionId: '14', timestamp: '',
  toolName: AgentToolName.UpdateChecklistStep, metaData: { rootSessionId: ROOT, sessionId: owner } });

test('只读取展开的子会话，根会话与其他成员事件不会触发回查', async context => {
  const lists = context.mock.method(BackgroundTaskAPI, 'list', async (owner: string) => ok([task(owner)]));
  const latest = context.mock.method(ChecklistAPI, 'latest', async (owner: string) => ok(snapshot(owner)));
  const session = ref<SubSessionVO | null>({ id: SUB, rootSessionId: ROOT });
  const open = ref(false);
  const scope = effectScope();
  const feed = scope.run(() => useSubSessionTaskProgress(session, open))!;
  context.after(() => scope.stop());
  await tick();
  assert.equal(lists.mock.callCount(), 0);
  assert.equal(latest.mock.callCount(), 0);
  open.value = true; await tick();
  assert.equal(feed.background.tasks.value[0]?.sessionId, SUB);
  assert.equal(feed.checklist.snapshot.value?.sessionId, SUB);
  for (const owner of [ROOT, OTHER]) {
    feed.onEvent(event(owner));
    feed.onTaskChanged({ rootSessionId: ROOT, sessionId: owner, taskId: '11', status: 'SUCCESS' });
  }
  await tick();
  assert.equal(lists.mock.callCount(), 1);
  assert.equal(latest.mock.callCount(), 1);
  feed.onEvent(event(SUB));
  feed.onTaskChanged({ rootSessionId: ROOT, sessionId: SUB, taskId: '11', status: 'SUCCESS' });
  await tick();
  assert.equal(lists.mock.callCount(), 2);
  assert.equal(latest.mock.callCount(), 2);
  feed.refresh(); await tick();
  assert.equal(lists.mock.callCount(), 3);
  assert.equal(latest.mock.callCount(), 3);
  assert.ok(lists.mock.calls.every(call => call.arguments[0] === SUB));
  assert.ok(latest.mock.calls.every(call => call.arguments[0] === SUB));
  open.value = false;
  assert.deepEqual(feed.background.tasks.value, []);
  assert.equal(feed.checklist.snapshot.value, null);
  open.value = true; await tick();
  assert.equal(lists.mock.callCount(), 4);
  assert.equal(latest.mock.callCount(), 4);
  session.value = null; await tick();
  assert.equal(feed.background.sessionId.value, null);
  for (const id of ['0', 'unknown', Number.MAX_SAFE_INTEGER + 1]) {
    session.value = { id }; await tick();
    assert.equal(feed.background.sessionId.value, null);
  }
  assert.equal(lists.mock.callCount(), 4);
  assert.equal(latest.mock.callCount(), 4);
});

test('切换成员作废迟到的任务与清单，旧输出也必须清除', async context => {
  let resolveTasks!: (value: Result<BackgroundTask[]>) => void;
  let resolveChecklist!: (value: Result<ChecklistSnapshot | null>) => void;
  const oldTasks = new Promise<Result<BackgroundTask[]>>(resolve => { resolveTasks = resolve; });
  const oldChecklist = new Promise<Result<ChecklistSnapshot | null>>(resolve => { resolveChecklist = resolve; });
  context.mock.method(BackgroundTaskAPI, 'list', async (owner: string) => owner === SUB ? oldTasks : ok([task(owner)]));
  context.mock.method(BackgroundTaskAPI, 'read', async (owner: string) => ok({ ...task(owner), output: '旧成员输出' }));
  context.mock.method(ChecklistAPI, 'latest', async (owner: string) => owner === SUB ? oldChecklist : ok(snapshot(owner)));
  const session = ref<SubSessionVO | null>({ id: SUB, rootSessionId: ROOT });
  const scope = effectScope();
  const feed = scope.run(() => useSubSessionTaskProgress(session, ref(true)))!;
  context.after(() => scope.stop());
  await tick();
  await feed.background.read('11');
  assert.equal(feed.background.detail.value?.output, '旧成员输出');
  session.value = { id: OTHER, rootSessionId: ROOT }; await tick();
  assert.equal(feed.background.detail.value, null);
  assert.equal(feed.background.selectedId.value, null);
  resolveTasks(ok([task(SUB)])); resolveChecklist(ok(snapshot(SUB))); await tick();
  assert.equal(feed.background.tasks.value[0]?.sessionId, OTHER);
  assert.equal(feed.checklist.snapshot.value?.sessionId, OTHER);
});

test('主视图转交事件与重连回查，并把子会话数据源交给底部胶囊', () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
  const view = read('../src/views/chat/useChatView.ts');
  assert.match(view, /onBackgroundTaskChanged:\s*\(event\)\s*=>\s*\{[^}]*subTaskProgress\.onTaskChanged\(event\)/);
  assert.match(view, /onEvent:\s*\(event\)\s*=>\s*\{[^}]*subTaskProgress\.onEvent\(event\)/);
  for (const callback of ['onConnectionClosed', 'onResubscribed']) {
    assert.match(view, new RegExp(`${callback}:\\s*\\([^)]*\\)\\s*=>\\s*\\{[^}]*subTaskProgress\\.refresh\\(\\)`));
  }
  assert.match(read('../src/views/chat/ChatView.vue'), /:taskProgress="subTaskProgress"/);
  const side = read('../src/components/chat/SubAgentSidePanel.vue');
  assert.match(side, /<TaskProgressDock[^>]*:background="taskProgress\.background"[^>]*:checklist="taskProgress\.checklist"[^>]*:executing="activeItem\.status === 'running'"/);
});
