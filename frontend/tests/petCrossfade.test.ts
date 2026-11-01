/**
 * 表情交叉过渡（cross-fade）单测（tsx 执行，不碰 DOM）。
 *
 * <p>两条主线：</p>
 * <ol>
 *   <li><b>可配置</b>：时长被钳制在 80–120ms、脏值回落默认、缓动可换；</li>
 *   <li><b>不堆积</b>：连切时新过渡必须作废旧过渡，旧回调自查后放弃。</li>
 * </ol>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSSFADE_MAX_MS,
  CROSSFADE_MIN_MS,
  CrossfadePlanner,
  DEFAULT_CROSSFADE_EASING,
  DEFAULT_CROSSFADE_MS,
  resolveCrossfade,
} from '../src/pet/presentation/crossfade';

test('过渡：默认 100ms + 默认缓动，且落在 80–120ms 区间内', () => {
  const resolved = resolveCrossfade();
  assert.equal(resolved.durationMs, DEFAULT_CROSSFADE_MS);
  assert.equal(resolved.easing, DEFAULT_CROSSFADE_EASING);
  assert.ok(resolved.durationMs >= CROSSFADE_MIN_MS && resolved.durationMs <= CROSSFADE_MAX_MS);
  assert.equal(resolved.cssTransition, `${DEFAULT_CROSSFADE_MS}ms ${DEFAULT_CROSSFADE_EASING}`);
});

test('过渡：时长被钳制到 80–120ms（过短等于硬切、过长发钝）', () => {
  assert.equal(resolveCrossfade({ durationMs: 0 }).durationMs, CROSSFADE_MIN_MS);
  assert.equal(resolveCrossfade({ durationMs: 10 }).durationMs, CROSSFADE_MIN_MS);
  assert.equal(resolveCrossfade({ durationMs: 500 }).durationMs, CROSSFADE_MAX_MS);
  assert.equal(resolveCrossfade({ durationMs: 80 }).durationMs, 80);
  assert.equal(resolveCrossfade({ durationMs: 120 }).durationMs, 120);
  assert.equal(resolveCrossfade({ durationMs: 95 }).durationMs, 95);
});

test('过渡：非法时长回落默认值（NaN / Infinity / 非数字）', () => {
  assert.equal(resolveCrossfade({ durationMs: Number.NaN }).durationMs, DEFAULT_CROSSFADE_MS);
  // Infinity 属于脏值：不钳到上界，直接按"没给"处理，避免配置写错反而变成最慢的过渡
  assert.equal(resolveCrossfade({ durationMs: Number.POSITIVE_INFINITY }).durationMs, DEFAULT_CROSSFADE_MS);
  assert.equal(resolveCrossfade({ durationMs: '90' as unknown as number }).durationMs, DEFAULT_CROSSFADE_MS);
});

test('过渡：缓动可配置，空串/空白回落默认', () => {
  assert.equal(resolveCrossfade({ easing: 'linear' }).easing, 'linear');
  assert.equal(resolveCrossfade({ easing: '  ease-out  ' }).easing, 'ease-out');
  assert.equal(resolveCrossfade({ easing: '' }).easing, DEFAULT_CROSSFADE_EASING);
  assert.equal(resolveCrossfade({ easing: '   ' }).easing, DEFAULT_CROSSFADE_EASING);
});

test('过渡：连切时新过渡作废上一次（cancelledToken 指向旧令牌）', () => {
  const planner = new CrossfadePlanner();
  const first = planner.plan(0, 1);
  assert.equal(first.cancelledToken, null);
  assert.equal(planner.isTransitioning, true);

  const second = planner.plan(1, 0);
  // 第二次切换时第一段过渡还没收尾 → 必须被取消，否则旧回调会把旧帧重新点亮
  assert.equal(second.cancelledToken, first.token);
  assert.equal(planner.isCurrent(first.token), false);
  assert.equal(planner.isCurrent(second.token), true);
  assert.equal(planner.complete(first.token), false);
  assert.equal(planner.complete(second.token), true);
  assert.equal(planner.isTransitioning, false);
});

test('过渡：连续 10 次快速切换后只有最后一段在飞（不堆积）', () => {
  const planner = new CrossfadePlanner();
  let last = planner.plan(0, 1);
  for (let i = 0; i < 9; i += 1) {
    const from = (i % 2 === 0 ? 1 : 0) as 0 | 1;
    const to = (from === 0 ? 1 : 0) as 0 | 1;
    last = planner.plan(from, to);
  }
  assert.equal(planner.pendingToken, last.token);
  assert.equal(planner.isTransitioning, true);
  // 只有最后一次令牌有效：其余全部作废
  let alive = 0;
  for (let token = 1; token <= last.token; token += 1) {
    if (planner.isCurrent(token)) alive += 1;
  }
  assert.equal(alive, 1);
});

test('过渡：双缓冲互斥——来去下标必须不同且在 0/1 之内', () => {
  const planner = new CrossfadePlanner();
  assert.throws(() => planner.plan(0, 0), TypeError);
  assert.throws(() => planner.plan(1, 1), TypeError);
  assert.throws(() => planner.plan(0, 2 as unknown as 0 | 1), TypeError);
  assert.doesNotThrow(() => planner.plan(0, 1));
  assert.doesNotThrow(() => planner.plan(1, 0));
});

test('过渡：每段过渡都带上解析后的时长与缓动（调用方可直接写 CSS）', () => {
  const planner = new CrossfadePlanner();
  const plan = planner.plan(0, 1, { durationMs: 90, easing: 'ease-in' });
  assert.equal(plan.durationMs, 90);
  assert.equal(plan.easing, 'ease-in');
  assert.equal(plan.fromIndex, 0);
  assert.equal(plan.toIndex, 1);
});

test('过渡：cancel 后可重新开始，且新过渡不再报"取消旧的"', () => {
  const planner = new CrossfadePlanner();
  planner.plan(0, 1);
  planner.cancel();
  assert.equal(planner.isTransitioning, false);
  const next = planner.plan(1, 0);
  assert.equal(next.cancelledToken, null);
});
