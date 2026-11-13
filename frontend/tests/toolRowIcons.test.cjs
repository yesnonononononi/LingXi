'use strict';
/**
 * 工具行类型图标守卫：哪个工具画哪个图标、图形是否与别人重样、尺寸与配色是否统一。
 *
 * <p>判别（`utils/toolRowIcons.ts`）与绘制（`process/ToolRowIcon.vue`）分开验证：
 * 判别用纯函数表驱动，绘制用 harness 真实挂载 SFC 后读节点属性。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('./support/chatProcessHarness.cjs');

const {find, findAll, mountComponent, loadFromSrc, componentFromSrc} = harness;

const icons = loadFromSrc('utils/toolRowIcons.ts');
const meta = loadFromSrc('utils/toolMeta.ts');
const toolNames = loadFromSrc('utils/toolNames.ts');
const ICON = icons.TOOL_ROW_ICON;

/** 工具名 → 期望图标；分类码按 `resolveToolCategory` 现取，避免测试自己编分类。 */
function expectIcon(toolName) {
  return icons.resolveToolRowIcon(toolName, meta.resolveToolCategory(toolName));
}

const iconComponent = componentFromSrc('components/chat/process/ToolRowIcon.vue', {
  compileId: 'tool-row-icon',
});

/** 挂载图标组件，返回 svg 节点与它下面的全部图形节点（path / rect / circle）。 */
function renderIcon(t, props) {
  const root = mountComponent(t, iconComponent, {isDark: true, ...props});
  const svg = find(root, node => node.tag === 'svg');
  assert.ok(svg, `工具 ${props.toolName || '(空)'} 必须有图标，不允许空白`);
  return {svg, shapes: drawingNodes(svg)};
}

/** 图形节点：描边图标用的是 rect / circle，不能只数 path。 */
function drawingNodes(svg) {
  return findAll(svg, node => ['path', 'rect', 'circle'].includes(node.tag));
}

/** 图形身份签名：同签名 = 两个图标长得一模一样。 */
function signature(svg) {
  const shapes = drawingNodes(svg).map(node => `${node.tag}:${node.props.d ?? ''}${node.props.cx ?? ''}${node.props.r ?? ''}`);
  return `${svg.props.viewBox}|${shapes.join('~')}`;
}

/** 每个图标种类一个代表样本：新增种类忘记给样本，下面的「样本齐全」用例会红。 */
const SAMPLES = [
  ['search_files', ICON.FILE_SEARCH],
  ['read_file', ICON.FILE_DOC],
  ['edit_file', ICON.FILE_EDIT],
  ['write_file', ICON.FILE_WRITE],
  ['delete_file', ICON.FILE_DELETE],
  ['load_memory', ICON.MEMORY_READ],
  ['generate_image', ICON.IMAGE_GENERATE],
  ['send_mail_to_agent', ICON.MAIL],
  ['create_checklist', ICON.CHECKLIST],
  ['create_plan', ICON.PLAN],
  ['require_choice', ICON.CHOICE],
  ['call_sub_agent', ICON.SUB_AGENT],
  ['peek_teammate_state', ICON.PEEK],
  ['compact_context', ICON.COMPACT],
  ['execute_command', ICON.COMMAND],
  ['manage_command', ICON.MANAGE_COMMAND],
  ['mcp_github_create_issue', ICON.DEFAULT],
];

test('图标判别：文件动作按具体工具分（检索/读取/编辑/写入/删除）', () => {
  assert.equal(expectIcon('delete_file'), ICON.FILE_DELETE, '删除文件必须是垃圾桶，不能混在写入里');
  assert.equal(expectIcon('write_file'), ICON.FILE_WRITE, '整文件写入用「文档 + 铅笔」');
  assert.equal(expectIcon('edit_file'), ICON.FILE_EDIT, '局部编辑与整文件写入必须能分辨');
  assert.equal(expectIcon('read_file'), ICON.FILE_DOC);
});

test('图标判别：四个「找东西」的动作共用一个检索图标', () => {
  for (const name of ['search_files', 'web_search', 'search_tool', 'search_wiki']) {
    assert.equal(expectIcon(name), ICON.FILE_SEARCH, `${name} 必须用检索图标`);
  }
});

test('图标判别：记忆、图片、邮件各归各位', () => {
  assert.equal(expectIcon('load_memory'), ICON.MEMORY_READ, '读记忆不再复用文档图标');
  assert.equal(expectIcon('search_wiki'), ICON.FILE_SEARCH);
  assert.equal(expectIcon('generate_image'), ICON.IMAGE_GENERATE, '生图是写类动作，不能画成文档');
  assert.equal(expectIcon('read_image'), ICON.FILE_DOC);
  assert.equal(expectIcon('send_mail_to_agent'), ICON.MAIL);
  assert.equal(expectIcon('read_skill'), ICON.FILE_DOC);
});

test('图标判别：清单六件套与 MCP 工具清单共用清单图标', () => {
  for (const name of ['create_checklist', 'get_current_checklist', 'get_checklist',
    'update_checklist_step', 'modify_checklist', 'delete_checklist', 'list_mcp_tools']) {
    assert.equal(expectIcon(name), ICON.CHECKLIST, `清单族工具 ${name} 必须用清单图标`);
  }
});

