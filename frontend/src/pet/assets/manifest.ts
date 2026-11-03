/**
 * 桌宠运行时资产清单（**生成物，勿手改**）。
 *
 * <p>数据源是仓库根的 `frontend/pet-assets.json`（由 `npm run build:pet-assets` 生成并入库），
 * 本文件只做类型化与访问器。为什么不把数据直接写在这里：门禁脚本与 node 测试要读同一份数据，
 * 解析 TS 文本太脆，所以数据落 JSON、类型留 TS。</p>
 *
 * <p><b>注意：</b>母版 2048×3072 是 1024×1536 原生画布的**最近邻 2× 放大**
 * （美术清单 `masterScale.addsDetail=false`），<b>不含额外细节</b>。别在注释或文档里声称"2× 高清母版"。</p>
 *
 * @module pet/assets/manifest
 */
import assetsSource from '../../../pet-assets.json';
import type { ExpressionId } from '../presentation/types';

/** 密度标识。 */
export type PetDensity = '1x' | '2x';

/** 一个运行时资产文件。 */
export interface PetAssetFile {
  /** 相对输出目录的路径（POSIX 风格）。 */
  readonly file: string;
  /** `lxa://` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** sha256（与美术清单对账）。 */
  readonly sha256: string;
  /** 容器格式。 */
  readonly format: string;
}

/** 按密度组织的资产表。 */
export type PetDensityMap = Partial<Record<PetDensity, PetAssetFile>>;

/**
 * 眨眼映射（与美术清单 `blink` 字段一致，缺项由 {@link PET_BLINK_MAPPING} 兜底）。
 *
 * <p><b>`wink` 为什么必填：</b>它属于**交互表情**（单眼闭合），不属于生理眨眼三态。
 * 放在同一张表里是为了让"眼部语义"只有一个出口：谁想知道"单眼闭合用哪一档"，
 * 都从这里读，而不是各自在调用点写字面量。生理三态与交互表情是否互斥由
 * `presentation/priority.ts` 的 `BLINK_LIKE_EXPRESSIONS` 决定，不在这里判。</p>
 */
