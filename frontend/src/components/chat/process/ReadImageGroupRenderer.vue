<script setup lang="ts">
/**
 * 读图组 renderer：段内相邻的成功读图合并为一条分组（分组逻辑在 `utils/readImageTools.ts`）。
 *
 * <p>根元素就是既有的 `ReadImageToolGroup` —— 原分支没有额外包裹层，这里也不许加。</p>
 */
import type { ImageProcessItem } from '../../../utils/readImageTools';
import ReadImageToolGroup from '../ReadImageToolGroup.vue';

defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  /** 注册表只在 `ctx.sessionId` 存在时才分发到本 renderer，故此处必填。 */
  sessionId: string | number;
}>();
</script>

<template>
  <ReadImageToolGroup
    :images="item.images ?? []"
    :session-id="sessionId"
    :is-dark="isDark"
  />
</template>
