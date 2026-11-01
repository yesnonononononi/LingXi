/**
 * 分层合成器单测（`LayeredPresentation`，tsx 执行，不碰真 DOM）。
 *
 * <p><b>假元素刻意不实现 `classList`</b>：合成器的写入面只有三种（`<img>.src`、
 * CSS 自定义属性、`data-*`）。实现里一旦冒出 `classList.add('is-happy')`，这些用例会立刻抛
 * `TypeError` —— 把"状态不许藏进 CSS 类"这条纪律做成会红的断言。</p>
 *
 * <p>覆盖：层挂载契约、动作编译成 CSS 后落到正确的层、支撑层永不接受动画、
 * 同一动作连播必须真的重播（既不堆积规则也不哑火）、减少动态零规则、
 * 参数驱动落层与钳制、无脸层时表情委托整帧、释放清空。</p>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CROSSFADE_CSS_VARIABLES, DEFAULT_CROSSFADE_MS } from '../src/pet/presentation/crossfade';
import {
  LAYER_SELECTOR_ROOT,
  LayeredPresentation,
  mountLayerViews,
  type DocumentLike,
  type ElementLike,
  type LayerView,
} from '../src/pet/presentation/layered-presentation';
import { MOTION_CATALOG } from '../src/pet/layers/motion-catalog';
import { resolveCompositePlan } from '../src/pet/layers/plan';
import type { CompositePlan, LayerManifest, LayerRole, LayerSpec } from '../src/pet/layers/types';
import {
  DEFAULT_PRESENTATION_STATE,
  MOTION_IDS,
  type PetPresentation,
  type PresentationOp,
} from '../src/pet/presentation/types';

/** P1 真契约的层序（[layerId, z, role]），顺序即 renderOrder，不许重排。 */
const REAL_ORDER: ReadonlyArray<readonly [string, number, LayerRole]> = [
  ['underpainting', 0, 'support'],
  ['tail-base', 10, 'animatable'],
  ['tail-tip', 15, 'animatable'],
  ['ear-left', 20, 'animatable'],
  ['ear-right', 25, 'animatable'],
  ['body-occluder', 30, 'support'],
  ['ahoge', 40, 'animatable'],
  ['bow', 45, 'animatable'],
  ['foreground-occluder', 50, 'support'],
];

/** 支撑层 id（只参与合成，不接受任何动画/参数驱动指令）。 */
const SUPPORT_IDS: readonly string[] = REAL_ORDER.filter(([, , role]) => role === 'support').map(([id]) => id);

/**
 * 假元素：只实现 `ElementLike` 声明的成员，**没有 `classList`**。
 *
 * <p>没有 `classList` 是刻意的：合成器若偷偷用类名表达状态，这里会当场抛异常。</p>
 */
class FakeElement implements ElementLike {
  /** `data-*` 写入面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** 写过的 CSS 自定义属性（断言用）。 */
  readonly styleProps = new Map<string, string>();

  /** 写过的属性（`src` / `class` / `alt` / `data-pet-motion`）。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面（只实现 `setProperty`，与 `ElementLike` 一致）。 */
  readonly style: { setProperty: (name: string, value: string) => void } = {
    setProperty: (name: string, value: string): void => {
      this.styleProps.set(name, value);
    },
  };

  /** 图片地址 / `<style>` 文本载体（与真元素同名字段）。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本内容（`<style>` 用）。 */
  textContent: string | null = null;

  /**
   * 构造假元素。
   *
   * @param tagName 标签名（只用于可读性）
   */
  constructor(readonly tagName: string) {}

  /**
   * 追加子节点。
   *
   * @param child 子节点
   * @returns 追加进去的节点
   */
  appendChild(child: ElementLike): unknown {
    const element = child as FakeElement;
    this.children.push(element);
    return element;
  }

  /**
   * 写属性。
   *
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /**
   * 读属性。
   *
   * @param name 属性名
   * @returns 属性值；没有时返回 null
   */
  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  /**
   * 按 `data-layer` 找直接子元素（断言用）。
   *
   * @param layerId 层 id
   * @returns 找到的元素；没有时返回 null
   */
  childLayer(layerId: string): FakeElement | null {
    return this.children.find((child) => child.dataset.layer === layerId) ?? null;
  }
}

/** 假文档：只实现 `createElement`。 */
class FakeDocument implements DocumentLike {
  /**
   * 创建元素。
   *
   * @param tagName 标签名
   * @returns 新的假元素
   */
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}

