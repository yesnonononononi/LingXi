<script setup lang="ts">
/** 内置浏览器「Show with Agent」弹窗：展示视口截图与选中文本，收集用户需求后发往 Agent。 */
import {computed, nextTick, ref, watch} from 'vue';
import {t} from '../../i18n';
import LxModal from '../common/LxModal.vue';
import type {ShowWithAgentPayload} from '../../types/projectPagePreview';

const props = defineProps<{
  open: boolean;
  payload: ShowWithAgentPayload | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'send', data: { text: string; file: File }): void;
  (e: 'insert', data: { text: string; file: File }): void;
}>();

const requirement = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const imageSrc = ref('');

watch(() => [props.open, props.payload], () => {
  if (props.open && props.payload) {
    requirement.value = '';
    if (imageSrc.value) {
      URL.revokeObjectURL(imageSrc.value);
      imageSrc.value = '';
    }
    const blob = new Blob([props.payload.imageBuffer], { type: 'image/png' });
    imageSrc.value = URL.createObjectURL(blob);
    void nextTick(() => {
      textareaRef.value?.focus();
    });
  } else {
    if (imageSrc.value) {
      URL.revokeObjectURL(imageSrc.value);
      imageSrc.value = '';
    }
  }
}, { immediate: true });

const pageTitle = computed(() => {
  if (!props.payload) return '';
  return props.payload.title?.trim() || props.payload.url || '';
});

const buildPrompt = (): string => {
  if (!props.payload) return requirement.value.trim();
  const title = pageTitle.value;
  const url = props.payload.url;
  const text = requirement.value.trim();
  const selection = props.payload.selectionText?.trim();

  if (selection) {
    return text
      ? `针对页面【${title}】(${url}) 中选中的内容：\n> ${selection}\n\n需求：${text}`
      : `针对页面【${title}】(${url}) 中选中的内容：\n> ${selection}\n\n请结合截图进行分析并提出修改建议。`;
  }
  return text
    ? `针对页面【${title}】(${url})，结合截图，需求如下：\n${text}`
    : `针对页面【${title}】(${url})，请结合截图分析当前页面并提出优化与修改建议。`;
};

const createFile = (): File | null => {
  if (!props.payload) return null;
  const blob = new Blob([props.payload.imageBuffer], { type: 'image/png' });
  return new File([blob], `page-preview-${Date.now()}.png`, { type: 'image/png' });
};

const handleSend = () => {
  const file = createFile();
  if (!file) return;
  const text = buildPrompt();
  emit('send', { text, file });
};

const handleInsert = () => {
  const file = createFile();
  if (!file) return;
  const text = buildPrompt();
  emit('insert', { text, file });
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    handleSend();
  }
};
</script>

<template>
  <LxModal
    :open="open"
    :closeOnBackdrop="true"
    :closeOnEsc="true"
    overlayClass="bg-black/50 backdrop-blur-xs z-50 transition-opacity duration-200"
    panelClass="w-full max-w-lg bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-5 text-zinc-900 dark:text-zinc-100 flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
    :ariaLabel="t('projectPagePreview.showWithAgentModalTitle')"
    @close="emit('close')"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-200/60 dark:border-emerald-800/40">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </span>
        <div class="min-w-0">
          <h3 class="text-sm font-semibold truncate">{{ t('projectPagePreview.showWithAgentModalTitle') }}</h3>
          <p class="text-xs text-zinc-500 dark:text-zinc-400 truncate">{{ pageTitle }}</p>
        </div>
      </div>
      <button
        type="button"
        class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1 rounded-md transition-colors"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="flex items-start gap-3 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200/70 dark:border-zinc-800/70">
      <div v-if="imageSrc" class="w-24 h-16 rounded-lg overflow-hidden shrink-0 border border-zinc-200 dark:border-zinc-700 bg-zinc-200 dark:bg-zinc-800">
        <img :src="imageSrc" alt="页面截图" class="w-full h-full object-cover" />
      </div>
      <div class="min-w-0 flex-1 text-xs space-y-1">
        <div class="font-medium text-zinc-800 dark:text-zinc-200 truncate">{{ pageTitle }}</div>
        <div class="text-zinc-400 dark:text-zinc-500 truncate font-mono text-[11px]">{{ payload?.url }}</div>
        <div v-if="payload?.selectionText" class="mt-1 px-2 py-1 rounded bg-zinc-200/70 dark:bg-zinc-800 border-l-2 border-emerald-500 text-zinc-700 dark:text-zinc-300 text-[11px] line-clamp-2">
          {{ payload.selectionText }}
        </div>
      </div>
    </div>

    <div class="space-y-1.5">
      <label for="show-with-agent-requirement" class="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {{ t('projectPagePreview.showWithAgentRequirementLabel') }}
      </label>
      <textarea
        id="show-with-agent-requirement"
        ref="textareaRef"
        v-model="requirement"
        class="w-full h-24 p-2.5 text-xs rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 focus:outline-none resize-none placeholder-zinc-400 dark:placeholder-zinc-500 text-zinc-900 dark:text-zinc-100"
        :placeholder="t('projectPagePreview.showWithAgentPromptPlaceholder')"
        @keydown="handleKeydown"
      ></textarea>
      <div class="text-[11px] text-zinc-400 dark:text-zinc-500 text-right">
        {{ t('projectPagePreview.showWithAgentShortcutHint') }}
      </div>
    </div>

    <div class="flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
      <button
        type="button"
        class="px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-transparent transition-colors"
        @click="handleInsert"
      >
        {{ t('projectPagePreview.showWithAgentInsert') }}
      </button>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 transition-colors"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="px-4 py-1.5 text-xs font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 shadow-sm transition-colors"
          @click="handleSend"
        >
          {{ t('projectPagePreview.showWithAgentSend') }}
        </button>
      </div>
    </div>
  </LxModal>
</template>
