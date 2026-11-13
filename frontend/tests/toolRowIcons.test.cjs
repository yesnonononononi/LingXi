'use strict';
/**
 * 工具行类型图标守卫：哪个工具画哪个图标、画出来的图形是否与别人重样、尺寸与配色是否统一。
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
const ICON = icons.TOOL_ROW_ICON;

/** 工具名 → 期望图标；分类码按 `resolveToolCategory` 现取，避免测试自己编分类。 */
function expectIcon(toolName) {
  return icons.resolveToolRowIcon(toolName, meta.resolveToolCategory(toolName));
}

const iconComponent = componentFromSrc('components/chat/process/ToolRowIcon.vue', {
  compileId: 'tool-row-icon',
});

/** 挂载图标组件，返回 svg 节点与它下面全部 path。 */
function renderIcon(t, toolName, isDark = true) {
  const root = mountComponent(t, iconComponent, {
    toolName,
    category: meta.resolveToolCategory(toolName),
    isDark,
  });
  const svg = find(root, node => node.tag === 'svg');
  assert.ok(svg, `工具 ${toolName || '(空)'} 必须有图标，不允许空白`);
  return {svg, paths: findAll(svg, node => node.tag === 'path')};
}

/** 图形的身份签名：同签名 = 两个图标长得一模一样。 */
function signature(viewBox, paths) {
  return `${viewBox}|${paths.map(node => String(node.props.d || '')).join('~')}`;
}

test('图标判别：文件动作按具体工具分（删除/写入/检索），同分类不再共用同一个图标', () => {
  assert.equal(expectIcon('delete_file'), ICON.FILE_DELETE, '删除文件必须是垃圾桶，不能混在写入里');
  assert.equal(expectIcon('write_file'), ICON.FILE_WRITE, '整文件写入用「文档 + 铅笔」');
  assert.equal(expectIcon('edit_file'), ICON.FILE_DOC, '局部编辑沿用文档图标');
  assert.equal(expectIcon('read_file'), ICON.FILE_DOC);
  assert.equal(expectIcon('read_image'), ICON.FILE_DOC);
});

test('图标判别：网页搜索与检索文件共用检索图标（用户明确要求同款）', () => {
  assert.equal(expectIcon('web_search'), ICON.FILE_SEARCH);
  assert.equal(expectIcon('web_search'), expectIcon('search_files'), '两者必须是同一个图标');
});

test('图标判别：邮件走信封，六个清单工具走清单图标', () => {
  assert.equal(expectIcon('send_mail_to_agent'), ICON.MAIL);
  for (const name of ['create_checklist', 'get_current_checklist', 'get_checklist',
    'update_checklist_step', 'modify_checklist', 'delete_checklist']) {
    assert.equal(expectIcon(name), ICON.CHECKLIST, `清单工具 ${name} 必须用清单图标`);
  }
});

test('图标判别：命令 / 思考 / 未知工具各归各位，未登记工具落兜底齿轮', () => {
  assert.equal(expectIcon('execute_command'), ICON.COMMAND);
  assert.equal(expectIcon('manage_command'), ICON.COMMAND);
  assert.equal(icons.resolveToolRowIcon('anything', 'THINK'), ICON.THINK, '思考分类按分类码取值');
  for (const name of ['require_choice', 'create_plan', 'call_sub_agent', 'peek_teammate_state',
    'compact_context', 'search_tool', 'list_mcp_tools', 'read_skill', 'mcp_github_create_issue', '']) {
    assert.equal(expectIcon(name), ICON.DEFAULT, `${name || '(空名)'} 必须落兜底齿轮，不许乱套图标`);
  }
});

