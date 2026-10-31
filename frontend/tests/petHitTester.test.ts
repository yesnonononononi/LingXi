/**
 * 命中抽象单测（tsx 执行，不碰 DOM）。
 *
 * <p>覆盖矩形命中的边界（四角外、边缘闭区间、内缩点）与命中管线的"每帧一次 + 值变化才上报 +
 * 主进程回执优先"。这条链路的缺陷表现是"点击穿透抽搐"或"点到透明区也算命中"，
 * 所以边界点必须逐条钉死。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_GEOMETRY, visibleBox } from '../src/pet/layout';
import { HitPipeline, type FrameScheduler } from '../src/pet/hit/hit-pipeline';
import { RectHitTester } from '../src/pet/hit/rect-hit-tester';

/** 可手动 flush 的帧调度器（node 里没有 rAF）。 */
class FakeFrames implements FrameScheduler {
  /** 待执行回调。 */
  private readonly pending = new Map<number, () => void>();

  /** 自增句柄。 */
  private seq = 0;

  /**
   * 排队一帧。
   *
   * @param callback 回调
   * @returns 句柄
   */
  request(callback: () => void): number {
    const id = ++this.seq;
    this.pending.set(id, callback);
    return id;
  }

  /**
   * 取消一帧。
   *
   * @param handle 句柄
   */
  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  /** 执行所有排队回调。 */
  flush(): void {
    const tasks = [...this.pending.values()];
    this.pending.clear();
    for (const task of tasks) task();
  }

  /** 排队中的帧数。 */
  get size(): number {
    return this.pending.size;
  }
}

/** 命中矩形（由几何真源推导，设计文档 §2.1 末行）。 */
const BOX = visibleBox(PET_GEOMETRY);

test('RectHitTester：命中矩形来自 visibleBox（不是立绘箱，也不是 getBoundingClientRect）', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  assert.equal(tester.kind, 'rect');
  assert.equal(tester.ready, true);
  const bounds = tester.bounds;
  assert.ok(bounds);
  assert.deepEqual(bounds, BOX);
  // 可见盒比立绘箱内缩：整箱判命中会让透明区吃掉桌面点击
  assert.ok((bounds?.width ?? 0) < PET_GEOMETRY.artWidth);
  assert.ok((bounds?.height ?? 0) < PET_GEOMETRY.artHeight);
});

test('RectHitTester：中心点命中，四角外不命中', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  const centerX = BOX.x + BOX.width / 2;
  const centerY = BOX.y + BOX.height / 2;
  assert.equal(tester.test(centerX, centerY), true);
  assert.equal(tester.test(BOX.x - 1, centerY), false);
  assert.equal(tester.test(BOX.x + BOX.width + 1, centerY), false);
  assert.equal(tester.test(centerX, BOX.y - 1), false);
  assert.equal(tester.test(centerX, BOX.y + BOX.height + 1), false);
});

test('RectHitTester：四条边是闭区间（边缘不抖）', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  const centerY = BOX.y + BOX.height / 2;
  const centerX = BOX.x + BOX.width / 2;
  assert.equal(tester.test(BOX.x, centerY), true, '左边界应命中');
  assert.equal(tester.test(BOX.x + BOX.width, centerY), true, '右边界应命中');
  assert.equal(tester.test(centerX, BOX.y), true, '上边界应命中');
  assert.equal(tester.test(centerX, BOX.y + BOX.height), true, '下边界应命中');
});

test('RectHitTester：窗口内但在透明留白处不命中', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  // 立绘箱左上角 (16, 88) 属于箱子但不在可见墨迹里
  assert.equal(tester.test(16, 88), false);
  // 右下角外（窗口 188×338，立绘箱右下 (172, 322)）
  assert.equal(tester.test(186, 336), false);
});

test('RectHitTester：非法坐标一律不命中（不抛异常）', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  assert.equal(tester.test(Number.NaN, 100), false);
  assert.equal(tester.test(100, Number.POSITIVE_INFINITY), false);
});

test('RectHitTester：setGeometry 后矩形跟着变（inkHeight 变化场景）', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  const larger = { ...PET_GEOMETRY, inkHeight: 260, artHeight: 291, artWidth: 194 };
  tester.setGeometry(larger);
  const box = tester.bounds;
  assert.ok(box);
  assert.ok((box?.width ?? 0) > BOX.width, '立绘箱变大后命中矩形也必须变大');
  assert.ok(tester.test((box?.x ?? 0) + 1, (box?.y ?? 0) + 1), true);
});

