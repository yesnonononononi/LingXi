/**
 * 序列（sequence）资产 + 运行时的契约单测（T05/B1）。
 *
 * <p><b>它守两类"静默错"：</b></p>
 * <ol>
 *   <li><b>加载期非法值必须炸</b>：缺字段 / 负数 / 帧 id 不存在 / 时序倒流——这四种错如果
 *       被"读不到就当 0"糊过去，运行时就会按错的时序演一遍，而所有判据全绿；</li>
 *   <li><b>门禁要有判别力</b>：G-S1（清单与磁盘对齐）与 G-S2（编排完整性）各造一个坏样本，
 *       必须**真的红**。只会说 OK 的门禁等于没有门禁（本仓已有前科）。</li>
 * </ol>
 *
 * <p>另有几条小结论顺手钉住：`stageToCss` 的换算值（`400 × 0.15234375 × 2 = 122`，与设计
 * §7.6 实测逐值一致）、导演的循环推进、`lxa://` 的 host 白名单语义。</p>
 *
 * <p>运行：`npx tsx --test tests/petSequenceManifest.test.ts`（登记进 `test:pet` 归主理人）。</p>
 *
 * @module tests/petSequenceManifest
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PET_GEOMETRY, ART_ORIGIN } from '../src/pet/layout';
import { PET_POSES } from '../src/pet/poses/manifest';
import {
  PET_SEQUENCES,
  SEQUENCE_SCHEMA_KEYS,
  companionBoxOf,
  frameFileOf,
  layerOf,
  loadPetSequences,
  normalizePetSequences,
  sceneIdsOf,
  sceneOf,
  stageToCssOf,
} from '../src/pet/sequences/manifest';
import { SequenceDirector, DomSequenceLayer, sceneDurationOf, stepIndexAt } from '../src/pet/sequences/director';
import type { PetSequences, SequenceFrameFile, SequenceLayerPort, SequenceScene, SequenceSceneEnd } from '../src/pet/sequences/types';
import { SEQUENCE_SCHEMA_KEYS as BUILD_SCHEMA_KEYS, runSequenceGate } from '../scripts/check-pet-sequences.mjs';
import { DEFAULT_SEQUENCE_OUT_DIR, SEQUENCES_JSON_PATH } from '../scripts/build-pet-sequences.mjs';
import { SEQUENCE_TOTAL_MAX_BYTES } from '../scripts/pet-budget.mjs';

/** `frontend/` 根。 */
const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 已提交清单的原文（每例都从它克隆，避免互相污染）。 */
const COMMITTED = JSON.parse(readFileSync(SEQUENCES_JSON_PATH, 'utf8')) as Record<string, any>;

/**
 * 深拷贝（清单只有 JSON 值，够用）。
 *
 * @param value 源对象
 * @returns 副本
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 取一份可改的清单副本。
 *
 * @returns 副本
 */
function rawSequences(): Record<string, any> {
  return clone(COMMITTED) as Record<string, any>;
}

/** 造一个"形似"的伙伴层端口，记录每一次调用。 */
class RecordingLayer implements SequenceLayerPort {
  /** 收到的帧（按顺序）。 */
  readonly frames: (SequenceFrameFile | null)[] = [];

  /** 收到的位置（按顺序）。 */
  readonly placements: { left: number; top: number; width: number; height: number }[] = [];

  /** `stop()` 次数。 */
  stops = 0;

  setFrame(frame: SequenceFrameFile | null): void {
    this.frames.push(frame);
  }

  setPlacement(box: { left: number; top: number; width: number; height: number } | null): void {
    if (box !== null) this.placements.push(box);
  }

  stop(): void {
    this.stops += 1;
  }
}

/**
 * 造一个可注入时钟的导演。
 *
 * @param options 覆盖项
 * @returns 时钟 + 层 + 导演
 */
function makeDirector(options: { base?: { centerX: number; footY: number } | null } = {}): {
  clock: { now: () => number; advance: (ms: number) => number };
  layer: RecordingLayer;
  director: SequenceDirector;
} {
  let nowMs = 0;
  const clock = {
    now: (): number => nowMs,
    advance: (ms: number): number => {
      nowMs += ms;
      return nowMs;
    },
  };
  const layer = new RecordingLayer();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion: layer },
    base: options.base === undefined ? { centerX: 1080, footY: 1454 } : options.base,
  });
  return { clock, layer, director };
}

