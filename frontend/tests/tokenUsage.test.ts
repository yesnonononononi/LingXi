import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCacheHitRate, resolveTokenUsage, resolveTotalTokens, resolveUncachedInputTokens } from '../src/utils/tokenUsage';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import type { ChatMessage, ChatTurn } from '../src/types/chat';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as parseSfc } from '@vue/compiler-sfc';
import postcss from 'postcss';

const message: ChatMessage = {
  id: 'message-1', role: 'assistant', content: '', timestamp: 0,
  tokenInfo: { inputTokenCount: 100, outputTokenCount: 40, totalTokenCount: 140, cacheTokens: 70, reasoningTokens: 20 },
};

test('用量入口默认透明，只有 hover 和键盘聚焦才高亮', () => {
  const source = readFileSync(new URL('../src/components/chat/TokenUsagePopover.vue', import.meta.url), 'utf8');
  const { descriptor } = parseSfc(source);
  const css = postcss.parse(descriptor.styles.map(style => style.content).join('\n'));
  const backgrounds = new Map<string, string>();
  css.walkRules(rule => {
    rule.walkDecls('background', declaration => backgrounds.set(rule.selector, declaration.value));
  });
  assert.equal(backgrounds.get('.usage-trigger'), 'transparent');
  assert.equal(backgrounds.get('.usage-trigger.dark'), 'transparent');
  for (const selector of ['.usage-trigger:hover, .usage-trigger:focus-visible', '.usage-trigger.dark:hover, .usage-trigger.dark:focus-visible']) {
    assert.ok(backgrounds.has(selector));
    assert.notEqual(backgrounds.get(selector), 'transparent');
  }
});

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

test('缓存命中率以总输入量为分母，未缓存输入为输入减缓存读取', () => {
  const usage = { inputTokenCount: 320577, outputTokenCount: 11580, totalTokenCount: 332157, cacheTokens: 312320 };
  assert.equal(resolveCacheHitRate(usage), 312320 / 320577);
  assert.equal((resolveCacheHitRate(usage)! * 100).toFixed(1), '97.4');
  assert.equal(resolveUncachedInputTokens(usage), 8257);
  assert.equal(resolveCacheHitRate({ inputTokenCount: 100, cacheTokens: 0 }), 0);
  assert.equal(resolveUncachedInputTokens({ inputTokenCount: 100, cacheTokens: 0 }), 100);
  for (const unknown of [null, {}, { inputTokenCount: 0, cacheTokens: 0 }, { inputTokenCount: 100 }, { cacheTokens: 20 }]) {
    assert.equal(resolveCacheHitRate(unknown), null);
  }
  assert.equal(resolveUncachedInputTokens(null), null);
  assert.equal(resolveUncachedInputTokens({ inputTokenCount: 100 }), null);
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
    assert.ok(!/\btok\b/.test(live));
    for (const text of ['Round usage', 'Uncached input', '30 token', 'Cache read', '70 token', '70.0%', '40 token', 'including reasoning 20 token', 'popover="auto"']) {
      assert.ok(live.includes(text), `${text}: ${live}`);
    }
    const turn: ChatTurn = { turnId: 'turn-1', status: 'FAILED', inputTokens: 80,
      outputTokens: 30, totalTokens: 110, cacheTokens: 0, reasoningTokens: null,
      modelName: 'model-1', modelProvider: 'provider-1' };
    const history = await renderToString(createSSRApp(component, { ...props, turn }));
    assert.ok(history.includes('80 token'));
    assert.ok(history.includes('0.0%'));
    assert.ok(history.includes('including reasoning None'));
    assert.ok(history.includes('provider-1/model-1'));
    assert.ok(!history.includes('70 token'));
    const head = await renderToString(createSSRApp(component, { ...props, isGroupTail: false }));
    assert.ok(!head.includes('Round usage'));
    i18n.useI18n().locale.value = 'zh-CN';
    const chinese = await renderToString(createSSRApp(component, props));
    for (const text of ['本轮用量', '提供方 / 模型', '缓存命中', '未缓存输入', '缓存读取', '70.0%', '其中推理 20 token']) {
      assert.ok(chinese.includes(text), text);
    }
    for (const status of ['CANCELLED', 'FAILED'] as const) {
      const terminalProps = {
        ...props,
        turn: { ...turn, status },
        message: { ...message, isComplete: true, cancelled: status === 'CANCELLED', failed: status === 'FAILED',
          thoughtSteps: [{ id: 'thought-1', title: '思考', content: '尚未产出正文', status: 'success' as const }] },
      };
      const terminal = await renderToString(createSSRApp(component, terminalProps));
      assert.ok(terminal.includes('本轮用量'), `${status} 只有思考内容也必须展示用量`);
      assert.ok(terminal.includes('110 token'), '必须展示轮次的真实累计用量');
      const terminalHead = await renderToString(createSSRApp(component, { ...terminalProps, isGroupTail: false }));
      assert.ok(!terminalHead.includes('本轮用量'), '终态仍然只在组尾展示');
      const running = await renderToString(createSSRApp(component, {
        ...terminalProps, turn: { ...turn, status: 'RUNNING' },
      }));
      assert.ok(!running.includes('本轮用量'), '运行态守卫不能被终态气泡标记绕过');
    }
  } finally {
    await server.close();
  }
});
