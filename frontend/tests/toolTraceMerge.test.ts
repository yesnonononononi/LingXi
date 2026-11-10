import test from 'node:test';
import assert from 'node:assert/strict';

import {writeToolTrace} from '../src/views/chat/turnRenderState';
import type {ChatMessage, ToolCallTrace} from '../src/types/chat';

/**
 * 工具轨迹合并：**缺失字段不得抹掉已有值**。
 *
 * <p>这条守的是一次真实故障：工具收尾时 `TOOL_COMPLETED` 事件先带着 `fileEdit` 行号写入轨迹，
 * 紧随其后的 `BLOCK_UPSERT` 单块帧当时不带行号 —— `{...incoming}` 里那些键的值是 `undefined`
 * 但键确实存在，`Object.assign` 直接把它赋进 previous，行号被抹成空，diff 左侧行号列整列消失，
 * 直到整轮视图重投影才恢复。</p>
 *
 * <p>所以这里断言的不是「渲染成什么样」，而是「状态里不能丢」：只要来源更晚的帧没带这个字段，
 * 旧值就必须留着。</p>
 */
function bubble(): ChatMessage {
  return {id: 'b1', role: 'assistant', content: '', timestamp: 0, isComplete: false,
    isThinking: false, isExploring: false, isSuspended: false,
    thoughtSteps: [], toolCalls: [], aiMessages: []} as ChatMessage;
}

/**
 * 构造一条轨迹。**关键点**：`toToolTrace` 对缺失字段返回的是「键存在、值为 undefined」，
 * 所以这里的 `explicitUndefined` 必须真的把这些键写出来 —— 用 `{...patch}` 不写键，
 * 就等于测了一条现实里不存在的路径（我第一版就写错，反证时测试全绿才发现）。
 */
function trace(patch: Partial<ToolCallTrace>, explicitUndefined = false): ToolCallTrace {
  const base = {id: 'call-1', toolName: 'edit_file', category: 'edit', status: 'calling', order: 0,
    responseId: '900'};
  const blanks = explicitUndefined
    ? {oldStartLine: undefined, oldEndLine: undefined, newStartLine: undefined, newEndLine: undefined,
      recordId: undefined, executionId: undefined}
    : {};
  return {...base, ...blanks, ...patch} as ToolCallTrace;
}

const full = trace({
  status: 'success',
  oldStartLine: 12, oldEndLine: 14, newStartLine: 12, newEndLine: 17,
  recordId: 'r-1', executionId: '900',
  plusLines: 5, minusLines: 2
});

test('writeToolTrace：后续帧缺行号时不会把已拿到的行号抹成空', () => {
  const message = bubble();
  writeToolTrace(message, {...full});
  // 单块增量帧：带版本（因此能穿过版本闸门）、行号键存在但值为 undefined ——
  // 这正是 toToolTrace 对 null 字段的产出形状，也是当初把行号抹掉的那一帧。
  writeToolTrace(message, trace({status: 'success', version: 3}, true));

  const merged = message.turnState!.tools['call-1']!;
  assert.equal(merged.oldStartLine, 12);
  assert.equal(merged.oldEndLine, 14);
  assert.equal(merged.newStartLine, 12);
  assert.equal(merged.newEndLine, 17);
  assert.equal(merged.recordId, 'r-1');
  assert.equal(merged.executionId, '900');
  assert.equal(merged.plusLines, 5);
  assert.equal(merged.minusLines, 2);
});

test('writeToolTrace：新帧带来行号时照常覆盖旧值', () => {
  const message = bubble();
  writeToolTrace(message, {...full});
  writeToolTrace(message, trace({status: 'success', version: 4, oldStartLine: 20, newStartLine: 21,
    recordId: 'r-2', executionId: '901'}));

  const merged = message.turnState!.tools['call-1']!;
  assert.equal(merged.oldStartLine, 20);
  assert.equal(merged.newStartLine, 21);
  assert.equal(merged.recordId, 'r-2');
  assert.equal(merged.executionId, '901');
});

test('writeToolTrace：更早的版本不会覆盖更新的持久化结果', () => {
  const message = bubble();
  writeToolTrace(message, trace({status: 'success', version: 5, oldStartLine: 3}));
  writeToolTrace(message, trace({status: 'calling', version: 5, oldStartLine: 99}));

  assert.equal(message.turnState!.tools['call-1']!.oldStartLine, 3);
  assert.equal(message.turnState!.tools['call-1']!.status, 'success');
});