test('S-01 已提交清单的自证：1 场景 / 8 步 / 3180 ms / 4 个 webp', () => {
  const sequences = PET_SEQUENCES;
  assert.deepEqual(sceneIdsOf(sequences), ['cloud_react'], 'B1 只有 cloud_react 一个场景');
  const scene = sceneOf(sequences, 'cloud_react');
  assert.ok(scene !== null, 'cloud_react 必须存在');
  assert.equal(scene.steps.length, 8, 'cloud_react 是 8 步（美术 gif-v1 manifest 原文）');
  assert.equal(sceneDurationOf(scene), 3180, '总时长 3.18 s（设计 §7.7 的验收判据）');
  assert.deepEqual(Object.keys(sequences.frames).sort(), [
    'cloud_react/happy@1x.webp',
    'cloud_react/happy@2x.webp',
    'cloud_react/neutral@1x.webp',
    'cloud_react/neutral@2x.webp',
  ]);
  assert.equal(sequences.totals.steps, 8);
  assert.equal(sequences.totals.durationMs, 3180);
  const bytes = sequences.totals.bytes1x + sequences.totals.bytes2x;
  assert.ok(bytes > 0 && bytes < SEQUENCE_TOTAL_MAX_BYTES, `合计 ${bytes} B 必须落在预算内`);
  // 设计 §7.6 实测：cloud_happy @2x = 3,906 B（逐字节对上，证明无损口径与 pose 同源）
  assert.equal(sequences.frames['cloud_react/happy@2x.webp']?.bytes, 3906, 'cloud_happy@2x 应为 3,906 B（设计 §7.6 实测值）');
  assert.equal(sequences.frames['cloud_react/happy@2x.webp']?.width, 122, '目标宽 122 = round(400 × stageToCss × 2)');
});

test('S-02 比例：stageToCss 与 pose 的 nativeToCss 同值（同一舞台坐标系）', () => {
  assert.equal(
    PET_SEQUENCES.scale.stageToCss,
    PET_POSES.scale.nativeToCss,
    '序列舞台与姿态 native 必须共用同一比例（否则云朵与坐着的主角会错位）',
  );
  assert.equal(stageToCssOf(400, PET_SEQUENCES.scale), 400 * PET_POSES.scale.nativeToCss);
});

test('S-03 缺字段 ⇒ TypeError（逐个点名）', () => {
  const cases: [string, (raw: Record<string, any>) => void][] = [
    ['scale 缺失', (raw) => delete raw.scale],
    ['stage 缺失', (raw) => delete raw.stage],
    ['layers 缺失', (raw) => delete raw.layers],
    ['scenes 缺失', (raw) => delete raw.scenes],
    ['frames 缺失', (raw) => delete raw.frames],
    ['provenance 缺失', (raw) => delete raw.provenance],
    ['step.ms 缺失', (raw) => delete raw.scenes.cloud_react.steps[0].ms],
    ['step.frames 缺失', (raw) => delete raw.scenes.cloud_react.steps[0].frames],
    ['帧条目的 sha256 缺失', (raw) => delete raw.frames['cloud_react/neutral@1x.webp'].sha256],
  ];
  for (const [label, mutate] of cases) {
    const raw = rawSequences();
    mutate(raw);
    assert.throws(() => normalizePetSequences(raw), TypeError, `${label} 必须抛 TypeError`);
  }
});

test('S-04 负数 ⇒ TypeError（尺寸 / 时长 / 字节）', () => {
  const cases: [string, (raw: Record<string, any>) => void][] = [
    ['stage.width 为负', (raw) => (raw.stage.width = -1280)],
    ['layer.canvas.width 为负', (raw) => (raw.layers[0].canvas.width = -400)],
    ['step.ms 为负', (raw) => (raw.scenes.cloud_react.steps[0].ms = -100)],
    ['frame.bytes 为负', (raw) => (raw.frames['cloud_react/neutral@1x.webp'].bytes = -1)],
    ['scale.stageToCss 为负', (raw) => (raw.scale.stageToCss = -0.15)],
  ];
  for (const [label, mutate] of cases) {
    const raw = rawSequences();
    mutate(raw);
    assert.throws(() => normalizePetSequences(raw), TypeError, `${label} 必须抛 TypeError`);
  }
});

test('S-05 帧 id 不存在 ⇒ TypeError（查不到就判红，不许跳过）', () => {
  const raw = rawSequences();
  raw.scenes.cloud_react.steps[2].frames.companion = 'missing_slot';
  assert.throws(
    () => normalizePetSequences(raw),
    (err: unknown) => err instanceof TypeError && /不存在的帧/.test((err as Error).message),
    '引用未登记的 slot 必须抛 TypeError 并点名"不存在的帧"',
  );

  const raw2 = rawSequences();
  // 删掉 2x 档但 step 仍引用它 ⇒ 同样必须炸（缺一档 = 高清屏上白屏）
  delete raw2.frames['cloud_react/happy@2x.webp'];
  raw2.totals.bytes2x -= 3906;
  assert.throws(() => normalizePetSequences(raw2), TypeError, '缺 @2x 档也必须抛 TypeError');
});

