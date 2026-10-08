/** 工具展示严格按后端固定工具名称及参数字段解析，不接受兼容名或分类推断。 */

import { toObject } from './json';
import { AgentToolName } from './toolNames';

export const TOOL_CATEGORY = {
  COMMAND: '执行命令',
  READ: '读取',
  WRITE: '写入',
  CHOICE: '选择',
  SUB_AGENT: '子代理',
  THINK: '思考',
  PLAN: '计划',
  MAIL: '发送邮件',
  COMPACT: '压缩上下文',
  TOOL_SEARCH: '检索工具',
  MCP_LIST: '列举可用工具',
  SKILL: '读取技能',
  DEFAULT: '工具',
} as const;

/**
 * 已知工具名 → 展示分类。键为后端注册名（见 {@link AgentToolName}），仅精确匹配。
 *
 * <p><b>这是「工具名 → 用户可见中文名」的唯一映射表</b>：后端下发的是机器名
 * （{@code execute_command}、{@code list_mcp_tools}…），直接展示等于把实现细节抛给用户。
 * 新增后端工具时**必须**在此登记 —— 未登记的会走 {@link UNKNOWN_TOOL_LABEL} 兜底，
 * 绝不把原生英文名裸显到界面上。终端命令等工具若当次调用带了 {@code description}，
 * 调用处优先展示 description（更具体），本表作无 description 时的回落。</p>
 *
 * <p>MCP 工具是远端下发的动态集合（{@code mcp_} 前缀，名字不可枚举），
 * 由 {@link resolveToolCategory} 按前缀统一归到 {@code DEFAULT}。</p>
 */
const KNOWN_TOOL_CATEGORY: Partial<Record<AgentToolName, string>> = {
  // 终端命令
  [AgentToolName.ExecuteCommand]: TOOL_CATEGORY.COMMAND,
  // 读取
  [AgentToolName.ReadFile]: TOOL_CATEGORY.READ,
  [AgentToolName.WebSearch]: TOOL_CATEGORY.READ,
  // 写入
  [AgentToolName.EditFile]: TOOL_CATEGORY.WRITE,
  // 选择 / 人工确认
  [AgentToolName.RequireChoice]: TOOL_CATEGORY.CHOICE,
  // 计划书
  [AgentToolName.CreatePlan]: TOOL_CATEGORY.PLAN,
  // 子代理
  [AgentToolName.CallSubAgent]: TOOL_CATEGORY.SUB_AGENT,
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

/** 未登记工具的统一兜底文案（绝不裸显原生英文名）。 */
export const UNKNOWN_TOOL_LABEL = TOOL_CATEGORY.DEFAULT;

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
  /** 读文件的行范围文案（L起点-终点，0 基口径与后端一致）；整文件读取为空串。 */
  lineRange: string;
}

/** 读取后端固定工具名称，不转换大小写或接受别名 */
export function normalizeToolName(toolName?: string | null): string {
  return toolName ?? '';
}

/**
 * 按后端固定工具名映射用户可见中文名。
 *
 * <p><b>绝不回落原生工具名</b>：未登记的固定工具走 {@link UNKNOWN_TOOL_LABEL} 兜底，
 * MCP 工具（{@code mcp_} 前缀）同样是远端动态名，一并归兜底 —— 界面上不出现
 * {@code list_mcp_tools} 这类机器名。已知工具见 {@link KNOWN_TOOL_CATEGORY}。</p>
 *
 * <p>空工具名返回空串（调用方据此判断「无可用信息」，而不是把它显示成兜底文案）。</p>
 */
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

/** 参数里的整数（容忍数字字符串，模型下发的 args 偶有字符串数字） */
const intArg = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** 读文件行范围文案：L起点-终点；两端都缺（整文件读取）为空串。 */
const readLineRange = (args: Record<string, unknown>): string => {
  const start = intArg(args.startLine);
  const end = intArg(args.endLine);
  if (start === null && end === null) return '';
  return `L${start ?? ''}-${end ?? ''}`;
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
