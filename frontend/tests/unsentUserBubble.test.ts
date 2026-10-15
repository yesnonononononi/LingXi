/**
 * 「未发送」幽灵气泡守卫（2026-10-15 缺陷复盘）。
 *
 * <p><b>缺陷形态</b>：受理被拒（单飞校验 / 前置校验 / 通道未就绪 / 网络失败）时，本地乐观气泡
 * 既不移除也不打标 —— 它留在界面上冒充「已发送」，但后端**根本没有这条消息**（不在 transcript、
 * 不在模型上下文）。用户因此会误以为提问已发出、只是模型没回。</p>
 *
 * <p><b>修复口径</b>：受理被拒即打「未发送」标记（绝不呈现成已发送），并给出重发入口；
 * 重发前先移除那条幽灵，再由发送链路 push 新气泡。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import type { ChatMessage } from '../src/types/chat';

/** tsx 以 ESM 运行本文件：__dirname 不存在，锚定测试文件所在目录。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function setup() {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  return { messages, reducer };
}

test('受理被拒：最新乐观气泡被标为未发送，且不影响其它消息', () => {
  const { messages, reducer } = setup();
  reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'e', timestamp: '', metaData: { sessionId: '7', turnId: '900' } });
  const assistant = messages[0]!;
  const bubble = reducer.pushUserMessage('现在是完全访问了,你来试试');
  assert.equal(bubble.turnId, null, '乐观气泡绑定 turnId 之前应为 null');
  assert.notEqual(bubble.unsent, true, '刚 push 的气泡不得预设为未发送');

  reducer.markUserMessageUnsent();

  assert.equal(bubble.unsent, true, '受理被拒后必须标记未发送');
  assert.notEqual(assistant.unsent, true, '助手消息不受影响');
});

test('已受理（已绑定 turnId）的气泡不得被标未发送', () => {
  const { reducer } = setup();
  const bubble = reducer.pushUserMessage('继续');
  reducer.bindUserMessageTurn('900');
  assert.equal(bubble.turnId, '900');

  reducer.markUserMessageUnsent();

  assert.notEqual(bubble.unsent, true, '受理成功的气泡由后端权威数据负责，本地不得改写状态');
});

test('标记可重复调用且幂等', () => {
  const { reducer } = setup();
  const bubble = reducer.pushUserMessage('重试');
  reducer.markUserMessageUnsent();
  reducer.markUserMessageUnsent();
  assert.equal(bubble.unsent, true);
});

test('重发前移除幽灵：只允许移除未绑定轮次的用户气泡', () => {
  const { messages, reducer } = setup();
  const phantom = reducer.pushUserMessage('幽灵');
  reducer.markUserMessageUnsent();

  reducer.removeUnsentUserMessage(phantom.id);
  assert.equal(messages.some(m => m.id === phantom.id), false, '未发送气泡应被移除');

  // 已受理的气泡不得被本地删除（会与 transcript 不一致）
  const accepted = reducer.pushUserMessage('已受理');
  reducer.bindUserMessageTurn('901');
  reducer.removeUnsentUserMessage(accepted.id);
  assert.equal(messages.some(m => m.id === accepted.id), true, '已受理气泡不得被移除');

  // 不存在的 id 是空操作
  reducer.removeUnsentUserMessage('not-exist');
  assert.equal(messages.length, 1);
});

test('接线守卫：拒稿路径打标、气泡渲染未发送态、重发贯通到宿主', () => {
  const read = (rel: string): string => {
    const source = fs.readFileSync(path.resolve(HERE, rel), 'utf8');
    assert.ok(source.length > 0, `${rel} 读取为空，断言不成立（金丝雀）`);
    return source;
  };
  const useChatView = read('../src/views/chat/useChatView.ts');
  const item = read('../src/components/chat/ChatMessageItem.vue');
  const list = read('../src/components/chat/ChatMessageList.vue');
  const view = read('../src/views/chat/ChatView.vue');
  const router = read('../src/views/chat/streamSessionRouter.ts');

  // 金丝雀：先证明关键锚点确实存在，否则下面的「包含」断言可能因为改名而假绿
  assert.match(useChatView, /onSendFailure:/, '未找到 onSendFailure 处理器');
  assert.match(router, /markUserMessageUnsent/, '路由器未暴露标记能力');

  assert.match(useChatView, /streamRouter\.markUserMessageUnsent\(\)/,
    '受理被拒时必须把本地气泡标成未发送（否则幽灵会被当成已发送）');
  assert.match(item, /data-testid="unsent-badge"/, '用户气泡缺少「未发送」标识');
  assert.match(item, /emit\('resendUnsent', props\.message\.id\)/, '缺少重发入口');
  assert.match(list, /@resendUnsent=/, '消息列表未透传重发事件');
  assert.match(view, /@resendUnsent="handleResendUnsent"/, 'ChatView 未接重发处理器');
  assert.match(useChatView, /const handleResendUnsent = async/, '缺少重发实现');
  assert.match(useChatView, /streamRouter\.removeUnsentUserMessage\(messageId\)/,
    '重发前必须先移除幽灵气泡，避免与新的乐观气泡并存');
});
