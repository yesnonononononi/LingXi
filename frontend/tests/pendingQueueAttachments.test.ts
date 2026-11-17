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

test('attachmentFiles 按附件逐个取字节，配对附件 id，读失败的那张跳过而不是整体失败', async t => {
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
    const restored = await queue.attachmentFiles({
      id: 'p1', input: '带图', dispatching: false, status: 'PENDING',
      attachments: [{id: 'a1', name: 'a.png'}, {id: 'bad', name: 'bad.png'}],
    });
    assert.equal(fetched.length, 2);
    assert.equal(restored.length, 1, '读不到的那张只是少一张，不能让整个回填失败');
    // 配对不能丢：提交时要按 File 对象反推「用户还留着哪个附件 id」，丢了对不上号。
    assert.equal(restored[0].id, 'a1');
    assert.equal(restored[0].file.name, 'a.png');
    assert.equal(restored[0].file.type, 'image/png');
    assert.equal(restored[0].file.size, 3);
  } finally {
    scope.stop();
  }
});

test('update 走 PUT，带上保留的附件 id、新图与整笔覆盖的模型/执行体/计划模式', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1, data: {paused: false, failure: null, entries: [entry('p1')]},
  }));
  const calls: any[] = [];
  t.mock.method(AgentAPI, 'updatePendingCommand', async (_sessionId: string, id: string, change: any) => {
    calls.push({id, change});
    return {code: 1, data: undefined};
  });
  const cancelled = t.mock.method(AgentAPI, 'cancelPendingCommand', async () => ({code: 1, data: undefined}));

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    const added = new File([new Uint8Array([9])], 'new.png', {type: 'image/png'});
    assert.equal(await queue.update('p1', {
      input: '改过的文本', keepAttachmentIds: ['a1'], images: [added],
      requirePlan: true, modelId: '31', agentId: 7,
    }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'p1');
    assert.deepEqual(calls[0].change, {
      input: '改过的文本', keepAttachmentIds: ['a1'], images: [added],
      requirePlan: true, modelId: '31', agentId: 7,
    });
    assert.equal(cancelled.mock.callCount(), 0, '原位修改不能退化成撤销');
  } finally {
    scope.stop();
  }
});

test('update 失败时返回 false 并把后端文案暴露给面板', async t => {
  const sessionId = ref<string | null>('s1');
  t.mock.method(AgentAPI, 'pendingCommands', async () => ({
    code: 1, data: {paused: false, failure: null, entries: [entry('p1')]},
  }));
  t.mock.method(AgentAPI, 'updatePendingCommand', async () => ({code: 0, errMsg: '这条消息正在发送', data: undefined}));

  const scope = effectScope();
  const queue = scope.run(() => usePendingChatQueue(sessionId, () => false))!;
  try {
    await settle();
    assert.equal(await queue.update('p1', {
      input: '文本', images: [], requirePlan: false, modelId: null, agentId: null,
    }), false);
    assert.equal(queue.error.value, '这条消息正在发送');
  } finally {
    scope.stop();
  }
});

test('ChatView 面板：缩略图懒加载 + 仅非 PENDING 给「继续」按钮 + 编辑态提示条', () => {
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

  // 编辑态：有可见提示 + 可取消，否则用户分不清「在改那条」还是「在发新消息」。
  assert.match(chatView, /data-testid="pending-edit-banner"/);
  assert.match(chatView, /data-testid="pending-edit-cancel"[\s\S]{0,200}@click="cancelQueuedEdit"/);
  assert.match(chatView, /:editingQueued="!!editingPending"/);
  assert.match(chatView, /:updateQueuedMessage="editingPending \? handleUpdateQueuedMessage : undefined"/);
});

