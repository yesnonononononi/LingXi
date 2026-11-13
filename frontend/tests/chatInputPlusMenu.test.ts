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

test('技能/MCP/协作列表有高度上限：不再用 240px 顶着窗口底边', async t => {
  const {root} = mountMenu(t);
  (groupButton(root, '技能').props.onClick as () => void)();
  await nextTick();
  const scroller = harness.find(root, node => String(node.props.class ?? '').includes('overflow-y-auto'));
  assert.ok(scroller, '技能面板必须有可滚动容器');
  const className = String(scroller!.props.class);
  assert.match(className, /max-h-44/, `滚动容器高度上限应为 max-h-44（176px），实际 class=${className}`);
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
