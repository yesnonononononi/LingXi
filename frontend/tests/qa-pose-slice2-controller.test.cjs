/**
 * QA 对抗测试（切片 2）· 控制器层：`setFacing` 的六种边界。
 *
 * <p>运行方式（必须走 tsx：require 的是 TS 模块）：</p>
 * <pre>npx tsx --test tests/qa-pose-slice2-controller.test.cjs</pre>
 *
 * <p>这一组只回答"朝向切换在**真状态**上做了什么"：no-op 是否真的不重启、
 * 重播是否真的从第 0 帧、没片段时是否真的降级而**不回落到另一朝向**、
 * 非法值是否在**写状态之前**就被拒。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '..');
const { PET_POSES } = require(path.join(FRONTEND, 'src/pet/poses/manifest.ts'));
const { PoseController } = require(path.join(FRONTEND, 'src/pet/poses/controller.ts'));

/** 手摇时钟（与控制器注入的 `ports` 同形）。 */
class FakeClock {
  time = 0;

  timers = [];

  seq = 0;

  now = () => this.time;

  schedule = (callback, delayMs) => {
    this.seq += 1;
    this.timers.push({ id: this.seq, at: this.time + Math.max(0, delayMs), callback });
    return this.seq;
  };

  cancel = (handle) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  advance(ms) {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

/** 极简假元素（控制器只用这几个成员）。 */
class FakeElement {
  tagName;

  dataset = {};

  attributes = new Map();

  children = [];

  properties = new Map();

  style = { setProperty: (name, value) => this.properties.set(name, value) };

  src = '';

  hidden = false;

  textContent = null;

  constructor(tagName) {
    this.tagName = tagName;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

/** 假文档（只造 div / img）。 */
class FakeDocument {
  createElement(tagName) {
    assert.ok(tagName === 'div' || tagName === 'img', `控制器不该创建 <${tagName}>`);
    return new FakeElement(tagName);
  }
}

/** 假眨眼驱动。 */
class FakeBlink {
  running = true;

  get isRunning() {
    return this.running;
  }

  stop() {
    this.running = false;
  }

  start() {
    this.running = true;
  }
}

/**
 * 造一个控制器，并把"上屏了哪些帧"记进 `frames`。
 *
 * @param {object} [options] 选项
 * @param {number} [options.facing] 构造期朝向（缺省 -1，与生产一致）
 * @param {object} [options.poses] 清单（缺省真清单）
 * @param {string[]} [options.prefix] 追加到每条日志前的前缀
 * @returns {{controller: object, clock: FakeClock, frames: string[], logs: string[]}} 观测面
 */
function makeController(options = {}) {
  const clock = new FakeClock();
  const frames = [];
  const logs = [];
  const controller = new PoseController({
    doc: new FakeDocument(),
    root: new FakeElement('div'),
    host: new FakeElement('div'),
    poses: options.poses ?? PET_POSES,
    density: '2x',
    ports: {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      onFrame: (frameId) => frames.push(frameId),
      onClipEnd: () => {},
    },
    boxOf: null,
    blink: new FakeBlink(),
    facing: options.facing ?? -1,
    log: (message) => logs.push(message),
  });
  return { controller, clock, frames, logs };
}

/** 真清单里某批某朝向的首帧与全部帧。 */
function clipFrames(batch, facing) {
  const clip = PET_POSES.batches[batch].clips.find((item) => item.facing === facing);
  assert.ok(clip, `真清单里 ${batch}@${facing} 必须有片段`);
  return clip.frames;
}

/** 深拷贝真清单（只在内存里改）。 */
function posesClone() {
  return JSON.parse(JSON.stringify(PET_POSES));
}

test('B-1 站姿调用 setFacing(1)：只记朝向，不重启、不播放', () => {
  const { controller, frames, logs } = makeController();
  assert.equal(controller.posture, 'stand');
  controller.setFacing(1);
  assert.equal(controller.facing, 1, '朝向必须记住');
  assert.equal(controller.clipFacing, null, '站姿没有片段 ⇒ clipFacing 必须是 null');
  assert.equal(controller.isPlaying, false);
  assert.deepEqual(frames, [], '站姿下不许因为切朝向就上屏任何帧');
  assert.ok(logs.some((line) => /无需重播/.test(line)), `日志应说明为什么没重播：${JSON.stringify(logs)}`);
});

test('B-2 站姿切到右向后再进 walk：播的是右向片段（朝向跨姿态生效）', () => {
  const { controller } = makeController();
  controller.setFacing(1);
  controller.setPosture('walk');
  assert.equal(controller.posture, 'walk');
  assert.equal(controller.clipFacing, 1, '必须播右向，不许静默拿到左向那条');
  assert.equal(controller.currentFrameId, clipFrames('walk', 1)[0]);
});

test('B-3 正在播 walk@-1 时 setFacing(-1)：必须是 no-op（不重启、相位不跳）', () => {
  const { controller, clock, frames } = makeController();
  controller.setPosture('walk');
  clock.advance(220); // 走过两帧
  const frameCountBefore = frames.length;
  const frameIdBefore = controller.currentFrameId;
  assert.ok(frameCountBefore >= 2, `前置：播放中必须已经在推进帧，实际 ${frameCountBefore}`);

  controller.setFacing(-1);
  assert.equal(frames.length, frameCountBefore, '朝向没变就不许重播（重播 = 相位跳回第 0 帧，走路会一顿一顿）');
  assert.equal(controller.currentFrameId, frameIdBefore);
});

test('B-4 正在播 walk@-1 时 setFacing(1)：换到右向并从第 0 帧重播（不续相位）', () => {
  const { controller, clock, frames } = makeController();
  const rightFrames = clipFrames('walk', 1);
  controller.setPosture('walk');
  clock.advance(330); // 左向已经走到第 3 帧
  assert.notEqual(controller.currentFrameId, rightFrames[0], '前置：此时不该正好是右向首帧');
  const frameCountBefore = frames.length;

  controller.setFacing(1);
  assert.equal(controller.clipFacing, 1, '必须换成右向片段');
  assert.equal(controller.currentFrameId, rightFrames[0], '必须从**第 0 帧**重播（跨朝向续相位会让角色踩空半拍）');
  assert.equal(frames.length, frameCountBefore + 1, '切朝向只许上屏 1 帧（新片段首帧）');

  controller.setFacing(-1);
  assert.equal(controller.clipFacing, -1, '再切回左向也必须换片段');
  assert.equal(controller.currentFrameId, clipFrames('walk', -1)[0], '切回左向同样从第 0 帧重播');
});

test('B-5 连续两次 setFacing(1)：第二次必须 no-op（不许重启播放）', () => {
  const { controller, clock, frames } = makeController();
  controller.setPosture('walk');
  controller.setFacing(1);
  clock.advance(110);
  const frameCountBefore = frames.length;
  const frameIdBefore = controller.currentFrameId;

  controller.setFacing(1);
  assert.equal(frames.length, frameCountBefore, '第二次同朝向调用不许重启播放');
  assert.equal(controller.currentFrameId, frameIdBefore);
});

test('B-6 非法朝向（0 / "1" / null / NaN）抛 TypeError，且**先校验后写状态**：朝向与播放都不变', () => {
  const { controller, clock, frames } = makeController();
  controller.setPosture('walk');
  clock.advance(220);
  const frameCountBefore = frames.length;
  const facingBefore = controller.facing;
  const clipFacingBefore = controller.clipFacing;
  const frameIdBefore = controller.currentFrameId;

  for (const bad of [0, '1', '-1', null, NaN, true, 2]) {
    assert.throws(
      () => controller.setFacing(bad),
      (err) => err instanceof TypeError && /setFacing/i.test(err.message),
      `setFacing(${String(bad)}) 必须抛 TypeError（不做类型宽松转换）`,
    );
    assert.equal(controller.facing, facingBefore, `setFacing(${String(bad)}) 之后朝向不许被写脏`);
    assert.equal(controller.clipFacing, clipFacingBefore, '片段朝向不许变');
    assert.equal(controller.currentFrameId, frameIdBefore, '当前帧不许被重置（说明没有偷偷重播）');
    assert.equal(frames.length, frameCountBefore, '非法调用不许上屏任何帧');
  }
});

test('B-7 新朝向没有片段 ⇒ 降级站姿，**绝不回落到另一朝向**（合成：walk 只留左向）', () => {
  const poses = posesClone();
  poses.batches.walk.clips = poses.batches.walk.clips.filter((clip) => clip.facing === -1);
  const { controller, clock, frames, logs } = makeController({ poses });

  controller.setPosture('walk');
  assert.equal(controller.clipFacing, -1, '前置：左向可播');
  clock.advance(110);
  const frameCountBefore = frames.length;

  controller.setFacing(1);
  assert.equal(controller.posture, 'stand', '没有右向片段 ⇒ 必须降级站姿');
  assert.equal(controller.clipFacing, null, '降级后不许还挂着一个片段');
  assert.equal(controller.isPlaying, false, '降级后必须停播');
  assert.equal(frames.length, frameCountBefore, '降级不许再上屏任何帧（尤其不许把左向帧顶上去）');
  assert.ok(
    logs.some((line) => /朝向 1 没有可播片段/.test(line)),
    `降级原因必须写清楚"这个朝向没有片段"：${JSON.stringify(logs)}`,
  );

  // 之后即使时钟继续走，也不许复活
  clock.advance(1000);
  assert.equal(controller.posture, 'stand');
  assert.equal(frames.length, frameCountBefore);
});

test('B-8 sit 只有左向片段：站在右向时进 sit ⇒ 留在站姿并说明原因（不假装切成功）', () => {
  const { controller, logs } = makeController();
  controller.setFacing(1);
  controller.setPosture('sit');
  assert.equal(controller.posture, 'stand', 'sit 没有右向片段 ⇒ 不许假装坐到右向');
  assert.equal(controller.clipFacing, null);
  assert.ok(logs.some((line) => /没有朝向 1 的片段/.test(line)), `日志必须点名缺的是哪个朝向：${JSON.stringify(logs)}`);
});

test('B-9 jump（once + return-stand）播完自己回站姿，且朝向切换不影响收尾语义', () => {
  const { controller, clock, frames } = makeController();
  controller.setFacing(1);
  controller.setPosture('jump');
  assert.equal(controller.clipFacing, 1);
  const jumpFrames = clipFrames('jump', 1);
  const totalMs = PET_POSES.batches.jump.clips.find((clip) => clip.facing === 1).frameMs.reduce((sum, ms) => sum + ms, 0);
  clock.advance(totalMs + 10);
  assert.deepEqual(
    frames.filter((id) => jumpFrames.includes(id)).length >= jumpFrames.length,
    true,
    '前置：整条 once 的帧应全部上屏过',
  );
  assert.equal(controller.posture, 'stand', 'once + onEnd:return-stand 播完必须回站姿');
  assert.equal(controller.isPlaying, false);
});
