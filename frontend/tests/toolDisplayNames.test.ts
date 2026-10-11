import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { AgentToolName } from '../src/utils/toolNames';
import { TOOL_DISPLAY_NAMES, resolveToolDisplayName, resolveToolFullName, resolveToolRenderName } from '../src/utils/toolDisplayNames';
import { resolveToolCategory, toolCategoryLabel } from '../src/utils/toolMeta';
import { setPreference } from '../src/i18n';

test('每个固定工具都有完整名与渲染名，渲染名保持既有流式文案', async () => {
  setPreference('zh-CN'); await nextTick();
  assert.equal(TOOL_DISPLAY_NAMES.size, Object.values(AgentToolName).length);
  for (const name of Object.values(AgentToolName)) {
    const entry = TOOL_DISPLAY_NAMES.get(name);
    assert.ok(entry); assert.ok(entry.fullName); assert.ok(entry.renderName);
    assert.notEqual(entry.fullName, name);
    assert.equal(entry.renderName, toolCategoryLabel(resolveToolCategory(name)));
  }
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ReadFile) }, { fullName: '读取文件', renderName: '读取' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.WebSearch) }, { fullName: '网页搜索', renderName: '读取' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.EditFile) }, { fullName: '编辑文件', renderName: '写入' });
});

test('同一映射实体跟随语言变化，未知与空标识不裸显机器名', async () => {
  const entry = resolveToolDisplayName(AgentToolName.ReadFile);
  setPreference('en-US'); await nextTick();
  assert.equal(entry.fullName, 'Read file'); assert.equal(entry.renderName, 'Read');
  setPreference('zh-CN'); await nextTick();
  assert.equal(entry.fullName, '读取文件'); assert.equal(entry.renderName, '读取');
  for (const name of ['mcp_remote_tool', 'future_tool', 'constructor']) {
    assert.equal(resolveToolFullName(name), '工具'); assert.equal(resolveToolRenderName(name), '工具');
  }
  assert.equal(resolveToolFullName(null), ''); assert.equal(resolveToolRenderName(undefined), '');
});
