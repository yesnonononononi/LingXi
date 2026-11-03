/**
 * 落地光晕 / 接地阴影（P0：让立牌"站在桌面上"而不是"浮在桌面上"）。
 *
 * <p><b>为什么它必须留在 DOM 而不是做进模型：</b>光晕/阴影属于"表现层之外的装饰层"，
 * 方案A 的 CSS 与方案B 的 Live2D 都要用它。塞进模型会导致方案B 重做一遍光晕
 * （设计文档 §3.4 末行的设计决策）。</p>
 *
 * <p>尺寸用比例 + 固定像素：宽度取立绘箱的 62%（跟着尺寸档位走），高度 14px（视觉常量，
 * 跟尺寸无关——一个 209px 高的宠物脚下不需要 30px 的影子）。</p>
 *
 * @module pet/visual/halo
 */
import { artBox, type Box, type PetGeometry } from '../layout';

/** 光晕宽度占立绘箱宽度的比例。 */
export const HALO_WIDTH_RATIO = 0.62;

/** 光晕高度（CSS px）。 */
export const HALO_HEIGHT_PX = 14;

/** 光晕底边相对立绘箱底边的内缩（CSS px）：贴地而不是悬空。 */
export const HALO_BOTTOM_PX = 2;

/** 光晕默认不透明度（与 `pet.css` 的 `--pet-halo-opacity` 默认值一致）。 */
export const HALO_DEFAULT_OPACITY = 0.55;

/**
 * 计算光晕矩形（视口坐标，CSS px）。
 *
 * @param geometry 几何真源
 * @returns 光晕矩形（水平居中于立绘箱）
 */
export function haloBox(geometry: PetGeometry): Box {
  const box = artBox(geometry);
  const width = box.width * HALO_WIDTH_RATIO;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + box.height - HALO_HEIGHT_PX - HALO_BOTTOM_PX,
    width,
    height: HALO_HEIGHT_PX,
  };
}

/**
 * 把光晕宿主写进 CSS 变量（尺寸变化后重算一次即可）。
 *
 * @param host 光晕元素或任意宿主元素
 * @param geometry 几何真源
 */
export function applyHaloVariables(host: HTMLElement, geometry: PetGeometry): void {
  const style = host.style;
  style.setProperty('--pet-halo-w', `${(HALO_WIDTH_RATIO * 100).toFixed(2)}%`);
  style.setProperty('--pet-halo-h', `${HALO_HEIGHT_PX}px`);
  style.setProperty('--pet-halo-bottom', `${HALO_BOTTOM_PX}px`);
  style.setProperty('--pet-halo-opacity', String(HALO_DEFAULT_OPACITY));
  // 立绘箱宽度也写进变量，方便将来按档位缩放光晕（现在由百分比天然跟随）
  style.setProperty('--pet-halo-art-w', `${geometry.artWidth}px`);
}

/**
 * 创建并挂载光晕元素。
 *
 * @param doc 文档对象
 * @param parent 立绘箱的父元素（光晕与立绘同坐标系，默认挂在 `.pet-art`）
 * @param geometry 几何真源
 * @returns 光晕元素
 */
export function mountHalo(doc: Document, parent: HTMLElement, geometry: PetGeometry): HTMLDivElement {
  const existing = parent.querySelector<HTMLDivElement>('.pet-halo');
  const halo = existing ?? doc.createElement('div');
  if (!existing) {
    halo.className = 'pet-halo';
    halo.setAttribute('aria-hidden', 'true');
    applyHaloVariables(halo, geometry);
    // 光晕放在立绘之前：贴在底层，避免盖住裙摆
    parent.insertBefore(halo, parent.firstChild);
  }
  return halo;
}
