import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {THINKING_FRAME_INTERVAL, THINKING_MAX_LAG, ThinkingTextScheduler} from '../src/utils/thinkingTextScheduler';

test('突发文本分帧推进，积压越大越快，240ms 内追上而不改写原文', () => {
  const state = new ThinkingTextScheduler();
  const text = '传输方式可以再优化。'.repeat(70);
  state.receive(text, true, 0);
  assert.equal(state.content, '');
  state.advance(16);
  assert.equal(state.content, '');
  const sizes: number[] = [];
  for (let now = 32; now <= 256; now += 32) {
    const previous = state.content.length;
    state.advance(now);
    if (state.content.length > previous) sizes.push(state.content.length - previous);
  }
  assert.equal(state.content, text);
  assert.ok(sizes.length >= 5);
  assert.ok(Math.max(...sizes) < text.length / 3);
  const small = new ThinkingTextScheduler();
  const large = new ThinkingTextScheduler();
  small.receive('字'.repeat(20), true, 0);
  large.receive('字'.repeat(900), true, 0);
  small.advance(32); large.advance(32);
  assert.ok(large.content.length > small.content.length * 10);
});

test('新 Token 不得延后已积压片段的期限，主线程停顿后立即追上到期文字', () => {
  const state = new ThinkingTextScheduler();
  state.receive('旧'.repeat(100), true, 0);
  for (let now = 32; now <= 256; now += 32) {
    state.receive('旧'.repeat(100) + '新'.repeat(now / 32), true, now);
    state.advance(now);
  }
  assert.ok(state.content.startsWith('旧'.repeat(100)));
  state.advance(1000);
  assert.equal(state.content, '旧'.repeat(100) + '新'.repeat(8));
});

test('历史静态直出，终态、挂起、减少动态效果、重试和全文替换不留下旧积压', () => {
  const state = new ThinkingTextScheduler('历史', 0);
  state.receive('历史', true, 10);
  assert.equal(state.pending, false);
  for (const label of ['完成', '取消', '失败', '挂起', '减少动态效果']) {
    const text = state.content + label.repeat(30);
    state.receive(text, true, 20);
    assert.equal(state.pending, true);
    state.receive(text, false, 21);
    assert.equal(state.pending, false);
    assert.equal(state.content, text);
    state.receive(text, true, 22);
    assert.equal(state.pending, false);
  }
  state.receive(state.content + '未展示', true, 30);
  state.receive('重试响应', true, 31);
  assert.equal(state.content, '重试响应');
  assert.equal(state.pending, false);
  state.receive('重试响应继续', true, 32);
  state.dispose();
  assert.equal(state.pending, false);
  assert.equal(state.advance(1000), false);
});

test('展示游标不拆开 emoji 组合、变音字符和中文', () => {
  const text = '你好👩🏽‍💻e\u0301🙂'.repeat(20);
  const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text), part => part.index));
  boundaries.add(text.length);
  const state = new ThinkingTextScheduler();
  state.receive(text, true, 0);
  for (let now = 32; now <= 256; now += 32) {
    state.advance(now);
    assert.ok(boundaries.has(state.content.length));
  }
  assert.equal(state.content, text);
});

test('真实 2893 次 thinking 到达时序回放：减少突发峰值，有界追赶且限制解析频率', () => {
  const trace = JSON.parse(fs.readFileSync(new URL('./fixtures/thinkingArrivalTrace.json', import.meta.url), 'utf8')) as {
    total: number; events: [number, number][];
  };
  assert.equal(trace.events.length, 2893);
  const state = new ThinkingTextScheduler();
  let cursor = 0;
  let received = '';
  let shown = 0;
  let direct = 0;
  let maxDirect = 0;
  let maxScheduled = 0;
  let maximumLag = 0;
  let commits = 0;
  const waiting: {end: number; arrived: number}[] = [];
  const finalTime = trace.events.at(-1)![0] + THINKING_MAX_LAG + 64;
  for (let now = 0; now <= finalTime; now += 1000 / 60) {
    while (cursor < trace.events.length && trace.events[cursor]![0] <= now) {
      const [arrived, size] = trace.events[cursor++]!;
      received += '字'.repeat(size);
      state.receive(received, true, arrived);
      waiting.push({end: received.length, arrived});
    }
    maxDirect = Math.max(maxDirect, received.length - direct);
    direct = received.length;
    if (state.advance(now)) {
      maxScheduled = Math.max(maxScheduled, state.content.length - shown);
      shown = state.content.length;
      commits++;
      while (waiting.length && waiting[0]!.end <= shown) {
        maximumLag = Math.max(maximumLag, now - waiting.shift()!.arrived);
      }
    }
  }
  assert.equal(received.length, trace.total);
  assert.equal(state.content, received);
  assert.equal(waiting.length, 0);
  assert.ok(maxScheduled < maxDirect * 0.65, `突发峰值应下降: direct=${maxDirect}, scheduled=${maxScheduled}`);
  assert.ok(maximumLag <= THINKING_MAX_LAG + THINKING_FRAME_INTERVAL + 17, `积压不应失控: lag=${maximumLag}`);
  assert.ok(commits <= finalTime / THINKING_FRAME_INTERVAL);
});
