/**
 * 层清单访问器：`frontend/pet-layers.json` 的唯一类型化入口。
 *
 * <p><b>为什么不让渲染层直接 `import json`：</b>清单是**生成物**（`files/sha256` 由
 * `scripts/build-pet-layers.mjs` 回填），人可能改坏。这里做三件事：</p>
 * <ol>
 *   <li>结构校验（缺字段/越界/重复 id 一律点名报错，而不是让 `undefined` 流到 DOM 里）；</li>
 *   <li>排序与选档（`layers` 按 `z` 升序、按 `devicePixelRatio` 选 `1x`/`2x`）；</li>
 *   <li>URL 解析（`assetBase + file`，渲染层永远不拼绝对路径）。</li>
 * </ol>
 *
 * <p><b>本模块是纯数据 + 纯函数，不碰 DOM</b>（设计文档 §8 共享知识第 4 条），
 * 因此可以在 node 里直接单测。</p>
 *
 * <h2>已知限制：P1 资产没有 `face` 层 → layered 模式下表情的"面部"不可见</h2>
 *
 * <p><b>这不是 bug，是已决策的取舍，别再去考古两小时：</b></p>
 * <ul>
 *   <li>P1 的分层件只有身体/耳朵/呆毛/蝴蝶结/尾巴等 9 层，<b>没有独立的 `face` 层</b>，
 *       所以表情（`happy` / `angry` / `sleepy` …）只能落到<b>整帧兜底</b>
 *       （`presentation/layered-presentation.ts` 的 `applyExpression` 里
 *       `views.get(FACE_LAYER_ID)` 为空就走 `baseFallback`）；</li>
 *   <li>而 `pet.css` 为了让层栈（动态尾巴）不与静止压平帧重影，在
 *       `data-composite-mode='layered'` 下把 `.pet-art-frame` 整帧 `opacity: 0`。
 *       两者相乘的结果就是：<b>layered 下表情的"脸"看不见</b>，
 *       能看见的只有<b>身体动作</b>（tap 的蹦、angry 的抖、wake、drag —— 它们挂在
 *       `.pet-action` 上，两种模式下都可见）；</li>
 *   <li><b>演示/验收要看到表情，请用 `?layers=0` 走 composite</b>（压平帧可见，
 *       表情就是整帧切换）；</li>
 *   <li><b>用户已决策（C 方案）</b>：不补做 `face` 层、不投美术、不关分层总闸，
 *       等 P2 和 face 层一起做。所以：<b>不要</b>为此生成 face 贴图、
 *       <b>不要</b>改美术管线、<b>不要</b>把 `pet-layers.json` 的 `enabled` 关掉、
 *       <b>更不要</b>把动作动画改回挂 `.pet-art-frame`（那会把"看得见的动作"一起弄没，
 *       守卫见 `tests/petMotionHost.test.ts`）。</li>
 * </ul>
 *
 * @module pet/layers/manifest
 */
import layersSource from '../../../pet-layers.json';
import type { PetDensity } from '../assets/manifest';
import type { LayerFileMap, LayerManifest, LayerSpec, ManifestIssue, NativeAnchor } from './types';

/** 密度 → 文件名后缀（与美术 `@1x` / `@2x` 命名一致）。 */
export const LAYER_DENSITY_SUFFIX: Readonly<Record<PetDensity, string>> = {
  '1x': '@1x',
  '2x': '@2x',
};

/** 允许的密度（顺序 = 质量升序）。 */
export const SUPPORTED_DENSITIES: readonly PetDensity[] = ['1x', '2x'];

/** 允许的混合模式（与 `types.ts` 的 `LayerBlend` 同步）。 */
export const SUPPORTED_BLENDS: readonly string[] = ['normal', 'multiply', 'screen'];

/** 允许的层角色（与 `types.ts` 的 `LayerRole` 同步）。 */
export const SUPPORTED_ROLES: readonly string[] = ['animatable', 'support'];

/**
 * 关闸兜底清单：清单读坏时用它顶上。
 *
 * <p>宁可"分层不生效"（等于今天的行为），也不要因为一个手改坏的 JSON 让桌宠白屏。</p>
 */
