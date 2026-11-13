import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { resolveSidePanelMaxWidth } from '../utils/chatColumnLayout';

/**
 * 右侧面板宽度的守卫：拖拽改宽时夹紧，行宽变化时重新夹紧。
 *
 * <p>为什么不能只在拖拽那一刻夹：行宽会因窗口缩放、侧边栏开合而变化，
 * 「先拖宽面板再展开侧边栏」照样能把对话列压成一条竖线。所以对面板父元素挂 ResizeObserver，
 * 父元素宽度只受窗口与侧边栏影响、不受面板自身改变，不会自激。</p>
 *
 * @param hostRef 面板根元素；父元素必须是那条承载「对话列 + 右侧面板」的弹性行
 * @param width 面板宽度状态（px），夹紧结果直接写回它
 * @param minPanelWidth 面板自身最小宽度
 */
export function useSidePanelWidthGuard(hostRef: Ref<HTMLElement | null>, width: Ref<number>, minPanelWidth: number) {
  /** 弹性行实测宽度：量不到（首帧 / 内存渲染器没有布局 API）时为 0。 */
  const rowWidth = ref(0);
  let observer: ResizeObserver | undefined;

  const measure = (): void => {
    rowWidth.value = Math.round(hostRef.value?.parentElement?.getBoundingClientRect().width ?? 0);
  };

  /** 把候选宽度夹到「行宽 - 对话列最小宽度」；行宽未知时只夹面板自身下限，量不到的时候不砍宽度。 */
  const clampWidth = (candidate: number): number => {
    const floored = Math.max(candidate, minPanelWidth);
    if (rowWidth.value <= 0) return floored;
    return Math.min(floored, resolveSidePanelMaxWidth(rowWidth.value, minPanelWidth));
  };

  const attach = (host: HTMLElement | null): void => {
    observer?.disconnect();
    observer = undefined;
    measure();
    const row = host?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      measure();
      width.value = clampWidth(width.value);
    });
    observer.observe(row);
  };

  watch(hostRef, attach, { immediate: true });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = undefined;
  });

  return { clampWidth, rowWidth };
}
