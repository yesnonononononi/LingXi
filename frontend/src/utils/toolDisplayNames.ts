import { t, useI18n } from '../i18n';
import { AgentToolName } from './toolNames';

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
  [AgentToolName.EditFile, defineToolName('编辑文件', 'Edit file', 'tool.category.write')],
  [AgentToolName.ExecuteCommand, defineToolName('执行命令', 'Execute command', 'tool.category.command')],
  [AgentToolName.WebSearch, defineToolName('网页搜索', 'Web search', 'tool.category.read')],
  [AgentToolName.RequireChoice, defineToolName('请求用户选择', 'Request user choice', 'tool.category.choice')],
  [AgentToolName.CreatePlan, defineToolName('创建计划', 'Create plan', 'tool.category.plan')],
  [AgentToolName.CallSubAgent, defineToolName('调用子 Agent', 'Call sub-agent', 'tool.category.subAgent')],
  [AgentToolName.SendMailToAgent, defineToolName('发送 Agent 邮件', 'Send agent mail', 'tool.category.mail')],
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

export function resolveToolDisplayName(toolName?: string | null): ToolDisplayName {
  return toolName ? TOOL_DISPLAY_NAMES.get(toolName as AgentToolName) ?? unknownToolName : emptyToolName;
}

export function resolveToolFullName(toolName?: string | null): string {
  return resolveToolDisplayName(toolName).fullName;
}

export function resolveToolRenderName(toolName?: string | null): string {
  return resolveToolDisplayName(toolName).renderName;
}
