<script setup lang="ts">
import {computed} from 'vue';
import {Cancel01Icon, CursorTextIcon, Doc01Icon} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import type {PastedDocument} from '../../utils/pastedDocument';
import {formatDocumentStat} from '../../utils/pastedDocument';
import {t} from '../../i18n';

const props = defineProps<{
  document: PastedDocument;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'preview'): void;
  (e: 'expand'): void;
  (e: 'remove'): void;
}>();

const statText = computed(() => formatDocumentStat(props.document));
</script>

<template>
  <div
    class="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-xl text-xs select-none transition-all duration-150 border max-w-full"
    :class="props.isDark ? 'bg-zinc-800/90 hover:bg-zinc-800 border-zinc-700/60 text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200/70 border-zinc-200 text-zinc-800'"
    data-testid="pasted-document-card"
  >
    <!-- 左侧可点击预览区 -->
    <button
      type="button"
      class="flex items-center gap-2 min-w-0 bg-transparent border-0 p-0 text-left cursor-pointer outline-none"
      :title="t('chat.input.pastedDocumentPreview')"
      @click="emit('preview')"
    >
      <span
        class="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
        :class="props.isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-500/10 text-blue-600'"
      >
        <HugeiconsIcon :icon="Doc01Icon as IconArray" :size="14" :stroke-width="2" />
      </span>
      <div class="flex flex-col min-w-0 pr-1">
        <span class="font-medium truncate max-w-[130px] sm:max-w-[180px] leading-tight text-inherit">
          {{ props.document.title }}
        </span>
        <span class="text-[10px] opacity-70 leading-tight">
          {{ statText }}
        </span>
      </div>
    </button>

    <!-- 右侧操作区：还原为纯文本、删除卡片 -->
    <div class="flex items-center gap-0.5 ml-0.5 shrink-0">
      <button
        type="button"
        class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[20px] h-[20px] text-inherit cursor-pointer transition-opacity"
        :title="t('chat.input.pastedDocumentExpand')"
        :aria-label="t('chat.input.pastedDocumentExpand')"
        @click.stop="emit('expand')"
      >
        <HugeiconsIcon :icon="CursorTextIcon as IconArray" :size="12" :stroke-width="2" />
      </button>
      <button
        type="button"
        class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[20px] h-[20px] text-inherit cursor-pointer hover:text-red-500 transition-colors"
        :title="t('chat.input.pastedDocumentRemove')"
        :aria-label="t('chat.input.pastedDocumentRemove')"
        @click.stop="emit('remove')"
      >
        <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="11" :stroke-width="2.5" />
      </button>
    </div>
  </div>
</template>