test('S-06 时序倒流 ⇒ TypeError（0 / 非数都会让累计时长不再递增）', () => {
  for (const bad of [0, Number.NaN, 'abc']) {
    const raw = rawSequences();
    raw.scenes.cloud_react.steps[1].ms = bad;
    assert.throws(
      () => normalizePetSequences(raw),
      (err: unknown) => err instanceof TypeError && /ms/.test((err as Error).message),
      `step.ms=${String(bad)} 必须抛 TypeError`,
    );
  }
});

test('S-07 未声明的键 ⇒ TypeError（静默忽略一个字段=按错的方式演一遍）', () => {
  const raw = rawSequences();
  raw.scenes.cloud_react.steps[0].dy2 = -3;
  assert.throws(() => normalizePetSequences(raw), TypeError);

  const raw2 = rawSequences();
  raw2.scenes.cloud_react.autoPlay = true;
  assert.throws(() => normalizePetSequences(raw2), TypeError);
});

test('S-08 loop / onEnd 自洽：循环场景声明 onEnd 必须炸，一次性场景不写 onEnd 也必须炸', () => {
  const looping = rawSequences();
  looping.scenes.cloud_react.onEnd = 'hold-last';
  assert.throws(() => normalizePetSequences(looping), TypeError, 'loop=true 却声明 onEnd 自相矛盾');

  const once = rawSequences();
  once.scenes.cloud_react.loop = false;
  assert.throws(() => normalizePetSequences(once), TypeError, 'loop=false 必须显式声明 onEnd');
});

test('S-09 totals 必须自证（改时长不改 totals ⇒ RangeError）', () => {
  const raw = rawSequences();
  raw.scenes.cloud_react.steps[0].ms = 1200;
  assert.throws(
    () => normalizePetSequences(raw),
    (err: unknown) => err instanceof RangeError && /durationMs/.test((err as Error).message),
    '改了一步时长却不改 totals.durationMs：必须红（否则"清单说自己 3180ms"就是一句空话）',
  );
});

test('S-10 schema 白名单两份实现逐项相等（TS ↔ 构建期）', () => {
  assert.deepEqual(
    Object.keys(SEQUENCE_SCHEMA_KEYS).sort(),
    Object.keys(BUILD_SCHEMA_KEYS).sort(),
    '两个模块的层名必须一致',
  );
  for (const layer of Object.keys(SEQUENCE_SCHEMA_KEYS)) {
    assert.deepEqual(
      [...(SEQUENCE_SCHEMA_KEYS[layer] ?? [])].sort(),
      [...(BUILD_SCHEMA_KEYS[layer] ?? [])].sort(),
      `层 ${layer} 的允许键必须逐项相等（改一处漏一处 = 运行时与门禁各说各话）`,
    );
  }
});

test('S-11 导演：按前缀和推进、循环回绕、dy 逐帧重算（不累加）', () => {
  const scene: SequenceScene | null = sceneOf(PET_SEQUENCES, 'cloud_react');
  assert.ok(scene !== null);
  assert.equal(stepIndexAt(scene, 0), 0);
  assert.equal(stepIndexAt(scene, 999), 0, '第 0 步 1000ms：999 还在第 0 步');
  assert.equal(stepIndexAt(scene, 1000), 1, '边界归下一步');
  assert.equal(stepIndexAt(scene, 2179), 6, '前缀和 1000/1080/1160/1320/1400/1480/2180/3180');
  assert.equal(stepIndexAt(scene, 3180), 7, '越界夹到末步（循环取模由 tick 负责）');

  const { clock, layer, director } = makeDirector();
  const report = director.play('cloud_react');
  assert.deepEqual(report, { sceneId: 'cloud_react', steps: 8, durationMs: 3180 });
  assert.equal(director.stepIndex, 0);
  assert.equal(layer.frames.length, 1, 'play 立刻推第 0 步');

  director.tick(clock.advance(1000));
  assert.equal(director.stepIndex, 1, '累计 1000ms 进入第 1 步');
  director.tick(clock.advance(1000)); // 累计 2000ms
  assert.equal(director.stepIndex, 6, '累计 2000ms 落在第 6 步（前缀 2180 > 2000）');

  // 走完一整圈 ⇒ 回到第 0 步（loop=true；累计 3180 取模得 0）
  director.tick(clock.advance(1180));
  assert.equal(director.stepIndex, 0, '循环场景走满一圈回到第 0 步');

  // dy 不累加：同一一步算两次，盒子必须**逐位相同**
  const companion = layerOf(PET_SEQUENCES, 'companion');
  assert.ok(companion !== null);
  const step3 = scene.steps[3];
  const boxA = companionBoxOf({ step: step3, layer: companion, sequences: PET_SEQUENCES, base: { centerX: 1080, footY: 1454 } });
  const boxB = companionBoxOf({ step: step3, layer: companion, sequences: PET_SEQUENCES, base: { centerX: 1080, footY: 1454 } });
  assert.deepEqual(boxA, boxB, 'dy 每步重算，绝不在上一次结果上累加（否则云朵会越飞越高）');
  director.stop();
  assert.equal(director.isPlaying, false);
  assert.equal(director.snapshot().sceneId, null);
});

