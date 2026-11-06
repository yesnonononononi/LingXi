/**
 * `play_cloud`（B2 的双角色场景）**专项**单测：真值 / 磁盘对齐 / 三层分流 / 松手撤层 /
 * 收尾撤层 / 入口幂等 / 主角路径不动姿态主状态。
 *
 * <p><b>为什么另立一个文件而不是塞进 `petSequenceManifest.test.ts`：</b>那份文件守的是
 * "清单与加载器的契约"（schema、归一化、门禁判别力），本文件守的是"<b>两次彩排有没有走错位</b>"
 * ——双角色场景最容易出的错不是数据不合法，而是**画面串层**：主角帧被写进伙伴层
 * （云朵突然变成坐着的小猫）、伙伴走到画面外（`companionCenterX` 写错域）、
 * 手掌松开后没撤层（一只悬空的手跟着云飘走）。这三件事都"数据合法、门禁全绿"，
 * 只有把每一步真的推进一遍、逐层核对写入了什么，才抓得到。</p>
 *
 * <p><b>本文件覆盖的判据：</b></p>
 * <ol>
 *   <li>真值：15 步 / 4,860 ms / 阶段分布（approach 5 · contact 3 · response 3 · end 4）；</li>
 *   <li>`pet-sequences.json` 的 16 条 play_cloud 帧与磁盘**逐字节**对齐（size + sha256 + 无孤儿）；</li>
 *   <li>三层分流：主角只经主角端口、伙伴/手掌各写各的层，主角帧绝不进伙伴层；</li>
 *   <li>第 11 步手掌松开 ⇒ 手掌层必须被撤（否则悬空手掌跟到最后）；</li>
 *   <li>`stop()` 之后所有层视觉上不可见（`display:none` + `hidden`），且重复 `stop()` 幂等；</li>
 *   <li>用户入口在播放中重入 ⇒ 从头重来、层不增生、不叠加（幂等）；</li>
 *   <li>主角路径经 `PoseController.showFrame`：`posture` / `facing` / `clip` 序列前后完全一致。</li>
 * </ol>
 *
 * @module tests/petPlayCloudSequence
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PET_POSES } from '../src/pet/poses/manifest';
import { PoseController, type PoseBlinkLike } from '../src/pet/poses/controller';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';
import type { PetPoses } from '../src/pet/poses/types';
import {
  PET_SEQUENCES,
  layerOf,
  normalizePetSequences,
  sceneOf,
} from '../src/pet/sequences/manifest';
import { DomSequenceLayer, SequenceDirector, sceneDurationOf } from '../src/pet/sequences/director';
import type {
  SequenceCssBox,
  SequenceDensity,
  SequenceFrameFile,
  SequenceProtagonistPort,
  SequenceScene,
  SequenceStep,
} from '../src/pet/sequences/types';
import { DEFAULT_SEQUENCE_OUT_DIR, SEQUENCES_JSON_PATH } from '../scripts/build-pet-sequences.mjs';

/** 场景 id（本文件的全部断言都针对它）。 */
const SCENE_ID = 'play_cloud';

/** 已提交清单原文（需要造变体时克隆它）。 */
const COMMITTED = JSON.parse(readFileSync(SEQUENCES_JSON_PATH, 'utf8')) as Record<string, any>;

/** 场景（真清单里必然存在；不存在就让整个文件在第一步就炸，而不是逐例报 null）。 */
const SCENE = sceneOf(PET_SEQUENCES, SCENE_ID) as SequenceScene;

/**
 * 深拷贝（清单只有 JSON 值）。
 *
 * @param value 源值
 * @returns 副本
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 记录每一次写入的层端口（伙伴层 / 手掌层共用）。 */
class RecordingPort {
  /** 收到的帧（含 `null`，按顺序）。 */
  readonly frames: (SequenceFrameFile | null)[] = [];

  /** 收到的盒子（按顺序；`null` 不记）。 */
  readonly placements: SequenceCssBox[] = [];

  /** `stop()` 次数。 */
  stopCount = 0;

