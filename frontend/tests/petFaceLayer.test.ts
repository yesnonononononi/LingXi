/**
 * 脸层接入单测（T03 结构断言，tsx 执行，不碰真 DOM、不碰 Electron）。
 *
 * <p><b>它证明什么（对应设计文档 §8-T03 与 §11.2 的 R1–R3）：</b></p>
 * <ol>
 *   <li><b>R1 契约</b>：真实 `pet-layers.json` 里有第 10 层 `face`，`z === 32`，
 *       严格夹在 `body-occluder(30)` 与 `ahoge(40)` 之间，且 `z <= SAFE_OVERLAY_Z(35)`
 *       （缺它就是"整体回落压平帧"，`layers/plan.ts` 一行都不用改）；</li>
 *   <li><b>放置</b>：`mountLayerViews` 与 `applyPlan` 只给 `face` 写 `data-placement='rect'`
 *       与四个百分比变量，其余 9 层**一个字节都不写**（既有 DOM 写入面零变化）；</li>
 *   <li><b>R2 贴片路径</b>：`layered` 下切表情 ⇒ `face.src === faceTileUrls[id]` 且
 *       `fallback.applied.length === 0`；</li>
 *   <li><b>R3 回落路径（本轮重点）</b>：脸层不在**本次计划**里（哪怕元素还在）⇒
 *       `fallback.applied.length === 1` 且 `face.hidden === true`。
 *       这条就是"按存在性判分支"那个真实漏洞的机器化守卫；</li>
 *   <li><b>过渡</b>：`blink` / `blinkHalf` / `wink` 的过渡时长为 0（根上的
 *       `--pet-crossfade-ms` 不被写成 0 也不被改成 100ms，值是写在脸层元素上的）。</li>
 * </ol>
 *
 * <p>假元素刻意不实现 `classList`（与 `petLayeredPresentation.test.ts` 同一纪律）：
 * 合成器一旦把状态藏进 CSS 类，这里会当场抛。</p>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CROSSFADE_CSS_VARIABLES, DEFAULT_CROSSFADE_MS } from '../src/pet/presentation/crossfade';
import {
  FACE_LAYER_ID,
  LayeredPresentation,
  RECT_PLACEMENT_VARIABLES,
  inferPlanCanvas,
  isBlinkLikeExpression,
  mountLayerViews,
  rectPlacementOf,
  resolveExpressionFadeMs,
  type DocumentLike,
  type ElementLike,
  type LayerView,
} from '../src/pet/presentation/layered-presentation';
import { PET_LAYERS, requestedLayerIds } from '../src/pet/layers/manifest';
import { SAFE_OVERLAY_Z, resolveCompositePlan } from '../src/pet/layers/plan';
import type { CompositePlan, LayerManifest, LayerSpec, Size } from '../src/pet/layers/types';
import { FACE_REGION, faceTileUrls } from '../src/pet/assets/face-tiles';
import {
  DEFAULT_PRESENTATION_STATE,
  type PetPresentation,
  type PresentationOp,
} from '../src/pet/presentation/types';
import { MOTION_CATALOG } from '../src/pet/layers/motion-catalog';

/** 真实清单里的脸区矩形（母版像素）——与 `pet-face-tiles.json` 的 `faceRegion` 同值。 */
const FACE_RECT = FACE_REGION;

/**
 * 假元素：只实现 `ElementLike` 声明的成员，**没有 `classList`**。
 */
class FakeElement implements ElementLike {
  /** `data-*` 写入面。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** 写过的 CSS 自定义属性（断言用）。 */
  readonly styleProps = new Map<string, string>();

  /** 写过的属性。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** CSS 写入面（只实现 `setProperty`）。 */
  readonly style: { setProperty: (name: string, value: string) => void } = {
    setProperty: (name: string, value: string): void => {
      this.styleProps.set(name, value);
    },
  };

