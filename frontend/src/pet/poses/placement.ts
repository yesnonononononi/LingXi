/**
 * 换姿不跳脚：**对齐公式**（纯函数，无 DOM、无窗口 API）。
 *
 * <p><b>只有这一个地方可以把 native 坐标换算成窗口内的 CSS 坐标</b>，
 * 也因此它是 C6（"窗口位置是主进程独占的单一写入者"）在渲染层的对应物：
 * 切姿态/切朝向只改这里的 `left/top`，**绝不改窗口位置**——即使这里算错，
 * 最多是画面错位，宠物不会在桌面上跳走。</p>
 *
 * <p><b>三个域绝不混用（E-01 的教训）：</b></p>
 * <ul>
 *   <li>`anchor` / `canvas` 是**母版域**（3072² 或 2048²）；</li>
 *   <li>`bodyAnchor` / `inkNative` 是**native 域**（母版 ÷ `masterScale`）；</li>
 *   <li>`align` / `left` / `top` / 包络是**窗口 CSS 域**。</li>
 * </ul>
 * <p>域之间只经 `units.ts` 的换算函数过渡。这里因此**不出现**任何
 * `0.15234375` / `×2` / `÷2` 字面量：比例一律取 `scale.nativeToCss`
 * （它是唯一真源，且被 `assertScaleConsistent` 钉死与几何真源一致）。
 * 设计稿 §A1.7.1 曾把 `Py` 写成 `artHeight × (align.yNative / (canvasHeight/2))`，
 * 同一条式子里混了两个域，实得 206.75 而不是 317.51 —— 那正是本模块存在的理由。</p>
 *
 * @module pet/poses/placement
 */
import { ART_ORIGIN, PET_GEOMETRY, type PetGeometry } from '../layout';
import { asCssPx } from './units';
import type { AlignContract, PoseBatch, PoseFrame, PoseScale } from './types';

/** 姿态盒（窗口 CSS 坐标系；`controller.ts` 把它写成 `.pet-pose` 的 left/top/width/height）。 */
export interface PosePlacement {
  /** 左（CSS px）。 */
  readonly left: number;
  /** 上（CSS px）。 */
  readonly top: number;
  /** 宽（= `batch.canvas.width × masterToCss`，逐批读，不写死 234）。 */
  readonly width: number;
  /** 高。 */
  readonly height: number;
}

/** 站姿对齐点在窗口内的位置（CSS px）。 */
export interface AlignPoint {
  /** `Px`：躯干质心要在的窗口横坐标。 */
  readonly x: number;
  /** `Py`：接地线要在的窗口纵坐标。 */
  readonly y: number;
}

/**
 * 算站姿对齐点在窗口内的位置。
 *
 * <p>`Px = artOrigin.x + align.xNative × nativeToCss`；
 * `Py = artOrigin.y + align.yNative × nativeToCss`。</p>
 *
 * <p>两个式子都只用 `nativeToCss` 一个比例（E-01 的修正口径）。与设计稿里
 * `artWidth × (align.xNative / 站姿native宽)` 等价，因为
 * `artWidth / 站姿native宽 === nativeToCss`（156 / 1024 = 0.15234375），
 * 但那两种写法各自要引一个"站姿宽/高"常量，很容易在 `y` 上错写成母版高的一半
 * —— 写成 `align.yNative / (canvasHeight/2)` 就变成 1454/1536 = 0.9466，
 * `Py` 直接错到 317 → 206。所以这里统一乘 `nativeToCss`。</p>
 *
 * @param scale 比例契约（来自 `pet-poses.json`）
 * @param align 站姿对齐点（native）
 * @param geometry 几何真源（默认 `PET_GEOMETRY`，测试可注入）
 * @returns 对齐点（CSS px）
 */
export function alignPointOf(
  scale: PoseScale,
  align: AlignContract,
  geometry: PetGeometry = PET_GEOMETRY,
): AlignPoint {
  const origin = ART_ORIGIN(geometry);
  const nativeToCss = scale.nativeToCss;
  return {
    x: origin.x + align.xNative * nativeToCss,
    y: origin.y + align.yNative * nativeToCss,
  };
}

/**
 * 算姿态盒尺寸。
 *
 * @param batch 批次
 * @param scale 比例契约
 * @returns 尺寸（CSS px）
 */