  /** 密度档（导演据此选 `@1x` / `@2x`）。 */
  readonly density: SequenceDensity = '2x';

  /**
   * @param frame 帧；`null` = 本步不显示
   */
  setFrame(frame: SequenceFrameFile | null): void {
    this.frames.push(frame);
  }

  /**
   * @param box 盒子
   */
  setPlacement(box: SequenceCssBox | null): void {
    if (box !== null) this.placements.push(box);
  }

  /** 撤层。 */
  stop(): void {
    this.stopCount += 1;
  }

  /** 非 `null` 的帧（断言"收到过什么画面"用）。 */
  get shown(): SequenceFrameFile[] {
    return this.frames.filter((frame): frame is SequenceFrameFile => frame !== null);
  }
}

/** 记录主角端口调用（`showFrame` / `clear`）。 */
class RecordingProtagonist implements SequenceProtagonistPort {
  /** `showFrame` 收到的帧 id（按顺序）。 */
  readonly frames: string[] = [];

  /** `clear()` 次数。 */
  clearCount = 0;

  /**
   * @param frameId 帧 id
   */
  showFrame(frameId: string): void {
    this.frames.push(frameId);
  }

  /** 收尾。 */
  clear(): void {
    this.clearCount += 1;
  }
}

/** 记录 `stop()` 次数的真 DOM 层（`DomSequenceLayer` 本身不暴露计数）。 */
class CountingLayer extends DomSequenceLayer {
  /** `stop()` 被调次数。 */
  stopCount = 0;

  /** 撤层并计数。 */
  override stop(): void {
    this.stopCount += 1;
    super.stop();
  }
}

/**
 * 读某一层已写入的行内 `display`（只写 `hidden` 的实现会读到 `block`，正是要抓的缺陷）。
 *
 * @param layer 层
 * @returns 行内 display 值；没写过为 `undefined`
 */
function displayOf(layer: DomSequenceLayer): string | undefined {
  return (layer.elementHandle as unknown as FakeElement).properties.get('display');
}

/** 假元素（层与控制器只用到这几个成员）。 */
class FakeElement implements ElementLike {
  /** 标签名。 */
  readonly tagName: string;

  /** 属性面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** 已写入的 CSS 属性。 */
  readonly properties = new Map<string, string>();

  /** CSS 写入面。 */
  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.properties.set(name, value);
    },
  };

  /** 图片地址。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /**
   * @param tagName 标签名
   */
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /**
   * @param child 子节点
   * @returns 入参
   */
  appendChild(child: ElementLike): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  /**
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /**
   * @param name 属性名
   * @returns 属性值
   */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

/** 假文档（只造 `img` / `div`）。 */
class FakeDocument implements DocumentLike {
  /**
   * @param tagName 标签名
   * @returns 假元素
   */
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}