export const DISABLED_LAYER_MANIFEST: LayerManifest = Object.freeze({
  version: 1,
  assetId: 'lingxi-pet-p1-layers',
  enabled: false,
  assetBase: 'lxa://pet-v3/',
  canvas: Object.freeze({ width: 2048, height: 3072 }),
  nativeCanvas: Object.freeze({ width: 1024, height: 1536 }),
  anchor: Object.freeze({ x: 1024, y: 2908 }),
  densities: Object.freeze(['1x', '2x'] as PetDensity[]),
  layers: Object.freeze([] as LayerSpec[]),
}) as LayerManifest;

/**
 * 判断一个值是不是有限数值。
 *
 * @param value 待判断值
 * @returns 是否为有限数值
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 读一个非负整数。
 *
 * @param value 原始值
 * @param path 定位串
 * @param issues 问题收集器
 * @param fallback 缺省值
 * @returns 校验后的数值（非法时返回缺省值并记一条问题）
 */
function readPositiveInt(value: unknown, path: string, issues: ManifestIssue[], fallback: number): number {
  if (!isFiniteNumber(value) || value <= 0 || !Number.isInteger(value)) {
    issues.push({ path, message: `必须是正整数，实际为 ${String(value)}` });
    return fallback;
  }
  return value;
}

/**
 * 读一个 0..1 的比例值。
 *
 * @param value 原始值
 * @param path 定位串
 * @param issues 问题收集器
 * @param fallback 缺省值
 * @returns 校验后的数值
 */
function readUnitNumber(value: unknown, path: string, issues: ManifestIssue[], fallback: number): number {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    issues.push({ path, message: `必须落在 0..1，实际为 ${String(value)}` });
    return fallback;
  }
  return value;
}

/**
 * 校验并收集层清单问题（**不抛异常**，供运行期兜底与门禁共用）。
 *
 * @param raw 原始 JSON 值
 * @returns 问题列表（空 = 结构合法）
 */
