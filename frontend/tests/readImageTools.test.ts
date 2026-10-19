import test from 'node:test';
import assert from 'node:assert/strict';
import { groupReadImageTools, resolveReadToolImages } from '../src/utils/readImageTools';
import { AgentToolName } from '../src/utils/toolNames';
import type { ProcessTimelineItem, ToolCallTrace } from '../src/types/chat';

const receipt = JSON.stringify({ ok: true, images: [{ imageId: '0123456789abcdef', ext: 'png', path: 'images/first.png' }] });
const tool: ToolCallTrace = { id: '1', toolName: AgentToolName.ReadImage, status: 'success', result: receipt };
const item = (id: string, call = tool): ProcessTimelineItem => ({ id, type: 'tool', order: Number(id), tool: { ...call, id } });

test('实时回执与历史信封读取相同的权威缓存标识', () => {
  assert.deepEqual(resolveReadToolImages(tool), [{ key: '1-0', imageId: '0123456789abcdef', ext: 'png', path: 'images/first.png' }]);
  assert.deepEqual(resolveReadToolImages({ ...tool, result: JSON.stringify({ outcome: 'SUCCESS', output: receipt }) }), resolveReadToolImages(tool));
});

test('相邻读图汇成两张缩略图，不改变原时间线或跨越其他项', () => {
  const thought: ProcessTimelineItem = { id: 'thought', type: 'thought', order: 3 };
  const source = [item('1'), item('2'), thought, item('4')];
  const grouped = groupReadImageTools(source, '1234567890123456789');
  assert.deepEqual(grouped.map(entry => [entry.id, entry.images?.length]), [['1', 2], ['thought', undefined], ['4', 1]]);
  assert.deepEqual(grouped[0]!.images!.map(image => image.key), ['1-0', '2-0']);
  assert.equal(source.length, 4);
  assert.equal(groupReadImageTools(source).length, 4);
  assert.equal(groupReadImageTools(source, '../42').length, 4);
});

test('失败、未完成、错误回执和非读图工具不能显示成已查看', () => {
  for (const status of ['failed', 'calling', 'pending', 'unknown'] as const) {
    assert.deepEqual(resolveReadToolImages({ ...tool, status }), []);
    assert.equal(groupReadImageTools([item('1'), item('2', { ...tool, status }), item('3')], 42).length, 3);
  }
  assert.deepEqual(resolveReadToolImages({ ...tool, toolName: AgentToolName.ReadFile }), []);
  for (const result of ['{}', JSON.stringify({ ok: false, images: JSON.parse(receipt).images }),
    JSON.stringify({ ok: true, images: [{ imageId: '../outside', ext: 'png', path: 'image.png' }] }),
    JSON.stringify({ ok: true, images: [{ imageId: '0123456789abcdef', ext: 'svg', path: 'image.svg' }] })]) {
    assert.deepEqual(resolveReadToolImages({ ...tool, result }), []);
  }
});
