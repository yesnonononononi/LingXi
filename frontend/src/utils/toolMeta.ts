/** 工具展示严格按后端固定工具名称及参数字段解析，不接受兼容名或分类推断。 */

import { toObject } from './json';
import { AgentToolName } from './toolNames';
import { t } from '../i18n';

/**
 * 工具分类（稳定判别码）。**不是展示文案** —— 界面展示一律经 {@link toolCategoryLabel}
 * 取当前语言的文案；这里的取值同时用作分类比对（如 toolDiff 判写入）。
 */
export const TOOL_CATEGORY = {
  COMMAND: 'COMMAND',
  READ: 'READ',
  WRITE: 'WRITE',
  CHOICE: 'CHOICE',
  SUB_AGENT: 'SUB_AGENT',
  PEEK: 'PEEK',
  THINK: 'THINK',
  PLAN: 'PLAN',
  MAIL: 'MAIL',
  COMPACT: 'COMPACT',
  TOOL_SEARCH: 'TOOL_SEARCH',
  MCP_LIST: 'MCP_LIST',
  SKILL: 'SKILL',
  DEFAULT: 'DEFAULT',
} as const;

/** 稳定分类用于逻辑判定，工具名称统一从 toolDisplayNames 读取。 */
const KNOWN_TOOL_CATEGORY: Partial<Record<AgentToolName, string>> = {
  // 终端命令
  [AgentToolName.ExecuteCommand]: TOOL_CATEGORY.COMMAND,
  [AgentToolName.ManageCommand]: TOOL_CATEGORY.COMMAND,
  // 读取
  [AgentToolName.ReadFile]: TOOL_CATEGORY.READ,
  [AgentToolName.ReadImage]: TOOL_CATEGORY.READ,
  [AgentToolName.WebSearch]: TOOL_CATEGORY.READ,
  // 写入
  [AgentToolName.EditFile]: TOOL_CATEGORY.WRITE,
  // 选择 / 人工确认
  [AgentToolName.RequireChoice]: TOOL_CATEGORY.CHOICE,
  // 计划书
  [AgentToolName.CreatePlan]: TOOL_CATEGORY.PLAN,
  // 子代理
  [AgentToolName.CallSubAgent]: TOOL_CATEGORY.SUB_AGENT,
  // 查看队员状态（只读观测，与委派分属两类）
  [AgentToolName.PeekTeammateState]: TOOL_CATEGORY.PEEK,
  // Agent 间邮件
  [AgentToolName.SendMailToAgent]: TOOL_CATEGORY.MAIL,
  // 上下文压缩
  [AgentToolName.CompactContext]: TOOL_CATEGORY.COMPACT,
  // 渐进披露：检索工具 / 列举可用工具
  [AgentToolName.SearchTool]: TOOL_CATEGORY.TOOL_SEARCH,
  [AgentToolName.ListMcpTools]: TOOL_CATEGORY.MCP_LIST,
  // Skill 正文读取
  [AgentToolName.ReadSkill]: TOOL_CATEGORY.SKILL,
};

/** 未登记工具的统一兜底分类码（绝不裸显原生英文名）。 */
export const UNKNOWN_TOOL_LABEL = TOOL_CATEGORY.DEFAULT;

/** 分类码 → i18n key。 */
const TOOL_CATEGORY_LABEL_KEY: Record<string, string> = {
  [TOOL_CATEGORY.COMMAND]: 'tool.category.command',
  [TOOL_CATEGORY.READ]: 'tool.category.read',
  [TOOL_CATEGORY.WRITE]: 'tool.category.write',
  [TOOL_CATEGORY.CHOICE]: 'tool.category.choice',
  [TOOL_CATEGORY.SUB_AGENT]: 'tool.category.subAgent',
  [TOOL_CATEGORY.PEEK]: 'tool.category.peek',
  [TOOL_CATEGORY.THINK]: 'tool.category.think',
  [TOOL_CATEGORY.PLAN]: 'tool.category.plan',
  [TOOL_CATEGORY.MAIL]: 'tool.category.mail',
  [TOOL_CATEGORY.COMPACT]: 'tool.category.compact',
  [TOOL_CATEGORY.TOOL_SEARCH]: 'tool.category.toolSearch',
  [TOOL_CATEGORY.MCP_LIST]: 'tool.category.mcpList',
  [TOOL_CATEGORY.SKILL]: 'tool.category.skill',
  [TOOL_CATEGORY.DEFAULT]: 'tool.category.default',
};

