/**
 * 工具调用元数据的唯一解析入口。
 *
 * 收敛原因（重要）：
 * 原先"工具分类"逻辑被复制了 3~4 份，且全部依赖 `toolName.includes('read')`
 * 这类子串猜测 —— `already_read`、`thread` 会被误判为"读取"，
 * 含 command 的任意工具名会被误判为终端命令。且三处规则已发生漂移。
 *
 * 现在的策略是"不猜"：
 *   1) 后端下发 category 时直接采用（唯一可信来源）
 *   2) 否则查已知工具名映射表（显式声明，不做子串匹配）
 *   3) 未知工具直接展示工具名，不再强行归类
 *
 * ⚠️ 后端依赖：映射表只是后端未下发 category 时的过渡兼容，
 *    后端应在工具定义中下发 category，届时整张表可删除。
 */

import { pickField, toObject } from './json';

export const TOOL_CATEGORY = {
  PWSH: 'Pwsh',
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
  execute_command: TOOL_CATEGORY.PWSH,
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

/**
 * 工具参数名（唯一声明处）。
 * 契约来源：com.summit.dp.tools.baseTools.arguments.*
 *   - ExecuteCommandRequest：command / intention
 *   - ReadFileRequest、EditFileRequest：path
 *   - RequireChoiceToolExecutor：question / choice
 *   - CallSubAgentToolArgument：task / prompt / agentId / subSessionId / workDir / agentName
 *   - PlanCreateArgument：title / text
 * 各工具的参数名互不重名，无需别名兜底。
 */
const ARG_KEYS = {
  command: ['command'],
  action: ['intention'],
  target: ['path'],
  question: ['question'],
  task: ['task'],
  prompt: ['prompt'],
  agentId: ['agentId'],
} as const;

export interface ToolMetaInput {
  toolName?: string;
  category?: string;
  args?: unknown;
  query?: string;
  rawArgs?: string;
}

export interface ToolMeta {
  category: string;
  description: string;
  target: string;
  command: string;
}

/** 规范化工具名：小写、去空格 */
export function normalizeToolName(toolName?: string | null): string {
  return (toolName || '').trim().toLowerCase();
}

/**
 * 解析工具分类。后端 category 优先，其次查表，未知工具返回工具名本身。
 */
export function resolveToolCategory(toolName?: string | null, backendCategory?: string | null): string {
  const explicit = (backendCategory || '').trim();
  if (explicit) return explicit;

  const key = normalizeToolName(toolName);
  if (!key) return TOOL_CATEGORY.DEFAULT;
  return KNOWN_TOOL_CATEGORY[key] ?? key;
}

/** 是否为子代理委派工具（精确匹配，不再用 includes） */
export function isSubAgentTool(toolName?: string | null, category?: string | null): boolean {
  if ((category || '').trim() === TOOL_CATEGORY.SUB_AGENT) return true;
  return normalizeToolName(toolName) === 'call_sub_agent';
}

/**
 * 是否为计划书提交工具（模型提交一段 Markdown 计划书 ⇒ loop 暂停等审批）。
 * 契约来源：ToolCatalog.CREATE_PLAN = "create_plan"。
 */
export function isPlanDocumentTool(toolName?: string | null): boolean {
  return normalizeToolName(toolName) === 'create_plan';
}

/** 是否为文件编辑工具 (edit_file / file_editor) */
export function isEditFileTool(toolName?: string | null): boolean {
  const name = normalizeToolName(toolName);
  return name === 'edit_file' || name === 'file_editor';
}

/** 解析工具展示所需的全部元数据 */
export function resolveToolMeta(input: ToolMetaInput): ToolMeta {
  const { toolName, category, args, query, rawArgs } = input;

  const parsedArgs = toObject(args, {});
  const fallbackText = rawArgs ?? (typeof query === 'string' ? query : '');
  const resolvedCategory = resolveToolCategory(toolName, category);

  let description = '';
  let target = '';
  let command = '';

  switch (resolvedCategory) {
    case TOOL_CATEGORY.PWSH:
      command = pickField(parsedArgs, ARG_KEYS.command);
      description = pickField(parsedArgs, ARG_KEYS.action) || command;
      break;
    case TOOL_CATEGORY.READ:
      target = pickField(parsedArgs, ARG_KEYS.target);
      description = target;
      break;
    case TOOL_CATEGORY.WRITE:
      target = pickField(parsedArgs, ARG_KEYS.target);
      description = target;
      break;
    case TOOL_CATEGORY.CHOICE:
      description = pickField(parsedArgs, ARG_KEYS.question);
      break;
    case TOOL_CATEGORY.SUB_AGENT:
      description = pickField(parsedArgs, ARG_KEYS.task);
      break;
    default:
      break;
  }

  if (!description) description = fallbackText;
  return { category: resolvedCategory, description, target, command };
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
  task?: string;
  prompt?: string;
  subSessionId?: string | number;
}

/**
 * 从工具调用的多个可能来源中提取子代理参数。
 * 来源优先级：结构化字段 → args → query(JSON 字符串)。
 */
export function extractSubAgentParams(tc: {
  subAgentId?: unknown;
  subTask?: unknown;
  subPrompt?: unknown;
  subSessionId?: unknown;
  args?: unknown;
  query?: string;
}): SubAgentParams {
  let agentId = tc.subAgentId as string | number | undefined;
  let task = typeof tc.subTask === 'string' ? tc.subTask : '';
  let prompt = typeof tc.subPrompt === 'string' ? tc.subPrompt : '';
  let subSessionId = tc.subSessionId as string | number | undefined;

  const args = toObject(tc.args, {});
  const queryObj = toObject(tc.query, {});
  const merged: Record<string, any> = { ...queryObj, ...args };

  if (agentId === undefined || agentId === null || agentId === '') {
    agentId = merged.agentId as string | number | undefined;
  }
  if (!task) task = typeof merged.task === 'string' ? merged.task : '';
  if (!prompt) prompt = typeof merged.prompt === 'string' ? merged.prompt : '';
  if (subSessionId === undefined || subSessionId === null || subSessionId === '') {
    subSessionId = merged.subSessionId as string | number | undefined;
  }

  return { agentId, task, prompt, subSessionId };
}
