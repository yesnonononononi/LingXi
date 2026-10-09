import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentAPI } from '../src/services/agent';
import { useChatImageAttachments } from '../src/composables/useChatImageAttachments';
import { upsertTurnViewIntoMessages } from '../src/views/chat/blockProjection';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import type { ChatMessage } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';

const image = (name: string) => new File([name], name, { type: 'image/png' });

test('数量来自接口：累加选择、超限整批拒绝，删除和清空释放预览', async (t) => {
  t.mock.method(AgentAPI, 'chatLimits', async () => ({ code: 1, data: { maxImages: 3 } }));
  const create = t.mock.method(URL, 'createObjectURL', file => `blob:${(file as File).name}`);
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const state = useChatImageAttachments();
  state.addImages([image('blocked.png')]);
  assert.equal(state.attachments.value.length, 0);
  await state.loadLimits();
  state.addImages([image('a.png'), image('b.png')]);
  state.addImages([image('c.png')]);
  assert.equal(state.attachments.value.length, 3);
  state.addImages([image('d.png')]);
  assert.match(state.attachmentError.value, /最多上传 3 张/);
  assert.equal(state.attachments.value.length, 3);
  assert.equal(create.mock.callCount(), 3);
  state.removeImage(1);
  assert.equal(revoke.mock.calls[0]?.arguments[0], 'blob:b.png');
  assert.deepEqual(state.attachments.value.map(item => item.file.name), ['a.png', 'c.png']);
  state.clearImages();
  assert.equal(revoke.mock.callCount(), 3);
});

test('限制加载失败不能自行猜上限，重试后采用新值', async (t) => {
  let request = 0;
  t.mock.method(AgentAPI, 'chatLimits', async () => {
    if (request++ === 0) throw new Error('网络断开');
    return { code: 1, data: { maxImages: 2 } };
  });
  const state = useChatImageAttachments();
  await state.loadLimits();
  assert.equal(state.maxImages.value, null);
  assert.equal(state.canAttach.value, false);
  assert.equal(state.limitsError.value, '网络断开');
  await state.loadLimits();
  assert.equal(state.maxImages.value, 2);
  assert.equal(state.canAttach.value, true);
});

test('实际发送 API 使用重复 multipart 字段保留所有图片和地址顺序', async (t) => {
  let body: FormData | undefined;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    body = options?.body as FormData;
    return Response.json({ code: 1, data: { sessionId: '42', turnId: '43' } });
  });
  await AgentAPI.acceptCommand({ input: '比较图片', sessionId: '42', modelId: 1, workspaceId: 1,
    agentId: 1, workDir: '', requirePlan: false, image: [image('a.png'), image('b.png')],
    imageUrl: ['https://example.com/a.png', 'https://example.com/b.png'] });
  assert.deepEqual(body!.getAll('image').map(item => (item as File).name), ['a.png', 'b.png']);
  assert.deepEqual(body!.getAll('imageUrl'), ['https://example.com/a.png', 'https://example.com/b.png']);
});

test('实时提问与刷新历史保留所有图片，权威历史替换预览且不重复建气泡', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: '42' });
  reducer.pushUserMessage('比较图片', ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']);
  reducer.bindUserMessageTurn('43');
  assert.equal(messages[0]?.imageUrls?.length, 2);
  const history: TurnViewVO = { sessionId: '42', turnId: '43', status: 'COMPLETED', viewVersion: 1,
    userMessage: '比较图片', userImageUrls: ['https://example.com/a.png', 'https://example.com/b.png'], blocks: [] };
  upsertTurnViewIntoMessages(messages, history, new Map());
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.deepEqual(messages[0]?.imageUrls, history.userImageUrls);
  const reloaded: ChatMessage[] = [];
  upsertTurnViewIntoMessages(reloaded, history, new Map());
  assert.deepEqual(reloaded.find(message => message.role === 'user')?.imageUrls, history.userImageUrls);
});

test('只有图片的失败轮次仍能还原用户提问', () => {
  const messages: ChatMessage[] = [];
  upsertTurnViewIntoMessages(messages, { sessionId: '42', turnId: '43', status: 'FAILED', viewVersion: 1,
    userImageUrls: ['https://example.com/a.png', 'https://example.com/b.png'], blocks: [] }, new Map());
  assert.deepEqual(messages[0]?.imageUrls, ['https://example.com/a.png', 'https://example.com/b.png']);
});
