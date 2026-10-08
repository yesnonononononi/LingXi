/**
 * 工具展示名映射守卫。
 *
 * <p>后端下发的是机器名（{@code execute_command}、{@code list_mcp_tools}…），
 * 界面不得裸显。本文件锁定「工具名 → 用户可见中文名」这张映射表，
 * 并确保未登记 / MCP 动态工具一律走中文兜底。</p>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolCategory, TOOL_CATEGORY, UNKNOWN_TOOL_LABEL } from '../src/utils/toolMeta';
import { AgentToolName } from '../src/utils/toolNames';

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
  for (const [tool, label] of expected) {
    assert.equal(resolveToolCategory(tool), label, `${tool} 应映射为「${label}」`);
  }
});

test('原生工具名绝不出现在展示名里（全量枚举扫描）', () => {
  for (const tool of Object.values(AgentToolName)) {
    const label = resolveToolCategory(tool);
    assert.ok(label.length > 0, `${tool} 必须有展示名`);
    assert.ok(!label.includes('_'), `${tool} 的展示名不得含下划线（裸显痕迹）: ${label}`);
    assert.notEqual(label, tool, `${tool} 不得原样回显`);
  }
});

test('MCP 动态工具名走中文兜底，不裸显 mcp_xxx', () => {
  assert.equal(resolveToolCategory('mcp_filesystem_read_file'), UNKNOWN_TOOL_LABEL);
  assert.equal(resolveToolCategory('mcp__github__create_issue'), UNKNOWN_TOOL_LABEL);
});

test('未登记工具走统一中文兜底（不再是原生名）', () => {
  assert.equal(resolveToolCategory('some_future_tool'), UNKNOWN_TOOL_LABEL);
  assert.equal(resolveToolCategory('whatever'), UNKNOWN_TOOL_LABEL);
  assert.equal(UNKNOWN_TOOL_LABEL, '工具');
});

test('空工具名返回空串（区别于「未知工具」）', () => {
  assert.equal(resolveToolCategory(''), '');
  assert.equal(resolveToolCategory(null), '');
  assert.equal(resolveToolCategory(undefined), '');
});

test('分类常量齐备（新增工具时映射表与常量同源）', () => {
  // 锁住「列举可用工具」这条用户明确点名要的中文名
  assert.equal(TOOL_CATEGORY.MCP_LIST, '列举可用工具');
  assert.equal(TOOL_CATEGORY.COMMAND, '执行命令');
});