test('RectHitTester：invalidate 不改变几何，dispose 后不再命中', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  tester.invalidate('expression-changed');
  assert.deepEqual(tester.bounds, BOX);
  tester.dispose();
  assert.equal(tester.bounds, null);
  assert.equal(tester.test(BOX.x + 1, BOX.y + 1), false);
});

test('RectHitTester：setGeometry 传空必须报错（不允许静默失效）', () => {
  const tester = new RectHitTester(PET_GEOMETRY);
  assert.throws(() => tester.setGeometry(null as unknown as typeof PET_GEOMETRY), TypeError);
});

// ---------------------------------------------------------------- 命中管线

/**
 * 造一个带记录的管线。
 *
 * @returns 管线、记录数组、假帧调度器
 */
function makePipeline(): { pipeline: HitPipeline; changes: boolean[]; frames: FakeFrames } {
  const frames = new FakeFrames();
  const changes: boolean[] = [];
  const pipeline = new HitPipeline(new RectHitTester(PET_GEOMETRY), {
    onHitChange: (hit) => changes.push(hit),
  }, frames);
  return { pipeline, changes, frames };
}

test('HitPipeline：同帧多次 schedule 只判定一次（取最后一个坐标）', () => {
  const { pipeline, changes, frames } = makePipeline();
  pipeline.schedule(BOX.x + 5, BOX.y + 5);
  pipeline.schedule(1, 1);
  pipeline.schedule(BOX.x + 6, BOX.y + 6);
  assert.equal(frames.size, 1, '一帧只允许排一次判定');
  frames.flush();
  assert.deepEqual(changes, [true]);
});

test('HitPipeline：值没变不回调（避免 setIgnoreMouseEvents 抖动）', () => {
  const { pipeline, changes, frames } = makePipeline();
  pipeline.schedule(BOX.x + 5, BOX.y + 5);
  frames.flush();
  pipeline.schedule(BOX.x + 8, BOX.y + 8);
  frames.flush();
  assert.deepEqual(changes, [true]);
});

test('HitPipeline：移出命中区回调 false', () => {
  const { pipeline, changes, frames } = makePipeline();
  pipeline.schedule(BOX.x + 5, BOX.y + 5);
  frames.flush();
  pipeline.schedule(2, 2);
  frames.flush();
  assert.deepEqual(changes, [true, false]);
  assert.equal(pipeline.hit, false);
});

test('HitPipeline：主进程回执是权威值，之后的本地判定以它为基准', () => {
  const { pipeline, changes, frames } = makePipeline();
  // 主进程说"现在是可交互"，但本地还没判过 → 不回调
  pipeline.reconcileFromMain(true);
  assert.deepEqual(changes, []);
  // 本地判到命中区外 → 相对权威值变了 → 回调 false
  pipeline.schedule(2, 2);
  frames.flush();
  assert.deepEqual(changes, [false]);
});

test('HitPipeline：reset 取消排队帧并强制回穿透', () => {
  const { pipeline, changes, frames } = makePipeline();
  pipeline.schedule(BOX.x + 5, BOX.y + 5);
  frames.flush();
  pipeline.schedule(BOX.x + 5, BOX.y + 5 - 1);
  assert.equal(pipeline.framePending, true);
  pipeline.reset();
  assert.equal(frames.size, 0, 'reset 必须取消排队中的帧');
  assert.equal(pipeline.framePending, false);
  assert.deepEqual(changes, [true, false]);
});

test('HitPipeline：dispose 后不再排帧、不再回调', () => {
  const { pipeline, changes, frames } = makePipeline();
  pipeline.dispose();
  pipeline.schedule(BOX.x + 5, BOX.y + 5);
  frames.flush();
  assert.deepEqual(changes, []);
  assert.equal(frames.size, 0);
});

test('HitPipeline：构造参数缺失必须报错', () => {
  assert.throws(() => new HitPipeline(null as unknown as RectHitTester, { onHitChange: () => {} }), TypeError);
  assert.throws(
    () => new HitPipeline(new RectHitTester(PET_GEOMETRY), {} as unknown as { onHitChange: (hit: boolean) => void }),
    TypeError,
  );
});