/** 分类码 → 当前语言的用户可见文案；未知码原样回显（不臆断）。 */
export function toolCategoryLabel(category: string): string {
  const key = TOOL_CATEGORY_LABEL_KEY[category];
  return key ? t(key) : category;
}

/** MCP 工具名前缀（远端下发的动态集合，无法逐一枚举）。 */
const MCP_TOOL_PREFIX = 'mcp_';



export interface ToolMetaInput {
  toolName?: string;
  args?: unknown;
}

export interface ToolMeta {
  category: string;
  description: string;
  target: string;
  command: string;
  /** 行范围沿用后端的 0 基口径；缺省范围明确显示全文。 */
  lineRange: string;
}

/** 读取后端固定工具名称，不转换大小写或接受别名 */
export function normalizeToolName(toolName?: string | null): string {
  return toolName ?? '';
}

/** 分类只认后端标识；未知工具归入默认分类，空标识保持为空。 */
export function resolveToolCategory(toolName?: string | null): string {
  const key = normalizeToolName(toolName);
  if (!key) return '';
  const known = KNOWN_TOOL_CATEGORY[key as AgentToolName];
  if (known) return known;
  // MCP 是动态集合：名字不可枚举，统一归兜底而不是裸显 mcp_xxx。
  if (key.startsWith(MCP_TOOL_PREFIX)) return UNKNOWN_TOOL_LABEL;
  return UNKNOWN_TOOL_LABEL;
}

/** 是否为子代理委派工具（精确匹配，不再用 includes） */
export function isSubAgentTool(toolName?: string | null, _category?: string | null): boolean {
  return normalizeToolName(toolName) === AgentToolName.CallSubAgent;
}

/** 是否为文件编辑工具（后端固定名称见枚举） */
export function isEditFileTool(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === AgentToolName.EditFile;
}

/**
 * 是否为文件读取工具。
 *
 * <p>读文件没有可展开的详情：头部一行已经说清「读了哪个文件、读了哪几行」，展开后只剩路径与状态
 * 这几项头部已有的信息 —— 结果正文（文件内容）是给模型看的，前端不展示，后端也不再下发。</p>
 */
export function isReadFileTool(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === AgentToolName.ReadFile;
}

/** 仅命令和文件编辑工具展示原始参数，其他工具保留摘要与执行结果。 */
export function shouldShowToolArguments(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === AgentToolName.ExecuteCommand || isEditFileTool(toolName);
}

/**
 * 通用工具结果信封解包。
 *
 * <p>EXECUTE 直通链路落库的 {@code raw_output} 是 {@code {outcome,output}}（失败为
 * {@code {outcome,reason}}）信封，直接展示就是一坨带转义的 JSON。成功/失败状态已由
 * 状态点表达，展示与复制只关心正文：解出 {@code output}（缺省退 {@code reason}）；
 * 非信封形状（普通文本、其它 JSON）一律原样返回，绝不臆断。</p>
 */
export function unwrapToolResultEnvelope(raw?: string | null): string {
  const text = raw ?? '';
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(trimmed) as { outcome?: unknown; output?: unknown; reason?: unknown };
    if (typeof parsed !== 'object' || parsed === null) return text;
    if (typeof parsed.output === 'string' && parsed.output.trim() !== '') return parsed.output;
    if (typeof parsed.reason === 'string' && parsed.reason.trim() !== '') return parsed.reason;
    return text;
  } catch {
    return text;
  }
}

