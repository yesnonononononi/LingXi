/**
 * 域换算的**唯一入口**。
 *
 * <p>三个域（母版 / native / CSS）之间只允许从这里过。为什么这么严：本项目实测踩到过
 * "把 native 当母版"的 bug——同一个人在同一小时内、有文档在手也会搞错，算完得到
 * "run 只需 31 CSS px、完全装得下"，而真实值是 249.5。所以换算函数收成一个文件，
 * 并由 `tests/petPoseManifest.test.ts` 静态扫描其它文件里的裸比例与裸 `×2` / `÷2`。</p>
 *
 * <p><b>本文件是那条静态扫描的唯一豁免</b>，且豁免的理由必须是"这里就是换算实现"。
 * 即使在这里也不写 `0.15234375` 这类字面量：比例一律从 {@link PoseScale} 读，
 * 而 `PoseScale` 在加载期已被断言与 `pet-geometry.json` 自洽。</p>
 *
 * @module pet/poses/units
 */
import type { CssPx, MasterPx, NativePx, PoseFrame, PoseScale } from './types';

/**
 * 把普通数值标记成母版域。
 *
 * <p>只在**边界**使用：adapter / manifest 刚从 JSON 读出数字时。渲染与布局内部一律
 * 用 TypedValue 之间运算，不再随手造新值。</p>
 *
 * @param value 原始数值
 * @returns 母版域数值
 */
export function asMasterPx(value: number): MasterPx {
  return value as MasterPx;
}

/**
 * 把普通数值标记成 native 域。
 *
 * @param value 原始数值
 * @returns native 域数值
 */
export function asNativePx(value: number): NativePx {
  return value as NativePx;
}

/**
 * 把普通数值标记成 CSS 域。
 *
 * @param value 原始数值
 * @returns CSS 域数值
 */
export function asCssPx(value: number): CssPx {
  return value as CssPx;
}

/**
 * native → CSS。
 *
 * @param value native 像素
 * @param scale 比例契约（来自运行时清单）
 * @returns CSS px
 * @throws {TypeError} `value` 或 `scale.nativeToCss` 不是有限数值
 */
export function nativeToCss(value: NativePx, scale: PoseScale): CssPx {
  assertFinite(value, 'nativeToCss.value');
  assertFinite(scale.nativeToCss, 'nativeToCss.scale.nativeToCss');
  return (value * scale.nativeToCss) as CssPx;
}

/**
 * 母版 → CSS。
 *
 * @param value 母版像素
 * @param scale 比例契约
 * @returns CSS px
 * @throws {TypeError} 入参不是有限数值
 */
export function masterToCss(value: MasterPx, scale: PoseScale): CssPx {
  assertFinite(value, 'masterToCss.value');
  assertFinite(scale.masterToCss, 'masterToCss.scale.masterToCss');
  return (value * scale.masterToCss) as CssPx;
}

/**
 * 母版 → native。
 *
 * @param value 母版像素
 * @param factor 倍率（`PoseBatch.masterScale`，1 或 2；只许读清单，不许猜）
 * @returns native 像素
 * @throws {TypeError} `factor` 不是正有限数值
 */
export function masterToNative(value: MasterPx, factor: number): NativePx {
  assertFinite(value, 'masterToNative.value');
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new TypeError(`masterToNative.factor 必须是正有限数值，实际为 ${String(factor)}`);
  }
  return (value / factor) as NativePx;
}

/**
 * native → 母版（{@link masterToNative} 的逆运算）。
 *
 * @param value native 像素
 * @param factor 倍率
 * @returns 母版像素
 * @throws {TypeError} `factor` 不是正有限数值
 */
export function nativeToMaster(value: NativePx, factor: number): MasterPx {
  assertFinite(value, 'nativeToMaster.value');
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new TypeError(`nativeToMaster.factor 必须是正有限数值，实际为 ${String(factor)}`);
  }
  return (value * factor) as MasterPx;
}

/**
 * 母版 / native 的倍率，**从比例契约反推**（`nativeToCss / masterToCss`）。
 *
 * <p>为什么反推而不是写常数 2：写常数就等于第二处真源。比例契约本身已被
 * `manifest.ts` 断言"`nativeToCss === masterToCss × 2`"，反推出来的必然是 2，
 * 但它随数据走 ⇒ 哪天美术真的给了 3 倍母版，这里不用改。</p>
 *
 * @param scale 比例契约
 * @returns 倍率
 * @throws {TypeError} `masterToCss` 为 0（无法反推）
 */
export function masterScaleOf(scale: PoseScale): number {
  assertFinite(scale.masterToCss, 'masterScaleOf.scale.masterToCss');
  if (scale.masterToCss === 0) {
    throw new TypeError('masterScaleOf：scale.masterToCss 为 0，无法反推倍率');
  }
  return scale.nativeToCss / scale.masterToCss;
}

/**
 * 站姿原生画布宽度（1024 = 母版 2048 / 倍率 2）。
 *
 * <p>`Px` 的公式要用它把 native 的 `align.xNative` 折成"画布内比例"：
 * `Px = artOrigin.x + artWidth × (align.xNative / 站姿原生画布宽)`。
 * 这里**没有**裸除法：母版画布宽经 {@link masterToNative} 换域，倍率来自比例契约。</p>
 *
 * @param scale 比例契约
 * @returns 站姿原生画布宽（native）
 */
export function standNativeCanvasWidth(scale: PoseScale): NativePx {
  return masterToNative(scale.canvasWidth as MasterPx, masterScaleOf(scale));
}

/**
 * 一帧的墨迹高度（CSS px）。
 *
 * @param frame 帧
 * @param scale 比例契约
 * @returns CSS px（入参为 native 域，经 `nativeToCss` 折算）
 */
export function inkHeightOf(frame: PoseFrame, scale: PoseScale): CssPx {
  const ink = frame.inkNative;
  return (nativeToCss(ink.bottom, scale) - nativeToCss(ink.top, scale)) as CssPx;
}

/**
 * 一帧的墨迹宽度（CSS px）。
 *
 * @param frame 帧
 * @param scale 比例契约
 * @returns CSS px
 */
export function inkWidthOf(frame: PoseFrame, scale: PoseScale): CssPx {
  const ink = frame.inkNative;
  return (nativeToCss(ink.right, scale) - nativeToCss(ink.left, scale)) as CssPx;
}

/**
 * 断言是有限数值（内部工具；不导出以免调用方依赖实现细节）。
 *
 * @param value 待检查值
 * @param name 字段名（报错用）
 * @throws {TypeError} 不是有限数值
 */
function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`[pet-poses] ${name} 必须是有限数值，实际为 ${String(value)}`);
  }
}
