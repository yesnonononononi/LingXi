/**
 * 矩形命中实现（**事件级二次筛选**，不决定窗口穿透）。
 *
 * <p><b>M2 重构后它的职责收窄了：</b>"鼠标是否在宠物身上"归主进程轮询独占；这里的矩形只用于
 * `main.ts` 的两处二道门——`pointerdown` 与 `contextmenu` 到达后再判一次坐标，把
 * "点在立绘箱四角透明留白上"的误触筛掉（立绘箱比可见墨迹宽 3.5px、高 24.7px）。</p>
 *
 * <p><b>为什么用 `visibleBox()` 而不是元素的 `getBoundingClientRect()`：</b></p>
 * <ul>
 *   <li>可见墨迹盒比立绘箱宽 3.5px、高 24.7px 小一圈，边界更贴合真实轮廓；</li>
 *   <li>元素带 `transform`（呼吸/摇摆）时 `getBoundingClientRect()` 返回**变换后**的框，
 *       鼠标在边缘 1~2px 内会随动画抖动；</li>
 *   <li>纯函数算出来的框可单测，`getBoundingClientRect()` 不能。</li>
 * </ul>
 *
 * <p>注意与主进程 `pet-hit-region.cjs` 的口径差异：那边是**半开区间**（状态机判定必须唯一），
 * 这里是**闭区间**（手指容差，点在边缘也算点到）。两处都由 C1 断言"同一份几何派生"。</p>
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
