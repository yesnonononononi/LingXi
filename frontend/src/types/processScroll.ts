import type {InjectionKey} from 'vue';

/**
 * 过程段滚动框的「用户接管」通道。
 *
 * <p>过程段的滚动框由 `ChatProcessSegment` 独占持有（`useStreamStickyScroll`），但真正产生
 * 「用户手势改变高度」的却是最里层的 renderer（展开工具详情卡片、折叠思考行）。两者之间隔着
 * `ProcessDetails` 的白名单 props，逐层透传会把一个纯垂直的手势信号污染成三层 props，
 * 因此改用 provide/inject：持有方 provide，需要的一方按需 inject（缺失即为独立挂载，
 * 例如组件单测），不参与任何渲染判定。</p>
 */
export interface ProcessSegmentScrollControl {
  /**
   * 暂停过程框的自动贴底。
   *
   * <p>展开/折叠是用户自己的手势：内容一变高就贴底，会把刚展开、正要读的那一块顶出视野
   * （现象：点开工具详情，框停在最下方，看不到开头）。用户滚回底部即自动恢复跟随。</p>
   */
  pauseAutoFollow: () => void;
}

export const PROCESS_SEGMENT_SCROLL_KEY: InjectionKey<ProcessSegmentScrollControl> = Symbol('process-segment-scroll');