  /** 图片地址。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本内容（`<style>` 用）。 */
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
}

/** 假文档。 */
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

/** 记录指令的整帧兜底实现。 */
class FakeFallback implements PetPresentation {
  /** 收到的指令。 */
  readonly applied: PresentationOp[] = [];

  /** 状态快照（本测试不关心）。 */
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
   * 记录预准备（立即完成）。
   *
   * @param next 指令
   */
  async prepare(next: PresentationOp): Promise<void> {
    void next;
  }

  /** 标记释放。 */
  dispose(): void {
    this.disposed = true;
  }
}

/** 可控定时器（过渡结束标记用）。 */
class FakeTimer {
  /** 待执行的定时器。 */
  readonly pending: { handle: number; handler: () => void; delayMs: number }[] = [];

  /** 句柄发号器。 */
  private seq = 0;

  /**
   * 注册定时器。
   *
   * @param handler 到期回调
   * @param delayMs 延迟
   * @returns 句柄
   */
  setTimeout(handler: () => void, delayMs: number): number {
    this.seq += 1;
    this.pending.push({ handle: this.seq, handler, delayMs });
    return this.seq;
  }

  /**
   * 取消定时器。
   *
   * @param handle 句柄
   */
  clearTimeout(handle: number): void {
    const index = this.pending.findIndex((item) => item.handle === handle);
    if (index >= 0) this.pending.splice(index, 1);
  }

  /** 立即执行全部待执行定时器。 */
  flush(): void {
    const items = this.pending.splice(0, this.pending.length);
    for (const item of items) item.handler();
  }
}

/**
 * 按指定缺层造一份计划（清单用真实的那份，只改"哪些层就绪"）。
 *
 * <p>缺层用 `failedLayers`（解码失败）表达，而不是把 id 从 `requested` 里删掉——
 * 删掉等于"这次根本不需要这一层"，计划自然还是 `layered`，那样就模拟不出真实降级。</p>
 *
 * @param missing 缺文件的层 id
 * @returns 合成计划
 */
function planMissing(missing: readonly string[]): CompositePlan {
  return resolveCompositePlan({
    manifest: PET_LAYERS,
    requested: requestedLayerIds(PET_LAYERS),
    density: '2x',
    failedLayers: missing,
  });
}

/** 测试夹具。 */
interface Fixture {
  /** 层宿主。 */
  readonly host: FakeElement;
  /** `#pet-root`。 */
  readonly root: FakeElement;
  /** 层视图。 */
  readonly views: ReadonlyMap<string, LayerView>;
  /** 整帧兜底。 */
  readonly fallback: FakeFallback;
  /** 定时器。 */
  readonly timer: FakeTimer;
  /** 合成器。 */
  readonly presentation: LayeredPresentation;
}

/**
 * 搭夹具。
 *
 * @param plan 首次合成计划（缺省 = 真实清单全齐 → `layered`）
 * @param overrides 可选注入项（目前只有"整帧表情 URL 表"，用于区分两套 URL）
 * @returns 夹具
 */
function setup(plan?: CompositePlan, overrides: { expressionUrls?: Record<string, string> } = {}): Fixture {
  const doc = new FakeDocument();
  const root = new FakeElement('div');
  const host = new FakeElement('div');
  const resolved = plan ?? planMissing([]);
  // 视图一律按"全齐"挂载：`partial` 场景要复现"元素在、但这次计划里没有它"
  const mountPlan = planMissing([]);
  const views = mountLayerViews(doc, host, mountPlan, PET_LAYERS.canvas);
  const fallback = new FakeFallback();
  const timer = new FakeTimer();
  const presentation = new LayeredPresentation({
    doc,
    root,
    views,
    manifest: PET_LAYERS,
    catalog: MOTION_CATALOG,
    plan: resolved,
    baseFallback: fallback,
    expressionUrls: overrides.expressionUrls ?? { happy: 'lxa://pet-p1/composites/happy@2x.webp' },
    faceTileUrls: faceTileUrls('2x'),
    timer,
    power: () => 'idle',
    reducedMotion: () => false,
  });
  return { host, root, views, fallback, timer, presentation };
}

