/** 工具展示严格按后端固定工具名称及参数字段解析，不接受兼容名或分类推断。 */

import { toObject } from './json';

export const TOOL_CATEGORY = {
  COMMAND: '执行命令',
  READ: '读取',
  WRITE: '写入',
  CHOICE: '选择',
  SUB_AGENT: '子代理',
  THINK: '思考',
  PLAN: '计划',
  DEFAULT: '工具',
} as const;

/**
 * 已知工具名 → 分类。键为规范化后的工具名（小写），仅精确匹配。
 * 契约来源：com.summit.dp.tools.baseTools.config.AvailableTool / ToolConfig / ToolCatalog——
 * 后端实际注册的工具名仅有：read_file、edit_file、execute_command、web_search、
 * compact_context、create_plan、require_choice、call_sub_agent。
 * 后端不下发 category 字段，故这是"名称→展示分类"的纯前端映射，只列真实工具名；
 * 未列出的工具（如 compact_context）不强行归类，直接展示原始工具名。
 */
const KNOWN_TOOL_CATEGORY: Record<string, string> = {
  // 终端命令
  execute_command: TOOL_CATEGORY.COMMAND,
  // 读取
  read_file: TOOL_CATEGORY.READ,
  web_search: TOOL_CATEGORY.READ,
  // 写入
  edit_file: TOOL_CATEGORY.WRITE,
  // 选择 / 人工确认
  require_choice: TOOL_CATEGORY.CHOICE,
  // 计划书
  create_plan: TOOL_CATEGORY.PLAN,
  // 子代理
  call_sub_agent: TOOL_CATEGORY.SUB_AGENT,
};



export interface ToolMetaInput {
  toolName?: string;
  args?: unknown;
}

export interface ToolMeta {
  category: string;
  description: string;
  target: string;
  command: string;
}

/** 读取后端固定工具名称，不转换大小写或接受别名 */
export function normalizeToolName(toolName?: string | null): string {
  return toolName ?? '';
}

/**
 * 按后端固定工具名称映射展示文案；未知工具展示原名。
 */
export function resolveToolCategory(toolName?: string | null): string {
  const key = normalizeToolName(toolName);
  return KNOWN_TOOL_CATEGORY[key] ?? key;
}

/** 是否为子代理委派工具（精确匹配，不再用 includes） */
export function isSubAgentTool(toolName?: string | null, _category?: string | null): boolean {
  return normalizeToolName(toolName) === 'call_sub_agent';
}

/**
 * 是否为计划书提交工具（模型提交一段 Markdown 计划书 ⇒ loop 暂停等审批）。
 * 契约来源：ToolCatalog.CREATE_PLAN = "create_plan"。
 */
export function isPlanDocumentTool(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === 'create_plan';
}

/** 是否为文件编辑工具（后端固定名称 edit_file） */
export function isEditFileTool(toolName?: string | null): boolean {
  const name = normalizeToolName(toolName);
  return name === 'edit_file';
}

/** 仅命令和文件编辑工具展示原始参数，其他工具保留摘要与执行结果。 */
export function shouldShowToolArguments(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === 'execute_command' || isEditFileTool(toolName);
}

/** 解析工具展示所需的全部元数据 */
export function resolveToolMeta(input: ToolMetaInput): ToolMeta {
  const args = toObject(input.args, {});
  const field = (key: string): string => typeof args[key] === 'string' ? args[key] : '';
  const category = resolveToolCategory(input.toolName);
  let description = '';
  let target = '';
  let command = '';
  switch (input.toolName) {
    case 'execute_command':
      command = field('command');
      description = field('intention');
      break;
      
    case 'read_file':

    case 'edit_file':
      target = field('path');
      description = target;
      break;

    case 'require_choice':
      description = field('question');
      break;

    case 'call_sub_agent':
      description = field('task');
      break;

    case 'create_plan':
      description = field('title');
      break;
  }
  return { category, description, target, command };
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