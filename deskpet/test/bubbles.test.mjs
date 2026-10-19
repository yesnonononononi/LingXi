import test from 'node:test';
import assert from 'node:assert/strict';

import { BUBBLES, pickBubble, BUBBLE_DURATION_MS } from '../src/bubbles.mjs';
import { FACES_IN_SVG } from '../src/pet.mjs';

test('每个会说话的表情都有台词，不会出现哑巴状态', () => {
  // 眨眼是无声动作，不该弹气泡；其余表情都必须有话说
  const silent = ['blink'];
  for (const face of FACES_IN_SVG) {
    if (silent.includes(face)) {
      assert.equal(BUBBLES[face], undefined, `${face} 是无声表情，不该有台词表`);
      continue;
    }
    assert.ok(Array.isArray(BUBBLES[face]), `表情 ${face} 没有台词`);
    assert.ok(BUBBLES[face].length > 0, `表情 ${face} 台词为空`);
    for (const line of BUBBLES[face]) {
      assert.equal(typeof line, 'string');
      assert.ok(line.trim().length > 0);
    }
  }
});


test('pickBubble 按注入的随机源选句', () => {
  assert.equal(pickBubble('happy', () => 0), BUBBLES.happy[0]);
  assert.equal(pickBubble('happy', (max) => max - 1), BUBBLES.happy[BUBBLES.happy.length - 1]);
});

test('随机源返回越界值时也不返回 undefined', () => {
  const pool = BUBBLES.normal;
  assert.equal(pickBubble('normal', () => pool.length), pool[0]);
  assert.equal(pickBubble('normal', () => -1), pool[pool.length - 1]);
  assert.equal(pickBubble('normal', () => pool.length * 3 + 1), pool[1]);
});

test('未知表情回落到常态台词，不抛异常', () => {
  const line = pickBubble('某个不存在的表情', () => 0);
  assert.equal(line, BUBBLES.normal[0]);
});

test('气泡展示时长在可读范围内', () => {
  assert.ok(BUBBLE_DURATION_MS >= 1_500 && BUBBLE_DURATION_MS <= 5_000);
});
