<script setup lang="ts">
/**
 * 正文默认实现：把 `ChatMessageItem.vue` 原 542–546 的三行 `MarkdownRenderer` 逐字搬出来，
 * 使「宿主注册的实现」与「Item 内的兜底实现」指向同一份语义（改一处不会漏另一处）。
 *
 * props 直接复用插槽契约类型 `ChatMessageBodySlotProps`，保证 slot props 与默认实现类型同源；
 * 不设 `inheritAttrs: false`：外层若有透传属性，应落到 `MarkdownRenderer` 根节点上（与原内联写法一致）。
 */
import MarkdownRenderer from './MarkdownRenderer.vue';
import type { ChatMessageBodySlotProps } from '../../types/chatMessageSlots';

const props = defineProps<ChatMessageBodySlotProps>();
</script>

<template>
  <MarkdownRenderer
    :content="props.message.content"
    :is-dark="props.isDark"
    :is-thinking="props.isThinking"
  />
</template>
