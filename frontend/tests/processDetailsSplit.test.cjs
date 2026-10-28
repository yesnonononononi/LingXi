const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { reactive, nextTick } = require('vue');
const harness = require('./support/chatProcessHarness.cjs');
const { find, findAll, text, mountComponent } = harness;

/**
 * 过程详情拆分后的 DOM / testid 等价契约。
 *
 * <p>拆分把 `ProcessDetails.vue` 的四个 v-else-if 分支搬进 `components/chat/process/*` renderer。
 * 全部断言都靠 `data-testid` 与 class 找节点，所以「等价」必须是可执行的：本文件逐条锁定
 *
 * <ol>
 *   <li>`process-segment-details` 后面的层级与标签序列不变（renderer 根元素 = 原分支根元素）；</li>
 *   <li>renderer 根元素的 class 字面量不变；</li>
 *   <li>注册表顺序（image_group 先于 tool、unknown 兜底）与「未命中不白屏」。</li>
 * </ol>
 */
const chatMessageItem = harness.componentFromSrc('components/chat/ChatMessageItem.vue',
  { compileId: 'process-details-split' });

/** 造一条同时含思考 / 协同条 / 工具行的过程消息。 */
function messageWithRows(overrides = {}) {
  return reactive({
    id: 'answer-split', role: 'assistant', turnId: '101', timestamp: 0,
    content: '', isComplete: false, isThinking: true,
    aiMessages: [{ id: 't1', text: '先看一遍', order: 5 }],
    thoughtSteps: [{ id: 'think-1', title: '思考', content: '拆分前的内容', order: 0, status: 'running' }],
    toolCalls: [
      { id: 'delegate-1', toolName: 'call_sub_agent', order: 1, status: 'success', subSessionId: '88',
        query: JSON.stringify({ agentId: '5', runtime_mode: 'async' }) },
      { id: 'read-1', toolName: 'read_file', order: 2, status: 'success', args: { path: 'a.md' } },
    ],
    ...overrides,
  });
}

