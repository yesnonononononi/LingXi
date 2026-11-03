import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick} from 'vue';
import {AgentToolName} from '../src/utils/toolNames';
import {
    resolveToolDisplayName,
    resolveToolFullName,
    resolveToolRenderName,
    TOOL_DISPLAY_NAMES
} from '../src/utils/toolDisplayNames';
import {setPreference} from '../src/i18n';
import {resolveToolCategory, TOOL_CATEGORY} from '../src/utils/toolMeta';

test('每个固定工具都有完整名与渲染名', async () => {
  setPreference('zh-CN'); await nextTick();
  assert.equal(TOOL_DISPLAY_NAMES.size, Object.values(AgentToolName).length);
  for (const name of Object.values(AgentToolName)) {
    const entry = TOOL_DISPLAY_NAMES.get(name);
    assert.ok(entry); assert.ok(entry.fullName); assert.ok(entry.renderName);
    assert.notEqual(entry.fullName, name);
  }
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ReadFile) }, { fullName: '读取文件', renderName: '读取' });
  // load_memory 短名独立成「读取记忆条目」，不再复用 read_file 的「读取」
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.LoadMemory) }, { fullName: '读取项目记忆', renderName: '读取记忆条目' });
  assert.equal(resolveToolCategory(AgentToolName.LoadMemory), TOOL_CATEGORY.READ);
  // search_wiki 的短渲染名独立成「检索记忆条目」，不再复用 search_tool 的「检索工具」
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.SearchWiki) }, { fullName: '检索项目记忆', renderName: '检索记忆条目' });
  assert.equal(resolveToolCategory(AgentToolName.SearchWiki), TOOL_CATEGORY.READ);
  // 两者必须真实可区分：搜记忆 ≠ 搜工具
  assert.equal(resolveToolRenderName(AgentToolName.SearchWiki), '检索记忆条目');
  assert.equal(resolveToolRenderName(AgentToolName.SearchTool), '检索工具');
  assert.notEqual(resolveToolRenderName(AgentToolName.SearchWiki), resolveToolRenderName(AgentToolName.SearchTool));
  // 记忆读与记忆搜也互不相同，且都不等于 read_file / search_tool 的短名
  assert.equal(resolveToolRenderName(AgentToolName.LoadMemory), '读取记忆条目');
  assert.notEqual(resolveToolRenderName(AgentToolName.LoadMemory), resolveToolRenderName(AgentToolName.SearchWiki));
  assert.notEqual(resolveToolRenderName(AgentToolName.LoadMemory), resolveToolRenderName(AgentToolName.ReadFile));
  assert.notEqual(resolveToolRenderName(AgentToolName.SearchWiki), resolveToolRenderName(AgentToolName.SearchTool));
  assert.notEqual(resolveToolRenderName(AgentToolName.SearchWiki), resolveToolRenderName(AgentToolName.ReadFile));
  // 读图短名独立成「查看图片」，不再复用 READ 的「读取」
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ReadImage) }, { fullName: '读取图片', renderName: '查看图片' });
  // 执行清单六个动作各自独立短名（分类码仍统一为 CHECKLIST，本次只改展示文案）
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.CreateChecklist) }, { fullName: '创建执行清单', renderName: '创建清单' });
  assert.equal(resolveToolCategory(AgentToolName.CreateChecklist), TOOL_CATEGORY.CHECKLIST);
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.GetCurrentChecklist) }, { fullName: '查看当前执行清单', renderName: '查看当前清单' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.GetChecklist) }, { fullName: '按标识查看执行清单', renderName: '按标识查看清单' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.UpdateChecklistStep) }, { fullName: '更新清单步骤', renderName: '更新清单步骤' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.ModifyChecklist) }, { fullName: '修改执行清单', renderName: '修改清单' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.DeleteChecklist) }, { fullName: '删除执行清单', renderName: '删除清单' });
  // web_search 渲染名独立成「检索网络资源」，不再复用 READ 分类文案（「读取」会让人以为是读文件）
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.WebSearch) }, { fullName: '网页搜索', renderName: '检索网络资源' });
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.EditFile) }, { fullName: '编辑文件', renderName: '写入' });
  // 「查看队员状态」自带名字，渲染名不再落到泛化的「工具」
  assert.deepEqual({ ...resolveToolDisplayName(AgentToolName.PeekTeammateState) }, { fullName: '查看队员状态', renderName: '查看队员状态' });
});

test('全部固定工具的短渲染名两两不重复（防回归唯一性守卫）', async () => {
  setPreference('zh-CN'); await nextTick();
  const entries = [...TOOL_DISPLAY_NAMES.entries()];
  assert.ok(entries.length > 0, 'TOOL_DISPLAY_NAMES 不能为空');
  const byRenderName = new Map<string, string[]>();
  for (const [toolName, entry] of entries) {
    const renderName = entry.renderName;
    assert.ok(renderName.length > 0, `${toolName} 必须有短渲染名`);
    const grouped = byRenderName.get(renderName) ?? [];
    grouped.push(toolName);
    byRenderName.set(renderName, grouped);
  }
  const duplicated = [...byRenderName.entries()].filter(([, tools]) => tools.length > 1);
  assert.deepEqual(duplicated, [], `短渲染名重复分组：${JSON.stringify(duplicated)}`);
  assert.equal(byRenderName.size, TOOL_DISPLAY_NAMES.size, '去重后的短名数量必须等于工具总数');
  // 英文口径同样两两不重复（en-US 下也走同一套 key）
  setPreference('en-US'); await nextTick();
  const englishNames = [...TOOL_DISPLAY_NAMES.values()].map((entry) => entry.renderName);
  assert.equal(new Set(englishNames).size, englishNames.length, `英文短渲染名重复：${JSON.stringify(englishNames)}`);
  setPreference('zh-CN'); await nextTick();
});

test('同一映射实体跟随语言变化，未知与空标识不裸显机器名', async () => {
  const entry = resolveToolDisplayName(AgentToolName.ReadFile);
  setPreference('en-US'); await nextTick();
  assert.equal(entry.fullName, 'Read file'); assert.equal(entry.renderName, 'Read');
  // 英文块也要有独立的记忆读取 / 记忆检索 / 读图文案，且与文件读取、工具检索不同
  assert.equal(resolveToolRenderName(AgentToolName.LoadMemory), 'Read memory entries');
  assert.equal(resolveToolRenderName(AgentToolName.SearchWiki), 'Search memory entries');
  assert.equal(resolveToolRenderName(AgentToolName.ReadImage), 'View image');
  assert.equal(resolveToolRenderName(AgentToolName.SearchTool), 'Search tools');
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
