/**
 * 子会话「模型重试」可见性 + 重试文案格式化的回归测试。
 *
 * <p>两个真实缺陷的守卫：(1) 子会话详情抽屉自带历史副本，收不到实时事件，模型重试期间
 * 那里什么都不显示；(2) 重试提示文案只有主气泡里一份，`retryDelay` 采了不用。
 * 现在两处共用 `ModelRetryNotice` + `views/chat/modelRetryStatus.ts`，历史分页统一经
 * `absorbSubSessionHistory` 写进 VO 上的实时数组。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChatSession, ChatMessage, SubSessionVO } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';
import { messages as dictionaries } from '../src/i18n/messages';
import { formatRetryDelay, resolveModelRetryText } from '../src/views/chat/modelRetryStatus';
import { absorbSubSessionHistory, type SubSessionHistoryPage } from '../src/views/chat/subSessionHistory';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

function dictValue(locale: 'zh-CN' | 'en-US', key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return (node as Record<string, unknown>)[segment];
  }, dictionaries[locale]);
}

/* ------------------------------------------------------------------ */
/* 文案与单位换算                                                       */
/* ------------------------------------------------------------------ */

test('毫秒 → 秒：整数不带小数点，非正/非有限值不产出文案', () => {
  assert.equal(formatRetryDelay(1500), '1.5');
  assert.equal(formatRetryDelay(250), '0.3');
  assert.equal(formatRetryDelay(2000), '2');
  assert.equal(formatRetryDelay(0), '');
  assert.equal(formatRetryDelay(-5), '');
  assert.equal(formatRetryDelay(undefined), '');
  assert.equal(formatRetryDelay(Number.NaN), '');
});

test('没有重试态就没有文案（调用方据此决定整行是否渲染）', () => {
  assert.equal(resolveModelRetryText(null), '');
  assert.equal(resolveModelRetryText(undefined), '');
});

test('亚秒级等待不写时长：线上常见 retryDelay=0，写出来只会闪一下', () => {
  assert.equal(resolveModelRetryText({ retryCount: 1, retryDelay: 0 }), '请求暂时失败，正在第 1 次重试…');
  assert.equal(resolveModelRetryText({ retryCount: 3, retryDelay: 999 }), '请求暂时失败，正在第 3 次重试…');
});

test('等待够长时把秒数带进文案，且与次数同时出现', () => {
  assert.equal(
    resolveModelRetryText({ retryCount: 2, retryDelay: 2500 }),
    '请求暂时失败，第 2 次重试将在 2.5 秒后开始…'
  );
});

test('非法计数按第 1 次展示，不把 NaN 写进界面', () => {
  assert.equal(resolveModelRetryText({ retryCount: 0, retryDelay: 0 }), '请求暂时失败，正在第 1 次重试…');
  assert.equal(resolveModelRetryText({ retryCount: Number.NaN, retryDelay: 0 }), '请求暂时失败，正在第 1 次重试…');
});

test('中英字典都提供带等待时长的键，占位符齐全', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    const template = dictValue(locale, 'chat.message.retryingWithDelay');
    assert.equal(typeof template, 'string', `${locale} 缺少 retryingWithDelay`);
    assert.match(template as string, /\{count\}/, `${locale} 缺少 {count}`);
    assert.match(template as string, /\{delay\}/, `${locale} 缺少 {delay}`);
  }
});

/* ------------------------------------------------------------------ */
/* 历史分页并入实时数组                                                 */
/* ------------------------------------------------------------------ */

function turnView(overrides: Partial<TurnViewVO> = {}): TurnViewVO {
  return {
    sessionId: '8',
    turnId: '901',
    status: 'RUNNING',
    viewVersion: '2',
    userMessage: '任务',
    blocks: [],
    ...overrides,
  };
}

function page(views: TurnViewVO[], turns: SubSessionHistoryPage['turns'] = {}): SubSessionHistoryPage {
  return {
    records: [],
    messages: [],
    turns,
    turnViews: Object.fromEntries(views.map(view => [view.turnId, view])),
    nextCursor: null,
    hasMore: false,
  };
}

test('历史分页写进会话 VO 的实时数组，不另建副本', () => {
  const sub: SubSessionVO = { id: '8', rootSessionId: '7', name: '成员', messages: [] };
  const live = sub.messages;
  absorbSubSessionHistory(sub, page([turnView({
    blocks: [{ blockId: 'text:900', type: 'TEXT', responseId: '900', order: 1, status: 'COMPLETE', text: '历史正文', isBody: true }],
  })]));
  // 一轮 = 用户提问 + 助手气泡，两条都落在同一份数组里。
  assert.equal(sub.messages?.length, 2);
  const bubble = sub.messages?.find(message => message.role === 'assistant');
  assert.equal(bubble?.content, '历史正文');
  // 实时 reducer 与历史写入的是同一份数组：身份不变才能保证两边同步。
  assert.equal(bubble, live?.find(message => message.role === 'assistant'));
});

