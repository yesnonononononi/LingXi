/**
 * 动作目录与编译器单测（纯函数 + 字符串断言，不碰 DOM、不用假时钟）。
 *
 * <p>三块内容：</p>
 * <ol>
 *   <li><b>等值迁移证明</b>：`deriveMotionRecipes(空目录)` 与 `deriveMotionRecipes(首版目录)`
 *       都必须与 `BUILTIN_MOTION_RECIPES` <b>深度相等</b>——这是 M2 唯一能证明"行为没变"的手段；</li>
 *   <li><b>目录校验</b>：设计文档 §1.7 的六条规则逐条反向验证（坏目录必须被点名）；</li>
 *   <li><b>编译输出</b>：轨道数、镜像、环移滞后、弹簧过冲、减少动态、低功耗时长。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMotionsFile } from '../scripts/check-pet-layers.mjs';
import {
  BUILTIN_MOTION_RECIPES,
  EMPTY_MOTION_CATALOG,
  MOTION_CATALOG,
  deriveMotionRecipes,
  normalizeMotionCatalog,
  validateCatalog,
} from '../src/pet/layers/motion-catalog';
import type { MotionCatalog } from '../src/pet/layers/motion-catalog';
import {
  DEFAULT_LOOP_DURATION_MS,
  compileMotion,
  evaluateCurve,
  sampleSpring,
  wrapKeyframes,
} from '../src/pet/layers/motion-compiler';

/** 读仓库里的动作目录原文（与运行时同一份文件）。 */
function readCatalogSource(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'pet-motions.json'), 'utf8')) as Record<string, unknown>;
}

/** 深拷贝运行时目录，便于做"坏目录"变体。 */
function cloneCatalog(): MotionCatalog {
  return JSON.parse(JSON.stringify(MOTION_CATALOG)) as MotionCatalog;
}

/** 取某层的关键帧规则体（用于比较镜像是否逐字相同）。 */
function keyframeBody(cssRules: readonly string[], name: string): string {
  const rule = cssRules.find((item) => item.startsWith(`@keyframes ${name} `));
  assert.ok(rule, `找不到 @keyframes ${name}`);
  return rule as string;
}

// ------------------------------------------------------------ 等值迁移证明

test('deriveMotionRecipes(空目录) 与内置表深度相等（回退路径等价）', () => {
  assert.deepEqual(deriveMotionRecipes(EMPTY_MOTION_CATALOG), BUILTIN_MOTION_RECIPES);
});

test('deriveMotionRecipes(首版目录) 与内置表深度相等（等值迁移证明）', () => {
  assert.deepEqual(deriveMotionRecipes(MOTION_CATALOG), BUILTIN_MOTION_RECIPES);
});

test('首版目录逐条对齐原 MOTION_RECIPES 的关键数值', () => {
  const recipes = deriveMotionRecipes(MOTION_CATALOG);
  assert.equal(recipes.tap.motionMs, 480);
  assert.equal(recipes.tap.expression, 'happy');
  assert.equal(recipes.tap.expressionMs, 900);
  assert.equal(recipes.wake.priority, 2);
  assert.equal(recipes.idle.loop, true);
  assert.equal(recipes.idle.motionMs, null);
  assert.equal(recipes.drag.motionMs, null);
});

test('目录删掉 tap 时回落到内置 480ms（不是 undefined）', () => {
  const catalog = cloneCatalog();
  const motions = { ...catalog.motions } as Record<string, unknown>;
  delete motions.tap;
  const broken = { ...catalog, motions } as unknown as MotionCatalog;
  const recipes = deriveMotionRecipes(broken);
  assert.equal(recipes.tap.motionMs, BUILTIN_MOTION_RECIPES.tap.motionMs);
  assert.equal(recipes.tap.motionMs, 480);
});

test('内置表是冻结的（任何写入都必须抛错，防止运行期被改）', () => {
  assert.equal(Object.isFrozen(BUILTIN_MOTION_RECIPES), true);
  assert.equal(Object.isFrozen(BUILTIN_MOTION_RECIPES.tap), true);
});

// ------------------------------------------------------------ 目录校验

test('仓库里的动作目录本身是合法的', () => {
  assert.deepEqual(validateCatalog(readCatalogSource()), []);
});

