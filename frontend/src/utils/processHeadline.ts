/**
 * 过程摘要的展示格式化。
 *
 * <p>{@link summarizeProcess} 只派生事实，本模块负责把事实变成一行文案：标题、预览、状态计数。
 * 组件不再各自拼文案 —— 去重、截断阈值、流式态语义都只在这里定义一处，中英文一律经 {@link t} 取。
 * 纯函数输入输出（除当前语言外无隐式状态），可直接单测，不必编译 SFC。</p>
 */
import type { ProcessSummary } from './processSegments';
import { resolveToolRenderName } from './toolDisplayNames';
import { resolveToolMeta } from './toolMeta';
import { t } from '../i18n';

/** 标题最多列出的工具名个数，超出转「等 N 类操作」。 */
const DEFAULT_MAX_NAMES = 3;
/** 预览最多列出的目标个数，超出转「等 N 个目标」。 */
const DEFAULT_MAX_TARGETS = 3;
/** 流式预览保留的思考正文尾部字符数。 */
const DEFAULT_MAX_PREVIEW_CHARS = 320;

/** 预览内容的来源，决定排版而非文案：text 是长正文，value 是单个值或短列表。 */
export type ProcessPreviewKind = 'text' | 'value' | 'none';

export interface ProcessHeadlineOptions {
  /** 是否为当前正在增长的段：true 时标题与预览指向「最新一步」，否则是整段概览。 */
  active?: boolean;
  /** running 计数的展示策略：auto 仅非 active 时显示，never 一律不显示。 */
  running?: 'auto' | 'never';
  /** 标题列出的工具名上限。 */
  maxNames?: number;
  /** 预览列出的目标上限。 */
  maxTargets?: number;
  /** 流式预览保留的思考正文字符数。 */
  maxPreviewChars?: number;
}

export interface ProcessHeadline {
  /** 折叠行左侧标题：流式态是最新工具名，否则是整段涉及的操作类别。 */
  title: string;
  /** 折叠行右侧预览：流式态是最新一步的内容，否则是整段涉及的目标。 */
  preview: string;
  /** 预览来源，供组件决定排版，不参与文案。 */
  previewKind: ProcessPreviewKind;
  /** 待确认 / 状态未知 / 进行中的计数文案，无计数时为空串。 */
  status: string;
}

/** 整段涉及的操作类别；重复工具名合并，超过上限只报总数。 */
function formatTitle(summary: ProcessSummary, active: boolean, maxNames: number): string {
  if (active) {
    const tool = summary.latest?.tool;
    return tool ? resolveToolRenderName(tool.toolName) : t('tool.category.think');
  }
  const names = [...new Set(summary.toolNames.map(resolveToolRenderName))];
  if (!names.length) return t('tool.category.think');
  const listed = names.slice(0, maxNames).join(t('chat.process.separator'));
  return names.length > maxNames ? t('chat.process.moreOperations', { names: listed, count: names.length }) : listed;
}

/** 流式态预览取最新一步：思考正文取尾部，工具取目标基线名 → 意图 → 命令。 */
function livePreview(summary: ProcessSummary, maxChars: number): Pick<ProcessHeadline, 'preview' | 'previewKind'> {
  const latest = summary.latest;
  if (latest?.step) {
    const text = latest.step.content.slice(-maxChars).replace(/\s+/g, ' ').trim();
    return text ? { preview: text, previewKind: 'text' } : { preview: '', previewKind: 'none' };
  }
  if (latest?.tool) {
    const meta = resolveToolMeta({ toolName: latest.tool.toolName, args: latest.tool.args ?? latest.tool.query });
    const value = meta.target.split(/[\\/]/).filter(Boolean).at(-1) || meta.description || meta.command;
    return value ? { preview: value, previewKind: 'value' } : { preview: '', previewKind: 'none' };
  }
  return { preview: '', previewKind: 'none' };
}

/** 整段涉及的目标；超过上限只报总数。 */
function overviewPreview(summary: ProcessSummary, maxTargets: number): Pick<ProcessHeadline, 'preview' | 'previewKind'> {
  const { targets } = summary;
  if (!targets.length) return { preview: '', previewKind: 'none' };
  const listed = targets.slice(0, maxTargets).join(t('chat.process.separator'));
  const preview = targets.length > maxTargets
    ? t('chat.process.moreTargets', { targets: listed, count: targets.length })
    : listed;
  return { preview, previewKind: 'value' };
}

/** 状态计数文案；按调用方策略决定 running 是否入列。 */
export function formatProcessStatus(summary: ProcessSummary, options: ProcessHeadlineOptions = {}): string {
  const running = options.running ?? 'auto';
  const showRunning = running === 'auto' && !options.active;
  return [
    summary.pendingCount ? t('chat.process.pending', { count: summary.pendingCount }) : '',
    summary.unknownCount ? t('chat.process.unknown', { count: summary.unknownCount }) : '',
    showRunning && summary.runningCount ? t('chat.process.running', { count: summary.runningCount }) : '',
  ].filter(Boolean).join(t('chat.process.separator'));
}

/** 折叠行完整文案：标题 + 预览 + 状态。 */
export function formatProcessHeadline(summary: ProcessSummary, options: ProcessHeadlineOptions = {}): ProcessHeadline {
  const active = options.active ?? false;
  const view = active
    ? livePreview(summary, options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS)
    : overviewPreview(summary, options.maxTargets ?? DEFAULT_MAX_TARGETS);
  return {
    title: formatTitle(summary, active, options.maxNames ?? DEFAULT_MAX_NAMES),
    preview: view.preview,
    previewKind: view.previewKind,
    status: formatProcessStatus(summary, options),
  };
}