/** 参数里的整数（容忍数字字符串，模型下发的 args 偶有字符串数字） */const intArg = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** 未指定的边界按执行器语义显示，避免把未知终点冒充实际行数。 */
const readLineRange = (args: Record<string, unknown>): string => {
  const start = intArg(args.startLine);
  const end = intArg(args.endLine);
  if (start === null && end === null) return t('tool.lineRange.all');
  return `L${start ?? 0}-${end ?? t('tool.lineRange.end')}`;
};

/** 解析工具展示所需的全部元数据 */
export function resolveToolMeta(input: ToolMetaInput): ToolMeta {
  const args = toObject(input.args, {});
  const field = (key: string): string => typeof args[key] === 'string' ? args[key] : '';
  const category = resolveToolCategory(input.toolName);
  let description = '';
  let target = '';
  let command = '';
  let lineRange = '';
  switch (input.toolName) {
    case AgentToolName.ExecuteCommand:
      command = field('command');
      description = field('intention');
      break;

    case AgentToolName.ReadFile:
      target = field('path');
      description = target;
      lineRange = readLineRange(args);
      break;

    case AgentToolName.ReadImage:
    case AgentToolName.EditFile:
      target = field('path');
      description = target;
      break;

    case AgentToolName.RequireChoice:
      description = field('question');
      break;

    case AgentToolName.CallSubAgent:
      description = field('task');
      break;

    case AgentToolName.PeekTeammateState:
      // 队员名是模型随参数下发的展示字段，可能缺失 ⇒ 兜底「队员」；绝不把 agentId 当名字显示。
      description = t('tool.peekState', { name: field('agentName').trim() || t('tool.peekMember') });
      break;

    case AgentToolName.CreatePlan:
      description = field('title');
      break;
  }
  return { category, description, target, command, lineRange };
}

/**
 * 工具执行结果状态（前端四态）。
 *
 * 契约来源：docs/frontend-backend-contract.md §2.3。
 * 框架 `ToolCallStatus` = STARTED / COMPLETED / PROMISED / REJECTED / FAILED / TIMED_OUT / CANCELLED。
 * `ToolCallEndEvent.resultStatus` 为 final 必填字段、所有分支都传非空状态 → 缺失只可能是解析异常。
 * 历史实现把「缺失」当作成功、把 `PROMISED`/`STARTED` 也判为成功，会把挂起中的工具显示成成功；
 * 现按后端语义映射为四态，缺失/未知一律 `unknown`，绝不回落 `success`。
 */
export type ToolExecutionState = 'success' | 'failed' | 'pending' | 'unknown';

const FAILED_RESULT_STATUS = ['FAILED', 'REJECTED', 'TIMED_OUT', 'CANCELLED'] as const;
/** 非终态：工具即将调用（STARTED）或已被挂起等待人工决策（PROMISED） */
const PENDING_RESULT_STATUS = ['STARTED', 'PROMISED'] as const;

export function resolveToolExecutionStatus(resultStatus?: string | null): ToolExecutionState {
  if (resultStatus === null || resultStatus === undefined) return 'unknown';
  const normalized = resultStatus.trim().toUpperCase();
  if (!normalized) return 'unknown';
  if (normalized === 'COMPLETED') return 'success';
  if ((FAILED_RESULT_STATUS as readonly string[]).includes(normalized)) return 'failed';
  if ((PENDING_RESULT_STATUS as readonly string[]).includes(normalized)) return 'pending';
  return 'unknown';
}

export interface SubAgentParams {
  agentId?: string | number;
  agentName?: string;
  task?: string;
  prompt?: string;
  subSessionId?: string | number;
}

/** 子代理请求参数只从 query 读取；派生会话 ID 由工具执行结果写入。 */
export function extractSubAgentParams(tc: {
  query?: string;
  subSessionId?: unknown;
}): SubAgentParams {
  const args = toObject(tc.query, {});
  return {
    agentId: args.agentId,
    agentName: args.agentName,
    task: args.task,
    prompt: args.prompt,
    subSessionId: tc.subSessionId as string | number | undefined
  };
}