test('validateCatalog：loop=true 同时给 durationMs 必须报错', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, Record<string, unknown>>;
  motions.tap.loop = true;
  const problems = validateCatalog(source);
  assert.ok(problems.some((item) => item.includes('loop=true')), problems.join(' | '));
});

test('validateCatalog：spring 与 follow 同现必须报错', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, Record<string, unknown>>;
  const tracks = motions.tap.tracks as Record<string, unknown>[];
  tracks[0].follow = { source: 'bodySway', lagMs: 90, gain: 0.5 };
  tracks[0].spring = { stiffness: 0.2, damping: 0.1, mass: 1 };
  const problems = validateCatalog(source);
  assert.ok(problems.some((item) => item.includes('follow 与 spring')), problems.join(' | '));
});

test('validateCatalog：关键帧 at 非严格递增必须报错', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, Record<string, unknown>>;
  const tracks = motions.tap.tracks as Record<string, Record<string, unknown>[]>;
  tracks[0].keyframes = [
    { at: 0, value: 0 },
    { at: 0.5, value: 1 },
    { at: 0.5, value: 2 },
    { at: 1, value: 0 },
  ];
  const problems = validateCatalog(source);
  assert.ok(problems.some((item) => item.includes('严格递增')), problems.join(' | '));
});

test('validateCatalog：缺 tap 必须报错（防止改目录把动作改没了）', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, unknown>;
  delete motions.tap;
  const problems = validateCatalog(source);
  assert.ok(problems.some((item) => item.includes('缺少动作 tap')), problems.join(' | '));
});

test('validateCatalog：未知动作 id / 未知属性 / 未知表情都必须报错', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, Record<string, unknown>>;
  motions.flip = { priority: 1, loop: false, durationMs: 100, layer: 'base', expression: null, tracks: [] };
  const tracks = motions.tap.tracks as Record<string, unknown>[];
  tracks[0].property = 'skewX';
  motions.tap.expression = { id: 'nope', durationMs: 100 };
  const problems = validateCatalog(source);
  assert.ok(problems.some((item) => item.includes('未知动作 id')), problems.join(' | '));
  assert.ok(problems.some((item) => item.includes('property 只允许')), problems.join(' | '));
  assert.ok(problems.some((item) => item.includes('不是合法表情')), problems.join(' | '));
});

test('validateCatalog：非对象直接报错而不是抛异常', () => {
  assert.deepEqual(validateCatalog(null), ['动作目录必须是对象']);
});

/**
 * 构建期门禁与运行期校验器对同一份坏目录都能点名（两边不漂移）。
 *
 * <p>这是"两套实现必然漂移"的解药：`scripts/check-pet-layers.mjs` 是 `.mjs` 侧的门禁，
 * `layers/motion-catalog.ts` 是运行期权威，同一份好目录必须两边都过、同一份坏目录必须两边都红。</p>
 */
test('构建期门禁与运行期校验器对同一份坏目录都能点名（两边不漂移）', () => {
  const source = readCatalogSource();
  const motions = source.motions as Record<string, Record<string, unknown>>;
  motions.tap.loop = true; // 违反"loop 与 durationMs 自洽"
  const tsProblems = validateCatalog(source);
  const jsProblems = validateMotionsFile(source);
  assert.ok(tsProblems.length > 0, '运行期校验器没有报错');
  assert.ok(jsProblems.length > 0, '构建期门禁没有报错');
  const good = readCatalogSource();
  assert.deepEqual(validateCatalog(good), []);
  assert.deepEqual(validateMotionsFile(good), []);
});

test('normalizeMotionCatalog：深拷贝且结构完整', () => {
  const catalog = normalizeMotionCatalog(readCatalogSource());
  assert.equal(catalog.version, 1);
  assert.equal(catalog.defaults.samples, 12);
  assert.equal(Object.keys(catalog.motions).length, 9);
  assert.equal(catalog.motions.tap.id, 'tap');
  // M6-b 设计变更：tap = 双耳 + 蝴蝶结 + 呆毛（呆毛靠 spring 过冲回弹）
  assert.equal(catalog.motions.tap.tracks.length, 4);
});

// ------------------------------------------------------------ 编译输出

