/**
 * 分层降级选路单测（`resolveCompositePlan`，纯函数，不碰 DOM）。
 *
 * <p>夹具按 **P1 真契约**（美术 manifest 的 renderOrder）搭：
 * `underpainting(0) → tail-base(10) → tail-tip(15) → ear-left(20) → ear-right(25)
 * → body-occluder(30) → ahoge(40) → bow(45) → foreground-occluder(50)`。</p>
 *
 * <p>覆盖设计文档附录 A.2 的四份变体（全缺 / 只有前景层 / 只有后景层 / 全齐）与全部理由码，
 * 并额外加一条**负样本金丝雀**：请求里混进一个不存在的 `layerId` 必须回退 `composite`，
 * 证明这组断言不是"永远返回绿"。</p>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN_REASONS,
  SAFE_OVERLAY_Z,
  isLayered,
  planLayerIds,
  resolveCompositePlan,
} from '../src/pet/layers/plan';
import type { LayerManifest, LayerRole, LayerSpec } from '../src/pet/layers/types';

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

/** 造一层的契约（`ready=false` 时 `files` 为空，模拟"该层未交付"）。 */
function makeLayer(layerId: string, z: number, ready = true, role: LayerRole = 'animatable', parent = 'root'): LayerSpec {
  return {
    layerId,
    role,
    z,
    parent,
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
            bytes: 1024,
            sha256: 'a'.repeat(64),
            format: 'webp',
          },
        }
      : {},
    required: true,
  };
}

/** 按真契约造一份清单（默认每一层都就绪）。 */
function realLayers(missing: readonly string[] = []): LayerSpec[] {
  return REAL_ORDER.map(([layerId, z, role]) => makeLayer(layerId, z, !missing.includes(layerId), role));
}

/** 造一份清单（默认开闸）。 */
function makeManifest(layers: LayerSpec[], enabled = true): LayerManifest {
  return {
    version: 1,
    assetId: 'test-layers',
    enabled,
    assetBase: 'lxa://pet-v3/',
    canvas: { width: 2048, height: 3072 },
    nativeCanvas: { width: 1024, height: 1536 },
    anchor: { x: 1024, y: 2908 },
    densities: ['1x', '2x'],
    layers,
  };
}

/** 全部层的 id（`requested` 用）。 */
function idsOf(manifest: LayerManifest): string[] {
  return manifest.layers.map((layer) => layer.layerId);
}

test('安全线落在 body-occluder(30) 与 ahoge(40) 之间', () => {
  assert.equal(SAFE_OVERLAY_Z, 35);
});

test('全齐 → layered，且层严格按 renderOrder 排列', () => {
  const manifest = makeManifest(realLayers());
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'layered');
  assert.equal(plan.fallbackReason, '');
  assert.deepEqual(planLayerIds(plan), REAL_ORDER.map(([layerId]) => layerId));
  assert.equal(isLayered(plan), true);
});

test('缺 ahoge（可动前景层）→ partial，只叠 z>安全线 的可动层', () => {
  const manifest = makeManifest(realLayers(['ahoge']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'partial');
  // 只剩蝴蝶结可叠：尾巴/双耳/遮挡片都留在压平帧里
  assert.deepEqual(planLayerIds(plan), ['bow']);
});

test('缺 tail-base（后景层）→ composite', () => {
  const manifest = makeManifest(realLayers(['tail-base']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
  assert.deepEqual(plan.layers, []);
});

test('缺 tail-tip（两段尾巴的第二段）→ composite', () => {
  const manifest = makeManifest(realLayers(['tail-tip']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
});

test('缺 ear-left（z=20）→ composite：耳朵叠上去是穿模', () => {
  const manifest = makeManifest(realLayers(['ear-left']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
});

test('缺前景遮挡片（支撑层 z=50 > 安全线）→ composite：支撑层缺一件合成就错了', () => {
  const manifest = makeManifest(realLayers(['foreground-occluder']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
});

test('缺底绘（支撑层 z=0）→ composite', () => {
  const manifest = makeManifest(realLayers(['underpainting']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.MISSING_BACK_LAYER);
});

test('enabled=false → composite（默认态，等于今天的行为）', () => {
  const manifest = makeManifest(realLayers(), false);
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.DISABLED);
  assert.equal(isLayered(plan), false);
});

test('failedLayers 含 ear-left → composite 且理由是解码失败', () => {
  const manifest = makeManifest(realLayers());
  const plan = resolveCompositePlan({
    manifest,
    requested: idsOf(manifest),
    density: '2x',
    failedLayers: ['ear-left'],
  });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.DECODE_FAILED);
});

test('failedLayers 只含前景可动层 → partial', () => {
  const manifest = makeManifest(realLayers());
  const plan = resolveCompositePlan({
    manifest,
    requested: idsOf(manifest),
    density: '2x',
    failedLayers: ['ahoge'],
  });
  assert.equal(plan.mode, 'partial');
  assert.deepEqual(planLayerIds(plan), ['bow']);
});

test('requested 为空 → composite（清单为空 = P1 未交付）', () => {
  const manifest = makeManifest([]);
  const plan = resolveCompositePlan({ manifest, requested: [], density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.NO_REQUESTED);
});

test('后景全齐、前景可动层全缺 → composite（partial 叠不出东西）', () => {
  const manifest = makeManifest(realLayers(['ahoge', 'bow']));
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.NO_FRONT_LAYER);
});

test('支撑层不参与 partial：只剩支撑性前景时也算"没有可叠的"', () => {
  const manifest = makeManifest(realLayers(['ahoge', 'bow']));
  // foreground-occluder(50) 就绪且 z>安全线，但它是 support，不能顶替可动前景层
  const plan = resolveCompositePlan({ manifest, requested: idsOf(manifest), density: '2x' });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.NO_FRONT_LAYER);
});

test('负样本金丝雀：请求里混入不存在的 layerId 必须回退 composite', () => {
  const manifest = makeManifest(realLayers());
  const plan = resolveCompositePlan({
    manifest,
    requested: [...idsOf(manifest), 'ghost-layer'],
    density: '2x',
  });
  assert.equal(plan.mode, 'composite');
  assert.equal(plan.fallbackReason, PLAN_REASONS.UNKNOWN_LAYER);
});

test('密度降级：只有 @1x 文件时用 2x 请求仍算就绪', () => {
  const only1x: LayerSpec = {
    ...makeLayer('ahoge', 40),
    files: {
      '1x': {
        file: 'layers/ahoge@1x.webp',
        url: 'lxa://pet-v3/layers/ahoge@1x.webp',
        width: 1024,
        height: 1536,
        bytes: 512,
        sha256: 'b'.repeat(64),
        format: 'webp',
      },
    },
  };
  const manifest = makeManifest([only1x]);
  const plan = resolveCompositePlan({ manifest, requested: ['ahoge'], density: '2x' });
  assert.equal(plan.mode, 'layered');
  assert.equal(plan.density, '2x');
});
