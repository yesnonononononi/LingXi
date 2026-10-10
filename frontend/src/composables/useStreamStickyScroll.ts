import { ref, watch, onBeforeUnmount } from 'vue';

/** 距底部多少像素以内视为「已经回到最底部」。 */
const BOTTOM_THRESHOLD = 24;

export interface StreamStickyScrollOptions {
  /** 内容指纹：只要有任何一段流式内容在增长，返回值就应该变化。 */
  streamSignature: () => string;
  /** 参与贴底的框 id，顺序无关；不存在的框会被跳过。 */
  boxIds: () => string[];
  /**
   * 框首次挂载时是否贴底并保持跟随，缺省为 true。
   *
   * 正在流式的框必须为 true（首个分片落地那一刻 scrollTop 还是 0，不贴底就等于从顶部开始追）；
   * 已经定型的历史内容应返回 false —— 让用户从头读，且避免它被别处的增量顶到底部。
   */
  shouldStickOnMount?: (id: string) => boolean;
}

export interface StreamStickyScroll {
  /** 绑定到滚动容器：`:ref="(el) => setBoxRef(id, el)"`。 */
  setBoxRef: (id: string, el: unknown) => void;
  /** 绑定到滚动容器：`@scroll="handleScroll(id, $event)"`。 */
  handleScroll: (id: string, event: Event) => void;
  /** 该框是否还在跟随底部（供「回到底部」入口显隐）。 */
  isFollowing: (id: string) => boolean;
  /** 强制恢复跟随并贴底。 */
  scrollToBottom: (id: string) => void;
}

/**
 * 流式内容滚动框的自动贴底。
 *
 * 跟随与否只认「用户自己的手势」，不认「此刻是否贴近底部」：这类框通常是首个分片落地时才挂载的，
 * 那一刻 scrollTop 还是 0，若按「贴近底部」判断，首屏就超出一屏的内容会被判成「用户已经滚走了」，
 * 之后每个分片只会让距离更大 —— 贴底动作就此永久丢失，用户只能手动往底部拖。
 * 因此这里只在「当前位置低于上一次程序贴底的位置」时才判定为用户上滑、停止跟随。
 *
 * 停止跟随只影响新的增量，不改变用户当前阅读位置；用户滚回底部或点击回到底部即恢复。
 */
export function useStreamStickyScroll(options: StreamStickyScrollOptions): StreamStickyScroll {
  // ⚠️ 必须是**非响应式**容器：存进 ref 的元素会被 Vue 包成 reactive 代理，
  // 而弱引用表的键来自事件里的原始元素 —— 代理与原始元素不是同一个对象，
  // WeakMap/WeakSet 查询会全部落空（表现为「用户上滑」永远判定不出来）。
  const boxRefs: Record<string, HTMLElement | null> = {};
  const followState = ref<Record<string, boolean>>({});
  // 已初始化过的框元素：内联 ref 回调在每次重渲染都会被重新触发，用它区分「新挂载」与「重复回调」。
  const initializedBoxes = new WeakSet<HTMLElement>();
  // 上一次由程序贴底写入的位置，用来把「程序滚动」与「用户上滑」区分开。
  const stickTargets = new WeakMap<HTMLElement, number>();
  const shouldStickOnMount = options.shouldStickOnMount ?? (() => true);
  let rafId: number | null = null;

  /** 可滚动的最大位置；拿不到布局几何时返回 null（如无 DOM 的组件测试）。 */
  const resolveMaxScrollTop = (box: HTMLElement): number | null => {
    const scrollHeight = box.scrollHeight;
    const clientHeight = box.clientHeight;
    if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return null;
    return scrollHeight - clientHeight;
  };

  const isNearBottom = (box: HTMLElement): boolean => {
    const maxScrollTop = resolveMaxScrollTop(box);
    // 没有几何信息时按「在底部」处理，不让缺失的布局把跟随关掉。
    if (maxScrollTop === null || !Number.isFinite(box.scrollTop)) return true;
    return maxScrollTop - box.scrollTop <= BOTTOM_THRESHOLD;
  };

  /** 未显式标记即视为跟随，保证新挂载的框默认贴底。 */
  const isFollowing = (id: string): boolean => followState.value[id] !== false;

  const stickToBottom = (id: string) => {
    const box = boxRefs[id];
    if (!box) return;
    const maxScrollTop = resolveMaxScrollTop(box);
    if (maxScrollTop === null) return;
    box.scrollTop = maxScrollTop;
    stickTargets.set(box, maxScrollTop);
  };

  const stickFollowingBoxes = () => {
    for (const id of options.boxIds()) {
      if (isFollowing(id)) stickToBottom(id);
    }
  };

  /** 补一帧再贴一次：分片落地后内容可能还有一次换行重排。无 rAF 的环境（组件测试）直接跳过。 */
  const scheduleStick = () => {
    if (typeof requestAnimationFrame !== 'function') return;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      stickFollowingBoxes();
    });
  };

  const setBoxRef = (id: string, el: unknown) => {
    const box = (el as HTMLElement | null) ?? null;
    if (!box) {
      delete boxRefs[id];
      return;
    }
    boxRefs[id] = box;
    if (initializedBoxes.has(box)) return;
    // 新挂载的框没有「用户看过的位置」需要保留，策略由调用方给（见 shouldStickOnMount）。
    initializedBoxes.add(box);
    const follow = shouldStickOnMount(id);
    followState.value[id] = follow;
    if (!follow) return;
    stickToBottom(id);
    scheduleStick();
  };

  const handleScroll = (id: string, event: Event) => {
    const box = event.target as HTMLElement | null;
    if (!box) return;
    // 回到最底部（滚轮、拖滚动条、触屏、键盘都算）即恢复跟随。
    if (isNearBottom(box)) {
      followState.value[id] = true;
      return;
    }
    // 只有当前位置低于「上一次程序贴底」的位置，才是用户自己往上滚的；
    // 程序贴底本身触发的 scroll 事件会让两者相等，不能拿它截断跟随。
    const target = stickTargets.get(box);
    if (target !== undefined && box.scrollTop < target - 1) {
      followState.value[id] = false;
    }
  };

  const scrollToBottom = (id: string) => {
    followState.value[id] = true;
    stickToBottom(id);
    scheduleStick();
  };

  watch(
    () => options.streamSignature(),
    () => {
      stickFollowingBoxes();
      scheduleStick();
    },
    { flush: 'post' }
  );

  onBeforeUnmount(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  return { setBoxRef, handleScroll, isFollowing, scrollToBottom };
}
