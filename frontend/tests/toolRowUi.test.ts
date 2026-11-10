/**
 * 工具行纯函数单测（不编译 SFC）。
 *
 * <p>覆盖 `ProcessDetails.vue` 拆出的全部展示判定：头部元信息、diff 统计、状态灯、
 * 可展开判定、diff 文本块、路径清洗、思考标题归一。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {setPreference} from '../src/i18n';
import type {ToolCallTrace} from '../src/types/chat';
import {AgentToolName} from '../src/utils/toolNames';
import {TOOL_CATEGORY} from '../src/utils/toolMeta';
import {
    buildEditDiffLines,
    canExpandToolRow,
    cleanDisplayPath,
    formatThoughtTitle,
    isToolInProgress,
    resolveToolRowDiff,
    resolveToolRowMeta,
    toolRowHeaderClass,
    toolStatusDotClass,
} from '../src/utils/toolRowUi';

setPreference('zh-CN');

/** 造一个工具调用轨迹。 */
function tool(name: string, extra: Partial<ToolCallTrace> = {}): ToolCallTrace {
  return { id: 'call-1', toolName: name, order: 0, status: 'success', ...extra };
}

test('resolveToolRowMeta：分类/目标/行范围来自 resolveToolMeta，detail 对命令工具取命令行', () => {
  const command = resolveToolRowMeta(tool(AgentToolName.ExecuteCommand,
    { query: JSON.stringify({ command: 'npm test', intention: '跑测试' }) }));
  assert.equal(command.category, TOOL_CATEGORY.COMMAND);
  assert.equal(command.detail, 'npm test', '命令工具的详情栏展示命令行');

  const read = resolveToolRowMeta(tool(AgentToolName.ReadFile, { args: { path: 'a.md', startLine: 2, endLine: 5 } }));
  assert.equal(read.category, TOOL_CATEGORY.READ);
  assert.equal(read.detail, read.description, '非命令工具的详情栏取描述');
  assert.match(read.target, /a\.md$/);
});

test('resolveToolRowDiff：写入工具解析出增删行，读文件工具不给统计', () => {
  const edit = resolveToolRowDiff(tool(AgentToolName.EditFile, {
    result: JSON.stringify({ plusLines: 3, minusLines: 2 }),
  }));
  assert.deepEqual(edit, { plusLines: 3, minusLines: 2 });

  assert.equal(resolveToolRowDiff(tool(AgentToolName.ReadFile, { args: { path: 'a.md' } })), null,
    '读文件不是编辑工具，不给 diff');
  const broken = resolveToolRowDiff(tool(AgentToolName.EditFile, { result: 'not-json' }));
  assert.equal(broken, null, '解析失败返回 null 而不是 0 行');
});

test('toolStatusDotClass：pending/unknown 不得显示成成功或失败，进行中走琥珀脉冲', () => {
  assert.equal(toolStatusDotClass('calling'), 'bg-amber-400 lx-live-dot');
  assert.equal(toolStatusDotClass('pending'), 'bg-amber-400 lx-live-dot');
  assert.equal(toolStatusDotClass('failed'), 'bg-red-500');
  assert.equal(toolStatusDotClass('unknown'), 'bg-zinc-400');
  assert.equal(toolStatusDotClass('success'), 'bg-emerald-500');
  assert.equal(toolStatusDotClass(undefined), 'bg-emerald-500');
});

test('isToolInProgress：只有 calling / pending 算进行中', () => {
  assert.equal(isToolInProgress('calling'), true);
  assert.equal(isToolInProgress('pending'), true);
  assert.equal(isToolInProgress('success'), false);
  assert.equal(isToolInProgress(undefined), false);
});

test('canExpandToolRow：读文件没有详情，其余工具保留详情', () => {
  assert.equal(canExpandToolRow(AgentToolName.ReadFile), false);
  assert.equal(canExpandToolRow(AgentToolName.EditFile), true);
  assert.equal(canExpandToolRow(AgentToolName.ExecuteCommand), true);
  assert.equal(canExpandToolRow(undefined), false);
});