/** 记录收到哪些指令的整帧兜底实现（代替真 `SpritePresentation`）。 */
class FakeFallback implements PetPresentation {
  /** 收到的指令。 */
  readonly applied: PresentationOp[] = [];

  /** 收到的预准备指令。 */
  readonly prepared: PresentationOp[] = [];

  /** 状态快照（固定为默认态，本测试不关心）。 */
  readonly state = DEFAULT_PRESENTATION_STATE;

  /** 是否已释放。 */
  disposed = false;

  /**
   * 记录一条指令。
   *
   * @param op 指令
   */
  apply(op: PresentationOp): void {
    this.applied.push(op);
  }

  /**
   * 记录一条预准备指令。
   *
   * @param next 指令
   * @returns 立即完成
   */
  async prepare(next: PresentationOp): Promise<void> {
    this.prepared.push(next);
  }

  /** 标记释放。 */
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * 造一层的契约。
 *
 * @param layerId 层 id
 * @param z 绘制顺序
 * @param role 角色
 * @param ready 是否有文件（false = 模拟未交付）
 * @returns 层契约
 */
function makeLayer(layerId: string, z: number, role: LayerRole, ready = true): LayerSpec {
  return {
    layerId,
    role,
    z,
    parent: 'root',
    pivot: { u: 0.5, v: 0.9 },
    rect: { x: 0, y: 0, width: 2048, height: 3072 },
    source: layerId,
    blend: 'normal',
    opacity: 1,
    occludes: [],
    files: ready
      ? {
          '2x': {
            file: `layers/${layerId}@2x.webp`,
            url: `lxa://pet-v3/layers/${layerId}@2x.webp`,
            width: 2048,
            height: 3072,
            bytes: 2048,
            sha256: 'b'.repeat(64),
            format: 'webp',
          },
        }
      : {},
    required: true,
  };
}

/**
 * 按真契约造一份清单。
 *
 * @param missing 缺文件的层 id
 * @param enabled 总闸
 * @returns 层清单
 */
function makeManifest(missing: readonly string[] = [], enabled = true): LayerManifest {
  return {
    version: 1,
    assetId: 'test-layers',
    enabled,
    assetBase: 'lxa://pet-v3/',
    canvas: { width: 2048, height: 3072 },
    nativeCanvas: { width: 1024, height: 1536 },
    anchor: { x: 1024, y: 2908 },
    densities: ['1x', '2x'],
    layers: REAL_ORDER.map(([layerId, z, role]) => makeLayer(layerId, z, role, !missing.includes(layerId))),
  };
}

/** 测试夹具（一次构造，用例各取所需）。 */
interface Fixture {
  /** 假文档。 */
  readonly doc: FakeDocument;
  /** `#pet-root`。 */
  readonly root: FakeElement;
  /** 层宿主（`.pet-art`）。 */
  readonly host: FakeElement;
  /** 层清单。 */
  readonly manifest: LayerManifest;
  /** 合成计划（全齐 → layered）。 */
  readonly plan: CompositePlan;
  /** 层视图。 */
  readonly views: ReadonlyMap<string, LayerView>;
  /** 整帧兜底。 */
  readonly fallback: FakeFallback;
  /** 合成器。 */
  readonly presentation: LayeredPresentation;
}

/**
 * 搭夹具。
 *
 * @param overrides 覆盖项（减少动态、功耗档、交叉过渡时长）
 * @returns 夹具
 */
function setup(overrides: {
  readonly reducedMotion?: boolean;
  readonly power?: 'interactive' | 'idle' | 'low' | 'off';
  readonly crossfadeMs?: number;
  /** 动作目录覆盖（M6-b：用"坏目录"验证运行期防线）。 */
  readonly catalog?: typeof MOTION_CATALOG;
} = {}): Fixture {
  const doc = new FakeDocument();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const manifest = makeManifest();
  const requested = manifest.layers.map((layer) => layer.layerId);
  const plan = resolveCompositePlan({ manifest, requested, density: '2x' });
  const views = mountLayerViews(doc, host, plan);
  const fallback = new FakeFallback();
  const presentation = new LayeredPresentation({
    doc,
    root,
    views,
    manifest,
    catalog: overrides.catalog ?? MOTION_CATALOG,
    plan,
    baseFallback: fallback,
    expressionUrls: { happy: 'lxa://pet-v3/composites/happy@2x.webp' },
    crossfade: typeof overrides.crossfadeMs === 'number' ? { durationMs: overrides.crossfadeMs } : undefined,
    power: () => overrides.power ?? 'idle',
    reducedMotion: () => overrides.reducedMotion === true,
  });
  return { doc, root, host, manifest, plan, views, fallback, presentation };
}

/**
 * 造一条动作指令。
 *
 * @param id 动作 id
 * @returns 指令
 */
function motionOp(id: string): PresentationOp {
  return { kind: 'motion', id: id as PresentationOp['id'], layer: 'base', priority: 0, reason: 'test:motion' };
}

test('mountLayerViews：9 层按 renderOrder 挂进 .pet-layers，并写 z / 角色 / 支点', () => {
  const { host, plan } = setup();
  assert.equal(plan.mode, 'layered');
  assert.equal(host.children.length, 1);
  const container = host.children[0];
  assert.equal(container.getAttribute('class'), 'pet-layers');
  assert.equal(container.dataset.compositeMode, 'layered');
  assert.equal(container.children.length, REAL_ORDER.length);
  // DOM 顺序 = renderOrder（无 z-index 的兜底场景也要是对的）
  assert.deepEqual(
    container.children.map((child) => child.dataset.layer),
    REAL_ORDER.map(([layerId]) => layerId),
  );
  for (const [layerId, z, role] of REAL_ORDER) {
    const element = container.childLayer(layerId);
    assert.ok(element, `缺少层 ${layerId}`);
    assert.equal(element.dataset.role, role);
    assert.equal(element.styleProps.get('z-index'), String(z));
    // 支点是归一化百分比（P1 每层一整张画布，支点由美术 pivot 决定）
    assert.match(element.styleProps.get('transform-origin') ?? '', /^\d+(\.\d+)?% \d+(\.\d+)?%$/);
  }
});

test('applyPlan：写 mode/层数/过渡变量，并把各层 src 指向 lxa://pet-v3', () => {
  const { root, views } = setup();
  assert.equal(root.dataset.compositeMode, 'layered');
  assert.equal(root.dataset.layers, String(REAL_ORDER.length));
  assert.equal(root.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), `${DEFAULT_CROSSFADE_MS}ms`);
  assert.ok(root.styleProps.get(CROSSFADE_CSS_VARIABLES.easing));
  for (const [layerId, view] of views) {
    assert.equal(view.element.getAttribute('src'), `lxa://pet-v3/layers/${layerId}@2x.webp`);
    assert.equal(view.element.src, `lxa://pet-v3/layers/${layerId}@2x.webp`);
    assert.equal(view.element.hidden, false);
    assert.equal(view.element.dataset.visible, '1');
  }
});

