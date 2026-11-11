<script setup lang="ts">
import {computed, ref} from 'vue';
import {Cancel01Icon, Copy01Icon, CursorTextIcon, Doc01Icon, Tick02Icon} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import LxModal from '../common/LxModal.vue';
import type {PastedDocument} from '../../utils/pastedDocument';
import {formatDocumentStat} from '../../utils/pastedDocument';
import {t} from '../../i18n';

const props = defineProps<{
  open: boolean;
  document: PastedDocument | null;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'expand'): void;
}>();

const copied = ref(false);

const handleCopy = async () => {
  if (!props.document?.content) return;
  try {
    await navigator.clipboard.writeText(props.document.content);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch (err) {
    console.error('复制文档内容失败:', err);
  }
};

const statText = computed(() => (props.document ? formatDocumentStat(props.document) : ''));
</script>

<template>
  <LxModal
    :open="props.open && !!props.document"
    :aria-label="props.document?.title || t('chat.input.pastedDocumentPreview')"
    overlay-class="z-[100] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
    :panel-class="[
      'flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl',
      props.isDark ? 'bg-zinc-900 border-zinc-700/80 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'
    ].join(' ')"
    @close="emit('close')"
  >
    <!-- 头部栏 -->
    <div class="flex items-center justify-between px-5 py-3.5 border-b border-black/5 dark:border-white/10 shrink-0">
      <div class="flex items-center gap-2.5 min-w-0 pr-2">
        <span
          class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          :class="props.isDark ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-500/10 text-blue-600'"
        >
          <HugeiconsIcon :icon="Doc01Icon as IconArray" :size="16" :stroke-width="2" />
        </span>
        <div class="flex flex-col min-w-0">
          <span class="font-semibold text-sm truncate leading-tight">
            {{ props.document?.title }}
          </span>
          <span class="text-xs text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
            {{ statText }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1 shrink-0">
        <!-- 复制全文按钮 -->
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors cursor-pointer"
          :class="props.isDark ? 'border-zinc-700 hover:bg-zinc-800 text-zinc-300' : 'border-zinc-200 hover:bg-zinc-100 text-zinc-700'"
          :title="copied ? t('common.copied') : t('chat.input.pastedDocumentCopy')"
          @click="handleCopy"
        >
          <HugeiconsIcon
            :icon="(copied ? Tick02Icon : Copy01Icon) as IconArray"
            :size="14"
            :stroke-width="2"
            :class="copied ? 'text-emerald-500' : ''"
          />
          <span>{{ copied ? t('common.copied') : t('chat.input.pastedDocumentCopy') }}</span>
        </button>

        <!-- 转为纯文本按钮 -->
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors cursor-pointer"
          :class="props.isDark ? 'border-zinc-700 hover:bg-zinc-800 text-zinc-300' : 'border-zinc-200 hover:bg-zinc-100 text-zinc-700'"
          :title="t('chat.input.pastedDocumentExpand')"
          @click="emit('expand')"
        >
          <HugeiconsIcon :icon="CursorTextIcon as IconArray" :size="14" :stroke-width="2" />
          <span>{{ t('chat.input.pastedDocumentExpand') }}</span>
        </button>

        <!-- 关闭弹窗 -->
        <button
          type="button"
          class="p-1.5 ml-1 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >
          <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="16" :stroke-width="2" />
        </button>
      </div>
    </div>

    <!-- 文档正文查看区 -->
    <div class="flex-1 min-h-0 overflow-y-auto p-4 select-text">
      <pre
        class="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed p-3.5 rounded-xl border"
        :class="props.isDark ? 'bg-zinc-950/80 border-zinc-800 text-zinc-200' : 'bg-zinc-50 border-zinc-200/90 text-zinc-800'"
      >{{ props.document?.content }}</pre>
    </div>
  </LxModal>
</template>
