import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {nextTick} from 'vue';

/**
 * 「+」分组菜单的加载触发与面板高度回归用例。
 *
 * <p>缺陷现场（2026-11-13）：从「+」点开 MCP 分组时面板永远空白 —— 数据只在
 * `openPlusMenu('mcp')` 那条命令直达入口里加载，菜单内部点分组没有回传给宿主。
 * 这里用真实组件挂载盯住两件事：点开分组必须 `emit('openGroup')`，宿主必须有对应落点。</p>
 */

const requireCjs = createRequire(import.meta.url);

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: Record<string, unknown>) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
  readSource: (relativeFromTests: string) => string;
};

const text = (node: MemoryNode): string => node.text + node.children.map(text).join('');

const SKILLS = Array.from({length: 12}, (_, index) => ({
  name: `skill-${index}`,
  description: `描述 ${index}`
}));

function mountMenu(t: unknown, overrides: Record<string, unknown> = {}) {
  const opened: string[] = [];
  const component = harness.componentFromSrc('components/chat/ChatInputPlusMenu.vue', {
    compileId: 'chat-input-plus-menu'
  });
  const root = harness.mountComponent(t, component, {
    isDark: false,
    isPlanMode: false,
    teams: [],
    skills: SKILLS,
    skillsLoading: false,
    skillsError: '',
    mcpServers: [{id: 1, name: 'chrome-devtools'}],
    mcpStates: [],
    mcpLoading: false,
    mcpError: '',
    initialGroup: null,
    onOpenGroup: (group: string) => { opened.push(group); },
    ...overrides
  });
  return {root, opened};
}

const groupButton = (root: MemoryNode, label: string): MemoryNode => {
  const button = harness.find(root, node => node.tag === 'button' && text(node).includes(label));
  assert.ok(button, `找不到分组按钮：${label}`);
  return button;
};