test('S-12 导演：dy −14 舞台 = −2.13 CSS（设计 §7.7 判据 ②）', () => {
  const companion = layerOf(PET_SEQUENCES, 'companion');
  assert.ok(companion !== null);
  const base = { centerX: 1080, footY: 1454 };
  const flat = rawSequences();
  const stepNeutral: Record<string, any> = clone(flat.scenes.cloud_react.steps[0]);
  const stepPeak: Record<string, any> = clone(flat.scenes.cloud_react.steps[3]);
  const boxFlat = companionBoxOf({ step: stepNeutral as any, layer: companion, sequences: PET_SEQUENCES, base });
  const boxPeak = companionBoxOf({ step: stepPeak as any, layer: companion, sequences: PET_SEQUENCES, base });
  assert.ok(boxFlat !== null && boxPeak !== null);
  const deltaCss = boxPeak.top - boxFlat.top;
  assert.ok(
    Math.abs(deltaCss + 2.13) < 0.01,
    `轻跳位移应为 −2.13 CSS，实际 ${deltaCss.toFixed(4)}（-14 stage × 0.15234375）`,
  );
  const origin = ART_ORIGIN(PET_GEOMETRY);
  assert.ok(
    Math.abs(boxFlat.left - (origin.x + (1080 - 200) * PET_SEQUENCES.scale.stageToCss)) < 1e-9,
    'left = (centerX − canvas/2) × stageToCss + origin.x',
  );
  assert.ok(Math.abs(boxFlat.width - 400 * PET_SEQUENCES.scale.stageToCss) < 1e-9, 'width = 400 × stageToCss');
});

test('S-13 导演：非法场景名 ⇒ TypeError（不许静默返回）', () => {
  const { director } = makeDirector();
  assert.throws(() => director.play('play_cloud'), TypeError, 'play_cloud 属 B2：清单里没有它就必须炸');
  assert.throws(() => director.play(''), TypeError);
});

test('S-14 伙伴帧只取登记过的层与密度（跨层取帧返回 null）', () => {
  const file = frameFileOf(PET_SEQUENCES, 'cloud_react', 'companion', 'happy', '2x');
  assert.ok(file !== null);
  assert.equal(file.layer, 'companion');
  assert.match(file.url, /^lxa:\/\/pet-sequences\/cloud_react\/happy@2x\.webp$/);
  assert.equal(frameFileOf(PET_SEQUENCES, 'cloud_react', 'hands', 'happy', '2x'), null, '层对不上就 null，不静默跨层取帧');
  assert.equal(frameFileOf(PET_SEQUENCES, 'cloud_react', 'companion', 'nope', '2x'), null);
});

test('S-15 DomSequenceLayer：新元素、行内样式、隐藏/换帧/停止', () => {
  const created: any[] = [];
  const hostChildren: any[] = [];
  const fakeDoc = {
    createElement: (tag: string) => {
      const element = {
        tagName: tag,
        src: '',
        hidden: false,
        dataset: {} as Record<string, string | undefined>,
        attributes: {} as Record<string, string>,
        styleValues: {} as Record<string, string>,
        style: {
          setProperty(name: string, value: string): void {
            element.styleValues[name] = value;
          },
        },
        setAttribute(name: string, value: string): void {
          element.attributes[name] = value;
        },
        getAttribute(name: string): string | null {
          return element.attributes[name] ?? null;
        },
        appendChild(): unknown {
          return null;
        },
      };
      created.push(element);
      return element;
    },
  };
  const host = {
    appendChild: (child: any): unknown => {
      hostChildren.push(child);
      return child;
    },
  };
  const layer = new DomSequenceLayer({
    doc: fakeDoc as any,
    host: host as any,
    layerId: 'companion',
    density: '2x',
  });
  assert.equal(created.length, 1, '只新建 1 个元素（换帧不新建元素 = 不双影）');
  assert.equal(hostChildren.length, 1, '必须挂到 host 上');
  const element = created[0];
  assert.equal(element.hidden, true, '初始必须隐藏');
  assert.equal(element.attributes['data-sequence-layer'], 'companion');
  assert.equal(element.styleValues['pointer-events'], 'none', '序列层不许吃掉鼠标事件');
  assert.equal(element.styleValues['z-index'], '2', 'z-index 必须 < 3（调试面板），否则把后门按钮盖住');

  const file = frameFileOf(PET_SEQUENCES, 'cloud_react', 'companion', 'happy', '2x');
  assert.ok(file !== null);
  layer.setFrame(file);
  assert.equal(element.src, file.url);
  assert.equal(element.hidden, false);
  layer.setPlacement({ left: 10, top: 20, width: 61, height: 61 });
  assert.equal(element.styleValues.left, '10px');
  assert.equal(element.styleValues.top, '20px');
  layer.stop();
  assert.equal(element.hidden, true);
  assert.equal(created.length, 1, 'stop 也不许新建元素');
});

