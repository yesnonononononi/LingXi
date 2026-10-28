/**
 * 过程区视图模型装配（纯函数，禁止 import vue）。
 *
 * <p>职责边界：`processSegments.ts` 只派生**事实**（分段、摘要、`closed`），本模块把「段级事实」
 * 与「轮次事实」（`ongoing`）装配成可渲染的视图对象，`ChatProcessSegment.vue` 因此退化为
 * 「模板 + 一个本地折叠状态」。</p>
 *
 * <p>为什么分两层：三类事实的失效频率不同 —— 段级事实随每个 token 变化（token 级），轮次态一轮
 * 只翻转几次（轮次级）。{@link deriveProcessSummaries} 只依赖分段结果，{@link deriveProcessViews}
 * 只依赖摘要的引用与 `ongoing`，于是「只有 `ongoing` 翻转」时 Vue 的 computed 会命中层一缓存，
 * 分段与 `summarizeProcess` 全部不重算（复杂度 O(#段)）。这条性质由
 * `tests/processViewModel.test.ts` 的调用计数桩锁定，不靠口头约定。</p>
 */
import type { ProcessPart, ProcessSegment, ProcessSegmentMode, ProcessSummary, ProcessText
  } from './processSegments';
import { resolveProcessSegmentMode, summarizeProcess } from './processSegments';
import type { ProcessHeadline } from './processHeadline';
import { formatProcessHeadline } from './processHeadline';
import type { ProcessTimelineItem, SubSessionVO } from '../types/chat';

/** 单个过程段的视图：事实 + 呈现模式 + 折叠行文案，全部由纯函数算出。 */
export interface ProcessSegmentView {
  kind: 'segment';
  segment: ProcessSegment;
  summary: ProcessSummary;
  mode: ProcessSegmentMode;
  headline: ProcessHeadline;
}

/** 文本分段的视图：文本段只提供位置边界，不含任何过程态。 */
export interface ProcessTextPartView {
  kind: 'text';
  part: ProcessText;
}

export type ProcessPartView = ProcessSegmentView | ProcessTextPartView;

export interface ProcessDerivedView {
  parts: ProcessPartView[];
  /** 整组「执行过程」折叠条的状态文案用；由各段摘要合并而来，不再二次遍历 items。 */
  totals: ProcessSummary;
}

/**
 * 摘要函数签名（与 {@link summarizeProcess} 一致）。
 *
 * <p>`deriveProcessSummaries` 的第三个参数默认取真实实现，只为测试注入「调用计数桩」留缝：
 * 层二绝不允许自己再摘一次，这条硬断言需要一个可观测的计数点。</p>
 */
export type ProcessSummarizeFn =
  (items: ProcessTimelineItem[], subSessions?: SubSessionVO[]) => ProcessSummary;

/** 空摘要：文本分段没有过程事实，用同一个冻结对象占位，避免每帧分配。 */
export const EMPTY_PROCESS_SUMMARY: ProcessSummary = Object.freeze({
  toolNames: [],
  targets: [],
  pendingCount: 0,
  runningCount: 0,
  unknownCount: 0,
  latest: undefined,
});

/**
 * 层一：只依赖分段结果（token 级失效）。
 *
 * @param parts 分段结果，索引与返回值一一对应（文本分段给 {@link EMPTY_PROCESS_SUMMARY}）
 * @param subSessions 子会话权威态，用于判定委派工具的真实状态
 * @param summarize 摘要实现，测试可注入计数桩
 * @returns 与 `parts` 等长的摘要数组
 */
export function deriveProcessSummaries(
  parts: ProcessPart[],
  subSessions: SubSessionVO[] = [],
  summarize: ProcessSummarizeFn = summarizeProcess
): ProcessSummary[] {
  return parts.map(part => part.kind === 'process' ? summarize(part.items, subSessions) : EMPTY_PROCESS_SUMMARY);
}

/**
 * 摘要合并：计数相加、`toolNames` / `targets` 保序去重、`latest` 取最后一个有值的。
 *
 * <p>它取代「对整组 items 再跑一遍 `summarizeProcess`」的第二趟遍历 —— 现值每 token 两趟，
 * 改后一趟。</p>
 */
export function mergeSummaries(list: ProcessSummary[]): ProcessSummary {
  const toolNames: string[] = [];
  const targets: string[] = [];
  let pendingCount = 0;
  let runningCount = 0;
  let unknownCount = 0;
  let latest: ProcessTimelineItem | undefined;
  for (const summary of list) {
    for (const name of summary.toolNames) {
      if (!toolNames.includes(name)) toolNames.push(name);
    }
    for (const target of summary.targets) {
      if (!targets.includes(target)) targets.push(target);
    }
    pendingCount += summary.pendingCount;
    runningCount += summary.runningCount;
    unknownCount += summary.unknownCount;
    if (summary.latest) latest = summary.latest;
  }
  return { toolNames, targets, pendingCount, runningCount, unknownCount, latest };
}

/**
 * 层二：只重新算 `mode` / `headline`（轮次级失效，O(#段)）。
 *
 * <p>不遍历段内步骤、不调用摘要函数：计数与最新一步全部来自入参 `summaries`。</p>
 *
 * @param parts 分段结果
 * @param summaries 层一产物，索引需与 `parts` 对齐
 * @param ongoing 整轮是否仍在进行（唯一来源：`ChatMessageItem.processIsOngoing`）
 */
export function deriveProcessViews(
  parts: ProcessPart[],
  summaries: ProcessSummary[],
  ongoing: boolean
): ProcessDerivedView {
  const views: ProcessPartView[] = [];
  const segmentSummaries: ProcessSummary[] = [];
  parts.forEach((part, index) => {
    if (part.kind !== 'process') {
      views.push({ kind: 'text', part });
      return;
    }
    const summary = summaries[index] ?? EMPTY_PROCESS_SUMMARY;
    segmentSummaries.push(summary);
    const mode = resolveProcessSegmentMode({
      closed: part.closed,
      ongoing,
      runningCount: summary.runningCount,
      pendingCount: summary.pendingCount,
    });
    views.push({
      kind: 'segment',
      segment: part,
      summary,
      mode,
      headline: formatProcessHeadline(summary, { active: mode === 'live' }),
    });
  });
  return { parts: views, totals: mergeSummaries(segmentSummaries) };
}