export function collectManifestIssues(raw: unknown): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    issues.push({ path: '$', message: '层清单必须是对象' });
    return issues;
  }
  const source = raw as Record<string, unknown>;

  if (!isFiniteNumber(source.version) || source.version !== 1) {
    issues.push({ path: 'version', message: `必须为 1，实际为 ${String(source.version)}` });
  }
  if (typeof source.assetId !== 'string' || source.assetId.length === 0) {
    issues.push({ path: 'assetId', message: '必须是非空字符串' });
  }
  if (typeof source.enabled !== 'boolean') {
    issues.push({ path: 'enabled', message: `必须是布尔值，实际为 ${String(source.enabled)}` });
  }
  if (typeof source.assetBase !== 'string' || !source.assetBase.startsWith('lxa://')) {
    issues.push({ path: 'assetBase', message: `必须以 lxa:// 开头，实际为 ${String(source.assetBase)}` });
  }

  const canvas = source.canvas as Record<string, unknown> | undefined;
  const canvasWidth = readPositiveInt(canvas?.width, 'canvas.width', issues, 0);
  const canvasHeight = readPositiveInt(canvas?.height, 'canvas.height', issues, 0);
  if (canvasWidth > 0 && canvasHeight > 0 && Math.abs(canvasWidth / canvasHeight - 2 / 3) > 0.002) {
    issues.push({
      path: 'canvas',
      message: `必须是 2:3，实际为 ${canvasWidth}×${canvasHeight}（比例 ${(canvasWidth / canvasHeight).toFixed(4)}）`,
    });
  }

  const nativeCanvas = source.nativeCanvas as Record<string, unknown> | undefined;
  const nativeWidth = readPositiveInt(nativeCanvas?.width, 'nativeCanvas.width', issues, 0);
  const nativeHeight = readPositiveInt(nativeCanvas?.height, 'nativeCanvas.height', issues, 0);
  if (nativeWidth > 0 && nativeHeight > 0 && canvasWidth > 0 && canvasHeight > 0) {
    if (nativeWidth !== canvasWidth / 2 || nativeHeight !== canvasHeight / 2) {
      issues.push({
        path: 'nativeCanvas',
        message: `必须是母版的一半（母版 = 原生最近邻 2× 放大），实际 ${nativeWidth}×${nativeHeight}`,
      });
    }
  }

  const anchor = source.anchor as Record<string, unknown> | undefined;
  const anchorX = anchor?.x;
  const anchorY = anchor?.y;
  if (!isFiniteNumber(anchorX) || !isFiniteNumber(anchorY)) {
    issues.push({ path: 'anchor', message: '必须含有限数值 x/y（母版像素）' });
  } else if (canvasWidth > 0 && canvasHeight > 0) {
    if (anchorX < 0 || anchorX > canvasWidth || anchorY < 0 || anchorY > canvasHeight) {
      issues.push({ path: 'anchor', message: `锚点 (${anchorX}, ${anchorY}) 越出画布 ${canvasWidth}×${canvasHeight}` });
    }
  }

  const densities = source.densities;
  if (!Array.isArray(densities) || densities.length === 0) {
    issues.push({ path: 'densities', message: '必须是非空数组' });
  } else {
    for (const density of densities) {
      if (!SUPPORTED_DENSITIES.includes(density as PetDensity)) {
        issues.push({ path: 'densities', message: `不支持的密度 ${String(density)}（只允许 1x / 2x）` });
      }
    }
  }

  const layers = source.layers;
  if (!Array.isArray(layers)) {
    issues.push({ path: 'layers', message: '必须是数组' });
    return issues;
  }

  const seenIds = new Set<string>();
  const seenZ = new Map<number, string>();
  layers.forEach((entry, index) => {
    const prefix = `layers[${index}]`;
    if (!entry || typeof entry !== 'object') {
      issues.push({ path: prefix, message: '必须是对象' });
      return;
    }
    const layer = entry as Record<string, unknown>;
    const layerId = layer.layerId;
    if (typeof layerId !== 'string' || layerId.length === 0) {
      issues.push({ path: `${prefix}.layerId`, message: '必须是非空字符串' });
    } else if (seenIds.has(layerId)) {
      issues.push({ path: `${prefix}.layerId`, message: `重复的 layerId ${layerId}（layerId 必须全局唯一，改了等于让美术白画）` });
    } else {
      seenIds.add(layerId);
    }

    if (!isFiniteNumber(layer.z) || !Number.isInteger(layer.z)) {
      issues.push({ path: `${prefix}.z`, message: `必须是整数，实际为 ${String(layer.z)}` });
    } else if (seenZ.has(layer.z)) {
      issues.push({ path: `${prefix}.z`, message: `z=${layer.z} 与 ${String(seenZ.get(layer.z))} 撞车（同 z 不允许）` });
    } else {
      seenZ.set(layer.z, typeof layerId === 'string' ? layerId : prefix);
    }

    if (typeof layer.parent !== 'string' || layer.parent.length === 0) {
      issues.push({ path: `${prefix}.parent`, message: '必须是非空字符串（root 或别的层 id）' });
    } else if (layer.parent === layerId) {
      issues.push({ path: `${prefix}.parent`, message: '不得指向自己（惯性继承会自激）' });
    }

    const pivot = layer.pivot as Record<string, unknown> | undefined;
    readUnitNumber(pivot?.u, `${prefix}.pivot.u`, issues, 0);
    readUnitNumber(pivot?.v, `${prefix}.pivot.v`, issues, 0);

    const rect = layer.rect as Record<string, unknown> | undefined;
    const rectX = isFiniteNumber(rect?.x) ? rect.x : null;
    const rectY = isFiniteNumber(rect?.y) ? rect.y : null;
    const rectW = readPositiveInt(rect?.width, `${prefix}.rect.width`, issues, 0);
    const rectH = readPositiveInt(rect?.height, `${prefix}.rect.height`, issues, 0);
    if (!isFiniteNumber(rectX)) issues.push({ path: `${prefix}.rect.x`, message: '必须是有限数值' });
    if (!isFiniteNumber(rectY)) issues.push({ path: `${prefix}.rect.y`, message: '必须是有限数值' });
    if (rectX !== null && rectY !== null && rectW > 0 && rectH > 0 && canvasWidth > 0 && canvasHeight > 0) {
      if (rectX < 0 || rectY < 0 || rectX + rectW > canvasWidth || rectY + rectH > canvasHeight) {
        issues.push({
          path: `${prefix}.rect`,
          message: `矩形 (${rectX}, ${rectY}, ${rectW}×${rectH}) 越出母版画布 ${canvasWidth}×${canvasHeight}（rect 用母版像素）`,
        });
      }
    }

    const allowed = layer.allowedRegion as Record<string, unknown> | undefined;
    if (allowed !== undefined) {
      const allowedX = allowed?.x;
      const allowedY = allowed?.y;
      const allowedW = allowed?.width;
      const allowedH = allowed?.height;
      const shapeOk = isFiniteNumber(allowedX) && isFiniteNumber(allowedY) && isFiniteNumber(allowedW) && isFiniteNumber(allowedH);
      if (!shapeOk || (allowedW as number) <= 0 || (allowedH as number) <= 0) {
        issues.push({ path: `${prefix}.allowedRegion`, message: '必须含有限数值 x/y 与正的 width/height' });
      } else if (
        canvasWidth > 0 &&
        canvasHeight > 0 &&
        ((allowedX as number) < 0 ||
          (allowedY as number) < 0 ||
          (allowedX as number) + (allowedW as number) > canvasWidth ||
          (allowedY as number) + (allowedH as number) > canvasHeight)
      ) {
        issues.push({
          path: `${prefix}.allowedRegion`,
          message: `可动区域 (${String(allowedX)}, ${String(allowedY)}, ${String(allowedW)}×${String(allowedH)}) 越出母版画布`,
        });
      }
    }

    if (typeof layer.role !== 'string' || !SUPPORTED_ROLES.includes(layer.role)) {
      issues.push({ path: `${prefix}.role`, message: `只允许 ${SUPPORTED_ROLES.join(' / ')}，实际为 ${String(layer.role)}` });
    }
    if (typeof layer.source !== 'string' || layer.source.length === 0) {
      issues.push({ path: `${prefix}.source`, message: '必须是非空字符串（美术源文件名主干，如 01_tail_base）' });
    }

    if (typeof layer.blend !== 'string' || !SUPPORTED_BLENDS.includes(layer.blend)) {
      issues.push({ path: `${prefix}.blend`, message: `只允许 ${SUPPORTED_BLENDS.join(' / ')}，实际为 ${String(layer.blend)}` });
    }
    readUnitNumber(layer.opacity, `${prefix}.opacity`, issues, 1);

    const occludes = layer.occludes;
    if (!Array.isArray(occludes)) {
      issues.push({ path: `${prefix}.occludes`, message: '必须是数组（可以为空）' });
    } else {
      for (const target of occludes) {
        if (typeof target !== 'string') {
          issues.push({ path: `${prefix}.occludes`, message: `只能引用层 id，实际为 ${String(target)}` });
        }
      }
    }

    const files = layer.files;
    if (!files || typeof files !== 'object') {
      issues.push({ path: `${prefix}.files`, message: '必须是对象（由 build-pet-layers.mjs 回填）' });
    } else {
      for (const [density, file] of Object.entries(files as Record<string, unknown>)) {
        if (!SUPPORTED_DENSITIES.includes(density as PetDensity)) {
          issues.push({ path: `${prefix}.files.${density}`, message: '不支持的密度（只允许 1x / 2x）' });
          continue;
        }
        if (!file || typeof file !== 'object') {
          issues.push({ path: `${prefix}.files.${density}`, message: '必须是对象' });
          continue;
        }
        const record = file as Record<string, unknown>;
        if (typeof record.file !== 'string' || record.file.length === 0) {
          issues.push({ path: `${prefix}.files.${density}.file`, message: '必须是非空字符串' });
        }
        if (typeof record.url !== 'string' || !record.url.startsWith('lxa://')) {
          issues.push({ path: `${prefix}.files.${density}.url`, message: `必须是 lxa:// URL，实际为 ${String(record.url)}` });
        }
        readPositiveInt(record.width, `${prefix}.files.${density}.width`, issues, 0);
        readPositiveInt(record.height, `${prefix}.files.${density}.height`, issues, 0);
        readPositiveInt(record.bytes, `${prefix}.files.${density}.bytes`, issues, 0);
        if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
          issues.push({ path: `${prefix}.files.${density}.sha256`, message: '必须是 64 位小写十六进制 sha256' });
        }
        if (typeof record.format !== 'string' || record.format.length === 0) {
          issues.push({ path: `${prefix}.files.${density}.format`, message: '必须是非空字符串' });
        }
      }
    }

    if (layer.required !== undefined && typeof layer.required !== 'boolean') {
      issues.push({ path: `${prefix}.required`, message: `必须是布尔值，实际为 ${String(layer.required)}` });
    }
  });

  // occludes 只能引用清单里存在的层（引用不存在的层等于"以为挡住了其实没挡"）
  layers.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const list = Array.isArray(record.occludes) ? record.occludes : [];
    for (const target of list) {
      if (typeof target !== 'string') continue;
      if (!seenIds.has(target)) {
        issues.push({ path: `layers[${index}].occludes`, message: `引用了不存在的层 ${target}` });
      }
    }
  });

  return issues;
}