/** 可控时钟（导演不自己读时间）。 */class FakeClock {
  /** 当前时刻（ms）。 */
  time = 0;

  /** 读时间。 */
  now = (): number => this.time;

  /**
   * 推进时间。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
  }
}

/** 假眨眼驱动（控制器构造必需）。 */
class FakeBlink implements PoseBlinkLike {
  /** 是否在跑。 */
  private running = false;

  /** 是否在跑。 */
  get isRunning(): boolean {
    return this.running;
  }

  /** 停。 */
  stop(): void {
    this.running = false;
  }

  /** 启。 */
  start(): void {
    this.running = true;
  }
}

/**
 * 造一个只接两个假层的导演（主角端口可注入）。
 *
 * @param options 选项
 * @param options.sequences 清单（缺省真清单）
 * @param options.protagonist 主角端口（缺省记录型假端口）
 * @returns 观测面
 */
function makeDirector(options: { sequences?: typeof PET_SEQUENCES; protagonist?: SequenceProtagonistPort } = {}): {
  clock: FakeClock;
  companion: RecordingPort;
  hands: RecordingPort;
  protagonist: RecordingProtagonist;
  director: SequenceDirector;
} {
  const clock = new FakeClock();
  const companion = new RecordingPort();
  const hands = new RecordingPort();
  const protagonist = new RecordingProtagonist();
  const director = new SequenceDirector({
    sequences: options.sequences ?? PET_SEQUENCES,
    clock,
    layers: { companion, hands },
    protagonist: options.protagonist ?? protagonist,
    align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
    base: { centerX: 1080, footY: 1454 },
  });
  return { clock, companion, hands, protagonist, director };
}

/**
 * 把场景逐步推完（每一步边界各 tick 一次，最后再 tick 到总时长）。
 *
 * @param director 导演
 * @param clock 时钟
 * @param scene 场景
 * @param onAfterPlay `play()` 之后、第一次 `tick()` 之前调（采集基线用；`play()` 内部会先
 *   `stop()` 一次，所以"撤层次数"必须从这个基线起算）
 * @returns 每一步结束时的时刻（ms，相对起点）
 */
function runScene(
  director: SequenceDirector,
  clock: FakeClock,
  scene: SequenceScene,
  onAfterPlay?: () => void,
): number[] {
  director.play(SCENE_ID);
  if (onAfterPlay !== undefined) onAfterPlay();
  const boundaries: number[] = [];
  let elapsed = 0;
  for (const [index, step] of scene.steps.entries()) {
    elapsed += step.ms;
    // 最后一步**停在末步之内**（`total − 1` ms）：循环场景 tick 到 `total` 会因为取模回绕到第 0 步，
    // 那样"每步恰好写一次"的计数会多出一次回绕写，把真正的串层问题盖掉。
    const stayInside = index === scene.steps.length - 1 && scene.loop;
    clock.advance(step.ms - (stayInside ? 1 : 0));
    director.tick(clock.now());
    boundaries.push(elapsed);
  }
  return boundaries;
}

test('P-01 真值：play_cloud 15 步 / 4,860 ms / 循环 / 四阶段分布', () => {
  assert.equal(SCENE.steps.length, 15, '美术 gif-v1 manifest 的 play_cloud 是 15 步');
  assert.equal(sceneDurationOf(SCENE), 4860, '总时长 4.86 s（manifest 声明值，逐步累加必须一致）');
  assert.equal(SCENE.loop, true, 'play_cloud 是循环场景');
  assert.equal(SCENE.onEnd, null, '循环场景没有"播完"语义');
  const phases = SCENE.steps.map((step: SequenceStep) => (step as SequenceStep & { phase?: string }).phase);
  const count = (phase: string): number => phases.filter((item) => item === phase).length;
  assert.equal(count('approach'), 5, '靠近 5 步');
  assert.equal(count('contact'), 3, '接触（抱起）3 步');
  assert.equal(count('response'), 3, '回应 3 步');
  assert.equal(count('end'), 4, '放回 4 步');
  assert.equal(phases.length, 15, '阶段数组长度必须等于步数（不许有未分类的步）');
});

test('P-02 清单与磁盘逐字节对齐：12 条 play_cloud 帧 + 无孤儿 + totals 自证', () => {
  const keys = Object.keys(PET_SEQUENCES.frames).filter((key) => key.startsWith(`${SCENE_ID}/`));
  assert.equal(keys.length, 12, 'play_cloud 有 12 条帧（6 个 slot × 2 档：sit_neutral / neutral / sit_welcome / sit_hug / hug / happy）');
  const expectedFiles = new Set<string>();
  for (const key of keys) {
    const file = PET_SEQUENCES.frames[key];
    assert.ok(file !== undefined, `帧表缺 ${key}`);
    const match = /^play_cloud\/([^/@]+)@(1x|2x)\.webp$/.exec(key);
    assert.ok(match !== null, `帧键形态不对：${key}`);
    const slot = match[1];
    const density = match[2];
    assert.equal(file.slot, slot, `${key} 的 slot 字段必须与键一致`);
    assert.equal(file.url, `lxa://pet-sequences/${key}`, `${key} 的 url 必须指向同一条相对路径`);
    assert.equal(file.format, 'webp-lossless', `${key} 必须是无损 webp（与 pose 同口径）`);
    if (density === '1x') expectedFiles.add(`${slot}@1x.webp`);
    else expectedFiles.add(`${slot}@2x.webp`);
    const onDisk = join(DEFAULT_SEQUENCE_OUT_DIR, SCENE_ID, `${slot}@${density}.webp`);
    const bytes = readFileSync(onDisk);
    assert.equal(statSync(onDisk).size, file.bytes, `${key} 的 bytes 必须等于磁盘文件大小`);
    assert.equal(bytes.length, file.bytes, `${key} 逐字节：读到的长度必须等于清单`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      file.sha256,
      `${key} 的 sha256 必须与磁盘逐字节一致（改了画面却没重建，这里就红）`,
    );
  }
  // 无孤儿：磁盘目录里的文件集合必须与清单集合**相等**（多一个 = 白占体积，少一个 = 断图）
  const onDiskNames = new Set(readdirSync(join(DEFAULT_SEQUENCE_OUT_DIR, SCENE_ID)).filter((name) => name.endsWith('.webp')));
  assert.deepEqual(
    [...onDiskNames].sort(),
    [...expectedFiles].sort(),
    '目录与清单必须一一对应（无孤儿、无缺失）',
  );
  // totals 自证：1x / 2x 分别等于逐条累加
  let bytes1x = 0;
  let bytes2x = 0;
  for (const key of keys) {
    const file = PET_SEQUENCES.frames[key];
    assert.ok(file !== undefined);
    if (key.endsWith('@1x.webp')) bytes1x += file.bytes;
    else bytes2x += file.bytes;
  }
  const cloudKeys = Object.keys(PET_SEQUENCES.frames).filter((key) => key.startsWith('cloud_react/'));
  const sumOf = (list: string[], suffix: string): number =>
    list
      .filter((key) => key.endsWith(suffix))
      .reduce((total, key) => total + (PET_SEQUENCES.frames[key]?.bytes ?? 0), 0);
  assert.equal(PET_SEQUENCES.totals.bytes1x, bytes1x + sumOf(cloudKeys, '@1x.webp'), 'totals.bytes1x 必须等于逐条累加');
  assert.equal(PET_SEQUENCES.totals.bytes2x, bytes2x + sumOf(cloudKeys, '@2x.webp'), 'totals.bytes2x 必须等于逐条累加');
  assert.equal(PET_SEQUENCES.totals.durationMs, 8040, '两场景时长之和（3180 + 4860）');
  assert.equal(PET_SEQUENCES.totals.steps, 23, '两场景步数之和（8 + 15）');
});

test('P-03 双角色各走各的层：主角/伙伴/手掌三层互不串位', () => {
  const clock = new FakeClock();
  const protagonist = new RecordingPort();
  const companion = new RecordingPort();
  const hands = new RecordingPort();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    // 数组下标即 z 序（0 最底）。play_cloud 的三层都是 `sequence-frames`，
    // 所以三层各有一个自己的端口——这正是"串层"能被抓住的前提。
    layers: { protagonist, companion, hands },
    align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
    base: { centerX: 1080, footY: 1454 },
  });
  runScene(director, clock, SCENE);

  // 主角：每一步恰好一次，帧序列与清单逐值相同（多一次/少一次都说明有别的路径在写主角）
  assert.deepEqual(
    protagonist.frames.map((frame) => (frame === null ? null : frame.slot)),
    SCENE.steps.map((step) => step.frames.protagonist),
    '主角层帧序列必须逐步等于清单',
  );
  for (const frame of protagonist.shown) {
    assert.equal(frame.layer, 'protagonist', `主角层收到了 ${frame.layer} 的帧（串层）`);
    assert.match(frame.slot, /^sit_/, `主角层只能是坐姿演出帧，实际 ${frame.slot}`);
  }
  // 伙伴：从第 0 步起每一步都在（15 次），且**只**收到云朵的帧
  assert.equal(companion.frames.length, 15, '伙伴层每一步都要写一次（play_cloud 每步都有 companion）');
  assert.equal(companion.shown.length, 15, '伙伴层不许出现"本步不显示"');
  for (const frame of companion.shown) {
    assert.equal(frame.layer, 'companion', `伙伴层收到了 ${frame.layer} 的帧（串层）`);
    assert.match(frame.slot, /^(neutral|happy)$/, `伙伴层的 slot 只能是 neutral / happy，实际 ${frame.slot}`);
  }
  // 手掌：只在第 7–10 步（4 次），且只收 hug
  assert.equal(hands.shown.length, 4, '手掌层只在抱起后的 4 步里出现');
  for (const frame of hands.shown) {
    assert.equal(frame.layer, 'hands', `手掌层收到了 ${frame.layer} 的帧（串层）`);
    assert.equal(frame.slot, 'hug', `手掌层的 slot 只能是 hug，实际 ${frame.slot}`);
  }
  // 位置：各层各写各的盒子（伙伴 15 次，手掌 4 次）
  assert.equal(companion.placements.length, 15, '伙伴层每步都写位置');
  assert.equal(hands.placements.length, 4, '手掌层只在有帧的步写位置');
  // 伙伴盒子的 x 必须随 `companionCenterX` 单调靠近（靠近段 5 步：1080 → 690）
  const approachLefts = companion.placements.slice(0, 5).map((box) => box.left);
  for (let index = 1; index < approachLefts.length; index += 1) {
    assert.ok(
      approachLefts[index] < approachLefts[index - 1],
      `靠近段伙伴必须逐步向左移动，实际 ${approachLefts.join(' → ')}`,
    );
  }
});

