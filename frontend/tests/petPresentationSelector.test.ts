/**
 * 表现层选路单测（`select-presentation.ts`，tsx 执行，不碰真 DOM）。
 *
 * <p><b>为什么这个文件必须存在：</b>分层合成器是"新增"，它的风险不在自己身上，而在
 * "总闸关闭时会不会顺手把今天的行为改坏"。这里把三个降级分支逐条钉死：</p>
 * <ol>
 *   <li>`composite`（总闸关 / `?layers=0` / 层未到货）→ 必须返回 `SpritePresentation`，
 *       且构造参数与分层之前一字不差；</li>
 *   <li>`partial`（缺前景可动层）→ `LayeredPresentation`，只叠安全线之上的可动层；</li>
 *   <li>`layered`（9 层全齐）→ `LayeredPresentation`，9 层全部挂上。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PET_GEOMETRY } from '../src/pet/layout';
import { MOTION_CATALOG } from '../src/pet/layers/motion-catalog';
import { applyLayersQueryOverride, layersQueryOverride } from '../src/pet/layers/manifest';
import { PLAN_REASONS, planLayerIds, resolveCompositePlan } from '../src/pet/layers/plan';
import type { CompositePlan, LayerManifest, LayerRole, LayerSpec } from '../src/pet/layers/types';
import {
  LAYER_SELECTOR_ROOT,
  LayeredPresentation,
  type DocumentLike,
  type ElementLike,
} from '../src/pet/presentation/layered-presentation';
import { selectPresentation, selectPresentationWithPlan, type SelectorDeps } from '../src/pet/presentation/select-presentation';
import { SpritePresentation } from '../src/pet/presentation/sprite-presentation';

/**
 * P1 真契约的层序（[layerId, z, role]），顺序即 renderOrder。
 *
 * <p>M1（T01）起是 **10 层**：`face` 插在 `body-occluder(30)` 与 `ahoge(40)` 之间取 `z = 32`。
 * 它不是"多画一层"而是"表情能不能被看见"的开关：缺它 ⇒ `layers/plan.ts` 的
 * `z <= SAFE_OVERLAY_Z(35)` 判定让整条链路回落 `composite`（压平帧），表情仍然可见，
 * 只是失去部件微动（设计文档 §3.1 / §3.2c）。</p>
 */
const REAL_ORDER: ReadonlyArray<readonly [string, number, LayerRole]> = [
  ['underpainting', 0, 'support'],
  ['tail-base', 10, 'animatable'],
  ['tail-tip', 15, 'animatable'],
  ['ear-left', 20, 'animatable'],
  ['ear-right', 25, 'animatable'],
  ['body-occluder', 30, 'support'],
  ['face', 32, 'animatable'],
  ['ahoge', 40, 'animatable'],
  ['bow', 45, 'animatable'],
  ['foreground-occluder', 50, 'support'],
];

/** 假元素：只实现 `ElementLike`（**没有 `classList`**，碰了就会抛）。 */
class FakeElement implements ElementLike {
  /** `data-*`。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** CSS 自定义属性。 */
  readonly styleProps = new Map<string, string>();

  /** 属性。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面。 */
  readonly style: { setProperty: (name: string, value: string) => void } = {
    setProperty: (name: string, value: string): void => {
      this.styleProps.set(name, value);
    },
  };

  /** 图片地址 / 文本载体。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本内容。 */
  textContent: string | null = null;

  /**
   * 构造假元素。
   *
   * @param tagName 标签名
   */
  constructor(readonly tagName: string) {}

  /**
   * 追加子节点。
   *
   * @param child 子节点
   * @returns 子节点
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
   * @returns 属性值
   */
  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }
}

/** 假文档。 */
class FakeDocument implements DocumentLike {
  /**
   * 创建元素。
   *
   * @param tagName 标签名
   * @returns 假元素
   */
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}

/**
 * 造一层契约。
 *
 * @param layerId 层 id
 * @param z 绘制顺序
 * @param role 角色
 * @param ready 是否有文件
 * @returns 层契约
 */
