import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_ARRIVAL_GRAPHEMES, MAX_ARRIVAL_RANGES, TEXT_ARRIVAL_DURATION, ProgressiveFadeState} from '../src/utils/progressiveFade';

test('中文和英文增量立即拥有独立动画，旧片段身份和时刻保持不变', () => {
  for (const chunks of [['你好', '，世界', '。'], ['Hel', 'lo,', '!']]) {
    const state = new ProgressiveFadeState();
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
  const state = new ProgressiveFadeState();
  state.update('历史', true, 0);
  assert.deepEqual(state.ranges, []);
  state.update('历史新字', true, 20);
  assert.equal(state.ranges[0]!.start, 2);
  const live = new ProgressiveFadeState();
  live.update('首批', true, 0, true);
  assert.equal(live.ranges.length, 1);
});

test('Markdown 去除未闭合标记时保留旧字进度，只显现新增部分', () => {
  const state = new ProgressiveFadeState();
  state.update('', true, 0);
  state.update('你好 **世界', true, 10);
  const times = new Map(state.ranges.map(range => [range.id, range.started]));
  state.update('你好 世界', true, 30);
  assert.deepEqual(state.ranges.map(range => [range.start, range.end]), [[0, 3], [3, 4], [4, 5]]);
  assert.ok(state.ranges.every(range => times.get(range.id) === range.started));
  state.update('你好 世界！', true, 50);
  assert.equal(state.ranges.at(-1)!.started, 50);
  assert.equal(state.ranges.at(-1)!.start, 5);
});

test('高频到达不排队，480ms 后区间被回收，停止/失败/减少动态效果立即清理', () => {
  const state = new ProgressiveFadeState();
  state.update('', true, 0);
  for (let index = 1; index <= 1000; index++) state.update('字'.repeat(index), true, index);
  assert.equal(TEXT_ARRIVAL_DURATION, 480);
  assert.equal(state.ranges.length, MAX_ARRIVAL_RANGES);
  state.expire(1480);
  assert.deepEqual(state.ranges, []);
  state.update('字'.repeat(1001), true, 1500);
  assert.equal(state.ranges.length, 1);
  state.update('字'.repeat(1001), false, 1501);
  assert.deepEqual(state.ranges, []);
  state.update('字'.repeat(1002), true, 1510);
  state.clear();
  assert.deepEqual(state.ranges, []);
});

test('单次大包全文立即可见，只有有界尾迹分成短片段，头深尾浅且没有未来排队时间', () => {
  const state = new ProgressiveFadeState();
  const text = '传输方式可以再优化，新文字应当自然呈现，已有文字保持稳定。'.repeat(25);
  state.update('', true, 0);
  state.update(text, true, 500);
  assert.equal(state.ranges.length, 32);
  assert.equal(state.ranges[0]!.start, text.length - MAX_ARRIVAL_GRAPHEMES);
  assert.equal(state.ranges.at(-1)!.end, text.length);
  assert.equal(state.ranges.at(-1)!.started, 500);
  assert.ok(state.ranges[0]!.started < 200);
  assert.ok(state.ranges.every((range, index, ranges) => range.started <= 500
    && range.end - range.start <= 3 && (!index || ranges[index - 1]!.started < range.started)));
});

test('分片不拆断 emoji 组合与变音字符；重试保留旧文，后续增量继续淡入', () => {
  const state = new ProgressiveFadeState();
  const text = '中文👩🏽‍💻e\u0301🙂'.repeat(25);
  state.update('', true, 0);
  state.update(text, true, 10);
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index));
  boundaries.add(text.length);
  assert.ok(state.ranges.every(range => boundaries.has(range.start) && boundaries.has(range.end)));
  state.update(text, false, 20);
  state.update(text, true, 30);
  assert.deepEqual(state.ranges, []);
  state.update(text + '重试中', true, 40);
  assert.equal(state.ranges[0]!.start, text.length);
});

test('多处 Markdown 标记一起闭合或权威文本改写时，不重新显现已读文字', () => {
  const state = new ProgressiveFadeState();
  state.update('*旧字 **内容', true, 0);
  state.update('旧字 内容 新增', true, 20);
  assert.deepEqual(state.ranges, []);
  state.update('旧字 内容 新增 后续', true, 30);
  assert.deepEqual(state.ranges.map(range => [range.start, range.end]), [[8, 11]]);
});