test('P-04 松手必须真的撤层：第 11 步起手掌层收到 null 且被 stop（防悬空手掌）', () => {
  const { clock, hands, director } = makeDirector();
  let stopsAfterPlay = 0;
  runScene(director, clock, SCENE, () => {
    // `play()` 内部会先 `stop()` 一次撤干净旧画面，所以基线必须在这里采
    stopsAfterPlay = hands.stopCount;
  });
  // 第 7–10 步是 hands 的 4 帧；第 11 步的 frames 里没有 hands ⇒ 必须撤
  assert.equal(hands.frames.length, 5, '手掌层：4 次上屏 + 1 次撤层（第 11 步），多一个少一个都不对');
  const last = hands.frames[hands.frames.length - 1];
  assert.equal(last, null, '手掌层的最后一次写入必须是 null（否则手一直亮着第 10 步的图）');
  assert.equal(hands.stopCount - stopsAfterPlay, 1, '撤层必须调端口 stop()（只写 null 不 stop 的实现在真机上不算撤）');
  // 第 12–14 步不许再反复写 null（撤一次就够，幂等不该退化成每步都写）
  assert.equal(
    hands.frames.filter((frame) => frame === null).length,
    1,
    '撤层只发生一次：后续步骤模板里没有 hands 时不必重复撤',
  );
});

