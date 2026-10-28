/**
 * 过程区视图模型单测（纯函数，不编译 SFC）。
 *
 * <p>锁三件事：</p>
 * <ol>
 *   <li>8 条呈现模式判定表经由 {@link deriveProcessViews} 仍然成立；</li>
 *   <li>{@link mergeSummaries} 的计数相加、保序去重与 `latest` 取最后一个有值项；</li>
 *   <li><b>失效分频</b>：只翻 `ongoing` 时 `summarizeProcess` 一次都不会被调用
 *       （层二绝不自己再摘一次）—— 这是设计书 A5.2 的硬断言。</li>
 * </ol>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setPreference } from '../src/i18n';
import { buildProcessSegments } from '../src/utils/processSegments';
import type { ProcessPart, ProcessSummary } from '../src/utils/processSegments';
import type { ProcessTimelineItem } from '../src/types/chat';
import {
  deriveProcessSummaries,
  deriveProcessViews,
  mergeSummaries,
  EMPTY_PROCESS_SUMMARY,
} from '../src/utils/processViewModel';
import { AgentToolName } from '../src/utils/toolNames';

setPreference('zh-CN');

/** 造一个工具项；`status` 直接决定 running / pending 计数。 */
function toolItem(id: string, order: number, status: string): ProcessTimelineItem {
  return {
    id,
    type: 'tool',
    order,
    tool: { id, toolName: AgentToolName.ReadFile, order, status, args: { path: `${id}.md` } },
  };
}

/** 造一个文本项（分段边界）。 */
function textItem(id: string, order: number): ProcessTimelineItem {
  return { id, type: 'intermediate_ai', order, message: { id, text: `第 ${id} 段`, order } };
}

/**
 * 造「一段过程」：`closed` 由是否在其后追加文本决定。
 *
 * @param items 段内条目
 * @param closed 是否追加一段后续文本收尾
 */
function segmentParts(items: ProcessTimelineItem[], closed: boolean): ProcessPart[] {
  const timeline = closed ? [...items, textItem('after', 100)] : items;
  return buildProcessSegments(timeline);
}

/** 只取过程分段的视图（文本分段只是边界）。 */
function segmentViews(parts: ProcessPart[], ongoing: boolean) {
  const summaries = deriveProcessSummaries(parts);
  const derived = deriveProcessViews(parts, summaries, ongoing);
  return derived.parts.filter(view => view.kind === 'segment');
}

test('判定表 1/2：段已收尾且步骤全定型 → summary（轮次是否结束都是 summary）', () => {
  for (const ongoing of [true, false]) {
    const views = segmentViews(segmentParts([toolItem('a', 0, 'success')], true), ongoing);
    assert.equal(views.length, 1);
    assert.equal(views[0].mode, 'summary', `ongoing=${ongoing} 时已收尾段应为概览`);
    assert.equal(views[0].headline.previewKind, 'value', '概览预览取目标列表');
  }
});

test('判定表 3/4：段已收尾但仍有 running / pending → 一票否决回 live', () => {
  const running = segmentViews(segmentParts([toolItem('a', 0, 'calling')], true), true);
  assert.equal(running[0].mode, 'live', 'running 一票否决');

  const pending = segmentViews(segmentParts([toolItem('a', 0, 'pending')], true), true);
  assert.equal(pending[0].mode, 'live', 'pending 一票否决');
});

test('判定表 5/6：轮次终态是权威，残留计数与未收尾都不阻止概览', () => {
  const residual = segmentViews(segmentParts([toolItem('a', 0, 'calling')], true), false);
  assert.equal(residual[0].mode, 'summary', '轮次结束后残留 running 只是陈旧事实');

  const unclosed = segmentViews(segmentParts([toolItem('a', 0, 'success')], false), false);
  assert.equal(unclosed[0].mode, 'summary', '最后一段永远等不到下一段 text，轮次结束即历史');
});

test('判定表 7/8：段仍在增长（未收尾）且轮次未结束 → live', () => {
  for (const status of ['success', 'calling', 'pending']) {
    const views = segmentViews(segmentParts([toolItem('a', 0, status)], false), true);
    assert.equal(views[0].mode, 'live', `未收尾段（${status}）必须是实时一步`);
  }
});

test('unknown 计数不参与判定，只影响状态文案', () => {
  const views = segmentViews(segmentParts([toolItem('a', 0, 'unknown')], true), true);
  assert.equal(views[0].mode, 'summary', 'unknown 既不能证明在跑也不能证明定型，不否决概览');
  assert.equal(views[0].headline.status, '1 项状态未知');
});

