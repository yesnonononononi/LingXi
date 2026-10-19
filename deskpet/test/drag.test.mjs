import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAG_THRESHOLD_PX,
  CLICK_MAX_MS,
  shouldStartDrag,
  isClick,
  clampToWorkArea,
  resolveScaledPosition,
} from '../src/drag.mjs';

test('位移未达阈值不算拖动', () => {
  assert.equal(shouldStartDrag(0, 0), false);
  assert.equal(shouldStartDrag(1, 1), false);
  assert.equal(shouldStartDrag(DRAG_THRESHOLD_PX - 0.1, 0), false);
});

test('位移刚好到阈值就算拖动', () => {
  assert.equal(shouldStartDrag(DRAG_THRESHOLD_PX, 0), true);
  assert.equal(shouldStartDrag(0, -DRAG_THRESHOLD_PX), true);
});

test('斜向位移按欧氏距离判定，不是按单轴', () => {
  // 单轴都没到阈值，但合成距离已超过
  const dx = 4;
  const dy = 4;
  assert.ok(dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX);
  assert.equal(shouldStartDrag(dx, dy), true);
});

test('短时间小位移算点击', () => {
  assert.equal(isClick(120, 0, 0), true);
  assert.equal(isClick(CLICK_MAX_MS, 2, 2), true);
});

test('长按不算点击', () => {
  assert.equal(isClick(CLICK_MAX_MS + 1, 0, 0), false);
});

test('拖过之后抬起不算点击', () => {
  assert.equal(isClick(100, DRAG_THRESHOLD_PX + 5, 0), false);
});

test('窗口在工作区内时位置原样保留（仅取整）', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 220, height: 300 };
  assert.deepEqual(clampToWorkArea({ x: 500, y: 400 }, size, workArea), { x: 500, y: 400 });
  assert.deepEqual(clampToWorkArea({ x: 500.4, y: 400.6 }, size, workArea), { x: 500, y: 401 });
});

test('越界时被拉回工作区边界', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 220, height: 300 };

  assert.deepEqual(clampToWorkArea({ x: -50, y: -50 }, size, workArea), { x: 0, y: 0 });
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000 }, size, workArea), {
    x: 1920 - 220,
    y: 1040 - 300,
  });
});

test('副屏负坐标工作区同样处理正确', () => {
  const workArea = { x: -1920, y: -200, width: 1920, height: 1080 };
  const size = { width: 220, height: 300 };

  assert.deepEqual(clampToWorkArea({ x: -3000, y: -900 }, size, workArea), { x: -1920, y: -200 });
  // y=0 落在 [-200, 880] 内，只把 x 拉回右边界
  assert.deepEqual(clampToWorkArea({ x: 0, y: 0 }, size, workArea), { x: -220, y: 0 });
});

test('窗口比工作区还大时贴住左上角，不产生越界值', () => {
  const workArea = { x: 0, y: 0, width: 200, height: 200 };
  const size = { width: 400, height: 500 };
  assert.deepEqual(clampToWorkArea({ x: 50, y: 50 }, size, workArea), { x: 0, y: 0 });
});

test('缩放以底部中心为锚点，脚不走位', () => {
  const topLeft = { x: 100, y: 200 };
  const currentSize = { width: 220, height: 300 };
  const nextSize = { width: 275, height: 375 };

  const next = resolveScaledPosition(topLeft, currentSize, nextSize);

  // 底边保持不动（取整最多带来 1px 误差）
  assert.ok(Math.abs(next.y + nextSize.height - (topLeft.y + currentSize.height)) <= 1);
  // 水平中心保持不动
  assert.ok(
    Math.abs(next.x + nextSize.width / 2 - (topLeft.x + currentSize.width / 2)) <= 1,
  );
});

