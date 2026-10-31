/**
 * 命中判定契约（seam S2）。
 *
 * <p><b>为什么把命中抽成接口：</b>现在"鼠标是否在宠物身上"这件事有三处耦合——穿透上报、
 * 拖拽起点、将来的动作分区。如果每处自己算，换实现（矩形 → alpha 掩码 → 模型几何）就要改三遍。
 * 抽成 {@link HitTester} 之后，三处只依赖接口，换实现改一个构造点。</p>
 *
 * <p><b>坐标空间（硬约定）：</b>一律用窗口视口 CSS px（＝DIP），与 `MouseEvent.clientX/clientY`
 * 同一空间。**禁止** `screenX/screenY` 参与命中（那是屏幕坐标，只用于拖拽上报且主进程会二次校验）；
 * **禁止**在实现里 `getBoundingClientRect()`（元素带 transform 时给出的是变换后的框，误差方向不可控）。</p>
 *
 * @module pet/hit/types
 */
import type { PetGeometry } from '../layout';

/**
 * 命中分区（本批恒 `body`；留给"点头部"这类动作分区用）。
 *
 * <ul>
 *   <li>`head`：头部区（将来的 `tap` 反应可以只对头生效）；</li>
 *   <li>`body`：身体/其它可见区；</li>
 *   <li>`none`：没命中（透明区或窗口外）。</li>
 * </ul>
 */
export type HitProfile = 'head' | 'body' | 'none';

/**
 * 命中测试器。
 *
 * <p>实现约定：**就绪前一律按"未命中"处理**——宁可穿透（用户还能操作桌面），
 * 也不要让一块看不见的窗口吃掉点击。</p>
 */
export interface HitTester {
  /** 实现种类（排障与调试面板用）。 */
  readonly kind: 'rect' | 'alpha' | 'model';
  /** 是否已就绪（未就绪时 `test` 必须返回 false）。 */
  readonly ready: boolean;
  /**
   * 判定一个视口坐标是否命中。
   *
   * @param viewX 视口 x（CSS px）
   * @param viewY 视口 y（CSS px）
   * @returns 是否命中
   */
  test(viewX: number, viewY: number): boolean;
  /**
   * 注入几何（布局/尺寸变化时由外部调用；实现不得自行读取 DOM 尺寸）。
   *
   * @param geometry 几何真源
   */
  setGeometry(geometry: PetGeometry): void;
  /**
   * 资产/模型/动作变化导致轮廓变化时调用（alpha/model 实现需要重建掩码）。
   *
   * @param reason 变化原因（排障用）
   */
  invalidate(reason: string): void;
  /** 释放内部资源。 */
  dispose(): void;
}
