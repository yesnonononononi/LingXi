/**
 * 待发送队列 Phase 3：图片排队、缩略图、单条「继续」、轮询退避。
 *
 * <p>这里钉的是三件会**静默**坏掉的事：</p>
 * <ol>
 *   <li>轮询间隔 —— 空队列每秒刷一次只是浪费；有排队消息还 5s 一次，用户看到的是「点了没反应」；</li>
 *   <li>缩略图地址 —— 少了 `/a` 前缀或没带会话/任务 id，图片永远 404，面板只剩破图；</li>
 *   <li>入队是否真的把图片交出去、成功后是否清空已选附件 —— 漏了就是「图没发出去，
 *       但输入框也被清空了」，用户得重新挑图。</li>
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
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await tick(); };

const entry = (id: string, status: 'PENDING' | 'PAUSED' | 'AWAITING_CONFIRM' = 'PENDING') => ({
  id, input: `内容 ${id}`, dispatching: false, status,
  attachments: [{id: `${id}a1`, name: 'a.png'}],
});

test('轮询退避：空面板 5s 一次，有排队消息时 1s 一次', async t => {
  const sessionId = ref<string | null>('s1');
  let entries: ReturnType<typeof entry>[] = [];
  let calls = 0;
  t.mock.method(AgentAPI, 'pendingCommands', async () => {
    calls++;
    return {code: 1, data: {paused: false, failure: null, entries}};
  });
  t.mock.timers.enable({apis: ['setTimeout']});

  const scope = effectScope();
  scope.run(() => usePendingChatQueue(sessionId, () => false));
  try {
    await settle();
    assert.equal(calls, 1, '进入会话立刻拉一次，不等第一个间隔');

    t.mock.timers.tick(4999);
    await settle();
    assert.equal(calls, 1, '空面板不该 1s 刷一次');

    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, 2, '空面板 5s 一次');

    // 后端开始有排队消息：间隔必须立刻收紧到 1s，用户正盯着这一条看。
    entries = [entry('p1')];
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(calls, 3);
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(calls, 4, '有排队消息时 1s 一次');
  } finally {
    scope.stop();
  }
});

test('会话在执行中时也按 1s 轮询', async t => {
  const sessionId = ref<string | null>('s1');
  let calls = 0;
  t.mock.method(AgentAPI, 'pendingCommands', async () => {
    calls++;
    return {code: 1, data: {paused: false, failure: null, entries: []}};
  });
  t.mock.timers.enable({apis: ['setTimeout']});

  const scope = effectScope();
  scope.run(() => usePendingChatQueue(sessionId, () => true));
  try {
    await settle();
    assert.equal(calls, 1);
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(calls, 2, '运行中要按 1s 盯，否则队列一到就晚 5s 才显示');
  } finally {
    scope.stop();
  }
});

test('confirm 走单条继续接口，不碰队列级 resume', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1, data: {paused: false, failure: null, entries: [entry('p1', 'AWAITING_CONFIRM')]},
  }));
  const confirmed: string[][] = [];
  t.mock.method(AgentAPI, 'confirmPendingCommand', async (owner: string, id: string) => {
    confirmed.push([owner, id]);
    return {code: 1, data: undefined};
  });
  const resumed = t.mock.method(AgentAPI, 'resumePendingCommands', async () => ({code: 1, data: undefined}));

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    assert.equal(await queue.confirm('p1'), true);
    assert.deepEqual(confirmed, [['s1', 'p1']]);
    assert.equal(resumed.mock.callCount(), 0, '单条继续不能变成整队放行');
  } finally {
    scope.stop();
  }
});

test('缩略图地址按会话 / 任务 / 附件拼，走 /a 前缀', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1, data: {paused: false, failure: null, entries: []},
  }));

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    assert.equal(queue.attachmentUrl('p1', 'a1'),
      '/a/completion/s1/pending/p1/attachments/a1');
  } finally {
    scope.stop();
  }
});

test('attachmentFiles 按附件逐个取字节，读失败的那张跳过而不是整体失败', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1, data: {paused: false, failure: null, entries: []},
  }));
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    fetched.push(String(url));
    if (String(url).endsWith('bad')) return {ok: false, blob: async () => new Blob([])};
    return {ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], {type: 'image/png'})};
  });

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    const files = await queue.attachmentFiles({
      id: 'p1', input: '带图', dispatching: false, status: 'PENDING',
      attachments: [{id: 'a1', name: 'a.png'}, {id: 'bad', name: 'bad.png'}],
    });
    assert.equal(fetched.length, 2);
    assert.equal(files.length, 1, '读不到的那张只是少一张，不能让整个回填失败');
    assert.equal(files[0].name, 'a.png');
    assert.equal(files[0].type, 'image/png');
    assert.equal(files[0].size, 3);
  } finally {
    scope.stop();
  }
});

test('ChatView 面板：缩略图懒加载 + 仅非 PENDING 给「继续」按钮', () => {
  const chatViewPath = fileURLToPath(new URL('../src/views/chat/ChatView.vue', import.meta.url));
  const chatView = readFileSync(chatViewPath, 'utf8');

  const thumbPos = chatView.indexOf('data-testid="pending-attachment-thumb"');
  assert.ok(thumbPos > 0, '缺少缩略图元素');
  // 属性顺序是 src/loading 在前、testid 在后，所以从 <img 起算，不能从 testid 往后切。
  const thumbSnippet = chatView.slice(chatView.lastIndexOf('<img', thumbPos), thumbPos + 200);
  assert.match(thumbSnippet, /loading="lazy"/, '缩略图必须懒加载：面板每秒轮询，图不能预先全拉');
  assert.match(thumbSnippet, /pendingQueue\.attachmentUrl\(entry\.id, attachment\.id\)/,
    '缩略图必须走按需接口，不能把字节塞进快照');

  const confirmPos = chatView.indexOf('data-testid="pending-confirm-btn"');
  assert.ok(confirmPos > 0, '缺少单条「继续」按钮');
  const confirmSnippet = chatView.slice(Math.max(0, confirmPos - 600),
    chatView.indexOf('data-testid="pending-edit-btn"'));
  assert.match(confirmSnippet, /entry\.status !== 'PENDING'/,
    'PENDING 的那条本来就会自动发，给按钮只会误导用户');
  assert.match(confirmSnippet, /pendingQueue\.confirm\(entry\.id\)/);
});

test('ChatInputArea：入队时把图片一起交出去，成功后清空已选附件', () => {
  const inputAreaPath = fileURLToPath(new URL('../src/components/chat/ChatInputArea.vue', import.meta.url));
  const source = readFileSync(inputAreaPath, 'utf8');

  assert.match(source,
    /props\.queueMessage\(combinedText, draft\.requirePlan, localSelectedAgentId\.value, images\)/,
    '入队必须带 images，否则排队的图片永远发不出去');
  assert.match(source,
    /props\.queueMessage\(combinedText[\s\S]{0,400}?clearImageAttachments\(\);/,
    '入队成功后必须清空已选附件，否则下一条消息会莫名其妙带上上一张图');
  assert.doesNotMatch(source,
    /attachments\.value\.length === 0 &&/,
    '「有附件就不能入队」是本次要拆掉的限制');
});
