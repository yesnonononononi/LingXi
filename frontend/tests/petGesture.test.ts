/**
 * 手势层单测（纯逻辑，不碰 DOM）。
 *
 * <p>钉住的是 D-B1 / D-B4 的根因契约：**"点击"与"拖拽"由阈值分离**，
 * 且四条收尾路径（pointerup / pointercancel / lostpointercapture / move 时 buttons===0）
 * 都不可能把状态留在 `drag`。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAG_THRESHOLD_PX,
  PressDragGesture,
  type GestureIntent,
} from '../src/pet/gesture/press-drag';

/** 取意图类型序列（断言"恰好一次 tap"这类契约最直观）。 */
function typesOf(intents: readonly GestureIntent[]): string[] {
  return intents.map((intent) => intent.type);
}

test('手势：阈值常量是 4px（手感真源，只此一处）', () => {
  assert.equal(DRAG_THRESHOLD_PX, 4);
  assert.equal(new PressDragGesture().thresholdPx, 4);
});

test('手势：按下不产生意图（按下本身既不是 tap 也不是 drag）', () => {
  const gesture = new PressDragGesture();
  assert.deepEqual(gesture.press({ pointerId: 1, x: 100, y: 100 }), []);
  assert.equal(gesture.phase, 'pressed');
  assert.equal(gesture.isDragging, false);
});

test('手势：按下后原地松开 → 恰好一次 tap（D-B1 的唯一来源）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  const intents = gesture.release(1);
  assert.deepEqual(typesOf(intents), ['tap']);
  assert.equal((intents[0] as { pointerId: number }).pointerId, 1);
  assert.equal(gesture.phase, 'idle', '收尾后必须回到 idle');
});

test('手势：阈值内的抖动仍是 tap，不产生 drag-start（窗口不再抖）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  // 3px 之内：一次 drag-start 都不许产生
  assert.deepEqual(gesture.move({ pointerId: 1, x: 102, y: 100, buttons: 1 }), []);
  assert.deepEqual(gesture.move({ pointerId: 1, x: 102, y: 102, buttons: 1 }), []);
  assert.equal(gesture.isDragging, false);
  assert.deepEqual(typesOf(gesture.release(1)), ['tap']);
});

test('手势：恰好达到阈值即算拖拽（>= 边界，用字面量 4 钉死）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  const intents = gesture.move({ pointerId: 1, x: 104, y: 100, buttons: 1 });
  assert.deepEqual(typesOf(intents), ['drag-start']);
  assert.equal(gesture.isDragging, true);
});

test('手势：3.9px 仍不是拖拽（阈值是硬边界，不是"约等于"）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  assert.deepEqual(gesture.move({ pointerId: 1, x: 103.9, y: 100, buttons: 1 }), []);
  assert.equal(gesture.isDragging, false);
});

test('手势：越过阈值后持续产出 drag-move，松手产出 drag-end（不再产出 tap）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  assert.deepEqual(typesOf(gesture.move({ pointerId: 1, x: 120, y: 100, buttons: 1 })), ['drag-start']);
  assert.deepEqual(typesOf(gesture.move({ pointerId: 1, x: 140, y: 130, buttons: 1 })), ['drag-move']);
  // 同一坐标重复上报被丢弃（省 IPC）
  assert.deepEqual(gesture.move({ pointerId: 1, x: 140, y: 130, buttons: 1 }), []);
  const end = gesture.release(1);
  assert.deepEqual(typesOf(end), ['drag-end']);
  assert.equal(gesture.phase, 'idle');
});

test('手势：收尾路径一 —— pointerup（标准路径）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 7, x: 0, y: 0 });
  gesture.move({ pointerId: 7, x: 30, y: 0, buttons: 1 });
  assert.deepEqual(typesOf(gesture.release(7)), ['drag-end']);
  assert.equal(gesture.isDragging, false);
});

test('手势：收尾路径二 —— pointercancel（已拖拽时必须产 drag-end）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 7, x: 0, y: 0 });
  gesture.move({ pointerId: 7, x: 30, y: 0, buttons: 1 });
  assert.deepEqual(typesOf(gesture.cancel(7)), ['drag-end']);
  assert.equal(gesture.phase, 'idle');
});

test('手势：收尾路径三 —— lostpointercapture（未拖拽时取消 = 不产出 tap）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 7, x: 0, y: 0 });
  assert.deepEqual(gesture.cancel(7), [], '取消不是点击，不许白送一次 tap');
  assert.equal(gesture.phase, 'idle');
});

