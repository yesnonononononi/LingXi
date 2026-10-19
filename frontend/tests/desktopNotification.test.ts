import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotificationGate,
  GLOBAL_COOLDOWN_MS,
  SESSION_COOLDOWN_MS,
} from '../src/composables/useDesktopNotification';
import {
  micaSupportedFor,
  normalizePayload,
  TITLE_MAX,
  BODY_MAX,
} from '../electron/notification-window.cjs';

/* ---------------------------------------------------------------- 材质判定 */

test('Mica 只在 Windows 11 22H2（build 22621）及以上启用', () => {
  assert.equal(micaSupportedFor('win32', '10.0.22621'), true);
  assert.equal(micaSupportedFor('win32', '10.0.26200'), true);
  // 21H2（22000）不支持 Mica，是最容易被「Windows 11」四个字骗过去的边界
  assert.equal(micaSupportedFor('win32', '10.0.22000'), false);
  assert.equal(micaSupportedFor('win32', '10.0.19045'), false);
});

test('非 Windows 平台一律不启用 Mica', () => {
  assert.equal(micaSupportedFor('darwin', '23.0.0'), false);
  assert.equal(micaSupportedFor('linux', '6.5.0'), false);
});

test('版本号残缺时按不支持处理，不能把 NaN 当通过', () => {
  assert.equal(micaSupportedFor('win32', ''), false);
  assert.equal(micaSupportedFor('win32', '10.0'), false);
  assert.equal(micaSupportedFor('win32', '10.0.abc'), false);
});

/* ---------------------------------------------------------------- 请求归一化 */

test('标题与正文按上限截断，且标题缺省回落为 LX', () => {
  const long = 'x'.repeat(TITLE_MAX + 50);
  const payload = normalizePayload({ title: long, body: 'y'.repeat(BODY_MAX + 50) });
  assert.equal(payload.title.length, TITLE_MAX);
  assert.equal(payload.body.length, BODY_MAX);
  assert.equal(normalizePayload({}).title, 'LX');
  assert.equal(normalizePayload({ title: '   ' }).title, 'LX');
});

test('未知 kind 归一为 completed，非法 theme 归一为 dark', () => {
  assert.equal(normalizePayload({ kind: 'exploded' }).kind, 'completed');
  assert.equal(normalizePayload({ kind: 'suspended' }).kind, 'suspended');
  assert.equal(normalizePayload({ theme: 'neon' }).theme, 'dark');
  assert.equal(normalizePayload({ theme: 'light' }).theme, 'light');
});

test('sessionId 统一转字符串，非字符串数字一律置空', () => {
  assert.equal(normalizePayload({ sessionId: 42 }).sessionId, '42');
  assert.equal(normalizePayload({ sessionId: '42' }).sessionId, '42');
  assert.equal(normalizePayload({ sessionId: { evil: true } }).sessionId, null);
  assert.equal(normalizePayload({ sessionId: undefined }).sessionId, null);
});

test('非法 duration 不落成 NaN 或负数', () => {
  assert.equal(normalizePayload({}).duration, undefined);
  assert.equal(normalizePayload({ duration: -1 }).duration, undefined);
  assert.equal(normalizePayload({ duration: Number.NaN }).duration, undefined);
  assert.equal(normalizePayload({ duration: 5000 }).duration, 5000);
});

test('null / 非对象输入不炸，直接给一份可用的默认值', () => {
  assert.deepEqual(normalizePayload(null), {
    title: 'LX', body: '', sessionId: null, kind: 'completed', duration: undefined, theme: 'dark',
  });
  assert.equal(normalizePayload('boom').title, 'LX');
});

/* ---------------------------------------------------------------- 通知闸门 */

test('全局冷却期内任何通知都不放行', () => {
  const gate = new NotificationGate(10_000, 3_000);
  assert.equal(gate.accept('s1', 'completed', 1_000), true);
  // 不同会话、不同种类，但落在全局冷却窗口内
  assert.equal(gate.accept('s2', 'failed', 1_000 + GLOBAL_COOLDOWN_MS - 1), false);
  assert.equal(gate.accept('s2', 'failed', 1_000 + GLOBAL_COOLDOWN_MS), true);
});

test('同一会话同一结果在冷却期内只弹一次', () => {
  const gate = new NotificationGate(SESSION_COOLDOWN_MS, 0);
  assert.equal(gate.accept('s1', 'suspended', 1_000), true);
  assert.equal(gate.accept('s1', 'suspended', 1_000 + SESSION_COOLDOWN_MS - 1), false);
  assert.equal(gate.accept('s1', 'suspended', 1_000 + SESSION_COOLDOWN_MS), true);
});

test('同一会话的不同结果互不压制（挂起与失败要分别告知）', () => {
  const gate = new NotificationGate(SESSION_COOLDOWN_MS, 0);
  assert.equal(gate.accept('s1', 'suspended', 1_000), true);
  assert.equal(gate.accept('s1', 'failed', 1_000), true);
});

test('不同会话互不压制（团队并发各跑各的）', () => {
  const gate = new NotificationGate(SESSION_COOLDOWN_MS, 0);
  assert.equal(gate.accept('s1', 'completed', 1_000), true);
  assert.equal(gate.accept('s2', 'completed', 1_000), true);
});

test('sessionId 缺失时归入同一个桶，仍然受冷却约束', () => {
  const gate = new NotificationGate(SESSION_COOLDOWN_MS, 0);
  assert.equal(gate.accept(null, 'completed', 1_000), true);
  assert.equal(gate.accept(undefined, 'completed', 1_500), false);
});

test('reset 后闸门回到初始状态', () => {
  const gate = new NotificationGate(10_000, 3_000);
  assert.equal(gate.accept('s1', 'completed', 1_000), true);
  gate.reset();
  assert.equal(gate.accept('s1', 'completed', 1_001), true);
});
 