test('S-16 lxa:// host 白名单：生成型资产不许被 userData 影子覆盖，其余保持原序', async () => {
  const protocol = await import('../electron/lx-protocol.cjs');
  assert.deepEqual(protocol.SHIPPED_ASSET_HOSTS, ['pet-poses', 'pet-sequences']);
  const groups = { user: ['user-live2d'], builtin: ['dist-live2d'] };
  assert.deepEqual(protocol.selectBasesForHost('pet-sequences', groups), ['dist-live2d'], '生成型资产只读内置根');
  assert.deepEqual(protocol.selectBasesForHost('pet-poses', groups), ['dist-live2d'], '与 pet-poses 同构');
  assert.deepEqual(protocol.selectBasesForHost('my-model', groups), ['user-live2d', 'dist-live2d'], '用户模型仍可覆盖');
  assert.deepEqual(protocol.selectBasesForHost('PET-SEQUENCES', groups), ['dist-live2d'], 'host 大小写不敏感');
});

test('S-17 预算常量有真消费者：超 1 字节必须被 G-S3 判红', async () => {
  const gate = await import('../scripts/check-pet-sequences.mjs');
  assert.equal(SEQUENCE_TOTAL_MAX_BYTES, 2 * 1024 * 1024, '裁决值：2 MiB（cloud_react 5~11 KB、play_cloud 约 407 KB，留 5 倍余量）');
  const atLimit = gate.checkVolume({ totals: { bytes1x: SEQUENCE_TOTAL_MAX_BYTES, bytes2x: 0 } });
  assert.deepEqual(atLimit, [], '= 上限必须放行（判据是 ≤，不是 <）');
  const over = gate.checkVolume({ totals: { bytes1x: SEQUENCE_TOTAL_MAX_BYTES, bytes2x: 1 } });
  assert.equal(over.length, 1, '上限 + 1 必须报错（空门比没有门更糟）');
  assert.match(over[0], /超过预算/);
});

/**
 * 把已提交的清单与运行目录复制到临时目录，供"坏样本必须红"用。
 *
 * @param mutate 对副本做的破坏
 * @returns 临时根目录
 */
function makeTempFixture(mutate: (paths: { manifestPath: string; outDir: string }) => void): {
  root: string;
  manifestPath: string;
  outDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'kou-seq-'));
  const outDir = join(root, 'pet-sequences');
  cpSync(DEFAULT_SEQUENCE_OUT_DIR, outDir, { recursive: true });
  const manifestPath = join(root, 'pet-sequences.json');
  cpSync(SEQUENCES_JSON_PATH, manifestPath);
  mutate({ manifestPath, outDir });
  return { root, manifestPath, outDir };
}

/**
 * 列出一个目录下所有 webp（相对路径）。
 *
 * @param dir 目录
 * @returns 相对路径
 */
