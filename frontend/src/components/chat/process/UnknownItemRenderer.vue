<script setup lang="ts">
/**
 * 兜底 renderer：未命中任何已知类型的步骤不再静默白屏。
 *
 * <p>文案复用既有 key `chat.message.noOutput`（值 `(暂无输出)`）—— 复用既有文案，
 * 避免为兜底新增 i18n 键（`frontend/src/i18n/messages.ts` 在禁改区）。</p>
 *
 * <p>样式与 <T> 工具行占位的「无输出」分支保持一致：只占一行灰字，不参与任何布局计算，
 * 因此现有 `innerText` 断言与几何断言都不受影响。</p>
 */
import type { ImageProcessItem } from '../../../utils/readImageTools';
import { t } from '../../../i18n';

defineProps<{
  item: ImageProcessItem;
}>();
</script>

<template>
  <div class="text-xs text-zinc-400 font-mono" :data-item-type="item.type">
    {{ t('chat.message.noOutput') }}
  </div>
</template>
