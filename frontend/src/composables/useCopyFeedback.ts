/**
 * 「复制到剪贴板 + N 秒后复位」状态的统一实现。
 *
 * 收敛原因：同一套「writeText → 置为已复制 → setTimeout 复位」逻辑在 6 处逐字复制：
 *   - components/chat/ChatMessageItem.vue:126-138（copyToolContent，按工具 id 键控）
 *   - components/chat/ChatMessageItem.vue:427-435（copyContent，布尔）
 *   - components/chat/ApprovalCard.vue:56-68（copyCommand，布尔）
 *   - components/chat/SubAgentSidePanel.vue:55-65（handleCopyResult，按子会话 id 键控）
 *   - components/chat/SubSessionDetailDrawer.vue:69-80（copyAllContent，布尔）
 *   - components/chat/MarkdownRenderer.vue:33-44（代码块复制，DOM 事件委托）
 *
 * 用法：
 *   const { copiedKey, isCopied, copy } = useCopyFeedback();      // 默认 2000ms
 *   // 键控场景（同一组件内有多个可复制项）：
 *   copy(text, item.id);            // 模板里 `copiedKey === item.id`
 *   // 布尔场景（组件内仅一个复制按钮）：
 *   await copy(text);               // 模板里 `isCopied`
 *
 * 行为契约（与原实现逐字一致）：
 *   - 复制成功才置为「已复制」，失败走 console.error 且不改变状态；
 *   - 复位带键守卫：只有当前仍指向同一键时才清空，避免快速连点时前一个定时器误清后一个；
 *   - 布尔场景等价于键为 true 的键控场景（复位时机与原实现相同）。
 */

import { computed, ref } from 'vue';

export function useCopyFeedback(resetMs = 2000) {
  /** 当前处于「已复制」态的键；null 表示无。布尔场景写入 true。 */
  const copiedKey = ref<string | number | boolean | null>(null);

  /** 布尔视图：是否存在处于「已复制」态的项 */
  const isCopied = computed(() => copiedKey.value !== null);

  /**
   * 复制文本；成功返回 true。key 缺省为 true（布尔场景）。
   */
  const copy = async (text: string, key: string | number | boolean = true): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey.value = key;
      setTimeout(() => {
        if (copiedKey.value === key) copiedKey.value = null;
      }, resetMs);
      return true;
    } catch (e) {
      console.error('复制失败:', e);
      return false;
    }
  };

  return { copiedKey, isCopied, copy };
}