test('compileMotion(tap)：4 条轨道、480ms、选择器落在 data-layer 上', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'tap', {
    power: 'idle',
    reducedMotion: false,
    selectorRoot: "#pet-root[data-motion='tap']",
  });
  assert.equal(compiled.durationMs, 480);
  const consumers = compiled.cssRules.filter((rule) => !rule.startsWith('@keyframes'));
  // M6-b 设计变更：tap 从 3 条轨道（双耳 + 蝴蝶结）扩到 4 条，新增呆毛弹簧
  assert.equal(consumers.length, 4);
  for (const layerId of ['ear-left', 'ear-right', 'bow', 'ahoge']) {
    assert.ok(
      consumers.some((rule) => rule.includes(`[data-layer='${layerId}']`)),
      `缺少 ${layerId} 的消费规则：${consumers.join(' | ')}`,
    );
  }
  assert.deepEqual(compiled.unsupportedTracks, []);
});

test('compileMotion(tap)：左右耳是两条独立轨道（真契约 mirrored=false，不镜像）', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'tap', {
    power: 'idle',
    reducedMotion: false,
    selectorRoot: '#pet-root',
  });
  const earLeft = keyframeBody(compiled.cssRules, 'pet-motion-tap-ear-left');
  const earRight = keyframeBody(compiled.cssRules, 'pet-motion-tap-ear-right');
  // 归一化后再比：两份关键帧必须不同（右耳是单独生成的补绘）
  const normalize = (rule: string): string => rule.replace(/pet-motion-tap-ear-(left|right)/, 'NAME');
  assert.notEqual(normalize(earRight), normalize(earLeft));
});

test('compileMotion：mirror 能力仍然可用（合成测试目录里 ear-right 镜像 ear-left）', () => {
  const catalog: MotionCatalog = {
    version: 1,
    defaults: { samples: 12, maxLagMs: 320, unit: 'deg' },
    motions: {
      tap: {
        id: 'tap',
        priority: 1,
        durationMs: 480,
        loop: false,
        layer: 'base',
        expression: null,
        tracks: [
          {
            layerId: 'ear-left',
            property: 'rotate',
            keyframes: [{ at: 0, value: 0 }, { at: 1, value: -6 }],
          },
          {
            layerId: 'ear-right',
            property: 'rotate',
            mirror: 'ear-left',
            keyframes: [],
          },
        ],
      },
    },
  };
  const compiled = compileMotion(catalog, 'tap', { power: 'idle', reducedMotion: false, selectorRoot: '#pet-root' });
  const normalize = (rule: string): string => rule.replace(/pet-motion-tap-ear-(left|right)/, 'NAME');
  assert.equal(
    normalize(keyframeBody(compiled.cssRules, 'pet-motion-tap-ear-right')),
    normalize(keyframeBody(compiled.cssRules, 'pet-motion-tap-ear-left')),
  );
});

test('支撑层（底绘/遮挡片）不出现在任何动作轨道里：支撑层不接受动画指令', () => {
  const supportLayers = ['underpainting', 'body-occluder', 'foreground-occluder'];
  for (const def of Object.values(MOTION_CATALOG.motions)) {
    for (const track of def.tracks) {
      assert.equal(
        supportLayers.includes(track.layerId),
        false,
        `动作 ${def.id} 的轨道指向了支撑层 ${track.layerId}（转一下遮挡片就会露缝）`,
      );
    }
  }
});

test('compileMotion(idle)：两段尾巴各自环移（base 3.33%、tip 5%），不是单层', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'idle', {
    power: 'idle',
    reducedMotion: false,
    selectorRoot: '#pet-root',
  });
  assert.equal(compiled.durationMs, DEFAULT_LOOP_DURATION_MS);
  // 第一段：120/3600 = 3.3333%
  const baseBody = keyframeBody(compiled.cssRules, 'pet-motion-idle-tail-base');
  const basePercents = [...baseBody.matchAll(/([0-9.]+)% \{/g)].map((match) => match[1]);
  assert.deepEqual(basePercents, ['0', '3.3333', '28.3333', '53.3333', '78.3333', '100']);
  assert.ok(baseBody.includes('rotate(1.8deg)'), `未按 gain=0.6 缩放：${baseBody}`);
  // 第二段：180/3600 = 5%（两段相邻、12px 重叠带靠 z 顺序保证无缝）
  const tipBody = keyframeBody(compiled.cssRules, 'pet-motion-idle-tail-tip');
  const tipPercents = [...tipBody.matchAll(/([0-9.]+)% \{/g)].map((match) => match[1]);
  assert.deepEqual(tipPercents, ['0', '5', '30', '55', '80', '100']);
  assert.ok(tipBody.includes('rotate(-1.75deg)'), `未按 gain=0.7 缩放：${tipBody}`);
  // idle 是循环动作：消费规则必须带 infinite
  const consumer = compiled.cssRules.find((rule) => rule.includes("[data-layer='tail-base']"));
  assert.ok(consumer && consumer.includes('infinite'), String(consumer));
});

