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
import type {ProcessPart, ProcessSegment, ProcessSegmentMode, ProcessSummary, ProcessText} from './processSegments';
import {resolveProcessSegmentMode, summarizeProcess} from './processSegments';
import type {ProcessHeadline} from './processHeadline';
import {formatProcessHeadline} from './processHeadline';
import type {ProcessTimelineItem, SubSessionVO} from '../types/chat';

/** 单个过程段的视图：事实 + 呈现模式 + 折叠行文案，全部由纯函数算出。 */
export interface ProcessSegmentView {
  kind: 'segment';
  segment: ProcessSegment;
  summary: ProcessSummary;
  /** 段自身真实状态：段内仍有未完成步骤时就是 live（**不参与**扫光互斥，见 `sweep`）。 */
  mode: ProcessSegmentMode;
  /**
   * 回答级「当前扫光位置」：整组过程里**唯一**一段为 true。
   *
   * <p>为什么不复用 `mode`：`mode` 描述的是「这一段该显示最新一步还是整段概览」，多段并存时
   * 它可以同时为 live（旧段已收尾但段内工具仍在跑）—— 那是**正确**的事实。扫光表达的是
   * 「此刻还在动」这一条**回答级**信号，只能有一个；把两者混成一个布尔，要么扫光乱闪，
   * 要么为了压扫光把旧段的「最新一步」文案降级成概览，两头都错。</p>
   */
  sweep: boolean;
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
 * 层二：只重新算 `mode` / `sweep` / `headline`（轮次级失效，O(#段)）。
 *
 * <p>不遍历段内步骤、不调用摘要函数：计数与最新一步全部来自入参 `summaries`。</p>
 *
 * <p>扫光位在这一层统一裁决，取**最后一个** `mode === 'live'` 的段；一个 live 段都没有时
 * 整组静止，谁都不扫光（不拿最后一段凑动画）。</p>
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
  // 回答级扫光位：记录「最后一个 live 段」在 views 里的下标，-1 = 整组静止（不扫光）。
  let liveIndex = -1;
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
    if (mode === 'live') liveIndex = views.length;
    views.push({
      kind: 'segment',
      segment: part,
      summary,
      mode,
      // 先全置 false，循环结束后只给唯一那一处置位：多段 live 时其余段不扫光。
      sweep: false,
      headline: formatProcessHeadline(summary, { active: mode === 'live' }),
    });
  });
  if (liveIndex >= 0) {
    const target = views[liveIndex];
    if (target && target.kind === 'segment') {
      views[liveIndex] = { ...target, sweep: true };
    }
  }
  return { parts: views, totals: mergeSummaries(segmentSummaries) };
}
