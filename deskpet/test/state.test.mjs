import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PetState,
  ACTION,
  FACE,
  DEFAULT_SLEEP_AFTER_MS,
  DEFAULT_STREAK_WINDOW_MS,
  DEFAULT_ANGRY_AFTER_TAPS,
} from '../src/state.mjs';

/** 可控时钟：时间相关行为必须完全确定，不能靠真实等待。 */
function makeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function newPet(options = {}) {
  const clock = makeClock();
  const pet = new PetState({ now: clock.now, ...options });
  return { pet, clock };
}

test('初始状态是待机 + 常态表情', () => {
  const { pet } = newPet();
  assert.equal(pet.action, ACTION.IDLE);
  assert.equal(pet.face, FACE.NORMAL);
  assert.equal(pet.tapStreak, 0);
  assert.equal(pet.snapshot.sleeping, false);
});

test('点一下变开心，连点计数累加', () => {
  const { pet, clock } = newPet();

  const first = pet.tap();
  assert.equal(first.face, FACE.HAPPY);
  assert.equal(first.tapStreak, 1);

  clock.advance(300);
  const second = pet.tap();
  assert.equal(second.face, FACE.HAPPY);
  assert.equal(second.tapStreak, 2);
});

test('连点到阈值就生气', () => {
  const { pet, clock } = newPet();

  for (let i = 0; i < DEFAULT_ANGRY_AFTER_TAPS - 1; i += 1) {
    pet.tap();
    clock.advance(200);
  }
  const angry = pet.tap();
  assert.equal(angry.face, FACE.ANGRY);
  assert.equal(angry.tapStreak, DEFAULT_ANGRY_AFTER_TAPS);

  // 继续点还是生气，不会突然又开心
  clock.advance(200);
  assert.equal(pet.tap().face, FACE.ANGRY);
});

test('连点间隔超过窗口则重新计数', () => {
  const { pet, clock } = newPet();

  pet.tap();
  pet.tap();
  clock.advance(DEFAULT_STREAK_WINDOW_MS + 1);

  const snapshot = pet.tap();
  assert.equal(snapshot.tapStreak, 1, '超时后应从 1 重新数');
  assert.equal(snapshot.face, FACE.HAPPY, '重新计数后不该直接翻脸');
});

test('久无互动会睡着', () => {
  const { pet, clock } = newPet();

  clock.advance(DEFAULT_SLEEP_AFTER_MS - 1);
  assert.equal(pet.tick().action, ACTION.IDLE);

  clock.advance(1);
  const sleeping = pet.tick();
  assert.equal(sleeping.action, ACTION.SLEEP);
  assert.equal(sleeping.face, FACE.SLEEPY);
  assert.equal(sleeping.sleeping, true);
});

test('睡着时点击是惊醒，不累计连点', () => {
  const { pet, clock } = newPet();
  clock.advance(DEFAULT_SLEEP_AFTER_MS);
  pet.tick();

  const woke = pet.tap();
  assert.equal(woke.action, ACTION.IDLE);
  assert.equal(woke.face, FACE.EXCITED);
  assert.equal(woke.tapStreak, 0, '惊醒这一下不能算作连点，否则第二下就翻脸');

  const second = pet.tap();
  assert.equal(second.tapStreak, 1);
  assert.equal(second.face, FACE.HAPPY);
});

test('拖起来是害羞，放下回到常态', () => {
  const { pet } = newPet();

  const dragging = pet.dragStart();
  assert.equal(dragging.action, ACTION.DRAG);
  assert.equal(dragging.face, FACE.SHY);

  const dropped = pet.dragEnd();
  assert.equal(dropped.action, ACTION.IDLE);
  assert.equal(dropped.face, FACE.NORMAL);
  assert.equal(dropped.tapStreak, 0);
});

test('被拖动期间不会睡着', () => {
  const { pet, clock } = newPet();
  pet.dragStart();

  clock.advance(DEFAULT_SLEEP_AFTER_MS * 3);
  const snapshot = pet.tick();
  assert.equal(snapshot.action, ACTION.DRAG, '用户正拎着它，状态不该自己跳走');
  assert.equal(snapshot.face, FACE.SHY, '拖动期间表情也不该被心跳冲掉');
});

test('表情在连点窗口结束后回落到常态', () => {
  const { pet, clock } = newPet();
  pet.tap();
  assert.equal(pet.face, FACE.HAPPY);

  clock.advance(DEFAULT_STREAK_WINDOW_MS + 1);
  const snapshot = pet.tick();
  assert.equal(snapshot.face, FACE.NORMAL);
});

test('睡着后 tick 保持睡眠状态，不会被重复唤醒', () => {
  const { pet, clock } = newPet();
  clock.advance(DEFAULT_SLEEP_AFTER_MS);
  pet.tick();

  clock.advance(5_000);
  const snapshot = pet.tick();
  assert.equal(snapshot.action, ACTION.SLEEP);
  assert.equal(snapshot.face, FACE.SLEEPY);
});

test('拖动会重置连点，避免拖完放下一碰就发火', () => {
  const { pet, clock } = newPet();
  pet.tap();
  pet.tap();
  clock.advance(100);

  pet.dragStart();
  pet.dragEnd();

  assert.equal(pet.tapStreak, 0);
  assert.equal(pet.tap().face, FACE.HAPPY);
});

test('snapshot 是只读快照，外部改不动内部状态', () => {
  const { pet } = newPet();
  const snapshot = pet.tap();
  assert.throws(() => {
    'use strict';
    snapshot.face = 'hacked';
  });
  assert.equal(pet.face, FACE.HAPPY);
});

test('自定义阈值生效（睡眠时长可配）', () => {
  const clock = makeClock();
  const pet = new PetState({ now: clock.now, sleepAfterMs: 1_000 });

  clock.advance(1_000);
  assert.equal(pet.tick().action, ACTION.SLEEP);
});