function listWebp(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.webp')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test('S-18 G-S1 判别力：缺文件 / 多文件 / 篡改字节，各造一个坏样本必须红', async () => {
  // 基线：未改动的副本必须绿（证明后面三条红是"改动导致的"，不是"临时目录里本来就红"）
  const clean = makeTempFixture(() => {});
  try {
    const ok = await runSequenceGate({ sequencesJsonPath: clean.manifestPath, outDir: clean.outDir });
    assert.equal(ok.ok, true, `干净副本必须通过：\n${ok.problems.join('\n')}`);
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }

  // ① 缺文件
  const missing = makeTempFixture(({ outDir }) => {
    const target = join(outDir, 'cloud_react', 'happy@2x.webp');
    assert.ok(existsSync(target), '夹具前置：文件必须在');
    unlinkSync(target);
  });
  try {
    const result = await runSequenceGate({ sequencesJsonPath: missing.manifestPath, outDir: missing.outDir });
    assert.equal(result.ok, false, '删掉一个 webp 后门禁必须红');
    assert.ok(
      result.problems.some((line: string) => line.includes('缺少运行产物')),
      `必须点名"缺少运行产物"，实际：\n${result.problems.join('\n')}`,
    );
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }

  // ② 多文件（孤儿）
  const extra = makeTempFixture(({ outDir }) => {
    writeFileSync(join(outDir, 'cloud_react', 'ghost@2x.webp'), Buffer.alloc(64, 0));
  });
  try {
    const result = await runSequenceGate({ sequencesJsonPath: extra.manifestPath, outDir: extra.outDir });
    assert.equal(result.ok, false, '盘上多出未登记的 webp 必须红');
    assert.ok(
      result.problems.some((line: string) => line.includes('多出未被清单引用')),
      `必须点名"多出未被清单引用"，实际：\n${result.problems.join('\n')}`,
    );
  } finally {
    rmSync(extra.root, { recursive: true, force: true });
  }

  // ③ 篡改字节（sha256 / 字节数漂移）
  const tampered = makeTempFixture(({ outDir }) => {
    const file = listWebp(outDir).find((path) => path.endsWith('neutral@1x.webp'));
    assert.ok(file !== undefined, '夹具前置：neutral@1x 必须在');
    const bytes = Buffer.from([...Buffer.alloc(16, 7)]);
    writeFileSync(file, bytes);
  });
  try {
    const result = await runSequenceGate({ sequencesJsonPath: tampered.manifestPath, outDir: tampered.outDir });
    assert.equal(result.ok, false, '篡改后的 webp 必须红');
    assert.ok(
      result.problems.some((line: string) => line.includes('不是合法 WebP') || line.includes('漂移')),
      `必须点名格式/漂移问题，实际：\n${result.problems.join('\n')}`,
    );
  } finally {
    rmSync(tampered.root, { recursive: true, force: true });
  }
});

test('S-19 G-S2 判别力：时序倒流 / 帧引用不存在，各造一个坏样本必须红', async () => {
  const brokenTiming = makeTempFixture(({ manifestPath }) => {
    const raw = rawSequences();
    raw.scenes.cloud_react.steps[4].ms = 0;
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  });
  try {
    const result = await runSequenceGate({ sequencesJsonPath: brokenTiming.manifestPath, outDir: brokenTiming.outDir });
    assert.equal(result.ok, false, 'step.ms=0 必须红');
    assert.ok(
      result.problems.some((line: string) => line.includes('时序必须单调递增')),
      `必须点名时序，实际：\n${result.problems.join('\n')}`,
    );
  } finally {
    rmSync(brokenTiming.root, { recursive: true, force: true });
  }

  const brokenFrame = makeTempFixture(({ manifestPath }) => {
    const raw = rawSequences();
    raw.scenes.cloud_react.steps[5].frames.companion = 'ghost';
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  });
  try {
    const result = await runSequenceGate({ sequencesJsonPath: brokenFrame.manifestPath, outDir: brokenFrame.outDir });
    assert.equal(result.ok, false, '引用不存在的帧 slot 必须红');
    assert.ok(
      result.problems.some((line: string) => line.includes('引用了不存在的帧')),
      `必须点名"引用了不存在的帧"，实际：\n${result.problems.join('\n')}`,
    );
  } finally {
    rmSync(brokenFrame.root, { recursive: true, force: true });
  }
});

test('S-20 加载器单例即校验：loadPetSequences() 与 PET_SEQUENCES 同源', () => {
  const reloaded = loadPetSequences();
  assert.deepEqual(reloaded.totals, PET_SEQUENCES.totals);
  assert.equal(reloaded.provenance.manifestSha256, PET_SEQUENCES.provenance.manifestSha256);
  assert.equal(PET_SEQUENCES.provenance.adapter, 'gif-v1-steps');
  assert.ok(
    PET_SEQUENCES.deferred.some((item) => item.scene === 'play_cloud'),
    'play_cloud 必须在 deferred 里（"没做"要说出来，不是靠类型里没有它）',
  );
  assert.equal(resolve(FRONTEND_ROOT, 'pet-sequences.json'), SEQUENCES_JSON_PATH, '清单路径只有一处定义');
});
/**
 * 造一个**按浏览器口径判可见**的假元素宿主。
 *
 * <p><b>为什么要专门做这个（而不是复用 S-15 的假元素）：</b>真浏览器里 `hidden` 属性靠
 * UA 样式表 `[hidden] { display: none }` 生效，而**行内作者样式 `display: block` 会把它
 * 打败**。S-15 的假元素只记 `hidden` 布尔值，于是"只写 `hidden`、从不写 `display`"的坏实现
 * 在测试里**永远是绿的**——真机上却留着一朵云（`stop()` 后 150 ms 读到
 * `{ src: 'neutral@1x.webp', display: 'block' }`）。这里的 {@link isVisuallyVisible} 按
 * "行内 `display` 优先、未写才看 `hidden`"判定，与层叠规则一致。</p>
 *
 * @returns `doc` / `host` / 造出来的元素列表
 */
