/**
 * 分层资产契约类型（`frontend/pet-layers.json` 的强类型视图）。
 *
 * <p><b>为什么把类型单开一个文件：</b>层清单、降级选路（`plan.ts`）、合成器（`presentation/layered-presentation.ts`）
 * 与门禁脚本（`scripts/check-pet-layers.mjs`）都读同一份契约。类型放在这里，
 * 数据层与写入面各自 import，就不会出现"合成器自己另定一套字段名"的漂移。</p>
 *
 * <p><b>坐标空间（全模块统一，与 `pet/layout.ts` 一致，禁止各自换算）：</b></p>
 * <ul>
 *   <li>画布坐标：母版像素，原点画布左上。`canvas` 是母版 2048×3072；
 *       `nativeCanvas` 是它的原生 1024×1536（母版 = 原生最近邻 2× 放大，<b>不含额外细节</b>）；</li>
 *   <li>层矩形 `rect` 与锚点 `anchor` 用**母版像素**（与美术清单同单位，便于直接对账）；</li>
 *   <li>支点 `pivot` 用**层矩形归一化坐标**（0..1，原点在层矩形左上），
 *       于是换密度（@1x/@2x）时支点不用重标。</li>
 * </ul>
 *
 * <p><b>字段不可改名的原因：</b>`layerId` 是美术交件名、动作目录选择器、将来 Cubism 参数表三处共用的
 * 稳定标识，改名等于让美术白画。</p>
 *
 * @module pet/layers/types
 */
import type { PetDensity } from '../assets/manifest';

/** 尺寸（画布像素或 CSS px，按使用处注明）。 */
export interface Size {
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 支点（层矩形归一化坐标，0..1，原点层左上）。 */
export interface Pivot {
  /** 水平位置，0 = 层左边，1 = 层右边。 */
  readonly u: number;
  /** 垂直位置，0 = 层上边，1 = 层下边。 */
  readonly v: number;
}

/** 锚点（母版像素，与美术清单 `anchor` 同单位）。 */
export interface NativeAnchor {
  /** 锚点 x（母版像素）。 */
  readonly x: number;
  /** 锚点 y（母版像素）。 */
  readonly y: number;
}

/** 层矩形（母版像素）。 */
export interface LayerRect {
  /** 左上角 x。 */
  readonly x: number;
  /** 左上角 y。 */
  readonly y: number;
  /** 宽。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/**
 * 混合模式。
 *
 * <p>只允许这三种：再多就需要 WebGL 合成，而本方案的载体是多个 `<img>` 叠层
 * （`mix-blend-mode` 只支持这三种在透明窗口下表现稳定）。</p>
 */
export type LayerBlend = 'normal' | 'multiply' | 'screen';

/** 单个密度下的层文件（字段与 `pet-assets.json` 的 `frames[id][density]` 同构，门禁代码可直接复用）。 */
export interface LayerFile {
  /** 相对 `assetBase` 的路径（POSIX 风格），如 `layers/tail@1x.webp`。 */
  readonly file: string;
  /** `lxa://` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** sha256（与美术交付对账）。 */
  readonly sha256: string;
  /** 容器格式（`webp` / `png`）。 */
  readonly format: string;
}

/** 按密度组织的层文件表（缺项 = 该密度未交付）。 */
export type LayerFileMap = Partial<Record<PetDensity, LayerFile>>;

/** 一层（一个可独立做 `transform` 的贴片）。 */
export interface LayerSpec {
  /** 稳定标识（定下不改）。 */
  readonly layerId: string;
  /** 绘制顺序，小的在后；同 `z` 不允许（门禁会拒）。 */
  readonly z: number;
  /** 惯性继承源：`root` = 跟身体整体，其余为别的层 id。 */
  readonly parent: string;
  /** 旋转支点（层矩形归一化坐标）。 */
  readonly pivot: Pivot;
  /** 层自身矩形（母版像素）。 */
  readonly rect: LayerRect;
  /** 混合模式。 */
  readonly blend: LayerBlend;
  /** 不透明度（0..1）。 */
  readonly opacity: number;
  /** 该层应遮住哪些更靠后的层（验收用：裁口检查）。 */
  readonly occludes: readonly string[];
  /** 各密度的文件（由构建脚本回填，人不要手写）。 */
  readonly files: LayerFileMap;
  /** 是否属于 `layered` 模式的必需层（缺省 true；false = 纯装饰，缺了也能分层）。 */
  readonly required: boolean;
}

/** 层清单（`frontend/pet-layers.json`）。 */
export interface LayerManifest {
  /** 契约版本（字段语义变化时自增）。 */
  readonly version: number;
  /** 美术资产 id。 */
  readonly assetId: string;
  /**
   * 总闸：`false` 时运行期完全走现状（`composite`）。
   *
   * <p>这是唯一开关，且**默认必须是 `false`**——分层资产是外部产能依赖，
   * 代码可以先合、后开闸（M6）。</p>
   */
  readonly enabled: boolean;
  /** 层文件的 URL 前缀（如 `lxa://pet-v3/`），`LayerFile.url = assetBase + file`。 */
  readonly assetBase: string;
  /** 母版画布尺寸（像素）。 */
  readonly canvas: Size;
  /** 原生画布尺寸（母版是它的最近邻放大）。 */
  readonly nativeCanvas: Size;
  /** 脚底锚点（母版像素，与美术清单同值，禁止另定义）。 */
  readonly anchor: NativeAnchor;
  /** 支持的分辨率档位。 */
  readonly densities: readonly PetDensity[];
  /** 层列表（按 `z` 升序由访问器给出，文件里顺序不作数）。 */
  readonly layers: readonly LayerSpec[];
}

/** 合成模式（三级降级）。 */
export type CompositeMode = 'composite' | 'partial' | 'layered';

/** 一层的就绪状态（`resolveCompositePlan` 的产出）。 */
export interface ResolvedLayer {
  /** 层契约。 */
  readonly spec: LayerSpec;
  /** 该密度的文件是否可用。 */
  readonly ready: boolean;
  /** 不可用原因（`ready=true` 时为空串）。 */
  readonly missingReason: string;
}

/** 合成计划（渲染层的唯一输入）。 */
export interface CompositePlan {
  /** 选中的模式。 */
  readonly mode: CompositeMode;
  /** 参与渲染的层（按 `z` 升序；`composite` 模式为空数组）。 */
  readonly layers: readonly ResolvedLayer[];
  /** 选路理由（排障用；`layered` 时为空串）。 */
  readonly fallbackReason: string;
  /** 本次选路使用的密度。 */
  readonly density: PetDensity;
}

/** 选路输入。 */
export interface PlanInput {
  /** 层清单。 */
  readonly manifest: LayerManifest;
  /** 本模式需要的层 id（idle 时 = 全部可见层）。 */
  readonly requested: readonly string[];
  /** 渲染密度。 */
  readonly density: PetDensity;
  /** 解码失败过的层（一次失败在本进程内不再重试）。 */
  readonly failedLayers?: readonly string[];
}

/** 清单校验问题（人话，直接进日志与门禁输出）。 */
export interface ManifestIssue {
  /** 定位串，如 `layers[2].pivot.u`。 */
  readonly path: string;
  /** 说明。 */
  readonly message: string;
}
