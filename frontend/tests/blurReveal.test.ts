import test from 'node:test';
import assert from 'node:assert/strict';
import {BLUR_REVEAL_DURATION, BlurRevealState} from '../src/utils/blurReveal';

test('中文和英文增量立即拥有独立动画，旧片段身份和时刻保持不变', () => {
  for (const chunks of [['你好', '，世界', '。'], ['Hello', ', world', '!']]) {
    const state = new BlurRevealState();
    state.update('', true, 0);
    let text = '';
    chunks.forEach((chunk, index) => {
      text += chunk;
      state.update(text, true, index * 20);
      assert.equal(state.ranges.length, index + 1);
      assert.deepEqual(state.ranges[index], {
        id: index + 1, start: text.length - chunk.length, end: text.length, started: index * 20,
      });
      assert.equal(state.ranges[0]!.started, 0);
    });
  }
});

test('历史快照不播放，后续新增文字才播放；从空正文挂载的首批可显现', () => {
  const state = new BlurRevealState();
  state.update('历史', true, 0);
  assert.deepEqual(state.ranges, []);
  state.update('历史新字', true, 20);
  assert.equal(state.ranges[0]!.start, 2);
  const live = new BlurRevealState();
  live.update('首批', true, 0, true);
  assert.equal(live.ranges.length, 1);
});

test('Markdown 去除未闭合标记时保留旧字进度，只显现新增部分', () => {
  const state = new BlurRevealState();
  state.update('', true, 0);
  state.update('你好 **世界', true, 10);
  state.update('你好 世界', true, 30);
  assert.deepEqual(state.ranges.map(range => [range.start, range.end, range.started]), [[0, 3, 10], [3, 5, 10]]);
  state.update('你好 世界！', true, 50);
  assert.equal(state.ranges.at(-1)!.started, 50);
  assert.equal(state.ranges.at(-1)!.start, 5);
});

test('高频到达不排队，290ms 后区间被回收，停止/失败/减少动态效果立即清理', () => {
  const state = new BlurRevealState();
  state.update('', true, 0);
  for (let index = 1; index <= 1000; index++) state.update('字'.repeat(index), true, index);
  assert.equal(state.ranges.length, BLUR_REVEAL_DURATION);
  state.expire(1290);
  assert.deepEqual(state.ranges, []);
  state.update('字'.repeat(1001), true, 1300);
  assert.equal(state.ranges.length, 1);
  state.update('字'.repeat(1001), false, 1301);
  assert.deepEqual(state.ranges, []);
  state.update('字'.repeat(1002), true, 1310);
  state.clear();
  assert.deepEqual(state.ranges, []);
});

test('多处 Markdown 标记一起闭合或权威文本改写时，不重新显现已读文字', () => {
  const state = new BlurRevealState();
  state.update('*旧字 **内容', true, 0);
  state.update('旧字 内容 新增', true, 20);
  assert.deepEqual(state.ranges, []);
  state.update('旧字 内容 新增 后续', true, 30);
  assert.deepEqual(state.ranges.map(range => [range.start, range.end]), [[8, 11]]);
});