test('compileMotion：弹簧轨道被采样成 12 帧且有过冲', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'idle', {
    power: 'idle',
    reducedMotion: false,
    selectorRoot: '#pet-root',
  });
  const body = keyframeBody(compiled.cssRules, 'pet-motion-idle-ahoge');
  const frames = body.split('% {').length - 1;
  assert.equal(frames, 12);
  const values = [...body.matchAll(/rotate\((-?[0-9.]+)deg\)/g)].map((match) => Number(match[1]));
  assert.equal(values.length, 12);
  // 关键帧本身在 [-1.5, 1.5] 内，过冲必须越出这个区间
  assert.ok(Math.min(...values) < -1.5, `没有过冲：${values.join(',')}`);
  // 收尾必须基本回落到目标值：末帧偏离要远小于峰值偏离（否则动画会"停在中途"）
  const target = -1.5;
  const peakDeviation = Math.max(...values.map((value) => Math.abs(value - target)));
  const lastDeviation = Math.abs(values[values.length - 1] - target);
  assert.ok(lastDeviation < peakDeviation * 0.15, `收尾没有收敛：末帧偏离 ${lastDeviation.toFixed(3)}，峰值偏离 ${peakDeviation.toFixed(3)}`);
});

test('compileMotion：reducedMotion 时零规则（一条都不产出）', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'tap', {
    power: 'idle',
    reducedMotion: true,
    selectorRoot: '#pet-root',
  });
  assert.deepEqual(compiled.cssRules, []);
  assert.equal(compiled.durationMs, 0);
});

test('compileMotion：low 功耗档时长 ×2（视觉降频，不降帧）', () => {
  const normal = compileMotion(MOTION_CATALOG, 'tap', { power: 'idle', reducedMotion: false, selectorRoot: '#pet-root' });
  const low = compileMotion(MOTION_CATALOG, 'tap', { power: 'low', reducedMotion: false, selectorRoot: '#pet-root' });
  assert.equal(low.durationMs, normal.durationMs * 2);
  const consumer = low.cssRules.find((rule) => rule.includes("[data-layer='ear-left']"));
  assert.ok(consumer && consumer.includes('960ms'), String(consumer));
});

test('compileMotion：未知动作不抛异常，返回空规则并记录', () => {
  const compiled = compileMotion(MOTION_CATALOG, 'nope', { power: 'idle', reducedMotion: false, selectorRoot: '#pet-root' });
  assert.deepEqual(compiled.cssRules, []);
  assert.deepEqual(compiled.unsupportedTracks, ['nope']);
});

// ------------------------------------------------------------ 基础数值工具

test('wrapKeyframes：滞后为 0 时只乘增益，首尾闭合', () => {
  const frames = wrapKeyframes([{ at: 0, value: 0 }, { at: 0.5, value: 2 }, { at: 1, value: 0 }], 0, 0.5);
  assert.deepEqual(frames, [{ at: 0, value: 0 }, { at: 0.5, value: 1 }, { at: 1, value: 0 }]);
});

test('wrapKeyframes：滞后 50% 时把后半段搬到前面（环移）', () => {
  const frames = wrapKeyframes([{ at: 0, value: 0 }, { at: 0.5, value: 2 }, { at: 1, value: 0 }], 0.5, 1);
  assert.deepEqual(frames, [{ at: 0, value: 2 }, { at: 0.5, value: 0 }, { at: 1, value: 2 }]);
});

test('sampleSpring：帧数 = samples，首帧 0、末帧 1，收尾回到目标附近', () => {
  const frames = sampleSpring(
    [{ at: 0, value: -1 }, { at: 0.5, value: 1 }, { at: 1, value: -1 }],
    { stiffness: 0.18, damping: 0.12, mass: 1 },
    12,
  );
  assert.equal(frames.length, 12);
  assert.equal(frames[0].at, 0);
  assert.equal(frames[frames.length - 1].at, 1);
  assert.ok(Math.abs(frames[frames.length - 1].value + 1) < 0.1);
});

