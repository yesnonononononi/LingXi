import {t, useI18n} from '../i18n';
import {AgentToolName} from './toolNames';

export interface ToolDisplayName {
  readonly fullName: string;
  readonly renderName: string;
}

const { locale } = useI18n();

// 语言在读取时解析，切换语言后已加载的工具列表也会同步更新。
function defineToolName(chinese: string, english: string, renderKey: string): ToolDisplayName {
  return {
    get fullName() { return locale.value === 'en-US' ? english : chinese; },
    get renderName() { return t(renderKey); },
  };
}

/** 完整名用于工具配置，短渲染名用于流式调用展示；键始终是后端工具标识。 */
export const TOOL_DISPLAY_NAMES: ReadonlyMap<AgentToolName, ToolDisplayName> = new Map([
  [AgentToolName.ReadFile, defineToolName('读取文件', 'Read file', 'tool.category.read')],
  // 记忆读取的渲染名独立成「读取记忆条目」，避免与 read_file 的「读取」在流式工具行上同文案
  [AgentToolName.LoadMemory, defineToolName('读取项目记忆', 'Read project memory', 'tool.category.memoryRead')],
  // 项目记忆检索的渲染名独立成「检索记忆条目」，避免与 search_tool（检索工具）在流式工具行上同文案
  [AgentToolName.SearchWiki, defineToolName('检索项目记忆', 'Search project memory', 'tool.category.memorySearch')],
  // 读图不再复用 READ 的「读取」（用户看不出是在读图片）
  [AgentToolName.ReadImage, defineToolName('读取图片', 'Read image', 'tool.category.imageRead')],
  [AgentToolName.EditFile, defineToolName('编辑文件', 'Edit file', 'tool.category.write')],
  [AgentToolName.ExecuteCommand, defineToolName('执行命令', 'Execute command', 'tool.category.command')],
  [AgentToolName.ManageCommand, defineToolName('确认后台任务状态', 'Check background task status', 'tool.category.backgroundCommand')],
  // web_search 的渲染名不再复用 READ 分类文案（「读取」会让人以为是读文件），独立成「检索网络资源」
  [AgentToolName.WebSearch, defineToolName('网页搜索', 'Web search', 'tool.category.webSearch')],
  [AgentToolName.RequireChoice, defineToolName('请求用户选择', 'Request user choice', 'tool.category.choice')],
  [AgentToolName.CreatePlan, defineToolName('创建计划', 'Create plan', 'tool.category.plan')],
  // 执行清单工具与 create_plan 分类不同：它们是执行期可维护的待办，不产生审批卡片
  // 六个动作各自独立短名：流式工具行短名不得两两重名（同分类码仍由 toolMeta 保持稳定）
  [AgentToolName.CreateChecklist, defineToolName('创建执行清单', 'Create checklist', 'tool.category.checklistCreate')],
  [AgentToolName.GetCurrentChecklist, defineToolName('查看当前执行清单', 'Get current checklist', 'tool.category.checklistCurrent')],
  [AgentToolName.GetChecklist, defineToolName('按标识查看执行清单', 'Get checklist', 'tool.category.checklistById')],
  [AgentToolName.UpdateChecklistStep, defineToolName('更新清单步骤', 'Update checklist step', 'tool.category.checklistStep')],
  [AgentToolName.ModifyChecklist, defineToolName('修改执行清单', 'Modify checklist', 'tool.category.checklistModify')],
  [AgentToolName.DeleteChecklist, defineToolName('删除执行清单', 'Delete checklist', 'tool.category.checklistDelete')],
  [AgentToolName.CallSubAgent, defineToolName('调用子 Agent', 'Call sub-agent', 'tool.category.subAgent')],
  [AgentToolName.SendMailToAgent, defineToolName('发送 Agent 邮件', 'Send agent mail', 'tool.category.mail')],
  [AgentToolName.PeekTeammateState, defineToolName('查看队员状态', 'View teammate state', 'tool.category.peek')],
  [AgentToolName.CompactContext, defineToolName('压缩上下文', 'Compact context', 'tool.category.compact')],
  [AgentToolName.SearchTool, defineToolName('检索工具', 'Search tools', 'tool.category.toolSearch')],
  [AgentToolName.ListMcpTools, defineToolName('列举 MCP 工具', 'List MCP tools', 'tool.category.mcpList')],
  [AgentToolName.ReadSkill, defineToolName('读取技能', 'Read skill', 'tool.category.skill')],
]);

const unknownToolName: ToolDisplayName = {
  get fullName() { return t('tool.category.default'); },
  get renderName() { return t('tool.category.default'); },
};
const emptyToolName: ToolDisplayName = { fullName: '', renderName: '' };

/** MCP 工具名前缀（框架转换器拼接，业务侧服务名接在其后） */
const MCP_TOOL_PREFIX = 'mcp_';

/**
 * MCP 动态工具名解析：线上名为 {@code mcp_<服务名>_<原生名>}，渲染成「服务名 原生名」。
 *
 * <p>不裸显机器名，但也不能全部压成「工具」——服务名段就是区分度。旧格式
 * （{@code mcp_<原生名>}，前缀后无服务名段）与解析不出服务名段的，退化为显示原生名。
 * 服务名与原生名本身是数据，不走 i18n。</p>
 */
export function resolveMcpToolDisplayName(toolName: string): ToolDisplayName | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator <= 0) return { fullName: rest, renderName: rest };
  const server = rest.slice(0, separator);
  const raw = rest.slice(separator + 1);
  if (!raw) return { fullName: server, renderName: server };
  return { fullName: `${server} ${raw}`, renderName: `${server} ${raw}` };
}

export function resolveToolDisplayName(toolName?: string | null): ToolDisplayName {
  if (!toolName) return emptyToolName;
  const known = TOOL_DISPLAY_NAMES.get(toolName as AgentToolName);
  if (known) return known;
  return resolveMcpToolDisplayName(toolName) ?? unknownToolName;
}

export function resolveToolFullName(toolName?: string | null): string {
  return resolveToolDisplayName(toolName).fullName;
}

export function resolveToolRenderName(toolName?: string | null): string {
  return resolveToolDisplayName(toolName).renderName;
}