/**
 * 造一条表情指令。
 *
 * @param id 表情 id
 * @param fadeMs 可选过渡时长
 * @returns 指令
 */
function expressionOp(id: string, fadeMs?: number): PresentationOp {
  return {
    kind: 'expression',
    id: id as PresentationOp['id'],
    layer: 'base',
    priority: 0,
    fadeMs,
    reason: `test:${id}`,
  };
}

// ------------------------------------------------------------------ R1：契约

test('R1：真实清单有第 10 层 face，z=32 夹在 body-occluder 与 ahoge 之间且 ≤ SAFE_OVERLAY_Z', () => {
  const layers = PET_LAYERS.layers;
  const face = layers.find((layer) => layer.layerId === FACE_LAYER_ID);
  assert.ok(face, '真实清单缺 face 层（表情在 layered 下就看不见了）');
  const occluder = layers.find((layer) => layer.layerId === 'body-occluder');
  const ahoge = layers.find((layer) => layer.layerId === 'ahoge');
  assert.ok(occluder && ahoge);
  assert.equal(face?.z, 32);
  assert.ok((face?.z ?? 0) > (occluder?.z ?? 0), 'face 必须盖住 body-occluder 里画好的中性脸');
  assert.ok((face?.z ?? 0) < (ahoge?.z ?? 0), '脸层不能压住呆毛/蝴蝶结（换表情不许把发饰刷掉）');
  assert.ok((face?.z ?? 0) <= SAFE_OVERLAY_Z, 'face.z 必须 ≤ SAFE_OVERLAY_Z，缺脸层时才会整体回落压平帧');
  assert.equal(face?.role, 'animatable');
  assert.equal(face?.required, true);
  assert.deepEqual(face?.rect, FACE_RECT, 'face.rect 必须与贴片真源逐位相等（否则贴片画偏）');
  assert.equal(requestedLayerIds(PET_LAYERS).length, 10, '真实清单必须是 10 层');
  const plan = planMissing([]);
  assert.equal(plan.mode, 'layered');
  assert.ok(
    plan.layers.some((item) => item.spec.layerId === FACE_LAYER_ID),
    'layered 计划里必须含 face 层',
  );
});

// ------------------------------------------------------------------ 放置

test('放置：只有 face 写 data-placement=rect 与四个百分比，其余 9 层不写', () => {
  const { views, host } = setup();
  const face = views.get(FACE_LAYER_ID);
  assert.ok(face, '缺少 face 视图');
  assert.equal(face?.element.dataset.placement, 'rect', "只有 face 层写 data-placement='rect'（整画布层一个字节都不写）");
  // 560/2048、1064/3072、792/2048、400/3072（容忍 1e-4 的百分比写法差异）
  const expect = {
    left: (FACE_RECT.x / PET_LAYERS.canvas.width) * 100,
    top: (FACE_RECT.y / PET_LAYERS.canvas.height) * 100,
    width: (FACE_RECT.width / PET_LAYERS.canvas.width) * 100,
    height: (FACE_RECT.height / PET_LAYERS.canvas.height) * 100,
  };
  for (const [key, expected] of Object.entries(expect)) {
    const raw = face?.element.styleProps.get(RECT_PLACEMENT_VARIABLES[key as keyof typeof expect]) ?? '';
    assert.match(raw, /^-?\d+(\.\d+)?%$/, `${key} 必须写成百分比，实际为 "${raw}"`);
    const numeric = Number.parseFloat(raw);
    assert.ok(
      Math.abs(numeric - expected) < 1e-4,
      `${key} 必须等于 rect/canvas*100 = ${expected.toFixed(6)}，实际 ${raw}`,
    );
  }
  // 其余 9 层：一个放置属性都没有（既有 DOM 写入面零变化）
  const others = [...views.entries()].filter(([layerId]) => layerId !== FACE_LAYER_ID);
  assert.equal(others.length, 9, '除脸层外应当恰好 9 层');
  for (const [layerId, view] of others) {
    assert.equal(view.element.dataset.placement, undefined, `${layerId} 不该被写 data-placement`);
    for (const variable of Object.values(RECT_PLACEMENT_VARIABLES)) {
      assert.equal(
        view.element.styleProps.get(variable),
        undefined,
        `${layerId} 是整画布层，不该写 ${variable}`,
      );
    }
  }
  // 容器本身也不该被误写
  const container = host.children[0];
  assert.equal(container.children.length, 10);
  assert.equal(inferPlanCanvas(planMissing([])).width, 2048);
  assert.equal(inferPlanCanvas(planMissing([])).height, 3072);
});