/**
 * 校验并把原始 JSON 转成强类型清单。
 *
 * @param raw 原始 JSON 值
 * @returns 强类型清单
 * @throws TypeError 结构非法时抛出（消息里带全部问题，便于一次改完）
 */
export function normalizeLayerManifest(raw: unknown): LayerManifest {
  const issues = collectManifestIssues(raw);
  if (issues.length > 0) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new TypeError(`[pet-layers] 层清单非法（${issues.length} 处）：${detail}`);
  }
  const source = raw as Record<string, unknown>;
  const layers = (source.layers as Record<string, unknown>[]).map((layer): LayerSpec => ({
    layerId: layer.layerId as string,
    role: layer.role as LayerSpec['role'],
    z: layer.z as number,
    parent: layer.parent as string,
    pivot: layer.pivot as LayerSpec['pivot'],
    rect: layer.rect as LayerSpec['rect'],
    allowedRegion: layer.allowedRegion === undefined ? undefined : (layer.allowedRegion as LayerSpec['rect']),
    source: layer.source as string,
    blend: layer.blend as LayerSpec['blend'],
    opacity: layer.opacity as number,
    occludes: (layer.occludes as string[]).slice(),
    files: { ...(layer.files as LayerFileMap) },
    required: layer.required === undefined ? true : (layer.required as boolean),
  }));
  const densities = (source.densities as PetDensity[]).slice();
  return {
    version: source.version as number,
    assetId: source.assetId as string,
    enabled: source.enabled as boolean,
    assetBase: source.assetBase as string,
    canvas: { ...(source.canvas as LayerManifest['canvas']) },
    nativeCanvas: { ...(source.nativeCanvas as LayerManifest['nativeCanvas']) },
    anchor: { ...(source.anchor as NativeAnchor) },
    densities,
    layers,
  };
}

