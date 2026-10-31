/**
 * 桌宠运行时资产清单（**生成物，勿手改**）。
 *
 * <p>由 `frontend/scripts/build-pet-assets.mjs` 从源目录
 * `../docs/assets/desktop-pet/v2` 生成：`npm run build:pet-assets`。</p>
 *
 * <p>为什么要生成而不是手写：资产尺寸、体积、URL 三处必须一致，手写必然漂移；
 * 门禁 `npm run gate:pet` 校验资产头比例，`tests/petAssetManifest.test.cjs` 校验清单与磁盘一致。</p>
 *
 * @module pet/assets/manifest
 */
import type { ExpressionId } from '../presentation/types';

/** 一档运行时立绘。 */
export interface PetArtAsset {
  /** 密度标识（`1x` / `2x`）。 */
  readonly density: '1x' | '2x';
  /** 文件名（相对运行时目录）。 */
  readonly file: string;
  /** `lxa://` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** 容器格式。 */
  readonly format: string;
}

/** 一档表情差分贴片（与立绘同画布同位置）。 */
export interface PetExpressionAsset {
  /** 表情 id（与美术规格书 §5 的 E1–E8 对应）。 */
  readonly id: ExpressionId;
  /** 文件名。 */
  readonly file: string;
  /** `lxa://` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** 容器格式。 */
  readonly format: string;
}

/** 资产清单。 */
export interface PetAssetManifest {
  /** 清单结构版本。 */
  readonly version: number;
  /** 生成器标识（排障用）。 */
  readonly generatedBy: string;
  /** 母版信息（只用于对账，不进运行时）。 */
  readonly master: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
  /** 运行时立绘（按密度）。 */
  readonly art: readonly PetArtAsset[];
  /** 表情贴片（未交付时为空表）。 */
  readonly expressions: Readonly<Partial<Record<ExpressionId, PetExpressionAsset>>>;
}

/** 运行时资产清单。 */
export const PET_ASSET_MANIFEST: PetAssetManifest = {
  version: 1,
  generatedBy: 'scripts/build-pet-assets.mjs',
  master: {
    file: 'front-standing.png',
    width: 1024,
    height: 1536,
    bytes: 1970393,
  },
  art: [
    {
      density: '1x',
      file: 'front-standing@1x.webp',
      url: 'lxa://pet-v2/front-standing@1x.webp',
      width: 160,
      height: 240,
      bytes: 18378,
      format: 'webp-extended',
    },
    {
      density: '2x',
      file: 'front-standing@2x.webp',
      url: 'lxa://pet-v2/front-standing@2x.webp',
      width: 320,
      height: 480,
      bytes: 50332,
      format: 'webp-extended',
    },
  ],
  expressions: {

  },
};

/**
 * 取某个密度的立绘 URL。
 *
 * @param density 密度（缺省 `2x`）
 * @returns `lxa://` URL；该密度不存在时回落到 `2x`，再没有则返回空串
 */
export function petArtUrl(density: '1x' | '2x' = '2x'): string {
  const matched = PET_ASSET_MANIFEST.art.find((item) => item.density === density);
  if (matched) return matched.url;
  return PET_ASSET_MANIFEST.art[0]?.url ?? '';
}

/**
 * 表情贴片 URL 表（直接喂给 `SpritePresentation`）。
 *
 * @returns 表情 id → URL；未交付的档不会出现在表里
 */
export function expressionPatchUrls(): Partial<Record<ExpressionId, string>> {
  const result: Partial<Record<ExpressionId, string>> = {};
  for (const [id, asset] of Object.entries(PET_ASSET_MANIFEST.expressions)) {
    if (asset) result[id as ExpressionId] = asset.url;
  }
  return result;
}