test('重复并入同一页不会产生第二条气泡', () => {
  const sub: SubSessionVO = { id: '8', rootSessionId: '7', name: '成员', messages: [] };
  const view = turnView({
    blocks: [{ blockId: 'text:900', type: 'TEXT', responseId: '900', order: 1, status: 'COMPLETE', text: '历史正文', isBody: true }],
  });
  absorbSubSessionHistory(sub, page([view]));
  absorbSubSessionHistory(sub, page([view]));
  assert.equal(sub.messages?.filter(message => message.role === 'assistant').length, 1);
});

test('整轮缺失、只有 FAILED 摘要时补合成失败气泡（历史侧唯一兜底）', () => {
  const sub: SubSessionVO = { id: '8', rootSessionId: '7', name: '成员', messages: [] };
  absorbSubSessionHistory(sub, page([], {
    '902': { turnId: '902', status: 'FAILED', errorReason: '模型超时' } as SubSessionHistoryPage['turns'][string],
  }));
  const bubble = sub.messages?.find(message => message.role === 'assistant');
  assert.ok(bubble, '失败轮必须留下一条助手气泡');
  assert.equal(bubble?.isComplete, true);
  assert.match(String(bubble?.content), /模型超时/);
});

test('历史补齐不能抹掉实时的重试提示（抽屉看得见重试的前提）', () => {
  const root: ChatSession = {
    id: '7', title: '主会话', createdAt: 0, updatedAt: 0, modelId: '1', activeTools: [], messages: [],
    subSessions: [{ id: '8', rootSessionId: '7', name: '成员', messages: [] }],
  };
  const router = new StreamSessionRouter();
  router.bindRootSession(root);
  router.dispatch({ type: 'EXECUTION_STARTED', executionId: 'root', timestamp: '', metaData: { turnId: '900', sessionId: '7' } });
  const childMeta = { rootSessionId: '7', sessionId: '8', turnId: '901', parentTurnId: '900' };
  router.dispatch({ type: 'EXECUTION_STARTED', executionId: 'child', timestamp: '', metaData: childMeta });
  router.dispatch({
    type: 'INVOKE_RETRY', executionId: 'child', timestamp: '', metaData: childMeta,
    responseId: '9007199254740992', retryCount: 2, retryDelay: 1500, timeUnit: 'MILLISECONDS',
  });
  const sub = root.subSessions![0]!;
  const bubble = sub.messages?.find(message => message.role === 'assistant');
  assert.deepEqual(bubble?.modelRetry, { responseId: '9007199254740992', retryCount: 2, retryDelay: 1500 });
  const liveMessages: ChatMessage[] | undefined = sub.messages;

  absorbSubSessionHistory(sub, page([turnView()]));

  const after = sub.messages?.find(message => message.role === 'assistant');
  assert.equal(after, bubble, '历史补齐必须就地更新同一条气泡，不能换对象');
  assert.deepEqual(after?.modelRetry, { responseId: '9007199254740992', retryCount: 2, retryDelay: 1500 });
  assert.equal(sub.messages?.length, liveMessages?.length);
});

/* ------------------------------------------------------------------ */
/* 接线守卫：两个渲染点共用同一份实现                                   */
/* ------------------------------------------------------------------ */

test('主消息气泡只保留压缩条，重试提示交给 ModelRetryNotice', () => {
  const source = read('../src/components/chat/ChatMessageItem.vue');
  assert.ok(source.includes('<ModelRetryNotice v-if="props.message.modelRetry"'), '主气泡未挂载重试提示组件');
  assert.ok(!source.includes('isCompressingContext || props.message.modelRetry'), '压缩条不应再兼职重试提示');
  assert.ok(!source.includes('activityStatusText'), '旧的三元文案应已移除，避免两套口径');
});

test('子会话详情抽屉读实时数组并渲染重试提示', () => {
  const source = read('../src/components/chat/SubSessionDetailDrawer.vue');
  assert.ok(source.includes('props.subSession?.messages ?? []'), '抽屉必须读会话 VO 上的实时数组');
  assert.ok(!source.includes('const messages = ref<'), '抽屉不得再持有私有消息副本');
  assert.ok(source.includes('<ModelRetryNotice v-if="msg.modelRetry"'), '抽屉未渲染重试提示');
});

test('子会话历史吸入逻辑只有一处实现，面板与抽屉都走它', () => {
  const hook = read('../src/views/chat/useChatSubSession.ts');
  const drawer = read('../src/components/chat/SubSessionDetailDrawer.vue');
  assert.equal((hook.match(/absorbSubSessionHistory\(/g) ?? []).length, 2, '选中加载与翻页都应复用同一实现');
  assert.ok(hook.includes('absorbSubSessionHistory'), '面板未复用吸入逻辑');
  assert.ok(drawer.includes('absorbSubSessionHistory('), '抽屉未复用吸入逻辑');
  assert.ok(!hook.includes('selectedSubSessionForDetail.value ='), '详情目标必须按 id 解析，不能缓存 VO 对象');
});