test('tap：规则落到双耳与蝴蝶结，且不碰支撑层', () => {
  const { presentation, root } = setup();
  presentation.apply(motionOp('tap'));
  assert.equal(root.dataset.motion, 'tap');
  const text = presentation.styleText;
  assert.match(text, /\[data-layer='ear-left'\]/);
  assert.match(text, /\[data-layer='ear-right'\]/);
  assert.match(text, /\[data-layer='bow'\]/);
  for (const supportId of SUPPORT_IDS) {
    assert.ok(!text.includes(`[data-layer='${supportId}']`), `支撑层 ${supportId} 不该被动画`);
  }
  // 规则挂在 #pet-root 的动作选择器下（也意味着不会污染压平帧实现的路径）
  assert.ok(text.includes(LAYER_SELECTOR_ROOT));
});

test('M6-b 运行期第二道防线：目录里混入支撑层轨道时，合成器也不会给它派规则', () => {
  const poisoned = JSON.parse(JSON.stringify(MOTION_CATALOG)) as typeof MOTION_CATALOG;
  (poisoned.motions.idle.tracks as Array<Record<string, unknown>>).push({
    layerId: 'foreground-occluder',
    property: 'rotate',
    keyframes: [
      { at: 0, value: 0 },
      { at: 1, value: 4 },
    ],
  });
  const { presentation } = setup({ catalog: poisoned });
  presentation.apply(motionOp('idle'));
  const text = presentation.styleText;
  assert.ok(!text.includes("[data-layer='foreground-occluder']"), '支撑层被转起来就一定会露补绘缝');
  // 同一条动作里的可动层照常编译，不是"整条动作被丢掉"
  for (const layerId of ['tail-base', 'tail-tip', 'ahoge', 'bow']) {
    assert.match(text, new RegExp(`\\[data-layer='${layerId}'\\]`), `可动层 ${layerId} 的规则不该被牵连`);
  }
});

test('全部 9 个动作都不给支撑层派任何规则', () => {
  const { presentation } = setup();
  for (const id of MOTION_IDS) {
    presentation.apply(motionOp(id));
    const text = presentation.styleText;
    for (const supportId of SUPPORT_IDS) {
      assert.ok(!text.includes(`[data-layer='${supportId}']`), `动作 ${id} 给支撑层 ${supportId} 派了规则`);
    }
    assert.ok(presentation.rules.length > 0, `动作 ${id} 没有编译出任何规则`);
  }
});

