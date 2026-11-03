/**
 * 矩形命中实现（本批默认实现）。
 *
 * <p><b>为什么用 `visibleBox()` 而不是元素的 `getBoundingClientRect()`：</b></p>
 * <ul>
 *   <li>可见墨迹盒比立绘箱宽 3.5px、高 24.7px 小一圈，边界更贴合真实轮廓；</li>
 *   <li>元素带 `transform`（呼吸/摇摆）时 `getBoundingClientRect()` 返回**变换后**的框，
 *       鼠标在边缘 1~2px 内会随动画抖动，表现为"穿透状态抽搐"；</li>
 *   <li>纯函数算出来的框可单测，`getBoundingClientRect()` 不能。</li>
 * </ul>
 *
 * <p>下一个实现是 `AlphaMaskHitTester`（1/8 降采样 + 膨胀 1 格 + α>24，归一化网格而非写死格子数），
 * 换它时 `HitPipeline` 与调用点都不用动。</p>
 *
 * @module pet/hit/rect-hit-tester
 */
import { PET_GEOMETRY, visibleBox, type Box, type PetGeometry } from '../layout';
import type { HitTester } from './types';

/** 矩形命中实现。 */
export class RectHitTester implements HitTester {
  /** 实现种类。 */
  readonly kind = 'rect' as const;

  /** 矩形命中永远就绪（没有需要异步准备的东西）。 */
  readonly ready = true;

  /** 当前命中矩形（视口坐标）；null = 尚未注入几何。 */
  private box: Box | null = null;

  /**
   * 构造矩形命中实现。
   *
   * @param geometry 初始几何（缺省用真源单例）
   */
  constructor(geometry: PetGeometry = PET_GEOMETRY) {
    this.setGeometry(geometry);
  }

  /**
   * 注入几何：用可见包围盒作为命中矩形。
   *
   * @param geometry 几何真源
   */
  setGeometry(geometry: PetGeometry): void {
    if (!geometry) throw new TypeError('RectHitTester.setGeometry 需要几何对象');
    this.box = visibleBox(geometry);
  }

  /**
   * 判定命中（闭区间：边界上的点算命中，避免"贴着尾巴挪一下就掉"）。
   *
   * @param viewX 视口 x（CSS px）
   * @param viewY 视口 y（CSS px）
   * @returns 是否命中
   */
  test(viewX: number, viewY: number): boolean {
    const box = this.box;
    if (!box) return false;
    if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) return false;
    return viewX >= box.x && viewX <= box.x + box.width && viewY >= box.y && viewY <= box.y + box.height;
  }

  /**
   * 轮轮廓变化通知：矩形无需重建（几何变了会走 {@link setGeometry}）。
   *
   * @param _reason 变化原因（本实现不使用）
   */
  invalidate(_reason: string): void {
    // 矩形实现不持有可失效的缓存；保留空实现是为了满足接口（不是 TODO）
  }

  /** 当前命中矩形（测试与调试面板用）。 */
  get bounds(): Box | null {
    return this.box;
  }

  /** 释放：丢掉几何引用。 */
  dispose(): void {
    this.box = null;
  }
}