test('P-05 stop() 之后所有层视觉上不可见（display:none + hidden），重复 stop 幂等', () => {
  const host = new FakeElement('div');
  const doc = new FakeDocument();
  const companion = new CountingLayer({ doc, host, layerId: 'companion', density: '2x' });
  const hands = new CountingLayer({ doc, host, layerId: 'hands', density: '2x' });
  const protagonist = new RecordingProtagonist();
  const clock = new FakeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion, hands },
    protagonist,
    align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
    base: { centerX: 1080, footY: 1454 },
  });
  runScene(director, clock, SCENE);
  // 反向断言：播放中两层必须真的可见（防"永远隐藏"的坏实现骗过绿）
  assert.equal(companion.elementHandle.hidden, false, '播放中伙伴层必须可见');
  assert.equal(displayOf(companion), 'block', '播放中伙伴层的行内 display 必须是 block');
  director.stop();
  for (const layer of [companion, hands]) {
    assert.equal(layer.elementHandle.hidden, true, `stop() 之后 ${layer.layerId} 层的 hidden 必须是 true`);
    assert.equal(
      layer.elementHandle.getAttribute('data-sequence-layer'),
      layer.layerId,
      '层元素不能被换掉（句柄必须仍指向同一个节点）',
    );
  }
  assert.equal(displayOf(companion), 'none', '伙伴层的行内 display 必须是 none（只写 hidden 会被行内 display:block 打败）');
  assert.equal(displayOf(hands), 'none', '手掌层的行内 display 必须是 none');
  assert.ok(protagonist.clearCount >= 1, '主角端口必须被 clear（序列不许把"收干净"留给调用方猜）');
  const clearsBefore = protagonist.clearCount;
  const stopsBefore = companion.stopCount;
  director.stop();
  director.stop();
  assert.equal(protagonist.clearCount, clearsBefore + 2, '重复 stop() 每次都会调 clear（幂等写入，不抛错）');
  assert.equal(companion.stopCount, stopsBefore + 2, '重复 stop() 每次都会撤层');
  assert.equal(companion.elementHandle.hidden, true, '重复 stop() 之后仍然不可见');
  assert.equal(displayOf(hands), 'none', '重复 stop() 之后仍然不可见');
});

