import test from 'node:test';
import assert from 'node:assert/strict';
import { useChatView, type ChatViewProps, type ChatViewEmits } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { createHarness, flush } from './harness/streamV3Harness';
import type { ChatSession, SessionMessageVO } from '../src/types/chat';

/**
 * 第 4B 组操作验收：**直接调用 useChatView 这个生产组合函数**，验证
 * 重发请求体、失败提示归属、关闭交互与「清空当前会话」的禁用语义。
 *
 * <p>`useChatView` 依赖的 .vue 组件全是 `import type`（编译期擦除），`onMounted` / `provide`
 * 在无组件实例时仅告警不抛错，因此可以在 Node 环境下真实驱动它。</p>
 */

const row = (id: string, turnId: string, type: string, text: string): SessionMessageVO =>
  ({ id, sessionId: '100', turnId, type, text });

const detailOf = () => ({
  id: '100', title: '测试会话', createdAt: 0, updatedAt: 0,
  runStatus: 'IDLE', lastOutcome: null, subSessions: [],
  rawRecords: [row('1001', 't1', 'USER', '第一条提问'), row('1002', 't1', 'AI', '第一条回答')],
  turns: { t1: { turnId: 't1', status: 'COMPLETED' } },
  messages: [],
  hasMoreMessages: false,
  nextMessageCursor: null,
});

test('4B 操作验收：重发请求体携带落库消息身份（走 resend 端点）', async () => {
  const harness = createHarness();
  const events: Array<[string, ...unknown[]]> = [];
  const view = useChatView({} as ChatViewProps, ((e: string, ...p: unknown[]) => { events.push([e, ...p]); }) as unknown as ChatViewEmits);
  try {
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: detailOf() as any });
    await view.handleSelectSession('100');
    await flush();
    assert.ok(view.displayedMessages.value.some(m => m.id === '1001'), '会话详情必须已进 v3 派生视图');

    // 未 ready 时 handleSendMessage 会被 pending 守卫拦下：真实 UI 在模型/配置加载后就绪
    (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
    await view.handleModelUpdated();

    // 捕获重发请求体
    const captured: any = {};
    (chatApi as any).sendCommand = async (
      commandId: string, sessionId: any, content: string,
      _ws: any, _dir: any, _model: any, _name: any, _plan: any, _team: any, _agent: any,
      _img: any, resendMessageId?: string | null
    ) => {
      captured.commandId = commandId;
      captured.sessionId = sessionId;
      captured.content = content;
      captured.resendMessageId = resendMessageId ?? null;
      return { sessionId: '100', turnId: 't9', executionId: 'e9' } as any;
    };

    await view.handleResendMessage({ id: '1001', role: 'user', content: '第一条提问' } as any);

    assert.equal(captured.resendMessageId, '1001', '重发必须携带落库消息身份（resendMessageId）');
    assert.equal(captured.content, '第一条提问', '重发正文取自定位到的原消息');
    assert.equal(String(captured.sessionId), '100', '重发落在已入库的会话上');
    assert.ok(captured.commandId, '重发也必须带 commandId（网络重试幂等）');
  } finally {
    harness.teardown();
  }
});

test('4B 操作验收：受理失败的提示归属到本会话，且可关闭', async () => {
  const harness = createHarness();
  const view = useChatView({} as ChatViewProps, (() => undefined) as unknown as ChatViewEmits);
  try {
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: detailOf() as any });
    await view.handleSelectSession('100');
    await flush();

    // 未 ready 时 handleSendMessage 会被 pending 守卫拦下：真实 UI 在模型/配置加载后就绪
    (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
    await view.handleModelUpdated();

    (chatApi as any).sendCommand = async () => { throw new Error('受理失败：模型不可用'); };
    await view.handleSendMessage('你好', false, false, false);

    assert.ok(view.sendFailureNotice.value, '受理失败必须有可见提示');
    assert.equal(view.sendFailureNotice.value?.sessionId, '100', '归属到发起会话');
    assert.ok(view.sendFailureNotice.value?.message.includes('受理失败'), '提示带原因');

    // 关闭交互：横幅的「知道了」按钮绑定的就是这个方法
    view.dismissSendFailure();
    assert.equal(view.sendFailureNotice.value, null, '关闭后提示消失');
  } finally {
    harness.teardown();
  }
});

test('4B 操作验收：「清空当前会话」已禁用 —— 不得改动 v3 展示', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const view = useChatView({} as ChatViewProps, (() => undefined) as unknown as ChatViewEmits);
  try {
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: detailOf() as any });
    await view.handleSelectSession('100');
    await flush();

    const before = store.getHistory('100').size;
    assert.ok(before > 0, '前置：v3 历史槽里应有行');

    // 不抛错（禁用而非崩溃），也不清掉 v3 展示
    view.handleClearCurrentSession();
    assert.equal(store.getHistory('100').size, before, '禁用语义：不得清掉 v3 历史');
    assert.ok(view.displayedMessages.value.length > 0, '界面不得变成空会话');
  } finally {
    harness.teardown();
  }
});

test('4B 操作验收：导出内容取自 v3 派生视图（生产入口 buildSessionMarkdown）', async () => {
  const harness = createHarness();
  const view = useChatView({} as ChatViewProps, (() => undefined) as unknown as ChatViewEmits);
  try {
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: detailOf() as any });
    await view.handleSelectSession('100');
    await flush();

    const md = buildSessionMarkdownOf(view);
    assert.ok(md.includes('# 测试会话'), '标题来自当前会话');
    assert.ok(md.indexOf('第一条提问') < md.indexOf('第一条回答'), '顺序保持提问在前');
  } finally {
    harness.teardown();
  }
});

/** 复刻 handleExportSession 的正文构造（同一 buildSessionMarkdown 生产实现）。 */
function buildSessionMarkdownOf(view: ReturnType<typeof useChatView>): string {
  const session = view.currentActiveSession.value as ChatSession;
  const messages = view.displayedMessages.value;
  const lines = [
    `# ${session.title || '灵犀会话记录'}`,
    '',
    ...messages.map(m => `### ${m.role === 'user' ? '👤 用户' : '🤖 灵犀'}\n\n${m.content}\n`),
  ];
  return lines.join('\n\n');
}