test('toolRowHeaderClass：不可展开的行没有「可点」的视觉暗示', () => {
  // dark 基底不含 text-glow-*：光晕会继承进 truncate 子元素并被裁成矩形灰盒，
  // 契约由 tests/processRowGlowClipping.test.cjs 守卫。
  assert.deepEqual(toolRowHeaderClass(tool(AgentToolName.ReadFile), true),
    ['text-zinc-200', 'cursor-default']);
  assert.deepEqual(toolRowHeaderClass(tool(AgentToolName.EditFile), false),
    ['text-zinc-600', 'cursor-pointer hover:text-lx-primary']);
});

test('buildEditDiffLines：删行在前、增行在后，行号从下发区间起算', () => {
  const lines = buildEditDiffLines({
    query: JSON.stringify({ oldText: '旧一\n旧二', newText: '新一' }),
    oldStartLine: 12,
    newStartLine: 12,
  });
  assert.deepEqual(lines, [
    { kind: 'del', lineNumber: 12, text: '旧一' },
    { kind: 'del', lineNumber: 13, text: '旧二' },
    { kind: 'add', lineNumber: 12, text: '新一' },
  ]);
});

test('buildEditDiffLines：末尾换行不算多一行，CRLF 等价', () => {
  const lines = buildEditDiffLines({
    query: JSON.stringify({ oldText: 'a\r\nb\r\n', newText: 'a\n' }),
    oldStartLine: 1,
    newStartLine: 1,
  });
  assert.deepEqual(lines, [
    { kind: 'del', lineNumber: 1, text: 'a' },
    { kind: 'del', lineNumber: 2, text: 'b' },
    { kind: 'add', lineNumber: 1, text: 'a' },
  ]);
});

test('buildEditDiffLines：缺行号区间时行号为 null，不编造', () => {
  const lines = buildEditDiffLines({ query: JSON.stringify({ oldText: '旧', newText: '新' }) });
  assert.deepEqual(lines, [
    { kind: 'del', lineNumber: null, text: '旧' },
    { kind: 'add', lineNumber: null, text: '新' },
  ]);
});

test('buildEditDiffLines：删除只有旧侧，插入只有新侧', () => {
  assert.deepEqual(buildEditDiffLines({ query: JSON.stringify({ oldText: '旧' }), oldStartLine: 3 }),
    [{ kind: 'del', lineNumber: 3, text: '旧' }]);
  assert.deepEqual(buildEditDiffLines({ query: JSON.stringify({ newText: '新' }), newStartLine: 1 }),
    [{ kind: 'add', lineNumber: 1, text: '新' }]);
});

test('buildEditDiffLines：两侧都空或参数非法时返回 null', () => {
  assert.equal(buildEditDiffLines({ query: JSON.stringify({}) }), null);
  assert.equal(buildEditDiffLines({ query: 'not-json' }), null);
  assert.equal(buildEditDiffLines({ query: undefined }), null);
});

test('cleanDisplayPath：剥掉尾部 (+N -M) 统计后缀并去空白', () => {
  assert.equal(cleanDisplayPath('D:\\repo\\mcp.json (+3 -2)'), 'D:\\repo\\mcp.json');
  assert.equal(cleanDisplayPath('  跑测试  '), '跑测试');
  assert.equal(cleanDisplayPath(undefined), '');
});

test('formatThoughtTitle：后端各种「思考」标题统一成深度思考，自定义标题原样保留', async () => {
  for (const raw of ['Thought for', 'Thought', 'thought for', '思考', '思考过程', '']) {
    assert.equal(formatThoughtTitle(raw), '深度思考', `原标题「${raw}」应归一到深度思考`);
  }
  assert.equal(formatThoughtTitle('  排查依赖  '), '排查依赖');

  setPreference('en-US');
  const { nextTick } = await import('vue');
  await nextTick();
  assert.equal(formatThoughtTitle('思考'), 'Deep thinking', '英文环境取英文文案');
  setPreference('zh-CN');
  await nextTick();
});