test('evaluateCurve：两端线性外插（过冲的地基）', () => {
  const curve = [{ at: 0, value: 0 }, { at: 1, value: 10 }];
  assert.equal(evaluateCurve(curve, 0), 0);
  assert.equal(evaluateCurve(curve, 1), 10);
  assert.equal(evaluateCurve(curve, 1.2), 12);
  assert.equal(evaluateCurve(curve, -0.1), -1);
});
// ------------------------------------------------------------ M6-b 分层轨道的物理参数

/**
 * 目录原文里的某个动作定义。
 *
 * @param id 动作 id
 * @returns 动作定义（未强类型，便于逐字段断言原始数值）
 */
function rawMotion(id: string): Record<string, any> {
  const source = readCatalogSource() as { motions: Record<string, Record<string, any>> };
  const def = source.motions[id];
  assert.ok(def, `目录里没有动作 ${id}`);
  return def;
}

/**
 * 取某动作里某层的轨道。
 *
 * @param motionId 动作 id
 * @param layerId 层 id
 * @returns 轨道
 */
function trackOf(motionId: string, layerId: string): Record<string, any> {
  const track = (rawMotion(motionId).tracks as Array<Record<string, any>>).find((item) => item.layerId === layerId);
  assert.ok(track, `动作 ${motionId} 缺少 ${layerId} 的轨道`);
  return track;
}

/**
 * 轨道在增益之后的有效幅值（`follow` 会乘 `gain`）。
 *
 * @param track 轨道
 * @returns 有效幅值（绝对值最大者）
 */
function effectiveAmplitude(track: Record<string, any>): number {
  const gain = track.follow && Number.isFinite(track.follow.gain) ? Number(track.follow.gain) : 1;
  const peak = Math.max(...(track.keyframes as Array<{ value: number }>).map((frame) => Math.abs(frame.value)));
  return peak * gain;
}

test('M6-b 尾巴两段传导：每个双段动作里 tail-tip 都比 tail-base 晚 60ms（120 → 180）', () => {
  const twoStage = ['idle', 'happy', 'sleepy', 'drag'];
  for (const id of twoStage) {
    const base = trackOf(id, 'tail-base');
    const tip = trackOf(id, 'tail-tip');
    assert.ok(base.follow && tip.follow, `${id}: 两段尾巴都必须用 follow 表达`);
    assert.equal(tip.follow.source, 'tail-base', `${id}: 尾梢必须挂在第一段上（传导链）`);
    assert.equal(
      Number(tip.follow.lagMs) - Number(base.follow.lagMs),
      60,
      `${id}: 两段滞后差必须 60ms（美术 tailJoin.delayMs=[120,180]）`,
    );
  }
  // 基准动作照抄美术物理参数
  assert.equal(Number(trackOf('idle', 'tail-base').follow.lagMs), 120);
  assert.equal(Number(trackOf('idle', 'tail-tip').follow.lagMs), 180);
});

test('M6-b 尾巴幅值按段递减：第二段的有效幅值必须小于第一段', () => {
  for (const id of ['idle', 'happy', 'sleepy', 'drag']) {
    const base = effectiveAmplitude(trackOf(id, 'tail-base'));
    const tip = effectiveAmplitude(trackOf(id, 'tail-tip'));
    assert.ok(tip < base, `${id}: 尾梢幅值 ${tip} 应小于尾根 ${base}（传导衰减）`);
    assert.ok(base > 0, `${id}: 尾根幅值不能是 0`);
  }
});