/**
 * 安全加载：结构非法时回落"关闸空清单"并记日志（**不抛异常**）。
 *
 * <p>运行期白屏比"分层不生效"严重得多：桌宠窗口没有兜底 UI，一个未捕获异常就是一块空白。</p>
 *
 * @param raw 原始 JSON 值
 * @param log 日志出口（缺省静默）
 * @returns 可用的清单（非法时是关闸空清单）
 */
export function loadLayerManifest(raw: unknown, log: (message: string) => void = () => {}): LayerManifest {
  const issues = collectManifestIssues(raw);
  if (issues.length === 0) return normalizeLayerManifest(raw);
  log(`[pet] 层清单非法，已回落到关闸空清单（分层不生效）: ${issues.map((item) => `${item.path}=${item.message}`).join('; ')}`);
  return DISABLED_LAYER_MANIFEST;
}

/** 运行时层清单（由 `frontend/pet-layers.json` 校验而来）。 */
export const PET_LAYERS: LayerManifest = loadLayerManifest(layersSource, (message) => console.warn(message));

/**
 * 层的绘制顺序（`z` 升序，小的先画）。
 *
 * @param manifest 层清单
 * @returns 排序后的层（新数组，不改清单本身）
 */
export function layersSorted(manifest: LayerManifest = PET_LAYERS): readonly LayerSpec[] {
  return [...manifest.layers].sort((left, right) => left.z - right.z);
}