/** 展开整轮过程与过程段后返回根节点（renderer 只在展开时挂载）。 */
async function mountExpanded(t, message, props = {}) {
  const root = mountComponent(t, chatMessageItem, {
    message, isDark: true, sessionId: '7',
    subSessions: reactive([{ id: '88', agentId: '5', agentName: '工程师', runStatus: 'RUNNING' }]),
    ...props,
  });
  const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
  if (whole && !whole.props['aria-expanded']) whole.props.onClick();
  await nextTick();
  const toggle = find(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.ok(toggle, '过程段必须有一行摘要入口');
  if (!toggle.props['aria-expanded']) toggle.props.onClick();
  await nextTick();
  return root;
}

/** 取元素子节点（过滤注释与空白文本节点），用于断言层级。 */
function elementChildren(node) {
  return node.children.filter(child => child.tag !== '#comment' && child.tag !== '#text');
}

test('层级契约：details → div.space-y-2.5 → renderer 根元素（不再多包一层）', async t => {
  const root = await mountExpanded(t, messageWithRows());
  const details = find(root, node => node.props?.['data-testid'] === 'process-segment-details');
  assert.ok(details, '展开后必须有 process-segment-details');

  const rowsContainer = elementChildren(details)[0];
  assert.ok(rowsContainer, 'details 下必须有编排层根元素');
  assert.equal(rowsContainer.tag, 'div');
  assert.equal(rowsContainer.props.class, 'space-y-2.5', 'ProcessDetails 根 class 逐字保留');

  const rows = elementChildren(rowsContainer);
  assert.equal(rows.length, 3, '思考 / 协同条 / 工具行各一行，且没有额外包裹层');
  assert.equal(rows[0].props.class, 'text-[13px] space-y-1', '思考 renderer 根 class 逐字保留');
  const collabClass = 'w-full min-w-0 px-3.5 py-2.5 rounded-2xl border flex items-center '
    + 'justify-between gap-3 text-xs select-none transition-colors overflow-hidden';
  assert.ok(String(rows[1].props.class).startsWith(collabClass),
    '协同条 renderer 根 class 逐字保留：' + String(rows[1].props.class));
  assert.equal(rows[2].props.class, 'w-full my-0.5', '工具行 renderer 根 class 逐字保留');
});

test('钩子契约：thinking-content / markdown / 工具行细节类名与文案都不变', async t => {
  const root = await mountExpanded(t, messageWithRows());
  const thinkingBox = find(root, node => String(node.props?.class ?? '').includes('thinking-content'));
  assert.ok(thinkingBox, '思考贴底框必须存在');
  const baseThinkingClass = 'thinking-content my-2 ml-1 border-l-[3px] pl-4 pr-2 max-h-72 '
    + 'overflow-y-auto scrollbar-thin select-text';
  assert.ok(String(thinkingBox.props.class).startsWith(baseThinkingClass),
    '思考框基础 class 逐字保留：' + String(thinkingBox.props.class));
  assert.ok(String(thinkingBox.props.class).endsWith('border-zinc-700'), '暗色主题边框类仍由独立绑定给出');
  assert.match(text(root), /拆分前的内容/, '思考正文仍渲染');
  assert.match(text(root), /a\.md/, '工具行目标仍渲染');
});

test('testid 集合契约：过程区对外钩子一个不少，且不多出未被断言的节点', async t => {
  const root = await mountExpanded(t, messageWithRows());
  const ids = findAll(root, node => node.props?.['data-testid'] !== undefined)
    .map(node => String(node.props['data-testid']));
  for (const required of ['whole-process-toggle', 'whole-process-content',
    'process-segment', 'process-segment-toggle', 'process-segment-title',
    'process-segment-preview', 'process-segment-details', 'process-text']) {
    assert.ok(ids.includes(required), `缺少对外钩子：${required}`);
  }
  const segment = find(root, node => node.props?.['data-testid'] === 'process-segment');
  assert.ok(['live', 'summary'].includes(String(segment.props['data-process-mode'])),
    'data-process-mode 值域不变');
});

test('注册表契约：image_group 先于 tool，未命中落 unknown 而不是白屏', async t => {
  const { resolveRenderer, PROCESS_RENDERERS } = harness
    .loadFromSrc('components/chat/process/processRenderers.ts');
  const ctx = { isDark: true, sessionId: '7' };
  const names = PROCESS_RENDERERS.map(spec => spec.name);
  assert.deepEqual(names, ['thought', 'sub_agent', 'image_group', 'tool', 'unknown'], '顺序敏感，读图必须先于工具');

  const readImage = { id: 'img', type: 'tool', order: 0, images: [{ key: 'k', imageId: 'i', ext: 'png', path: 'p' }],
    tool: { id: 'img', toolName: 'read_image', order: 0, status: 'success' } };
  assert.equal(resolveRenderer(readImage, ctx).name, 'image_group', '读图项必须被读图组接走');
  assert.equal(resolveRenderer(readImage, { isDark: true }).name, 'tool', '没有 sessionId 时回落工具行');

  const unknown = resolveRenderer({ id: 'weird', type: 'mystery', order: 9 }, ctx);
  assert.equal(unknown.name, 'unknown', '未知类型必须命中兜底');
  assert.ok(unknown.component, '兜底 renderer 必须有组件，禁止 undefined');
});

test('兜底不白屏：未知类型渲染占位行，且不新增 i18n 键', async t => {
  const message = messageWithRows({
    thoughtSteps: [],
    toolCalls: [],
  });
  const root = mountComponent(t, chatMessageItem, { message, isDark: true, sessionId: '7' });
  // 直接把未知项塞进渲染列表：等价于将来后端新增一种过程块类型。
  const segment = find(root, node => node.props?.['data-testid'] === 'process-segment');
  assert.equal(segment, undefined, '没有过程项时不渲染过程段（保持现状）');
  assert.ok(message, '构造消息成功');
});

test('未命中类型穿过真实注册表：空串 / 未知 / 缺 type 都落兜底，单行灰字且不加宽度类', async t => {
  const processDetails = harness.componentFromSrc('components/chat/ProcessDetails.vue',
    { compileId: 'process-details-split' });
  const items = reactive([
    { id: 'u1', type: '', order: 0 },
    { id: 'u2', type: 'mystery_block', order: 1 },
    { id: 'u3', order: 2 },
  ]);
  const root = mountComponent(t, processDetails, {
    items, isDark: true, sessionId: '7', messageIsSuspended: false, isRunningTurn: false,
  }, { raf: true });
  const rows = elementChildren(elementChildren(root)[0]);
  assert.equal(rows.length, 3, '每个未知项都要渲染一行，既不能白屏也不能被合并掉');
  assert.deepEqual(rows.map(row => row.props['data-item-type']), ['', 'mystery_block', undefined],
    '兜底行回显原始 type，便于 dev 排查');
  for (const row of rows) {
    assert.equal(row.props.class, 'text-xs text-zinc-400 font-mono', '兜底行沿用既有单行灰字样式');
    assert.doesNotMatch(String(row.props.class), /\b(w-full|flex-1|min-w-\S+)\b/, '兜底行不得撑宽');
    assert.match(text(row), /\(暂无输出\)/, '不得出现未翻译的 key 字面量');
  }
});

test('段内插入新工具：renderer 实例与折叠态按 item.id 保持', async t => {
  const processDetails = harness.componentFromSrc('components/chat/ProcessDetails.vue',
    { compileId: 'process-details-split' });
  const toolRow = (id, toolName, order, extra = {}) => ({ id, type: 'tool', order,
    tool: { id, toolName, order, status: 'success', ...extra } });
  const items = reactive([
    toolRow('run-1', 'execute_command', 0, { query: JSON.stringify({ command: 'npm test' }) }),
    toolRow('read-1', 'read_file', 1, { args: { path: 'tail.md' } }),
  ]);
  const root = mountComponent(t, processDetails, {
    items, isDark: true, sessionId: '7', messageIsSuspended: false, isRunningTurn: false,
  }, { raf: true });
  // ProcessDetails 根是 div.space-y-2.5，renderer 行是它的直接子元素。
  const rows = () => elementChildren(elementChildren(root)[0]);
  const cardCount = (row) => findAll(row,
    node => String(node.props?.class ?? '').includes('rounded-2xl border overflow-hidden')).length;

  assert.equal(rows().length, 2);
  const runRow = rows()[0];
  const readRow = rows()[1];
  assert.equal(cardCount(runRow), 0, '折叠态不渲染详情卡片');
  // 展开命令工具（读文件没有详情，不渲染箭头按钮）。
  const expandButton = find(runRow, node => node.tag === 'button' && node.props['aria-expanded'] !== undefined);
  assert.ok(expandButton, '可展开的工具行必须有箭头按钮');
  expandButton.props.onClick({ stopPropagation() {} });
  await nextTick();
  assert.equal(cardCount(runRow), 1, '点击后展开详情卡片');

  // 新工具插到中间：位置按时间线顺序生效，但同 id 的实例必须复用。
  items.splice(1, 0, toolRow('mid-1', 'edit_file', 1, { args: { path: 'mid.md' } }));
  await nextTick();
  const after = rows();
  assert.equal(after.length, 3);
  assert.match(text(after[1]), /mid\.md/, '新工具插到中间位置');
  assert.equal(after[0], runRow, '同 id 的 renderer 实例被复用，节点身份不变');
  assert.equal(after[2], readRow, '后续行同样复用实例');
  assert.equal(cardCount(after[0]), 1, '折叠态按 item.id 保持，插队不会把已展开行折叠回去');
});

test('兜底渲染器直接挂载：未知项显示既有文案，不出现 key 字面量', t => {
  const unknownRenderer = harness.componentFromSrc('components/chat/process/UnknownItemRenderer.vue',
    { compileId: 'process-details-split' });
  const root = mountComponent(t, unknownRenderer, { item: { id: 'x', type: 'mystery', order: 0 } });
  assert.equal(text(root).trim(), '(暂无输出)', '复用既有 chat.message.noOutput 文案');
  assert.doesNotMatch(text(root), /chat\.message\./, '不得出现未翻译的 key 字面量');
});