test('P-06 用户入口幂等：播放中重入 ⇒ 从头重来、层不增生、不叠加', () => {
  const host = new FakeElement('div');
  const doc = new FakeDocument();
  const companion = new DomSequenceLayer({ doc, host, layerId: 'companion', density: '2x' });
  const protagonist = new RecordingProtagonist();
  const clock = new FakeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion },
    protagonist,
    align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
    base: { centerX: 1080, footY: 1454 },
  });
  director.play(SCENE_ID);
  clock.advance(1500);
  director.tick(clock.now());
  const midStep = director.snapshot().stepIndex;
  assert.ok(midStep > 0, '第一次播放应该已经推进（否则这条用例证明不了重入）');
  const childrenBefore = host.children.length;
  // 重入：用户又双击了一次
  director.play(SCENE_ID);
  assert.equal(director.snapshot().stepIndex, 0, '重入必须回到第 0 步（不是叠加两段时间轴）');
  assert.equal(director.snapshot().elapsedMs, 0, '重入必须把已跑时长清零');
  assert.equal(host.children.length, childrenBefore, '重入不许新建层元素（双影就是从这里来的）');
  clock.advance(0);
  director.tick(clock.now());
  assert.equal(director.snapshot().stepIndex, 0, '重入后第 0 步必须稳定');
});

/**
 * 造一份"坐姿片段时长合法"的 pose 清单副本（**只在内存里**，不写盘）。
 *
 * <p><b>为什么要这样造：</b>姿态清单（`pet-poses.json`）与 `sit_blink` 的片段时长归另一条
 * 交付线（姿态侧），本轮它是**在飞的共享文件**；如果本用例直接吃它当前的时长，就会因为
 * 别人还没定稿的数值而红/绿抖动。这里把每条片段的 `frameMs` 夹到播放器允许的
 * `[80, 2400]`（单帧片段的 0 也不受影响，`Math.max(80, 0)` 只在多帧片段上出现，
 * 而多帧片段的 0 本来就不合法），只为让 `PoseController` 真的进入坐姿——
 * 本文件要证明的是"**序列借用画面时不写姿态主状态**"，不是"姿态片段的时长对不对"。</p>
 *
 * @returns 合法时长版本的 pose 清单
 */
function posesForSequenceTest(): PetPoses {
  const raw = JSON.parse(JSON.stringify(PET_POSES)) as Record<string, any>;
  for (const batch of Object.values(raw.batches) as Record<string, any>[]) {
    for (const clip of batch.clips as Record<string, any>[]) {
      const frameMs = clip.frameMs as number[];
      if (frameMs.length === 1) continue;
      clip.frameMs = frameMs.map((ms) => Math.min(2400, Math.max(80, ms)));
    }
  }
  return raw as PetPoses;
}