function makeDomHarness(): { doc: any; host: any; elements: any[] } {
  const elements: any[] = [];
  const doc = {
    createElement: (tag: string): any => {
      const element: any = {
        tagName: tag,
        src: '',
        hidden: false,
        styleValues: {} as Record<string, string>,
        attributes: {} as Record<string, string>,
        style: {
          setProperty(name: string, value: string): void {
            element.styleValues[name] = value;
          },
        },
        setAttribute(name: string, value: string): void {
          element.attributes[name] = value;
        },
        getAttribute(name: string): string | null {
          return element.attributes[name] ?? null;
        },
        appendChild: (): unknown => null,
      };
      elements.push(element);
      return element;
    },
  };
  const host = {
    appendChild: (child: any): unknown => child,
  };
  return { doc, host, elements };
}

/**
 * 与浏览器同口径的可见性判定：**行内 `display` 优先**，没写过 `display` 才看 `hidden`。
 *
 * @param element 假元素
 * @returns 用户是否看得见
 */
function isVisuallyVisible(element: any): boolean {
  const display = element.styleValues['display'];
  if (display === undefined) return element.hidden !== true;
  return display !== 'none';
}

/**
 * 可手摇时钟（序列导演不自己读时钟，这是它能被毫秒级复现的前提）。
 *
 * @returns 时钟 + 推进器
 */
function makeClock(): { now: () => number; advance: (ms: number) => number } {
  let nowMs = 0;
  return {
    now: (): number => nowMs,
    advance: (ms: number): number => {
      nowMs += ms;
      return nowMs;
    },
  };
}

/**
 * 造一份"含一次性 `return-stand` 场景"的合成清单（验证**自然播完**的收尾路径）。
 *
 * <p>帧表沿用已提交的 `neutral` 那一帧，只把键与 `url` 换成新场景 id，并同步
 * `totals`（`bytes1x/bytes2x/scenes/steps/durationMs` 必须自证）——这样合成清单仍然走
 * **真正的** `normalizePetSequences`，而不是手搓一个"运行时并不存在"的半成品对象。</p>
 *
 * @returns 合成清单（`cloud_react` + `cloud_once`）
 */
function sequencesWithOneShot(): PetSequences {
  const raw = rawSequences();
  const onceMs = 200;
  for (const density of ['1x', '2x'] as const) {
    const source = raw.frames[`cloud_react/neutral@${density}.webp`] as Record<string, any>;
    raw.frames[`cloud_once/neutral@${density}.webp`] = {
      layer: source.layer,
      slot: source.slot,
      width: source.width,
      height: source.height,
      bytes: source.bytes,
      sha256: source.sha256,
      format: source.format,
      url: `lxa://pet-sequences/cloud_once/neutral@${density}.webp`,
    };
    if (density === '1x') raw.totals.bytes1x += source.bytes;
    else raw.totals.bytes2x += source.bytes;
  }
  raw.scenes.cloud_once = {
    loop: false,
    onEnd: 'return-stand',
    steps: [{ ms: onceMs, frames: { companion: 'neutral' } }],
  };
  raw.totals.scenes += 1;
  raw.totals.steps += 1;
  raw.totals.durationMs += onceMs;
  return normalizePetSequences(raw);
}

test('S-21 缺陷回归：play → stop 之后伙伴层必须从视觉上撤掉（display 必须是 none）', () => {
  const { doc, host, elements } = makeDomHarness();
  const layer = new DomSequenceLayer({ doc: doc as any, host: host as any, layerId: 'companion', density: '2x' });
  const clock = makeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion: layer },
    base: { centerX: 1080, footY: 1454 },
  });
  director.play('cloud_react');
  clock.advance(500);
  director.tick(clock.now());
  assert.equal(isVisuallyVisible(elements[0]), true, '反向断言：play 之后该层必须可见（见 S-24）');
  director.stop();
  assert.equal(
    elements[0].styleValues['display'],
    'none',
    'stop 之后行内 display 必须是 none —— 只写 hidden 会被构造时的 display:block 打败（真机表现：停止后窗上留一朵云）',
  );
  assert.equal(elements[0].hidden, true, 'hidden 属性也要写上（语义与 display 一起走，不只靠 stylesheet）');
  assert.equal(isVisuallyVisible(elements[0]), false, '关键判据：stop 之后用户在窗口上看不到任何序列层');
  assert.equal(director.snapshot().playing, false, '导演自己也要回到"未播放"');
  assert.equal(director.snapshot().sceneId, null);
});

