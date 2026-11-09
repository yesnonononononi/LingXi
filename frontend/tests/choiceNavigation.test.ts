import test from 'node:test';
import assert from 'node:assert/strict';
import {firstUnansweredIndex, nextUnansweredIndex, resolveActiveChoiceId} from '../src/utils/choiceNavigation';

/**
 * 多题选择卡的顺序状态机。
 *
 * <p>这组用例锁的是「用户会漏答」这一条线：落点必须是第一道未答的题，
 * 进位必须是后面第一道未答的题，两个方向都不许跳过前面没答的题。</p>
 */

test('默认落点：跳过前面已答的题，落在第一道未答的题上', () => {
  assert.equal(firstUnansweredIndex([true, true, false, false]), 2);
  assert.equal(firstUnansweredIndex([true, false, true, false]), 1);
});

test('默认落点：一题都没答时就是第一题，不能跳到最后一题', () => {
  assert.equal(firstUnansweredIndex([false, false, false, false]), 0);
});

test('默认落点：全部答完时回到第一题供回看，空组返回 -1', () => {
  assert.equal(firstUnansweredIndex([true, true, true]), 0);
  assert.equal(firstUnansweredIndex([]), -1);
});

test('进位：答完当前题去后面第一道未答的题', () => {
  assert.equal(nextUnansweredIndex([true, false, false, false], 0), 1);
  assert.equal(nextUnansweredIndex([true, true, true, false], 2), 3);
});

test('进位：跳过后面已答的题，但不回绕到前面', () => {
  assert.equal(nextUnansweredIndex([true, true, false, true, false], 2), 4);
  assert.equal(nextUnansweredIndex([false, true, true], 0), -1, '后面都答过时不回绕到第 1 题');
});

test('进位：末题不动，全部答完不动', () => {
  assert.equal(nextUnansweredIndex([false, false, false], 2), -1);
  assert.equal(nextUnansweredIndex([true, true, true], 0), -1);
  assert.equal(nextUnansweredIndex([], 0), -1);
});

test('进位：当前下标非法时从头找第一道未答的题', () => {
  assert.equal(nextUnansweredIndex([true, false, false], -1), 1);
  assert.equal(nextUnansweredIndex([false, false], Number.NaN), 0);
  assert.equal(nextUnansweredIndex([true, false, false], 1.5), 1);
});

test('并发乱序到达：后题先到占住焦点后，首道未决题补齐时必须归位到第一道未决题', () => {
  const onlySecond = [{ id: 'q2', answered: false }];
  const activeAfterSecond = resolveActiveChoiceId(onlySecond, '', false);
  assert.equal(activeAfterSecond, 'q2');

  const fullBatch = [
    { id: 'q1', answered: false },
    { id: 'q2', answered: false },
    { id: 'q3', answered: false },
  ];
  assert.equal(resolveActiveChoiceId(fullBatch, activeAfterSecond, false), 'q1');
});

test('状态推进与手动翻页：当前题变为已决时自动推进到首道未决题，手动翻页和自定义输入中保持原位', () => {
  assert.equal(
    resolveActiveChoiceId([
      { id: 'q1', answered: true, completed: true },
      { id: 'q2', answered: false, completed: false },
    ], 'q1', true),
    'q2',
    '当前停留题变为已决且仍有未决题时，必须推进到第一道未决题'
  );
  assert.equal(
    resolveActiveChoiceId([
      { id: 'q1', answered: false, completed: false },
      { id: 'q2', answered: false, completed: false },
    ], 'q2', true),
    'q2',
    '用户主动翻到后面的未决题时，保持用户停留位'
  );
  assert.equal(
    resolveActiveChoiceId([
      { id: 'q1', answered: true, completed: false, editingCustom: true },
      { id: 'q2', answered: false, completed: false },
    ], 'q1', false),
    'q1',
    '自定义输入过程中即使已产生非空草稿也不得跳题'
  );
});