test('编辑提交：保留的图按对象引用翻成附件 id，新图才作为上传追加', () => {
  const chatViewPath = fileURLToPath(new URL('../src/views/chat/ChatView.vue', import.meta.url));
  const chatView = readFileSync(chatViewPath, 'utf8');
  const start = chatView.indexOf('const handleUpdateQueuedMessage');
  assert.ok(start > 0, '缺 handleUpdateQueuedMessage');
  const body = chatView.slice(start, chatView.indexOf('\n};', start));

  // 用引用判定而不是按文件名：同名图会串，且 File 没有可写的自定义字段可带 id。
  assert.match(body, /editing\.restored\.filter\(item => images\.includes\(item\.file\)\)/,
    '保留的图必须按 File 对象引用判定');
  assert.match(body, /\.map\(item => item\.id\)/);
  assert.match(body, /images\.filter\(image => !editing\.restored\.some\(item => item\.file === image\)\)/,
    '回填进来的图不能再作为新图上传一次');
  assert.match(body, /submitPendingEdit\(editing\.id, text, requirePlan, keptIds, added\)/);
});

test('编辑提交带上模型 / 执行体 / 计划模式，且与「发新消息」同一口径', () => {
  const chatViewPath = fileURLToPath(new URL('../src/views/chat/ChatView.vue', import.meta.url));
  const chatView = readFileSync(chatViewPath, 'utf8');
  const useChatViewPath = fileURLToPath(new URL('../src/views/chat/useChatView.ts', import.meta.url));
  const useChatView = readFileSync(useChatViewPath, 'utf8');

  // 组件只负责算「保留哪些图」，模型/执行体的取值交给 useChatView 的唯一口径。
  assert.match(chatView, /submitPendingEdit\(editing\.id, text, requirePlan, keptIds, added\)/);

  const start = useChatView.indexOf('const submitPendingEdit');
  assert.ok(start > 0, '缺 submitPendingEdit');
  const body = useChatView.slice(start, useChatView.indexOf('\n  };', start));
  assert.match(body, /requirePlan: requirePlan === true/);
  assert.match(body, /modelId: resolveModelId\(\) \|\| null/,
    '模型必须走 resolveModelId，否则编辑期间换的模型不生效');
  assert.match(body, /agentId: toPositiveInt\(userConfig\.agentId, 0\) \|\| null/);

  // 单一真源：buildCommand 也用同一个函数，别在发送路径上再写一遍三元表达式。
  assert.match(useChatView, /const buildCommand = [\s\S]{0,400}?modelId: resolveModelId\(\)/);
  assert.doesNotMatch(useChatView, /modelId: userConfig\.agentId \|\| localSelectedTeamId\.value/,
    '模型选择规则只能在 resolveModelId 里写一次');
});

test('ChatInputArea：入队时把图片一起交出去，成功后清空已选附件', () => {
  const inputAreaPath = fileURLToPath(new URL('../src/components/chat/ChatInputArea.vue', import.meta.url));
  const source = readFileSync(inputAreaPath, 'utf8');

  assert.match(source,
    /submitQueued\(props\.queueMessage, combinedText, draft\.requirePlan, images\)/,
    '入队必须带 images，否则排队的图片永远发不出去');
  assert.match(source,
    /const submitQueued = [\s\S]{0,900}?clearImageAttachments\(\);/,
    '入队成功后必须清空已选附件，否则下一条消息会莫名其妙带上上一张图');
  assert.doesNotMatch(source,
    /attachments\.value\.length === 0 &&/,
    '「有附件就不能入队」是本次要拆掉的限制');
});

test('ChatInputArea：编辑态的提交排在入队与发送之前', () => {
  const inputAreaPath = fileURLToPath(new URL('../src/components/chat/ChatInputArea.vue', import.meta.url));
  const source = readFileSync(inputAreaPath, 'utf8');

  const editBranch = source.indexOf('if (props.editingQueued && props.updateQueuedMessage)');
  const queueBranch = source.indexOf('if (props.isSending || props.queueMessage)');
  assert.ok(editBranch > 0, '缺编辑态分支');
  assert.ok(queueBranch > editBranch, '编辑分支必须先命中，否则会新增第二条队列消息');
  assert.match(source,
    /props\.editingQueued && props\.updateQueuedMessage\) \{\s*submitQueued\(props\.updateQueuedMessage/,
    '编辑态提交必须走 updateQueuedMessage（PUT），不能落到 queueMessage');
});