test('同一动作连播两次：规则文本不同（真的重播）且 <style> 只有一个节点', () => {
  const { presentation, root, host } = setup();
  presentation.apply(motionOp('tap'));
  const first = presentation.styleText;
  presentation.apply(motionOp('tap'));
  const second = presentation.styleText;
  assert.notEqual(first, second, '连播同一动作必须换规则文本，否则动画不会重头播');
  assert.match(second, /data-motion-seq='2'/);
  const styleNodes = root.children.filter((child) => child.getAttribute('data-pet-motion') === '1');
  assert.equal(styleNodes.length, 1, '样式节点必须复用，不许每次动作追加一个');
  assert.equal(root.dataset.motionSeq, '2');
});

test('减少动态：一条规则都不产出，样式文本为空', () => {
  const { presentation } = setup({ reducedMotion: true });
  presentation.apply(motionOp('tap'));
  assert.deepEqual(presentation.rules, []);
  assert.equal(presentation.styleText, '');
});

test('参数驱动落层：尾巴角度写两段尾巴，不写支撑层也不写根', () => {
  const { presentation, root, views } = setup();
  presentation.apply({
    kind: 'driven',
    id: 'tailAngle',
    layer: 'ambient',
    priority: 0,
    value: 8,
    reason: 'test:driven',
  });
  assert.equal(views.get('tail-base')?.element.styleProps.get('--pet-tail-angle'), '8deg');
  assert.equal(views.get('tail-tip')?.element.styleProps.get('--pet-tail-angle'), '8deg');
  assert.equal(views.get('body-occluder')?.element.styleProps.get('--pet-tail-angle'), undefined);
  assert.equal(root.styleProps.get('--pet-tail-angle'), undefined);
  assert.equal(presentation.state.driven.tailAngle, 8);
});

test('参数驱动钳制：30° 上限与 0..1 不透明度', () => {
  const { presentation, root, views } = setup();
  presentation.apply({
    kind: 'driven',
    id: 'earLAngle',
    layer: 'ambient',
    priority: 0,
    value: 99,
    reason: 'test:clamp',
  });
  assert.equal(views.get('ear-left')?.element.styleProps.get('--pet-ear-l-angle'), '30deg');
  presentation.apply({
    kind: 'driven',
    id: 'haloOpacity',
    layer: 'ambient',
    priority: 0,
    value: 0.4,
    reason: 'test:halo',
  });
  // 光晕没有层目标：留在根上（装饰层不属于任何分层件）
  assert.equal(root.styleProps.get('--pet-halo-opacity'), '0.4');
});

test('没有 face 层时表情委托整帧兜底（不硬拆贴片）', () => {
  const { presentation, fallback, root } = setup();
  presentation.apply({ kind: 'expression', id: 'happy', layer: 'base', priority: 0, reason: 'test:expr' });
  assert.equal(fallback.applied.length, 1);
  assert.equal(fallback.applied[0].id, 'happy');
  assert.equal(root.dataset.expression, 'happy');
  assert.equal(presentation.state.expression, 'happy');
});

test('功耗 low 档：动作时长翻倍（视觉降频不降帧）', () => {
  const { presentation } = setup({ power: 'low' });
  presentation.apply(motionOp('tap'));
  // tap 在目录里是 480ms，low 档 ×2
  assert.match(presentation.styleText, /960ms/);
});

test('交叉过渡时长钳制到 80–120ms 并写进 CSS 变量', () => {
  const fast = setup({ crossfadeMs: 5 });
  assert.equal(fast.presentation.crossfadeMs, 80);
  assert.equal(fast.root.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), '80ms');
  const slow = setup({ crossfadeMs: 999 });
  assert.equal(slow.presentation.crossfadeMs, 120);
});

test('dispose：清空注入的样式与根上的临时属性', () => {
  const { presentation, root } = setup();
  presentation.apply(motionOp('tap'));
  presentation.dispose();
  assert.equal(presentation.styleText, '');
  assert.deepEqual(presentation.rules, []);
  assert.equal(root.dataset.motion, undefined);
  assert.equal(root.dataset.expression, undefined);
  assert.equal(root.dataset.compositeMode, undefined);
  // 释放后再来的指令一律无效（桌宠窗口会被反复开关）
  presentation.apply(motionOp('happy'));
  assert.equal(presentation.styleText, '');
});
