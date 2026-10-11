/**
 * 工具展示名映射守卫。
 *
 * <p>后端下发的是机器名（{@code execute_command}、{@code list_mcp_tools}…），
 * 界面不得裸显。本文件锁定「工具名 → 用户可见中文名」这张映射表，
 * 并确保未登记 / MCP 动态工具一律走中文兜底。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { resolveToolCategory, toolCategoryLabel, TOOL_CATEGORY, UNKNOWN_TOOL_LABEL } from '../src/utils/toolMeta';
import { AgentToolName } from '../src/utils/toolNames';
import { setPreference } from '../src/i18n';

// 展示名随语言变化：本文件锁定中文口径，先把语言钉死为 zh-CN（不依赖运行环境 navigator）。
setPreference('zh-CN');
await nextTick();

/** 展示名 = 分类码 → 当前语言文案，UI 一律经此出口。 */
const label = (tool?: string | null): string => toolCategoryLabel(resolveToolCategory(tool));

test('已知固定工具全部映射为中文展示名，且不含英文下划线', () => {
  const expected: Array<[string, string]> = [
    [AgentToolName.ExecuteCommand, '执行命令'],
    [AgentToolName.ReadFile, '读取'],
    [AgentToolName.WebSearch, '读取'],
    [AgentToolName.EditFile, '写入'],
    [AgentToolName.RequireChoice, '选择'],
    [AgentToolName.CreatePlan, '计划'],
    [AgentToolName.CallSubAgent, '子代理'],
    [AgentToolName.SendMailToAgent, '发送邮件'],
    [AgentToolName.CompactContext, '压缩上下文'],
    [AgentToolName.SearchTool, '检索工具'],
    [AgentToolName.ListMcpTools, '列举可用工具'],
    [AgentToolName.ReadSkill, '读取技能'],
  ];
  for (const [tool, expectedLabel] of expected) {
    assert.equal(label(tool), expectedLabel, `${tool} 应映射为「${expectedLabel}」`);
  }
});

test('原生工具名绝不出现在展示名里（全量枚举扫描）', () => {
  for (const tool of Object.values(AgentToolName)) {
    const shown = label(tool);
    assert.ok(shown.length > 0, `${tool} 必须有展示名`);
    assert.ok(!shown.includes('_'), `${tool} 的展示名不得含下划线（裸显痕迹）: ${shown}`);
    assert.notEqual(shown, tool, `${tool} 不得原样回显`);
    // 分类码本身是稳定机器码，绝不能直接作为展示文案（必须再经 toolCategoryLabel）
    assert.notEqual(shown, resolveToolCategory(tool), `${tool} 的展示名不得等于分类码`);
  }
});

test('MCP 动态工具名走中文兜底，不裸显 mcp_xxx', () => {
  assert.equal(resolveToolCategory('mcp_filesystem_read_file'), UNKNOWN_TOOL_LABEL);
  assert.equal(resolveToolCategory('mcp__github__create_issue'), UNKNOWN_TOOL_LABEL);
  assert.equal(label('mcp_filesystem_read_file'), '工具');
});

test('未登记工具走统一中文兜底（不再是原生名）', () => {
  assert.equal(resolveToolCategory('some_future_tool'), UNKNOWN_TOOL_LABEL);
  assert.equal(resolveToolCategory('whatever'), UNKNOWN_TOOL_LABEL);
  assert.equal(label('some_future_tool'), '工具');
  assert.equal(label('whatever'), '工具');
});

test('空工具名返回空串（区别于「未知工具」）', () => {
  assert.equal(resolveToolCategory(''), '');
  assert.equal(resolveToolCategory(null), '');
  assert.equal(resolveToolCategory(undefined), '');
});

test('分类常量为稳定机器码，展示名经 toolCategoryLabel 取用', () => {
  // 分类码不再等同于中文文案：展示一律走 toolCategoryLabel
  assert.equal(TOOL_CATEGORY.MCP_LIST, 'MCP_LIST');
  assert.equal(TOOL_CATEGORY.COMMAND, 'COMMAND');
  // 锁住「列举可用工具」这条用户明确点名要的中文名
  assert.equal(toolCategoryLabel(TOOL_CATEGORY.MCP_LIST), '列举可用工具');
  assert.equal(toolCategoryLabel(TOOL_CATEGORY.COMMAND), '执行命令');
});