export interface PetBlinkMapping {
  /** 睁眼表情。 */
  readonly open: ExpressionId;
  /** 闭眼表情。 */
  readonly closed: ExpressionId;
  /** 半闭表情（三态的中间帧）。 */
  readonly half: ExpressionId;
  /**
   * 单眼闭合（wink，交互表情）。
   *
   * <p>美术母版未交付时该档走 `pet-face-tiles.json` 的 `degraded` 降级路径，
   * **不代表资产存在**（设计文档 §5.3）。</p>
   */
  readonly wink: ExpressionId;
  /** 眼部原生区域（1024×1536 坐标系）。 */
  readonly eyeRegionNative: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** 资产清单（结构见 `pet-assets.json`）。 */
export interface PetAssets {
  /** 清单结构版本。 */
  readonly version: number;
  /** 生成器标识。 */
  readonly generatedBy: string;
  /** 美术资产 id。 */
  readonly assetId: string;
  /** 源目录（相对仓库根，排障用）。 */
  readonly sourceDir: string;
  /** 合成模式：`composite`（整帧）/ `overlay`（无头身体 + 整头）/ `transcode`（本地转码）。 */
  readonly mode: 'composite' | 'overlay' | 'transcode';
  /** 母版画布尺寸。 */
  readonly canvas: { readonly width: number; readonly height: number };
  /** 原生画布尺寸（母版是它的最近邻放大）。 */
  readonly nativeCanvas: { readonly width: number; readonly height: number };
  /** 色彩空间。 */
  readonly colorSpace: string;
  /** alpha 模式（`straight` = 不预乘）。 */
  readonly alpha: string;
  /** 母版放大信息（`addsDetail=false` = 没有真 2× 细节）。 */
  readonly masterScale: { readonly factor: number; readonly kernel: string; readonly addsDetail: boolean };
  /** 脚底锚点（归一化）。 */
  readonly anchorNormalized: { readonly x: number; readonly y: number };
  /** 各密度下头部结束的 y 像素（用于未来分层件的裁剪）。 */
  readonly headEndByScale: Readonly<Record<PetDensity, number>>;
  /** 眨眼映射。 */
  readonly blink: PetBlinkMapping;
  /** 美术声明的 8 档表情 id（用于与渲染层枚举对账）。 */
  readonly expressionIds: readonly ExpressionId[];
  /** 支持的密度。 */
  readonly densities: readonly { readonly id: PetDensity; readonly suffix: string }[];
  /** 每个表情在各密度下的完整帧（composite / transcode 模式）。 */
  readonly frames: Readonly<Partial<Record<ExpressionId, PetDensityMap>>>;
  /** 每个表情的整头贴片（overlay 模式）。 */
  readonly patches: Readonly<Partial<Record<ExpressionId, PetDensityMap>>>;
  /** 无头身体（overlay 模式）。 */
  readonly body: PetDensityMap | null;
  /** 汇总与预算。 */
  readonly totals: { readonly fileCount: number; readonly bytes: number };
}

/** 运行时资产清单。 */
export const PET_ASSETS: PetAssets = assetsSource as unknown as PetAssets;

/**
 * 取指定密度的表情完整帧 URL。
 *
 * @param id 表情 id
 * @param density 密度（缺省 `2x`）
 * @returns `lxa://` URL；该档缺失时回落另一档，再没有返回空串
 */
export function expressionFrameUrl(id: ExpressionId, density: PetDensity = '2x'): string {
  const byDensity = PET_ASSETS.frames[id];
  if (!byDensity) return '';
  return byDensity[density]?.url ?? byDensity['2x']?.url ?? byDensity['1x']?.url ?? '';
}

/**
 * 表情完整帧 URL 表（直接喂给 `SpritePresentation`）。
 *
 * @param density 密度（缺省 `2x`）
 * @returns 表情 id → URL（未交付的档不在表里）
 */
export function expressionFrameUrls(density: PetDensity = '2x'): Partial<Record<ExpressionId, string>> {
  const result: Partial<Record<ExpressionId, string>> = {};
  for (const [id, byDensity] of Object.entries(PET_ASSETS.frames)) {
    const url = byDensity?.[density]?.url ?? byDensity?.['2x']?.url ?? byDensity?.['1x']?.url;
    if (url) result[id as ExpressionId] = url;
  }
  return result;
}

/**
 * 默认立绘 URL（`neutral` 完整帧）。
 *
 * @param density 密度（缺省 `2x`）
 * @returns `lxa://` URL
 */
export function petArtUrl(density: PetDensity = '2x'): string {
  return expressionFrameUrl('neutral', density);
}

/**
 * 无头身体 URL（overlay 模式；composite 模式返回空串）。
 *
 * @param density 密度（缺省 `2x`）
 * @returns `lxa://` URL 或空串
 */
export function bodyUrl(density: PetDensity = '2x'): string {
  return PET_ASSETS.body?.[density]?.url ?? PET_ASSETS.body?.['2x']?.url ?? '';
}

/**
 * 眨眼映射（渲染层的眨眼调度器与这里同源）。
 *
 * <p><b>为什么要在这里补 `wink` 而不是直接 `= PET_ASSETS.blink`：</b>`pet-assets.json`
 * 由 `scripts/build-pet-assets.mjs` 从美术清单生成，v3 清单（`lingxi-pet-p0-v3`）里
 * 只有生理三态、没有 `wink`；v4 清单会补上。若直接取用，`PET_BLINK_MAPPING.wink` 在
 * v4 到货前会是 `undefined`，而类型写着 `ExpressionId`——那正是"假装有资产"。
 * 所以这里显式兜底成枚举里的 `'wink'`：**档位存在、资产可以缺**，
 * 缺资产由 `pet-face-tiles.json` 的 `degraded` 声明，渲染层按降级路径处理。</p>
 */
export const PET_BLINK_MAPPING: PetBlinkMapping = {
  ...PET_ASSETS.blink,
  wink: PET_ASSETS.blink.wink ?? 'wink',
};