test('P-07 主角路径经 PoseController.showFrame：posture / facing / clip 序列前后完全一致', () => {
  // 造一份"主角层是 pose-frames"的清单变体：这正是 `SequenceProtagonistPort` 存在的场景
  // （play_cloud 的三层都是 sequence-frames，见 types.ts 的模块注释；pose-frames 这条 kind
  // 用来验证窄接口契约本身）。
  const raw = clone(COMMITTED) as Record<string, any>;
  raw.layers[0].kind = 'pose-frames';
  for (const step of raw.scenes[SCENE_ID].steps) {
    step.frames.protagonist = 'sit_neutral';
  }
  const sequences = normalizePetSequences(raw);
  assert.equal(layerOf(sequences, 'protagonist')?.kind, 'pose-frames', '变体的主角层必须是 pose-frames');
  assert.equal(layerOf(sequences, 'companion')?.kind, 'sequence-frames', '伙伴层保持 sequence-frames');

  const clock = new FakeClock();
  const companion = new RecordingPort();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const controller = new PoseController({
    doc: new FakeDocument(),
    root,
    host,
    poses: posesForSequenceTest(),
    density: '2x',
    ports: {
      now: clock.now,
      schedule: () => 0,
      cancel: () => {},
      onFrame: () => {},
      onClipEnd: () => {},
    },
    boxOf: null,
    blink: new FakeBlink(),
    facing: -1,
    log: () => {},
  });
  controller.setPosture('sit');
  assert.equal(controller.posture, 'sit', '前置：控制器必须真的进了坐姿');
  const postureBefore = controller.posture;
  const facingBefore = controller.facing;
  const clipBefore = controller.clipId;
  const pendingBefore = controller.isSequenceFrameActive;

  let showFrameCalls = 0;
  const director = new SequenceDirector({
    sequences,
    clock,
    layers: { companion },
    protagonist: {
      showFrame: (frameId: string) => {
        showFrameCalls += 1;
        assert.equal(controller.showFrame(frameId), true, `showFrame(${frameId}) 必须真的画上去（否则主角是空的）`);
      },
      clear: () => {
        controller.clearSequenceFrame();
      },
    },
    align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
    base: { centerX: 1080, footY: 1454 },
  });
  const scene = sceneOf(sequences, SCENE_ID) as SequenceScene;
  runScene(director, clock, scene);
  assert.equal(showFrameCalls, 15, '主角端口每步一次（15 次）');
  assert.equal(controller.isSequenceFrameActive, true, '序列期间姿态层确实被借用（画面可见）');
  assert.equal(controller.currentFrameId, 'sit_neutral', '姿态层当前帧就是序列要的那一帧');
  assert.equal(controller.poseImageCount, 1, '姿态层里仍然只有 1 个 <img>（G-03 不变）');

  director.stop();
  // 三条主状态：序列不许写
  assert.equal(controller.posture, postureBefore, 'posture 必须零写入（唯一主人是 setPosture）');
  assert.equal(controller.facing, facingBefore, 'facing 必须零写入（唯一主人是 setFacing）');
  assert.equal(controller.clipId, clipBefore, 'clip 必须零写入（序列不改选中的片段）');
  assert.equal(controller.isSequenceFrameActive, false, 'stop() 之后姿态层不该再被借用');
  assert.equal(controller.currentFrameId, null, '收尾必须把序列帧撤掉（不留"序列播完还挂着一帧"）');
  assert.equal(controller.posture, 'sit', '收尾之后仍然坐在那里（没被赶起来）');
  assert.equal(pendingBefore, false, '前置：进入序列前并没有借用画面');

  // 幂等：clearSequenceFrame 连调两次与一次相同
  const snapshotAfter = controller.currentFrameId;
  controller.clearSequenceFrame();
  controller.clearSequenceFrame();
  assert.equal(controller.currentFrameId, snapshotAfter, '重复 clearSequenceFrame 不该产生任何变化');
  assert.equal(controller.posture, 'sit', '重复 clearSequenceFrame 不许改姿态');

  // 非法输入必须返回 false（不许静默当成功）
  assert.equal(controller.showFrame(''), false, '空帧 id 必须被拒');
  assert.equal(controller.showFrame('not-a-pose-frame'), false, '姿态清单里没有的帧必须被拒');
  assert.equal(controller.isSequenceFrameActive, false, '被拒的 showFrame 不许把姿态层借走');
});