/**
 * 按 id 取层。
 *
 * @param layerId 层 id
 * @param manifest 层清单
 * @returns 层契约；不存在时返回 null
 */
export function findLayer(layerId: string, manifest: LayerManifest = PET_LAYERS): LayerSpec | null {
  return manifest.layers.find((layer) => layer.layerId === layerId) ?? null;
}

/**
 * 本模式需要的层（`required` 未显式关掉的都算）。
 *
 * @param manifest 层清单
 * @returns 层 id 列表（按 `z` 升序）
 */
export function requestedLayerIds(manifest: LayerManifest = PET_LAYERS): readonly string[] {
  return layersSorted(manifest)
    .filter((layer) => layer.required)
    .map((layer) => layer.layerId);
}

/**
 * 可动层 id（`role='animatable'`，按 `z` 升序）。
 *
 * <p>动作目录与 `driven` 指令只能落到这些层上；支撑层（底绘/遮挡）一律静默跳过，
 * 否则"转一下遮挡片"就会露缝。</p>
 *
 * @param manifest 层清单
 * @returns 可动层 id 列表
 */
export function animatableLayerIds(manifest: LayerManifest = PET_LAYERS): readonly string[] {
  return layersSorted(manifest)
    .filter((layer) => layer.role === 'animatable')
    .map((layer) => layer.layerId);
}

/**
 * 按设备像素比选密度。
 *
 * <p>`@2x` 文件是母版的一半分辨率，DPR≥2 时用它才是"原生 1:1"；
 * DPR<2 用 `@1x` 省字节。</p>
 *
 * @param devicePixelRatio 设备像素比（缺省 1）
 * @param manifest 层清单
 * @returns 可用且该清单支持的密度
 */
export function pickLayerDensity(devicePixelRatio = 1, manifest: LayerManifest = PET_LAYERS): PetDensity {
  const wanted: PetDensity = devicePixelRatio >= 2 ? '2x' : '1x';
  if (manifest.densities.includes(wanted)) return wanted;
  return manifest.densities[0] ?? '2x';
}

/**
 * 解析层文件的 `lxa://` URL。
 *
 * @param file 相对路径（如 `layers/tail@1x.webp`）
 * @param manifest 层清单（提供 `assetBase`）
 * @returns 完整 URL
 */
export function layerAssetUrl(file: string, manifest: LayerManifest = PET_LAYERS): string {
  const base = manifest.assetBase.endsWith('/') ? manifest.assetBase : `${manifest.assetBase}/`;
  const relative = file.startsWith('/') ? file.slice(1) : file;
  return `${base}${relative}`;
}

/**
 * 锚点归一化（母版像素 → 0..1）。
 *
 * <p>与 `pet-assets.json` 的 `anchorNormalized` 必须逐位一致（`0.5 / 0.946614583…`），
 * 这是分层契约与现有资产清单的接缝。</p>
 *
 * @param manifest 层清单
 * @returns 归一化锚点
 */
export function anchorNormalized(manifest: LayerManifest = PET_LAYERS): { readonly x: number; readonly y: number } {
  return {
    x: manifest.anchor.x / manifest.canvas.width,
    y: manifest.anchor.y / manifest.canvas.height,
  };
}

/**
 * 读 query 里的分层覆写。
 *
 * <p>`?layers=1` 强制开（排障用）、`?layers=0` 强制关（回归手测用）；**不作为用户可见设置**——
 * 发布态默认值永远是 `pet-layers.json` 的 `enabled`，M6 之前它是 `false`。</p>
 *
 * @param search `location.search`（形如 `?layers=1`）
 * @returns `true`/`false` 覆写值；没有覆写时返回 null
 */
export function layersQueryOverride(search: string): boolean | null {
  if (typeof search !== 'string' || search.length === 0) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = params.get('layers');
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/**
 * 按 query 覆写得到本次运行的清单（深拷贝，不改运行时单例）。
 *
 * @param manifest 层清单
 * @param search `location.search`
 * @returns 覆写后的清单（无覆写时原样返回同一引用）
 */
export function applyLayersQueryOverride(manifest: LayerManifest, search: string): LayerManifest {
  const override = layersQueryOverride(search);
  if (override === null || override === manifest.enabled) return manifest;
  return { ...manifest, enabled: override };
}