export function poseSizeOf(batch: PoseBatch, scale: PoseScale): { width: number; height: number } {
  return {
    width: batch.canvas.width * scale.masterToCss,
    height: batch.canvas.height * scale.masterToCss,
  };
}

/**
 * 算一帧在窗口内的姿态盒（**唯一的位置计算入口**）。
 *
 * <p>`left = Px − bodyAnchor.byFacing[frame.facing].x × nativeToCss`；
 * `top = Py − bodyAnchor.byFacing[frame.facing].y × nativeToCss`。</p>
 *
 * <p>注意 `bodyAnchor` 必须按**该帧的朝向**取：`run` / `jump` 的左右向帧锚点不同
 * （700 / 836），用错朝向会让整批画面横移 10.4 CSS px。</p>
 *
 * @param batch 批次
 * @param frame 帧
 * @param scale 比例契约
 * @param align 站姿对齐点
 * @param geometry 几何真源
 * @returns 姿态盒（CSS px）
 */
export function poseBoxOf(
  batch: PoseBatch,
  frame: PoseFrame,
  scale: PoseScale,
  align: AlignContract,
  geometry: PetGeometry = PET_GEOMETRY,
): PosePlacement {
  const point = alignPointOf(scale, align, geometry);
  const anchor = batch.bodyAnchor.byFacing[frame.facing === 1 ? '1' : '-1'];
  const size = poseSizeOf(batch, scale);
  return {
    left: asCssPx(point.x - anchor.x * scale.nativeToCss),
    top: asCssPx(point.y - anchor.y * scale.nativeToCss),
    width: asCssPx(size.width),
    height: asCssPx(size.height),
  };
}

/**
 * 一帧在窗口内的**实测**接地基线（G-06 的左半边）。
 *
 * <p>`baseline = placement.top + inkNative.bottom × nativeToCss`。</p>
 *
 * <p><b>为什么不是 `top + (ink.bottom − bodyAnchor.y) × nativeToCss`：</b>那样算出来的是
 * "盒顶 + 脚底相对锚点的偏移"，量纲上等于 `Py − 2 × anchor.y × nativeToCss + ink.bottom × nativeToCss`，
 * 拿它去比 `Py` 就恒等地要求 `ink.bottom === 2 × anchor.y`（对 `sit` 是 1454.5 vs 2908，
 * 差 221 CSS）。`inkNative` 是**画布基准**的包围盒，所以脚底在窗口内的绝对位置只能由
 * `top + ink.bottom × nativeToCss` 给出。它与 `Py` 的偏差
 * `(ink.bottom − anchor.y) × nativeToCss` 正是设计 §A1.8 记录的那两个实测值
 * （`jump/land` −0.15、`jump/apex` −26.05）。</p>
 *
 * @param batch 批次
 * @param frame 帧
 * @param placement 姿态盒
 * @param scale 比例契约
 * @returns 接地基线（窗口 CSS 坐标系；腾空帧会小于 `Py`）
 */
export function groundBaselineOf(
  batch: PoseBatch,
  frame: PoseFrame,
  placement: PosePlacement,
  scale: PoseScale,
): number {
  const anchor = batch.bodyAnchor.byFacing[frame.facing === 1 ? '1' : '-1'];
  if (!Number.isFinite(anchor.y)) {
    // 锚点缺失/非数时不许静默按 0 处理：那会把"不跳脚"变成"猜一个位置"
    throw new RangeError(`帧 ${frame.id} 的朝向 ${frame.facing} 没有可用的 bodyAnchor.y`);
  }
  return placement.top + frame.inkNative.bottom * scale.nativeToCss;
}

/**
 * 一帧**应有**的接地基线（G-06 的右半边）。
 *
 * <p>`expected = Py − airborneGapNative × nativeToCss`：贴地帧等于 `Py`，
 * 腾空帧按美术声明的离地量扣减（`airborneGapNative` 缺省按 0 处理）。</p>
 *
 * @param gapNative 腾空量（native；`null` 视为 0）
 * @param scale 比例契约
 * @param align 站姿对齐点
 * @param geometry 几何真源
 * @returns 期望基线（CSS px）
 */
export function expectedBaselineOf(
  gapNative: number | null,
  scale: PoseScale,
  align: AlignContract,
  geometry: PetGeometry = PET_GEOMETRY,
): number {
  const point = alignPointOf(scale, align, geometry);
  const gap = gapNative === null || !Number.isFinite(gapNative) ? 0 : gapNative;
  return point.y - gap * scale.nativeToCss;
}