test('放置：mountLayerViews 自己就写 data-placement（不靠 LayerPresentation 构造时兜底）', () => {
  // 真实运行顺序是"先挂层、后构造表现层"（`select-presentation.ts`）：挂载这一步如果不写放置，
  // 中间会有一帧按整画布 contain 摆的脸贴片——正是 T03 要消灭的"错位闪一下"。
  // 所以这里**不**构造 LayeredPresentation，只验 mountLayerViews 自己的写入面。
  const doc = new FakeDocument();
  const host = new FakeElement('div');
  const views = mountLayerViews(doc, host, planMissing([]), PET_LAYERS.canvas);
  const face = views.get(FACE_LAYER_ID);
  assert.ok(face, '缺少 face 视图');
  assert.equal(face?.element.dataset.placement, 'rect', '挂载时就必须写 data-placement（否则会先按 contain 错位一下）');
  const left = face?.element.styleProps.get(RECT_PLACEMENT_VARIABLES.left) ?? '';
  assert.match(left, /^-?\d+(\.\d+)?%$/, '挂载时就必须写 left 百分比');
  const top = face?.element.styleProps.get(RECT_PLACEMENT_VARIABLES.top) ?? '';
  assert.match(top, /^-?\d+(\.\d+)?%$/, '挂载时就必须写 top 百分比');
  for (const [layerId, view] of views) {
    if (layerId === FACE_LAYER_ID) continue;
    assert.equal(view.element.dataset.placement, undefined, `${layerId} 是整画布层，挂载时不该写 data-placement`);
  }
});

test('放置：整画布层返回 null（不写放置变量），脏矩形也不写', () => {
  const canvas: Size = { width: 2048, height: 3072 };
  assert.equal(rectPlacementOf({ x: 0, y: 0, width: 2048, height: 3072 }, canvas), null);
  assert.equal(rectPlacementOf({ x: 0, y: 0, width: 0, height: 0 }, canvas), null);
  assert.equal(rectPlacementOf(undefined, canvas), null);
  const placement = rectPlacementOf(FACE_RECT, canvas);
  assert.ok(placement);
  assert.equal(placement?.left, '27.34375%');
  assert.equal(placement?.width, '38.671875%');
});

// ------------------------------------------------------------------ R2：贴片路径

