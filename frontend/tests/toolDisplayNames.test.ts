import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { AgentToolName } from '../src/utils/toolNames';
import { TOOL_DISPLAY_NAMES, resolveToolDisplayName, resolveToolFullName, resolveToolRenderName } from '../src/utils/toolDisplayNames';
import { setPreference } from '../src/i18n';

test('每个固定工具都有完整名与渲染名', async () => {
  setPreference('zh-CN'); await nextTick();
  assert.equal(TOOL_DISPLAY_NAMES.size, Object.values(AgentToolName).length);
  for (const name of Object.values(AgentToolName)) {
    const entry = TOOL_DISPLAY_NAMES.get(name);
    assert.ok(entry); assert.ok(entry.fullName); assert.ok(entry.renderName);
    assert.notEqual(entry.fullName, name);
  }
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ReadFile) }, { fullName: '读取文件', renderName: '读取' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ReadImage) }, { fullName: '读取图片', renderName: '读取' });
  // web_search 渲染名独立成「检索网络资源」，不再复用 READ 分类文案（「读取」会让人以为是读文件）
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.WebSearch) }, { fullName: '网页搜索', renderName: '检索网络资源' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.EditFile) }, { fullName: '编辑文件', renderName: '写入' });
});

test('同一映射实体跟随语言变化，未知与空标识不裸显机器名', async () => {
  const entry = resolveToolDisplayName(AgentToolName.ReadFile);
  setPreference('en-US'); await nextTick();
  assert.equal(entry.fullName, 'Read file'); assert.equal(entry.renderName, 'Read');
  setPreference('zh-CN'); await nextTick();
  assert.equal(entry.fullName, '读取文件'); assert.equal(entry.renderName, '读取');
  assert.equal(resolveToolFullName(null), ''); assert.equal(resolveToolRenderName(undefined), '');
});

test('MCP 动态工具渲染成「服务名 原生名」（去 mcp_ 前缀），旧格式退化为原名', () => {
  // 新线上名格式 mcp_<服务名>_<原生名>
  assert.equal(resolveToolRenderName('mcp_context7_resolve-library-id'), 'context7 resolve-library-id');
  assert.equal(resolveToolFullName('mcp_context7_resolve-library-id'), 'context7 resolve-library-id');
  // 服务名含历史下划线时按第一个下划线切分（简单口径，接受近似）
  assert.equal(resolveToolRenderName('mcp_remote_tool'), 'remote tool');
  // 旧格式（mcp_<原生名>，前缀后无服务名段）退化为原生名，不显示「工具」
  assert.equal(resolveToolRenderName('mcp_resolve-library-id'), 'resolve-library-id');
  // 未登记的非 MCP 工具仍走「工具」兜底
  assert.equal(resolveToolFullName('future_tool'), '工具');
  assert.equal(resolveToolRenderName('constructor'), '工具');
});