test('图标判别：命令、计划、选择、子代理、观测、压缩各有专属图标', () => {
  assert.equal(expectIcon('execute_command'), ICON.COMMAND);
  assert.equal(expectIcon('manage_command'), ICON.MANAGE_COMMAND, '后台任务与前台命令动作不同');
  assert.equal(expectIcon('create_plan'), ICON.PLAN);
  assert.equal(expectIcon('require_choice'), ICON.CHOICE);
  assert.equal(expectIcon('call_sub_agent'), ICON.SUB_AGENT);
  assert.equal(expectIcon('peek_teammate_state'), ICON.PEEK);
  assert.equal(expectIcon('compact_context'), ICON.COMPACT);
  assert.equal(icons.resolveToolRowIcon('anything', 'THINK'), ICON.THINK, '思考分类按分类码取值');
});

test('齿轮只表示「真的不认识」：任何已登记固定工具都不许落兜底', () => {
  for (const name of Object.values(toolNames.AgentToolName)) {
    assert.notEqual(expectIcon(name), ICON.DEFAULT,
      `固定工具 ${name} 落到了兜底齿轮，齿轮的「未知工具」信号就被吃掉了`);
  }
  // 金丝雀：证明上面那条 notEqual 真的会因缺陷变红（否则循环写错也全绿）。
  assert.equal(expectIcon('mcp_github_create_issue'), ICON.DEFAULT, 'MCP 动态工具仍必须落兜底');
  assert.equal(expectIcon(''), ICON.DEFAULT, '空工具名必须落兜底');
});

test('绘制：样本覆盖全部图标种类，不多不少', () => {
  const kinds = new Set(SAMPLES.map(([, kind]) => kind));
  kinds.add(ICON.THINK); // 思考图标没有对应固定工具，单独按分类码验
  assert.deepEqual([...kinds].sort(), Object.values(ICON).sort(),
    '每个图标种类都要有代表样本，新增种类必须补样本');
});

test('绘制：图标尺寸与配色统一（w-4 h-4 + 同一前景色，禁止抄设计稿的十六进制填充）', async t => {
  const shapes = new Set();
  for (const [toolName] of SAMPLES) {
    for (const isDark of [true, false]) {
      const root = mountComponent(t, iconComponent, {
        toolName, category: meta.resolveToolCategory(toolName), isDark,
      });
      const svg = find(root, node => node.tag === 'svg');
      const className = String(svg.props.class);
      assert.match(className, /(^|\s)w-4(\s|,|$)/, `${toolName} 图标宽度必须 w-4`);
      assert.match(className, /(^|\s)h-4(\s|,|$)/, `${toolName} 图标高度必须 h-4`);
      const tone = isDark ? 'text-zinc-100' : 'text-zinc-500';
      assert.match(className, new RegExp(tone), `${toolName} 图标前景色必须统一为 ${tone}`);
      assert.doesNotMatch(JSON.stringify(svg.props), /#[0-9a-fA-F]{3}/,
        `${toolName} 图标不得带死色值，否则深浅主题只有一种能看清`);
      for (const node of findAll(svg, node => node.tag === 'path')) {
        assert.equal(node.props.fill, undefined, `${toolName} 的 path 不得自带 fill`);
      }
      shapes.add(className.split(/\s+/).filter(token => token && token !== tone
        && !token.startsWith('drop-shadow-')).join(' '));
    }
  }
  assert.equal(shapes.size, 1, '除前景色外，全部图标的尺寸/发光类名必须完全一致：' + [...shapes].join(' | '));
});

test('绘制：不同种类的图形互不重样（复制粘贴图标必须变红）', async t => {
  const signatures = new Map();
  const cases = [...SAMPLES, [undefined, ICON.THINK, 'THINK']];
  for (const [toolName, kind, onlyCategory] of cases) {
    const {svg, shapes} = renderIcon(t, onlyCategory === 'THINK'
      ? {category: 'THINK'}
      : {toolName, category: meta.resolveToolCategory(toolName)});
    assert.ok(shapes.length > 0, `${kind} 必须有绘制内容`);
    const value = signature(svg);
    assert.equal(signatures.has(value), false,
      `${kind} 与 ${signatures.get(value)} 的图形完全相同，界面上分不出动作`);
    signatures.set(value, kind);
  }
});

test('绘制：每个图标分支都在源码里，缺一个分支就会掉到兜底齿轮', () => {
  const source = fs.readFileSync(
    path.resolve(harness.SRC_DIR, 'components/chat/process/ToolRowIcon.vue'), 'utf8');
  for (const kind of Object.values(ICON)) {
    if (kind === ICON.DEFAULT) continue; // DEFAULT 是 v-else，没有 kind 判断
    assert.ok(source.includes(`kind === TOOL_ROW_ICON.${kind}`), `缺少 ${kind} 的绘制分支`);
  }
  assert.match(source, /<svg v-else :class="iconClass"/, '必须有兜底分支，未登记工具不能白屏');
});