test('R2：layered 下切表情只换脸层贴片，整帧兜底一条都不收', () => {
  const { presentation, views, fallback, root } = setup();
  const tiles = faceTileUrls('2x');
  const face = views.get(FACE_LAYER_ID);
  assert.ok(face);
  assert.equal(face?.element.hidden, false, 'layered 下脸层必须是可见的');

  presentation.apply(expressionOp('angry'));
  assert.equal(face?.element.src, tiles.angry, '脸层 src 必须指向该档贴片');
  assert.equal(face?.element.getAttribute('src'), tiles.angry);
  assert.equal(fallback.applied.length, 0, 'layered 下不许再回落整帧（整帧是 opacity:0，等于什么都不做）');
  assert.equal(root.dataset.expression, 'angry');
  assert.equal(presentation.state.expression, 'angry');
  assert.equal(face?.element.dataset.expression, 'angry');

  // 再切一档：身体层一个字都不动，只有脸层换 src
  const body = views.get('body-occluder');
  const bodySrc = body?.element.getAttribute('src');
  const bodyWrites = body?.element.styleProps.size ?? 0;
  presentation.apply(expressionOp('shy'));
  assert.equal(face?.element.src, tiles.shy);
  assert.equal(body?.element.getAttribute('src'), bodySrc, '换表情不许动身体层');
  assert.equal(body?.element.styleProps.size, bodyWrites, '换表情不许给身体层写新的 CSS 变量');
});

test('R2：贴片与整帧两套 URL 同时存在时，脸层必须取贴片（§11.3 M5 的抓手）', () => {
  // 这条是 M5「关闭 faceTile 资源选择（恒用 expressionUrls）」的专用抓手：
  // 只有当同一个表情 id 在两套表里**都有值且互不相同**时，才可能区分实现走了哪套。
  const frameUrls = {
    angry: 'lxa://pet-p1/composites/angry@2x.webp',
    shy: 'lxa://pet-p1/composites/shy@2x.webp',
  };
  const { presentation, views } = setup(undefined, { expressionUrls: frameUrls });
  const tiles = faceTileUrls('2x');
  const face = views.get(FACE_LAYER_ID);
  assert.ok(face);
  for (const id of ['angry', 'shy'] as const) {
    assert.ok(tiles[id], `用例前提：${id} 必须已交付贴片`);
    assert.notEqual(tiles[id], frameUrls[id], `用例前提：${id} 的贴片与整帧 URL 必须不同`);
    presentation.apply(expressionOp(id));
    assert.equal(face?.element.src, tiles[id], `脸层 ${id} 必须用贴片 URL`);
    assert.notEqual(
      face?.element.src,
      frameUrls[id],
      '整帧 URL 绝不能塞进子矩形脸层（object-fit:fill 会把它压扁成一条）',
    );
  }
});

test('R2：degraded 表情（无贴片）保持当前贴片并记日志，绝不拿别的表情顶替', () => {
  const { presentation, views, fallback } = setup();
  const face = views.get(FACE_LAYER_ID);
  const before = face?.element.src;
  const tiles = faceTileUrls('2x');
  // 找一个确实没有贴片的档（美术母版未交付的那两档之一）
  const missing = (['wink', 'blinkHalf'] as const).find((id) => tiles[id] === undefined);
  assert.ok(missing, '用例前提：至少有一档是 degraded（否则这条断言无意义）');
  presentation.apply(expressionOp(missing));
  assert.equal(face?.element.src, before, '缺贴片时不许把 src 改成空/别人的贴片');
  assert.equal(fallback.applied.length, 0, '也不许回落整帧（layered 下它看不见，还会把状态与画面搞成两套）');
});

test('R2：过渡时长写在脸层元素上，根上的 --pet-crossfade-ms 保持全局节奏', () => {
  const { presentation, views, root } = setup();
  const face = views.get(FACE_LAYER_ID);
  presentation.apply(expressionOp('happy'));
  assert.equal(face?.element.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), `${DEFAULT_CROSSFADE_MS}ms`);
  assert.equal(root.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), `${DEFAULT_CROSSFADE_MS}ms`);
  // 显式 fadeMs 优先（非眨眼类）
  presentation.apply(expressionOp('shy', 40));
  assert.equal(face?.element.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), '40ms');
});