function makeLayer(layerId: string, z: number, role: LayerRole, ready: boolean): LayerSpec {
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
            sha256: 'c'.repeat(64),
            format: 'webp',
          },
        }
      : {},
    required: true,
  };
}

/**
 * 造清单。
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

/**
 * 造选路依赖。
 *
 * @param manifest 层清单
 * @returns 依赖
 */
function makeDeps(manifest: LayerManifest): SelectorDeps {
  const doc = new FakeDocument();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const front = new FakeElement('img');
  const back = new FakeElement('img');
  return {
    doc,
    root,
    layerHost: host,
    frames: [front, back] as unknown as readonly [HTMLImageElement, HTMLImageElement],
    geometry: PET_GEOMETRY,
    catalog: MOTION_CATALOG,
    expressionUrls: { neutral: 'lxa://pet-v3/composites/neutral@2x.webp' },
    manifest,
    initialExpression: 'neutral',
  };
}

/**
 * 算一份计划。
 *
 * @param manifest 层清单
 * @returns 计划
 */
function planOf(manifest: LayerManifest): CompositePlan {
  return resolveCompositePlan({
    manifest,
    requested: manifest.layers.map((layer) => layer.layerId),
    density: '2x',
  });
}

test('总闸关闭（默认态）→ composite，返回的就是今天那个 SpritePresentation', () => {
  const manifest = makeManifest([], false);
  const deps = makeDeps(manifest);
  const outcome = selectPresentationWithPlan(planOf(manifest), deps);
  assert.equal(outcome.mode, 'composite');
  assert.equal(outcome.views.size, 0);
  assert.ok(outcome.presentation instanceof SpritePresentation, '总闸关闭时必须还是立牌实现');
  assert.ok(!(outcome.presentation instanceof LayeredPresentation));
  // 立牌实现把初始表情写进了 root.dataset（与分层之前的构造完全一致）
  assert.equal(deps.root.dataset.expression, 'neutral');
  assert.equal(deps.root.dataset.motion, 'idle');
});

test('运行时清单 pet-layers.json 已开闸（M6-b 设计变更）：真实清单选路 = layered，10 层全挂', async () => {
  const { PET_LAYERS, pickLayerDensity, requestedLayerIds } = await import('../src/pet/layers/manifest');
  // M6-b：总闸由 false 改为 true（用户已批准）。这是设计变更，不是"为过测试改断言"。
  assert.equal(PET_LAYERS.enabled, true, 'M6-b 开闸后总闸必须是 true');
  const requested = requestedLayerIds(PET_LAYERS);
  // M1/T01：新增第 10 层 face（z=32），层数期望随之从 9 改为 10
  assert.equal(requested.length, 10, `真实清单应请求 10 层（含 face），实际 ${requested.join(',')}`);
  const plan = resolveCompositePlan({
    manifest: PET_LAYERS,
    requested,
    density: pickLayerDensity(1, PET_LAYERS),
  });
  assert.equal(plan.mode, 'layered');
  assert.equal(plan.layers.length, 10);
  assert.deepEqual(planLayerIds(plan), REAL_ORDER.map(([id]) => id));
});

test('真实清单 + ?layers=0：强制回 composite（回归手测开关仍然有效）', async () => {
  const { PET_LAYERS, pickLayerDensity, requestedLayerIds } = await import('../src/pet/layers/manifest');
  const overridden = applyLayersQueryOverride(PET_LAYERS, '?layers=0');
  assert.equal(overridden.enabled, false);
  const plan = resolveCompositePlan({
    manifest: overridden,
    requested: requestedLayerIds(overridden),
    density: pickLayerDensity(1, overridden),
  });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.layers.length, 0);
});