test('M6-b 双耳独立：每个含双耳的动作都是两条非镜像轨道，相位错开 ≥30ms', () => {
  const withEars = ['tap', 'happy', 'angry', 'sad'];
  for (const id of withEars) {
    const def = rawMotion(id);
    const left = trackOf(id, 'ear-left');
    const right = trackOf(id, 'ear-right');
    assert.equal(left.mirror, undefined, `${id}: 左耳不许用 mirror`);
    assert.equal(right.mirror, undefined, `${id}: 右耳是单独补绘件，不许用 mirror（美术 mirrored=false）`);
    // 相位 = 第一个峰值关键帧的归一化时间差 × 动作时长
    const peakAt = (track: Record<string, any>): number => {
      const frames = track.keyframes as Array<{ at: number; value: number }>;
      let best = frames[0];
      for (const frame of frames) if (Math.abs(frame.value) > Math.abs(best.value)) best = frame;
      return best.at;
    };
    const durationMs = Number(def.durationMs);
    const offsetMs = Math.abs(peakAt(right) - peakAt(left)) * durationMs;
    assert.ok(offsetMs >= 30, `${id}: 双耳相位只差 ${offsetMs.toFixed(1)}ms，会读成"机械同步"（要求 ≥30ms）`);
  }
});

test('M6-b 呆毛：tap / happy / wake / surprised / idle 都用 spring 采样出过冲', () => {
  for (const id of ['idle', 'tap', 'happy', 'surprised', 'wake']) {
    const track = trackOf(id, 'ahoge');
    assert.ok(track.spring, `${id}: 呆毛必须用 spring（过冲回弹）`);
    assert.equal(track.follow, undefined, `${id}: spring 与 follow 互斥`);
    assert.ok(Number(track.spring.stiffness) > 0 && Number(track.spring.damping) >= 0);
  }
});

test('M6-b 蝴蝶结惯性：idle/tap/happy/angry 都挂 follow{lagMs:90, gain:0.4}', () => {
  for (const id of ['idle', 'tap', 'happy', 'angry']) {
    const track = trackOf(id, 'bow');
    assert.ok(track.follow, `${id}: 蝴蝶结必须靠 follow 滞后（不是独立摆动）`);
    assert.equal(Number(track.follow.lagMs), 90, `${id}: 蝴蝶结滞后必须是 90ms`);
    assert.equal(Number(track.follow.gain), 0.4, `${id}: 蝴蝶结增益必须是 0.4`);
  }
});

test('M6-b 支撑层永不出现在任何轨道里（底绘/身体遮挡/前景遮挡只合成不动画）', () => {
  const source = readCatalogSource() as { motions: Record<string, Record<string, any>> };
  const support = ['underpainting', 'body-occluder', 'foreground-occluder'];
  for (const [id, def] of Object.entries(source.motions)) {
    for (const track of def.tracks as Array<Record<string, any>>) {
      assert.ok(
        !support.includes(String(track.layerId)),
        `${id}: 支撑层 ${track.layerId} 出现在轨道里（转一下就会露补绘缝）`,
      );
    }
  }
});

test('compileMotion：allowedLayerIds 过滤掉非可动层（运行期第二道防线）', () => {
  const catalog = cloneCatalog() as unknown as Record<string, any>;
  // 人为把支撑层塞进 idle：模拟"目录与层清单漂移"的坏状态
  catalog.motions.idle.tracks.push({
    layerId: 'body-occluder',
    property: 'rotate',
    keyframes: [
      { at: 0, value: 0 },
      { at: 1, value: 5 },
    ],
  });
  const options = { power: 'idle' as const, reducedMotion: false, selectorRoot: '#pet-root' };
  // 不给白名单：能编出来（说明这条防线不是"编译器的默认行为"）
  const unguarded = compileMotion(catalog as unknown as MotionCatalog, 'idle', options);
  assert.ok(
    unguarded.cssRules.some((rule) => rule.includes("[data-layer='body-occluder']")),
    '未传白名单时应能编出支撑层规则（对照组）',
  );
  // 给白名单：支撑层被拒，且记账
  const guarded = compileMotion(catalog as unknown as MotionCatalog, 'idle', {
    ...options,
    allowedLayerIds: ['tail-base', 'tail-tip', 'ear-left', 'ear-right', 'ahoge', 'bow'],
  });
  assert.ok(
    !guarded.cssRules.some((rule) => rule.includes("[data-layer='body-occluder']")),
    '支撑层必须被白名单挡掉',
  );
  assert.deepEqual(guarded.unsupportedTracks, ['idle:body-occluder']);
  // 可动层一条不许少
  for (const layerId of ['tail-base', 'tail-tip', 'ahoge', 'bow']) {
    assert.ok(
      guarded.cssRules.some((rule) => rule.includes(`[data-layer='${layerId}']`)),
      `可动层 ${layerId} 的规则被误删了`,
    );
  }
});