test('过渡：blink / blinkHalf / wink 一律 0ms 硬切，根上的变量不被覆盖成 100ms', () => {
  for (const id of ['blink', 'blinkHalf', 'wink'] as const) {
    assert.equal(isBlinkLikeExpression(id), true);
    assert.equal(resolveExpressionFadeMs(id, expressionOp(id, undefined), DEFAULT_CROSSFADE_MS), 0, `${id} 必须硬切`);
    assert.equal(resolveExpressionFadeMs(id, expressionOp(id, 100), DEFAULT_CROSSFADE_MS), 0, `${id} 不许被 fadeMs 覆盖`);
  }
  assert.equal(resolveExpressionFadeMs('happy', expressionOp('happy'), DEFAULT_CROSSFADE_MS), DEFAULT_CROSSFADE_MS);

  const { presentation, views, root } = setup();
  const face = views.get(FACE_LAYER_ID);
  // `blink` 一定有贴片（v3 母版已交付），用它验证"整条链路真的把 0ms 落下去了"
  presentation.apply(expressionOp('blink'));
  assert.equal(face?.element.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), '0ms');
  assert.equal(root.styleProps.get(CROSSFADE_CSS_VARIABLES.duration), `${DEFAULT_CROSSFADE_MS}ms`);
  assert.equal(face?.element.dataset.fading, undefined, '0ms 不需要进场动画标记');
});

// ------------------------------------------------------------------ R3：回落路径

test('R3：计划里没有 face（元素还在）⇒ 表情回落整帧，且脸层必须隐藏', () => {
  const { presentation, views, fallback } = setup();
  const face = views.get(FACE_LAYER_ID);
  assert.ok(face, '元素始终挂着（这正是"按存在性判分支"会踩雷的前提）');

  // 模拟运行期计划降级：层文件解码失败 → 计划里只剩下前景可动层
  const partial = resolveCompositePlan({
    manifest: PET_LAYERS,
    requested: requestedLayerIds(PET_LAYERS),
    density: '2x',
    failedLayers: ['bow'],
  });
  assert.equal(partial.mode, 'partial', '缺一个前景层应当落到 partial');
  presentation.applyPlan(partial);
  assert.equal(face?.element.hidden, true, 'partial 计划里没有脸层，元素必须被隐藏');

  presentation.apply(expressionOp('happy'));
  assert.equal(fallback.applied.length, 1, 'partial 下表情必须回落压平帧（那时它才是可见的）');
  assert.equal(fallback.applied[0].id, 'happy');
  assert.equal(face?.element.src.includes('face/'), true, '脸层 src 不许被改成整帧 URL');
});

test('R3：缺 face 层 ⇒ 计划整体回落 composite（plan.ts 一行不用改）', () => {
  const plan = planMissing([FACE_LAYER_ID]);
  assert.equal(plan.mode, 'composite', '缺脸层必须整体回落压平帧，否则 layered 下表情彻底不可见');
  assert.equal(plan.layers.length, 0);
});

test('R3：composite 计划下 applyExpression 全部委托整帧', () => {
  const composite: CompositePlan = {
    mode: 'composite',
    layers: [],
    fallbackReason: 'test:forced',
    density: '2x',
  };
  const { presentation, views, fallback } = setup(composite);
  presentation.apply(expressionOp('sad'));
  presentation.apply(expressionOp('angry'));
  assert.equal(fallback.applied.length, 2);
  assert.deepEqual(fallback.applied.map((op) => op.id), ['sad', 'angry']);
  for (const [, view] of views) {
    assert.equal(view.element.hidden, true, 'composite 下所有层元素都应隐藏');
  }
});

test('R3：预留 —— 清单里没有 face 层时 classify 侧也拿不到脸区（faceLayer 返回 null）', async () => {
  const { faceLayer } = await import('../src/pet/layers/manifest');
  const withoutFace: LayerManifest = {
    ...PET_LAYERS,
    layers: PET_LAYERS.layers.filter((layer: LayerSpec) => layer.layerId !== FACE_LAYER_ID),
  };
  assert.equal(faceLayer(withoutFace), null);
  assert.ok(faceLayer(PET_LAYERS), '真实清单必须能取到脸层');
});
