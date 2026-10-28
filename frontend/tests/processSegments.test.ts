import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ProcessTimelineItem, ToolCallTrace } from '../src/types/chat';
import { AgentToolName } from '../src/utils/toolNames';
import { buildProcessTimeline } from '../src/utils/processTimeline';
import { buildProcessSegments, resolveProcessSegmentMode, summarizeProcess } from '../src/utils/processSegments';
import type { ProcessSegmentModeFacts } from '../src/utils/processSegments';

function tool(id: string, toolName: string, order: number, extra: Partial<ToolCallTrace> = {}): ProcessTimelineItem {
  return { id, type: 'tool', order, tool: { id, toolName, order, status: 'success', ...extra } };
}
function text(id: string, order: number): ProcessTimelineItem {
  return { id, type: 'intermediate_ai', order, message: { id, text: '继续检查', order } };
}
const thought = (id: string, order: number): ProcessTimelineItem => ({ id, type: 'thought', order,
  step: { id, title: '思考', content: '推理内容', order, status: 'running' } });

test('相邻 text 是边界，同文案不同身份不会合并，段身份不随内容与尾部增长改变', () => {
  const message: ChatMessage = { id: 'a', role: 'assistant', content: '', timestamp: 0,
    aiMessages: [text('t1', 1).message!, text('t2', 3).message!],
    thoughtSteps: [thought('s1', 0).step!, thought('s2', 2).step!, thought('s3', 4).step!] };
  const parts = buildProcessSegments(buildProcessTimeline(message));
  assert.deepEqual(parts.map(part => part.kind), ['process', 'text', 'process', 'text', 'process']);
  assert.deepEqual(parts.filter(part => part.kind === 'process').map(part => [part.id, part.closed]),
    [['process:s1', true], ['process:s2', true], ['process:s3', false]]);
  message.thoughtSteps![2]!.content += '持续增长';
  message.toolCalls = [tool('c1', AgentToolName.ReadFile, 5).tool!];
  assert.equal(buildProcessSegments(buildProcessTimeline(message)).at(-1)?.id, 'process:s3');
});

test('同一子会话在不同文本段内分别展示，段内重复委派合并但不跨边界提前', () => {
  const items = [tool('d1', AgentToolName.CallSubAgent, 0, { subSessionId: '88' }), text('t1', 1),
    tool('d2', AgentToolName.CallSubAgent, 2, { subSessionId: '88' }),
    tool('d3', AgentToolName.CallSubAgent, 3, { subSessionId: '88' })];
  const segments = buildProcessSegments(items).filter(part => part.kind === 'process');
  assert.deepEqual(segments.map(part => part.detailItems.map(item => item.id)), [['sub-agents:d1'], ['sub-agents:d2']]);
  assert.deepEqual(segments.map(part => part.items.length), [1, 2]);
});

test('相邻成功读图仅在段内合并，摘要仍保留所有原始调用事实', () => {
  const image = (id: string, order: number) => tool(id, AgentToolName.ReadImage, order,
    { result: JSON.stringify({ ok: true, images: [{ imageId: '1234567890abcdef', ext: 'png', path: `${id}.png` }] }) });
  const segments = buildProcessSegments([image('a', 0), image('b', 1), text('t', 2), image('c', 3)], [], '7')
    .filter(part => part.kind === 'process');
  assert.deepEqual(segments.map(part => part.detailItems[0]?.images?.length), [2, 1]);
  assert.deepEqual(segments.map(part => part.items.length), [2, 1]);
});

test('最新活动按时间线选取，迟到旧工具收尾不能抢回思考预览，状态分别统计', () => {
  const first = tool('c1', AgentToolName.EditFile, 0, { status: 'calling', args: { path: 'C:\\project\\mcp.json' } });
  const items = [first, tool('c2', AgentToolName.ExecuteCommand, 1, { status: 'pending' }),
    tool('c3', 'mcp_docs_search', 2, { status: 'unknown' }), thought('s1', 3)];
  first.tool!.status = 'failed';
  const summary = summarizeProcess(items);
  assert.equal(summary.latest?.id, 's1');
  assert.deepEqual(summary.targets, ['mcp.json']);
  assert.equal(first.tool!.status, 'failed');
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.runningCount, 1);
});

test('所有固定工具沿用原名，无独立动词映射；空摘要与子会话权威状态可正确派生', () => {
  const names = Object.values(AgentToolName);
  const items = names.map((name, index) => tool(String(index), name, index));
  assert.deepEqual(summarizeProcess(items).toolNames, names);
  assert.deepEqual(summarizeProcess([]), { toolNames: [], targets: [],
    pendingCount: 0, runningCount: 0, unknownCount: 0, latest: undefined });
  const delegate = tool('delegate', AgentToolName.CallSubAgent, 0, { subSessionId: '88', query: '{"runtime_mode":"async"}' });
  assert.equal(summarizeProcess([delegate], [{ id: '88', runStatus: 'RUNNING' }]).runningCount, 1);
});
/**
 * 过程段呈现模式判定（`resolveProcessSegmentMode`）。
 *
 * <p>锁四类事实组合与两条否决条件：只有「段已收尾」且「无 running / pending」才允许整段概览；
 * 整轮已结束时最后一段（永远等不到下一段 text）也必须汇总；其余一律实时一步。</p>
 */
function modeFacts(patch: Partial<ProcessSegmentModeFacts> = {}): ProcessSegmentModeFacts {
  return { closed: false, ongoing: true, runningCount: 0, pendingCount: 0, ...patch };
}

test('模式判定：段未收尾时无论有无未完成步骤，一律实时一步', () => {
  assert.equal(resolveProcessSegmentMode(modeFacts()), 'live');
  assert.equal(resolveProcessSegmentMode(modeFacts({ runningCount: 2 })), 'live');
  assert.equal(resolveProcessSegmentMode(modeFacts({ pendingCount: 1 })), 'live');
  assert.equal(resolveProcessSegmentMode(modeFacts({ runningCount: 1, pendingCount: 1 })), 'live');
});

test('模式判定：段已收尾且无未完成步骤时汇总整段', () => {
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: true })), 'summary');
});

test('模式判定：running / pending 各自一票否决汇总', () => {
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: true, runningCount: 1 })), 'live');
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: true, pendingCount: 1 })), 'live');
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: true, runningCount: 1, pendingCount: 1 })), 'live');
});

test('模式判定：整轮已结束时即使未收尾也汇总（其后不会再有 text）', () => {
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: false, ongoing: false })), 'summary');
});

test('模式判定：整轮已结束时残留未完成步骤同样汇总（轮次终态是权威）', () => {
  assert.equal(resolveProcessSegmentMode(modeFacts({ closed: true, ongoing: false, runningCount: 3 })), 'summary');
  assert.equal(resolveProcessSegmentMode(modeFacts({ ongoing: false, pendingCount: 1 })), 'summary');
});

test('模式判定是纯函数：相同输入恒等，且不修改入参', () => {
  const input = modeFacts({ closed: true });
  const snapshot = { ...input };
  assert.equal(resolveProcessSegmentMode(input), resolveProcessSegmentMode(input));
  assert.deepEqual(input, snapshot);
});

