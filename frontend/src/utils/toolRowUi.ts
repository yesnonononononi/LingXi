/**
 * 工具行（以及思考标题）的纯展示逻辑。
 *
 * <p>这些函数原来内联在 520 行的 `ProcessDetails.vue` 里，既无法单测、又和模板耦合。
 * 外提后：`ToolCallRenderer` 只做「读 props + 绑模板」，判定规则全部可被
 * `tests/toolRowUi.test.ts` 直接断言（不编译 SFC）。</p>
 *
 * <p>铁律：本模块只做展示派生，不判断「过程是否结束」—— 呈现模式判据唯一一处定义在
 * `processSegments.resolveProcessSegmentMode`。</p>
 */
import type { ChatMessage, ToolCallTrace } from '../types/chat';
import { t } from '../i18n';
import { AgentToolName } from './toolNames';
import { isReadFileTool, resolveToolMeta } from './toolMeta';
import type { ToolMeta } from './toolMeta';
import { parseToolDiff } from './toolDiff';
import { toObject } from './json';

/** 工具行的头部元信息（分类 / 目标 / 行范围 / 描述 / 命令 / 详情）。 */
export interface ToolRowMeta extends ToolMeta {
  /** 详情栏展示的一行摘要：命令工具取命令行，其余取描述。 */
  detail: string;
}

/** 增删行统计；`undefined` 表示该侧没有数据（模板据此决定是否渲染）。 */
export interface ToolRowDiffStat {
  plusLines?: number;
  minusLines?: number;
}

/** `edit_file` 的前后文本块。 */
export interface EditDiffChunks {
  oldText: string;
  newText: string;
}

/**
 * 解析工具行的头部元信息。
 *
 * @param tool 工具调用轨迹
 */
export function resolveToolRowMeta(tool: ToolCallTrace): ToolRowMeta {
  const meta = resolveToolMeta({ toolName: tool.toolName, args: tool.args ?? tool.query });
  const detail = tool.toolName === AgentToolName.ExecuteCommand ? meta.command : meta.description;
  return { ...meta, detail };
}

/**
 * 工具行的增删行统计。
 *
 * <p>统一走 `utils/toolDiff.ts` 的 `parseToolDiff`（收敛原因见该模块头注释）；
 * 这里只把「未知（null）」适配成模板约定的 `null`，UI 输出不变。</p>
 *
 * @param tool 工具调用轨迹
 * @param fileEdits 消息上的权威编辑记录（`parseToolDiff` 的最后一路数据源）
 */
export function resolveToolRowDiff(
  tool: ToolCallTrace,
  fileEdits?: ChatMessage['fileEdits']
): ToolRowDiffStat | null {
  const target = resolveToolMeta({ toolName: tool.toolName, args: tool.args ?? tool.query }).target;
  const stat = parseToolDiff({
    toolName: tool.toolName,
    category: tool.category,
    plusLines: tool.plusLines,
    minusLines: tool.minusLines,
    result: tool.result,
    description: tool.description,
    target,
    fileEdits,
    context: `toolCall ${tool.id}`,
  });
  if (!stat) return null;
  return {
    plusLines: stat.plusLines ?? undefined,
    minusLines: stat.minusLines ?? undefined,
  };
}

/**
 * 工具执行状态 → 指示灯样式。
 *
 * <p>契约 §2.3：`pending`（挂起待人工决策）与 `unknown`（状态未知）**不得**显示为成功或失败。</p>
 *
 * @param status 工具状态
 */
export function toolStatusDotClass(status?: string): string {
  switch (status) {
    case 'calling':
    case 'pending':
      return 'bg-amber-400 lx-live-dot';
    case 'failed':
      return 'bg-red-500';
    case 'unknown':
      return 'bg-zinc-400';
    default:
      return 'bg-emerald-500';
  }
}

/** 是否处于「进行中」（已请求 / 挂起待决断）——用于展示执行中占位。 */
export function isToolInProgress(status?: string): boolean {
  return status === 'calling' || status === 'pending';
}

/**
 * 该工具是否有可展开的详情。
 *
 * <p>读文件没有：头部一行已给全（读了哪个文件），展开拿不到头部没有的信息，
 * 只会把「路径 + 状态」重复一遍。其余工具（命令、编辑、检索等）保留详情。</p>
 */
export function canExpandToolRow(toolName?: string): boolean {
  return !!toolName && !isReadFileTool(toolName);
}

/**
 * 头部行的交互样式：能展开时才是按钮，读文件这类没有详情的行不该有「可点」的视觉暗示。
 *
 * <p>样式集中在此的理由同 {@link toolStatusDotClass}：模板里只保留一次类绑定，避免分支散落。</p>
 */
export function toolRowHeaderClass(tool: ToolCallTrace, dark: boolean): string[] {
  const base = dark ? 'text-zinc-200 text-glow-subtle' : 'text-zinc-600';
  if (!canExpandToolRow(tool.toolName)) return [base, 'cursor-default'];
  return [base, 'cursor-pointer hover:text-lx-primary'];
}

/** `edit_file` 的前后文本块；两侧都为空时返回 null（不渲染 diff 区）。 */
export function buildEditDiffChunks(query?: string): EditDiffChunks | null {
  const args = toObject(query, {});
  const oldText = typeof args.oldText === 'string' ? args.oldText : '';
  const newText = typeof args.newText === 'string' ? args.newText : '';
  if (!oldText && !newText) return null;
  return { oldText, newText };
}

/** 去掉路径尾部的 `(+N -M)` 统计后缀（diff 统计另有独立展示位）。 */
export function cleanDisplayPath(val?: string): string {
  if (!val) return '';
  return val.replace(/\s*\(\+\d+\s+-\d+\)$/, '').trim();
}

/**
 * 思考标题文案：后端给的 `Thought for` / `思考` 等一律归一成「深度思考」。
 *
 * @param title 原始标题
 */
export function formatThoughtTitle(title?: string): string {
  if (!title) return t('chat.message.deepThought');
  const trimmed = title.trim();
  if (trimmed === 'Thought for' || trimmed === 'Thought' || trimmed === '思考过程' || trimmed === '思考'
    || trimmed.toLowerCase() === 'thought for') {
    return t('chat.message.deepThought');
  }
  return trimmed;
}