test('S-22 幂等：连续两次 stop() 不抛错、最终仍不可见（导演与层各自都幂等）', () => {
  const { doc, host, elements } = makeDomHarness();
  const layer = new DomSequenceLayer({ doc: doc as any, host: host as any, layerId: 'companion', density: '1x' });
  const clock = makeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion: layer },
    base: { centerX: 1080, footY: 1454 },
  });
  director.play('cloud_react');
  clock.advance(400);
  director.tick(clock.now());
  assert.equal(isVisuallyVisible(elements[0]), true, '前置：这一轮确实在播（否则本用例证明不了"幂等"）');
  assert.doesNotThrow(() => director.stop(), '第一次 stop 不许抛');
  assert.doesNotThrow(() => director.stop(), '第二次 stop 不许抛（幂等门）');
  assert.equal(isVisuallyVisible(elements[0]), false, '两次 stop 之后必须仍然不可见');
  // 层自己也停两次：即使绕开导演直接停，也不许抛错、不许变回可见
  assert.doesNotThrow(() => layer.stop(), '层 stop 第二次不许抛');
  assert.doesNotThrow(() => layer.stop(), '层 stop 第三次不许抛');
  assert.equal(isVisuallyVisible(elements[0]), false, '层反复 stop 之后仍然不可见');
  assert.equal(elements.length, 1, 'stop 不许新建元素（新建 = 双影）');
});

test('S-23 幂等：未 play 直接 stop() 不抛错，且不会把层弄成可见', () => {
  const { doc, host, elements } = makeDomHarness();
  const layer = new DomSequenceLayer({ doc: doc as any, host: host as any, layerId: 'companion', density: '1x' });
  const clock = makeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion: layer },
    base: { centerX: 1080, footY: 1454 },
  });
  assert.equal(isVisuallyVisible(elements[0]), false, '构造完就该是不可见的');
  assert.doesNotThrow(() => director.stop(), '没 play 就 stop 不许抛');
  assert.equal(isVisuallyVisible(elements[0]), false, '没 play 就 stop 也不许留下可见残留');
  // 停过之后照样能正常播：状态没有被 stop 弄坏
  director.play('cloud_react');
  assert.equal(isVisuallyVisible(elements[0]), true, 'stop 之后 play 必须能重新显示（幂等不许把状态机搞死）');
});

test('S-24 反向断言：play 之后该层必须可见（防"永远隐藏"的坏实现骗过绿）', () => {
  const { doc, host, elements } = makeDomHarness();
  const layer = new DomSequenceLayer({ doc: doc as any, host: host as any, layerId: 'companion', density: '2x' });
  const clock = makeClock();
  const director = new SequenceDirector({
    sequences: PET_SEQUENCES,
    clock,
    layers: { companion: layer },
    base: { centerX: 1080, footY: 1454 },
  });
  director.play('cloud_react');
  assert.equal(elements[0].styleValues['display'], 'block', 'play 之后行内 display 必须是 block');
  assert.equal(elements[0].hidden, false, 'play 之后 hidden 必须是 false');
  assert.equal(isVisuallyVisible(elements[0]), true);
  const firstUrl = elements[0].src as string;
  assert.equal(firstUrl, frameFileOf(PET_SEQUENCES, 'cloud_react', 'companion', 'neutral', '2x')?.url, '首帧就是清单里 neutral@2x');
  // 换帧（第 4 步是 happy，落在 1000+80+80+160 之后的第 4 步之前的边界内）后必须仍然可见
  clock.advance(1200);
  director.tick(clock.now());
  assert.equal(isVisuallyVisible(elements[0]), true, '换帧之后仍然可见');
  assert.notEqual(elements[0].src, firstUrl, '换帧必须真的换 src（否则"永远隐藏"之外还有"永远同一帧"这种坏实现）');
});

test('S-25 收尾出口同源：一次性 return-stand 场景自然播完后，伙伴层必须不可见', () => {
  const sequences = sequencesWithOneShot();
  const { doc, host, elements } = makeDomHarness();
  const layer = new DomSequenceLayer({ doc: doc as any, host: host as any, layerId: 'companion', density: '1x' });
  const clock = makeClock();
  const ends: string[] = [];
  const director = new SequenceDirector({
    sequences,
    clock,
    layers: { companion: layer },
    base: { centerX: 1080, footY: 1454 },
    onSceneEnd: (sceneId: string, onEnd: SequenceSceneEnd) => {
      ends.push(`${sceneId}:${onEnd}`);
    },
  });
  director.play('cloud_once');
  assert.equal(isVisuallyVisible(elements[0]), true, '前置：一次性场景播放中该层必须可见');
  clock.advance(200 + 50);
  director.tick(clock.now());
  assert.deepEqual(ends, ['cloud_once:return-stand'], '自然播完必须回调 onSceneEnd（收尾接线没断）');
  assert.equal(director.snapshot().playing, false, '播完就不是"在播"了');
  assert.equal(
    isVisuallyVisible(elements[0]),
    false,
    'return-stand 收尾必须真的撤层（与 stop() 走同一出口：只写 hidden 会被 display:block 打败）',
  );
});