test('?layers=0 覆写：即使清单开闸也回 composite', () => {
  const manifest = applyLayersQueryOverride(makeManifest([], true), '?layers=0');
  assert.equal(manifest.enabled, false);
  const outcome = selectPresentationWithPlan(planOf(manifest), makeDeps(manifest));
  assert.equal(outcome.mode, 'composite');
  assert.ok(outcome.presentation instanceof SpritePresentation);
});

test('?layers=1 覆写：层文件没到货 → composite（理由 missing-back-layer），不硬上分层', () => {
  const overridden = applyLayersQueryOverride(makeManifest(REAL_ORDER.map(([id]) => id), false), '?layers=1');
  assert.equal(overridden.enabled, true);
  const plan = planOf(overridden);
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
  const outcome = selectPresentationWithPlan(plan, makeDeps(overridden));
  assert.ok(outcome.presentation instanceof SpritePresentation);
  assert.equal(outcome.views.size, 0);
});

test('query 覆写解析：只有 1/0/true/false 生效，其它一律忽略', () => {
  assert.equal(layersQueryOverride('?layers=1'), true);
  assert.equal(layersQueryOverride('?layers=0'), false);
  assert.equal(layersQueryOverride('?layers=true'), true);
  assert.equal(layersQueryOverride('?layers=false'), false);
  assert.equal(layersQueryOverride('?layers=yes'), null);
  assert.equal(layersQueryOverride(''), null);
  assert.equal(layersQueryOverride('?debug=1'), null);
});

test('缺一件前景可动层 → partial：只叠安全线之上的可动层，支撑层不参与', () => {
  const manifest = makeManifest(['ahoge']);
  const plan = planOf(manifest);
  assert.equal(plan.mode, 'partial');
  const outcome = selectPresentationWithPlan(plan, makeDeps(manifest));
  assert.equal(outcome.mode, 'partial');
  assert.ok(outcome.presentation instanceof LayeredPresentation);
  // 只剩蝴蝶结可叠：尾巴/双耳/遮挡片都留在压平帧里
  assert.deepEqual([...outcome.views.keys()], ['bow']);
  assert.deepEqual([...outcome.views.keys()], planLayerIds(plan));
  assert.ok(![...outcome.views.keys()].some((id) => id === 'underpainting' || id === 'body-occluder'));
});

test('前景可动层一件不剩 → 回 composite（partial 等于空操作）', () => {
  const manifest = makeManifest(['ahoge', 'bow']);
  const plan = planOf(manifest);
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.NO_FRONT_LAYER);
  const outcome = selectPresentationWithPlan(plan, makeDeps(manifest));
  assert.ok(outcome.presentation instanceof SpritePresentation);
});

test('10 层全齐 → layered：LayeredPresentation，10 层全部挂上且顺序 = renderOrder', () => {
  const manifest = makeManifest();
  const plan = planOf(manifest);
  assert.equal(plan.mode, 'layered');
  const deps = makeDeps(manifest);
  const outcome = selectPresentationWithPlan(plan, deps);
  assert.equal(outcome.mode, 'layered');
  assert.ok(outcome.presentation instanceof LayeredPresentation);
  assert.equal(outcome.views.size, REAL_ORDER.length);
  assert.deepEqual(
    [...outcome.views.keys()],
    REAL_ORDER.map(([layerId]) => layerId),
  );
  // 根上标了模式：CSS 与调试面板都读它
  assert.equal(deps.root.dataset.compositeMode, 'layered');
});

test('selectPresentation 简版入口与带计划版选到同一个实现类型', () => {
  const layeredManifest = makeManifest();
  const layered = selectPresentation(planOf(layeredManifest), makeDeps(layeredManifest));
  assert.ok(layered instanceof LayeredPresentation);
  const compositeManifest = makeManifest([], false);
  const composite = selectPresentation(planOf(compositeManifest), makeDeps(compositeManifest));
  assert.ok(composite instanceof SpritePresentation);
});

test('分层实现在无动作时也把根的选择器根常量暴露给 CSS（防止样式写错根）', () => {
  assert.equal(LAYER_SELECTOR_ROOT, '#pet-root');
});
