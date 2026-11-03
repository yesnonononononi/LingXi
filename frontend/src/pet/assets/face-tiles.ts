/**
 * 脸区贴片清单访问器：`frontend/pet-face-tiles.json` 的唯一类型化入口。
 *
 * <p><b>数据与类型分开的原因</b>（与 `assets/manifest.ts` 同因）：门禁脚本与 node 测试要读同一份数据，
 * 解析 TS 文本太脆。数据落 JSON（生成物，由 `scripts/build-pet-face-tiles.mjs` 写），类型留在这里。</p>
 *
 * <p><b>三件容易记错的事：</b></p>
 * <ol>
 *   <li>`faceRegion` 是**母版像素**（2048×3072 坐标系，`{x,y,width,height}`），
 *       与 `pet-layers.json` 的 `face.rect` 必须逐位相等（门禁 C2/C3 守这条）；</li>
 *   <li>贴片文件尺寸是**固定**的：`@2x = 396×200`、`@1x = 198×100`。
 *       不要把整帧 URL 塞进脸层——`object-fit: fill` 会把它压扁成一条（设计文档 §3.2 的变异体 M5）；</li>
 *   <li>`degraded` 里的 id **没有贴片**（美术母版未交付）。查 `faceTileUrl('wink')` 会得到空串，
 *       调用方必须走降级路径，**不许**拿别的表情顶替（`wink` ≠ `blink`，见 §5）。</li>
 * </ol>
 *
 * @module pet/assets/face-tiles
 */
import tilesSource from '../../../pet-face-tiles.json';
import type { LayerRect } from '../layers/types';
import type { PetDensity } from './manifest';
import type { ExpressionId } from '../presentation/types';

/** 原生像素矩形（1024×1536 坐标系；与美术清单的 `nativeFaceEditCrop` 同单位）。 */
export interface NativeRect {
  /** 左边界。 */
  readonly left: number;
  /** 上边界。 */
  readonly top: number;
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 一张脸贴片文件（字段与层清单的 `LayerFile` 同构，门禁代码可直接复用）。 */
export interface FaceTileFile {
  /** 相对 `assetBase` 的路径（如 `face/neutral@2x.webp`）。 */
  readonly file: string;
  /** `lxa://` URL。 */
  readonly url: string;
  /** 像素宽度（严格 396 / 198）。 */
  readonly width: number;
  /** 像素高度（严格 200 / 100）。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** sha256（与磁盘文件对账）。 */
  readonly sha256: string;
  /** 容器格式（`webp-lossless`）。 */
  readonly format: string;
}

/** 按密度组织的脸贴片表。 */
export type FaceTileFileMap = Partial<Record<PetDensity, FaceTileFile>>;

/** 脸贴片清单（`pet-face-tiles.json` 的强类型视图）。 */
export interface FaceTilesManifest {
  /** 清单结构版本。 */
  readonly version: number;
  /** 生成器标识。 */
  readonly generatedBy: string;
  /** 资产 id。 */
  readonly assetId: string;
  /** `lxa://` 前缀。 */
  readonly assetBase: string;
  /** 脸区矩形（母版像素）。 */
  readonly faceRegion: LayerRect;
  /** 脸区矩形（原生像素）。 */
  readonly faceRegionNative: NativeRect;
  /** 本次取母版的目录（相对仓库根，排障用）。 */
  readonly masterDir: string;
  /** 没有贴片的表情 id（美术母版未交付，必须走降级路径）。 */
  readonly degraded: readonly string[];
  /** 表情 id → 各密度贴片。 */
  readonly faceTiles: Readonly<Partial<Record<ExpressionId, FaceTileFileMap>>>;
}

/** 脸贴片清单（生成物）。 */
export const FACE_TILES_MANIFEST: FaceTilesManifest = tilesSource as unknown as FaceTilesManifest;

/** 表情 id → 各密度贴片（`LayeredPresentationDeps.faceTileUrls` 的原始数据源）。 */
export const FACE_TILES: FaceTilesManifest['faceTiles'] = FACE_TILES_MANIFEST.faceTiles;

/** 脸区矩形（母版像素；与 `pet-layers.json` 的 `face.rect` 必须逐位相等）。 */
export const FACE_REGION: LayerRect = FACE_TILES_MANIFEST.faceRegion;

/** 脸区矩形（原生像素，1024×1536 坐标系）。 */
export const FACE_REGION_NATIVE: NativeRect = FACE_TILES_MANIFEST.faceRegionNative;

/** 没有贴片的表情 id 集合（`degraded` 的 Set 视图，便于 O(1) 判定）。 */
export const FACE_DEGRADED_IDS: ReadonlySet<string> = new Set(FACE_TILES_MANIFEST.degraded);

/**
 * 判断某档表情是否处于降级状态（美术母版未交付）。
 *
 * @param id 表情 id
 * @returns `true` = 没有贴片，调用方必须走降级路径
 */
export function isFaceDegraded(id: ExpressionId): boolean {
  return FACE_DEGRADED_IDS.has(id);
}

/**
 * 取指定密度的脸贴片文件条目。
 *
 * @param id 表情 id
 * @param density 密度（缺省 `2x`）
 * @returns 文件条目；该档未交付时回落另一档，再没有返回 null
 */
export function faceTileFile(id: ExpressionId, density: PetDensity = '2x'): FaceTileFile | null {
  const byDensity = FACE_TILES[id];
  if (!byDensity) return null;
  return byDensity[density] ?? byDensity['2x'] ?? byDensity['1x'] ?? null;
}

/**
 * 取指定密度的脸贴片 URL。
 *
 * @param id 表情 id
 * @param density 密度（缺省 `2x`）
 * @returns `lxa://` URL；没有贴片时返回空串（**空串 = 走降级路径**，不是"可以不处理"）
 */
export function faceTileUrl(id: ExpressionId, density: PetDensity = '2x'): string {
  return faceTileFile(id, density)?.url ?? '';
}

/**
 * 表情 id → URL 表（直接喂给 `LayeredPresentationDeps.faceTileUrls`）。
 *
 * @param density 密度（缺省 `2x`）
 * @returns 有贴片的表情才在表里（`degraded` 的不出现，调用方据此回落压平帧）
 */
export function faceTileUrls(density: PetDensity = '2x'): Partial<Record<ExpressionId, string>> {
  const result: Partial<Record<ExpressionId, string>> = {};
  for (const [id, byDensity] of Object.entries(FACE_TILES)) {
    const url = byDensity?.[density]?.url ?? byDensity?.['2x']?.url ?? byDensity?.['1x']?.url;
    if (url) result[id as ExpressionId] = url;
  }
  return result;
}
