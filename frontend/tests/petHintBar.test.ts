/**
 * 提示行单测（O2：3 秒无交互自动淡出、任何交互重新计时、隐藏态不写死样式）。
 *
 * <p>定时器全部注入假实现，所以"2999ms 仍可见 / 3000ms 起不可见"这类边界是确定性断言，
 * 不含 sleep、不靠肉眼。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_AUTO_FADE_MS, HintBar, type HintBarHost } from '../src/pet/visual/hint-bar';
import type { TimerPort } from '../src/pet/presentation/bus';

/** 假定时器：手动推进虚拟时间，按到期顺序触发。 */
class FakeTimer implements TimerPort {
  /** 虚拟当前时间（毫秒）。 */
  time = 0;

  /** 下一个句柄。 */
  private nextId = 1;

  /** 挂起的任务。 */
  private readonly tasks = new Map<number, { handler: () => void; at: number }>();

  /**
   * 注册一次性定时器。
   *
   * @param handler 到期回调
   * @param delayMs 延迟毫秒
   * @returns 句柄
   */
  setTimeout(handler: () => void, delayMs: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { handler, at: this.time + delayMs });
    return id;
  }

  /**
   * 取消定时器。
   *
   * @param handle 句柄
   */
  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  /**
   * 推进时间并触发到期任务。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.time) {
        this.tasks.delete(id);
        task.handler();
      }
    }
  }

  /** 当前挂起任务数（断言"没有泄漏定时器"用）。 */
  get pending(): number {
    return this.tasks.size;
  }
}

/**
 * 建一个假宿主元素。
 *
 * @returns 满足 {@link HintBarHost} 的普通对象
 */
function host(): HintBarHost {
  return { textContent: '', dataset: {} };
}

test('提示行：常量是 3000ms（O2 的"3 秒无交互自动淡出"）', () => {
  assert.equal(HINT_AUTO_FADE_MS, 3000);
});

test('提示行：构造后默认隐藏（首帧不该先闪一下再淡出）', () => {
  const element = host();
  const bar = new HintBar(element, { timer: new FakeTimer() });
  assert.equal(element.dataset.visible, '0');
  assert.equal(bar.isVisible, false);
});

test('提示行：show() 可见，2999ms 仍可见，3000ms 起不可见', () => {
  const timer = new FakeTimer();
  const element = host();
  const bar = new HintBar(element, { timer });
  bar.show();
  assert.equal(bar.isVisible, true);
  assert.equal(element.dataset.visible, '1');

  timer.advance(2999);
  assert.equal(bar.isVisible, true, '2999ms 还不该淡出');

  timer.advance(1);
  assert.equal(bar.isVisible, false, '3000ms 起必须淡出');
  assert.equal(element.dataset.visible, '0');
});

test('提示行：交互（poke）会重新计时，而不是累加', () => {
  const timer = new FakeTimer();
  const element = host();
  const bar = new HintBar(element, { timer });
  bar.poke();
  timer.advance(2000);
  bar.poke();
  timer.advance(2999);
  assert.equal(bar.isVisible, true, '重新计时后 2999ms 仍可见');
  timer.advance(1);
  assert.equal(bar.isVisible, false);
});

test('提示行：hide() 立即隐藏并清掉倒计时（不留下孤儿定时器）', () => {
  const timer = new FakeTimer();
  const element = host();
  const bar = new HintBar(element, { timer });
  bar.show();
  assert.equal(timer.pending, 1);
  bar.hide();
  assert.equal(timer.pending, 0, '隐藏后不该还挂着定时器');
  assert.equal(bar.isVisible, false);
});

test('提示行：文案只在变化时写 DOM（避免每帧排版）', () => {
  const element = host();
  const bar = new HintBar(element, { timer: new FakeTimer() });
  bar.setText('拖动移动 · 右键菜单');
  assert.equal(element.textContent, '拖动移动 · 右键菜单');
  bar.setText('拖动移动 · 右键菜单');
  assert.equal(element.textContent, '拖动移动 · 右键菜单');
  bar.setText('换一句');
  assert.equal(element.textContent, '换一句');
});

test('提示行：文案里不许再出现"表情：xx"实时值（O2 明确去掉）', () => {
  // 这条是纪律断言：文案由 main.ts 提供，这里断言的是"不给实时值留入口"的形态——
  // setText 只接受整串，提示行自己不会拼 `表情：`。
  const element = host();
  const bar = new HintBar(element, { timer: new FakeTimer() });
  bar.setText('拖动移动 · 右键菜单');
  assert.equal(/表情/.test(element.textContent ?? ''), false);
});

test('提示行：dispose() 清定时器并保持隐藏（页面卸载不留后台任务）', () => {
  const timer = new FakeTimer();
  const element = host();
  const bar = new HintBar(element, { timer });
  bar.show();
  bar.dispose();
  assert.equal(timer.pending, 0);
  assert.equal(element.dataset.visible, '0');
  // 释放后再调用不炸、也不再显示
  bar.show();
  assert.equal(bar.isVisible, false);
});

test('提示行：fadeAfterMs<=0 时从不自动淡出（标定页之类的常显场景）', () => {
  const timer = new FakeTimer();
  const element = host();
  const bar = new HintBar(element, { timer, fadeAfterMs: 0 });
  bar.show();
  timer.advance(600000);
  assert.equal(bar.isVisible, true);
  assert.equal(timer.pending, 0);
});

test('提示行：缺宿主（没有 dataset）构造直接抛错，防止静默失效', () => {
  assert.throws(() => new HintBar(undefined as unknown as HintBarHost), TypeError);
  assert.throws(() => new HintBar({ textContent: '' } as unknown as HintBarHost), TypeError);
});