test('视图模型：文本分段不给摘要，headline 只在段视图上产出', () => {
  const parts = buildProcessSegments([toolItem('a', 0, 'success'), textItem('t1', 5)]);
  const summaries = deriveProcessSummaries(parts);
  assert.deepEqual(summaries.map(summary => summary.toolNames), [[AgentToolName.ReadFile], []]);
  assert.equal(summaries[1], EMPTY_PROCESS_SUMMARY, '文本分段复用同一个空摘要，不额外分配');
  const derived = deriveProcessViews(parts, summaries, false);
  assert.deepEqual(derived.parts.map(part => part.kind), ['segment', 'text']);
  assert.equal(derived.parts[1].kind === 'text' && derived.parts[1].part.id, 't1');
});

test('mergeSummaries：计数相加、工具名与目标保序去重、latest 取最后一个有值项', () => {
  const first: ProcessSummary = {
    toolNames: ['ReadFile', 'EditFile'], targets: ['a.md'], pendingCount: 1,
    runningCount: 2, unknownCount: 0, latest: toolItem('a', 0, 'pending'),
  };
  const second: ProcessSummary = {
    toolNames: ['EditFile', 'ExecuteCommand'], targets: ['a.md', 'b.md'], pendingCount: 0,
    runningCount: 0, unknownCount: 3,
  };
  const merged = mergeSummaries([first, second]);
  assert.deepEqual(merged.toolNames, ['ReadFile', 'EditFile', 'ExecuteCommand']);
  assert.deepEqual(merged.targets, ['a.md', 'b.md']);
  assert.equal(merged.pendingCount, 1);
  assert.equal(merged.runningCount, 2);
  assert.equal(merged.unknownCount, 3);
  assert.equal(merged.latest?.id, 'a', 'latest 取最后一个有值的摘要');
  assert.equal(mergeSummaries([]).latest, undefined);
});

test('失效分频：只翻 ongoing 时 summarizeProcess 一次都不被调用（层二不重算摘要）', () => {
  const parts = buildProcessSegments([
    toolItem('a', 0, 'success'), textItem('t1', 1), toolItem('b', 2, 'calling'),
  ]);
  let calls = 0;
  const countingSummarize = (items: ProcessTimelineItem[], subSessions?: never[]) => {
    calls++;
    return { toolNames: ['stub'], targets: [], pendingCount: 0, runningCount: 0,
      unknownCount: 0, latest: items.at(-1), ...(subSessions ? {} : {}) };
  };
  const summaries = deriveProcessSummaries(parts, [], countingSummarize);
  const segmentCount = parts.filter(part => part.kind === 'process').length;
  assert.equal(calls, segmentCount, '层一按段各摘一次');

  const before = calls;
  for (const ongoing of [true, false, true, false]) deriveProcessViews(parts, summaries, ongoing);
  assert.equal(calls, before, '层二（含只翻 ongoing）绝不能再调用摘要函数');
});

test('层二只读入参摘要：传入与 items 不一致的摘要，headline 必须跟着摘要走（不重算）', () => {
  const parts = segmentParts([toolItem('a', 0, 'success')], true);
  const forged: ProcessSummary = {
    toolNames: ['ForgedTool'], targets: ['forged.md'], pendingCount: 0, runningCount: 0,
    unknownCount: 0, latest: toolItem('forged', 0, 'success'),
  };
  const derived = deriveProcessViews(parts, [forged], false);
  const segment = derived.parts.find(part => part.kind === 'segment');
  assert.ok(segment && segment.kind === 'segment');
  assert.deepEqual(segment.summary, forged, '摘要对象原样透传');
  assert.match(segment.headline.title + segment.headline.preview, /forged/, '文案只能来自入参摘要');
  assert.deepEqual(derived.totals.toolNames, ['ForgedTool']);
});

test('纯函数：不修改入参，且相同输入产出等价结果', () => {
  const parts = buildProcessSegments([toolItem('a', 0, 'success'), textItem('t1', 1)]);
  const snapshot = JSON.stringify(parts);
  const summaries = deriveProcessSummaries(parts);
  const summariesSnapshot = JSON.stringify(summaries);
  const first = deriveProcessViews(parts, summaries, true);
  const second = deriveProcessViews(parts, summaries, true);
  assert.equal(JSON.stringify(parts), snapshot, '分段结果不得被改写');
  assert.equal(JSON.stringify(summaries), summariesSnapshot, '摘要不得被改写');
  assert.deepEqual(first.parts.map(part => part.kind), second.parts.map(part => part.kind));
  assert.deepEqual(
    first.parts.map(part => (part.kind === 'segment' ? part.mode : 'text')),
    second.parts.map(part => (part.kind === 'segment' ? part.mode : 'text'))
  );
});
