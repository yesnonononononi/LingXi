import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTokenUsage, resolveTotalTokens } from '../src/utils/tokenUsage';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import type { ChatMessage, ChatTurn } from '../src/types/chat';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fileURLToPath } from 'node:url';

const message: ChatMessage = {
  id: 'message-1', role: 'assistant', content: '', timestamp: 0,
  tokenInfo: { inputTokenCount: 100, outputTokenCount: 40, totalTokenCount: 140, cacheTokens: 70, reasoningTokens: 20 },
};

test('历史与实时用量保持同一明细，缓存和推理不重复计入总量', () => {
  const turn: ChatTurn = {
    turnId: 'turn-1', status: 'COMPLETED', inputTokens: 100, outputTokens: 40,
    totalTokens: 140, cacheTokens: 70, reasoningTokens: 20,
  };
  assert.deepEqual(resolveTokenUsage(turn, message), message.tokenInfo);
  assert.deepEqual(resolveTokenUsage(null, message), message.tokenInfo);
  assert.equal(resolveTotalTokens(message.tokenInfo!), 140);
  assert.equal(resolveTotalTokens({ inputTokenCount: 100, outputTokenCount: 40, cacheTokens: 70, reasoningTokens: 20 }), 140);
  assert.equal(resolveTotalTokens({ inputTokenCount: 100, cacheTokens: 70 }), null);
});

test('权威轮次的未知值不被气泡覆盖，真实 0 与未知可区分', () => {
  const turn: ChatTurn = { turnId: 'turn-1', status: 'CANCELLED', cacheTokens: 0, reasoningTokens: null };
  const usage = resolveTokenUsage(turn, message)!;
  assert.equal(usage.cacheTokens, 0);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.totalTokenCount, undefined);
  assert.equal(resolveTotalTokens(usage), null);
  assert.equal(resolveTotalTokens({ totalTokenCount: 0 }), 0);
  assert.equal(resolveTokenUsage(null, { ...message, tokenInfo: undefined }), null);
});

for (const type of ['EXECUTION_COMPLETED', 'EXECUTION_FAILED', 'EXECUTION_CANCELLED'] as const) {
  test(`${type} 实时保留五项用量，未采集不会补 0`, () => {
    const messages: ChatMessage[] = [];
    const reducer = new TurnStreamReducer(messages, { sessionId: 'session-1' });
    reducer.consume({ type: 'EXECUTION_STARTED', executionId: 'exec-1', metaData: { turnId: 'turn-1' } });
    reducer.consume({ type, executionId: 'exec-1', tokenInfo: message.tokenInfo, metaData: { turnId: 'turn-1' } });
    assert.deepEqual(messages[0].tokenInfo, message.tokenInfo);
    assert.equal(messages[0].isComplete, true);

    const unknownMessages: ChatMessage[] = [];
    const unknown = new TurnStreamReducer(unknownMessages, { sessionId: 'session-2' });
    unknown.consume({ type: 'EXECUTION_STARTED', executionId: 'exec-2', metaData: { turnId: 'turn-2' } });
    unknown.consume({ type, executionId: 'exec-2', tokenInfo: null, metaData: { turnId: 'turn-2' } });
    assert.equal(unknownMessages[0].tokenInfo, undefined);
  });
}

test('实际消息组件同时展示历史和实时明细，仅在组尾展示', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom',
    plugins: [{
      name: 'token-test-markdown', enforce: 'pre',
      // Markdown 净化依赖浏览器 DOM，本用例只验证消息工具栏。
      load(id) {
        if (id.replaceAll('\\', '/').endsWith('/MarkdownRenderer.vue')) return '<template><div /></template>';
      },
    }],
  });
  try {
    const component = (await server.ssrLoadModule('/src/components/chat/ChatMessageItem.vue')).default;
    const i18n = await server.ssrLoadModule('/src/i18n/index.ts');
    i18n.useI18n().locale.value = 'en-US';
    const props = { message: { ...message, content: '回答内容', isComplete: true }, isGroupTail: true };
    const live = await renderToString(createSSRApp(component, props));
    for (const text of ['Input 100', 'Output 40', 'Cached 70', 'Reasoning 20']) {
      assert.ok(live.includes(text), `${text}: ${live}`);
    }
    assert.ok(live.includes('cached: 70'));
    assert.ok(live.includes('reasoning: 20'));
    const turn: ChatTurn = { turnId: 'turn-1', status: 'FAILED', inputTokens: 80,
      outputTokens: 30, totalTokens: 110, cacheTokens: 0, reasoningTokens: null };
    const history = await renderToString(createSSRApp(component, { ...props, turn }));
    assert.ok(history.includes('Input 80'));
    assert.ok(history.includes('Cached 0'));
    assert.ok(history.includes('Reasoning None'));
    assert.ok(!history.includes('Cached 70'));
    const head = await renderToString(createSSRApp(component, { ...props, isGroupTail: false }));
    assert.ok(!head.includes('Cached 70'));
    i18n.useI18n().locale.value = 'zh-CN';
    const chinese = await renderToString(createSSRApp(component, props));
    for (const text of ['输入 100', '输出 40', '缓存命中 70', '推理 20', '其中缓存命中: 70', '其中推理: 20']) {
      assert.ok(chinese.includes(text), text);
    }
  } finally {
    await server.close();
  }
});
