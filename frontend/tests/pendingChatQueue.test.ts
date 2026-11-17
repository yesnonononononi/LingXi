/**
 * 待发送队列（pendingChat）回写编辑与撤销回写的回归测试。
 *
 * <p>验证契约：</p>
 * <ol>
 *   <li>{@code usePendingChatQueue.cancel} 成功返回 {@code true}，失败返回 {@code false}；</li>
 *   <li>{@code ChatView} 在撤销按钮左侧渲染 {@code pending-edit-btn}（含 SVG 图标），
 *       且编辑与撤销按钮都通过 {@code handlePendingRestore} 在撤销成功后将原文回写输入框并聚焦；
 *       附件先取字节再撤销 —— 反了就只剩文字。</li>
 * </ol>
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {effectScope, ref} from 'vue';
import {AgentAPI} from '../src/services/agent';
import {usePendingChatQueue} from '../src/views/chat/usePendingChatQueue';

const ls = new Map<string, string>();
(globalThis as any).window ??= {
  setTimeout: () => 0,
  clearTimeout: () => {},
  matchMedia: () => ({matches: false}),
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as any).localStorage ??= {
  getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string) => { ls.set(k, String(v)); },
  removeItem: (k: string) => { ls.delete(k); },
};

const tick = () => new Promise<void>(r => setImmediate(r));
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await tick(); };

test('usePendingChatQueue.cancel 成功返回 true，失败返回 false', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1,
    data: {
      paused: false, failure: null,
      entries: [{id: 'p1', input: 'hello', dispatching: false, attachments: [], status: 'PENDING' as const}],
    },
  }));

  let shouldFail = false;
  t.mock.method(AgentAPI, 'cancelPendingCommand', async () => {
    if (shouldFail) return {code: 0, errMsg: '撤回失败', data: undefined};
    return {code: 1, data: undefined};
  });

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    assert.equal(await queue.cancel('p1'), true);
    shouldFail = true;
    assert.equal(await queue.cancel('p1'), false);
    assert.equal(queue.error.value, '撤回失败');
  } finally {
    scope.stop();
  }
});

test('ChatView 待发送队列在撤销左侧提供 SVG 编辑图标，且编辑与撤销均在成功后回写输入框', () => {
  const chatViewPath = fileURLToPath(new URL('../src/views/chat/ChatView.vue', import.meta.url));
  const chatView = readFileSync(chatViewPath, 'utf8');

  const editPos = chatView.indexOf('data-testid="pending-edit-btn"');
  const cancelPos = chatView.indexOf('data-testid="pending-cancel-btn"');
  assert.ok(editPos > 0, '缺少 pending-edit-btn');
  assert.ok(cancelPos > editPos, 'pending-edit-btn 必须位于 pending-cancel-btn 左侧');

  const editSnippet = chatView.slice(editPos, cancelPos);
  assert.match(editSnippet, /<svg\b/);
  assert.match(editSnippet, /@click="handlePendingRestore\(entry\)"/);

  const cancelSnippet = chatView.slice(cancelPos, cancelPos + 800);
  assert.match(cancelSnippet, /@click="handlePendingRestore\(entry\)"/);

  // 附件必须在撤销之前取字节：撤销会把磁盘上的附件一起删掉。
  assert.match(
    chatView,
    /const handlePendingRestore = async \(entry: PendingTaskEntry\): Promise<void> => \{[\s\S]*?pendingQueue\.attachmentFiles\(entry\)[\s\S]*?pendingQueue\.cancel\(entry\.id\)[\s\S]*?if \(!cancelled\) return;[\s\S]*?inputAreaRef\.value\?\.setInputText\(entry\.input\);[\s\S]*?setAttachedImages\(files\)[\s\S]*?focusInput\?\.\(\);/,
  );
});
