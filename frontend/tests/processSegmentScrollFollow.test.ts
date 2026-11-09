import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer, nextTick, ref} from 'vue';
import {useStreamStickyScroll} from '../src/composables/useStreamStickyScroll';

/**
 * 过程段滚动框的「用户接管」契约。
 *
 * <p>场景来源：流式正文之间的过程区里点开某个工具详情，框停在最下方，刚展开的卡片开头被顶出视野。
 * 根因是高度变化一律被当成流式增量贴底 —— 判定必须只认流式签名，用户手势（展开/折叠）另行暂停跟随。</p>
 *
 * <p>这里断言的是 composable 的真实实现，因此 `pauseFollowing` 被改成空实现、或者被误实现成
 * 「顺手贴一次底」，下面的用例都会失败。</p>
 */

interface FakeBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function mountHost(t: test.TestContext) {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const previousRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  (globalThis as unknown as {requestAnimationFrame: unknown}).requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  (globalThis as unknown as {cancelAnimationFrame: unknown}).cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };

  const signature = ref('0');
  let scroll!: ReturnType<typeof useStreamStickyScroll>;
  const renderer = createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null,
    nextSibling: () => null, createElement: () => ({}), createText: () => ({}),
    setText() {}, setElementText() {}, patchProp() {},
  });
  const app = renderer.createApp({
    setup() {
      scroll = useStreamStickyScroll({streamSignature: () => signature.value, boxIds: () => ['details']});
      return () => null;
    },
  });
  app.mount({});

  t.after(() => {
    app.unmount();
    if (previousRaf) Object.defineProperty(globalThis, 'requestAnimationFrame', previousRaf);
    else delete (globalThis as unknown as Record<string, unknown>).requestAnimationFrame;
    if (previousCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', previousCancel);
    else delete (globalThis as unknown as Record<string, unknown>).cancelAnimationFrame;
  });

  return {
    api: () => scroll,
    signature,
    /** 跑完一轮 watch(flush: 'post') + 一帧 rAF 的贴底调度。 */
    async flush() {
      await nextTick();
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => callback(0));
      await nextTick();
    },
  };
}

test('流式增量继续贴底，用户展开详情后暂停跟随，滚回底部恢复', async t => {
  const host = mountHost(t);
  const box: FakeBox = {scrollTop: 0, scrollHeight: 900, clientHeight: 300};
  host.api().setBoxRef('details', box);
  await host.flush();
  assert.equal(box.scrollTop, 600, '首次挂载必须贴底（首个分片落地时 scrollTop 还是 0）');

  box.scrollHeight = 1300;
  host.signature.value = '1';
  await host.flush();
  assert.equal(box.scrollTop, 1000, '跟随状态下流式增量继续贴底');

  // 用户点开工具详情：内容变高了，但这是手势不是增量。
  host.api().pauseFollowing('details');
  assert.equal(host.api().isFollowing('details'), false);
  assert.equal(box.scrollTop, 1000, '暂停跟随不能顺手改动当前位置');
  box.scrollHeight = 1700;
  host.signature.value = '2';
  await host.flush();
  assert.equal(box.scrollTop, 1000, '刚展开的详情开头必须留在视野里');

  // 用户自己滚回底部 → 恢复跟随。
  box.scrollTop = 1400;
  host.api().handleScroll('details', {target: box} as unknown as Event);
  assert.equal(host.api().isFollowing('details'), true, '滚回底部即恢复跟随');
  box.scrollHeight = 2000;
  host.signature.value = '3';
  await host.flush();
  assert.equal(box.scrollTop, 1700, '恢复跟随后新增量再次贴底');
});

test('暂停跟随不影响已经贴底的历史内容被重新展开时的定位', async t => {
  const host = mountHost(t);
  const box: FakeBox = {scrollTop: 0, scrollHeight: 500, clientHeight: 500};
  host.api().setBoxRef('details', box);
  await host.flush();
  assert.equal(box.scrollTop, 0, '内容不溢出时不该产生滚动位移');
  host.api().pauseFollowing('details');
  box.scrollHeight = 800;
  host.signature.value = '1';
  await host.flush();
  assert.equal(box.scrollTop, 0, '从顶部开始读的位置不能被抢占');
});