test('绘制：图标尺寸与配色统一（w-4 h-4 + 同一前景色，禁止抄设计稿的十六进制填充）', async t => {
  const tools = ['search_files', 'web_search', 'read_file', 'edit_file', 'write_file',
    'delete_file', 'send_mail_to_agent', 'create_checklist', 'execute_command',
    'call_sub_agent', ''];
  const shapes = new Set();
  for (const toolName of tools) {
    for (const isDark of [true, false]) {
      const {svg, paths} = await renderIcon(t, toolName, isDark);
      const className = String(svg.props.class);
      assert.match(className, /(^|\s)w-4(\s|,|$)/, `${toolName} 图标宽度必须 w-4`);
      assert.match(className, /(^|\s)h-4(\s|,|$)/, `${toolName} 图标高度必须 h-4`);
      const tone = isDark ? 'text-zinc-100' : 'text-zinc-500';
      assert.match(className, new RegExp(tone), `${toolName} 图标前景色必须统一为 ${tone}`);
      assert.doesNotMatch(JSON.stringify(svg.props), /#[0-9a-fA-F]{3}/,
        `${toolName} 图标不得带死色值，否则深浅主题只有一种能看清`);
      for (const node of paths) {
        assert.equal(node.props.fill, undefined, `${toolName} 的 path 不得自带 fill`);
      }
      shapes.add(className.split(/\s+/).filter(token => token && token !== tone
        && !token.startsWith('drop-shadow-')).join(' '));
    }
  }
  assert.equal(shapes.size, 1, '除前景色外，全部图标的尺寸/发光类名必须完全一致：' + [...shapes].join(' | '));
});

test('绘制：不同种类的图形互不重样（复制粘贴图标必须变红）', async t => {
  const cases = [
    ['search_files', ICON.FILE_SEARCH],
    ['delete_file', ICON.FILE_DELETE],
    ['write_file', ICON.FILE_WRITE],
    ['send_mail_to_agent', ICON.MAIL],
    ['create_checklist', ICON.CHECKLIST],
    ['read_file', ICON.FILE_DOC],
    ['execute_command', ICON.COMMAND],
    ['call_sub_agent', ICON.DEFAULT],
  ];
  const signatures = new Map();
  for (const [toolName, kind] of cases) {
    const {svg, paths} = await renderIcon(t, toolName);
    assert.ok(paths.length > 0, `${kind} 必须有绘制内容`);
    const value = signature(svg.props.viewBox, paths);
    assert.equal(signatures.has(value), false,
      `${kind} 与 ${signatures.get(value)} 的图形完全相同，界面上分不出动作`);
    signatures.set(value, kind);
  }
  // 思考图标没有对应固定工具，单独按分类码验一次，否则它只在分支里存在、永不被渲染。
  const thinkRoot = mountComponent(t, iconComponent, {category: 'THINK', isDark: true});
  const thinkSvg = find(thinkRoot, node => node.tag === 'svg');
  const thinkPaths = findAll(thinkSvg, node => node.tag === 'path');
  assert.equal(signatures.has(signature(thinkSvg.props.viewBox, thinkPaths)), false,
    '思考图标不得与任何工具图标同形');
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

test('金丝雀：把 write_file 的映射改回文档图标，上面的判据会红（判据本身是活的）', () => {
  const file = path.resolve(harness.SRC_DIR, 'utils/toolRowIcons.ts');
  const original = fs.readFileSync(file, 'utf8');
  const mutated = original.replace(
    '[AgentToolName.WriteFile]: TOOL_ROW_ICON.FILE_WRITE',
    '[AgentToolName.WriteFile]: TOOL_ROW_ICON.FILE_DOC');
  assert.notEqual(mutated, original, '金丝雀样本没替换成功，这条自证无效');

  const mutatedIcons = loadFromSrc('utils/toolRowIcons.ts', {
    sourceOverrides: [{test: /toolRowIcons\.ts$/, source: mutated}],
  });
  assert.equal(mutatedIcons.resolveToolRowIcon('write_file'), 'FILE_DOC',
    '变异后判别必须落到文档图标，说明期望值能因回退变红');
});
