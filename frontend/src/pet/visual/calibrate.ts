/**
 * 标定页（P1 开发工具）：`pet.html?calibrate=1`。
 *
 * <p><b>它解决什么问题：</b>以下几件事都需要"眼睛/耳根/尾根在画布上的归一化坐标"：
 * 眨眼兜底方案（4 个归一化椭圆）、尾巴/耳朵的二次采样（mask 挖洞 + clip-path）、
 * 方案B 的 Cubism 顶点对齐。这些数值不该靠猜，也不必装图像工具——在真实渲染结果上拖 4 个点即可。</p>
 *
 * <p><b>为什么坐标是归一化的（0..1）：</b>归一化坐标与显示尺寸、DPR、窗口档位无关，
 * 是 seam S3 的契约物。标一次，换尺寸不用重标。</p>
 *
 * <p><b>发布态零影响：</b>只有 `data-calibrate='1'` 时 CSS 才显示这块覆盖层，
 * 且 `main.ts` 只在 `?calibrate=1` 时才挂载它。</p>
 *
 * @module pet/visual/calibrate
 */
import { toNormalized, toView, type PetGeometry } from '../layout';
import { parseQueryFlag } from './micro-motion';

/** 一个标定锚点（归一化坐标）。 */
export interface CalibrationAnchor {
  /** 锚点 id（落盘键名）。 */
  readonly id: string;
  /** 归一化 x（0..1，沿画布宽度）。 */
  readonly u: number;
  /** 归一化 y（0..1，沿画布高度）。 */
  readonly v: number;
}

/** 默认锚点（v2 立绘的粗估值，拖一遍即可精确）。 */
export const CALIBRATION_ANCHOR_DEFAULTS: readonly CalibrationAnchor[] = [
  { id: 'eyeLeft', u: 0.4, v: 0.19 },
  { id: 'eyeRight', u: 0.6, v: 0.19 },
  { id: 'tailRoot', u: 0.78, v: 0.62 },
  { id: 'ahogeRoot', u: 0.52, v: 0.08 },
];

/** 标定页是否开启（`?calibrate=1`）。 */
export function isCalibrationEnabled(search: string): boolean {
  return parseQueryFlag(search, 'calibrate');
}

/**
 * 把一个归一化坐标钳到 0..1 并保留 4 位小数。
 *
 * <p>4 位小数在 1024px 画布上是 0.1px 精度，足够；保留更多位只会让落盘 JSON 难读。</p>
 *
 * @param value 原始值
 * @returns 钳制后的值
 */
export function clampAnchorValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * 归一化一个锚点。
 *
 * @param anchor 原始锚点
 * @returns 钳制后的锚点
 */
export function normalizeAnchor(anchor: CalibrationAnchor): CalibrationAnchor {
  return { id: anchor.id, u: clampAnchorValue(anchor.u), v: clampAnchorValue(anchor.v) };
}

/**
 * 序列化锚点（落盘 `anchors.json` 用）。
 *
 * @param anchors 锚点数组
 * @returns 稳定顺序的 JSON 文本（键序固定，diff 好读）
 */
export function serializeAnchors(anchors: readonly CalibrationAnchor[]): string {
  const list = anchors.map((anchor) => normalizeAnchor(anchor));
  return `${JSON.stringify({ version: 1, coordinate: 'normalized', anchors: list }, null, 2)}\n`;
}

/**
 * 挂载标定覆盖层（网格 + 可拖锚点 + 输出面板）。
 *
 * @param doc 文档对象
 * @param host `#pet-root`
 * @param geometry 几何真源（用于把归一化坐标换算成视口位置）
 * @param initial 初始锚点（缺省用 {@link CALIBRATION_ANCHOR_DEFAULTS}）
 * @returns 卸载函数
 */
export function mountCalibration(
  doc: Document,
  host: HTMLElement,
  geometry: PetGeometry,
  initial: readonly CalibrationAnchor[] = CALIBRATION_ANCHOR_DEFAULTS,
): () => void {
  const overlay = doc.createElement('div');
  overlay.className = 'pet-calibrate';

  const grid = doc.createElement('div');
  grid.className = 'pet-calibrate__grid';

  const output = doc.createElement('pre');
  output.className = 'pet-calibrate__output';

  const anchors: CalibrationAnchor[] = initial.map((anchor) => normalizeAnchor(anchor));
  const dots = new Map<string, HTMLDivElement>();
  const cleanups: (() => void)[] = [];

  /**
   * 刷新输出面板。
   */
  const renderOutput = (): void => {
    output.textContent = serializeAnchors(anchors);
  };

  /**
   * 把锚点摆到它该在的位置。
   *
   * @param anchor 锚点
   * @param dot 对应的圆点
   */
  const place = (anchor: CalibrationAnchor, dot: HTMLDivElement): void => {
    const point = toView(geometry, anchor.u, anchor.v);
    dot.style.left = `${point.x}px`;
    dot.style.top = `${point.y}px`;
  };

  for (const anchor of anchors) {
    const dot = doc.createElement('div');
    dot.className = 'pet-calibrate__anchor';
    dot.dataset.anchor = anchor.id;
    dot.title = `${anchor.id}: u=${anchor.u}, v=${anchor.v}`;

    const label = doc.createElement('span');
    label.className = 'pet-calibrate__label';
    label.textContent = anchor.id;
    dot.appendChild(label);
    place(anchor, dot);

    /**
     * 拖拽：把鼠标视口位置换回归一化坐标。
     *
     * @param event 指针事件
     */
    const onMove = (event: PointerEvent): void => {
      const uv = toNormalized(geometry, event.clientX, event.clientY);
      const index = anchors.findIndex((item) => item.id === anchor.id);
      if (index < 0) return;
      anchors[index] = normalizeAnchor({ id: anchor.id, u: uv.u, v: uv.v });
      place(anchors[index], dot);
      dot.title = `${anchor.id}: u=${anchors[index].u}, v=${anchors[index].v}`;
      renderOutput();
    };

    dot.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      dot.setPointerCapture(event.pointerId);
      const stop = (): void => {
        dot.removeEventListener('pointermove', onMove);
        dot.removeEventListener('pointerup', stop);
      };
      dot.addEventListener('pointermove', onMove);
      dot.addEventListener('pointerup', stop);
      cleanups.push(stop);
    });
    // 防止拖锚点时误触发桌宠拖拽
    dot.addEventListener('pointerdown', (event) => event.stopPropagation());

    dots.set(anchor.id, dot);
    overlay.appendChild(dot);
  }

  renderOutput();
  overlay.append(grid, output);
  host.appendChild(overlay);
  host.dataset.calibrate = '1';

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // 卸载阶段的异常不该阻断其它清理
      }
    }
    cleanups.length = 0;
    dots.clear();
    overlay.remove();
    delete host.dataset.calibrate;
  };
}