test('手势：收尾路径四 —— move 时 buttons===0（在窗口外松手的兜底）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 7, x: 0, y: 0 });
  gesture.move({ pointerId: 7, x: 30, y: 0, buttons: 1 });
  // 没有 pointerup，直接来了一个 buttons=0 的移动
  assert.deepEqual(typesOf(gesture.move({ pointerId: 7, x: 40, y: 0, buttons: 0 })), ['drag-end']);
  assert.equal(gesture.phase, 'idle');
});

test('手势：未越阈值就 buttons===0 → 算一次 tap（点完手滑一下也是点击）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 7, x: 0, y: 0 });
  assert.deepEqual(typesOf(gesture.move({ pointerId: 7, x: 1, y: 1, buttons: 0 })), ['tap']);
  assert.equal(gesture.phase, 'idle');
});

test('手势：D-B4 验收 —— 20 次"点一下立即松开"全部是 tap 且从不停在 drag', () => {
  const gesture = new PressDragGesture();
  let taps = 0;
  for (let index = 0; index < 20; index += 1) {
    gesture.press({ pointerId: 1, x: 100, y: 100 });
    // 真实场景里总会带 1~2px 微动，这里刻意带上，验证它不会变成拖拽
    gesture.move({ pointerId: 1, x: 101, y: 101, buttons: 1 });
    const intents = gesture.release(1);
    assert.deepEqual(typesOf(intents), ['tap'], `第 ${index + 1} 次点击必须是 tap`);
    assert.equal(gesture.phase, 'idle', `第 ${index + 1} 次点击后不得停在 drag`);
    taps += intents.length;
  }
  assert.equal(taps, 20);
});

test('手势：多指场景只认最先按下的那根（第二根手指的 up 不会误收尾）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 100, y: 100 });
  assert.deepEqual(gesture.press({ pointerId: 2, x: 10, y: 10 }), [], '第二根手指不改变手势');
  assert.equal(gesture.activePointerId, 1);
  assert.deepEqual(gesture.move({ pointerId: 2, x: 200, y: 200, buttons: 1 }), []);
  assert.deepEqual(gesture.release(2), [], '别的指针 id 不触发收尾');
  assert.equal(gesture.isPressed, true, '第一根手指的手势还在进行');
  assert.deepEqual(typesOf(gesture.release(1)), ['tap']);
});

test('手势：脏坐标（NaN / Infinity）不推进状态', () => {
  const gesture = new PressDragGesture();
  assert.deepEqual(gesture.press({ pointerId: 1, x: Number.NaN, y: 0 }), []);
  assert.equal(gesture.phase, 'idle');
  gesture.press({ pointerId: 1, x: 0, y: 0 });
  assert.deepEqual(gesture.move({ pointerId: 1, x: Number.POSITIVE_INFINITY, y: 0, buttons: 1 }), []);
  assert.equal(gesture.isDragging, false);
});

test('手势：idle 状态下的移动与松手都是空操作（幂等）', () => {
  const gesture = new PressDragGesture();
  assert.deepEqual(gesture.move({ pointerId: 1, x: 50, y: 50, buttons: 1 }), []);
  assert.deepEqual(gesture.release(1), []);
  assert.deepEqual(gesture.cancel(1), []);
  assert.equal(gesture.phase, 'idle');
});

test('手势：重复 release / cancel 不会重复产出意图', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 0, y: 0 });
  assert.deepEqual(typesOf(gesture.release(1)), ['tap']);
  assert.deepEqual(gesture.release(1), []);
  assert.deepEqual(gesture.cancel(1), []);
});

test('手势：reset() 强制回到空闲（页面卸载时杜绝残留 drag）', () => {
  const gesture = new PressDragGesture();
  gesture.press({ pointerId: 1, x: 0, y: 0 });
  gesture.move({ pointerId: 1, x: 50, y: 0, buttons: 1 });
  gesture.reset();
  assert.equal(gesture.phase, 'idle');
  assert.equal(gesture.activePointerId, null);
  assert.deepEqual(gesture.release(1), []);
});

test('手势：阈值可注入，非法值回落到常量（防止手感被调用点改写）', () => {
  assert.equal(new PressDragGesture({ thresholdPx: 10 }).thresholdPx, 10);
  assert.equal(new PressDragGesture({ thresholdPx: 0 }).thresholdPx, DRAG_THRESHOLD_PX);
  assert.equal(new PressDragGesture({ thresholdPx: Number.NaN }).thresholdPx, DRAG_THRESHOLD_PX);
});