test('点开分组必须把意图回传宿主：MCP 面板不能靠命令直达才加载', async t => {
  const {root, opened} = mountMenu(t);
  (groupButton(root, 'MCP').props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(opened, ['mcp'], `点开 MCP 分组必须 emit openGroup('mcp')，实际 ${JSON.stringify(opened)}`);
  assert.equal(harness.find(root, node => node.tag === 'button' && text(node).includes('chrome-devtools')) != null, true,
    'MCP 面板应使用宿主注入的服务清单');
});

test('技能分组：同样回传意图，并渲染宿主注入的技能行', async t => {
  const {root, opened} = mountMenu(t);
  (groupButton(root, '技能').props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(opened, ['skills'], `点开技能分组必须 emit openGroup('skills')，实际 ${JSON.stringify(opened)}`);
  assert.equal(harness.find(root, node => node.tag === 'button' && text(node).includes('skill-3')) != null, true,
    '技能面板应渲染宿主注入的技能行');
});

test('再次点击同一分组只收起面板，不重复请求数据', async t => {
  const {root, opened} = mountMenu(t);
  (groupButton(root, 'MCP').props.onClick as () => void)();
  await nextTick();
  (groupButton(root, 'MCP').props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(opened, ['mcp'], `收起不该再 emit，实际 ${JSON.stringify(opened)}`);
  assert.equal(harness.find(root, node => node.tag === 'button' && text(node).includes('chrome-devtools')), undefined,
    '收起后二级浮层必须消失');
});

test('二级浮层顶对齐菜单顶、滚动区高度不超过菜单：靠 CSS 而不是脚本测量', async t => {
  const {root} = mountMenu(t);
  (groupButton(root, '技能').props.onClick as () => void)();
  await nextTick();
  const scroller = harness.find(root, node => String(node.props.class ?? '').includes('overflow-y-auto'));
  assert.ok(scroller, '技能面板必须有可滚动容器');
  assert.match(String(scroller!.props.class), /max-h-32/,
    `滚动区上限应为 max-h-32（128px，与菜单高度相当），实际 class=${String(scroller!.props.class)}`);

  // 浮层位置全交给 CSS：包含块必须是「菜单根」（分组行不再 relative），位置一写脚本就会在
  // 数据到位、窗口尺寸变化时各算一次，正是被任务栏盖住的来源
  const source = harness.readSource('../src/components/chat/ChatInputPlusMenu.vue');
  assert.match(source, /<div v-for="group in GROUPS" :key="group\.key">/,
    '分组行不得再是 relative：否则浮层锚回各自行顶，越靠下的分组越低，底部就钻到任务栏底下');
  assert.doesNotMatch(source, /panelLift|fitPanel|getBoundingClientRect/,
    '浮层定位不得由脚本测量决定');
});

test('菜单位置：底边锚在「+」按钮上沿，而不是输入卡片上沿', () => {
  const source = harness.readSource('../src/components/chat/ChatInputArea.vue');
  // `bottom-full` 量的是「定位祖先的高度」，所以锚点必须是与按钮同尺寸的那层 relative 包裹，
  // 直接挂在输入卡片下就变成了贴卡片上沿（用户截图里那截空档就是它）。
  assert.match(
    source,
    /<div class="relative inline-flex shrink-0">\s*<button[\s\S]*?@click="handlePlusClick"[\s\S]*?<ChatInputPlusMenu[\s\S]*?\/>\s*<\/div>/,
    'ChatInputPlusMenu 必须渲染在「+」按钮那层 relative 包裹里，否则菜单底边贴不到按钮上沿'
  );
});

test('技能加载中只显示占位：不得先渲染列表再抽掉占位', async t => {
  const {root} = mountMenu(t, {skillsLoading: true});
  (groupButton(root, '技能').props.onClick as () => void)();
  await nextTick();
  assert.equal(harness.find(root, node => node.tag === 'button' && text(node).includes('skill-3')), undefined,
    'skillsLoading 时不得渲染技能行：占位与列表并存，占位消失会把滚动框顶得一跳');
  assert.match(text(root), /正在加载 Skill 清单/, '加载中必须给出占位');
});

test('MCP 加载中只显示占位：服务行不渲染、加载文案不复读', async t => {
  const {root} = mountMenu(t, {mcpLoading: true});
  (groupButton(root, 'MCP').props.onClick as () => void)();
  await nextTick();
  assert.equal(harness.find(root, node => node.tag === 'button' && text(node).includes('chrome-devtools')), undefined,
    'mcpLoading 时不得渲染服务行');
  assert.equal(text(root).split('正在加载 MCP 服务').length - 1, 1,
    '加载文案只该出现一次（整块占位），不该每行右侧复读一遍');
});

test('宿主接线：ChatInputArea 绑 open-group 且三个分组各有加载落点', () => {
  const source = harness.readSource('../src/components/chat/ChatInputArea.vue');
  assert.match(source, /@open-group="loadPlusGroup"/, 'ChatInputArea 必须监听 open-group');
  const handler = /const loadPlusGroup = async \(group: string\) => \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(handler, '找不到 loadPlusGroup 实现');
  assert.match(handler![1], /group === 'mcp'[\s\S]*loadMcpServers/, 'mcp 分组必须触发 loadMcpServers');
  assert.match(handler![1], /group === 'skills'[\s\S]*skillList\.load/, 'skills 分组必须触发 skillList.load');
  assert.doesNotMatch(handler![1], /skillMenu/, 'skills 分组不得顺手打开旧技能浮层（会出现两个技能框同时展开）');
  assert.doesNotMatch(source, /isSkillMenuOpen|useSkillMenu|skillSearchInputRef/,
    '旧的 /skill 浮层已删除：残留任何一处都会让两个技能框同时展开');
  assert.match(handler![1], /group === 'teams'[\s\S]*fetchTeams/, 'teams 分组必须触发 fetchTeams');
});

/**
 * MCP 行内动作（启用 / 停用 / 重新连接）。
 *
 * <p>需求核心是「按状态给出唯一那个动作」：动作映射写反（CONNECTED 给「启用」）、
 * 或动作按钮点下去不发对应事件，都必须让这里的用例变红。</p>
 */
interface McpRowFixture {
  server: Record<string, unknown>;
  state?: Record<string, unknown>;
}

function mountMcpMenu(t: unknown, rows: McpRowFixture[], overrides: Record<string, unknown> = {}) {
  const toggled: Array<Record<string, unknown>> = [];
  const reconnected: Array<Record<string, unknown>> = [];
  const settingsOpened: number[] = [];
  const {root} = mountMenu(t, {
    mcpServers: rows.map(row => row.server),
    mcpStates: rows.map(row => row.state).filter(state => state != null),
    onToggleMcp: (server: Record<string, unknown>) => { toggled.push(server); },
    onReconnectMcp: (server: Record<string, unknown>) => { reconnected.push(server); },
    onOpenMcpSettings: () => { settingsOpened.push(1); },
    ...overrides
  });
  (groupButton(root, 'MCP').props.onClick as () => void)();
  return {root, toggled, reconnected, settingsOpened};
}

/** 动作按钮按「文本完全相等」定位：状态文案里有「已启用」，用 includes 会选中错误的节点。 */
const actionButton = (root: MemoryNode, label: string): MemoryNode => {
  const node = harness.find(root, item => item.tag === 'button' && text(item).trim() === label);
  assert.ok(node, `找不到动作按钮「${label}」，面板文本=${JSON.stringify(text(root).trim())}`);
  return node;
};

test('连接成功的服务行给「停用」，点击 emit toggleMcp 且不改动「打开设置」入口', async t => {
  const server = {id: 11, name: 'github', status: 1};
  const {root, toggled, reconnected, settingsOpened} = mountMcpMenu(t, [{
    server,
    state: {id: 11, state: 'CONNECTED', toolCount: 46, error: null}
  }]);
  await nextTick();

  assert.ok(!harness.find(root, item => item.tag === 'button' && text(item).trim() === '启用'),
    'CONNECTED 不得同时出现「启用」按钮：一行只有一个动作');
  const button = actionButton(root, '停用');
  assert.notEqual(button.props.disabled, true, '空闲状态下动作按钮必须可点');
  (button.props.onClick as () => void)();
  await nextTick();

  assert.deepEqual(toggled.map(item => item.id), [11], `点击「停用」必须 emit toggleMcp，实际 ${JSON.stringify(toggled)}`);
  assert.equal(reconnected.length, 0, '「停用」不得走 reconnectMcp');
  assert.equal(settingsOpened.length, 0, '点动作按钮不得顺带打开 MCP 设置（那是左侧区域的动作）');
});

test('已停用的服务行给「启用」，status=0 与 DISABLED 两条判据都认', async t => {
  const {root, toggled} = mountMcpMenu(t, [{
    server: {id: 21, name: 'context7', status: 0},
    state: {id: 21, state: 'DISABLED', toolCount: null, error: null}
  }]);
  await nextTick();

  assert.ok(!harness.find(root, item => item.tag === 'button' && text(item).trim() === '停用'),
    '停用的服务不得给出「停用」按钮');
  const button = actionButton(root, '启用');
  (button.props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(toggled.map(item => item.id), [21], `已停用的行点击也必须 emit toggleMcp，实际 ${JSON.stringify(toggled)}`);
});

test('连接失败的服务行给「重新连接」，点击 emit reconnectMcp 而不是 toggleMcp', async t => {
  const {root, toggled, reconnected} = mountMcpMenu(t, [{
    server: {id: 31, name: 'playwright', status: 1},
    state: {id: 31, state: 'FAILED', toolCount: null, error: '握手超时'}
  }]);
  await nextTick();

  const button = actionButton(root, '重新连接');
  (button.props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(reconnected.map(item => item.id), [31], `点击「重新连接」必须 emit reconnectMcp，实际 ${JSON.stringify(reconnected)}`);
  assert.equal(toggled.length, 0, '「重新连接」不得复用 toggleMcp');
});

test('状态缺失（未连接）与 DISCONNECTED 复用「重新连接」，不新增第四种按钮', async t => {
  const {root, reconnected} = mountMcpMenu(t, [
    {server: {id: 41, name: 'windows_mcp', status: 1}},
    {server: {id: 42, name: 'filesystem', status: 1}, state: {id: 42, state: 'DISCONNECTED', toolCount: null, error: null}}
  ]);
  await nextTick();

  const labels = harness.findAll(root, item => item.tag === 'button' && String(item.props['data-testid'] ?? '').startsWith('plus-mcp-action-'))
    .map(item => text(item).trim());
  assert.deepEqual(labels, ['重新连接', '重新连接'], `无连接的两行都应是「重新连接」，实际 ${JSON.stringify(labels)}`);
  for (const button of harness.findAll(root, item => item.tag === 'button' && text(item).trim() === '重新连接')) {
    (button.props.onClick as () => void)();
  }
  await nextTick();
  assert.deepEqual(reconnected.map(item => item.id), [41, 42], `两行点击都应 emit reconnectMcp，实际 ${JSON.stringify(reconnected)}`);
});

test('mcpBusy 命中该 id 时动作按钮 disabled + aria-busy，点击不再发第二次请求', async t => {
  const {root, toggled} = mountMcpMenu(t, [{
    server: {id: 51, name: 'github', status: 1},
    state: {id: 51, state: 'CONNECTED', toolCount: 3, error: null}
  }], {mcpBusy: {'51': true}});
  await nextTick();

  const button = actionButton(root, '停用');
  assert.equal(button.props.disabled, true, '进行中的行必须 disabled，否则连点会发两次请求');
  assert.equal(button.props['aria-busy'], 'true', '进行中要给出 aria-busy');
  (button.props.onClick as () => void)();
  await nextTick();
  assert.equal(toggled.length, 0, '进行中再点不得再次 emit');
});

test('MCP 服务行结构：行容器是 div + justify-between，左侧打开设置、右侧独立动作按钮', async t => {
  const {root, settingsOpened} = mountMcpMenu(t, [{
    server: {id: 61, name: 'github', status: 1},
    state: {id: 61, state: 'CONNECTED', toolCount: 46, error: null}
  }]);
  await nextTick();

  const row = harness.find(root, item => item.props['data-testid'] === 'plus-mcp-row-61');
  assert.ok(row, '服务行必须带可定位的行容器');
  assert.equal(row!.tag, 'div', 'button 不能嵌套 button，行容器必须是 div');
  assert.match(String(row!.props.class), /justify-between/, `行容器必须 justify-between，实际 class=${String(row!.props.class)}`);
  assert.equal(
    harness.findAll(row!, item => item.tag === 'button').length,
    2,
    '行内应只有两个 button：左侧打开设置 + 右侧动作，嵌套结构会违反 HTML 约束'
  );

  const nameButton = harness.find(row!, item => item.tag === 'button' && text(item).includes('github'));
  assert.ok(nameButton, '左侧服务名必须是可点按钮');
  (nameButton!.props.onClick as () => void)();
  await nextTick();
  assert.equal(settingsOpened.length, 1, '点服务名仍要打开 MCP 设置');
});

test('优先级矩阵：配置态压过运行态 —— status=0 且 state=CONNECTED 时仍只能「启用」', async t => {
  const {root, toggled, reconnected} = mountMcpMenu(t, [{
    server: {id: 71, name: 'github', status: 0},
    state: {id: 71, state: 'CONNECTED', toolCount: 12, error: null}
  }]);
  await nextTick();

  const labels = harness.findAll(root, item => item.tag === 'button'
    && String(item.props['data-testid'] ?? '').startsWith('plus-mcp-action-'))
    .map(item => text(item).trim());
  assert.deepEqual(labels, ['启用'],
    `停用的服务即使连接表残留 CONNECTED，也只能给「启用」；若按运行态判成「停用」，用户就再也打不开它。实际 ${JSON.stringify(labels)}`);

  (actionButton(root, '启用').props.onClick as () => void)();
  await nextTick();
  assert.deepEqual(toggled.map(item => item.id), [71], `该行点击必须走 toggleMcp，实际 ${JSON.stringify(toggled)}`);
  assert.equal(reconnected.length, 0, '该行不得走 reconnectMcp');
});

/**
 * 宿主 handler 的源码级守护。
 *
 * <p>行内动作一旦把整包 McpVO 回传，后端会把另一路传输方式的 url / command 写空；
 * 一旦改成调 `loadMcpServers`，面板又会闪回加载占位。这两条都只在源码上看得出来，用挂载用例盖不住。</p>
 */
test('宿主接线：启停只提交 {id,status}，不整体重载面板，失败写 mcpError', () => {
  const source = harness.readSource('../src/components/chat/ChatInputArea.vue');

  const toggleHandler = /const handlePlusToggleMcp = async \(server: McpVO\) => \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(toggleHandler, '找不到 handlePlusToggleMcp 实现');
  const toggleBody = toggleHandler![1];
  assert.match(toggleBody, /nextMcpStatus\(server\.status\)/,
    '启停方向必须走纯函数 nextMcpStatus，不要在 handler 里就地写三元');
  const updateCall = /McpAPI\.update\(\{([^}]*)\}\)/.exec(toggleBody);
  assert.ok(updateCall, '启停必须调用 McpAPI.update');
  const payloadKeys = updateCall![1].split(',').map(part => part.split(':')[0].trim()).filter(Boolean).sort();
  assert.deepEqual(payloadKeys, ['id', 'status'],
    `启停只能提交 id 与 status（后端按缺省字段保持原值），实际 ${JSON.stringify(payloadKeys)}`);
  assert.doesNotMatch(toggleBody, /\.\.\.server|url:|command:/,
    '不得把整包 McpVO 或 url / command 回传：另一种传输方式的连接参数会被写空');
  assert.doesNotMatch(toggleBody, /loadMcpServers/,
    '行内动作不得整体重载面板：整块置 loading 会把面板切回「正在加载 MCP 服务…」');
  assert.match(toggleBody, /mcpError\.value = res\.errMsg/,
    '后端失败必须落到 mcpError，不能静默失败');

  const reconnectHandler = /const handlePlusReconnectMcp = async \(server: McpVO\) => \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(reconnectHandler, '找不到 handlePlusReconnectMcp 实现');
  const reconnectBody = reconnectHandler![1];
  assert.match(reconnectBody, /McpAPI\.reconnect\(server\)/, '重新连接必须走 McpAPI.reconnect');
  assert.doesNotMatch(reconnectBody, /loadMcpServers/,
    '重新连接同样不得整体重载面板');
  assert.match(reconnectBody, /mcpError\.value = res\.errMsg/,
    '后端失败必须落到 mcpError，不能静默失败');

  // 反过来证明上面这些断言不是「怎么写都过」：把 busy 关键字去掉就得红
  assert.match(source, /const mcpBusy = ref<Record<string, boolean>>\(\{\}\)/,
    '宿主必须持有按 id 的 mcpBusy，否则动作进行中按钮无法置灰');
});

/**
 * 宿主 busy 入口守卫（QA 变异「删掉 in-flight 早退」曾存活）。
 *
 * <p>`handlePlusToggleMcp` / `handlePlusReconnectMcp` 都靠 `mcpBusy[key]` 早退挡住连点：
 * 守卫只存在源码里，界面层即便按钮置灰也可能被键盘/脚本再触发一次，两次请求会让
 * 状态写入互相覆盖。这里按顺序断言「先早退、再置忙」，删掉任一句都会红。</p>
 */
test('宿主 busy 入口守卫：两个 handler 都必须先早退再置忙，finally 必须清 busy', () => {
  const source = harness.readSource('../src/components/chat/ChatInputArea.vue');
  const handlers: Array<{name: string; body: string}> = [
    {name: 'handlePlusToggleMcp', body: captureBody(source, 'handlePlusToggleMcp')},
    {name: 'handlePlusReconnectMcp', body: captureBody(source, 'handlePlusReconnectMcp')},
  ];

  for (const handler of handlers) {
    const guardIndex = handler.body.indexOf('if (mcpBusy.value[key]) return;');
    const busyOnIndex = handler.body.indexOf('markMcpBusy(key, true)');
    const busyOffIndex = handler.body.indexOf('markMcpBusy(key, false)');

    assert.notEqual(guardIndex, -1,
      `${handler.name} 缺少 in-flight 早退守卫：连点会发出两次请求，两次写入互相覆盖`);
    assert.notEqual(busyOnIndex, -1, `${handler.name} 进入时必须置 busy，否则按钮永远不会置灰`);
    assert.ok(guardIndex < busyOnIndex,
      `${handler.name} 的早退守卫必须在置忙之前，顺序反了就挡不住第二次进入`);
    assert.notEqual(busyOffIndex, -1, `${handler.name} 的 finally 必须清 busy，否则该行按钮永久置灰`);
    assert.match(handler.body, /finally \{[\s\S]*markMcpBusy\(key, false\);/,
      `${handler.name} 清理 busy 必须落在 finally 里：异常路径同样要解锁`);
  }
});

/** 取一个 handler 的函数体，截到同缩进的 `};` 为止。 */
function captureBody(source: string, handlerName: string): string {
  const matched = new RegExp(`const ${handlerName} = async \\(server: McpVO\\) => \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(matched, `找不到 ${handlerName} 实现`);
  return matched![1];
}
